// @vitest-environment jsdom
// The commit runner against the vault's positions (017-9a): locks, the batch view (D-379),
// additions with a target and the limits read from `get_config`.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { runRealUnallocate } from "./run-real-unallocate";
import { resetPreflightLimitsCache } from "./vault-limits";
import type { NearSigner } from "./allocate-submit";
import { nep413VaultSigner } from "./vault-signer";
import { walletSubmitter } from "./envelope-submitter";

const USDC = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
const PID = "p_000000000000";

const LIMITS = {
  max_portfolios_per_account: 16,
  max_tokens_per_portfolio: 32,
  max_token_id_len: 128,
  max_portfolio_name_len: 128,
  max_wallet_address_len: 128,
  max_unalloc_legs_per_commit: 32,
  max_composition_changes_per_commit: 64,
  target_sum_bps: 10_000,
  tolerance_min_bps: 200,
  tolerance_max_bps: 3_000,
};

function viewResponse(value: unknown): Response {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
  return new Response(
    JSON.stringify({ result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/** Answers per view method; each entry is the successive replies, the last one repeating. */
function stubViews(replies: Record<string, unknown[]>) {
  const calls: Record<string, number> = {};
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const method = JSON.parse(init.body as string).params.method_name as string;
    const sequence = replies[method];
    if (!sequence) throw new Error(`unexpected view ${method}`);
    const n = calls[method] ?? 0;
    calls[method] = n + 1;
    return viewResponse(sequence[Math.min(n, sequence.length - 1)]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const eventLog = (event: string, data: Record<string, unknown>) =>
  `EVENT_JSON:${JSON.stringify({ standard: "intentfolio-vault", version: "1.0.0", event, data: [data] })}`;

function makeSigner(logs: string[]): NearSigner {
  return {
    signNEP413Message: vi.fn().mockResolvedValue({
      accountId: "denance02.near",
      publicKey: "ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN",
      signature: Buffer.from(new Uint8Array(64)).toString("base64"),
    }),
    signAndSendTransaction: vi.fn().mockResolvedValue({
      transaction_outcome: { id: "CommitTx", outcome: { logs: [] } },
      receipts_outcome: [{ outcome: { logs, status: { SuccessValue: "" } } }],
    }),
  };
}

function run(signer: NearSigner, over: Partial<Parameters<typeof runRealUnallocate>[0]> = {}) {
  return runRealUnallocate({
    accountId: "denance02.near",
    portfolioId: PID,
    requests: [],
    signer: nep413VaultSigner(signer, "denance02.near"),
    loginChain: "near" as const,
    nearWallet: signer,
    submit: walletSubmitter(signer),
    poll: { sleep: () => Promise.resolve() },
    ...over,
  });
}

const signedMessage = (signer: NearSigner) =>
  JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);

beforeEach(() => {
  window.localStorage.clear();
  resetPreflightLimitsCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runRealUnallocate — positions, locks and limits", () => {
  it("caps a Max at `available`: a withdrawal in flight locks part of the position", async () => {
    stubViews({
      get_portfolio_positions: [
        [{ token: USDC, qty_held: "1000000", locked_qty: "400000", available: "600000", matures_at: 0 }],
      ],
      // After settlement: the whole position less this leg (the lock settles on its own).
      get_portfolio_balance: [[[USDC, "400000"]]],
      get_pending_unallocation: [null],
    });
    const signer = makeSigner([eventLog("pending_unallocation_opened", { commit_id: "c1" })]);

    await run(signer, { requests: [{ tokenId: USDC, qty: 1 }] });

    expect(signedMessage(signer).unallocations).toEqual([[USDC, "600000"]]);
  });

  // D-379: H = 1.0 held, L = 0.6 locked by an earlier withdrawal, Max = 0.4, expected remainder
  // 0.6. The earlier one settling alone drops the balance to 0.4 ≤ 0.6 — which the balance rule
  // alone read as OUR withdrawal done. Our batch is still pending, so it must keep waiting.
  it("D-379: does not call the withdrawal done while OUR batch is still pending", async () => {
    const fetchMock = stubViews({
      get_portfolio_positions: [
        [{ token: USDC, qty_held: "1000000", locked_qty: "600000", available: "400000", matures_at: 0 }],
      ],
      get_portfolio_balance: [[[USDC, "400000"]], [[USDC, "400000"]], [[USDC, "0"]]],
      get_pending_unallocation: [{ commit_id: "c1" }, { commit_id: "c1" }, null],
    });
    const signer = makeSigner([eventLog("pending_unallocation_opened", { commit_id: "c1" })]);

    const result = await run(signer, { requests: [{ tokenId: USDC, qty: 1 }] });

    const pendingReads = fetchMock.mock.calls.filter(
      ([, init]) => JSON.parse((init as RequestInit).body as string).params.method_name === "get_pending_unallocation"
    );
    expect(pendingReads).toHaveLength(3);
    expect(JSON.parse(atob(JSON.parse(pendingReads[0][1].body).params.args_base64))).toEqual({ commit_id: "c1" });
    expect(result).toMatchObject({ kind: "settled" });
  });

  it("D-379: without the event's commit_id the balance rule decides alone — the batch view is not read", async () => {
    const fetchMock = stubViews({
      get_portfolio_positions: [
        [{ token: USDC, qty_held: "1000000", locked_qty: "0", available: "1000000", matures_at: 0 }],
      ],
      get_portfolio_balance: [[[USDC, "0"]]],
    });
    const signer = makeSigner([]); // an outcome with no pending_unallocation_opened

    const result = await run(signer, { requests: [{ tokenId: USDC, qty: 1 }] });

    expect(result).toMatchObject({ kind: "settled" });
    const methods = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).params.method_name);
    expect(methods).not.toContain("get_pending_unallocation");
  });

  it("refuses before signing when everything is locked", async () => {
    stubViews({
      get_portfolio_positions: [
        [{ token: USDC, qty_held: "1000000", locked_qty: "1000000", available: "0", matures_at: 0 }],
      ],
    });
    const signer = makeSigner([]);
    await expect(run(signer, { requests: [{ tokenId: USDC, qty: 1 }] })).rejects.toThrow(/can be withdrawn/);
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  it("signs a new token with its target in the same commit (FE #6)", async () => {
    const before = { owner: "denance02.near", name: "x", composition: [{ token_id: USDC, target_bps: 10_000, tolerance_bps: 500 }], held_tokens: [USDC], created_at: 1 };
    const after = {
      ...before,
      composition: [
        { token_id: USDC, target_bps: 6_000, tolerance_bps: 500 },
        { token_id: "nep141:wrap.near", target_bps: 4_000, tolerance_bps: 300 },
      ],
    };
    stubViews({ get_portfolio: [before, after], get_config: [{ limits: LIMITS }] });
    const signer = makeSigner([]);

    await run(signer, {
      composition: {
        targetChanges: [{ tokenId: USDC, targetPct: 60, tolerancePct: 5 }],
        tokenAdditions: [{ tokenId: "near", targetPct: 40, tolerancePct: 3 }],
      },
    });

    expect(signedMessage(signer).token_additions).toEqual([["nep141:wrap.near", 4000, 300]]);
  });

  it("does not sign when get_config cannot be read (the limits fail closed)", async () => {
    const before = { owner: "denance02.near", name: "x", composition: [{ token_id: USDC, target_bps: 10_000, tolerance_bps: 500 }], held_tokens: [USDC], created_at: 1 };
    const fetchMock = stubViews({ get_portfolio: [before] });
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const method = JSON.parse(init.body as string).params.method_name;
      if (method === "get_portfolio") return viewResponse(before);
      return new Response("bad gateway", { status: 502 });
    });
    const signer = makeSigner([]);

    await expect(
      run(signer, { composition: { targetChanges: [{ tokenId: USDC, targetPct: 100, tolerancePct: 4 }] } })
    ).rejects.toThrow();
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });
});
