// Warns before the relayer's keys stop working (017-2, D-365 item 5). SERVER ONLY.
//
// Each relay target signs with its own pool of FunctionCall keys (D-246, D-367), and a
// FunctionCall key can only spend its allowance. Sends spread across the pool at random, so the
// keys drain at about the same pace and every one of them is watched. Two numbers matter, both measured on mainnet:
//   - a relayed call burns ~0.001 NEAR of it (s194: ~0.48 NEAR left after ~20 calls per key);
//   - the node refuses a transaction whose WORST-CASE cost exceeds what is left, and 300 Tgas
//     prices at ~0.30 NEAR (D-246: 0.3009). Below that floor every call is refused at
//     validation — the relay answers `send-failed` to everyone, nothing moves, nothing runs.
// So the key is dead at ~0.30 NEAR, not at zero. The warning fires with ~50 calls to spare.
//
// It is a warning, not a gate: the node is the gate. Reading it never blocks or fails a relay.

import type { OpsAlertSink } from "./ops-alerts";
import type { RelayTarget } from "./relay-types";

const YOCTO_PER_NEAR = BigInt("1000000000000000000000000");
const nearToYocto = (near: number) => (BigInt(Math.round(near * 1_000_000)) * YOCTO_PER_NEAR) / BigInt(1_000_000);

/** Below this, calls start being refused (see the header). */
export const RELAY_ALLOWANCE_FLOOR_NEAR = 0.3;
/** Warn from here on: ~50 relayed calls before the floor. */
export const RELAY_ALLOWANCE_WARN_NEAR = 0.35;

/** Remaining allowance of a key in yocto, or null for a FullAccess key (nothing to watch). */
export type ReadAllowance = (publicKey: string) => Promise<bigint | null>;

export type AllowanceWatcher = (target: RelayTarget) => Promise<void>;

/** One read of a target's pool per minute per process: a key moves ~0.001 NEAR per call. */
export const RELAY_ALLOWANCE_READ_EVERY_MS = 60_000;

/** When each target's allowance was last read, by this process. The watcher is built per request. */
const processLastRead = new Map<RelayTarget, number>();

/** Reads `allowance` out of a `view_access_key` answer; null when there is none (FullAccess). */
export function allowanceOf(accessKey: unknown): bigint | null {
  const permission = (accessKey as { permission?: unknown } | null)?.permission;
  if (typeof permission !== "object" || permission === null) return null;
  const allowance = (permission as { FunctionCall?: { allowance?: unknown } }).FunctionCall?.allowance;
  if (typeof allowance === "string" && /^\d+$/.test(allowance)) return BigInt(allowance);
  if (typeof allowance === "bigint") return allowance;
  return null;
}

function formatNear(yocto: bigint): string {
  return (Number((yocto * BigInt(10_000)) / YOCTO_PER_NEAR) / 10_000).toFixed(4);
}

export function createAllowanceWatcher({
  accountId,
  publicKeys,
  readAllowance,
  alerter,
  log = (line) => console.warn(line),
  lastRead = processLastRead,
  now = Date.now,
}: {
  accountId: string;
  publicKeys: Record<RelayTarget, string[]>;
  readAllowance: ReadAllowance;
  alerter: OpsAlertSink;
  log?: (line: string) => void;
  /** Injected in tests; defaults to the process-wide record. */
  lastRead?: Map<RelayTarget, number>;
  now?: () => number;
}): AllowanceWatcher {
  const warnAt = nearToYocto(RELAY_ALLOWANCE_WARN_NEAR);
  const floor = nearToYocto(RELAY_ALLOWANCE_FLOOR_NEAR);
  return async (target) => {
    const t = now();
    const previous = lastRead.get(target);
    if (previous !== undefined && t - previous < RELAY_ALLOWANCE_READ_EVERY_MS) return;
    lastRead.set(target, t);
    await Promise.all(
      publicKeys[target].map(async (publicKey) => {
        try {
          const allowance = await readAllowance(publicKey);
          if (allowance === null || allowance >= warnAt) return;
          const dead = allowance < floor;
          // The alerter throttles per id and never throws (ops-alerts.ts). One id per key: a
          // pool's keys run low together, and each one needs its own replacement.
          await alerter.send({
            id: `relay-allowance-low:${target}:${publicKey}`,
            severity: dead ? "critical" : "warn",
            message:
              `Relayer key for "${target}" (${accountId}, ${publicKey}) has ${formatNear(allowance)} NEAR ` +
              `of allowance left. ` +
              (dead
                ? `Below ${RELAY_ALLOWANCE_FLOOR_NEAR} NEAR it refuses every call it is picked for — replace it with a larger allowance.`
                : `Calls on it start failing below ${RELAY_ALLOWANCE_FLOOR_NEAR} NEAR — top it up (docs/deploy-staging.md).`),
          });
        } catch (e) {
          log(`[relay] could not read the allowance of ${target} key ${publicKey}: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  };
}
