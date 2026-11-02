import bs58 from "bs58";
import { KeyPair, KeyPairSigner } from "near-api-js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { portfolioPresets } from "@/content/portfolio-presets";
import { deriveIntentsAccountId } from "@/features/login-wallet/lib/identity";
import { toIntentsTokenId } from "@/features/market/lib/intents-token-id";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import {
  ALLOCATE_DEADLINE_SLACK_SECS,
  COMMIT_DEADLINE_CAP_SECS,
  createRelayGate,
  isAllocateIntoVault,
  RELAY_MAX_AUTH_CALL_MIN_GAS,
  type RelayView,
} from "./relay-gate";
import { APP_MAX_PORTFOLIOS_PER_ACCOUNT, APP_MAX_TOKENS_PER_PORTFOLIO } from "./change-set-preflight";
import type { RelayViewResult } from "./relay-rpc-provider";
import { AUTH_CALL_MIN_GAS, AUTH_CALL_TTL_SECS, buildAllocateSignRequest, buildCommitSignRequest } from "./vault-envelope";
import {
  buildAuthCallAllocateIntoMsg,
  buildAuthCallSetupMsg,
  buildCommitChangeSet,
  type BuildAuthCallAllocateIntoParams,
  type BuildAuthCallSetupParams,
  type BuildCommitChangeSetParams,
} from "./vault-payloads";
import {
  ed25519VaultSigner,
  erc191VaultSigner,
  nep413VaultSigner,
  tip191VaultSigner,
  tonConnectVaultSigner,
  type VaultSigner,
  type VaultSignRequest,
} from "./vault-signer";

const VAULT = "intentfolio-vault.near";
const INTENTS = "intents.near";
const NOW_MS = 1_900_000_000_000;
const NOW = NOW_MS / 1000;

/** NEAR as the contracts read it (`toIntentsTokenId`), which the app offers. */
const WNEAR = "nep141:wrap.near";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** In the registry, so in the General Balance, but outside the catalog the composer offers (D-396). */
const DOGE = "nep141:doge.omft.near";
/** A token the app has never heard of. */
const JUNK = "nep141:junk.attacker.near";

const value = (v: unknown): RelayViewResult => ({ kind: "value", value: v });
const panic = (message: string): RelayViewResult => ({ kind: "panic", message });

/** A view that answers per method; anything not listed is a test bug. */
function fakeView(answers: Record<string, RelayViewResult | Error>) {
  return vi.fn<RelayView>(async (_contract, method) => {
    const answer = answers[method];
    if (answer === undefined) throw new Error(`unexpected view ${method}`);
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

/** The commit path also asks whether the nonce is burnt; `false` unless the test says otherwise. */
const vaultView = (answers: Record<string, RelayViewResult | Error>) =>
  fakeView({ is_commit_nonce_used: value(false), ...answers });

/** A Setup also asks how many portfolios the account holds; none unless the test says otherwise. */
const setupView = (answers: Record<string, RelayViewResult | Error>) =>
  fakeView({ simulate_intents: value({ intents_executed: [{}], state: {} }), list_portfolios_for: value([]), ...answers });

const gateWith = (view: RelayView, log: (line: string) => void = () => {}) =>
  createRelayGate({ view, vaultId: VAULT, intentsId: INTENTS, now: () => NOW_MS, log });

async function nep413Commit(
  opts: {
    signerId?: string;
    deadlineSecs?: number;
    portfolioId?: string;
    vaultId?: string;
    edits?: Omit<BuildCommitChangeSetParams, "portfolioId">;
    /** Rewrites the message before it is signed, for texts the builder cannot produce. */
    mangle?: (message: string) => string;
  } = {}
) {
  const keyPair = KeyPair.fromRandom("ed25519");
  const implicitId = Buffer.from(keyPair.getPublicKey().data).toString("hex");
  const signerId = opts.signerId ?? implicitId;
  const { request } = buildCommitSignRequest({
    signerId,
    deadlineSecs: opts.deadlineSecs ?? NOW + 600,
    vaultId: opts.vaultId ?? VAULT,
    changeSet: buildCommitChangeSet({
      portfolioId: opts.portfolioId ?? "3",
      ...(opts.edits ?? { unallocations: [{ tokenId: "nep141:wrap.near", amount: "1" }] }),
    }),
  });
  const message = opts.mangle ? opts.mangle(request.message) : request.message;
  const signed = await new KeyPairSigner(keyPair).signNep413Message(signerId, { ...request, message });
  return {
    signerId,
    publicKey: keyPair.getPublicKey().toString(),
    payload: {
      standard: "nep413",
      payload: { message, nonce: Buffer.from(request.nonce).toString("base64"), recipient: request.recipient },
      public_key: signed.publicKey.toString(),
      signature: `ed25519:${bs58.encode(signed.signature)}`,
    },
  };
}

async function erc191Commit(opts: { mangle?: (message: string) => string } = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const signerId = account.address.toLowerCase();
  const { erc191Message: built } = buildCommitSignRequest({
    signerId,
    deadlineSecs: NOW + 600,
    vaultId: VAULT,
    changeSet: buildCommitChangeSet({ portfolioId: "3", targetChanges: [{ tokenId: "nep141:wrap.near", targetBps: 10000, toleranceBps: 500 }] }),
  });
  const erc191Message = opts.mangle ? opts.mangle(built) : built;
  const sig = await account.signMessage({ message: erc191Message });
  const v = parseInt(sig.slice(-2), 16);
  const wire = Buffer.from(sig.slice(2, -2) + (v >= 27 ? v - 27 : v).toString(16).padStart(2, "0"), "hex");
  return { signerId, payload: { standard: "erc191", payload: erc191Message, signature: `secp256k1:${bs58.encode(wire)}` } };
}

type PatchableMsg = { op: Record<string, Record<string, unknown>> } & Record<string, unknown>;

/**
 * A Setup by default, signed by an EVM account with its own wallet as the login wallet;
 * `allocateInto` makes it one. The transfer is always the msg's own legs. `patchMsg` edits the
 * parsed `auth_call.msg` for shapes the builders cannot produce.
 */
function allocatePayload(
  opts: {
    intents?: unknown[];
    signerId?: string;
    deadline?: number;
    setup?: Partial<Pick<BuildAuthCallSetupParams, "portfolioName" | "composition" | "allocations" | "chain" | "address">>;
    allocateInto?: Partial<Pick<BuildAuthCallAllocateIntoParams, "tokenAdditions" | "allocations">>;
    /** A Setup's Storage Cost (D-528); one base unit of its first leg unless given, none with null. */
    storage?: { tokenId: string; amount: string } | null;
    patchMsg?: (msg: PatchableMsg) => void;
  } = {}
) {
  const signerId = opts.signerId ?? `0x${"ab".repeat(20)}`;
  const deadline = opts.deadline ?? NOW + AUTH_CALL_TTL_SECS;
  const allocations = opts.allocateInto?.allocations ?? opts.setup?.allocations ?? [{ tokenId: WNEAR, amount: "1" }];
  let authCallMsg = opts.allocateInto
    ? buildAuthCallAllocateIntoMsg({
        deadline,
        nonce: Array(32).fill(0),
        portfolioId: "3",
        tokenAdditions: opts.allocateInto.tokenAdditions,
        allocations,
      })
    : buildAuthCallSetupMsg({
        deadline,
        nonce: Array(32).fill(0),
        chain: opts.setup?.chain ?? "evm",
        address: opts.setup?.address ?? signerId,
        portfolioName: opts.setup?.portfolioName ?? "p",
        composition: opts.setup?.composition ?? [{ tokenId: WNEAR, targetBps: 10000, toleranceBps: 500 }],
        allocations,
      });
  if (opts.patchMsg) {
    const msg = JSON.parse(authCallMsg) as PatchableMsg;
    opts.patchMsg(msg);
    authCallMsg = JSON.stringify(msg);
  }
  const { erc191Message } = buildAllocateSignRequest({
    signerId,
    deadlineSecs: NOW + 600,
    nonceDeadlineSecs: NOW + 3600,
    salt: new Uint8Array(4),
    vaultId: VAULT,
    transfers: allocations,
    authCallMsg,
    storage: opts.allocateInto || opts.storage === null ? undefined : (opts.storage ?? { tokenId: allocations[0].tokenId, amount: "1" }),
  });
  // The builder's own text unless the intents are replaced, so every Setup test also ties it to the gate.
  let text = erc191Message;
  if (opts.intents) {
    const parsed = JSON.parse(erc191Message) as Record<string, unknown>;
    parsed.intents = opts.intents;
    text = JSON.stringify(parsed, null, 2);
  }
  // The signature is the simulation's business, not the gate's: any string reaches the view.
  return { signerId, payload: { standard: "erc191", payload: text, signature: "secp256k1:x" } };
}

describe("relay gate — Verifier (Allocate)", () => {
  it("passes an Allocate the simulation accepts", async () => {
    const view = setupView({});
    const { signerId, payload } = allocatePayload();

    await expect(gateWith(view)({ target: "verifier", payload })).resolves.toMatchObject({ ok: true, signerId });
    expect(view).toHaveBeenCalledWith(INTENTS, "simulate_intents", { signed: [payload] });
    expect(view).toHaveBeenCalledWith(VAULT, "list_portfolios_for", { account_id: signerId });
  });

  it("refuses what the simulation refuses, with the contract's reason", async () => {
    const view = setupView({ simulate_intents: panic("insufficient balance or overflow") });
    await expect(gateWith(view)({ target: "verifier", payload: allocatePayload().payload })).resolves.toEqual({
      ok: false,
      code: "would-fail",
      reason: "insufficient balance or overflow",
    });
  });

  it("refuses a reported invariant violation (execution panics on it)", async () => {
    const view = setupView({ simulate_intents: value({ invariant_violated: { unmatched_deltas: [] } }) });
    const verdict = await gateWith(view)({ target: "verifier", payload: allocatePayload().payload });
    expect(verdict).toMatchObject({ ok: false, code: "would-fail" });
  });

  it("refuses an empty intent list WITHOUT asking the simulation (it would pass, s194)", async () => {
    const view = fakeView({});
    const verdict = await gateWith(view)({ target: "verifier", payload: allocatePayload({ intents: [] }).payload });
    expect(verdict).toMatchObject({ ok: false, code: "would-fail" });
    expect(view).not.toHaveBeenCalled();
  });

  it("refuses a transfer anywhere but the vault", async () => {
    const view = fakeView({});
    const payload = allocatePayload({
      intents: [
        { intent: "transfer", receiver_id: "attacker.near", tokens: { "nep141:wrap.near": "1" } },
        { intent: "auth_call", contract_id: VAULT, msg: "{}" },
      ],
    }).payload;
    await expect(gateWith(view)({ target: "verifier", payload })).resolves.toMatchObject({ ok: false, code: "would-fail" });
  });

  it("says check-failed, not would-fail, when no node answered", async () => {
    const view = setupView({ simulate_intents: new Error("fetch failed") });
    await expect(gateWith(view)({ target: "verifier", payload: allocatePayload().payload })).resolves.toMatchObject({
      ok: false,
      code: "check-failed",
    });
  });
});

// D-371: until the final contract charges the storage a portfolio takes, the vault's reserve
// pays it, so the relay pays only for what the app itself would build — and checks only what
// comes IN, so an old portfolio keeps moving tokens the app no longer offers.
describe("relay gate — only the app's shape (D-371)", () => {
  const allocate = (view: RelayView, payload: unknown, log?: (line: string) => void) =>
    gateWith(view, log)({ target: "verifier", payload });
  const commit = (view: RelayView, payload: unknown) => gateWith(view)({ target: "vault", payload });
  const portfolios = (n: number) => value(Array.from({ length: n }, (_, i) => String(i)));

  it("refuses a Setup composition with a token the app does not know, before any view", async () => {
    const view = setupView({});
    // "near" is the registry's label; the app signs NEAR as nep141:wrap.near (toIntentsTokenId).
    for (const tokenId of ["near", JUNK]) {
      const { payload } = allocatePayload({ setup: { composition: [{ tokenId, targetBps: 10000, toleranceBps: 500 }] } });
      await expect(allocate(view, payload)).resolves.toEqual({
        ok: false,
        code: "would-fail",
        reason: `${tokenId} is not a token the app knows`,
      });
    }
    expect(view).not.toHaveBeenCalled();
  });

  it("refuses a Setup leg with a token the app does not know, even outside the composition", async () => {
    const { payload } = allocatePayload({ setup: { allocations: [{ tokenId: WNEAR, amount: "1" }, { tokenId: JUNK, amount: "1" }] } });
    await expect(allocate(setupView({}), payload)).resolves.toMatchObject({ ok: false, code: "would-fail" });
  });

  // Cross-review s266 (F1): the creation modal offers every General Balance token worth $1, not
  // only the composer's list, as legs outside the composition. A user arriving from near.com with
  // DOGE must still be able to create a portfolio.
  it("passes a Setup funded with a held token outside the composer's list", async () => {
    const { payload } = allocatePayload({ setup: { allocations: [{ tokenId: WNEAR, amount: "1" }, { tokenId: DOGE, amount: "1" }] } });
    await expect(allocate(setupView({}), payload)).resolves.toMatchObject({ ok: true });
  });

  // The other half of "the app's shape": nothing the app can build is refused. Every preset, and
  // every registry token, as `run-real-allocate.ts` puts them on the wire.
  it("passes a Setup of every preset, and of every registry token (in compositions of the app's cap)", async () => {
    const registry = tokenRegistry.map((t) => t.id);
    const chunks = Array.from({ length: Math.ceil(registry.length / APP_MAX_TOKENS_PER_PORTFOLIO) }, (_, i) =>
      registry.slice(i * APP_MAX_TOKENS_PER_PORTFOLIO, (i + 1) * APP_MAX_TOKENS_PER_PORTFOLIO)
    );
    for (const registryIds of [...portfolioPresets.map((p) => p.slots.map((s) => s.tokenId)), ...chunks]) {
      const ids = registryIds.map(toIntentsTokenId);
      const { payload } = allocatePayload({
        setup: {
          // A composition the vault accepts (Σ = 10000, D-542): the first token takes the rest.
          composition: ids.map((tokenId, i) => ({ tokenId, targetBps: i === 0 ? 10000 - (ids.length - 1) : 1, toleranceBps: 500 })),
          allocations: ids.map((tokenId) => ({ tokenId, amount: "1" })),
        },
      });
      await expect(allocate(setupView({}), payload), registryIds.join()).resolves.toMatchObject({ ok: true });
    }
  });

  it("refuses a Setup name longer than the app's 25, counted as the app counts (UTF-16 units)", async () => {
    for (const portfolioName of ["x".repeat(26), "😀".repeat(13)]) {
      const { payload } = allocatePayload({ setup: { portfolioName } });
      await expect(allocate(setupView({}), payload)).resolves.toMatchObject({ ok: false, code: "would-fail" });
    }
    const { payload } = allocatePayload({ setup: { portfolioName: "x".repeat(25) } });
    await expect(allocate(setupView({}), payload)).resolves.toMatchObject({ ok: true });
  });

  it("refuses a Setup for an account already at the app's cap, and passes the last one under it", async () => {
    const { signerId, payload } = allocatePayload();
    const full = setupView({ list_portfolios_for: portfolios(APP_MAX_PORTFOLIOS_PER_ACCOUNT) });
    await expect(allocate(full, payload)).resolves.toEqual({
      ok: false,
      code: "would-fail",
      reason: `${signerId} already has ${APP_MAX_PORTFOLIOS_PER_ACCOUNT} portfolios (the app's cap is ${APP_MAX_PORTFOLIOS_PER_ACCOUNT})`,
    });
    const room = setupView({ list_portfolios_for: portfolios(APP_MAX_PORTFOLIOS_PER_ACCOUNT - 1) });
    await expect(allocate(room, payload)).resolves.toMatchObject({ ok: true });
  });

  it("lets the Setup through, and logs it, when the portfolio list cannot be read (operator, s266)", async () => {
    const { payload } = allocatePayload();
    for (const answer of [new Error("timeout"), panic("MethodNotFound"), value(null)]) {
      const log = vi.fn();
      await expect(allocate(setupView({ list_portfolios_for: answer }), payload, log)).resolves.toMatchObject({ ok: true });
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not read the portfolios/));
    }
  });

  it("an AllocateInto is not capped, and its additions and legs must be offered", async () => {
    const add = { tokenId: USDC, targetBps: 0, toleranceBps: 500 };
    const ok = allocatePayload({ allocateInto: { tokenAdditions: [add], allocations: [{ tokenId: USDC, amount: "1" }] } });
    const view = fakeView({ simulate_intents: value({ intents_executed: [{}], state: {} }) });
    await expect(allocate(view, ok.payload)).resolves.toMatchObject({ ok: true });
    expect(view).not.toHaveBeenCalledWith(VAULT, "list_portfolios_for", expect.anything());

    const foreignAddition = allocatePayload({ allocateInto: { tokenAdditions: [{ ...add, tokenId: JUNK }] } });
    await expect(allocate(setupView({}), foreignAddition.payload)).resolves.toEqual({
      ok: false,
      code: "would-fail",
      reason: `${JUNK} is not a token the app knows`,
    });
    const foreignLeg = allocatePayload({ allocateInto: { allocations: [{ tokenId: JUNK, amount: "1" }] } });
    await expect(allocate(setupView({}), foreignLeg.payload)).resolves.toMatchObject({ ok: false, code: "would-fail" });
  });

  it("refuses a commit adding a token the app does not know, before any view", async () => {
    const foreign = await nep413Commit({ edits: { tokenAdditions: [{ tokenId: JUNK, targetBps: 0, toleranceBps: 500 }] } });
    const view = fakeView({});
    await expect(commit(view, foreign.payload)).resolves.toEqual({
      ok: false,
      code: "would-fail",
      reason: `${JUNK} is not a token the app knows`,
    });
    expect(view).not.toHaveBeenCalled();
  });

  // Cross-review s266 (F2): the editor promotes a held token to a target, whatever the catalog says.
  it("passes a commit adding a registry token, the composer's or a held one", async () => {
    for (const tokenId of [USDC, DOGE]) {
      const added = await nep413Commit({ edits: { tokenAdditions: [{ tokenId, targetBps: 0, toleranceBps: 500 }] } });
      const owned = vaultView({ get_portfolio: value({ owner: added.signerId }) });
      await expect(commit(owned, added.payload), tokenId).resolves.toMatchObject({ ok: true });
    }
  });

  it("lets an old portfolio retarget, remove and withdraw a token the app no longer offers", async () => {
    for (const edits of [
      { targetChanges: [{ tokenId: DOGE, targetBps: 10000, toleranceBps: 500 }] },
      { tokenRemovals: [DOGE], unallocations: [{ tokenId: DOGE, amount: "1" }] },
    ]) {
      const { signerId, payload } = await nep413Commit({ edits });
      await expect(commit(vaultView({ get_portfolio: value({ owner: signerId }) }), payload)).resolves.toMatchObject({ ok: true });
    }
  });

  it("refuses a rename longer than the app's 25, and passes 25", async () => {
    const long = await nep413Commit({ edits: { name: "x".repeat(26) } });
    await expect(commit(fakeView({}), long.payload)).resolves.toMatchObject({ ok: false, code: "would-fail" });
    const fits = await nep413Commit({ edits: { name: "x".repeat(25) } });
    await expect(commit(vaultView({ get_portfolio: value({ owner: fits.signerId }) }), fits.payload)).resolves.toMatchObject({
      ok: true,
    });
  });
});

// D-528: a Setup pays its Storage Cost, and no composition grows past the app's 10 tokens.
describe("relay gate — the Storage Cost and the app's token cap (D-528)", () => {
  const allocate = (view: RelayView, payload: unknown) => gateWith(view)({ target: "verifier", payload });
  const commit = (view: RelayView, payload: unknown) => gateWith(view)({ target: "vault", payload });
  const registryIds = tokenRegistry.map((t) => toIntentsTokenId(t.id));
  // Σ = 10000, so only the cap is under test (D-542): the first token takes the rest.
  const compositionOf = (n: number) =>
    registryIds.slice(0, n).map((tokenId, i) => ({ tokenId, targetBps: i === 0 ? 10000 - (n - 1) : 1, toleranceBps: 500 }));

  it("refuses a Setup without its Storage Cost before any view, and pays for one with it", async () => {
    const view = setupView({});
    await expect(allocate(view, allocatePayload({ storage: null }).payload)).resolves.toMatchObject({ ok: false, code: "would-fail" });
    expect(view).not.toHaveBeenCalled();
    await expect(allocate(view, allocatePayload().payload)).resolves.toMatchObject({ ok: true });
  });

  it("refuses an AllocateInto that carries one", async () => {
    const { payload } = allocatePayload({ allocateInto: {} });
    const parsed = JSON.parse(payload.payload) as { intents: unknown[] };
    parsed.intents.push({ intent: "transfer", receiver_id: "intentfolio-budget.near", tokens: { [WNEAR]: "1" }, memo: "storage" });
    const view = fakeView({});
    await expect(allocate(view, { ...payload, payload: JSON.stringify(parsed, null, 2) })).resolves.toMatchObject({ ok: false, code: "would-fail" });
    expect(view).not.toHaveBeenCalled();
  });

  it("passes a Setup composition of 10 tokens and refuses 11, before any view", async () => {
    const at = (n: number) =>
      allocatePayload({ setup: { composition: compositionOf(n), allocations: [{ tokenId: registryIds[0], amount: "1" }] } }).payload;
    await expect(allocate(setupView({}), at(APP_MAX_TOKENS_PER_PORTFOLIO))).resolves.toMatchObject({ ok: true });
    const view = setupView({});
    await expect(allocate(view, at(APP_MAX_TOKENS_PER_PORTFOLIO + 1))).resolves.toEqual({
      ok: false,
      code: "would-fail",
      reason: `a composition of 11 tokens (the app's cap is ${APP_MAX_TOKENS_PER_PORTFOLIO})`,
    });
    expect(view).not.toHaveBeenCalled();
  });

  it("refuses a commit growing a composition past 10; lets one above it swap or shrink", async () => {
    const add = { tokenId: USDC, targetBps: 0, toleranceBps: 500 };
    const owning = (signerId: string, n: number) =>
      vaultView({ get_portfolio: value({ owner: signerId, composition: compositionOf(n).map((c) => ({ token_id: c.tokenId })) }) });

    const grows = await nep413Commit({ edits: { tokenAdditions: [add] } });
    await expect(commit(owning(grows.signerId, 10), grows.payload)).resolves.toEqual({
      ok: false,
      code: "would-fail",
      reason: `a composition of 11 tokens (the app's cap is ${APP_MAX_TOKENS_PER_PORTFOLIO})`,
    });
    const fits = await nep413Commit({ edits: { tokenAdditions: [add] } });
    await expect(commit(owning(fits.signerId, 9), fits.payload)).resolves.toMatchObject({ ok: true });
    const swaps = await nep413Commit({ edits: { tokenAdditions: [add], tokenRemovals: [registryIds[0]] } });
    await expect(commit(owning(swaps.signerId, 12), swaps.payload)).resolves.toMatchObject({ ok: true });
    const retargets = await nep413Commit({ edits: { targetChanges: [{ tokenId: registryIds[0], targetBps: 1, toleranceBps: 500 }] } });
    await expect(commit(owning(retargets.signerId, 12), retargets.payload)).resolves.toMatchObject({ ok: true });
  });
});

// Cross-review s266: two holes from before D-371, in the same "only the app's shape" layer.
describe("relay gate — the Setup's login wallet and the msg deadline (D-371)", () => {
  const allocate = (view: RelayView, payload: unknown) => gateWith(view)({ target: "verifier", payload });
  const solanaKey = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));

  it("refuses a Setup linking a wallet that is not the signer's, before any view", async () => {
    const view = setupView({});
    for (const setup of [
      { chain: "evm" as const, address: `0x${"cd".repeat(20)}` },
      // The vault takes any Solana/TON/Stellar/Tron wallet; this squat orphans the owner's first deposit.
      { chain: "solana" as const, address: solanaKey },
    ]) {
      const { signerId, payload } = allocatePayload({ setup });
      await expect(allocate(view, payload)).resolves.toEqual({
        ok: false,
        code: "would-fail",
        reason: `the login wallet is not ${signerId}'s own`,
      });
    }
    expect(view).not.toHaveBeenCalled();
  });

  it("passes the signer's own wallet, in every family the app signs with", async () => {
    const owned = [
      { signerId: `0x${"ab".repeat(20)}`, chain: "evm" as const, address: `0x${"AB".repeat(20)}` }, // as the wallet reports it
      { signerId: deriveIntentsAccountId(solanaKey, "solana"), chain: "solana" as const, address: solanaKey },
      { signerId: "alice.near", chain: "near" as const, address: "alice.near" },
    ];
    for (const { signerId, chain, address } of owned) {
      const { payload } = allocatePayload({ signerId, setup: { chain, address } });
      await expect(allocate(setupView({}), payload), chain).resolves.toMatchObject({ ok: true });
    }
  });

  it("refuses a login wallet that is not exactly {chain, address}", async () => {
    const signerId = `0x${"ab".repeat(20)}`;
    for (const loginWallet of [["evm", signerId], { chain: "evm", address: signerId, extra: "x" }]) {
      const { payload } = allocatePayload({ signerId, patchMsg: (m) => (m.op.setup.login_wallet = loginWallet) });
      await expect(allocate(setupView({}), payload)).resolves.toMatchObject({ ok: false, code: "would-fail" });
    }
  });

  // The SDK derives a webauthn handle too (an ed25519 one to the same id as the Solana key), but
  // the vault's ChainKind has no such variant: the Setup would revert in `on_auth`, an orphan.
  it("refuses a chain the vault does not know, even one that derives to the signer", async () => {
    const signerId = deriveIntentsAccountId(solanaKey, "solana");
    const loginWallet = { chain: "webauthn", address: `ed25519:${solanaKey}` };
    const { payload } = allocatePayload({ signerId, patchMsg: (m) => (m.op.setup.login_wallet = loginWallet) });
    await expect(allocate(setupView({}), payload)).resolves.toMatchObject({ ok: false, code: "would-fail" });
  });

  it("passes the deadline the app signs, and refuses one past it, one about to pass, or one that is not a u64 it can read", async () => {
    await expect(allocate(setupView({}), allocatePayload({ deadline: NOW + AUTH_CALL_TTL_SECS }).payload)).resolves.toMatchObject({ ok: true });
    for (const deadline of [
      NOW + AUTH_CALL_TTL_SECS + ALLOCATE_DEADLINE_SLACK_SECS + 1,
      18446744073709551615, // u64::MAX: a seal no GC could ever purge
      NOW + 10,
      NOW - 1,
      NOW + 3600.5, // not a u64: serde refuses it inside `on_auth`, an orphan
    ]) {
      for (const allocateInto of [undefined, { tokenAdditions: [] }]) {
        const { payload } = allocatePayload({ deadline, allocateInto });
        await expect(allocate(setupView({}), payload), String(deadline)).resolves.toMatchObject({ ok: false, code: "would-fail" });
      }
    }
  });
});

// The simulation never reads the msg: one serde refuses settles the transfer and reverts in
// `on_auth`, an orphan on the relay's gas. The types are the vault's `AuthCallMsg` (types.rs).
describe("relay gate — the msg's types (D-542)", () => {
  const allocate = (view: RelayView, payload: unknown) => gateWith(view)({ target: "verifier", payload });
  const refused = { ok: false, code: "would-fail", reason: "the auth_call msg does not have the types the vault reads" };
  const into = { tokenAdditions: [] };
  const zeros = (n: number) => Array<number>(n).fill(0);

  async function expectRefused(label: string, allocateInto: typeof into | undefined, patchMsg: (m: PatchableMsg) => void) {
    const view = setupView({});
    const { payload } = allocatePayload({ allocateInto, patchMsg });
    await expect(allocate(view, payload), label).resolves.toEqual(refused);
    expect(view, label).not.toHaveBeenCalled();
  }

  it("refuses a msg nonce that is not a [u8; 32], in a Setup and an AllocateInto", async () => {
    const nonces = [[256, ...zeros(31)], [-1, ...zeros(31)], [1.5, ...zeros(31)], ["0", ...zeros(31)], zeros(31), zeros(33), "AAAA", null];
    for (const nonce of nonces) {
      for (const allocateInto of [undefined, into]) {
        await expectRefused(JSON.stringify(nonce), allocateInto, (m) => (m.nonce = nonce));
      }
    }
  });

  it("refuses a Setup target_bps or tolerance_bps that is not a u16", async () => {
    for (const field of ["target_bps", "tolerance_bps"]) {
      for (const bad of [1.5, -1, 65536, "500", null]) {
        await expectRefused(`${field} ${bad}`, undefined, (m) => ((m.op.setup.composition as Record<string, unknown>[])[0][field] = bad));
      }
    }
  });

  it("refuses an AllocateInto portfolio_id that is not a string", async () => {
    for (const bad of [3, null, ["3"]]) {
      await expectRefused(JSON.stringify(bad), into, (m) => (m.op.allocate_into.portfolio_id = bad));
    }
  });

  it("refuses AllocateInto target_changes or token_additions that are not (string, u16, u16) rows", async () => {
    const rows = [undefined, {}, [[USDC, 1.5, 500]], [[USDC, 0, -1]], [[USDC, 65536, 500]], [[USDC, 0]], [[USDC, 0, 500, 0]], [[3, 0, 500]]];
    for (const field of ["target_changes", "token_additions"]) {
      for (const bad of rows) {
        await expectRefused(`${field} ${JSON.stringify(bad)}`, into, (m) => (m.op.allocate_into[field] = bad));
      }
    }
  });

  it("refuses AllocateInto token_removals that are not a list of strings", async () => {
    for (const bad of [undefined, USDC, [3], [[USDC]]]) {
      await expectRefused(JSON.stringify(bad), into, (m) => (m.op.allocate_into.token_removals = bad));
    }
  });

  // Control: what the app builds passes. Its nonce is random bytes (allocate-submit.ts), so any
  // of 0..255; and the vault's serde ignores keys it does not know (no `deny_unknown_fields`).
  it("passes the msgs the app builds, any nonce byte, every list filled, and keys the vault ignores", async () => {
    const nonce = Array.from({ length: 32 }, (_, i) => (i === 0 ? 255 : i));
    const setup = allocatePayload({ patchMsg: (m) => (m.nonce = nonce) });
    await expect(allocate(setupView({}), setup.payload)).resolves.toMatchObject({ ok: true });

    const filled = allocatePayload({
      allocateInto: { tokenAdditions: [{ tokenId: USDC, targetBps: 0, toleranceBps: 500 }] },
      patchMsg: (m) => {
        m.nonce = nonce;
        m.op.allocate_into.target_changes = [[WNEAR, 10000, 3000]];
        m.op.allocate_into.token_removals = [DOGE];
      },
    });
    await expect(allocate(setupView({}), filled.payload)).resolves.toMatchObject({ ok: true });

    const extra = allocatePayload({
      patchMsg: (m) => {
        m.extra = 1;
        (m.op.setup.composition as Record<string, unknown>[])[0].extra = 1;
      },
    });
    await expect(allocate(setupView({}), extra.payload)).resolves.toMatchObject({ ok: true });
  });
});

// Past the types, `on_auth` validates the composition (composition.rs): all of it on a Setup
// (`validate_composition`), and on an AllocateInto the half of the change set that needs no
// stored composition (`validate_change_set`). A refusal there is the same orphan.
describe("relay gate — the composition rules `on_auth` checks (D-542)", () => {
  const allocate = (view: RelayView, payload: unknown) => gateWith(view)({ target: "verifier", payload });
  const refused = { ok: false, code: "would-fail", reason: "a composition the vault refuses" };
  type Row = [string, number, number];
  const composition = (rows: Row[]) => rows.map(([tokenId, targetBps, toleranceBps]) => ({ tokenId, targetBps, toleranceBps }));

  async function expectRefused(label: string, opts: Parameters<typeof allocatePayload>[0]) {
    const view = setupView({});
    await expect(allocate(view, allocatePayload(opts).payload), label).resolves.toEqual(refused);
    expect(view, label).not.toHaveBeenCalled();
  }

  it("refuses a Setup whose targets do not sum to 10000, a band outside [200, 3000], 0 on a positive target, or a repeated token", async () => {
    const bad: Row[][] = [
      [],
      [[WNEAR, 5000, 500]],
      [[WNEAR, 5000, 500], [USDC, 4999, 500]],
      [[WNEAR, 10001, 500]],
      [[WNEAR, 10000, 199]],
      [[WNEAR, 10000, 3001]],
      [[WNEAR, 10000, 0]],
      [[WNEAR, 5000, 500], [WNEAR, 5000, 500]],
    ];
    for (const rows of bad) await expectRefused(JSON.stringify(rows), { setup: { composition: composition(rows) } });
  });

  it("passes a Setup at the edges the vault accepts: a band of 200 or 3000, and 0 on a zero target", async () => {
    for (const rows of [[[WNEAR, 10000, 200], [USDC, 0, 0]], [[WNEAR, 9999, 3000], [USDC, 1, 200]]] as Row[][]) {
      const { payload } = allocatePayload({ setup: { composition: composition(rows) } });
      await expect(allocate(setupView({}), payload), JSON.stringify(rows)).resolves.toMatchObject({ ok: true });
    }
  });

  it("refuses AllocateInto change rows with a target over 10000, a band outside [200, 3000], or 0 on a positive target", async () => {
    for (const field of ["target_changes", "token_additions"]) {
      for (const row of [[USDC, 10001, 500], [USDC, 0, 199], [USDC, 0, 3001], [USDC, 100, 0]] as Row[]) {
        await expectRefused(`${field} ${JSON.stringify(row)}`, {
          allocateInto: {},
          patchMsg: (m) => (m.op.allocate_into[field] = [row]),
        });
      }
    }
  });

  it("refuses an AllocateInto naming a token in two change lists, or twice in one", async () => {
    const lists: Record<string, unknown>[] = [
      { target_changes: [[USDC, 0, 0]], token_removals: [USDC] },
      { target_changes: [[USDC, 0, 0]], token_additions: [[USDC, 0, 500]] },
      { token_additions: [[USDC, 0, 500]], token_removals: [USDC] },
      { token_additions: [[USDC, 0, 500], [USDC, 0, 500]] },
      { token_removals: [USDC, USDC] },
    ];
    for (const patch of lists) {
      await expectRefused(JSON.stringify(patch), { allocateInto: {}, patchMsg: (m) => Object.assign(m.op.allocate_into, patch) });
    }
  });

  it("passes AllocateInto rows at the edges: a band of 200 or 3000, 0 on a zero target, a target of 10000", async () => {
    const { payload } = allocatePayload({
      allocateInto: {},
      patchMsg: (m) => {
        m.op.allocate_into.target_changes = [[WNEAR, 10000, 200], [DOGE, 0, 0]];
        m.op.allocate_into.token_additions = [[USDC, 0, 3000]];
      },
    });
    await expect(allocate(setupView({}), payload)).resolves.toMatchObject({ ok: true });
  });

  // allocate.rs:313-317: the three lists together, at most MAX_COMPOSITION_CHANGES_PER_COMMIT (64).
  it("refuses an AllocateInto with more than 64 composition changes across its lists, and passes 64", async () => {
    const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => `nep141:t${from + i}.near`);
    const changes = (additions: Row[]) => (m: PatchableMsg) => {
      m.op.allocate_into.target_changes = ids(0, 32).map((id) => [id, 0, 0]);
      m.op.allocate_into.token_additions = additions;
      m.op.allocate_into.token_removals = ids(32, 32);
    };
    const { payload } = allocatePayload({ allocateInto: {}, patchMsg: changes([]) });
    await expect(allocate(setupView({}), payload)).resolves.toMatchObject({ ok: true });
    await expectRefused("65", { allocateInto: {}, patchMsg: changes([[USDC, 0, 500]]) });
  });

  // `check_token_id`: `str::len() ≤ MAX_TOKEN_ID_LEN` (128) — UTF-8 bytes, not characters.
  it("refuses a retargeted or removed token id over 128 UTF-8 bytes, and passes 128", async () => {
    const at128 = ["x".repeat(128), `${"x".repeat(126)}é`];
    const over = ["x".repeat(129), `${"x".repeat(127)}é`]; // the second is 128 characters
    const lists = {
      target_changes: (id: string) => [[id, 0, 0]],
      token_removals: (id: string) => [id],
    };
    for (const [field, list] of Object.entries(lists)) {
      for (const id of at128) {
        const { payload } = allocatePayload({ allocateInto: {}, patchMsg: (m) => (m.op.allocate_into[field] = list(id)) });
        await expect(allocate(setupView({}), payload), `${field} ${id}`).resolves.toMatchObject({ ok: true });
      }
      for (const id of over) {
        await expectRefused(`${field} ${id}`, { allocateInto: {}, patchMsg: (m) => (m.op.allocate_into[field] = list(id)) });
      }
    }
  });
});

describe("isAllocateIntoVault", () => {
  const msg = (op: unknown) => JSON.stringify({ deadline: 1, nonce: [], op });
  const t = { intent: "transfer", receiver_id: VAULT, tokens: { "nep141:wrap.near": "5", "nep141:usdc.near": "7" } };
  const legs = [["nep141:wrap.near", "5"], ["nep141:usdc.near", "7"]];
  const a = { intent: "auth_call", contract_id: VAULT, msg: msg({ setup: { allocations: legs } }) };
  const into = { ...a, msg: msg({ allocate_into: { allocations: legs } }) };
  /** The Setup's Storage Cost (D-528), as `buildAllocateSignRequest` appends it. */
  const s = { intent: "transfer", receiver_id: "intentfolio-budget.near", tokens: { "nep141:usdc.near": "3" }, memo: "storage" };

  it("wants exactly [transfer → vault, auth_call → vault], plus the Storage Cost last on a Setup", () => {
    expect(isAllocateIntoVault({ intents: [t, a, s] }, VAULT)).toBe(true);
    expect(isAllocateIntoVault({ intents: [t, into] }, VAULT)).toBe(true);
    expect(isAllocateIntoVault({ intents: [t, a] }, VAULT)).toBe(false); // a Setup without it (an old bundle)
    expect(isAllocateIntoVault({ intents: [t, into, s] }, VAULT)).toBe(false); // AllocateInto never charges it
    expect(isAllocateIntoVault({ intents: [t, s, a] }, VAULT)).toBe(false);
    expect(isAllocateIntoVault({ intents: [s, t, a] }, VAULT)).toBe(false);
    expect(isAllocateIntoVault({ intents: [a, t, s] }, VAULT)).toBe(false);
    expect(isAllocateIntoVault({ intents: [t, a, t] }, VAULT)).toBe(false);
    expect(isAllocateIntoVault({ intents: [t, a, s, s] }, VAULT)).toBe(false);
    expect(isAllocateIntoVault({ intents: [t, { ...a, contract_id: "other.near" }, s] }, VAULT)).toBe(false);
    expect(isAllocateIntoVault({}, VAULT)).toBe(false);
  });

  it("refuses any field the app does not set — min_gas passes the simulation and reverts on-chain (cross-review)", () => {
    expect(isAllocateIntoVault({ intents: [t, { ...a, min_gas: "400000000000000" }, s] }, VAULT)).toBe(false);
    expect(isAllocateIntoVault({ intents: [t, { ...a, attached_deposit: "1" }, s] }, VAULT)).toBe(false);
    expect(isAllocateIntoVault({ intents: [{ ...t, memo: "x".repeat(10_000) }, a, s] }, VAULT)).toBe(false);
    // A transfer's notification is flattened on the wire: `msg`, `min_gas`, `state_init`.
    for (const extra of [{ msg: "" }, { min_gas: "1" }, { state_init: {} }]) {
      expect(isAllocateIntoVault({ intents: [{ ...t, ...extra }, a, s] }, VAULT)).toBe(false);
    }
  });

  // 017-9a (D-302 m): the app now sends `min_gas` = 65 TGas. The relay admits it up to a cap
  // that fits in RELAY_GAS, and still admits its absence (a tab on the previous bundle).
  it("admits min_gas as the app sends it, up to the cap, and its absence", () => {
    expect(isAllocateIntoVault({ intents: [t, { ...a, min_gas: AUTH_CALL_MIN_GAS }, s] }, VAULT)).toBe(true);
    expect(isAllocateIntoVault({ intents: [t, { ...a, min_gas: RELAY_MAX_AUTH_CALL_MIN_GAS.toString() }, s] }, VAULT)).toBe(true);
    expect(isAllocateIntoVault({ intents: [t, a, s] }, VAULT)).toBe(true);
  });

  it("refuses a min_gas above the cap, zero, negative, not a decimal string, or null", () => {
    const over = (RELAY_MAX_AUTH_CALL_MIN_GAS + BigInt(1)).toString();
    for (const minGas of [over, "0", "-1", "065000000000000", "6.5e13", 65_000_000_000_000, null, "9".repeat(21)]) {
      expect(isAllocateIntoVault({ intents: [t, { ...a, min_gas: minGas }, s] }, VAULT)).toBe(false);
    }
  });

  it("the Allocate the app builds passes, min_gas, Storage Cost and all", () => {
    const allocations = [{ tokenId: "nep141:wrap.near", amount: "5" }];
    const build = (storage?: { tokenId: string; amount: string }) =>
      buildAllocateSignRequest({
        signerId: "alice.near",
        vaultId: VAULT,
        deadlineSecs: NOW + 600,
        nonceDeadlineSecs: NOW + 600,
        salt: new Uint8Array(4),
        transfers: allocations,
        authCallMsg: msg({ setup: { allocations: [["nep141:wrap.near", "5"]] } }),
        storage,
      }).intents;
    const intents = build({ tokenId: "nep141:wrap.near", amount: "2" });
    expect(intents[1]).toMatchObject({ min_gas: AUTH_CALL_MIN_GAS });
    expect(isAllocateIntoVault({ intents }, VAULT)).toBe(true);
    expect(isAllocateIntoVault({ intents: build() }, VAULT)).toBe(false);
  });

  it("wants the msg's allocations to be exactly the transferred tokens", () => {
    const with_ = (allocations: unknown, op = "setup") => ({
      intents: [t, { ...a, msg: msg({ [op]: { allocations } }) }, ...(op === "setup" ? [s] : [])],
    });
    expect(isAllocateIntoVault(with_(legs), VAULT)).toBe(true);
    expect(isAllocateIntoVault(with_(legs, "allocate_into"), VAULT)).toBe(true);
    expect(isAllocateIntoVault(with_([["nep141:wrap.near", "5"]]), VAULT)).toBe(false); // a leg missing
    expect(isAllocateIntoVault(with_([["nep141:wrap.near", "5"], ["nep141:wrap.near", "5"]]), VAULT)).toBe(false); // duplicated
    expect(isAllocateIntoVault(with_([["nep141:wrap.near", "6"], ["nep141:usdc.near", "7"]]), VAULT)).toBe(false); // amount
    expect(isAllocateIntoVault(with_(legs, "mint"), VAULT)).toBe(false); // op
    expect(isAllocateIntoVault({ intents: [t, { ...a, msg: "not json" }, s] }, VAULT)).toBe(false);
  });

  // D-528: the Storage Cost exactly as the app builds it — its presence, not its amount.
  it("wants the Storage Cost to the ops account, memo `storage`, in one funded token, a positive amount", () => {
    const setup = (storage: unknown) => isAllocateIntoVault({ intents: [t, a, storage] }, VAULT);
    expect(setup(s)).toBe(true);
    expect(setup({ ...s, tokens: { "nep141:wrap.near": "1" } })).toBe(true); // any funded token
    for (const memo of ["Storage", "storage ", "", "p_000000000001", undefined]) {
      expect(setup({ ...s, memo }), String(memo)).toBe(false);
    }
    expect(setup(Object.fromEntries(Object.entries(s).filter(([key]) => key !== "memo")))).toBe(false);
    expect(setup({ ...s, receiver_id: "attacker.near" })).toBe(false);
    expect(setup({ ...s, receiver_id: VAULT })).toBe(false);
    expect(setup({ ...s, tokens: { "nep141:usdc.near": "3", "nep141:wrap.near": "1" } })).toBe(false); // two tokens
    expect(setup({ ...s, tokens: {} })).toBe(false);
    expect(setup({ ...s, tokens: { "nep141:doge.omft.near": "3" } })).toBe(false); // not a leg of the Setup
    expect(setup({ ...s, tokens: JSON.parse('{"__proto__":"3"}') })).toBe(false); // an own key, as on the wire
    for (const amount of ["0", "01", "1.5", "-1", 3, null]) {
      expect(setup({ ...s, tokens: { "nep141:usdc.near": amount } }), String(amount)).toBe(false);
    }
    for (const extra of [{ msg: "" }, { min_gas: "1" }, { state_init: {} }, { notification: {} }]) {
      expect(setup({ ...s, ...extra }), JSON.stringify(extra)).toBe(false);
    }
  });
});

describe("relay gate — vault (commit)", () => {
  it("passes an implicit NEAR-family signer who owns the portfolio, without asking the key registry", async () => {
    const { signerId, payload } = await nep413Commit();
    const view = vaultView({ get_portfolio: value({ owner: signerId, deleted: false }) });

    await expect(gateWith(view)({ target: "vault", payload })).resolves.toMatchObject({ ok: true, signerId });
    expect(view).toHaveBeenCalledWith(VAULT, "get_portfolio", { portfolio_id: "3" });
    expect(view).not.toHaveBeenCalledWith(INTENTS, "has_public_key", expect.anything());
  });

  it("passes an EVM signer (ETH-implicit account)", async () => {
    const { signerId, payload } = await erc191Commit();
    const view = vaultView({ get_portfolio: value({ owner: signerId }) });
    await expect(gateWith(view)({ target: "vault", payload })).resolves.toMatchObject({ ok: true, signerId });
  });

  it("a named account needs its key registered on the Verifier", async () => {
    const { payload, publicKey } = await nep413Commit({ signerId: "alice.near" });
    const registered = vaultView({ has_public_key: value(true), get_portfolio: value({ owner: "alice.near" }) });
    await expect(gateWith(registered)({ target: "vault", payload })).resolves.toMatchObject({ ok: true, signerId: "alice.near" });
    expect(registered).toHaveBeenCalledWith(INTENTS, "has_public_key", { account_id: "alice.near", public_key: publicKey });

    const foreign = vaultView({ has_public_key: value(false), get_portfolio: value({ owner: "alice.near" }) });
    await expect(gateWith(foreign)({ target: "vault", payload })).resolves.toMatchObject({ ok: false, code: "would-fail" });
  });

  it("refuses an implicit signer_id the key does not control (the vault's E_ACCOUNT_ID_MISMATCH)", async () => {
    const { payload } = await nep413Commit({ signerId: "cd".repeat(32) });
    const view = vaultView({ get_portfolio: value({ owner: "cd".repeat(32) }) });
    await expect(gateWith(view)({ target: "vault", payload })).resolves.toMatchObject({ ok: false, code: "would-fail" });
    expect(view).not.toHaveBeenCalled();
  });

  it("refuses a signer who is not the owner", async () => {
    const { payload } = await nep413Commit();
    const view = vaultView({ get_portfolio: value({ owner: "someone-else.near" }) });
    const verdict = await gateWith(view)({ target: "vault", payload });
    expect(verdict).toMatchObject({ ok: false, code: "would-fail" });
  });

  it("refuses an unknown or deleted portfolio", async () => {
    const { signerId, payload } = await nep413Commit();
    await expect(gateWith(vaultView({ get_portfolio: value(null) }))({ target: "vault", payload })).resolves.toMatchObject({
      ok: false,
      code: "would-fail",
      // run-real-portfolio-meta.ts reads this prefix as "already deleted" for a delete (D-403).
      reason: expect.stringMatching(/^unknown portfolio /),
    });
    await expect(
      gateWith(vaultView({ get_portfolio: value({ owner: signerId, deleted: true }) }))({ target: "vault", payload })
    ).resolves.toMatchObject({ ok: false, code: "would-fail" });
  });

  // D-403 (1): the vault answers E_PORTFOLIO_NOT_EMPTY; the relay would pay gas for that.
  it("refuses a delete of a portfolio that still holds tokens, and passes one that is empty", async () => {
    const { signerId, payload } = await nep413Commit({ edits: { delete: true } });
    const holding = vaultView({ get_portfolio: value({ owner: signerId, held_tokens: ["nep141:wrap.near"] }) });
    await expect(gateWith(holding)({ target: "vault", payload })).resolves.toMatchObject({
      ok: false,
      code: "would-fail",
    });
    const empty = vaultView({ get_portfolio: value({ owner: signerId, held_tokens: [] }) });
    await expect(gateWith(empty)({ target: "vault", payload })).resolves.toMatchObject({ ok: true });
  });

  it("refuses a tampered signature before any view", async () => {
    const { payload } = await nep413Commit();
    const tampered = { ...payload, payload: { ...payload.payload, message: payload.payload.message.replace('"1"', '"2"') } };
    const view = fakeView({});
    await expect(gateWith(view)({ target: "vault", payload: tampered })).resolves.toEqual({
      ok: false,
      code: "would-fail",
      reason: "the signature does not verify",
    });
    expect(view).not.toHaveBeenCalled();
  });

  it("refuses an envelope signed for another contract", async () => {
    const { payload } = await nep413Commit({ vaultId: "other-vault.near" });
    await expect(gateWith(fakeView({}))({ target: "vault", payload })).resolves.toMatchObject({ ok: false, code: "would-fail" });
  });

  it("refuses an expired signature", async () => {
    const { payload } = await nep413Commit({ deadlineSecs: NOW - 1 });
    await expect(gateWith(fakeView({}))({ target: "vault", payload })).resolves.toMatchObject({
      ok: false,
      code: "would-fail",
      reason: "the signature expired",
    });
  });

  it("refuses a commit whose nonce the vault already consumed (a landed commit, replayed)", async () => {
    const { signerId, payload } = await nep413Commit();
    const view = vaultView({ get_portfolio: value({ owner: signerId }), is_commit_nonce_used: value(true) });

    await expect(gateWith(view)({ target: "vault", payload })).resolves.toEqual({
      ok: false,
      code: "would-fail",
      reason: "this signed change was already applied",
    });
    expect(view).toHaveBeenCalledWith(VAULT, "is_commit_nonce_used", { account_id: signerId, nonce: payload.payload.nonce });
  });

  it("passes a free nonce, and lets the owner through when the view has no boolean answer", async () => {
    const { signerId, payload } = await nep413Commit();
    for (const answer of [value(false), panic("MethodNotFound"), value(null), new Error("timeout")]) {
      const view = vaultView({ get_portfolio: value({ owner: signerId }), is_commit_nonce_used: answer });
      await expect(gateWith(view)({ target: "vault", payload })).resolves.toMatchObject({ ok: true });
    }
  });

  it("logs a nonce it could not read, and only then", async () => {
    const { signerId, payload } = await nep413Commit();
    const log = vi.fn();
    await gateWith(vaultView({ get_portfolio: value({ owner: signerId }) }), log)({ target: "vault", payload });
    expect(log).not.toHaveBeenCalled();
    const unreadable = vaultView({ get_portfolio: value({ owner: signerId }), is_commit_nonce_used: new Error("timeout") });
    await gateWith(unreadable, log)({ target: "vault", payload });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not read the commit nonce/));
  });

  it("refuses a portfolio the vault no longer has (a delete removes the record)", async () => {
    const { payload } = await nep413Commit();
    const view = vaultView({ get_portfolio: value(null) });
    await expect(gateWith(view)({ target: "vault", payload })).resolves.toMatchObject({ ok: false, code: "would-fail" });
  });

  it("refuses a signature about to expire, or one past the final contract's 24 h cap", async () => {
    const soon = await nep413Commit({ deadlineSecs: NOW + 10 });
    await expect(gateWith(fakeView({}))({ target: "vault", payload: soon.payload })).resolves.toMatchObject({
      ok: false,
      reason: "the signature expired",
    });
    const far = await nep413Commit({ deadlineSecs: NOW + COMMIT_DEADLINE_CAP_SECS + 60 });
    await expect(gateWith(fakeView({}))({ target: "vault", payload: far.payload })).resolves.toMatchObject({
      ok: false,
      code: "would-fail",
    });
  });

  it("gives each signed commit its own replay key", async () => {
    const a = await nep413Commit();
    const view = vaultView({ get_portfolio: value({ owner: a.signerId }) });
    const verdict = await gateWith(view)({ target: "vault", payload: a.payload });
    const nonceHex = Buffer.from(a.payload.payload.nonce, "base64").toString("hex");
    expect(verdict).toMatchObject({ ok: true, replayKey: `${a.signerId}:${nonceHex}` });
  });

  it("says check-failed when a view had no answer", async () => {
    const { payload } = await nep413Commit();
    const view = vaultView({ get_portfolio: new Error("timeout after 3000ms") });
    await expect(gateWith(view)({ target: "vault", payload })).resolves.toMatchObject({ ok: false, code: "check-failed" });
  });
});

// D-538: the relay reads signed JSON with `JSON.parse`, which keeps the last of two equal keys;
// the contracts read it with serde, which refuses the duplicate. The relay pays only for the
// exact text the app's builders emit — and must keep paying for every family's.
describe("relay gate — canonical JSON (D-538)", () => {
  const allocate = (view: RelayView, payload: unknown) => gateWith(view)({ target: "verifier", payload });
  const simulated = () => fakeView({ simulate_intents: value({ intents_executed: [{}], state: {} }) });
  const ENVELOPE_REASON = expect.stringMatching(/^the signed envelope is not the JSON the app builds/);
  const MSG_REASON = expect.stringMatching(/^the auth_call msg is not the JSON the app builds/);

  /** An AllocateInto as allocate-submit.ts builds it, in both forms; `mangleMsg` edits the msg text. */
  function allocateIntoRequest(signerId: string, mangleMsg: (msg: string) => string = (m) => m): VaultSignRequest {
    return allocateRequest("allocate_into", signerId, mangleMsg);
  }

  /** A Setup or an AllocateInto as allocate-submit.ts builds it, in both forms. */
  function allocateRequest(
    op: "setup" | "allocate_into",
    signerId: string,
    mangleMsg: (msg: string) => string = (m) => m
  ): VaultSignRequest {
    const allocations = [{ tokenId: WNEAR, amount: "1" }];
    const deadline = NOW + AUTH_CALL_TTL_SECS;
    const nonce = Array(32).fill(0);
    const authCallMsg = mangleMsg(
      op === "setup"
        ? buildAuthCallSetupMsg({
            deadline,
            nonce,
            chain: "evm",
            address: signerId,
            portfolioName: "p",
            composition: [{ tokenId: WNEAR, targetBps: 10000, toleranceBps: 500 }],
            allocations,
          })
        : buildAuthCallAllocateIntoMsg({ deadline, nonce, portfolioId: "3", allocations })
    );
    const { request, erc191Message } = buildAllocateSignRequest({
      signerId,
      deadlineSecs: NOW + 600,
      nonceDeadlineSecs: NOW + 3600,
      salt: new Uint8Array(4),
      vaultId: VAULT,
      transfers: allocations,
      authCallMsg,
      // A Setup carries its Storage Cost (D-528), as allocate-submit.ts sends it.
      storage: op === "setup" ? { tokenId: WNEAR, amount: "1" } : undefined,
    });
    return { nep413: request, erc191Message };
  }

  /** The same request with each signed form rewritten before it reaches the wallet. */
  const mangled = (req: VaultSignRequest, compact: (s: string) => string, pretty: (s: string) => string): VaultSignRequest => ({
    nep413: { ...req.nep413, message: compact(req.nep413.message) },
    erc191Message: pretty(req.erc191Message),
  });

  // Well-formed, never valid, signatures: an Allocate's signature is the simulation's to judge.
  const SIG = new Uint8Array(64).fill(7);
  const SIG_BASE64 = Buffer.from(SIG).toString("base64");
  const ED25519_KEY = new Uint8Array(32).fill(9);
  const TON_KEY_HEX = Buffer.from(ED25519_KEY).toString("hex");
  const SOLANA_KEY = bs58.encode(ED25519_KEY);
  const STELLAR_ADDRESS = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

  /** Every family's own signer, as the app wires it (vault-signer.ts), over a wallet that signs whatever it is handed. */
  const families: Array<[string, string, VaultSigner]> = [
    [
      "nep413",
      "alice.near",
      nep413VaultSigner(
        {
          signNEP413Message: async () => ({ accountId: "alice.near", publicKey: `ed25519:${SOLANA_KEY}`, signature: SIG_BASE64 }),
          signAndSendTransaction: async () => undefined,
        },
        "alice.near"
      ),
    ],
    [
      "erc191",
      `0x${"ab".repeat(20)}`,
      erc191VaultSigner(async (m) => ({ scheme: "erc191", payload: m, signature: `0x${"11".repeat(64)}1b` }), `0x${"ab".repeat(20)}`),
    ],
    [
      "tip191",
      `0x${"cd".repeat(20)}`,
      tip191VaultSigner(async (m) => ({ scheme: "tip191", payload: m, signature: `0x${"22".repeat(64)}1c` }), `0x${"cd".repeat(20)}`),
    ],
    [
      "raw_ed25519",
      TON_KEY_HEX,
      ed25519VaultSigner({
        signMessage: async (m) => ({ scheme: "raw_ed25519", payload: m, signature: bs58.encode(SIG), publicKey: SOLANA_KEY }),
        family: "solana",
        signerId: TON_KEY_HEX,
        walletAddress: SOLANA_KEY,
      }),
    ],
    [
      "sep53",
      TON_KEY_HEX,
      ed25519VaultSigner({
        signMessage: async (m) => ({ scheme: "sep53", payload: m, signature: SIG_BASE64, publicKey: STELLAR_ADDRESS }),
        family: "stellar",
        signerId: TON_KEY_HEX,
        walletAddress: STELLAR_ADDRESS,
      }),
    ],
    [
      "ton_connect",
      TON_KEY_HEX,
      tonConnectVaultSigner(
        async (m) => ({
          scheme: "ton_connect",
          address: `0:${TON_KEY_HEX}`,
          domain: "intentfolio.app",
          timestamp: "1800000000",
          text: m,
          signature: SIG_BASE64,
          publicKey: TON_KEY_HEX,
        }),
        TON_KEY_HEX,
        TON_KEY_HEX
      ),
    ],
  ];

  it.each(families)("pays for the Allocate the %s signer ships, built by the app's own builders", async (standard, signerId, signer) => {
    const payload = await signer.signEnvelope(allocateIntoRequest(signerId));
    expect(payload).toMatchObject({ standard });
    await expect(allocate(simulated(), payload)).resolves.toMatchObject({ ok: true, signerId });
  });

  it("pays for a Setup whose name needs escaping", async () => {
    const { payload } = allocatePayload({ setup: { portfolioName: 'Mi "cartera" \\ 🚀 é' } });
    await expect(allocate(setupView({}), payload)).resolves.toMatchObject({ ok: true });
  });

  // A duplicate the gate's JSON.parse would hide: it keeps the real value, which comes last.
  const DUPLICATE = "2000-01-01T00:00:00.000Z";
  const duplicateCompact = (s: string) => s.replace("{", `{"deadline":"${DUPLICATE}",`);
  const duplicatePretty = (s: string) => s.replace("{\n", `{\n  "deadline": "${DUPLICATE}",\n`);

  it.each(families)("refuses a %s envelope with a duplicate key, before any view", async (_standard, signerId, signer) => {
    const original = allocateIntoRequest(signerId);
    const req = mangled(original, duplicateCompact, duplicatePretty);
    // What makes it dangerous: read the gate's way, it is the very envelope the app built.
    expect(JSON.parse(req.erc191Message)).toEqual(JSON.parse(original.erc191Message));
    expect(JSON.parse(req.nep413.message)).toEqual(JSON.parse(original.nep413.message));
    const view = fakeView({});
    await expect(allocate(view, await signer.signEnvelope(req))).resolves.toEqual({ ok: false, code: "would-fail", reason: ENVELOPE_REASON });
    expect(view).not.toHaveBeenCalled();
  });

  it.each(families)("refuses a %s envelope signed in another layout, before any view", async (_standard, signerId, signer) => {
    const req = mangled(
      allocateIntoRequest(signerId),
      (s) => JSON.stringify(JSON.parse(s), null, 2),
      (s) => JSON.stringify(JSON.parse(s))
    );
    const view = fakeView({});
    await expect(allocate(view, await signer.signEnvelope(req))).resolves.toEqual({ ok: false, code: "would-fail", reason: ENVELOPE_REASON });
    expect(view).not.toHaveBeenCalled();
  });

  it.each(["setup", "allocate_into"] as const)(
    "refuses a %s auth_call msg with a duplicate key or another layout, which the simulation never reads",
    async (op) => {
      const [, signerId, signer] = families[1];
      for (const mangleMsg of [
        (m: string) => m.replace("{", `{"deadline":${NOW + 60},`),
        (m: string) => JSON.stringify(JSON.parse(m), null, 2),
      ]) {
        const view = fakeView({});
        const payload = await signer.signEnvelope(allocateRequest(op, signerId, mangleMsg));
        await expect(allocate(view, payload)).resolves.toEqual({ ok: false, code: "would-fail", reason: MSG_REASON });
        expect(view).not.toHaveBeenCalled();
      }
    }
  );

  // JSON.stringify writes a lone surrogate as "\ud83d", which round-trips; serde refuses it in
  // `on_auth`, after the transfer settled.
  it("refuses a Setup whose name holds a lone surrogate, before any view", async () => {
    const view = setupView({});
    const { payload } = allocatePayload({ setup: { portfolioName: "a\ud83d" } });
    await expect(allocate(view, payload)).resolves.toEqual({ ok: false, code: "would-fail", reason: MSG_REASON });
    expect(view).not.toHaveBeenCalled();
  });

  it("refuses a commit whose signed message has a duplicate key or another layout, though its signature verifies", async () => {
    for (const mangle of [duplicateCompact, (m: string) => JSON.stringify(JSON.parse(m), null, 2)]) {
      const { payload } = await nep413Commit({ mangle });
      const view = fakeView({});
      await expect(gateWith(view)({ target: "vault", payload })).resolves.toEqual({ ok: false, code: "would-fail", reason: ENVELOPE_REASON });
      expect(view).not.toHaveBeenCalled();
    }
    for (const mangle of [duplicatePretty, (m: string) => JSON.stringify(JSON.parse(m))]) {
      const { payload } = await erc191Commit({ mangle });
      const view = fakeView({});
      await expect(gateWith(view)({ target: "vault", payload })).resolves.toEqual({ ok: false, code: "would-fail", reason: ENVELOPE_REASON });
      expect(view).not.toHaveBeenCalled();
    }
  });
});
