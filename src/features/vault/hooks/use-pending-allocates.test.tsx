// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AllocateRescueRecord } from "../lib/allocate-rescue-store";
import type { SealRead } from "../lib/allocate-seal";

// D-293, the wiring: the real store and the real seal read handed to `findPendingAllocates`,
// and the re-evaluation that keeps a credited Allocate from being shown twice.

// Before any import: `vault-flag.ts` reads it at module evaluation.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VAULT_ROUNDTRIP = "true";
});

const deps = vi.hoisted(() => ({
  records: [] as AllocateRescueRecord[],
  readSeal: vi.fn<(signerId: string, msg: string) => Promise<SealRead>>(),
  readNonceWitness: vi.fn(),
  readVerdicts: vi.fn(),
  updateRecord: vi.fn(),
  portfoliosUpdatedAt: 0,
}));

vi.mock("../lib/allocate-rescue-store", () => ({
  listAllocateRecords: () => deps.records,
  updateAllocateRecord: deps.updateRecord,
}));
vi.mock("../lib/allocate-seal", () => ({
  readAllocateSeal: deps.readSeal,
}));
vi.mock("../lib/intents-read-client", () => ({
  readNonceWitness: deps.readNonceWitness,
}));
vi.mock("../lib/allocate-verdicts-client", async (original) => ({
  ...(await original<typeof import("../lib/allocate-verdicts-client")>()),
  fetchAllocateVerdicts: deps.readVerdicts,
}));
vi.mock("./use-real-portfolios", () => ({
  useRealPortfolios: () => ({ dataUpdatedAt: deps.portfoliosUpdatedAt }),
}));

import { PENDING_ALLOCATES_RECHECK_MS, pendingAllocatesQueryKey, usePendingAllocates } from "./use-pending-allocates";

const ME = "alice.near";

function record(over: Partial<AllocateRescueRecord> = {}): AllocateRescueRecord {
  return {
    id: "rec-1",
    signerId: ME,
    msg: '{"deadline":"1"}',
    vaultId: "intentfolio-staging.near",
    portfolioName: "Mi cartera",
    legs: [{ tokenId: "nep141:wrap.near", amount: "300000000000000000000000" }],
    createdAt: 1_000,
    status: "suspected_orphan",
    signedEnvelope: { standard: "nep413" },
    ...over,
  };
}

function setup(signerId: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => usePendingAllocates(signerId), { wrapper }) };
}

describe("usePendingAllocates", () => {
  beforeEach(() => {
    deps.records = [record()];
    deps.readSeal.mockReset();
    deps.readNonceWitness.mockReset();
    deps.readVerdicts.mockReset();
    deps.readVerdicts.mockResolvedValue({});
    deps.updateRecord.mockReset();
    deps.portfoliosUpdatedAt = 0;
  });
  afterEach(cleanup);

  it.each<[SealRead["kind"], SealRead, number]>([
    ["unsealed", { kind: "unsealed" }, 1],
    ["unreadable", { kind: "unreadable", reason: "rpc 503" }, 1],
    ["sealed", { kind: "sealed", deadlineSecs: 1 }, 0],
  ])("a %s seal → %i row(s)", async (_, seal, rows) => {
    deps.readSeal.mockResolvedValue(seal);
    const { result } = setup(ME);

    await waitFor(() => expect(result.current.pending).toBeDefined());
    expect(result.current.pending).toHaveLength(rows);
    expect(deps.readSeal).toHaveBeenCalledWith(ME, record().msg);
  });

  // V1 nonce: magic, discriminant, salt 252812b3, deadline far ahead, zero tail.
  function neverRan(over: Partial<AllocateRescueRecord> = {}) {
    const nonce = new Uint8Array(32);
    nonce.set([0x56, 0x28, 0xf6, 0xc6, 0x00, 0x25, 0x28, 0x12, 0xb3], 0);
    new DataView(nonce.buffer).setBigInt64(9, BigInt(4_000_000_000) * BigInt(1_000_000_000), true);
    const verifierNonce = Buffer.from(nonce).toString("base64");
    deps.readSeal.mockResolvedValue({ kind: "unsealed" });
    deps.readNonceWitness.mockResolvedValue({ nonceUsed: false, saltValid: true, blockTimestampMs: 2_000_000_000_000 });
    return record({ status: "submitted", verifierNonce, envelopeDeadlineSecs: 1, ...over });
  }

  // D-312, the wiring: the real nonce witness is what takes a record whose envelope never ran
  // (the relayer refused, the send never landed) off the list, and D-556 tells the user.
  it("moves an unsealed record that the nonce proves never executed to notExecuted", async () => {
    const rec = neverRan();
    deps.records = [rec];
    const { result } = setup(ME);

    await waitFor(() => expect(result.current.pending).toBeDefined());
    expect(result.current.pending).toEqual([]);
    expect(result.current.notExecuted.map((n) => n.id)).toEqual(["rec-1"]);
    expect(deps.readNonceWitness).toHaveBeenCalledWith(ME, rec.verifierNonce, "252812b3");
  });

  it("dismissing writes the record, clears the notice at once and asks the chain again", async () => {
    deps.records = [neverRan()];
    const { result } = setup(ME);
    await waitFor(() => expect(result.current.notExecuted).toHaveLength(1));

    // The re-read never answers: what clears the notice is the dismissal, not a new evaluation.
    deps.records = [neverRan({ notExecutedNoticeDismissedAt: 5 })];
    deps.readSeal.mockImplementation(() => new Promise(() => {}));
    act(() => result.current.dismissNotExecuted(["rec-1"]));

    await waitFor(() => expect(result.current.notExecuted).toEqual([]));
    expect(deps.updateRecord).toHaveBeenCalledWith("rec-1", { notExecutedNoticeDismissedAt: expect.any(Number) });
    await waitFor(() => expect(deps.readSeal).toHaveBeenCalledTimes(2));
    expect(result.current.notExecuted).toEqual([]);
  });

  it("keeps notExecuted while the evaluation is older than the list: only `pending` can double-count", async () => {
    deps.records = [neverRan()];
    const { client, result, rerender } = setup(ME);
    await waitFor(() => expect(result.current.notExecuted).toHaveLength(1));

    deps.readSeal.mockImplementation(() => new Promise(() => {}));
    deps.portfoliosUpdatedAt = client.getQueryState(pendingAllocatesQueryKey(ME))!.dataUpdatedAt + 1;
    rerender();
    expect(result.current.pending).toBeUndefined();
    expect(result.current.notExecuted).toHaveLength(1);
  });

  // D-556: nothing else re-reads a tab left open, and the envelope closes while it sits there.
  describe("the timer", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    // `vi.waitFor`, not Testing Library's: that one polls with the `setInterval` faked here.
    const tick = () => act(async () => void vi.advanceTimersByTime(PENDING_ALLOCATES_RECHECK_MS));
    // Time for a re-read that should NOT happen to show up. Only `setInterval` is faked.
    const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

    it("re-reads while a row can change, and stops when none is left", async () => {
      deps.readSeal.mockResolvedValue({ kind: "unsealed" });
      const { result } = setup(ME);
      await vi.waitFor(() => expect(result.current.pending).toHaveLength(1));
      expect(deps.readSeal).toHaveBeenCalledTimes(1);

      deps.readSeal.mockResolvedValue({ kind: "sealed", deadlineSecs: 1 });
      await tick();
      await vi.waitFor(() => expect(result.current.pending).toEqual([]));
      expect(deps.readSeal).toHaveBeenCalledTimes(2);

      await tick();
      await settle();
      expect(deps.readSeal).toHaveBeenCalledTimes(2);
    });

    it("does not re-read a row under the team's review: that verdict is permanent", async () => {
      deps.readVerdicts.mockResolvedValue({ "rec-1": "orphan_escalated" });
      const { result } = setup(ME);
      await vi.waitFor(() => expect(result.current.pending).toHaveLength(1));
      expect(deps.readVerdicts).toHaveBeenCalledTimes(1);

      await tick();
      await settle();
      expect(deps.readVerdicts).toHaveBeenCalledTimes(1);
    });
  });

  it("reads nothing without a signer", async () => {
    const { result } = setup(null);
    await act(async () => {});
    expect(result.current.pending).toBeUndefined();
    expect(deps.readSeal).not.toHaveBeenCalled();
  });

  it("uses the key the create flow invalidates", async () => {
    deps.readSeal.mockResolvedValue({ kind: "unsealed" });
    const { client, result } = setup(ME);
    await waitFor(() => expect(result.current.pending).toHaveLength(1));

    deps.readSeal.mockResolvedValue({ kind: "sealed", deadlineSecs: 1 });
    await act(async () => {
      await client.invalidateQueries({ queryKey: pendingAllocatesQueryKey(ME) });
    });
    await waitFor(() => expect(result.current.pending).toEqual([]));
  });

  it("when the portfolio list refetches after it, hides the stale rows and re-evaluates", async () => {
    deps.readSeal.mockResolvedValue({ kind: "unsealed" });
    const { client, result, rerender } = setup(ME);
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    expect(deps.readSeal).toHaveBeenCalledTimes(1);

    // The credit lands: the seal is on chain and the list has just refetched with the new
    // portfolio. In that same render the old row must already be gone — not shown twice.
    let releaseSeal!: (s: SealRead) => void;
    deps.readSeal.mockImplementation(() => new Promise((r) => (releaseSeal = r)));
    const evaluatedAt = client.getQueryState(pendingAllocatesQueryKey(ME))!.dataUpdatedAt;
    deps.portfoliosUpdatedAt = evaluatedAt + 1;
    rerender();
    expect(result.current.pending).toBeUndefined();

    await waitFor(() => expect(deps.readSeal).toHaveBeenCalledTimes(2));
    // Real time must pass so the new evaluation is stamped after the list.
    await new Promise((r) => setTimeout(r, 5));
    await act(async () => releaseSeal({ kind: "sealed", deadlineSecs: 1 }));
    await waitFor(() => expect(result.current.pending).toEqual([]));
  });
});
