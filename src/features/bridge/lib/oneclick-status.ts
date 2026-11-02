// Follows a Converting Withdrawal after its `transfer` settles: reads 1Click's `/v0/status` until
// 1Click says it delivered, refunded or failed — or until we stop watching (D-392, plan 020 §5.4;
// ADR-0024).
//
// Attribution: see ATTRIBUTIONS.md #13 (1Click API v0 `/v0/status`).
//
// 🔴 WHAT AN ANSWER MAY CLOSE. Once the transfer settles the money is in 1Click's deposit account,
// and only 1Click can say where it went next. So the only readings that resolve anything are its
// two final ones — `SUCCESS` (delivered) and `REFUNDED` (back in the General Balance) — and only
// when the answer is provably about OUR quote: `quoteResponse.quote.depositAddress` must repeat
// the address we paid (the spec makes `quoteResponse` required) and, when both sides have one, the
// quote signature must be the one we kept (G7). Anything else — a 404 before 1Click indexes the
// deposit, a 5xx, a shape we do not know, a status outside the seven — is "no answer this round",
// never a conclusion.
//
// `FAILED` ends the watch but resolves nothing: the record stays open and the screen says "not
// confirmed" (plan 020 §5.4). `INCOMPLETE_DEPOSIT` should not happen (the transfer is exactly
// `amountIn`, C1) and is watched like a refund in progress.
//
// WHAT WAS MEASURED (2026-10-06, s225/s226, no key): a quote nobody paid answers `PENDING_DEPOSIT`
// with `quoteResponse` (request echo, quote, signature) and an all-null `swapDetails`, and still
// does after the requested deadline has passed. The other six states are first seen with real
// money in 020-4.

import { ONE_CLICK_BASE_URL } from "./oneclick-base-url";

/** The seven states `/v0/status` documents (`GetExecutionStatusResponse.status`). */
export const ONE_CLICK_STATUSES = [
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;

export type OneClickStatus = (typeof ONE_CLICK_STATUSES)[number];

export type ConversionStatusReading = {
  status: OneClickStatus;
  /** 1Click's own timestamp for the state; `null` when absent. Display and logs only. */
  updatedAt: string | null;
  /** The first destination-chain transaction 1Click reports, once it has one. */
  destinationTxHash: string | null;
  /** Base units of the Delivery Token that actually went out, once settled. */
  amountOutRaw: string | null;
  /** Base units of the held token sent back to `refundTo`. `"0"` until a refund happens. */
  refundedAmountRaw: string | null;
};

export type ConversionStatusRead =
  | { ok: true; reading: ConversionStatusReading }
  /** No usable answer this round. `detail` is for the console and the rescue record. */
  | { ok: false; detail: string };

export type ConversionStatusDeps = {
  /** Injected so no test reaches the network. */
  fetchImpl?: typeof fetch;
};

export type ReadConversionStatusParams = {
  /** The quote's deposit address: the key `/v0/status` is read by, and what the answer must repeat. */
  depositAddress: string;
  /** The quote's signature, as kept in the rescue record. Compared when the answer carries one. */
  quoteSignature?: string;
  signal?: AbortSignal;
  /**
   * How long one read may take before it counts as "no answer this round". Without it a request
   * that never settles would hold the watch past its budget (cross-review 020-4).
   */
  readTimeoutMs?: number;
  deps?: ConversionStatusDeps;
};

/** Default bound on one `/v0/status` read: well above a normal answer, well below the poll cap. */
export const CONVERSION_STATUS_READ_TIMEOUT_MS = 10_000;

const KNOWN = new Set<string>(ONE_CLICK_STATUSES);

function isBaseUnitString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function firstTxHash(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const hash = (item as { hash?: unknown } | null)?.hash;
    if (typeof hash === "string" && hash !== "") return hash;
  }
  return null;
}

/** One read of `/v0/status`. Never throws: every failure is `{ ok: false }`. */
export async function readConversionStatus(
  p: ReadConversionStatusParams
): Promise<ConversionStatusRead> {
  let payload: unknown;
  const timeoutMs = p.readTimeoutMs ?? CONVERSION_STATUS_READ_TIMEOUT_MS;
  // One controller for the request and its body: aborts on the caller's signal or our own bound.
  const controller = new AbortController();
  const forward = () => controller.abort(p.signal?.reason);
  if (p.signal?.aborted) forward();
  else p.signal?.addEventListener("abort", forward);
  const timer = setTimeout(
    () => controller.abort(new Error(`no answer within ${timeoutMs}ms`)),
    timeoutMs
  );
  try {
    const url = `${ONE_CLICK_BASE_URL}/v0/status?depositAddress=${encodeURIComponent(p.depositAddress)}`;
    const res = await (p.deps?.fetchImpl ?? fetch)(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, detail: `1Click status answered ${res.status}` };
    payload = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, detail: `1Click status unreachable (${e instanceof Error ? e.message : String(e)})` };
  } finally {
    clearTimeout(timer);
    p.signal?.removeEventListener("abort", forward);
  }
  // A body that never finished reading was cut by our bound, not answered.
  if (controller.signal.aborted && !p.signal?.aborted) {
    return { ok: false, detail: `1Click status gave no answer within ${timeoutMs}ms` };
  }

  const root = payload as
    | { status?: unknown; updatedAt?: unknown; quoteResponse?: unknown; swapDetails?: unknown }
    | null;
  if (typeof root?.status !== "string" || !KNOWN.has(root.status)) {
    return { ok: false, detail: `unrecognised 1Click status ${JSON.stringify(root?.status)}` };
  }

  // The answer is about our quote, or it is about nothing we may act on.
  const quoteResponse = root.quoteResponse as
    | { quote?: { depositAddress?: unknown }; signature?: unknown }
    | null
    | undefined;
  if (quoteResponse?.quote?.depositAddress !== p.depositAddress) {
    return { ok: false, detail: "status does not repeat our deposit address" };
  }
  if (
    p.quoteSignature !== undefined &&
    typeof quoteResponse?.signature === "string" &&
    quoteResponse.signature !== p.quoteSignature
  ) {
    return { ok: false, detail: "status carries another quote's signature" };
  }

  const details = (root.swapDetails ?? {}) as {
    destinationChainTxHashes?: unknown;
    amountOut?: unknown;
    refundedAmount?: unknown;
  };
  return {
    ok: true,
    reading: {
      status: root.status as OneClickStatus,
      updatedAt: typeof root.updatedAt === "string" ? root.updatedAt : null,
      destinationTxHash: firstTxHash(details.destinationChainTxHashes),
      amountOutRaw: isBaseUnitString(details.amountOut) ? details.amountOut : null,
      refundedAmountRaw: isBaseUnitString(details.refundedAmount) ? details.refundedAmount : null,
    },
  };
}

/**
 * How long a watch lasts: four times 1Click's own estimate, never under 15 minutes. It bounds what
 * we REPORT — 1Click keeps working after it expires, and the open record is re-checked on the next
 * mount. `null` (a resume after a reload, where the estimate is gone) gets the floor.
 */
export const CONVERSION_WATCH_FLOOR_MS = 15 * 60 * 1000;

export function conversionWatchBudgetMs(timeEstimateSecs: number | null): number {
  const estimateMs = timeEstimateSecs !== null && timeEstimateSecs > 0 ? timeEstimateSecs * 4000 : 0;
  return Math.max(CONVERSION_WATCH_FLOOR_MS, estimateMs);
}

/** First poll 2 s after the start, then ×1.5 up to 15 s: quick for NEAR (~10 s), light for Bitcoin. */
export const CONVERSION_POLL_FIRST_MS = 2_000;
export const CONVERSION_POLL_MAX_MS = 15_000;

export type ConversionOutcome =
  /** 1Click says SUCCESS. Resolves the record as delivered. */
  | { kind: "delivered"; reading: ConversionStatusReading }
  /** 1Click says REFUNDED: the money is back in the General Balance. Resolves the record. */
  | { kind: "refunded"; reading: ConversionStatusReading }
  /** 1Click says FAILED. Ends the watch, resolves NOTHING: the record stays open. */
  | { kind: "failed"; reading: ConversionStatusReading }
  /**
   * The watch ended without a final answer — the budget ran out, or the caller aborted. The last
   * reading 1Click gave (if any) and why there is no conclusion. Resolves nothing.
   */
  | { kind: "unanswered"; last: ConversionStatusReading | null; detail: string };

export type WaitForConversionOutcomeParams = ReadConversionStatusParams & {
  /** See `conversionWatchBudgetMs`. */
  timeoutMs: number;
  /** Every reading, final or not — what the record and the console learn as it happens. */
  onReading?: (reading: ConversionStatusReading) => void;
  deps?: ConversionStatusDeps & {
    /** Injectable clock (ms). */
    now?: () => number;
    /** Injectable wait; must settle early when `signal` aborts. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });
}

/**
 * Polls `/v0/status` until a final state, the budget, or the caller's abort. Never throws: the
 * outcome is a value, so every caller has to say what each one means for the record.
 */
export async function waitForConversionOutcome(
  p: WaitForConversionOutcomeParams
): Promise<ConversionOutcome> {
  const now = p.deps?.now ?? Date.now;
  const sleep = p.deps?.sleep ?? defaultSleep;
  const deadline = now() + p.timeoutMs;
  let delay = CONVERSION_POLL_FIRST_MS;
  let last: ConversionStatusReading | null = null;
  let lastDetail = "no answer from 1Click yet";

  for (;;) {
    await sleep(Math.min(delay, Math.max(0, deadline - now())), p.signal);
    if (p.signal?.aborted) return { kind: "unanswered", last, detail: "stopped watching" };

    // Each read is bounded too, so a request that never settles cannot outlive the budget.
    const read = await readConversionStatus({
      ...p,
      readTimeoutMs: Math.min(
        p.readTimeoutMs ?? CONVERSION_STATUS_READ_TIMEOUT_MS,
        Math.max(1, deadline - now())
      ),
    });
    if (read.ok) {
      last = read.reading;
      p.onReading?.(read.reading);
      if (read.reading.status === "SUCCESS") return { kind: "delivered", reading: read.reading };
      if (read.reading.status === "REFUNDED") return { kind: "refunded", reading: read.reading };
      if (read.reading.status === "FAILED") return { kind: "failed", reading: read.reading };
      lastDetail = `1Click still reports ${read.reading.status}`;
    } else {
      lastDetail = read.detail;
    }

    if (p.signal?.aborted) return { kind: "unanswered", last, detail: "stopped watching" };
    if (now() >= deadline) {
      return {
        kind: "unanswered",
        last,
        detail: `no final answer within ${Math.round(p.timeoutMs / 1000)}s (${lastDetail})`,
      };
    }
    delay = Math.min(Math.round(delay * 1.5), CONVERSION_POLL_MAX_MS);
  }
}
