// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  runRealUnallocate,
  RealUnallocateUnconfirmedError,
  type RealUnallocateStage,
} from "./run-real-unallocate";
import { RealChangeSetInvalidError, RealUnallocateTransferFailedError } from "./vault-errors";
import { resetPreflightLimitsCache } from "./vault-limits";
import type { NearSigner } from "./allocate-submit";
import { nep413VaultSigner } from "./vault-signer";
import { walletSubmitter } from "./envelope-submitter";
import { toBaseUnits } from "./base-units";
import { RelayError } from "./relay-client";

// End-to-end orchestration of the return leg, wallet and RPC faked. USDC (Ethereum) is
// used because it exists in the registry with 6 decimals.
const USDC = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
const PID = "p_000000000000";

function viewResponse(value: unknown): Response {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
  return new Response(
    JSON.stringify({ result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/** `get_config` as the vault answers it: the limits the pre-flight reads (vault-limits.ts). */
const CONFIG = {
  portfolio_counter: 1,
  return_counter: 0,
  limits: {
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
  },
};

/** A position with nothing locked and no clock: all of it can be withdrawn. */
const positions = (balances: Array<[string, string]>) =>
  balances.map(([token, qty]) => ({ token, qty_held: qty, locked_qty: "0", available: qty, matures_at: 0 }));

/**
 * The views a withdrawal reads. `sequence[0]` is the position before signing
 * (`get_portfolio_positions`); `sequence[1..]` are the settlement poll's successive
 * `get_portfolio_balance` replies, the last one repeating. Our batch reads as resolved.
 */
function answerWithdrawalViews(method: string, sequence: Array<Array<[string, string]>>, pollCall: () => number) {
  if (method === "get_portfolio_positions") return viewResponse(positions(sequence[0]));
  if (method === "get_portfolio_balance") return viewResponse(sequence[Math.min(1 + pollCall(), sequence.length - 1)]);
  if (method === "get_pending_unallocation") return viewResponse(null);
  if (method === "get_config") return viewResponse(CONFIG);
  return null;
}

function stubBalances(sequence: Array<Array<[string, string]>>) {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const method = JSON.parse(init.body as string).params.method_name;
      const reply = answerWithdrawalViews(method, sequence, () => call++);
      if (!reply) throw new Error(`unexpected view ${method}`);
      return reply;
    })
  );
}

function eventLog(event: string, data: Record<string, unknown>): string {
  return `EVENT_JSON:${JSON.stringify({
    standard: "intentfolio-vault",
    version: "1.0.0",
    event,
    data: [data],
  })}`;
}

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

const ACCEPTED = [eventLog("pending_unallocation_opened", { commit_id: "c1" })];

function run(signer: NearSigner, over: Partial<Parameters<typeof runRealUnallocate>[0]> = {}) {
  return runRealUnallocate({
    accountId: "denance02.near",
    portfolioId: PID,
    requests: [{ tokenId: USDC, qty: 1 }],
    signer: nep413VaultSigner(signer, "denance02.near"),
    loginChain: "near" as const,
    nearWallet: signer,
    submit: walletSubmitter(signer),
    poll: { sleep: () => Promise.resolve() },
    ...over,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetPreflightLimitsCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runRealUnallocate — happy path", () => {
  it("drains the position and reports what the vault still holds", async () => {
    stubBalances([[[USDC, "1000000"]], []]);
    const signer = makeSigner(ACCEPTED);
    const stages: RealUnallocateStage[] = [];

    const result = await run(signer, { onStage: (s) => stages.push(s) });

    expect(result).toEqual({ kind: "settled", txHash: "CommitTx", remaining: {} });
    expect(stages).toEqual([
      "preparing",
      "signing",
      "submitting",
      "awaiting-settlement",
      "settled",
    ]);
  });

  it("sends the on-chain bigint verbatim for a full withdrawal, leaving no dust", async () => {
    // A float round-trip of this amount is exactly the case that would strand a base unit.
    stubBalances([[[USDC, "1234567"]], []]);
    const signer = makeSigner(ACCEPTED);

    await run(signer, { requests: [{ tokenId: USDC, qty: 1.234567 }] });

    const message = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    expect(message.unallocations).toEqual([[USDC, "1234567"]]);
  });

  // D-313, both real cases from the s163 smoke. The dialog's Max is `currentUsd / price`, a
  // float that lands a few parts in 10^17 BELOW the 24-decimal position about half the time;
  // `requested >= onChain` read that as a partial and left the gap as dust in the portfolio.
  // `qty` is the float the modal carried then, recovered from the amount it actually signed.
  it.each([
    ["248071769999999997002859", 0.24807176999999997, "p_000000000012, left 27002859 yocto"],
    ["798071770987143215177784", 0.7980717709871432, "p_000000000016, left 15177784 yocto"],
  ])("sends the exact position %s for a Max just below it (%s — %s)", async (onChain, qty) => {
    expect(BigInt(toBaseUnits(qty, 24))).toBeLessThan(BigInt(onChain));
    // The vault answers in ITS space; the registry id is "near".
    stubBalances([[["nep141:wrap.near", onChain]], []]);
    const signer = makeSigner(ACCEPTED);

    await run(signer, { requests: [{ tokenId: "near", qty }] });

    const message = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    expect(message.unallocations).toEqual([["nep141:wrap.near", onChain]]);
  });

  it("still sends a partial amount just outside float noise as asked", async () => {
    // One part in 10^11 below: a real (if tiny) difference, not Max — it must not be rounded
    // up to everything.
    stubBalances([[["nep141:wrap.near", "1000000000000000000000000"]], []]);
    const signer = makeSigner(ACCEPTED);

    await run(signer, { requests: [{ tokenId: "near", qty: 0.99999999999 }] });

    const message = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    expect(message.unallocations).toEqual([["nep141:wrap.near", "999999999990000000000000"]]);
  });

  it("clamps a request that exceeds the position instead of overshooting the ledger", async () => {
    stubBalances([[[USDC, "1000000"]], []]);
    const signer = makeSigner(ACCEPTED);

    await run(signer, { requests: [{ tokenId: USDC, qty: 999 }] });

    const message = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    expect(message.unallocations).toEqual([[USDC, "1000000"]]);
  });

  it("sends a partial amount as asked and keeps the remainder", async () => {
    stubBalances([[[USDC, "1000000"]], [[USDC, "600000"]]]);
    const signer = makeSigner(ACCEPTED);

    const result = await run(signer, { requests: [{ tokenId: USDC, qty: 0.4 }] });

    const message = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    expect(message.unallocations).toEqual([[USDC, "400000"]]);
    expect(result).toMatchObject({ kind: "settled", remaining: { [USDC]: 0.6 } });
  });
});

describe("runRealUnallocate — deferred (immature position)", () => {
  const deferredLogs = [
    eventLog("unallocate_deferred", {
      account_id: "denance02.near",
      portfolio_id: PID,
      token: USDC,
      qty_requested: "1000000",
      qty_available: "1000000",
      next_release_at: 1_800_000_300,
      reason: "maturity",
    }),
  ];

  it("reports the defer instead of claiming the funds moved", async () => {
    stubBalances([[[USDC, "1000000"]]]);
    const stages: RealUnallocateStage[] = [];

    const result = await run(makeSigner(deferredLogs), { onStage: (s) => stages.push(s) });

    expect(result).toEqual({
      kind: "deferred",
      txHash: "CommitTx",
      nextReleaseAt: 1_800_000_300,
      tokenId: USDC,
    });
    expect(stages).not.toContain("settled");
  });
});

describe("runRealUnallocate — failures", () => {
  it("refuses to build a withdrawal for a position the vault does not hold", async () => {
    stubBalances([[]]);
    const signer = makeSigner(ACCEPTED);

    await expect(run(signer)).rejects.toThrow(/holds no USDC\(ETH\) for this portfolio that can be withdrawn$/);
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  it("surfaces a reverted batch transfer as a failure, not as a settlement", async () => {
    stubBalances([[[USDC, "1000000"]]]);
    const signer = makeSigner([
      eventLog("unallocate_failed", { commit_id: "c1", reason: "mt_batch_transfer reverted" }),
    ]);

    await expect(run(signer)).rejects.toBeInstanceOf(RealUnallocateTransferFailedError);
  });

  it("reports an unobserved settlement as unconfirmed, keeping the tx hash", async () => {
    stubBalances([[[USDC, "1000000"]]]); // never drains
    const stages: RealUnallocateStage[] = [];

    const error = await run(makeSigner(ACCEPTED), {
      onStage: (s) => stages.push(s),
      poll: { sleep: () => Promise.resolve(), timeoutMs: 1 },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(RealUnallocateUnconfirmedError);
    expect((error as RealUnallocateUnconfirmedError).txHash).toBe("CommitTx");
    expect(stages).toContain("pending-unconfirmed");
  });

  // D-329, D-330: the relayer sent and cannot say how it ended. The settlement poll decides.
  const unanswered = () =>
    vi.fn().mockRejectedValue(new RelayError("no answer within 30000ms", "unknown-outcome", 504, "SentTx"));

  it("settles an unanswered withdrawal once the chain shows it drained", async () => {
    stubBalances([[[USDC, "1000000"]], []]);
    const result = await run(makeSigner(ACCEPTED), { submit: unanswered() });
    expect(result).toEqual({ kind: "settled", txHash: "SentTx", remaining: {} });
  });

  it("ends an unanswered withdrawal the chain never shows as unconfirmed, with the relayer's hash", async () => {
    stubBalances([[[USDC, "1000000"]]]); // never drains
    const error = await run(makeSigner(ACCEPTED), {
      submit: unanswered(),
      poll: { sleep: () => Promise.resolve(), timeoutMs: 1 },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(RealUnallocateUnconfirmedError);
    expect((error as RealUnallocateUnconfirmedError).txHash).toBe("SentTx");
  });
});

// ── Composition edits (008.plan Phase 2) ─────────────────────────────────────
describe("runRealUnallocate — composition edits", () => {
  // NEAR is the one token the two sides spell differently, so it is the one that proves
  // the translation: the CHAIN stores `nep141:wrap.near`, the editor and the registry say
  // `near`, and the fold has to line them up (intents-token-id.ts).
  const WNEAR = "nep141:wrap.near"; // as the vault stores it
  const NEAR = "near";              // as the editor sends it

  type ChainRow = { token_id: string; target_bps: number; tolerance_bps: number };

  /**
   * Replies to `get_portfolio` (the fold base) and the withdrawal's views (`balances` as in
   * `stubBalances`).
   *
   * `get_portfolio` is read TWICE on a composition-only commit: once before signing (the
   * fold base) and then by the confirmation poll until the new composition is visible.
   * `afterCommit` is what the chain reports from the second read on — pass it whenever the
   * commit is expected to succeed, or the poll will spin until its timeout.
   */
  function stubPortfolio(
    composition: ChainRow[],
    balances: Array<Array<[string, string]>> = [[]],
    afterCommit?: ChainRow[]
  ) {
    let balanceCall = 0;
    let portfolioCall = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const method = JSON.parse(init.body as string).params.method_name;
        if (method === "get_portfolio") {
          const composed = portfolioCall === 0 ? composition : (afterCommit ?? composition);
          portfolioCall += 1;
          return viewResponse({
            owner: "denance02.near",
            name: "Conservative",
            composition: composed,
            held_tokens: [USDC],
            created_at: 1,
            deleted: false,
            deleted_at: 0,
          });
        }
        const reply = answerWithdrawalViews(method, balances, () => balanceCall++);
        if (!reply) throw new Error(`unexpected view ${method}`);
        return reply;
      })
    );
  }

  const CURRENT = [
    { token_id: USDC, target_bps: 6_000, tolerance_bps: 500 },
    { token_id: WNEAR, target_bps: 4_000, tolerance_bps: 500 },
  ];

  const RETARGETED = [
    { token_id: USDC, target_bps: 7_000, tolerance_bps: 500 },
    { token_id: WNEAR, target_bps: 3_000, tolerance_bps: 500 },
  ];

  it("commits a retarget with no withdrawal and opens no pending", async () => {
    stubPortfolio(CURRENT, [[]], RETARGETED);
    const signer = makeSigner([]);
    const stages: RealUnallocateStage[] = [];

    const result = await run(signer, {
      requests: [],
      composition: {
        targetChanges: [
          { tokenId: USDC, targetPct: 70, tolerancePct: 5 },
          { tokenId: NEAR, targetPct: 30, tolerancePct: 5 },
        ],
      },
      onStage: (s) => stages.push(s),
    });

    expect(result).toEqual({ kind: "committed", txHash: "CommitTx" });
    expect(stages).toEqual(["preparing", "signing", "submitting", "awaiting-settlement", "settled"]);
  });

  // The regression: this used to return the instant the relayer had submitted. The caller
  // then invalidated the read-model, that refetch raced the chain and cached the PRE-commit
  // composition — so a saved change looked lost until a manual reload (008.plan Phase 2).
  it("does NOT return until the chain reports the new composition", async () => {
    let portfolioReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const method = JSON.parse(init.body as string).params.method_name;
        if (method === "get_portfolio") {
          portfolioReads += 1;
          // Read 1 = the fold base. Reads 2-3 = the chain has not caught up yet.
          const composition = portfolioReads >= 4 ? RETARGETED : CURRENT;
          return viewResponse({
            owner: "denance02.near",
            name: "Conservative",
            composition,
            held_tokens: [USDC],
            created_at: 1,
            deleted: false,
            deleted_at: 0,
          });
        }
        if (method === "get_portfolio_balance") return viewResponse([]);
        if (method === "get_config") return viewResponse(CONFIG);
        throw new Error(`unexpected view ${method}`);
      })
    );

    const result = await run(makeSigner([]), {
      requests: [],
      composition: {
        targetChanges: [
          { tokenId: USDC, targetPct: 70, tolerancePct: 5 },
          { tokenId: NEAR, targetPct: 30, tolerancePct: 5 },
        ],
      },
    });

    expect(result.kind).toBe("committed");
    // It kept reading past the stale replies instead of returning on the first one.
    expect(portfolioReads).toBe(4);
  });

  it("still returns when the commit cannot be observed — an unseen commit is not a failure", async () => {
    // The chain never reports the change (slow node). The commit IS on-chain; reporting a
    // failure here would be the worse lie, so the call resolves normally.
    stubPortfolio(CURRENT, [[]]); // afterCommit omitted → always the OLD composition
    let clock = 0;

    const result = await run(makeSigner([]), {
      requests: [],
      composition: {
        targetChanges: [
          { tokenId: USDC, targetPct: 70, tolerancePct: 5 },
          { tokenId: NEAR, targetPct: 30, tolerancePct: 5 },
        ],
      },
      poll: { sleep: () => Promise.resolve(), now: () => (clock += 10_000), timeoutMs: 20_000 },
    });

    expect(result).toEqual({ kind: "committed", txHash: "CommitTx" });
  });

  // …but only because the chain SAID it ran it. When the relayer could not say (D-329), an
  // unseen composition proves nothing: it ends "not confirmed", never "saved".
  it("reports an unanswered composition commit the chain never shows as unconfirmed", async () => {
    stubPortfolio(CURRENT, [[]]);
    let clock = 0;
    const stages: RealUnallocateStage[] = [];

    const error = await run(makeSigner([]), {
      requests: [],
      composition: {
        targetChanges: [
          { tokenId: USDC, targetPct: 70, tolerancePct: 5 },
          { tokenId: NEAR, targetPct: 30, tolerancePct: 5 },
        ],
      },
      submit: vi.fn().mockRejectedValue(new RelayError("HTTP 503", "unknown-outcome", 504, "SentTx")),
      onStage: (s) => stages.push(s),
      poll: { sleep: () => Promise.resolve(), now: () => (clock += 10_000), timeoutMs: 20_000 },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(RealUnallocateUnconfirmedError);
    expect((error as RealUnallocateUnconfirmedError).txHash).toBe("SentTx");
    expect(stages.at(-1)).toBe("pending-unconfirmed");
  });

  it("saves an unanswered composition commit once the chain shows it", async () => {
    stubPortfolio(CURRENT, [[]], RETARGETED);
    const result = await run(makeSigner([]), {
      requests: [],
      composition: {
        targetChanges: [
          { tokenId: USDC, targetPct: 70, tolerancePct: 5 },
          { tokenId: NEAR, targetPct: 30, tolerancePct: 5 },
        ],
      },
      submit: vi.fn().mockRejectedValue(new RelayError("HTTP 503", "unknown-outcome", 504, "SentTx")),
    });
    expect(result).toEqual({ kind: "committed", txHash: "SentTx" });
  });

  it("sends the three composition lists in the signed change set", async () => {
    stubPortfolio(
      [...CURRENT, { token_id: "nep141:dai.near", target_bps: 0, tolerance_bps: 500 }],
      [[]],
      [
        { token_id: USDC, target_bps: 6_000, tolerance_bps: 800 },
        { token_id: WNEAR, target_bps: 4_000, tolerance_bps: 500 },
        { token_id: "nep141:aurora", target_bps: 0, tolerance_bps: 1_000 },
      ]
    );
    const signer = makeSigner([]);

    await run(signer, {
      requests: [],
      composition: {
        targetChanges: [{ tokenId: USDC, targetPct: 60, tolerancePct: 8 }],
        tokenAdditions: [{ tokenId: "nep141:aurora", tolerancePct: 10 }],
        tokenRemovals: ["nep141:dai.near"],
      },
    });

    const inner = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    expect(inner.target_changes).toEqual([[USDC, 6_000, 800]]);
    // No target asked for: the addition joins at 0%.
    expect(inner.token_additions).toEqual([["nep141:aurora", 0, 1_000]]);
    expect(inner.token_removals).toEqual(["nep141:dai.near"]);
    expect(inner.unallocations).toEqual([]);
  });

  it("withdraws and edits in ONE signature when both are asked for", async () => {
    stubPortfolio(CURRENT, [[[USDC, "1000000"]], []]);
    const signer = makeSigner(ACCEPTED);

    const result = await run(signer, {
      requests: [{ tokenId: USDC, qty: 1 }],
      composition: {
        targetChanges: [
          { tokenId: USDC, targetPct: 50, tolerancePct: 5 },
          { tokenId: NEAR, targetPct: 50, tolerancePct: 5 },
        ],
      },
    });

    expect(result.kind).toBe("settled");
    expect(signer.signNEP413Message).toHaveBeenCalledTimes(1);
    const inner = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    expect(inner.target_changes).toHaveLength(2);
    expect(inner.unallocations).toEqual([[USDC, "1000000"]]);
    // The editor said "near"; what gets SIGNED must be the id the contract knows.
    expect(inner.target_changes.map((r: [string, number, number]) => r[0])).toEqual([
      USDC,
      WNEAR,
    ]);
  });

  it("folds against the CHAIN's composition, not the editor's belief", async () => {
    // The chain does not have this token; a stale read-model is exactly how a retarget of
    // an absent token gets built. Rejected before the wallet is touched.
    stubPortfolio(CURRENT);
    const signer = makeSigner([]);

    const error = await run(signer, {
      requests: [],
      composition: { targetChanges: [{ tokenId: "nep141:ghost.near", targetPct: 10, tolerancePct: 5 }] },
    }).catch((e: unknown) => e);

    expect((error as RealChangeSetInvalidError).reason).toBe("retarget-absent-token");
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  it("refuses a retarget that leaves the targets short of 100%", async () => {
    stubPortfolio(CURRENT);
    const signer = makeSigner([]);

    const error = await run(signer, {
      requests: [],
      composition: { targetChanges: [{ tokenId: USDC, targetPct: 70, tolerancePct: 5 }] },
    }).catch((e: unknown) => e);

    expect((error as RealChangeSetInvalidError).reason).toBe("targets-not-100");
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  it("refuses a commit that would carry neither funds nor edits", async () => {
    stubPortfolio(CURRENT);
    await expect(run(makeSigner([]), { requests: [], composition: {} })).rejects.toThrow(
      /at least one token or one composition change/
    );
  });
});
