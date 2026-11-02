// Server-side core of the gas relayer (008.plan, Phase 0). SERVER ONLY — never import this
// from a component: it reads the relayer's private key out of the environment.
//
// The route handler (`src/app/api/relay/route.ts`) is a thin shell around this module so the
// pause, the destination guard, the spend cap and the order of the checks are unit-testable
// without a network, a key or a running server. Injected: the sender, the gate that decides
// whether the envelope is worth the gas (relay-gate.ts), and the allowance watcher.
//
// No access token since 017-2 (D-365): a secret every tester's browser holds is a public one,
// and the public cannot be asked to paste it. What gates the gas now is the envelope itself.
//
// ⚠️ SECRETS: the two `RELAYER_*_PRIVATE_KEY` values must NEVER get a `NEXT_PUBLIC_` prefix. Next
// inlines those variables into the browser bundle, which would publish the keys to every
// visitor. The repo already uses that prefix for the feature flag two files over, so the
// mistake is one autocomplete away — hence this comment and the matching one in `.env.example`.

import type { AllowanceWatcher } from "./relay-allowance";
import type { RelayGate, RelayGateVerdict } from "./relay-gate";
import {
  RELAY_DESTINATIONS,
  RELAY_GAS,
  extractEnvelopeRecipient,
  isRelayTarget,
  type RelayErrorCode,
  type RelayResponseBody,
  type RelayTarget,
} from "./relay-types";

/**
 * Sends one function call from the relayer account and resolves with the raw outcome.
 *
 * Its throws are a contract: `RelayOutcomeUnknownError` when the transaction may have run, any
 * other error only when it provably did not (see relay-sender.ts).
 */
export type RelaySender = (input: {
  target: RelayTarget;
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: string;
}) => Promise<unknown>;

/** The send went out and nothing proves how it ended. Carries the hash, known before sending. */
export class RelayOutcomeUnknownError extends Error {
  constructor(
    message: string,
    readonly txHash: string
  ) {
    super(message);
    this.name = "RelayOutcomeUnknownError";
  }
}

export type RelayConfig = {
  accountId: string;
  /**
   * The key pool of each target (D-367): every key has its own nonce, so two requests at once
   * rarely share one. The env value is a comma-separated list; a single key is a pool of one.
   */
  privateKeys: Record<RelayTarget, string[]>;
  /**
   * `RELAY_PAUSED=true`: the operator's switch that stops the relay for everyone (017-2). Read
   * per deployment — Vercel fixes a deployment's variables, so flipping it takes a redeploy.
   */
  paused: boolean;
  maxRequests: number;
  maxSpendNear: number;
};

/**
 * Cumulative spend of THIS server process.
 *
 * Deliberately in-memory and deliberately documented as such: it resets on every restart and
 * is not shared across instances, so it is a brake against a runaway loop, not a budget. The
 * on-chain bound is structural and lives outside the process: each target has its own
 * FunctionCall keys, each with a 0.50 NEAR initial allowance. A restart cannot reset those.
 */
export type RelayLedger = { requests: number; yoctoBurnt: bigint };

export function createRelayLedger(): RelayLedger {
  return { requests: 0, yoctoBurnt: BigInt(0) };
}

const processLedger = createRelayLedger();

/**
 * The signed operations this process already sent, so each goes out at most once (017-2,
 * cross-review). A landed envelope is public, and the Verifier's simulation cannot see a copy
 * that is still in flight: without this, N concurrent POSTs of one Allocate all pass the checks
 * and N-1 revert on the relayer's gas. The app never re-posts a signed envelope (017-1: one POST
 * per signature), so a repeat is never the owner's retry.
 *
 * In-memory and per process, like the ledger: it stops a repeat on this instance, not across
 * instances. What stops a LANDED replay everywhere is the chain read in the gate (the Verifier's
 * simulation, the vault's nonce word). Entries expire after RELAY_SENT_TTL_MS — past the app's
 * 10-minute envelope deadline, so a remembered envelope could not land anyway.
 */
export type RelaySentRegistry = Map<string, number>;

export function createRelaySentRegistry(): RelaySentRegistry {
  return new Map();
}

const processSent = createRelaySentRegistry();

export const RELAY_SENT_TTL_MS = 15 * 60_000;
const RELAY_SENT_MAX = 10_000;

/** Records `key` unless it is already there and fresh. `false` means it was sent before. */
function recordSend(sent: RelaySentRegistry, key: string, nowMs: number): boolean {
  const expiresAt = sent.get(key);
  if (expiresAt !== undefined && expiresAt > nowMs) return false;
  if (sent.size >= RELAY_SENT_MAX) {
    for (const [k, at] of sent) if (at <= nowMs) sent.delete(k);
  }
  sent.set(key, nowMs + RELAY_SENT_TTL_MS);
  return true;
}

const DEFAULT_MAX_REQUESTS = 300;
const DEFAULT_MAX_SPEND_NEAR = 0.5;

export type RelayConfigResult =
  | { ok: true; config: RelayConfig }
  | { ok: false; issues: string[] };

export function readRelayConfig(
  env: Record<string, string | undefined> = process.env
): RelayConfigResult {
  const accountId = env.RELAYER_ACCOUNT_ID?.trim();
  const verifierPrivateKeys = keyList(env.RELAYER_VERIFIER_PRIVATE_KEY);
  const vaultPrivateKeys = keyList(env.RELAYER_VAULT_PRIVATE_KEY);
  const issues: string[] = [];
  if (!accountId) issues.push("missing RELAYER_ACCOUNT_ID");
  if (verifierPrivateKeys.length === 0) issues.push("missing RELAYER_VERIFIER_PRIVATE_KEY");
  if (vaultPrivateKeys.length === 0) issues.push("missing RELAYER_VAULT_PRIVATE_KEY");
  if (!accountId || verifierPrivateKeys.length === 0 || vaultPrivateKeys.length === 0) return { ok: false, issues };
  // A key listed twice shares its nonce with itself: the pool would collide as if it were smaller.
  if (verifierPrivateKeys.some((key) => vaultPrivateKeys.includes(key))) {
    return { ok: false, issues: ["the verifier and vault private keys must be different"] };
  }
  for (const [name, keys] of [
    ["RELAYER_VERIFIER_PRIVATE_KEY", verifierPrivateKeys],
    ["RELAYER_VAULT_PRIVATE_KEY", vaultPrivateKeys],
  ] as const) {
    if (new Set(keys).size !== keys.length) issues.push(`${name} lists the same key twice`);
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    config: {
      accountId,
      privateKeys: {
        verifier: verifierPrivateKeys,
        vault: vaultPrivateKeys,
      },
      paused: readRelayPaused(env),
      maxRequests: positiveNumber(env.RELAYER_MAX_REQUESTS, DEFAULT_MAX_REQUESTS),
      maxSpendNear: positiveNumber(env.RELAYER_MAX_NEAR_SPEND, DEFAULT_MAX_SPEND_NEAR),
    },
  };
}

/** A comma-separated key list; blanks between commas are dropped, not read as keys. */
function keyList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Only the literal `true` pauses: a typo must not stop the relay, and nothing else should. */
export function readRelayPaused(env: Record<string, string | undefined> = process.env): boolean {
  return env.RELAY_PAUSED?.trim().toLowerCase() === "true";
}

/** Yocto burnt by a transaction: its own receipt plus every receipt it fanned out into. */
export function sumTokensBurnt(outcome: unknown): bigint {
  const o = (outcome ?? {}) as {
    transaction_outcome?: { outcome?: { tokens_burnt?: unknown } };
    receipts_outcome?: Array<{ outcome?: { tokens_burnt?: unknown } }>;
  };
  let total = toYocto(o.transaction_outcome?.outcome?.tokens_burnt);
  for (const receipt of o.receipts_outcome ?? []) {
    total += toYocto(receipt?.outcome?.tokens_burnt);
  }
  return total;
}

function toYocto(value: unknown): bigint {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  return BigInt(0);
}

const YOCTO_PER_NEAR = BigInt("1000000000000000000000000");

/**
 * Yocto as a NEAR decimal string, six places — enough to read a ~0.001 NEAR gas cost.
 *
 * Hand-rolled rather than pulled from near-api-js on purpose: it keeps this module free of the
 * SDK, so the gate / guard / cap logic tests as plain functions with no transport in scope.
 */
export function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = ((yocto % YOCTO_PER_NEAR) * BigInt(1_000_000)) / YOCTO_PER_NEAR;
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

/** Lossy on purpose: only ever compared against a cap expressed in whole-ish NEAR. */
function nearAsNumber(yocto: bigint): number {
  return Number(yocto) / 1e24;
}

function txHashOf(outcome: unknown): string | null {
  const o = outcome as
    | { transaction_outcome?: { id?: string }; transaction?: { hash?: string } }
    | null
    | undefined;
  return o?.transaction_outcome?.id ?? o?.transaction?.hash ?? null;
}

/** Best-effort attribution for the per-request log: which scheme signed, and as whom. */
export function describeEnvelopeSigner(payload: unknown): { standard: string; signerId: string } {
  const envelope = (payload ?? {}) as { standard?: unknown; payload?: unknown };
  const standard = typeof envelope.standard === "string" ? envelope.standard : "unknown";

  const inner = envelope.payload;
  const raw =
    typeof inner === "string"
      ? inner
      : inner && typeof inner === "object" && typeof (inner as { message?: unknown }).message === "string"
        ? (inner as { message: string }).message
        : null;
  if (raw === null) return { standard, signerId: "unknown" };
  try {
    const parsed = JSON.parse(raw) as { signer_id?: unknown };
    return {
      standard,
      signerId: typeof parsed.signer_id === "string" ? parsed.signer_id : "unknown",
    };
  } catch {
    return { standard, signerId: "unknown" };
  }
}

export type HandleRelayInput = {
  body: unknown;
  config: RelayConfig;
  sender: RelaySender;
  /** Whether this envelope is worth the gas (relay-gate.ts). */
  gate: RelayGate;
  /** Reads the target key's allowance and alerts when it runs low. Never throws. */
  watchAllowance?: AllowanceWatcher;
  /** Override RELAY_CHECK_BUDGET_MS / RELAY_ALLOWANCE_WATCH_BUDGET_MS; tests only. */
  checkBudgetMs?: number;
  watchBudgetMs?: number;
  /** Defaults to the process-wide ledger; injected in tests. */
  ledger?: RelayLedger;
  /** Defaults to the process-wide registry of sent operations; injected in tests. */
  sent?: RelaySentRegistry;
  now?: () => number;
  log?: (message: string) => void;
};

export type HandleRelayOutput = { status: number; body: RelayResponseBody };

export async function handleRelayRequest(input: HandleRelayInput): Promise<HandleRelayOutput> {
  const { config } = input;
  const ledger = input.ledger ?? processLedger;
  const log = input.log ?? ((m: string) => console.log(m));

  // ── Pause ──────────────────────────────────────────────────────────────────
  // First, so a paused relay costs no RPC and reads nothing. The app asks GET /api/relay before
  // it asks for a signature; this is the backstop for a pause that lands in between.
  if (config.paused) {
    return fail(503, "paused", "The relayer is paused by the operator (RELAY_PAUSED)");
  }

  // ── Request shape ──────────────────────────────────────────────────────────
  if (!input.body || typeof input.body !== "object") {
    return fail(400, "bad-request", "Body must be a JSON object");
  }
  const { target, payload } = input.body as { target?: unknown; payload?: unknown };
  if (!isRelayTarget(target)) {
    return fail(400, "bad-request", `target must be "verifier" or "vault"`);
  }
  if (!payload || typeof payload !== "object") {
    return fail(400, "bad-request", "payload must be the signed MultiPayload object");
  }

  const destination = RELAY_DESTINATIONS[target];

  // ── Destination guard (see extractEnvelopeRecipient) ───────────────────────
  const recipient = extractEnvelopeRecipient(payload);
  if (recipient !== null && recipient !== destination.receiverId) {
    return fail(
      400,
      "destination-mismatch",
      `Envelope was signed for ${recipient}, but target "${target}" submits to ${destination.receiverId}`
    );
  }

  // ── Spend cap ──────────────────────────────────────────────────────────────
  if (ledger.requests >= config.maxRequests) {
    return fail(
      429,
      "cap-exceeded",
      `Relayer request cap reached (${config.maxRequests}). Restart the server or raise RELAYER_MAX_REQUESTS.`
    );
  }
  const spentNear = nearAsNumber(ledger.yoctoBurnt);
  if (spentNear >= config.maxSpendNear) {
    return fail(
      429,
      "cap-exceeded",
      `Relayer spend cap reached (${spentNear.toFixed(6)} / ${config.maxSpendNear} NEAR). Raise RELAYER_MAX_NEAR_SPEND.`
    );
  }

  // ── Worth the gas? ─────────────────────────────────────────────────────────
  const who = describeEnvelopeSigner(payload);
  // Started now, awaited last: the allowance read overlaps the checks and the send instead of
  // adding to them, and a key running low is worth knowing even when this request is refused.
  // Bounded, so a node that never answers it cannot hold the response back.
  // The watcher never rejects by contract; the catch keeps a broken one from turning an answer
  // that carries a tx hash into a 500.
  const watching = (input.watchAllowance?.(target) ?? Promise.resolve()).catch(() => {});
  try {
    return await checkAndSend({ input, target, payload, destination, ledger, log, who });
  } finally {
    await settleWithin(watching, input.watchBudgetMs ?? RELAY_ALLOWANCE_WATCH_BUDGET_MS, undefined);
  }
}

/**
 * Budget for the envelope checks. They are reads (~0.1-1 s when the nodes are healthy), but the
 * last upstream has no per-read cut-off (relay-rpc-provider.ts), so without one a hung node would
 * hold the request until the platform kills it — and an unreadable 504 is exactly what the client
 * must read as "maybe sent". Past the budget nothing was sent: `check-failed`, safe to sign again.
 */
export const RELAY_CHECK_BUDGET_MS = 10_000;
/** How long the allowance read may still run after the answer is ready. */
export const RELAY_ALLOWANCE_WATCH_BUDGET_MS = 2_000;

/** `promise`, or `fallback` once `ms` pass. Never rejects when `promise` never rejects. */
function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkAndSend({
  input,
  target,
  payload,
  destination,
  ledger,
  log,
  who,
}: {
  input: HandleRelayInput;
  target: RelayTarget;
  payload: unknown;
  destination: (typeof RELAY_DESTINATIONS)[RelayTarget];
  ledger: RelayLedger;
  log: (message: string) => void;
  who: { standard: string; signerId: string };
}): Promise<HandleRelayOutput> {
  const verdict: RelayGateVerdict = await settleWithin(
    input.gate({ target, payload }).catch(
      (e: unknown): RelayGateVerdict => ({
        ok: false,
        code: "check-failed",
        reason: e instanceof Error ? e.message : String(e),
      })
    ),
    input.checkBudgetMs ?? RELAY_CHECK_BUDGET_MS,
    { ok: false, code: "check-failed", reason: `the checks had no answer within ${input.checkBudgetMs ?? RELAY_CHECK_BUDGET_MS}ms` }
  );
  if (!verdict.ok) {
    // JSON-encoded: the reason can quote envelope fields, and a newline in one must not forge a line.
    log(`[relay] REFUSED ${target} ${verdict.code}: ${JSON.stringify({ ...who, reason: verdict.reason })}`);
    return fail(verdict.code === "would-fail" ? 422 : 503, verdict.code, verdict.reason);
  }
  // Checked and recorded in one synchronous step, after the checks' await: two concurrent copies
  // cannot both get past it.
  if (!recordSend(input.sent ?? processSent, `${target}:${verdict.replayKey}`, (input.now ?? Date.now)())) {
    log(`[relay] REFUSED ${target} would-fail: ${JSON.stringify({ ...who, reason: "sent before" })}`);
    return fail(422, "would-fail", "this signed operation was already sent");
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  let outcome: unknown;
  try {
    outcome = await input.sender({
      target,
      receiverId: destination.receiverId,
      methodName: destination.methodName,
      args: destination.buildArgs(payload),
      gas: RELAY_GAS,
    });
  } catch (e) {
    // The request is counted even on a throw: a send that failed may still have landed, and
    // an uncounted failure is a free retry loop against the gas account.
    ledger.requests += 1;
    const error = e instanceof Error ? e.message : String(e);
    if (e instanceof RelayOutcomeUnknownError) {
      // Not a failure, and it must not read as one downstream: the client shows "not confirmed
      // yet" and waits for the chain (D-329, D-330). The hash is what the operator follows.
      log(
        `[relay] UNKNOWN OUTCOME ${target} signer=${who.signerId} scheme=${who.standard} ` +
          `tx=${e.txHash}: ${error} — https://nearblocks.io/txns/${e.txHash}`
      );
      return {
        status: 504,
        body: { ok: false, code: "unknown-outcome", error, txHash: e.txHash },
      };
    }
    // Anything else proves nothing ran (the sender's contract).
    log(`[relay] FAILED ${target} signer=${who.signerId} scheme=${who.standard}: ${error}`);
    return fail(502, "send-failed", error);
  }

  const burnt = sumTokensBurnt(outcome);
  ledger.requests += 1;
  ledger.yoctoBurnt += burnt;

  const txHash = txHashOf(outcome);
  const gasBurntNear = formatNear(burnt);
  log(
    `[relay] ${target} signer=${who.signerId} scheme=${who.standard} ` +
      `tx=${txHash ?? "none"} gas=${gasBurntNear} NEAR ` +
      `total=${formatNear(ledger.yoctoBurnt)} NEAR over ${ledger.requests} req ` +
      `— https://nearblocks.io/txns/${txHash ?? ""}`
  );

  // A REVERTED transaction is still a 200 here: the outcome is the answer, and the callers
  // already know how to read a failure (and a defer) out of it. Turning it into an HTTP error
  // would throw away the tx hash and the events — the two things a wet test needs most.
  return { status: 200, body: { ok: true, txHash, outcome, gasBurntNear } };
}

function fail(status: number, code: RelayErrorCode, error: string): HandleRelayOutput {
  return { status, body: { ok: false, code, error } };
}
