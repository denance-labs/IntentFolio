// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// D-280 B4 — the only BEHAVIOURAL test of a money door, and it exists because cross-review
// showed the structural guard was not enough. Three mutations of the door passed the entire
// suite green: dropping the `await`, expressing the gate as the local `isRealWithdrawal`
// wrapper, and moving the guard to after the funds were spent. Each one type-checks, lints,
// and leaves the `ensureCanOperate(` text exactly where a grep expects it.
//
// So this asks the question grep cannot: with the gate closed, does the door REFUSE — and
// does it refuse in the right direction?
//
// 🔴 The second assertion is the one that matters and is easy to forget. "It did not reach
// the vault" is only half an answer: falling through to `mockContract` instead is the
// failure mode this whole block was warned about, because it reports success on screen for
// something that never happened on chain. A blocked door must reach NEITHER.
//
// `createPortfolioWithChangeSet` is the door under test because it is the one a new tester
// reaches FIRST — a NEAR account that cannot operate breaks here, long before any withdrawal
// exists. The other three share the same guard and the same primitive.

// 🔴 Before any import, because `vault-flag.ts` reads this at module-evaluation time and
// Next.js inlines it at build time. Without it the round-trip flag is off under vitest, the
// live branch is never taken, and all five cases below fall through to `mockContract` — which
// is CORRECT production behaviour (the mock moves no real funds, so it needs no gate) and
// would have made this file assert nothing at all. Found by running it: the first version
// failed with "Composition must sum to 100%", the mock's error, not the gate's.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VAULT_ROUNDTRIP = "true";
});

const loginWallet = vi.hoisted(() => ({
  value: null as unknown,
}));
const vaultRuns = vi.hoisted(() => ({
  allocate: vi.fn(),
  allocateInto: vi.fn(),
  unallocate: vi.fn(),
}));
// The vault read-model. Empty unless a test needs a real portfolio to act on (D-321).
const realReads = vi.hoisted(() => ({ value: [] as unknown[] | undefined, error: null as Error | null }));

vi.mock("@/features/login-wallet", async (importOriginal) => ({
  // 🔴 `importOriginal`, so `ensureCanOperate` is the REAL gate. Mocking it here would make
  // this test assert that a stub was called, which is what the structural guard already does.
  ...(await importOriginal<typeof import("@/features/login-wallet")>()),
  useLoginWallet: () => loginWallet.value,
}));

vi.mock("@/features/vault/lib/run-real-allocate", async (importOriginal) => ({
  // The real module for its error class, which the refetch cases below throw.
  ...(await importOriginal<typeof import("@/features/vault/lib/run-real-allocate")>()),
  runRealAllocate: vaultRuns.allocate,
}));

vi.mock("@/features/vault/lib/run-real-allocate-into", () => ({
  runRealAllocateInto: vaultRuns.allocateInto,
}));

vi.mock("@/features/vault/lib/run-real-unallocate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/vault/lib/run-real-unallocate")>()),
  runRealUnallocate: vaultRuns.unallocate,
}));

// `off` simulates a session with no live signer (017-9c: a real portfolio must then refuse,
// never fall through to the mock).
const liveSigner = vi.hoisted(() => ({ off: false }));
vi.mock("@/features/vault/hooks/use-live-signer", () => ({
  useLiveSigner: () =>
    liveSigner.off
      ? null
      : {
          signer: { signEnvelope: vi.fn() },
          chain: "near" as const,
          address: ACCOUNT,
        },
}));

const metaRuns = vi.hoisted(() => ({ rename: vi.fn(), delete: vi.fn() }));
vi.mock("@/features/vault/lib/run-real-portfolio-meta", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/vault/lib/run-real-portfolio-meta")>()),
  runRealRenamePortfolio: metaRuns.rename,
  runRealDeletePortfolio: metaRuns.delete,
}));

// 028-7 (d): what each operation tells the history. The asks themselves are tested where they live.
const announce = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/features/vault/hooks/use-real-portfolio-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/vault/hooks/use-real-portfolio-history")>()),
  announceOperation: announce,
}));

vi.mock("@/features/vault/context/real-allocate-context", () => ({
  useRealAllocateSigner: () => ({ signMessage: vi.fn() }),
  RealAllocateProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/features/vault/hooks/use-real-portfolios", () => ({
  realPortfoliosQueryKey: (id: string) => ["real-portfolios", id],
  useRealPortfolios: () => ({
    data: realReads.value,
    isLoading: false,
    error: realReads.error,
    refetch: vi.fn(),
  }),
}));

import { PortfolioProvider, usePortfolio } from "./portfolio-context";
import { LanguageProvider } from "./language-context";
import { mockContract } from "@/features/intents-account/mock-contract";
import { NearKeyJustVerifiedError, NearKeyNotVerifiedError } from "@/features/login-wallet";
import type { NearKeyVerification } from "@/features/login-wallet";
import type { PortfolioChangeSet } from "@/features/intents-account/mock-contract/types";
import type { SetupStorageCost } from "@/features/vault/lib/storage-cost";
import { RealAllocateUnconfirmedError } from "@/features/vault/lib/run-real-allocate";
import { RealPortfolioMetaUnconfirmedError } from "@/features/vault/lib/run-real-portfolio-meta";
import { AmountExceedsBalanceError } from "@/features/vault/lib/base-units";
import { RealChangeSetInvalidError } from "@/features/vault/lib/vault-errors";
import { appPortfolioCap } from "@/features/vault/lib/change-set-preflight";
import { WalletAccountMismatchError } from "@/features/login-wallet/lib/identity";
import {
  RealUnallocateDeferredError,
  RealUnallocateTransferFailedError,
  VaultCommitRevertedError,
} from "@/features/vault/lib/vault-errors";

const ACCOUNT = "pablofork.near";
const SIGNING_KEY = "ed25519:2EVgyHyRbaLZjSDPzR8bnLTiPWtTYQ9GLNvtDoHZ4qGB";

const CHANGESET: PortfolioChangeSet = {
  targetChanges: [],
  tokenAdditions: [{ tokenId: "nep141:wrap.near", initialTargetPct: 0, initialTolerancePct: 5 }],
  tokenRemovals: [],
  allocations: [],
  unallocations: [],
};
/** What the gate is about happens before any of this is read (D-528). */
const STORAGE: SetupStorageCost = {
  ok: true,
  tokenId: "nep141:wrap.near",
  amount: BigInt(1),
  qty: 1e-24,
  bytes: 1,
  costYocto: BigInt(1),
};

function setLogin(keyVerification: NearKeyVerification, verifyKey = vi.fn()) {
  loginWallet.value = {
    intentsAccountId: ACCOUNT,
    signMessage: vi.fn(),
    family: "near" as const,
    connection: { chainKind: "near" as const, address: ACCOUNT },
    liveConnection: { chainKind: "near" as const, address: ACCOUNT },
    keyVerification,
    verifyKey,
  };
  return verifyKey;
}

/** Grabs the context value so the test can call the door directly. */
let door: ReturnType<typeof usePortfolio> | null = null;
function Probe() {
  door = usePortfolio();
  return null;
}

let client: QueryClient;
function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LanguageProvider>
        <PortfolioProvider>
          <Probe />
        </PortfolioProvider>
      </LanguageProvider>
    </QueryClientProvider>,
  );
}

describe("createPortfolioWithChangeSet — the gate, exercised through the real door", () => {
  let createSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    vaultRuns.allocate.mockReset().mockResolvedValue({ portfolioId: "p1" });
    createSpy = vi.spyOn(mockContract, "createPortfolio");
    door = null;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("refuses a NEAR account whose key is not registered, and signs NOTHING", async () => {
    setLogin({ kind: "not-registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();

    await act(async () => {
      await expect(
        door!.createPortfolioWithChangeSet("Mi cartera", CHANGESET, "sign this", STORAGE),
      ).rejects.toBeInstanceOf(NearKeyNotVerifiedError);
    });

    // Nothing was signed and nothing was sent to the vault.
    expect(vaultRuns.allocate).not.toHaveBeenCalled();
    // 🔴 And it did NOT quietly become a mock portfolio, which would show the tester a
    // portfolio that exists nowhere on chain.
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("lets a registered account through to the vault", async () => {
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();

    await act(async () => {
      await door!.createPortfolioWithChangeSet("Mi cartera", CHANGESET, "sign this", STORAGE);
    });

    // The other direction, and it is not a formality: a gate that blocked everybody would
    // pass the test above and ship a product nobody can use.
    expect(vaultRuns.allocate).toHaveBeenCalledTimes(1);
  });

  it("lets a non-NEAR family through — `not-required` is an answer, not a missing one", async () => {
    setLogin({ kind: "not-required" });
    mount();

    await act(async () => {
      await door!.createPortfolioWithChangeSet("Mi cartera", CHANGESET, "sign this", STORAGE);
    });

    expect(vaultRuns.allocate).toHaveBeenCalledTimes(1);
  });

  it("verifies inline from `unchecked`, then stops before Meteor's blocked second prompt", async () => {
    // The friction concession, through the real door: a reload leaves every session
    // `unchecked`, and verifying here is what keeps a tester who registered yesterday from
    // having to close the modal, find the banner, sign, and rebuild the whole portfolio.
    //
    // The first live Meteor run showed that Connect reopens but never delivers a chained
    // second request to the wallet, so the operation must wait for a fresh user gesture.
    const verify = setLogin(
      { kind: "unchecked" },
      vi.fn(async () => ({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY })),
    );
    mount();

    await act(async () => {
      await expect(
        door!.createPortfolioWithChangeSet("Mi cartera", CHANGESET, "sign this", STORAGE),
      ).rejects.toBeInstanceOf(NearKeyJustVerifiedError);
    });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(vaultRuns.allocate).not.toHaveBeenCalled();
    // The stop still must not fall through to a mock portfolio.
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("goes through on the retry with no further verification prompt", async () => {
    const verify = setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();

    await act(async () => {
      await door!.createPortfolioWithChangeSet("Mi cartera", CHANGESET, "sign this", STORAGE);
    });

    expect(verify).not.toHaveBeenCalled();
    expect(vaultRuns.allocate).toHaveBeenCalledTimes(1);
  });

  it("on the mock path, the portfolio cap is refused before the text signature", async () => {
    mockContract._reset();
    for (let i = 0; i < appPortfolioCap(); i++) mockContract.createEmptyPortfolio(ACCOUNT, `p${i}`);
    liveSigner.off = true;
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();

    try {
      await act(async () => {
        await expect(
          door!.createPortfolioWithChangeSet("Mi cartera", CHANGESET, "sign this", STORAGE),
        ).rejects.toMatchObject({ name: "RealChangeSetInvalidError", reason: "too-many-portfolios" });
      });
      const sign = (loginWallet.value as { signMessage: ReturnType<typeof vi.fn> }).signMessage;
      expect(sign).not.toHaveBeenCalled();
    } finally {
      liveSigner.off = false;
      mockContract._reset();
    }
  });

  it("refuses when the inline verification comes back unregistered", async () => {
    const verify = setLogin(
      { kind: "unchecked" },
      vi.fn(async () => ({ kind: "not-registered", accountId: ACCOUNT, publicKey: SIGNING_KEY })),
    );
    mount();

    await act(async () => {
      await expect(
        door!.createPortfolioWithChangeSet("Mi cartera", CHANGESET, "sign this", STORAGE),
      ).rejects.toBeInstanceOf(NearKeyNotVerifiedError);
    });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(vaultRuns.allocate).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// D-298 / D-304(b). A failed live Allocate must not leave the balance it was drawn from on
// screen: after an unconfirmed one the funds already left, and "Available to add" showing
// them invites a second signature over the same money. Every failure refetches — including
// one that is not an unconfirmed error, since a submit that threw may have landed too.
describe("createPortfolioWithChangeSet — a failed live Allocate refetches what it may have moved", () => {
  beforeEach(() => {
    localStorage.clear();
    vaultRuns.allocate.mockReset();
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    door = null;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    ["an unconfirmed Allocate", new RealAllocateUnconfirmedError("x", "rec-1", "vault_failed")],
    ["an amount above the balance", new AmountExceedsBalanceError(BigInt(2), BigInt(1))],
    ["a submit that threw", new Error("relay 502")],
  ])("invalidates the balances and the portfolios after %s, and re-throws it", async (_, error) => {
    vaultRuns.allocate.mockRejectedValue(error);
    mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(async () => {
      await expect(
        door!.createPortfolioWithChangeSet("Mi cartera", CHANGESET, "sign this", STORAGE),
      ).rejects.toBe(error);
    });

    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["intents-balances", ACCOUNT]);
    expect(keys).toContainEqual(["real-portfolios", ACCOUNT]);
    // D-293: My Account's in-transit notice is re-evaluated too — it is where the modal
    // sends the user.
    expect(keys).toContainEqual(["pending-allocates", ACCOUNT]);
  });

  it("re-evaluates the in-transit notice after a credited Allocate too", async () => {
    vaultRuns.allocate.mockResolvedValue({ portfolioId: "p1" });
    mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(async () => {
      await door!.createPortfolioWithChangeSet("Mi cartera", CHANGESET, "sign this", STORAGE);
    });

    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["pending-allocates", ACCOUNT]);
  });
});

// D-321 (013.plan B2). `allocateIntoPortfolio` is a money door like the create one: the same
// gate, the same refetch on failure, and no mock fallback at all.
const REAL_READ = {
  id: "p_000000000017",
  portfolio: {
    owner: ACCOUNT,
    name: "canary-931",
    composition: [{ token_id: "nep141:wrap.near", target_bps: 10_000, tolerance_bps: 500 }],
    held_tokens: ["nep141:wrap.near"],
    created_at: 1,
    deleted: false,
    deleted_at: 0,
  },
  balances: [["nep141:wrap.near", BigInt("1000000000000000000000000")]],
};
const FUNDING = {
  allocations: [{ tokenId: "near", qty: 1 }],
  tokenAdditions: [],
};

describe("allocateIntoPortfolio — the door for adding funds to a real portfolio", () => {
  beforeEach(() => {
    localStorage.clear();
    realReads.value = [REAL_READ];
    vaultRuns.allocateInto.mockReset().mockResolvedValue({ recordId: "r", txHash: "T", credited: [] });
    door = null;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    realReads.value = [];
  });

  it("refuses a NEAR account whose key is not registered, and signs NOTHING", async () => {
    setLogin({ kind: "not-registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();
    await act(async () => {
      await expect(door!.allocateIntoPortfolio(FUNDING)).rejects.toBeInstanceOf(NearKeyNotVerifiedError);
    });
    expect(vaultRuns.allocateInto).not.toHaveBeenCalled();
  });

  it("funds the ACTIVE real portfolio, by its on-chain id and current name", async () => {
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();
    await act(async () => {
      await door!.allocateIntoPortfolio({
        allocations: [{ tokenId: "near", qty: 1 }],
        tokenAdditions: [{ tokenId: "nep141:usdt.tether-token.near", tolerancePct: 5 }],
      });
    });
    expect(vaultRuns.allocateInto).toHaveBeenCalledTimes(1);
    expect(vaultRuns.allocateInto.mock.calls[0][0]).toMatchObject({
      accountId: ACCOUNT,
      portfolioId: "p_000000000017",
      portfolioName: "canary-931",
      allocations: [{ tokenId: "near", qty: 1 }],
      tokenAdditions: [{ tokenId: "nep141:usdt.tether-token.near", tolerancePct: 5 }],
    });
  });

  it("with no real portfolio active, throws and signs nothing — there is no mock fallback", async () => {
    realReads.value = [];
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();
    await act(async () => {
      await expect(door!.allocateIntoPortfolio(FUNDING)).rejects.toThrow(/live-vault portfolio/);
    });
    expect(vaultRuns.allocateInto).not.toHaveBeenCalled();
  });

  it.each([
    ["an unconfirmed Allocate", new RealAllocateUnconfirmedError("x", "rec-1", "unconfirmed")],
    ["an amount above the balance", new AmountExceedsBalanceError(BigInt(2), BigInt(1))],
    ["a submit that threw", new Error("relay 502")],
  ])("refetches what it may have moved after %s, and re-throws it", async (_, error) => {
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    vaultRuns.allocateInto.mockRejectedValue(error);
    mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await expect(door!.allocateIntoPortfolio(FUNDING)).rejects.toBe(error);
    });
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["intents-balances", ACCOUNT]);
    expect(keys).toContainEqual(["real-portfolios", ACCOUNT]);
    expect(keys).toContainEqual(["pending-allocates", ACCOUNT]);
  });

  // The backstop (013.plan P1): no contract op takes new funds and a withdrawal in one
  // signature, and the UI no longer puts funds in a real draft.
  it("commitChangeSet refuses funds in a real draft before signing", async () => {
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();
    const mockCommit = vi.spyOn(mockContract, "commitPortfolioChanges");
    await act(async () => {
      await expect(
        door!.commitChangeSet({ allocations: [{ tokenId: "near", qty: 1 }] }, "sign this"),
      ).rejects.toBeInstanceOf(RealChangeSetInvalidError);
    });
    expect(vaultRuns.allocateInto).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });
});

// D-321: the context gate itself — refetch after a credit, wallet/account match, and no
// mock fallback (cross-review B5).

const GAP_READ = {
  id: "p_000000000017",
  portfolio: {
    owner: ACCOUNT,
    name: "canary-931",
    composition: [{ token_id: "nep141:wrap.near", target_bps: 10_000, tolerance_bps: 500 }],
    held_tokens: ["nep141:wrap.near"],
    created_at: 1,
    deleted: false,
    deleted_at: 0,
  },
  balances: [["nep141:wrap.near", BigInt("1000000000000000000000000")]],
};
const GAP_FUNDING = { allocations: [{ tokenId: "near", qty: 1 }], tokenAdditions: [] };

describe("allocateIntoPortfolio — coverage gaps", () => {
  beforeEach(() => {
    localStorage.clear();
    realReads.value = [GAP_READ];
    vaultRuns.allocateInto.mockReset().mockResolvedValue({ recordId: "r", txHash: "T", credited: [] });
    door = null;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    realReads.value = [];
  });

  it("after a credit, refetches the portfolio, the General Balance and the pending notice", async () => {
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await door!.allocateIntoPortfolio(GAP_FUNDING);
    });
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["real-portfolios", ACCOUNT]);
    expect(keys).toContainEqual(["intents-balances", ACCOUNT]);
    expect(keys).toContainEqual(["pending-allocates", ACCOUNT]);
  });

  it("refuses when the live wallet is not the account's, and signs nothing", async () => {
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    (loginWallet.value as { liveConnection: unknown }).liveConnection = {
      chainKind: "near",
      address: "mallory.near",
    };
    mount();
    await act(async () => {
      await expect(door!.allocateIntoPortfolio(GAP_FUNDING)).rejects.toBeInstanceOf(
        WalletAccountMismatchError
      );
    });
    expect(vaultRuns.allocateInto).not.toHaveBeenCalled();
  });

  it("with a MOCK portfolio active, throws and signs nothing", async () => {
    realReads.value = [];
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();
    act(() => door!.createPortfolio("mock-one"));
    // Last in the file: the mock contract keeps this portfolio for the rest of the module.
    expect(door!.activePortfolio).not.toBeNull();
    expect(door!.activePortfolio?.isReal).toBeFalsy();
    await act(async () => {
      await expect(door!.allocateIntoPortfolio(GAP_FUNDING)).rejects.toThrow(/live-vault portfolio/);
    });
    expect(vaultRuns.allocateInto).not.toHaveBeenCalled();
  });
});

// D-422: a composition edit's History row comes from the chain (`portfolio_composition_changed`),
// the same on every device; the local log of 016 block 1b (D-339) is retired. After a confirmed
// operation the history is told its hash (028-7 (d)), and nothing is written to the browser for it.
describe("composition edits — no local log, the History re-reads the chain", () => {
  const logKeys = () => Object.keys(localStorage).filter((k) => k.startsWith("composition-log:"));

  beforeEach(() => {
    localStorage.clear();
    // The "MOCK portfolio active" case above leaves its portfolio in the in-memory mock, and a
    // mock portfolio listed first would be the active one here.
    mockContract._reset();
    realReads.value = [REAL_READ];
    vaultRuns.allocate.mockReset().mockResolvedValue({ portfolioId: "p_new", txHash: "TX_CREATE" });
    vaultRuns.allocateInto.mockReset().mockResolvedValue({ recordId: "r", txHash: "TX_INTO", credited: [] });
    vaultRuns.unallocate.mockReset().mockResolvedValue({ kind: "committed", txHash: "TX_EDIT" });
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    announce.mockClear();
    door = null;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    realReads.value = [];
  });

  it.each([
    ["a creation", "TX_CREATE", () => door!.createPortfolioWithChangeSet("mine", CHANGESET, "sign", STORAGE)],
    [
      "adding funds with a token that joins",
      "TX_INTO",
      () =>
        door!.allocateIntoPortfolio({
          allocations: [{ tokenId: "near", qty: 1 }],
          tokenAdditions: [{ tokenId: "nep141:usdt.tether-token.near", tolerancePct: 7 }],
        }),
    ],
    [
      "a composition edit",
      "TX_EDIT",
      () =>
        door!.commitChangeSet(
          { targetChanges: [{ tokenId: "nep141:wrap.near", newTargetPct: 60, newTolerancePct: 5 }] },
          "sign"
        ),
    ],
  ])("%s tells the history its hash and writes no local log", async (_, txHash, run) => {
    mount();
    await act(async () => {
      await run();
    });
    expect(announce).toHaveBeenCalledWith(client, ACCOUNT, txHash);
    expect(logKeys()).toEqual([]);
  });

  it("a deferred commit changed nothing on-chain and keeps the draft (it throws)", async () => {
    vaultRuns.unallocate.mockResolvedValue({
      kind: "deferred",
      txHash: "TX_DEFER",
      nextReleaseAt: 1,
      tokenId: "nep141:wrap.near",
    });
    mount();
    await act(async () => {
      await expect(
        door!.commitChangeSet(
          { targetChanges: [{ tokenId: "nep141:wrap.near", newTargetPct: 60, newTolerancePct: 5 }] },
          "sign"
        )
      ).rejects.toBeInstanceOf(RealUnallocateDeferredError);
    });
  });

  // 017-9b (D-302 j): a replay code is what a commit that ALREADY applied answers. The modal
  // shows "not confirmed" and closing drops the draft, so the portfolio must be re-read.
  it("a reverted commit re-reads the portfolios and the balances", async () => {
    const reverted = new VaultCommitRevertedError("Smart contract panicked: E_NONCE_CONSUMED");
    vaultRuns.unallocate.mockRejectedValue(reverted);
    mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await expect(
        door!.commitChangeSet(
          { targetChanges: [{ tokenId: "nep141:wrap.near", newTargetPct: 60, newTolerancePct: 5 }] },
          "sign"
        )
      ).rejects.toBe(reverted);
    });
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["real-portfolios", ACCOUNT]);
    expect(keys).toContainEqual(["intents-balances", ACCOUNT]);
  });

  // D-385 (a): the batch transfer failed in intents.near AFTER the commit applied its
  // composition. Not a revert, but the cached composition is just as stale.
  it("a batch transfer that failed after the commit applied re-reads too", async () => {
    const failed = new RealUnallocateTransferFailedError("mt_batch_transfer reverted");
    vaultRuns.unallocate.mockRejectedValue(failed);
    mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await expect(
        door!.commitChangeSet(
          { targetChanges: [{ tokenId: "nep141:wrap.near", newTargetPct: 60, newTolerancePct: 5 }] },
          "sign"
        )
      ).rejects.toBe(failed);
    });
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["real-portfolios", ACCOUNT]);
    expect(keys).toContainEqual(["intents-balances", ACCOUNT]);
  });
});

// 017-9c: rename and signed delete share one door (`runPortfolioMeta`). What the structural
// guard cannot see: a real portfolio goes to the vault and NEVER to the mock, the key gate runs
// first, and every outcome re-reads the list — a failed attempt may still have applied.
describe("renamePortfolio / deletePortfolio — the rename/delete door", () => {
  const EMPTY_REAL = {
    ...REAL_READ,
    portfolio: { ...REAL_READ.portfolio, held_tokens: [] },
    balances: [],
  };
  let mockRename: ReturnType<typeof vi.spyOn>;
  let mockDelete: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    realReads.value = [EMPTY_REAL];
    liveSigner.off = false;
    metaRuns.rename.mockReset().mockResolvedValue({ txHash: "T" });
    metaRuns.delete.mockReset().mockResolvedValue({ txHash: "T" });
    announce.mockClear();
    mockRename = vi.spyOn(mockContract, "renamePortfolio");
    mockDelete = vi.spyOn(mockContract, "deletePortfolio");
    door = null;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    realReads.value = [];
    liveSigner.off = false;
  });

  it("routes a real rename to the vault with the trimmed name, never to the mock", async () => {
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await door!.renamePortfolio(EMPTY_REAL.id, "  Largo plazo ");
    });
    expect(metaRuns.rename).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT, portfolioId: EMPTY_REAL.id, name: "Largo plazo" })
    );
    expect(mockRename).not.toHaveBeenCalled();
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(["real-portfolios", ACCOUNT]);
    expect(announce).toHaveBeenCalledWith(client, ACCOUNT, "T");
  });

  // 028-7 (d): sent but not shown in time, it may have applied — the history is asked, hash or not.
  it("a rename not confirmed in time still tells the history", async () => {
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    metaRuns.rename.mockRejectedValue(new RealPortfolioMetaUnconfirmedError("relayer: unknown outcome", null));
    mount();
    await act(async () => {
      await expect(door!.renamePortfolio(EMPTY_REAL.id, "x")).rejects.toBeInstanceOf(RealPortfolioMetaUnconfirmedError);
    });
    expect(announce).toHaveBeenCalledWith(client, ACCOUNT, null);
  });

  it("refuses a NEAR account whose key is not registered, and signs NOTHING", async () => {
    setLogin({ kind: "not-registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();
    await act(async () => {
      await expect(door!.deletePortfolio(EMPTY_REAL.id)).rejects.toBeInstanceOf(NearKeyNotVerifiedError);
    });
    expect(metaRuns.delete).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("a failed real delete still re-reads the list, and keeps its error", async () => {
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    metaRuns.delete.mockRejectedValue(new VaultCommitRevertedError("Smart contract panicked: E_PORTFOLIO_NOT_EMPTY"));
    mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await expect(door!.deletePortfolio(EMPTY_REAL.id)).rejects.toBeInstanceOf(VaultCommitRevertedError);
    });
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(["real-portfolios", ACCOUNT]);
    // A refusal changed nothing: no asks, only the re-read.
    expect(announce).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("a real portfolio with no live signer throws and never falls through to the mock", async () => {
    liveSigner.off = true;
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();
    await act(async () => {
      await expect(door!.deletePortfolio(EMPTY_REAL.id)).rejects.toThrow(/live wallet session/);
      await expect(door!.renamePortfolio(EMPTY_REAL.id, "x")).rejects.toThrow(/live wallet session/);
    });
    expect(metaRuns.delete).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it("an id the list does not have is refused, not handed to the mock", async () => {
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();
    await act(async () => {
      await expect(door!.renamePortfolio("p_0000000000ff", "x")).rejects.toThrow(/no longer in the list/);
    });
    expect(metaRuns.rename).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it("a mock portfolio is signed and handed to the mock, never to the vault", async () => {
    realReads.value = [];
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    mount();
    act(() => door!.createPortfolio("mock-meta"));
    const id = door!.activePortfolio!.id;
    await act(async () => {
      await door!.renamePortfolio(id, "renamed");
    });
    const sign = (loginWallet.value as { signMessage: ReturnType<typeof vi.fn> }).signMessage;
    expect(sign).toHaveBeenCalledTimes(1);
    expect(mockRename).toHaveBeenCalledWith(ACCOUNT, id, "renamed", undefined);
    expect(metaRuns.rename).not.toHaveBeenCalled();
    await act(async () => {
      await door!.deletePortfolio(id);
    });
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(metaRuns.delete).not.toHaveBeenCalled();
  });
});

// D-327 — which failure takes the page and which only says the list may be out of date.
describe("the portfolio read — a first read vs a re-read that fails", () => {
  beforeEach(() => {
    setLogin({ kind: "registered", accountId: ACCOUNT, publicKey: SIGNING_KEY });
    door = null;
  });
  afterEach(() => {
    realReads.value = [];
    realReads.error = null;
    cleanup();
  });

  it("a failed re-read over a list already read keeps the list and flags it", () => {
    realReads.value = [];
    realReads.error = new Error("rpc");
    mount();
    expect(door!.portfoliosError).toBeNull();
    expect(door!.portfoliosRefreshFailed).toBe(true);
  });

  it("a failed first read, with nothing to show, is the read error", () => {
    realReads.value = undefined;
    realReads.error = new Error("rpc");
    mount();
    expect(door!.portfoliosError).toBeInstanceOf(Error);
    expect(door!.portfoliosRefreshFailed).toBe(false);
  });

  it("a read that answered flags nothing", () => {
    mount();
    expect(door!.portfoliosError).toBeNull();
    expect(door!.portfoliosRefreshFailed).toBe(false);
  });
});
