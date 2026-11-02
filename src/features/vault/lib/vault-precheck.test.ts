import { describe, expect, it, vi } from "vitest";
import { runVaultPrecheck, type PrecheckReads } from "./vault-precheck";
import type { AreaPause, PauseState } from "./vault-read-client";

// 017-9b, D-302 a: which reads apply, per gesture, and that every read errs OPEN.

const NOW = 1_800_000_000;
const pause = (until: number | null): AreaPause => ({ until, reason: "incident", since: NOW - 60, actor: "guardian.near" });
const NO_PAUSE: PauseState = { areas: [null, null, null] };

function reads(over: Partial<{ pause: PauseState; reservoir: { deposits_open: boolean; withdrawals_open: boolean }; frozen: string[] }> = {}) {
  const r: PrecheckReads = {
    pauseState: vi.fn(async () => over.pause ?? NO_PAUSE),
    reservoir: vi.fn(async () => over.reservoir ?? { deposits_open: true, withdrawals_open: true }),
    tokenFreeze: vi.fn(async (t: string) => ((over.frozen ?? []).includes(t) ? { reason: "depeg" } : null)),
  };
  return r;
}

describe("runVaultPrecheck — Allocate", () => {
  it("passes when nothing is paused, the deposit cut is open and no token is frozen", async () => {
    expect(await runVaultPrecheck({ kind: "allocate", tokenIds: ["usdc"] }, reads(), NOW)).toBeNull();
  });

  it("blocks on the Allocations pause", async () => {
    const r = reads({ pause: { areas: [pause(null), null, null] } });
    expect(await runVaultPrecheck({ kind: "allocate", tokenIds: ["usdc"] }, r, NOW)).toEqual({ reason: "unavailable" });
  });

  it("ignores the Unallocations pause", async () => {
    const r = reads({ pause: { areas: [null, pause(null), null] } });
    expect(await runVaultPrecheck({ kind: "allocate", tokenIds: ["usdc"] }, r, NOW)).toBeNull();
  });

  it("a pause past its `until` is dead", async () => {
    const r = reads({ pause: { areas: [pause(NOW - 1), null, null] } });
    expect(await runVaultPrecheck({ kind: "allocate", tokenIds: ["usdc"] }, r, NOW)).toBeNull();
    const live = reads({ pause: { areas: [pause(NOW + 60), null, null] } });
    expect(await runVaultPrecheck({ kind: "allocate", tokenIds: ["usdc"] }, live, NOW)).toEqual({ reason: "unavailable" });
  });

  it("blocks when the deposit cut is closed", async () => {
    const r = reads({ reservoir: { deposits_open: false, withdrawals_open: true } });
    expect(await runVaultPrecheck({ kind: "allocate", tokenIds: ["usdc"] }, r, NOW)).toEqual({ reason: "unavailable" });
  });

  it("names the frozen token", async () => {
    const r = reads({ frozen: ["near"] });
    expect(await runVaultPrecheck({ kind: "allocate", tokenIds: ["usdc", "near"] }, r, NOW)).toEqual({
      reason: "token-frozen",
      tokenId: "near",
    });
  });
});

describe("runVaultPrecheck — commit", () => {
  it("with legs: the withdrawal cut, the Unallocations pause and the withdrawn tokens", async () => {
    const op = { kind: "commit" as const, legTokenIds: ["usdc"] };
    expect(await runVaultPrecheck(op, reads({ reservoir: { deposits_open: false, withdrawals_open: true } }), NOW)).toBeNull();
    expect(await runVaultPrecheck(op, reads({ reservoir: { deposits_open: true, withdrawals_open: false } }), NOW)).toEqual({
      reason: "unavailable",
    });
    expect(await runVaultPrecheck(op, reads({ pause: { areas: [null, pause(null), null] } }), NOW)).toEqual({
      reason: "unavailable",
    });
    expect(await runVaultPrecheck(op, reads({ pause: { areas: [pause(null), null, null] } }), NOW)).toBeNull();
    expect(await runVaultPrecheck(op, reads({ frozen: ["usdc"] }), NOW)).toEqual({ reason: "token-frozen", tokenId: "usdc" });
  });

  it("without legs: the deposit cut only — the contract checks no pause there (D.2 step 11)", async () => {
    const op = { kind: "commit" as const, legTokenIds: [] };
    const paused = reads({ pause: { areas: [pause(null), pause(null), null] } });
    expect(await runVaultPrecheck(op, paused, NOW)).toBeNull();
    expect(paused.pauseState).not.toHaveBeenCalled();
    expect(await runVaultPrecheck(op, reads({ reservoir: { deposits_open: false, withdrawals_open: true } }), NOW)).toEqual({
      reason: "unavailable",
    });
  });
});

describe("runVaultPrecheck — errs open", () => {
  it("every read failing lets the user sign", async () => {
    const r: PrecheckReads = {
      pauseState: vi.fn().mockRejectedValue(new Error("rpc down")),
      reservoir: vi.fn().mockRejectedValue(new Error("rpc down")),
      tokenFreeze: vi.fn().mockRejectedValue(new Error("rpc down")),
    };
    expect(await runVaultPrecheck({ kind: "allocate", tokenIds: ["usdc"] }, r, NOW)).toBeNull();
  });

  it("one read failing does not hide another that answered", async () => {
    const r = reads({ frozen: ["usdc"] });
    r.pauseState = vi.fn().mockRejectedValue(new Error("rpc down"));
    expect(await runVaultPrecheck({ kind: "allocate", tokenIds: ["usdc"] }, r, NOW)).toEqual({
      reason: "token-frozen",
      tokenId: "usdc",
    });
  });
});
