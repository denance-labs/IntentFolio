// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  runRealAllocate,
  RealAllocateUnconfirmedError,
  type RealAllocateStage,
} from "./run-real-allocate";
import { listAllocateRecords } from "./allocate-rescue-store";
import { AmountExceedsBalanceError } from "./base-units";
import type { NearSigner } from "./allocate-submit";
import { nep413VaultSigner } from "./vault-signer";
import { walletSubmitter } from "./envelope-submitter";
import { resetPreflightLimitsCache } from "./vault-limits";
import type { PortfolioChangeSet } from "@/features/intents-account/mock-contract/types";
import { storageCostBytes } from "./storage-cost";

// End-to-end orchestration with the wallet and RPC faked. USDC (Ethereum) is used because
// it exists in the registry with 6 decimals.
const USDC = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";

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

function viewResponse(value: unknown): Response {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
  return new Response(
    JSON.stringify({ result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// The pre-signing cap read (D-303): one balance per requested token. Ample unless a test
// asks for a specific figure — the cap itself is exercised in its own describe block.
function heldResponse(init: RequestInit, held = "1000000000000000000000000000"): Response {
  const args = JSON.parse(atob(JSON.parse(init.body as string).params.args_base64));
  return viewResponse(args.token_ids.map(() => held));
}

// Replies per view method. The FIRST list_portfolios_for is the pre-submit snapshot and
// must NOT contain the portfolio the Allocate is about to create — that diff is how the
// poll identifies it. Later calls include it.
function stubRpc(opts: { portfolios: string[]; balance: string | null; held?: string; existing?: string[] }) {
  let listCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const method = JSON.parse(init.body as string).params.method_name;
      if (method === "get_config") return viewResponse(CONFIG);
      if (method === "current_salt") return viewResponse("252812b3");
      if (method === "mt_batch_balance_of") return heldResponse(init, opts.held);
      if (method === "list_portfolios_for") {
        listCalls += 1;
        return viewResponse(listCalls === 1 ? (opts.existing ?? []) : opts.portfolios);
      }
      if (method === "get_portfolio_balance") {
        return viewResponse(opts.balance === null ? [] : [[USDC, opts.balance]]);
      }
      throw new Error(`unexpected view ${method}`);
    })
  );
}

const signer: NearSigner = {
  signNEP413Message: vi.fn().mockResolvedValue({
    accountId: "alice.near",
    publicKey: "ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN",
    signature: Buffer.from(new Uint8Array(64)).toString("base64"),
  }),
  signAndSendTransaction: vi.fn().mockResolvedValue({ transaction_outcome: { id: "Tx1" } }),
};

const changeset: PortfolioChangeSet = {
  tokenAdditions: [{ tokenId: USDC, initialTargetPct: 100, initialTolerancePct: 5 }],
  allocations: [{ tokenId: USDC, qty: 1 }],
};

/**
 * The Storage Cost of a changeset as the confirmation would price it (D-528): 10 000 base units
 * of its first leg. Deducted from that leg, so a test about amounts reads `vault + storage`.
 */
const STORAGE_AMOUNT = BigInt(10_000);
const storageFor = (cs: PortfolioChangeSet, loginAddress = "alice.near", amount = STORAGE_AMOUNT) => ({
  tokenId: cs.allocations?.[0]?.tokenId ?? USDC,
  amount,
  bytes: storageCostBytes({
    accountId: "alice.near",
    loginAddress,
    portfolioName: "Wet Test",
    compositionTokenIds: (cs.tokenAdditions ?? []).map((t) => t.tokenId),
    fundedTokenIds: (cs.allocations ?? []).map((a) => a.tokenId),
  }),
});

function run(over: Partial<Parameters<typeof runRealAllocate>[0]> = {}) {
  return runRealAllocate({
    accountId: "alice.near",
    portfolioName: "Wet Test",
    changeset,
    storage: storageFor(over.changeset ?? changeset, over.loginWalletAddress),
    signer: nep413VaultSigner(signer, "alice.near"),
    loginChain: "near" as const,
    loginWalletAddress: "alice.near",
    nearWallet: signer,
    submit: walletSubmitter(signer),
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
  vi.clearAllMocks();
});

describe("runRealAllocate", () => {
  // D-361: `apply_setup` refuses a portfolio past the cap inside `on_auth`, after the Transfer —
  // an orphan. The count is the chain's, read in the round trip the click already makes. The cap
  // is the app's 7, under the vault's 16 (D-476).
  it("refuses the 8th portfolio before anything is signed, with a typed reason", async () => {
    const existing = Array.from({ length: 7 }, (_, i) => `p_${i}`);
    stubRpc({ portfolios: existing, balance: "1000000", existing });
    await expect(run()).rejects.toMatchObject({ name: "RealChangeSetInvalidError", reason: "too-many-portfolios" });
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
    expect(listAllocateRecords()).toEqual([]);
  });

  it("lets the 7th portfolio through", async () => {
    const existing = Array.from({ length: 6 }, (_, i) => `p_${i}`);
    stubRpc({ portfolios: [...existing, "pf-real"], balance: "1000000", existing });
    await expect(run()).resolves.toMatchObject({ portfolioId: "pf-real" });
  });

  it("an invalid composition is typed too, so the modal words it instead of a failed signature", async () => {
    stubRpc({ portfolios: ["pf-real"], balance: "1000000" });
    await expect(
      run({ changeset: { ...changeset, tokenAdditions: [{ tokenId: USDC, initialTargetPct: 99, initialTolerancePct: 5 }] } })
    ).rejects.toMatchObject({ name: "RealChangeSetInvalidError", reason: "targets-not-100" });
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  it("returns the on-chain portfolio id and the credited amount in human units", async () => {
    stubRpc({ portfolios: ["pf-real"], balance: "1000000" });
    const result = await run();
    expect(result.portfolioId).toBe("pf-real");
    expect(result.credited).toEqual([{ tokenId: USDC, qty: 1 }]);
    expect(result.txHash).toBe("Tx1");
  });

  it("reports each leg in order so the UI never shows one opaque spinner", async () => {
    stubRpc({ portfolios: ["pf-real"], balance: "1000000" });
    const stages: RealAllocateStage[] = [];
    await run({ onStage: (s) => stages.push(s) });
    expect(stages).toEqual([
      "preparing",
      "signing",
      "submitting",
      "awaiting-credit",
      "credited",
    ]);
  });

  it("converts human qty to base units without floating-point drift", async () => {
    stubRpc({ portfolios: ["pf-real"], balance: "1100000" });
    await run({
      changeset: { ...changeset, allocations: [{ tokenId: USDC, qty: 1.1 }] },
    });
    const [record] = listAllocateRecords();
    // Net of the Storage Cost; with it, exactly what was typed (not 1100000.0000000002).
    expect(BigInt(record.legs[0].amount) + STORAGE_AMOUNT).toBe(BigInt(1_100_000));
  });

  it("surfaces an uncredited allocate as UNCONFIRMED, not as a failure", async () => {
    // The portfolio exists but never shows the balance → the poll times out. The funds
    // may be held pending, so this must NOT be reported as a plain failure.
    stubRpc({ portfolios: ["pf-real"], balance: null });
    const stages: RealAllocateStage[] = [];

    const error = await run({
      onStage: (s) => stages.push(s),
      poll: { timeoutMs: 0, sleep: () => Promise.resolve() },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RealAllocateUnconfirmedError);
    // The credit may still land by itself: not the vault refusing it.
    expect((error as RealAllocateUnconfirmedError).reason).toBe("unconfirmed");
    expect(stages).toEqual([
      "preparing",
      "signing",
      "submitting",
      "awaiting-credit",
      "pending-unconfirmed",
    ]);

    // The rescue record survives and is NOT resolved — this is what recovers the funds.
    const [record] = listAllocateRecords();
    expect(record.status).not.toBe("credited");
    expect(record.msg).toBeTruthy();
    expect((error as RealAllocateUnconfirmedError).recordId).toBe(record.id);
  });

  // D-311: a submit that threw without proof that nothing was sent is judged by the credit
  // poll, like any other submit — never handed to the modal as an error it would offer to retry.
  it("polls after an AMBIGUOUS submit, and a credit is a success", async () => {
    stubRpc({ portfolios: ["pf-real"], balance: "1000000" });
    const result = await run({ submit: vi.fn().mockRejectedValue(new Error("relay 504")) });

    expect(result.portfolioId).toBe("pf-real");
    expect(listAllocateRecords()[0].status).not.toBe("failed");
  });

  it("reports an ambiguous submit that never credits as UNCONFIRMED, not as an error", async () => {
    stubRpc({ portfolios: ["pf-real"], balance: null });
    const stages: RealAllocateStage[] = [];
    const error = await run({
      submit: vi.fn().mockRejectedValue(new Error("relay 504")),
      onStage: (s) => stages.push(s),
      poll: { timeoutMs: 0, sleep: () => Promise.resolve() },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RealAllocateUnconfirmedError);
    expect((error as RealAllocateUnconfirmedError).reason).toBe("unconfirmed");
    expect(stages.at(-2)).toBe("awaiting-credit");
    expect(listAllocateRecords()[0].status).toBe("suspected_orphan");
  });

  // FE #5 (`922` §8 #15): the Transfer settled, `on_auth` failed. There is no credit to wait
  // for, so the 120s poll is skipped, and the verdict travels through the SAME error as an
  // unconfirmed settlement — never as a failure, never as a cancel.
  it("reports a failed on_auth receipt as UNCONFIRMED at once, without polling", async () => {
    stubRpc({ portfolios: ["pf-real"], balance: "1000000" }); // a credit the poll would even see
    const stages: RealAllocateStage[] = [];
    const orphaned: NearSigner = {
      ...signer,
      signAndSendTransaction: vi.fn().mockResolvedValue({
        transaction_outcome: { id: "Tx1" },
        status: { SuccessValue: "" },
        receipts_outcome: [
          {
            outcome: {
              executor_id: "intentfolio-staging.near",
              status: {
                Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "trap" } } } },
              },
            },
          },
        ],
      }),
    };

    const error = await run({
      signer: nep413VaultSigner(orphaned, "alice.near"),
      nearWallet: orphaned,
      submit: walletSubmitter(orphaned),
      onStage: (s) => stages.push(s),
      poll: { timeoutMs: 120_000, sleep: () => Promise.resolve() },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RealAllocateUnconfirmedError);
    expect((error as Error).message).toMatch(/could not credit it \(trap\)/);
    expect((error as RealAllocateUnconfirmedError).reason).toBe("vault_failed");
    // "Without polling" = the balance is never asked for: the poll reads it before its first
    // sleep, so the RPC log, not the sleep, is what proves the poll never started.
    const viewsAsked = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).params.method_name);
    expect(viewsAsked).not.toContain("get_portfolio_balance");
    expect(stages).toEqual(["preparing", "signing", "submitting", "pending-unconfirmed"]);

    const [record] = listAllocateRecords();
    expect(record.status).toBe("suspected_orphan");
    expect(record.txHash).toBe("Tx1");
    expect((error as RealAllocateUnconfirmedError).recordId).toBe(record.id);
  });

  // D-176 / intents-token-id.ts. NEAR is the one asset whose registry id is not a Defuse
  // asset id, and everything the contract reads has to carry the Defuse one. Signing "near"
  // asks intents.near to move a token the account holds zero of: the Transfer fails AFTER
  // the signature, and it reads to the user as a wallet problem.
  describe("NEAR — the id the contract actually reads", () => {
    const NEAR_CHANGESET: PortfolioChangeSet = {
      tokenAdditions: [{ tokenId: "near", initialTargetPct: 100, initialTolerancePct: 5 }],
      allocations: [{ tokenId: "near", qty: 2 }],
    };

    function stubNearRpc() {
      let listCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
          const method = JSON.parse(init.body as string).params.method_name;
          if (method === "get_config") return viewResponse(CONFIG);
          if (method === "current_salt") return viewResponse("252812b3");
          if (method === "mt_batch_balance_of") return heldResponse(init);
          if (method === "list_portfolios_for") {
            listCalls += 1;
            return viewResponse(listCalls === 1 ? [] : ["pf-near"]);
          }
          if (method === "get_portfolio_balance") {
            // The vault answers in ITS space, as the real one does.
            return viewResponse([["nep141:wrap.near", "2000000000000000000000000"]]);
          }
          throw new Error(`unexpected view ${method}`);
        })
      );
    }

    it("signs nep141:wrap.near for both the Transfer and the composition", async () => {
      stubNearRpc();
      await run({ changeset: NEAR_CHANGESET });

      const inner = JSON.parse(
        vi.mocked(signer.signNEP413Message).mock.calls[0][0].message
      );
      const transfer = inner.intents.find(
        (i: { intent: string }) => i.intent === "transfer"
      );
      expect(Object.keys(transfer.tokens)).toEqual(["nep141:wrap.near"]);

      const authCall = inner.intents.find(
        (i: { intent: string }) => i.intent === "auth_call"
      );
      const setup = JSON.parse(authCall.msg).op.setup;
      expect(setup.composition.map((c: { token_id: string }) => c.token_id)).toEqual([
        "nep141:wrap.near",
      ]);
      const net = (BigInt("2000000000000000000000000") - STORAGE_AMOUNT).toString();
      expect(setup.allocations).toEqual([["nep141:wrap.near", net]]);
      // The Storage Cost is a third intent in the same token: together, the 2 NEAR typed.
      expect(inner.intents[2]).toMatchObject({ receiver_id: "intentfolio-budget.near", tokens: { "nep141:wrap.near": "10000" } });
    });

    it("reports the credit back in OUR id, so the dashboard can resolve it", async () => {
      stubNearRpc();
      const result = await run({ changeset: NEAR_CHANGESET });
      expect(result.credited).toEqual([{ tokenId: "near", qty: 2 }]);
    });
  });

  it("rejects the SAME token listed twice rather than silently keeping one", async () => {
    stubRpc({ portfolios: [], balance: null });
    await expect(
      run({
        changeset: {
          ...changeset,
          allocations: [
            { tokenId: USDC, qty: 1 },
            { tokenId: USDC, qty: 2 },
          ],
        },
      })
    ).rejects.toThrow(/Duplicate token/);
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  it("refuses an allocate with no allocations at all", async () => {
    stubRpc({ portfolios: [], balance: null });
    await expect(run({ changeset: { ...changeset, allocations: [] } })).rejects.toThrow(
      /at least one allocation/
    );
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  it("refuses an amount that rounds down to zero base units", async () => {
    stubRpc({ portfolios: [], balance: null });
    await expect(
      run({ changeset: { ...changeset, allocations: [{ tokenId: USDC, qty: 0.0000001 }] } })
    ).rejects.toThrow(/rounds to zero/);
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  describe("multi-token funding (008.plan Phase 2)", () => {
    // The real seed left over from the Phase 0 wet test: 3.50 USDT(ARB) + 0.00013 ETH(ARB)
    // sitting unallocated in the General Balance. Different decimals (6 vs 18) on purpose.
    const USDT_ARB = "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near";
    const ETH_ARB = "nep141:arb.omft.near";

    function stubTwoTokenRpc(balances: Array<[string, string]>) {
      let listCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
          const method = JSON.parse(init.body as string).params.method_name;
          if (method === "get_config") return viewResponse(CONFIG);
          if (method === "current_salt") return viewResponse("252812b3");
          if (method === "mt_batch_balance_of") return heldResponse(init);
          if (method === "list_portfolios_for") {
            listCalls += 1;
            return viewResponse(listCalls === 1 ? [] : ["pf-real"]);
          }
          if (method === "get_portfolio_balance") return viewResponse(balances);
          throw new Error(`unexpected view ${method}`);
        })
      );
    }

    const twoTokenChangeset: PortfolioChangeSet = {
      tokenAdditions: [
        { tokenId: USDT_ARB, initialTargetPct: 60, initialTolerancePct: 5 },
        { tokenId: ETH_ARB, initialTargetPct: 40, initialTolerancePct: 5 },
      ],
      allocations: [
        { tokenId: USDT_ARB, qty: 3.5 },
        { tokenId: ETH_ARB, qty: 0.00013 },
      ],
    };

    it("funds two tokens in one signature and reports both credits", async () => {
      stubTwoTokenRpc([
        [USDT_ARB, "3500000"],
        [ETH_ARB, "130000000000000"],
      ]);

      const result = await run({ changeset: twoTokenChangeset });

      expect(result.portfolioId).toBe("pf-real");
      expect(result.credited).toEqual([
        { tokenId: USDT_ARB, qty: 3.5 },
        { tokenId: ETH_ARB, qty: 0.00013 },
      ]);
      // One wallet prompt, not two — the whole point of the single Transfer.
      expect(signer.signNEP413Message).toHaveBeenCalledTimes(1);
    });

    it("does not report success until BOTH legs are credited", async () => {
      // Only USDT lands. The poll must time out rather than call it done.
      stubTwoTokenRpc([[USDT_ARB, "3500000"]]);

      const error = await run({
        changeset: twoTokenChangeset,
        poll: { timeoutMs: 0, sleep: () => Promise.resolve() },
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RealAllocateUnconfirmedError);
      expect(listAllocateRecords()[0].status).not.toBe("credited");
    });
  });

  describe("the orphan gate — a composition the vault would refuse", () => {
    // A Setup the vault rejects does NOT roll back the Transfer: the funds land on the
    // vault, on_auth panics, and they are credited to nobody. These must never be signed.
    it("refuses targets that sum to 100% in floats but not in basis points", async () => {
      // 33.333 + 33.333 + 33.334 = 100.0 exactly, so the editor's percent gate passes it.
      // In bps it is 3333 + 3333 + 3333 = 9999, and the vault demands exactly 10000.
      stubRpc({ portfolios: [], balance: null });
      await expect(
        run({
          changeset: {
            tokenAdditions: [
              { tokenId: USDC, initialTargetPct: 33.333, initialTolerancePct: 5 },
              { tokenId: "nep141:arb.omft.near", initialTargetPct: 33.333, initialTolerancePct: 5 },
              {
                tokenId: "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near",
                initialTargetPct: 33.334,
                initialTolerancePct: 5,
              },
            ],
            allocations: [{ tokenId: USDC, qty: 1 }],
          },
        })
      ).rejects.toThrow(/targets-not-100/);
      expect(signer.signNEP413Message).not.toHaveBeenCalled();
    });

    it("refuses a tolerance outside the hard band before asking for a signature", async () => {
      stubRpc({ portfolios: [], balance: null });
      await expect(
        run({
          changeset: {
            tokenAdditions: [{ tokenId: USDC, initialTargetPct: 100, initialTolerancePct: 50 }],
            allocations: [{ tokenId: USDC, qty: 1 }],
          },
        })
      ).rejects.toThrow(/tolerance-out-of-band/);
      expect(signer.signNEP413Message).not.toHaveBeenCalled();
    });
  });

  it("refuses an unknown token rather than guessing decimals", async () => {
    stubRpc({ portfolios: [], balance: null });
    await expect(
      run({
        changeset: {
          tokenAdditions: [{ tokenId: "nep141:nope", initialTargetPct: 100, initialTolerancePct: 5 }],
          allocations: [{ tokenId: "nep141:nope", qty: 1 }],
        },
      })
    ).rejects.toThrow(/Unknown token/);
  });
});

// D-303: every leg is capped against the General Balance read right before signing. The
// read shares the click with the portfolio snapshot, so it must add no round trip, and it
// is the gate — no balance, no signature.
describe("the amount is capped at the balance read before signing (D-303)", () => {
  // Answers per token and per account, as the Verifier does: a balance is only returned for
  // the id it is held under (`nep141:wrap.near`, never the registry's "near") and for the
  // signer. Anything else reads 0 — so asking with the wrong id or account fails loudly.
  function stubRpcWithHeld(held: string | Record<string, string> | Error) {
    const byToken: Record<string, string> =
      typeof held === "string" ? { "nep141:wrap.near": held } : held instanceof Error ? {} : held;
    let listCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const params = JSON.parse(init.body as string).params;
        const method = params.method_name;
        if (method === "get_config") return viewResponse(CONFIG);
        if (method === "current_salt") return viewResponse("252812b3");
        if (method === "mt_batch_balance_of") {
          if (held instanceof Error) throw held;
          const args = JSON.parse(atob(params.args_base64));
          const mine = params.account_id === "intents.near" && args.account_id === "alice.near";
          return viewResponse(
            args.token_ids.map((id: string) => (mine ? (byToken[id] ?? "0") : "0"))
          );
        }
        if (method === "list_portfolios_for") {
          listCalls += 1;
          return viewResponse(listCalls === 1 ? [] : ["pf-near"]);
        }
        if (method === "get_portfolio_balance") {
          return viewResponse(Object.entries(byToken));
        }
        throw new Error(`unexpected view ${method}`);
      })
    );
  }

  const nearMax = (qty: number): PortfolioChangeSet => ({
    tokenAdditions: [{ tokenId: "near", initialTargetPct: 100, initialTolerancePct: 5 }],
    allocations: [{ tokenId: "near", qty }],
  });

  /** What leaves the balance in `token`: the vault leg plus the Storage Cost charged in it (D-528). */
  function signedAmount(token = "nep141:wrap.near"): string {
    const inner = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    const transfers = inner.intents.filter((i: { intent: string }) => i.intent === "transfer");
    return transfers
      .reduce((sum: bigint, t: { tokens: Record<string, string> }) => sum + BigInt(t.tokens[token] ?? "0"), BigInt(0))
      .toString();
  }

  // Two legs with DIFFERENT balances, so a leg capped against the other leg's balance, or
  // read in the wrong order, cannot pass by coincidence.
  const twoLegs = (nearQty: number): PortfolioChangeSet => ({
    tokenAdditions: [
      { tokenId: USDC, initialTargetPct: 50, initialTolerancePct: 5 },
      { tokenId: "near", initialTargetPct: 50, initialTolerancePct: 5 },
    ],
    allocations: [
      { tokenId: USDC, qty: 5 },
      { tokenId: "near", qty: nearQty },
    ],
  });

  it("caps each leg against its own balance", async () => {
    const raw = "123456789012345678901234";
    stubRpcWithHeld({ [USDC]: "5000000", "nep141:wrap.near": raw });
    // A login wallet that is not the signing account (an EVM login signs as a derived id):
    // the balance that caps the Transfer is the SIGNER's, so reading this one would read 0.
    await run({
      changeset: twoLegs(Number(BigInt(raw)) / 1e24),
      loginWalletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
    });
    expect(signedAmount(USDC)).toBe("5000000");
    expect(signedAmount()).toBe(raw);
  });

  it("refuses when the SECOND leg is really above its balance", async () => {
    stubRpcWithHeld({ [USDC]: "5000000", "nep141:wrap.near": "100000000000000000000000" });
    await expect(run({ changeset: twoLegs(0.3) })).rejects.toThrow(AmountExceedsBalanceError);
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  it("signs the typed 0.3 NEAR as exactly 3 × 10^23 yocto", async () => {
    stubRpcWithHeld("300000000000000000000000");
    await run({ changeset: nearMax(0.3) });
    expect(signedAmount()).toBe("300000000000000000000000");
  });

  it("Max on a float balance signs the exact balance — never a yocto more", async () => {
    // The create flow's default: the whole balance, held as `Number(raw) / 1e24`. Its
    // shortest spelling is 1098766 yocto above the real figure.
    const raw = "123456789012345678901234";
    stubRpcWithHeld(raw);
    await run({ changeset: nearMax(Number(BigInt(raw)) / 1e24) });
    expect(signedAmount()).toBe(raw);
    expect(BigInt(listAllocateRecords()[0].legs[0].amount) + STORAGE_AMOUNT).toBe(BigInt(raw));
  });

  it("signs nothing and records nothing when the balance cannot be read", async () => {
    stubRpcWithHeld(new Error("RPC HTTP 401"));
    await expect(run({ changeset: nearMax(0.3) })).rejects.toThrow(/401/);
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
    expect(listAllocateRecords()).toEqual([]);
  });

  it("signs nothing when the amount is really above the balance", async () => {
    stubRpcWithHeld("100000000000000000000000");
    await expect(run({ changeset: nearMax(0.3) })).rejects.toThrow(AmountExceedsBalanceError);
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
    expect(listAllocateRecords()).toEqual([]);
  });

  it("reads the balance alongside the portfolio snapshot — neither waits on the other", async () => {
    // Each answer is held back until the OTHER read has been issued. In parallel both are
    // issued at once; in sequence, whichever goes first waits on one that never starts, and
    // gives up instead, failing the run. Both orders are covered.
    let listCalls = 0;
    let balanceAsked: () => void = () => {};
    const balanceIssued = new Promise<void>((resolve) => (balanceAsked = resolve));
    let snapshotAsked: () => void = () => {};
    const snapshotIssued = new Promise<void>((resolve) => (snapshotAsked = resolve));
    const orGiveUp = (issued: Promise<void>) =>
      Promise.race([
        issued,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("a read waited on a sequential one")), 200)
        ),
      ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const method = JSON.parse(init.body as string).params.method_name;
        if (method === "get_config") return viewResponse(CONFIG);
        if (method === "current_salt") return viewResponse("252812b3");
        if (method === "mt_batch_balance_of") {
          balanceAsked();
          await orGiveUp(snapshotIssued);
          return heldResponse(init, "300000000000000000000000");
        }
        if (method === "list_portfolios_for") {
          listCalls += 1;
          if (listCalls === 1) {
            snapshotAsked();
            await orGiveUp(balanceIssued);
            return viewResponse([]);
          }
          return viewResponse(["pf-near"]);
        }
        if (method === "get_portfolio_balance") {
          return viewResponse([["nep141:wrap.near", "300000000000000000000000"]]);
        }
        throw new Error(`unexpected view ${method}`);
      })
    );
    await expect(run({ changeset: nearMax(0.3) })).resolves.toMatchObject({
      portfolioId: "pf-near",
    });
  });
});

describe("RealAllocateUnconfirmedError", () => {
  it("carries the rescue record id so the operator can recover the funds", () => {
    const e = new RealAllocateUnconfirmedError("timed out", "rec-1", "unconfirmed");
    expect(e.recordId).toBe("rec-1");
    expect(e.reason).toBe("unconfirmed");
    expect(e.name).toBe("RealAllocateUnconfirmedError");
  });
});

// D-528: the Storage Cost is deducted here and only here, from the GROSS leg after the cap, and
// the vault leg, the rescue record and the credit poll all carry the same net figure.
describe("the Storage Cost (D-528)", () => {
  const gross = (qty: number): PortfolioChangeSet => ({ ...changeset, allocations: [{ tokenId: USDC, qty }] });
  const signedIntents = () =>
    JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message).intents as Array<{
      intent: string;
      receiver_id?: string;
      tokens?: Record<string, string>;
      memo?: string;
    }>;

  it("signs net to the vault and the cost to the ops account, and records the net", async () => {
    stubRpc({ portfolios: ["pf-real"], balance: "990000" });
    await run({ changeset: gross(1) });
    const [vault, , storage] = signedIntents();
    expect(vault.tokens).toEqual({ [USDC]: "990000" });
    expect(storage).toEqual({
      intent: "transfer",
      receiver_id: "intentfolio-budget.near",
      tokens: { [USDC]: "10000" },
      memo: "storage",
    });
    expect(listAllocateRecords()[0].legs).toEqual([{ tokenId: USDC, amount: "990000" }]);
  });

  it("waits for the NET credit, not the gross one", async () => {
    // A vault that credited the net amount is a success; one that credited less is not.
    stubRpc({ portfolios: ["pf-real"], balance: "989999" });
    const error = await run({ changeset: gross(1), poll: { timeoutMs: 0, sleep: () => Promise.resolve() } }).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(RealAllocateUnconfirmedError);
  });

  it("Max: net plus cost is exactly the balance, never a unit more", async () => {
    stubRpc({ portfolios: ["pf-real"], balance: "4990000", held: "5000000" });
    await run({ changeset: gross(5.0000000001) }); // float noise above the balance
    const [vault, , storage] = signedIntents();
    expect(BigInt(vault.tokens![USDC]) + BigInt(storage.tokens![USDC])).toBe(BigInt(5_000_000));
  });

  it("refuses, before signing, when the balance does not cover the cost", async () => {
    stubRpc({ portfolios: [], balance: null, held: "10000" });
    await expect(run({ changeset: gross(0.01) })).rejects.toMatchObject({
      name: "RealChangeSetInvalidError",
      reason: "storage-exceeds-amount",
    });
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
    expect(listAllocateRecords()).toEqual([]);
  });

  it("refuses a cost priced for another Setup (bytes) or in a token the Setup does not fund", async () => {
    stubRpc({ portfolios: [], balance: null });
    const priced = storageFor(changeset);
    for (const storage of [
      { ...priced, bytes: priced.bytes - 1 },
      { ...priced, tokenId: "near" },
      { ...priced, amount: BigInt(0) },
    ]) {
      await expect(run({ storage })).rejects.toMatchObject({ reason: "storage-mismatch" });
    }
    // A name edited after pricing changes the bytes too.
    await expect(run({ portfolioName: "Wet Test 2" })).rejects.toMatchObject({ reason: "storage-mismatch" });
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });
});

describe("the app's 10-token cap on a Setup (D-528)", () => {
  it("refuses an 11-token composition before signing, with its own reason", async () => {
    stubRpc({ portfolios: [], balance: null });
    const { tokenRegistry } = await import("@/features/market/lib/token-registry");
    const ids = tokenRegistry.map((t) => t.id).filter((id) => id !== USDC).slice(0, 10);
    const cs: PortfolioChangeSet = {
      tokenAdditions: [USDC, ...ids].map((tokenId, i) => ({ tokenId, initialTargetPct: i === 0 ? 100 : 0, initialTolerancePct: 5 })),
      allocations: [{ tokenId: USDC, qty: 1 }],
    };
    await expect(run({ changeset: cs })).rejects.toMatchObject({ reason: "app-too-many-tokens" });
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });
});
