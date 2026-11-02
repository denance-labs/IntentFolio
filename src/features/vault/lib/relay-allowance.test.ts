import { describe, expect, it, vi } from "vitest";
import type { OpsAlert } from "./ops-alerts";
import { allowanceOf, createAllowanceWatcher } from "./relay-allowance";

const NEAR = BigInt("1000000000000000000000000");
const near = (n: number) => (BigInt(Math.round(n * 1000)) * NEAR) / BigInt(1000);

function setup(allowance: bigint | null | Error, verifierPool = ["ed25519:V"]) {
  const sent: OpsAlert[] = [];
  const logs: string[] = [];
  const clock = { now: 1_000_000 };
  const readAllowance = vi.fn<(publicKey: string) => Promise<bigint | null>>(async () => {
    if (allowance instanceof Error) throw allowance;
    return allowance;
  });
  const watch = createAllowanceWatcher({
    accountId: "intentfolio-budget.near",
    publicKeys: { verifier: verifierPool, vault: ["ed25519:W"] },
    readAllowance,
    alerter: { send: async (a) => void sent.push(a) },
    log: (l) => logs.push(l),
    lastRead: new Map(),
    now: () => clock.now,
  });
  return { watch, sent, logs, readAllowance, clock };
}

describe("relay allowance watcher", () => {
  it("stays quiet with room to spare", async () => {
    const { watch, sent } = setup(near(0.48));
    await watch("verifier");
    expect(sent).toEqual([]);
  });

  it("warns under 0.35 NEAR, naming the target and the key", async () => {
    const { watch, sent } = setup(near(0.34));
    await watch("vault");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: "relay-allowance-low:vault:ed25519:W", severity: "warn" });
    expect(sent[0].message).toContain("ed25519:W");
    expect(sent[0].message).toContain("0.3400");
  });

  it("goes critical under the 0.30 NEAR floor, where every call is refused", async () => {
    const { watch, sent } = setup(near(0.29));
    await watch("verifier");
    expect(sent[0]).toMatchObject({ id: "relay-allowance-low:verifier:ed25519:V", severity: "critical" });
  });

  it("reads every key of the pool and alerts once per key (D-367)", async () => {
    const { watch, sent, readAllowance } = setup(near(0.34), ["ed25519:V1", "ed25519:V2", "ed25519:V3"]);
    await watch("verifier");
    expect(readAllowance.mock.calls.map(([pk]) => pk)).toEqual(["ed25519:V1", "ed25519:V2", "ed25519:V3"]);
    expect(sent.map((a) => a.id)).toEqual([
      "relay-allowance-low:verifier:ed25519:V1",
      "relay-allowance-low:verifier:ed25519:V2",
      "relay-allowance-low:verifier:ed25519:V3",
    ]);
  });

  it("reads each target at most once a minute", async () => {
    const { watch, readAllowance, clock } = setup(near(0.48));
    await watch("vault");
    await watch("vault");
    await watch("verifier");
    expect(readAllowance).toHaveBeenCalledTimes(2);
    clock.now += 60_000;
    await watch("vault");
    expect(readAllowance).toHaveBeenCalledTimes(3);
  });

  it("ignores a FullAccess key and never throws on a failed read", async () => {
    const full = setup(null);
    await full.watch("vault");
    expect(full.sent).toEqual([]);

    const broken = setup(new Error("timeout"));
    await expect(broken.watch("vault")).resolves.toBeUndefined();
    expect(broken.logs[0]).toContain("timeout");
  });
});

describe("allowanceOf", () => {
  it("reads a FunctionCall allowance, and null for anything else", () => {
    expect(allowanceOf({ permission: { FunctionCall: { allowance: "481465000000000000000000", receiver_id: "x", method_names: [] } } })).toBe(
      BigInt("481465000000000000000000")
    );
    expect(allowanceOf({ permission: "FullAccess" })).toBeNull();
    expect(allowanceOf({ permission: { FunctionCall: { allowance: null } } })).toBeNull();
    expect(allowanceOf(null)).toBeNull();
  });
});
