// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { StrictMode } from "react";
import { renderHook, cleanup, act } from "@testing-library/react";
import { mockContract } from "@/features/intents-account/mock-contract";
import { dismissWithdrawal, usePendingWithdrawals } from "./use-pending-withdrawals";
import {
  clearWithdrawRecords,
  DISMISS_AFTER_MS,
  listUnresolvedWithdrawRecords,
  listWithdrawRecords,
  recordPendingWithdraw,
  updateWithdrawRecord,
} from "../lib/withdraw-rescue-store";

// Directly test the mock contract tracking methods (the hook's data layer).
// Hook rendering is verified manually via the visual QA flow.

describe("mockContract withdrawal tracking", () => {
  beforeEach(() => {
    mockContract._reset();
  });

  afterEach(() => {
    mockContract._reset();
  });

  it("registers a withdrawal in PENDING state", () => {
    mockContract.trackWithdrawal("intent-1", {
      accountId: "alice.near",
      tokenId: "nep141:usdt.tether-token.near",
      qty: 100,
      chainId: "near:mainnet",
      destinationAddress: "bob.near",
      ts: 1000,
    });

    const records = mockContract.getTrackedWithdrawals("alice.near");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ intentId: "intent-1", status: "PENDING", qty: 100 });
  });

  it("advances status through the lifecycle", () => {
    mockContract.trackWithdrawal("intent-2", {
      accountId: "alice.near",
      tokenId: "nep141:usdt.tether-token.near",
      qty: 50,
      chainId: "near:mainnet",
      destinationAddress: "bob.near",
      ts: 2000,
    });

    mockContract.setWithdrawalStatus("intent-2", "TX_BROADCASTED");
    expect(mockContract.getTrackedWithdrawals("alice.near")[0].status).toBe("TX_BROADCASTED");

    mockContract.setWithdrawalStatus("intent-2", "SETTLED");
    expect(mockContract.getTrackedWithdrawals("alice.near")[0].status).toBe("SETTLED");

    mockContract.setWithdrawalStatus("intent-2", "DELIVERED", { destinationTxHash: "0xabc" });
    const delivered = mockContract.getTrackedWithdrawals("alice.near")[0];
    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.destinationTxHash).toBe("0xabc");
  });

  it("marks FAILED and does not throw for unknown intentId (refundWithdrawal no-op)", () => {
    expect(() => mockContract.refundWithdrawal("no-such-intent")).not.toThrow();
  });

  it("advances to FAILED and keeps record accessible", () => {
    mockContract.trackWithdrawal("intent-fail", {
      accountId: "alice.near",
      tokenId: "nep141:usdt.tether-token.near",
      qty: 75,
      chainId: "eth:1",
      destinationAddress: "0xabc",
      ts: 3000,
    });
    mockContract.setWithdrawalStatus("intent-fail", "TX_BROADCASTED");
    mockContract.refundWithdrawal("intent-fail");

    const record = mockContract.getTrackedWithdrawals("alice.near").find((r) => r.intentId === "intent-fail");
    expect(record?.status).toBe("FAILED");
  });

  it("isolates withdrawals by account", () => {
    mockContract.trackWithdrawal("intent-a", {
      accountId: "alice.near",
      tokenId: "nep141:usdt.tether-token.near",
      qty: 10,
      chainId: "near:mainnet",
      destinationAddress: "x.near",
      ts: 1,
    });
    mockContract.trackWithdrawal("intent-b", {
      accountId: "bob.near",
      tokenId: "nep141:usdt.tether-token.near",
      qty: 20,
      chainId: "near:mainnet",
      destinationAddress: "y.near",
      ts: 2,
    });

    expect(mockContract.getTrackedWithdrawals("alice.near")).toHaveLength(1);
    expect(mockContract.getTrackedWithdrawals("bob.near")).toHaveLength(1);
    expect(mockContract.getTrackedWithdrawals("alice.near")[0].intentId).toBe("intent-a");
  });
});

// ── Block 5.4 ──────────────────────────────────────────────────────────────────
// Two behaviours the real path depends on, both of which the mock progression would
// otherwise trample.

const USDT_ARB = "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near";
const ACCOUNT = "alice.near";

function seedRescueRecord(
  overrides: Partial<Extract<Parameters<typeof recordPendingWithdraw>[0], { route: unknown }>> = {}
) {
  return recordPendingWithdraw({
    signerId: ACCOUNT,
    tokenId: USDT_ARB,
    amount: "500000",
    qty: 0.5,
    route: "omft",
    chainId: "eth:42161",
    destinationAddress: "0x195d287fB6E1fbBaaC18cB6C7DB0050388Ed8B00",
    ...overrides,
  });
}

describe("usePendingWithdrawals — rescue-store hydration (D-193)", () => {
  beforeEach(() => {
    mockContract._reset();
    clearWithdrawRecords();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    mockContract._reset();
    clearWithdrawRecords();
  });

  // The gap this closes: the in-flight list lives in memory and dies with the tab, while a
  // published withdrawal can take minutes. Without this, a reload mid-flight makes the row
  // disappear — and a withdrawal has NO Solver-side backstop (D-160), so this worklist is
  // the only recovery mechanism there is.
  it("shows an unresolved record from a previous session", () => {
    const id = seedRescueRecord();

    const { result } = renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT }));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      intentId: id,
      status: "PENDING",
      qty: 0.5,
      chainId: "eth:42161",
      isReal: true,
    });
  });

  it("carries the record's own progress across, not a fresh PENDING", () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });

    const { result } = renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT }));

    expect(result.current[0]).toMatchObject({ status: "SETTLED", txHash: "NEARTX123" });
  });

  it("ignores records belonging to another account", () => {
    seedRescueRecord({ signerId: "bob.near" });

    const { result } = renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT }));

    expect(result.current).toHaveLength(0);
  });

  // Resolved means delivered or definitively failed. Re-hydrating those would refill the
  // feed with finished business on every reload.
  it("ignores resolved records", () => {
    const delivered = seedRescueRecord();
    updateWithdrawRecord(delivered, { status: "delivered" });
    const failed = seedRescueRecord();
    updateWithdrawRecord(failed, { status: "failed" });

    const { result } = renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT }));

    expect(result.current).toHaveLength(0);
  });

  it("does not duplicate a row the store is already tracking", () => {
    const id = seedRescueRecord();
    mockContract.trackWithdrawal(id, {
      accountId: ACCOUNT,
      tokenId: USDT_ARB,
      qty: 0.5,
      chainId: "eth:42161",
      destinationAddress: "0x195d287fB6E1fbBaaC18cB6C7DB0050388Ed8B00",
      ts: Date.now(),
      status: "TX_BROADCASTED",
      isReal: true,
    });

    const { result } = renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT }));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].status).toBe("TX_BROADCASTED");
  });
});

// ── D-259 ──────────────────────────────────────────────────────────────────────
// Rehydration used to restore the label and not the machinery: a record with a persisted
// error came back as a clean "Pending", and a settled record with no delivery came back as
// "Settled on NEAR" and froze there forever. Both measured on a real withdrawal, same run.

describe("usePendingWithdrawals — rehydration resolves against the chain (D-259)", () => {
  beforeEach(() => {
    mockContract._reset();
    clearWithdrawRecords();
  });

  afterEach(() => {
    cleanup();
    mockContract._reset();
    clearWithdrawRecords();
  });

  it("does not show a clean Pending over a record that carries an error", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { error: "Could not confirm whether the withdrawal was published" });

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeDelivery: vi.fn() })
    );

    // Not PENDING (would claim it is cleanly in flight) and not FAILED (would promise the
    // funds are safe, which only `fundsState: "untouched"` may say).
    expect(result.current[0].status).toBe("UNCONFIRMED");
  });

  it("resumes the delivery wait for a settled record and lands it DELIVERED", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const resumeDelivery = vi.fn().mockResolvedValue({
      kind: "bridge",
      destinationTxHash: "0xDESTINATION",
      chain: "eth:42161",
    });
    const onDelivered = vi.fn();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, onDelivered, resumeDelivery })
    );
    await act(async () => {});

    // Resumed from the record alone — everything the wait needs survived the reload.
    expect(resumeDelivery).toHaveBeenCalledOnce();
    expect(resumeDelivery.mock.calls[0][0]).toMatchObject({
      tokenId: USDT_ARB,
      route: "omft",
      // With the token, the chain names the route: an omft token can also go to NEAR (D-384).
      chainId: "eth:42161",
      txHash: "NEARTX123",
    });
    expect(result.current[0]).toMatchObject({
      status: "DELIVERED",
      destinationTxHash: "0xDESTINATION",
    });
    expect(onDelivered).toHaveBeenCalledOnce();
    // Persisted too: the next reload must not re-open a wait that already has its answer.
    expect(listWithdrawRecords().find((r) => r.id === id)).toMatchObject({
      status: "delivered",
      destinationTxHash: "0xDESTINATION",
    });
  });

  // D-384: the record carries the chain, and the real wait resolves the NEAR route from it. Without
  // it the wait would resolve the bridge route and call a delivered withdrawal a mismatch.
  it("resumes an omft token sent to NEAR as delivered, through the real wait", async () => {
    const id = seedRescueRecord({
      tokenId: "nep141:sol.omft.near",
      route: "near-native",
      chainId: "near:mainnet",
      destinationAddress: "pablofork.near",
    });
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });

    const { result } = renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT }));
    await act(async () => {});

    expect(result.current[0].status).toBe("DELIVERED");
    expect(listWithdrawRecords().find((r) => r.id === id)).toMatchObject({ status: "delivered" });
  });

  it("leaves an unanswered resume UNCONFIRMED, never FAILED", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const resumeDelivery = vi.fn().mockRejectedValue(new Error("delivery not confirmed"));

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeDelivery })
    );
    await act(async () => {});

    // The funds have already left the balance. Claiming a loss here is the one mistake this
    // whole phase exists to avoid.
    expect(result.current[0].status).toBe("UNCONFIRMED");
    expect(listWithdrawRecords().find((r) => r.id === id)).toMatchObject({
      status: "settled",
      error: "delivery not confirmed",
    });
  });

  it("does not re-open a wait for a record that already has its delivery", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, {
      status: "settled",
      txHash: "NEARTX123",
      destinationTxHash: "0xALREADYTHERE",
    });
    const resumeDelivery = vi.fn();

    renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeDelivery }));
    await act(async () => {});

    expect(resumeDelivery).not.toHaveBeenCalled();
  });

  // ── Found by cross-review on the first version of this fix ────────────────────────────
  // All three come from one root cause: resumability was a by-product of hydration, and an id
  // was marked "resumed" forever. A wait the cleanup killed could never be reopened.

  it("reopens the wait under StrictMode, where the effect runs twice", async () => {
    // StrictMode is on for every `npm run dev` (Next sets it by default), which is exactly
    // where the real-money runs get watched. The first pass started the wait, the cleanup
    // aborted it, and the second pass returned early — so D-259 was unobservable in dev.
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const resumeDelivery = vi.fn().mockResolvedValue({
      kind: "bridge",
      destinationTxHash: "0xDESTINATION",
      chain: "eth:42161",
    });

    const { result } = renderHook(
      () => usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeDelivery }),
      { wrapper: StrictMode }
    );
    await act(async () => {});

    expect(result.current[0]).toMatchObject({
      status: "DELIVERED",
      destinationTxHash: "0xDESTINATION",
    });
  });

  it("reopens the wait after switching account away and back", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    // Never settles: the wait is still open when the account switch aborts it.
    const resumeDelivery = vi.fn().mockReturnValue(new Promise(() => {}));

    const { rerender } = renderHook(
      ({ account }) =>
        usePendingWithdrawals({ intentsAccountId: account, resumeDelivery }),
      { initialProps: { account: ACCOUNT } }
    );
    await act(async () => {});
    expect(resumeDelivery).toHaveBeenCalledTimes(1);

    await act(async () => rerender({ account: "bob.near" }));
    await act(async () => rerender({ account: ACCOUNT }));

    // Three, not two, since D-264 stopped filtering the worklist by who is logged in: the
    // pass as bob.near re-checks alice's record too. What this test guards is unchanged and
    // is the reason the count may not be 1 — a wait the cleanup killed must be free to start
    // again, or the row reads "Settled on NEAR" for the rest of the session, which is the
    // exact freeze D-259 exists to end.
    expect(resumeDelivery).toHaveBeenCalledTimes(3);
  });

  // ── D-264: the re-check is the only recovery a withdrawal has (no Solver backstop, D-160),
  // and it used to be switched off by the very reload it exists for.
  it("re-checks a settled record with nobody logged in", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const resumeDelivery = vi.fn().mockResolvedValue({
      kind: "hot-bridge",
      destinationTxHash: "STELLARTX",
      chain: "stellar:mainnet",
      nonce: "1786399461000001592906",
    });

    // What the shell passes while the session has not restored: `loginConnected ? id : ""`.
    renderHook(() => usePendingWithdrawals({ intentsAccountId: "", resumeDelivery }));
    await act(async () => {});

    expect(resumeDelivery).toHaveBeenCalledTimes(1);
    // Closed in the DURABLE store, which is what the next mount reads.
    expect(listWithdrawRecords()[0]).toMatchObject({
      status: "delivered",
      destinationTxHash: "STELLARTX",
    });
  });

  // 🔴 The defect cross-review reproduced: the two halves of D-264 cancelling out. Closing the
  // record before login restores took it OFF the unresolved worklist, so hydration skipped it
  // and the user who reloaded to check on their withdrawal got an EMPTY feed — no row, no
  // strip, no toast. Worse than the freeze it replaced, on the same scenario.
  it("still shows a withdrawal that closed before the session restored", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const onDelivered = vi.fn();
    const resumeDelivery = vi.fn().mockResolvedValue({
      kind: "hot-bridge",
      destinationTxHash: "STELLARTX",
      chain: "stellar:mainnet",
      nonce: "1786399461000001592906",
    });

    // `loginStatus` is "restoring" on every first client render, so the shell passes "".
    const { result, rerender } = renderHook(
      ({ account }) => usePendingWithdrawals({ intentsAccountId: account, onDelivered, resumeDelivery }),
      { initialProps: { account: "" } }
    );
    await act(async () => {});
    // The record is resolved now, and NOT on the unresolved worklist hydration reads.
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "delivered" });

    await act(async () => rerender({ account: ACCOUNT }));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      intentId: id,
      status: "DELIVERED",
      // The DESTINATION hash, not the NEAR settlement one standing in for it.
      destinationTxHash: "STELLARTX",
      txHash: "NEARTX123",
    });
    // Same signal the live path sends, so the toast and the badge do not depend on whether the
    // delivery happened to be observed while the user was watching.
    expect(onDelivered).toHaveBeenCalledTimes(1);
  });

  it("does not drag 30 days of resolved records into the feed", async () => {
    // `closedUnseen` lets resolved records past hydration's filter. Only the ones this page
    // closed: the store keeps delivered/failed records for 30 days as an evidence trail, and
    // hydrating that wholesale would bury the feed in history.
    const old = seedRescueRecord();
    updateWithdrawRecord(old, { status: "delivered", destinationTxHash: "OLDTX" });
    const failed = seedRescueRecord();
    updateWithdrawRecord(failed, { status: "failed", error: "rejected" });

    const { result } = renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT }));
    await act(async () => {});

    expect(result.current).toHaveLength(0);
  });

  it("does not let a stale error relabel an observed delivery", async () => {
    // A record can carry an `error` from an attempt that later succeeded. Hydration maps a
    // persisted error to UNCONFIRMED, which is right for an OPEN record and wrong for a closed
    // one — it would put "Not confirmed" over a delivery, the D-259 stale-label bug inverted.
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123", error: "timed out once" });
    const resumeDelivery = vi.fn().mockResolvedValue({
      kind: "hot-bridge",
      destinationTxHash: "STELLARTX",
      chain: "stellar:mainnet",
      nonce: "n",
    });

    const { result, rerender } = renderHook(
      ({ account }) => usePendingWithdrawals({ intentsAccountId: account, resumeDelivery }),
      { initialProps: { account: "" } }
    );
    await act(async () => {});
    await act(async () => rerender({ account: ACCOUNT }));

    expect(result.current[0]).toMatchObject({ status: "DELIVERED" });
  });

  it("closes another account's record without announcing it", async () => {
    const id = seedRescueRecord({ signerId: "bob.near" });
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    // Tracked in memory under bob, the way a previous session on this browser would have left
    // it. Without this the record is findable under NOBODY and the test passes for the wrong
    // reason — it has to be reachable by the signer to prove the lookup uses the shown account.
    mockContract.trackWithdrawal(id, {
      accountId: "bob.near",
      tokenId: USDT_ARB,
      qty: 0.5,
      chainId: "eth:42161",
      destinationAddress: "0x195d287fB6E1fbBaaC18cB6C7DB0050388Ed8B00",
      ts: Date.now(),
      status: "SETTLED",
      isReal: true,
    });
    const onDelivered = vi.fn();
    const resumeDelivery = vi.fn().mockResolvedValue({
      kind: "bridge",
      destinationTxHash: "0xDESTINATION",
      chain: "eth:42161",
    });

    renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, onDelivered, resumeDelivery })
    );
    await act(async () => {});

    expect(listWithdrawRecords()[0]).toMatchObject({ status: "delivered" });
    // The toast and the My Account badge belong to whoever is at the screen. Firing them for
    // bob's withdrawal would tell alice that money of hers landed when none did.
    expect(onDelivered).not.toHaveBeenCalled();
  });

  it("does not erase a destination hash another tab already recorded", async () => {
    // Two tabs share localStorage but not the in-memory tracking, so both can wait on one
    // withdrawal. On hot-omni a delivery can be confirmed WITHOUT a hash, so the tab that
    // answers `null` must not blank out the explorer link the other one saved.
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const resumeDelivery = vi.fn().mockImplementation(async () => {
      updateWithdrawRecord(id, { destinationTxHash: "0xFROM_THE_OTHER_TAB" });
      return { kind: "hot-bridge", destinationTxHash: null, chain: "ton:mainnet", nonce: "7" };
    });

    renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeDelivery }));
    await act(async () => {});

    expect(listWithdrawRecords().find((r) => r.id === id)).toMatchObject({
      status: "delivered",
      destinationTxHash: "0xFROM_THE_OTHER_TAB",
    });
  });

  it("still hydrates an ordinary in-flight record untouched", async () => {
    // The regression guard: nothing above may change the record that has nothing wrong.
    seedRescueRecord();
    const resumeDelivery = vi.fn();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeDelivery })
    );
    await act(async () => {});

    expect(result.current[0].status).toBe("PENDING");
    expect(resumeDelivery).not.toHaveBeenCalled();
  });
});

// ── Plan 020 §5.4 (block 020-2) ──────────────────────────────────────────────
// A Converting Withdrawal is followed by asking 1Click, by deposit address. Only SUCCESS or
// REFUNDED closes it; FAILED and an unanswered watch leave it open — and it must never be handed
// to the bridge wait, whose "no answer" would be a lie about money that never crossed a bridge.

const ETH_OMFT = "nep141:eth.omft.near";
const ETH_NEAR = "nep141:eth.bridge.near";
const DEPOSIT = "5863efabda6c40d89b37aa899add569e32cb7a670e6b56a7f2cbb8d62c5333a0";
const QUOTE_SIGNATURE = "ed25519:quoteSignature";

function seedConversionRecord(overrides: { signerId?: string } = {}) {
  return recordPendingWithdraw({
    kind: "conversion",
    signerId: overrides.signerId ?? ACCOUNT,
    tokenId: ETH_OMFT,
    amount: "5000000000000000",
    qty: 0.005,
    chainId: "near:mainnet",
    destinationAddress: "alice.near",
    conversion: {
      depositAddress: DEPOSIT,
      deliveryTokenId: ETH_NEAR,
      amountOut: "4998990052004899",
      minAmountOut: "4973995101744874",
      requestedDeadlineMs: 1_790_000_000_000,
      quoteSignature: QUOTE_SIGNATURE,
    },
  });
}

const reading = (status: string, over: Record<string, unknown> = {}) => ({
  status,
  updatedAt: null,
  destinationTxHash: null,
  amountOutRaw: null,
  refundedAmountRaw: "0",
  ...over,
});

describe("usePendingWithdrawals — conversions resume through 1Click (020-2)", () => {
  beforeEach(() => {
    mockContract._reset();
    clearWithdrawRecords();
  });

  afterEach(() => {
    cleanup();
    mockContract._reset();
    clearWithdrawRecords();
  });

  it("hydrates a conversion with what leaves and what arrives", () => {
    const id = seedConversionRecord();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeConversion: vi.fn(() => new Promise<never>(() => {})) })
    );

    expect(result.current[0]).toMatchObject({
      intentId: id,
      tokenId: ETH_OMFT,
      deliveryTokenId: ETH_NEAR,
      chainId: "near:mainnet",
      isReal: true,
    });
  });

  it("asks 1Click about a settled conversion and lands it DELIVERED — never through the bridge wait", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const resumeDelivery = vi.fn();
    const resumeConversion = vi.fn().mockResolvedValue({
      kind: "delivered",
      reading: reading("SUCCESS", { destinationTxHash: "DESTTX", amountOutRaw: "4990000000000000" }),
    });
    const onDelivered = vi.fn();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, onDelivered, resumeDelivery, resumeConversion })
    );
    await act(async () => {});

    expect(resumeDelivery).not.toHaveBeenCalled();
    expect(resumeConversion).toHaveBeenCalledOnce();
    expect(resumeConversion.mock.calls[0][0]).toMatchObject({
      depositAddress: DEPOSIT,
      quoteSignature: QUOTE_SIGNATURE,
      // The quote's estimate did not survive the reload: the floor.
      timeoutMs: 15 * 60 * 1000,
    });
    // What ARRIVED travels with the row, so the toast does not repeat what was sent.
    const delivered = {
      status: "DELIVERED",
      destinationTxHash: "DESTTX",
      deliveredAmountRaw: "4990000000000000",
    };
    expect(result.current[0]).toMatchObject(delivered);
    expect(onDelivered).toHaveBeenCalledWith(expect.objectContaining(delivered));
    expect(listWithdrawRecords()[0]).toMatchObject({
      status: "delivered",
      destinationTxHash: "DESTTX",
      deliveredAmount: "4990000000000000",
    });
  });

  it("lands a refund as REFUNDED, resolved, with what came back", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const resumeConversion = vi.fn().mockResolvedValue({
      kind: "refunded",
      reading: reading("REFUNDED", { refundedAmountRaw: "5000000000000000" }),
    });
    const onRefunded = vi.fn();
    const onFailed = vi.fn();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, onRefunded, onFailed, resumeConversion })
    );
    await act(async () => {});

    expect(result.current[0].status).toBe("REFUNDED");
    expect(onRefunded).toHaveBeenCalledOnce();
    // A refund is not a failure to move: FAILED's toast would say the opposite of what happened.
    expect(onFailed).not.toHaveBeenCalled();
    expect(listWithdrawRecords()[0]).toMatchObject({
      status: "refunded",
      refundedAmount: "5000000000000000",
    });
    expect(listUnresolvedWithdrawRecords()).toEqual([]);
  });

  it.each([
    ["1Click reports FAILED", { kind: "failed", reading: reading("FAILED") }, "1Click reported FAILED"],
    [
      "the watch ends unanswered",
      { kind: "unanswered", last: null, detail: "no final answer within 900s (1Click status answered 503)" },
      "no final answer within 900s (1Click status answered 503)",
    ],
  ])("%s: UNCONFIRMED, record left open", async (_label, outcome, error) => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const resumeConversion = vi.fn().mockResolvedValue(outcome);

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeConversion })
    );
    await act(async () => {});

    expect(result.current[0].status).toBe("UNCONFIRMED");
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "settled", error });
    expect(listUnresolvedWithdrawRecords()).toHaveLength(1);
  });

  // D-436: a stored `error` hydrates the row as UNCONFIRMED; while 1Click says PROCESSING it is
  // converting, and only the final answer may move it on.
  it("goes back to Converting while 1Click reports PROCESSING, then lands on the final state", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123", error: "watch crashed" });
    let finish!: (o: unknown) => void;
    const resumeConversion = vi.fn(
      (p: { onReading?: (r: unknown) => void }) =>
        new Promise((resolve) => {
          p.onReading?.(reading("PROCESSING"));
          finish = resolve;
        })
    );

    const { result } = renderHook(() =>
      usePendingWithdrawals({
        intentsAccountId: ACCOUNT,
        resumeConversion: resumeConversion as never,
      })
    );
    await act(async () => {});
    expect(result.current[0].status).toBe("SETTLED");

    await act(async () => {
      finish({ kind: "delivered", reading: reading("SUCCESS", { destinationTxHash: "DESTTX" }) });
    });
    expect(result.current[0].status).toBe("DELIVERED");
  });

  it("PROCESSING and then FAILED lands back on unconfirmed", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123", error: "watch crashed" });
    let finish!: (o: unknown) => void;
    const resumeConversion = vi.fn(
      (p: { onReading?: (r: unknown) => void }) =>
        new Promise((resolve) => {
          p.onReading?.(reading("PROCESSING"));
          finish = resolve;
        })
    );

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeConversion: resumeConversion as never })
    );
    await act(async () => {});
    expect(result.current[0].status).toBe("SETTLED");

    await act(async () => {
      finish({ kind: "failed", reading: reading("FAILED") });
    });
    expect(result.current[0].status).toBe("UNCONFIRMED");
  });

  it("a PROCESSING reading after the final answer does not reopen the row", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123", error: "watch crashed" });
    let onReading!: (r: unknown) => void;
    const resumeConversion = vi.fn((p: { onReading?: (r: unknown) => void }) => {
      onReading = p.onReading!;
      return Promise.resolve({ kind: "delivered", reading: reading("SUCCESS", { destinationTxHash: "DESTTX" }) });
    });

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeConversion: resumeConversion as never })
    );
    await act(async () => {});
    expect(result.current[0].status).toBe("DELIVERED");

    await act(async () => {
      onReading(reading("PROCESSING"));
    });
    expect(result.current[0].status).toBe("DELIVERED");
  });

  it("a non-PROCESSING reading leaves an unconfirmed conversion unconfirmed", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123", error: "watch crashed" });
    const resumeConversion = vi.fn((p: { onReading?: (r: unknown) => void }) => {
      p.onReading?.(reading("PENDING_DEPOSIT"));
      return new Promise<never>(() => {});
    });

    const { result } = renderHook(() =>
      usePendingWithdrawals({
        intentsAccountId: ACCOUNT,
        resumeConversion: resumeConversion as never,
      })
    );
    await act(async () => {});
    expect(result.current[0].status).toBe("UNCONFIRMED");
  });

  it("treats a watch that throws as no answer", async () => {
    seedConversionRecord();
    const resumeConversion = vi.fn().mockRejectedValue(new Error("watch crashed"));

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeConversion })
    );
    await act(async () => {});

    expect(result.current[0].status).toBe("UNCONFIRMED");
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "publishing", error: "watch crashed" });
  });

  it("asks about a conversion whose publish never answered — the deposit address is known from the start", async () => {
    seedConversionRecord(); // still `publishing`: no intent hash, no settlement
    const resumeConversion = vi.fn().mockResolvedValue({ kind: "delivered", reading: reading("SUCCESS") });

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeConversion })
    );
    await act(async () => {});

    expect(resumeConversion).toHaveBeenCalledOnce();
    expect(result.current[0].status).toBe("DELIVERED");
  });

  it("does not ask about a conversion that is already resolved", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "refunded" });
    const resumeConversion = vi.fn();

    renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeConversion }));
    await act(async () => {});

    expect(resumeConversion).not.toHaveBeenCalled();
  });

  // D-440: a conversion's `transfer` to 1Click is not an `mt_burn`, so no chain row ever takes
  // its place in the feed. Measured s230: a delivered conversion vanished on reload.
  it("keeps a delivered conversion in the feed after a reload, without announcing it again", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, {
      status: "delivered",
      txHash: "NEARTX123",
      destinationTxHash: "DESTTX",
      deliveredAmount: "4990000000000000",
    });
    const resumeConversion = vi.fn();
    const onDelivered = vi.fn();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, onDelivered, resumeConversion })
    );
    await act(async () => {});

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      intentId: id,
      status: "DELIVERED",
      deliveryTokenId: ETH_NEAR,
      destinationTxHash: "DESTTX",
      deliveredAmountRaw: "4990000000000000",
    });
    // Old news: the toast and the badge fired when it closed, not on every reload.
    expect(onDelivered).not.toHaveBeenCalled();
    expect(resumeConversion).not.toHaveBeenCalled();
  });

  it("keeps a refunded conversion in the feed after a reload", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "refunded" });
    const onRefunded = vi.fn();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, onRefunded, resumeConversion: vi.fn() })
    );
    await act(async () => {});

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ intentId: id, status: "REFUNDED" });
    expect(onRefunded).not.toHaveBeenCalled();
  });

  it("does not bring back a conversion that failed before any money left", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "failed", error: "rejected" });

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeConversion: vi.fn() })
    );
    await act(async () => {});

    expect(result.current).toHaveLength(0);
  });

  it("does not bring back another account's finished conversion", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "delivered" });

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: "bob.near", resumeConversion: vi.fn() })
    );
    await act(async () => {});

    expect(result.current).toHaveLength(0);
  });

  it("never sends a direct withdrawal to 1Click", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const resumeConversion = vi.fn();
    const resumeDelivery = vi.fn().mockResolvedValue({ kind: "bridge", destinationTxHash: "0xD", chain: "eth:42161" });

    renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeConversion, resumeDelivery }));
    await act(async () => {});

    expect(resumeConversion).not.toHaveBeenCalled();
    expect(resumeDelivery).toHaveBeenCalledOnce();
  });

  it("still shows a refund that closed before the session restored", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const onRefunded = vi.fn();
    const resumeConversion = vi.fn().mockResolvedValue({ kind: "refunded", reading: reading("REFUNDED") });

    const { result, rerender } = renderHook(
      ({ account }) => usePendingWithdrawals({ intentsAccountId: account, onRefunded, resumeConversion }),
      { initialProps: { account: "" } }
    );
    await act(async () => {});
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "refunded" });
    expect(onRefunded).not.toHaveBeenCalled();

    await act(async () => rerender({ account: ACCOUNT }));

    expect(result.current[0]).toMatchObject({ intentId: id, status: "REFUNDED" });
    expect(onRefunded).toHaveBeenCalledOnce();
  });

  it("still announces what arrived for a delivery that closed before the session restored", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const onDelivered = vi.fn();
    const resumeConversion = vi.fn().mockResolvedValue({
      kind: "delivered",
      reading: reading("SUCCESS", { amountOutRaw: "4990000000000000" }),
    });

    const { rerender } = renderHook(
      ({ account }) => usePendingWithdrawals({ intentsAccountId: account, onDelivered, resumeConversion }),
      { initialProps: { account: "" } }
    );
    await act(async () => {});
    await act(async () => rerender({ account: ACCOUNT }));

    expect(onDelivered).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: id, status: "DELIVERED", deliveredAmountRaw: "4990000000000000" })
    );
  });

  it("stops asking when the dashboard unmounts, and writes nothing after", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    let seenSignal: AbortSignal | undefined;
    let answer: (o: unknown) => void = () => {};
    const resumeConversion = vi.fn(({ signal }: { signal?: AbortSignal }) => {
      seenSignal = signal;
      return new Promise((resolve) => (answer = resolve));
    });

    const { unmount } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, resumeConversion: resumeConversion as never })
    );
    // The re-checks start after the verdict read (024-D), one tick in.
    await act(async () => {});
    unmount();
    expect(seenSignal?.aborted).toBe(true);

    await act(async () => answer({ kind: "unanswered", last: null, detail: "stopped watching" }));
    // Not marked unconfirmed by a watch WE stopped: the next mount asks again.
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "settled" });
    expect(listWithdrawRecords()[0].error).toBeUndefined();
  });
});

describe("usePendingWithdrawals — the mock progression stays off real withdrawals", () => {
  beforeEach(() => {
    mockContract._reset();
    clearWithdrawRecords();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    mockContract._reset();
    clearWithdrawRecords();
  });

  // `runRealWithdraw` reports observed stages. A simulated timer firing at a real
  // withdrawal would invent a settlement that may not have happened — and the 25% failure
  // branch would refund a mock balance and label money that is genuinely in flight as lost.
  it("never advances a real withdrawal on a timer", () => {
    // "0…" would take the simulated-failure branch if the guard were missing.
    const intentId = "0-real-withdrawal";
    mockContract.trackWithdrawal(intentId, {
      accountId: ACCOUNT,
      tokenId: USDT_ARB,
      qty: 0.5,
      chainId: "eth:42161",
      destinationAddress: "0x195d287fB6E1fbBaaC18cB6C7DB0050388Ed8B00",
      ts: Date.now(),
      isReal: true,
    });
    const onFailed = vi.fn();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, onFailed })
    );
    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(result.current[0].status).toBe("PENDING");
    expect(onFailed).not.toHaveBeenCalled();
  });

  // The other half of the same guarantee: with the flag off nothing changed, so a mock
  // withdrawal still runs the full simulated progression.
  it("still advances a mock withdrawal on the same timers", () => {
    const intentId = "a-mock-withdrawal"; // not in {0,1,2,3} — happy path
    mockContract.trackWithdrawal(intentId, {
      accountId: ACCOUNT,
      tokenId: USDT_ARB,
      qty: 0.5,
      chainId: "eth:42161",
      destinationAddress: "0x195d287fB6E1fbBaaC18cB6C7DB0050388Ed8B00",
      ts: Date.now(),
    });
    const onDelivered = vi.fn();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, onDelivered })
    );
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current[0].status).toBe("TX_BROADCASTED");

    act(() => {
      vi.advanceTimersByTime(150_000);
    });
    expect(result.current[0].status).toBe("DELIVERED");
    expect(onDelivered).toHaveBeenCalledOnce();
  });
});

// ── D-463 ──────────────────────────────────────────────────────────────────────────────────
// A publish whose page stopped watching. Measured s254: `published`, delivered on chain two
// seconds later, shown "in progress" for nine days because nothing re-checked it.

const NEAR_TOKEN = "near";

function seedPublishedNear() {
  const id = recordPendingWithdraw({
    signerId: ACCOUNT,
    tokenId: NEAR_TOKEN,
    amount: "1000000000000000000000000",
    qty: 1,
    route: "near-unwrap",
    chainId: "near:mainnet",
    destinationAddress: ACCOUNT,
    nonce: "6RB+1r+c2m86XOwmAuOjQ23QcHTVBaOv9ykJXPv/DsI=",
    deadline: 1_790_000_000_000,
  });
  updateWithdrawRecord(id, { status: "published", intentHash: "INTENTHASH" });
  return id;
}

describe("usePendingWithdrawals — an unanswered publish is re-checked (D-463)", () => {
  beforeEach(() => {
    mockContract._reset();
    clearWithdrawRecords();
  });

  afterEach(() => {
    cleanup();
    mockContract._reset();
    clearWithdrawRecords();
  });

  it("the s254 case: executed on a NEAR route is delivered, and the user is told", async () => {
    const id = seedPublishedNear();
    const checkPublishedWithdraw = vi.fn().mockResolvedValue({ kind: "executed" });
    const onDelivered = vi.fn();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw, onDelivered })
    );
    await act(async () => {});

    expect(checkPublishedWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ id, signerId: ACCOUNT, intentHash: "INTENTHASH", deadline: 1_790_000_000_000 })
    );
    expect(result.current[0].status).toBe("DELIVERED");
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "delivered" });
    expect(listUnresolvedWithdrawRecords()).toHaveLength(0);
    expect(onDelivered).toHaveBeenCalledOnce();
  });

  it("relay SETTLED: records the tx and carries on into the delivery wait", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "published", intentHash: "INTENTHASH" });
    const checkPublishedWithdraw = vi.fn().mockResolvedValue({ kind: "settled", txHash: "NEARTX" });
    const resumeDelivery = vi.fn().mockResolvedValue({
      kind: "bridge",
      destinationTxHash: "0xDEST",
      chain: "eth:42161",
    });

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw, resumeDelivery })
    );
    await act(async () => {});

    expect(resumeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ route: "omft", chainId: "eth:42161", txHash: "NEARTX" })
    );
    expect(result.current[0].status).toBe("DELIVERED");
    expect(listWithdrawRecords()[0]).toMatchObject({
      status: "delivered",
      txHash: "NEARTX",
      destinationTxHash: "0xDEST",
    });
  });

  it("executed on a bridged route with no tx: settled + unconfirmed, and not asked again", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "published", intentHash: "INTENTHASH" });
    const checkPublishedWithdraw = vi.fn().mockResolvedValue({ kind: "executed" });
    const resumeDelivery = vi.fn();

    const first = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw, resumeDelivery })
    );
    await act(async () => {});

    // The funds left the balance: never FAILED, never a fake "delivered".
    expect(first.result.current[0].status).toBe("UNCONFIRMED");
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "settled" });
    expect(listWithdrawRecords()[0].error).toMatch(/nonce used/);
    expect(resumeDelivery).not.toHaveBeenCalled();

    // Next load: no tx to wait on, and no longer a publish to check.
    first.unmount();
    mockContract._reset();
    renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw, resumeDelivery })
    );
    await act(async () => {});
    expect(checkPublishedWithdraw).toHaveBeenCalledOnce();
    expect(resumeDelivery).not.toHaveBeenCalled();
  });

  it("never executed: failed, funds intact, and the user is told", async () => {
    seedPublishedNear();
    const checkPublishedWithdraw = vi.fn().mockResolvedValue({ kind: "never-executed" });
    const onNeverExecuted = vi.fn();
    const onFailed = vi.fn();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw, onNeverExecuted, onFailed })
    );
    await act(async () => {});

    expect(result.current[0].status).toBe("FAILED");
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "failed" });
    expect(onNeverExecuted).toHaveBeenCalledOnce();
    // Not "failed · returned to your balance": the funds never left.
    expect(onFailed).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", vi.fn().mockResolvedValue({ kind: "unknown", reason: "deadline not passed" })],
    ["a check that throws", vi.fn().mockRejectedValue(new Error("boom"))],
  ])("%s: the record is left exactly as it was", async (_label, checkPublishedWithdraw) => {
    seedPublishedNear();
    const before = listWithdrawRecords()[0];

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw })
    );
    await act(async () => {});

    expect(result.current[0].status).toBe("TX_BROADCASTED");
    expect(listWithdrawRecords()[0]).toEqual(before);
  });

  it("closed before login: the failure is announced when the account arrives", async () => {
    seedPublishedNear();
    const checkPublishedWithdraw = vi.fn().mockResolvedValue({ kind: "never-executed" });
    const onNeverExecuted = vi.fn();

    const { rerender } = renderHook(
      ({ account }) => usePendingWithdrawals({ intentsAccountId: account, checkPublishedWithdraw, onNeverExecuted }),
      { initialProps: { account: "" } }
    );
    await act(async () => {});
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "failed" });
    expect(onNeverExecuted).not.toHaveBeenCalled();

    rerender({ account: ACCOUNT });
    await act(async () => {});
    expect(onNeverExecuted).toHaveBeenCalledOnce();
  });

  it("does not check a record that is already settled or resolved", async () => {
    const settled = seedRescueRecord();
    updateWithdrawRecord(settled, { status: "settled", txHash: "NEARTX" });
    const delivered = seedPublishedNear();
    updateWithdrawRecord(delivered, { status: "delivered" });
    const checkPublishedWithdraw = vi.fn();

    renderHook(() =>
      usePendingWithdrawals({
        intentsAccountId: ACCOUNT,
        checkPublishedWithdraw,
        resumeDelivery: vi.fn().mockReturnValue(new Promise(() => {})),
      })
    );
    await act(async () => {});
    expect(checkPublishedWithdraw).not.toHaveBeenCalled();
  });

  it("a conversion that never ran is failed without asking 1Click", async () => {
    seedConversionRecord();
    const checkPublishedWithdraw = vi.fn().mockResolvedValue({ kind: "never-executed" });
    const resumeConversion = vi.fn();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw, resumeConversion })
    );
    await act(async () => {});

    expect(resumeConversion).not.toHaveBeenCalled();
    expect(result.current[0].status).toBe("FAILED");
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "failed" });
  });

  it("a conversion that executed is left to 1Click", async () => {
    seedConversionRecord();
    const checkPublishedWithdraw = vi.fn().mockResolvedValue({ kind: "executed" });
    const resumeConversion = vi.fn().mockResolvedValue({ kind: "delivered", reading: reading("SUCCESS") });

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw, resumeConversion })
    );
    await act(async () => {});

    expect(checkPublishedWithdraw).toHaveBeenCalledOnce();
    expect(resumeConversion).toHaveBeenCalledOnce();
    expect(result.current[0].status).toBe("DELIVERED");
  });

  // Cross-review 023-A: another tab finished the withdrawal while this one was asking the chain.
  it("does not reopen a record another tab resolved during the check", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "published", intentHash: "INTENTHASH" });
    let answer: (v: unknown) => void = () => {};
    const checkPublishedWithdraw = vi.fn().mockReturnValue(new Promise((r) => (answer = r)));

    renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw }));
    await act(async () => {});
    updateWithdrawRecord(id, { status: "delivered", txHash: "NEARTX", destinationTxHash: "0xDEST" });
    await act(async () => answer({ kind: "executed" }));

    expect(listWithdrawRecords()[0]).toMatchObject({ status: "delivered", destinationTxHash: "0xDEST" });
    expect(listWithdrawRecords()[0].error).toBeUndefined();
  });

  it("writes nothing when the page is gone before the check answers", async () => {
    seedPublishedNear();
    const before = listWithdrawRecords()[0];
    let answer: (v: unknown) => void = () => {};
    const checkPublishedWithdraw = vi.fn().mockReturnValue(new Promise((r) => (answer = r)));

    const { unmount } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw })
    );
    await act(async () => {});
    unmount();
    await act(async () => answer({ kind: "never-executed" }));

    expect(listWithdrawRecords()[0]).toEqual(before);
  });

  it("a stored NEAR route the registry disagrees with is not enough to call it delivered", async () => {
    // USDT on Arbitrum is an `omft` withdrawal; a record claiming `near-unwrap` for it is drift.
    const id = seedRescueRecord({ route: "near-unwrap" });
    updateWithdrawRecord(id, { status: "published", intentHash: "INTENTHASH" });
    const checkPublishedWithdraw = vi.fn().mockResolvedValue({ kind: "executed" });

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw })
    );
    await act(async () => {});

    expect(result.current[0].status).toBe("UNCONFIRMED");
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "settled" });
  });

  it("a settled conversion is not checked again", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX" });
    const checkPublishedWithdraw = vi.fn();
    const resumeConversion = vi.fn().mockResolvedValue({ kind: "delivered", reading: reading("SUCCESS") });

    renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw, resumeConversion })
    );
    await act(async () => {});
    expect(checkPublishedWithdraw).not.toHaveBeenCalled();
  });
});

describe("usePendingWithdrawals — «Hide» on a record nothing can close (D-463, 023-B)", () => {
  const T0 = new Date("2026-09-30T14:12:12Z").getTime();
  const unknown = vi.fn(async () => ({ kind: "unknown" as const, reason: "no nonce stored" }));

  beforeEach(() => {
    mockContract._reset();
    clearWithdrawRecords();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.spyOn(console, "log").mockImplementation(() => {});
    unknown.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
    mockContract._reset();
    clearWithdrawRecords();
  });

  /** The tester's record: published before D-463, so no nonce — no re-check can close it. */
  function seedOldPublished() {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "published", intentHash: "31ZbWCWy" });
    return id;
  }

  it("hides the row, closes the record, and a reload does not bring it back", async () => {
    const id = seedOldPublished();
    vi.setSystemTime(T0 + DISMISS_AFTER_MS + 1);
    const usePending = () =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw: unknown });

    const first = renderHook(usePending);
    await act(async () => {});
    expect(first.result.current.map((r) => r.intentId)).toEqual([id]);

    let hidden = false;
    act(() => {
      hidden = dismissWithdrawal(id);
    });
    expect(hidden).toBe(true);
    expect(first.result.current).toEqual([]);
    expect(listUnresolvedWithdrawRecords()).toEqual([]);
    expect(listWithdrawRecords()[0]).toMatchObject({ id, status: "dismissed" });

    // A reload: fresh memory, same storage. Neither hydrated nor re-checked.
    first.unmount();
    mockContract._reset();
    unknown.mockClear();
    const second = renderHook(usePending);
    await act(async () => {});
    expect(second.result.current).toEqual([]);
    expect(unknown).not.toHaveBeenCalled();
  });

  it("refuses before a full day, and the row stays", async () => {
    const id = seedOldPublished();
    vi.setSystemTime(T0 + DISMISS_AFTER_MS - 1);
    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw: unknown })
    );
    await act(async () => {});

    let hidden = true;
    act(() => {
      hidden = dismissWithdrawal(id);
    });
    expect(hidden).toBe(false);
    expect(result.current.map((r) => r.intentId)).toEqual([id]);
    expect(listUnresolvedWithdrawRecords()).toHaveLength(1);
  });

  it("marks a settled record as having left the balance, so the row can say so", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, {
      status: "settled",
      error: "Executed on NEAR (nonce used); settlement tx unknown, delivery not checkable",
    });
    const { result } = renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT }));
    expect(result.current[0]).toMatchObject({ status: "UNCONFIRMED", leftBalance: true });
  });

  it("does not mark a publish whose outcome is unknown", async () => {
    seedOldPublished();
    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, checkPublishedWithdraw: unknown })
    );
    await act(async () => {});
    expect(result.current[0].leftBalance).toBeUndefined();
  });
});

describe("usePendingWithdrawals — the solver's verdict closes a record first (024-D)", () => {
  beforeEach(() => {
    mockContract._reset();
    clearWithdrawRecords();
  });

  afterEach(() => {
    cleanup();
    mockContract._reset();
    clearWithdrawRecords();
  });

  const NEAR_TX = "9xKcXGhT2qWvbnLmRtYpZsAeDfGhJkLmNoPqRsTuVwXy";
  const DEST_TX = "0x5a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";

  // The D-465 case: settled, the relay long gone, the bridge wait would time out into
  // "unconfirmed". The verdict is the one answer that outlives it.
  it("delivered: closes with both hashes, tells the user, and skips the bridge wait", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", error: "Executed on NEAR (nonce used); settlement tx unknown" });
    const readWithdrawVerdicts = vi.fn().mockResolvedValue({
      [id.toLowerCase()]: { verdict: "delivered", txHash: NEAR_TX, destinationTxHash: DEST_TX },
    });
    const resumeDelivery = vi.fn();
    const onDelivered = vi.fn();

    const { result } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, readWithdrawVerdicts, resumeDelivery, onDelivered })
    );
    await act(async () => {});

    expect(readWithdrawVerdicts).toHaveBeenCalledWith([id]);
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "delivered", txHash: NEAR_TX, destinationTxHash: DEST_TX });
    expect(result.current[0]).toMatchObject({ status: "DELIVERED", destinationTxHash: DEST_TX });
    expect(onDelivered).toHaveBeenCalledOnce();
    expect(resumeDelivery).not.toHaveBeenCalled();
  });

  it("never_executed: closes as failed (funds untouched) and skips the publication check", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "published", intentHash: "INTENTHASH" });
    const readWithdrawVerdicts = vi.fn().mockResolvedValue({ [id]: { verdict: "never_executed" } });
    const checkPublishedWithdraw = vi.fn();
    const onNeverExecuted = vi.fn();

    renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, readWithdrawVerdicts, checkPublishedWithdraw, onNeverExecuted })
    );
    await act(async () => {});

    expect(listWithdrawRecords()[0]).toMatchObject({ status: "failed" });
    expect(onNeverExecuted).toHaveBeenCalledOnce();
    expect(checkPublishedWithdraw).not.toHaveBeenCalled();
  });

  // Cross-review 024-D: only 1Click knows what arrived or came back; the verdict has no amount.
  it("a conversion's delivered or refunded is left to the 1Click watch", async () => {
    const id = seedConversionRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX123" });
    const readWithdrawVerdicts = vi.fn().mockResolvedValue({ [id]: { verdict: "refunded" } });
    const resumeConversion = vi.fn(() => new Promise<never>(() => {}));

    renderHook(() =>
      usePendingWithdrawals({
        intentsAccountId: ACCOUNT,
        readWithdrawVerdicts,
        resumeConversion: resumeConversion as never,
      })
    );
    await act(async () => {});

    expect(listWithdrawRecords()[0]).toMatchObject({ status: "settled" });
    expect(resumeConversion).toHaveBeenCalledOnce();
  });

  it("never_executed does not close a record this browser saw settle", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX" });
    const readWithdrawVerdicts = vi.fn().mockResolvedValue({ [id]: { verdict: "never_executed" } });
    const resumeDelivery = vi.fn(() => new Promise<never>(() => {}));
    const onNeverExecuted = vi.fn();

    renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, readWithdrawVerdicts, resumeDelivery, onNeverExecuted })
    );
    await act(async () => {});

    expect(listWithdrawRecords()[0]).toMatchObject({ status: "settled" });
    expect(onNeverExecuted).not.toHaveBeenCalled();
    expect(resumeDelivery).toHaveBeenCalledOnce();
  });

  it("no verdict, or a read that fails: the browser's own re-checks run as before", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX" });
    const resumeDelivery = vi.fn(() => new Promise<never>(() => {}));

    for (const readWithdrawVerdicts of [vi.fn().mockResolvedValue({}), vi.fn().mockRejectedValue(new Error("down"))]) {
      resumeDelivery.mockClear();
      renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT, readWithdrawVerdicts, resumeDelivery }));
      await act(async () => {});
      expect(resumeDelivery).toHaveBeenCalledOnce();
      expect(listWithdrawRecords()[0]).toMatchObject({ status: "settled" });
      cleanup();
    }
  });

  it("never reopens or relabels a record another tab closed meanwhile", async () => {
    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX" });
    let answer: (v: unknown) => void = () => {};
    const readWithdrawVerdicts = vi.fn(() => new Promise((resolve) => (answer = resolve)));

    renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, readWithdrawVerdicts: readWithdrawVerdicts as never })
    );
    // The other tab saw it delivered first.
    updateWithdrawRecord(id, { status: "delivered", destinationTxHash: "0xOTHER" });
    await act(async () => answer({ [id]: { verdict: "never_executed" } }));

    expect(listWithdrawRecords()[0]).toMatchObject({ status: "delivered", destinationTxHash: "0xOTHER" });
  });

  it("asks nothing when no record is open, and starts nothing if the page closes mid-read", async () => {
    const readWithdrawVerdicts = vi.fn().mockResolvedValue({});
    renderHook(() => usePendingWithdrawals({ intentsAccountId: ACCOUNT, readWithdrawVerdicts }));
    await act(async () => {});
    expect(readWithdrawVerdicts).not.toHaveBeenCalled();
    cleanup();

    const id = seedRescueRecord();
    updateWithdrawRecord(id, { status: "settled", txHash: "NEARTX" });
    let answer: (v: unknown) => void = () => {};
    const pending = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const resumeDelivery = vi.fn();
    const { unmount } = renderHook(() =>
      usePendingWithdrawals({ intentsAccountId: ACCOUNT, readWithdrawVerdicts: pending as never, resumeDelivery })
    );
    unmount();
    await act(async () => answer({ [id]: { verdict: "delivered" } }));

    expect(resumeDelivery).not.toHaveBeenCalled();
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "settled" });
  });
});
