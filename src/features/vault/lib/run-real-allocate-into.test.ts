// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { runRealAllocateInto } from "./run-real-allocate-into";
import { RealAllocateUnconfirmedError, type RealAllocateStage } from "./run-real-allocate";
import { listAllocateRecords } from "./allocate-rescue-store";
import { AmountExceedsBalanceError } from "./base-units";
import { resetPreflightLimitsCache } from "./vault-limits";
import { RealChangeSetInvalidError } from "./vault-errors";
import type { NearSigner } from "./allocate-submit";
import type { SealRead } from "./allocate-seal";
import { nep413VaultSigner } from "./vault-signer";
import { walletSubmitter } from "./envelope-submitter";

// D-321 (013.plan B1). Wallet and RPC faked; the credit poll's seal read is injected, because
// the property under test is how the orchestrator treats each answer.
const USDC = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near"; // 6 decimals
const USDT = "nep141:usdt.tether-token.near";
const PID = "p_000000000017";

/** `get_config` as the vault answers it: the limits the pre-flight reads (vault-limits.ts). */
const CONFIG = {
  portfolio_counter: 24,
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

type ChainPortfolio = {
  owner: string;
  composition: Array<{ token_id: string; target_bps: number; tolerance_bps: number }>;
  held_tokens: string[];
  deleted?: boolean;
} | null;

const OWNED: NonNullable<ChainPortfolio> = {
  owner: "alice.near",
  composition: [{ token_id: USDC, target_bps: 10_000, tolerance_bps: 500 }],
  held_tokens: [USDC],
};

function stubRpc(opts: { portfolio?: ChainPortfolio; held?: string; seal?: "sealed" | "unsealed" } = {}) {
  const portfolio = opts.portfolio === undefined ? OWNED : opts.portfolio;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const params = JSON.parse(init.body as string).params;
      const method = params.method_name;
      // The seal (allocate-seal.ts), read by the submit before it declares an orphan (D-328).
      // Unset, it throws like any unexpected read: "unreadable".
      if (method === "get_allocate_seal" && opts.seal) {
        return viewResponse(opts.seal === "sealed" ? { msg_hash: "h", deadline: 1 } : null);
      }
      if (method === "get_config") return viewResponse(CONFIG);
      if (method === "current_salt") return viewResponse("252812b3");
      if (method === "mt_batch_balance_of") {
        const args = JSON.parse(atob(params.args_base64));
        return viewResponse(args.token_ids.map(() => opts.held ?? "1000000000000000000000000000"));
      }
      if (method === "get_portfolio") {
        return viewResponse(
          portfolio === null
            ? null
            : { name: "canary", created_at: 1, deleted: false, deleted_at: 0, ...portfolio }
        );
      }
      throw new Error(`unexpected view ${method}`);
    })
  );
}

const walletMock: NearSigner = {
  signNEP413Message: vi.fn().mockResolvedValue({
    accountId: "alice.near",
    publicKey: "ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN",
    signature: Buffer.from(new Uint8Array(64)).toString("base64"),
  }),
  signAndSendTransaction: vi.fn().mockResolvedValue({ transaction_outcome: { id: "Tx1" } }),
};

const sealed = (): Promise<SealRead> => Promise.resolve({ kind: "sealed", deadlineSecs: 1 });

function run(over: Partial<Parameters<typeof runRealAllocateInto>[0]> = {}) {
  return runRealAllocateInto({
    accountId: "alice.near",
    portfolioId: PID,
    portfolioName: "canary",
    allocations: [{ tokenId: USDC, qty: 1 }],
    signer: nep413VaultSigner(walletMock, "alice.near"),
    loginChain: "near",
    nearWallet: walletMock,
    submit: walletSubmitter(walletMock),
    poll: { readSeal: sealed, sleep: () => Promise.resolve() },
    ...over,
  });
}

/** The AuthCallMsg as it was signed, from the one NEP-413 message the wallet saw. */
function signedMsg(): { op: { allocate_into: Record<string, unknown> } } {
  const inner = JSON.parse(vi.mocked(walletMock.signNEP413Message).mock.calls[0][0].message);
  return JSON.parse(inner.intents[1].msg);
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

describe("runRealAllocateInto", () => {
  it("signs an allocate_into for the portfolio and reports the credit once the seal is seen", async () => {
    stubRpc();
    const stages: RealAllocateStage[] = [];
    const result = await run({ onStage: (s) => stages.push(s) });

    expect(result.credited).toEqual([{ tokenId: USDC, qty: 1 }]);
    expect(result.txHash).toBe("Tx1");
    expect(stages).toEqual(["preparing", "signing", "submitting", "awaiting-credit", "credited"]);

    const msg = signedMsg();
    expect(msg.op.allocate_into).toEqual({
      portfolio_id: PID,
      target_changes: [],
      token_additions: [],
      token_removals: [],
      allocations: [[USDC, "1000000"]],
    });
    // No `login_wallet`: the vault checks the owner against the Verifier-authenticated signer.
    expect(JSON.stringify(msg)).not.toContain("login_wallet");

    const [record] = listAllocateRecords();
    expect(record.status).toBe("credited");
    expect(record.portfolioName).toBe("canary");
  });

  it("puts the funds in the Transfer to the vault that the AuthCall names", async () => {
    stubRpc();
    await run();
    const inner = JSON.parse(vi.mocked(walletMock.signNEP413Message).mock.calls[0][0].message);
    expect(inner.intents[0].tokens).toEqual({ [USDC]: "1000000" });
    expect(signedMsg().op.allocate_into.allocations).toEqual([[USDC, "1000000"]]);
  });

  describe("composition additions", () => {
    it("adds a token the chain composition lacks, at 0%, in the same signature", async () => {
      stubRpc();
      await run({
        allocations: [{ tokenId: USDT, qty: 2 }],
        tokenAdditions: [{ tokenId: USDT, tolerancePct: 10 }],
      });
      expect(signedMsg().op.allocate_into.token_additions).toEqual([[USDT, 0, 1000]]);
    });

    it("drops an addition the chain composition already has, instead of orphaning the Transfer", async () => {
      // The editor believed USDC was new; the chain says otherwise. Sent as an addition, the
      // fold fails inside `on_auth` — after the funds moved.
      stubRpc();
      await run({ tokenAdditions: [{ tokenId: USDC, tolerancePct: 10 }] });
      expect(signedMsg().op.allocate_into.token_additions).toEqual([]);
    });

    it("refuses an addition the vault would reject, before signing", async () => {
      stubRpc();
      const error = await run({
        allocations: [{ tokenId: USDT, qty: 2 }],
        tokenAdditions: [{ tokenId: USDT, tolerancePct: 50 }], // outside [2%, 30%]
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RealChangeSetInvalidError);
      expect((error as RealChangeSetInvalidError).reason).toBe("tolerance-out-of-band");
      expect(walletMock.signNEP413Message).not.toHaveBeenCalled();
      expect(listAllocateRecords()).toHaveLength(0);
    });
  });

  describe("the orphan gate: what on_auth would refuse after the Transfer settled", () => {
    async function expectNothingSigned(promise: Promise<unknown>) {
      await expect(promise).rejects.toThrow();
      expect(walletMock.signNEP413Message).not.toHaveBeenCalled();
      expect(listAllocateRecords()).toHaveLength(0);
    }

    it("a portfolio the vault does not know", async () => {
      stubRpc({ portfolio: null });
      await expectNothingSigned(run());
    });

    it("a deleted portfolio", async () => {
      stubRpc({ portfolio: { ...OWNED, deleted: true } });
      await expectNothingSigned(run());
    });

    it("a portfolio someone else owns", async () => {
      stubRpc({ portfolio: { ...OWNED, owner: "mallory.near" } });
      await expectNothingSigned(run());
    });

    it("a first credit of a token when held_tokens is already full", async () => {
      const full = Array.from({ length: 32 }, (_, i) => `nep141:t${i}.near`);
      stubRpc({ portfolio: { ...OWNED, held_tokens: full } });
      const error = await run({ allocations: [{ tokenId: USDT, qty: 2 }] }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RealChangeSetInvalidError);
      expect((error as RealChangeSetInvalidError).reason).toBe("too-many-tokens");
      expect(walletMock.signNEP413Message).not.toHaveBeenCalled();
    });

    it("but a full held_tokens still takes more of a token it already holds", async () => {
      const full = [USDC, ...Array.from({ length: 31 }, (_, i) => `nep141:t${i}.near`)];
      stubRpc({ portfolio: { ...OWNED, held_tokens: full } });
      await expect(run()).resolves.toBeDefined();
    });
  });

  describe("the amount is capped at the General Balance read before signing (D-303)", () => {
    it("more than the balance, beyond float noise, throws before signing", async () => {
      stubRpc({ held: "999999" }); // 1 USDC asked for, the chain holds 0.999999
      await expect(run()).rejects.toThrow(AmountExceedsBalanceError);
      expect(walletMock.signNEP413Message).not.toHaveBeenCalled();
    });

    it("a 24-decimal Max a hair below the balance signs the balance, not the float", async () => {
      // D-315's case: the field holds the shortest float that round-trips, which sits a few
      // parts in 10^16 away from the exact yocto figure.
      stubRpc({ held: "666273744117494233559424" });
      await run({ allocations: [{ tokenId: "nep141:meta-pool.near", qty: 0.6662737441174941 }] });
      expect(signedMsg().op.allocate_into.allocations).toEqual([
        ["nep141:meta-pool.near", "666273744117494233559424"],
      ]);
    });
  });

  describe("confirmation by seal", () => {
    it("keeps polling through unsealed reads and succeeds on the seal", async () => {
      stubRpc();
      const answers: SealRead[] = [
        { kind: "unsealed" },
        { kind: "unreadable", reason: "rpc 502" },
        { kind: "sealed", deadlineSecs: 1 },
      ];
      const readSeal = vi.fn(() => Promise.resolve(answers.shift()!));
      await run({ poll: { readSeal, sleep: () => Promise.resolve() } });
      expect(readSeal).toHaveBeenCalledTimes(3);
      expect(listAllocateRecords()[0].status).toBe("credited");
    });

    it("reads the seal for the exact msg that was signed", async () => {
      stubRpc();
      const readSeal = vi.fn(sealed);
      await run({ poll: { readSeal } });
      const [record] = listAllocateRecords();
      expect(readSeal).toHaveBeenCalledWith("alice.near", record.msg);
    });

    it("an unreadable seal is never taken for a credit: it ends UNCONFIRMED", async () => {
      stubRpc();
      let t = 0;
      const error = await run({
        poll: {
          readSeal: () => Promise.resolve({ kind: "unreadable", reason: "rpc 502" }),
          sleep: () => Promise.resolve(),
          now: () => (t += 60_000),
        },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RealAllocateUnconfirmedError);
      expect((error as RealAllocateUnconfirmedError).reason).toBe("unconfirmed");
      expect(listAllocateRecords()[0].status).toBe("suspected_orphan");
    });

    it("a timeout is UNCONFIRMED and hands the record to the solver", async () => {
      stubRpc();
      const stages: RealAllocateStage[] = [];
      const error = await run({
        onStage: (s) => stages.push(s),
        poll: {
          readSeal: () => Promise.resolve({ kind: "unsealed" }),
          timeoutMs: 0,
          sleep: () => Promise.resolve(),
        },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RealAllocateUnconfirmedError);
      expect(stages.at(-1)).toBe("pending-unconfirmed");
      const [record] = listAllocateRecords();
      expect(record.status).toBe("suspected_orphan");
      expect((error as RealAllocateUnconfirmedError).recordId).toBe(record.id);
    });

    it("a failed on_auth receipt is UNCONFIRMED at once, without reading the seal", async () => {
      stubRpc();
      const orphaned: NearSigner = {
        ...walletMock,
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
      const readSeal = vi.fn(sealed);
      const error = await run({
        signer: nep413VaultSigner(orphaned, "alice.near"),
        nearWallet: orphaned,
        submit: walletSubmitter(orphaned),
        poll: { readSeal },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RealAllocateUnconfirmedError);
      expect((error as RealAllocateUnconfirmedError).reason).toBe("vault_failed");
      expect(readSeal).not.toHaveBeenCalled();
      expect(listAllocateRecords()[0].status).toBe("suspected_orphan");
    });

    // D-328 end to end: a failed receipt that is not the vault's, under a settled Transfer,
    // with the vault's seal on this msg — the credit happened. It must reach the credit poll,
    // not the "we couldn't finish" copy.
    it("a foreign failed receipt with the msg SEALED is a credit, not vault_failed", async () => {
      stubRpc({ seal: "sealed" });
      const foreign: NearSigner = {
        ...walletMock,
        signAndSendTransaction: vi.fn().mockResolvedValue({
          transaction_outcome: { id: "Tx1" },
          status: { SuccessValue: "" },
          receipts_outcome: [
            { outcome: { executor_id: "intentfolio-staging.near", status: { SuccessValue: "" } } },
            {
              outcome: {
                executor_id: "some-refund.near",
                status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "refund failed" } } } } },
              },
            },
          ],
        }),
      };
      const result = await run({
        signer: nep413VaultSigner(foreign, "alice.near"),
        nearWallet: foreign,
        submit: walletSubmitter(foreign),
      });
      expect(result.txHash).toBe("Tx1");
      expect(listAllocateRecords()[0].status).not.toBe("suspected_orphan");
      const methods = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).params.method_name);
      expect(methods).toContain("get_allocate_seal");
    });

    // D-302 h1: the portfolio was deleted between the read and the credit. That msg never
    // applies (ADR-0023), so the UI must not promise to complete it.
    it("E_PORTFOLIO_NOT_FOUND from on_auth is its own reason: the portfolio is gone", async () => {
      stubRpc();
      const gone: NearSigner = {
        ...walletMock,
        signAndSendTransaction: vi.fn().mockResolvedValue({
          transaction_outcome: { id: "Tx1" },
          status: { SuccessValue: "" },
          receipts_outcome: [
            {
              outcome: {
                executor_id: "intentfolio-staging.near",
                status: {
                  Failure: {
                    ActionError: {
                      kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: E_PORTFOLIO_NOT_FOUND" } },
                    },
                  },
                },
              },
            },
          ],
        }),
      };
      const error = await run({
        signer: nep413VaultSigner(gone, "alice.near"),
        nearWallet: gone,
        submit: walletSubmitter(gone),
      }).catch((e: unknown) => e);
      expect((error as RealAllocateUnconfirmedError).reason).toBe("portfolio_gone");
      expect(listAllocateRecords()[0].status).toBe("suspected_orphan"); // still on the worklist: ops returns it
    });
  });

  it("refuses an empty, duplicated or zero allocation before any read", async () => {
    stubRpc();
    await expect(run({ allocations: [] })).rejects.toThrow(/at least one/);
    await expect(
      run({ allocations: [{ tokenId: USDC, qty: 1 }, { tokenId: USDC, qty: 2 }] })
    ).rejects.toThrow(/Duplicate/);
    await expect(run({ allocations: [{ tokenId: USDC, qty: 0.0000001 }] })).rejects.toThrow(/zero/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── D-321 cross-review (B5): several legs, the signer's account, and the id spaces ──
// The stub answers balances per INTENTS id; any other id reads "0", exactly as intents.near
// answers for the registry id "near". That is what makes a registry-space leak visible.

const META = "nep141:meta-pool.near"; // 24 decimals
const WNEAR = "nep141:wrap.near";

function stubChain(balances: Record<string, string>) {
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const params = JSON.parse(init.body as string).params;
    const method = params.method_name;
    if (method === "get_config") return viewResponse(CONFIG);
    if (method === "current_salt") return viewResponse("252812b3");
    if (method === "mt_batch_balance_of") {
      const args = JSON.parse(atob(params.args_base64));
      return viewResponse(args.token_ids.map((id: string) => balances[id] ?? "0"));
    }
    if (method === "get_portfolio") {
      return viewResponse({ name: "canary", created_at: 1, deleted: false, deleted_at: 0, ...OWNED });
    }
    throw new Error(`unexpected view ${method}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function balanceReads(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .map(([, init]) => JSON.parse((init as RequestInit).body as string).params)
    .filter((p) => p.method_name === "mt_batch_balance_of")
    .map((p) => JSON.parse(atob(p.args_base64)));
}

function signedInner() {
  return JSON.parse(vi.mocked(walletMock.signNEP413Message).mock.calls[0][0].message);
}

describe("runRealAllocateInto — legs, accounts and id spaces", () => {
  it("caps EACH leg against its own balance, read for the signer (multi-leg Max)", async () => {
    const fetchMock = stubChain({ [USDC]: "5000000", [META]: "666273744117494233559424" });
    await run({
      allocations: [
        { tokenId: USDC, qty: 1 },
        { tokenId: META, qty: 0.6662737441174941 },
      ],
    });
    expect(balanceReads(fetchMock)).toEqual([{ account_id: "alice.near", token_ids: [USDC, META] }]);
    expect(signedMsg().op.allocate_into.allocations).toEqual([
      [USDC, "1000000"],
      [META, "666273744117494233559424"],
    ]);
    // The envelope and the rescue record name the signer, never the portfolio.
    expect(signedInner().signer_id).toBe("alice.near");
    expect(listAllocateRecords()[0].signerId).toBe("alice.near");
  });

  it("NEAR crosses the wire as wNEAR everywhere", async () => {
    const fetchMock = stubChain({ [WNEAR]: "5000000000000000000000000" });
    await run({
      allocations: [{ tokenId: "near", qty: 1 }],
      tokenAdditions: [{ tokenId: "near", tolerancePct: 10 }],
    });
    expect(balanceReads(fetchMock)[0].token_ids).toEqual([WNEAR]);
    expect(signedInner().intents[0].tokens).toEqual({ [WNEAR]: "1000000000000000000000000" });
    expect(signedMsg().op.allocate_into.allocations).toEqual([[WNEAR, "1000000000000000000000000"]]);
    expect(signedMsg().op.allocate_into.token_additions).toEqual([[WNEAR, 0, 1000]]);
  });

  it("an addition named twice is sent once, not refused", async () => {
    stubChain({ [USDT]: "5000000" });
    await run({
      allocations: [{ tokenId: USDT, qty: 2 }],
      tokenAdditions: [
        { tokenId: USDT, tolerancePct: 10 },
        { tokenId: USDT, tolerancePct: 10 },
      ],
    });
    expect(signedMsg().op.allocate_into.token_additions).toEqual([[USDT, 0, 1000]]);
    expect(listAllocateRecords()).toHaveLength(1);
  });
});
