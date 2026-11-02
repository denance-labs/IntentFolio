import { describe, it, expect, vi, beforeEach } from "vitest";

// The orchestration is under test, not the wire (vault-payloads.test.ts pins that) nor the
// submit (unallocate-submit.test.ts): the reads and the submit are faked at the module seam.
const reads = vi.hoisted(() => ({
  getPortfolio: vi.fn(),
  getConfig: vi.fn(),
}));
const submit = vi.hoisted(() => ({ submitUnallocate: vi.fn() }));
const vault = vi.hoisted(() => ({ id: "intentfolio-vault.near" }));

vi.mock("./vault-read-client", () => reads);
vi.mock("./unallocate-submit", () => submit);
vi.mock("@/features/wallet/config/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/wallet/config/network")>()),
  get VAULT_CONTRACT_ID() {
    return vault.id;
  },
}));
vi.mock("./vault-limits", () => ({
  loadPreflightLimits: async () => ({ maxPortfolioNameLen: 128 }),
}));

import {
  isPortfolioDeleted,
  portfolioIndexOf,
  RealPortfolioMetaUnconfirmedError,
  runRealDeletePortfolio,
  runRealRenamePortfolio,
  type RealPortfolioMetaStage,
} from "./run-real-portfolio-meta";
import { RealChangeSetInvalidError, VaultCommitRevertedError } from "./vault-errors";
import { RelayError } from "./relay-client";
import type { VaultSigner } from "./vault-signer";

const PID = "p_00000000002a"; // index 42
const signer = { scheme: "nep413", signEnvelope: vi.fn() } as unknown as VaultSigner;
const fastPoll = { timeoutMs: 3, intervalMs: 1, sleep: async () => {} };

function base(stages: RealPortfolioMetaStage[] = []) {
  return {
    accountId: "alice.near",
    portfolioId: PID,
    signer,
    loginChain: "near" as const,
    submit: vi.fn(),
    onStage: (s: RealPortfolioMetaStage) => stages.push(s),
    poll: fastPoll,
  };
}

const clean = { txHash: "tx1", deferred: null, accepted: false, failure: null };
const revert = (code: string) =>
  new VaultCommitRevertedError(`Smart contract panicked: ${code}`);

beforeEach(() => {
  vi.clearAllMocks();
  vault.id = "intentfolio-vault.near";
  reads.getConfig.mockResolvedValue({ portfolio_counter: 43, return_counter: 0, limits: {} });
});

describe("portfolioIndexOf / isPortfolioDeleted", () => {
  it("parses the contract's p_<12 hex> ids and nothing else", () => {
    expect(portfolioIndexOf("p_00000000002a")).toBe(42);
    expect(portfolioIndexOf("p_2a")).toBeNull();
    expect(portfolioIndexOf("pf-golden-1")).toBeNull();
  });

  it("is deleted only when issued (below the counter) and unreadable", async () => {
    reads.getPortfolio.mockResolvedValue(null);
    expect(await isPortfolioDeleted(PID)).toBe(true);
    reads.getConfig.mockResolvedValue({ portfolio_counter: 42 });
    expect(await isPortfolioDeleted(PID)).toBe(false); // never issued
  });

  it("is not deleted while the record still reads", async () => {
    reads.getPortfolio.mockResolvedValue({ name: "x" });
    expect(await isPortfolioDeleted(PID)).toBe(false);
  });
});

describe("runRealDeletePortfolio", () => {
  it("submits a delete alone and confirms it by state", async () => {
    submit.submitUnallocate.mockResolvedValue(clean);
    reads.getPortfolio.mockResolvedValue(null);
    const stages: RealPortfolioMetaStage[] = [];
    await expect(runRealDeletePortfolio(base(stages))).resolves.toEqual({ txHash: "tx1" });
    const args = submit.submitUnallocate.mock.calls[0][0];
    expect(args).toMatchObject({ portfolioId: PID, legs: [], delete: true });
    expect(args.name).toBeUndefined();
    expect(stages).toEqual(["signing", "confirming", "done"]);
  });

  it("refuses without a configured vault, before any signature", async () => {
    vault.id = "";
    await expect(runRealRenamePortfolio({ ...base(), name: "New" })).rejects.toThrow(/configured vault/);
    await expect(runRealDeletePortfolio(base())).rejects.toThrow(/configured vault/);
    expect(submit.submitUnallocate).not.toHaveBeenCalled();
  });

  it("reads a replay code as done when the chain shows it deleted", async () => {
    submit.submitUnallocate.mockRejectedValue(revert("E_NONCE_CONSUMED"));
    reads.getPortfolio.mockResolvedValue(null);
    await expect(runRealDeletePortfolio(base())).resolves.toEqual({ txHash: null });
  });

  it("reads a replay code as unconfirmed when the chain does not show it", async () => {
    submit.submitUnallocate.mockRejectedValue(revert("E_NONCE_CONSUMED"));
    reads.getPortfolio.mockResolvedValue({ name: "still here" });
    await expect(runRealDeletePortfolio(base())).rejects.toBeInstanceOf(
      RealPortfolioMetaUnconfirmedError
    );
  });

  it("reads E_PORTFOLIO_NOT_FOUND as done once verified deleted", async () => {
    submit.submitUnallocate.mockRejectedValue(revert("E_PORTFOLIO_NOT_FOUND"));
    reads.getPortfolio.mockResolvedValue(null);
    await expect(runRealDeletePortfolio(base())).resolves.toEqual({ txHash: null });
  });

  it("reads the gate's 'unknown portfolio' refusal as done once verified deleted (D-403)", async () => {
    submit.submitUnallocate.mockRejectedValue(new RelayError(`unknown portfolio ${PID}`, "would-fail", 422));
    reads.getPortfolio.mockResolvedValue(null);
    const stages: RealPortfolioMetaStage[] = [];
    await expect(runRealDeletePortfolio(base(stages))).resolves.toEqual({ txHash: null });
    expect(stages).toEqual(["signing", "confirming", "done"]);
  });

  it("keeps any other gate refusal of a delete, without asking the chain", async () => {
    const refusal = new RelayError(`portfolio ${PID} still holds tokens`, "would-fail", 422);
    submit.submitUnallocate.mockRejectedValue(refusal);
    await expect(runRealDeletePortfolio(base())).rejects.toBe(refusal);
    expect(reads.getPortfolio).not.toHaveBeenCalled();
  });

  it("keeps E_PORTFOLIO_NOT_EMPTY as a refusal, without asking the chain", async () => {
    submit.submitUnallocate.mockRejectedValue(revert("E_PORTFOLIO_NOT_EMPTY"));
    await expect(runRealDeletePortfolio(base())).rejects.toBeInstanceOf(VaultCommitRevertedError);
    expect(reads.getPortfolio).not.toHaveBeenCalled();
  });

  it("an unproven relay send that never shows on chain is unconfirmed, not done", async () => {
    submit.submitUnallocate.mockResolvedValue({ ...clean, submitUncertain: "timeout" });
    reads.getPortfolio.mockResolvedValue({ name: "still here" });
    await expect(runRealDeletePortfolio(base())).rejects.toBeInstanceOf(
      RealPortfolioMetaUnconfirmedError
    );
  });
});

describe("runRealRenamePortfolio", () => {
  it("submits the trimmed name and confirms it by reading it back", async () => {
    submit.submitUnallocate.mockResolvedValue(clean);
    reads.getPortfolio.mockResolvedValue({ name: "Long term" });
    await expect(runRealRenamePortfolio({ ...base(), name: "  Long term " })).resolves.toEqual({
      txHash: "tx1",
    });
    expect(submit.submitUnallocate.mock.calls[0][0]).toMatchObject({ legs: [], name: "Long term" });
    expect(submit.submitUnallocate.mock.calls[0][0].delete).toBeUndefined();
  });

  it("refuses a name over the byte cap before signing", async () => {
    // 43 × "€" = 129 UTF-8 bytes, 43 UTF-16 units: the cap is bytes.
    await expect(runRealRenamePortfolio({ ...base(), name: "€".repeat(43) })).rejects.toBeInstanceOf(
      RealChangeSetInvalidError
    );
    expect(submit.submitUnallocate).not.toHaveBeenCalled();
  });

  it("refuses an empty name before signing", async () => {
    await expect(runRealRenamePortfolio({ ...base(), name: "   " })).rejects.toThrow(/empty/);
  });

  it("does not treat E_PORTFOLIO_NOT_FOUND as success for a rename", async () => {
    submit.submitUnallocate.mockRejectedValue(revert("E_PORTFOLIO_NOT_FOUND"));
    await expect(runRealRenamePortfolio({ ...base(), name: "x" })).rejects.toBeInstanceOf(
      VaultCommitRevertedError
    );
  });
});
