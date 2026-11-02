// Browser side of the gas relayer (008.plan, Phase 0): POSTs a signed envelope to /api/relay
// and hands the raw execution outcome back to the caller, shaped exactly like the one a wallet
// returns — so every downstream reader (`findExecutionFailure`, the vault's NEP-297 events, the
// tx-hash extraction) works unchanged whether the send went through the wallet or the relayer.

import type { EnvelopeSubmitter, RelayResponseBody, RelayTarget } from "./relay-types";

const RELAY_ENDPOINT = "/api/relay";

/**
 * Where testers used to paste the relayer's access token (008.plan Escalón 2). The token is gone
 * (017-2, D-365: the signature is the pass), so nothing reads this key; it is only deleted, so a
 * secret that stopped protecting anything does not linger in the browsers that had it.
 */
export const LEGACY_RELAY_TOKEN_KEY = "vault.relayer-token.v1";

/** Removes the old relayer token from this browser. Safe to call on every load. */
export function clearLegacyRelayToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LEGACY_RELAY_TOKEN_KEY);
  } catch {
    // Blocked storage: nothing was readable there either.
  }
}

/**
 * Whether the operator paused the relay (`RELAY_PAUSED`), asked when a confirmation modal opens so
 * the app does not request a signature it cannot send. `false` when the answer is unreadable: this
 * only spares the user a pointless signature — the relay refuses a paused POST on its own.
 */
export async function fetchRelayPaused(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(RELAY_ENDPOINT, { method: "GET", cache: "no-store" });
    const body = (await response.json()) as { paused?: unknown };
    return body.paused === true;
  } catch {
    return false;
  }
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /** Set on `unknown-outcome` when the relayer got as far as signing: the tx to follow. */
    readonly txHash: string | null = null
  ) {
    super(message);
    this.name = "RelayError";
  }
}

/**
 * The relayer's answers that PROVE nothing reached the chain: its own refusals before sending
 * (`relay-service.ts` pause, shape, destination, caps and the envelope gate — `would-fail`,
 * `check-failed`; `api/relay/route.ts` for `not-configured`), `send-failed`, which it only
 * answers when nothing ran — nothing left, or the node refused the tx at validation
 * (relay-sender.ts) — and the two the PLATFORM answers before the function runs: the
 * firewall's rate limit (429) and deny rule (403), read from the status because their body is
 * not ours. An allow-list: `unknown-outcome`, an unreadable answer, a dropped connection and
 * any code added later are ambiguous until someone proves otherwise.
 */
const REFUSED_BEFORE_SENDING: ReadonlySet<string> = new Set([
  "bad-request",
  "destination-mismatch",
  "cap-exceeded",
  "not-configured",
  "paused",
  "would-fail",
  "check-failed",
  "send-failed",
  "rate-limited",
  "blocked",
]);

/**
 * A platform answer from before the function ran, for a body that is not the relay's JSON: the
 * firewall's per-IP rate limit (429) and the operator's instant `deny` brake (403), 017-2 — and
 * nothing was sent. The status alone is not proof (D-370): a proxy in between could let the
 * request through and block the RESPONSE. Vercel's firewall stamps both with
 * `x-vercel-mitigated` (measured on staging, s196: the value is `deny` on the 429 too, so its
 * PRESENCE is the mark) and our function never does. Without it, a 403/429 stays ambiguous.
 */
function platformRefusal(response: Response): "rate-limited" | "blocked" | null {
  if (!response.headers.has("x-vercel-mitigated")) return null;
  if (response.status === 429) return "rate-limited";
  if (response.status === 403) return "blocked";
  return null;
}

/** True only when the relayer proved the envelope never reached the chain. */
export function relayRefusedBeforeSending(e: unknown): boolean {
  return e instanceof RelayError && REFUSED_BEFORE_SENDING.has(e.code);
}

export type SubmitViaRelayParams = {
  target: RelayTarget;
  payload: unknown;
  fetchImpl?: typeof fetch;
};

function isRelayBody(value: unknown): value is RelayResponseBody {
  return typeof value === "object" && value !== null && typeof (value as { ok?: unknown }).ok === "boolean";
}

/** Sends one envelope through the relayer. Resolves with the raw execution outcome. */
export async function submitViaRelay(p: SubmitViaRelayParams): Promise<unknown> {
  const doFetch = p.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(RELAY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: p.target, payload: p.payload }),
    });
  } catch (e) {
    // The request may have reached the relayer before the connection dropped.
    throw new RelayError(
      `Lost the connection to the relayer: ${e instanceof Error ? e.message : String(e)}`,
      "unknown-outcome",
      0
    );
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  // Only the relay's own JSON counts as its answer: a platform page may be JSON too.
  const body = isRelayBody(parsed) ? parsed : null;

  if (!body) {
    const refusal = platformRefusal(response);
    if (refusal) {
      throw new RelayError(`The platform refused the request (HTTP ${response.status})`, refusal, response.status);
    }
    // A function that timed out, a proxy page: nothing says whether the send went out.
    throw new RelayError(
      `The relayer returned an unreadable response (HTTP ${response.status})`,
      "unknown-outcome",
      response.status
    );
  }
  if (body.ok !== true) {
    throw new RelayError(body.error, body.code, response.status, body.txHash ?? null);
  }

  console.log(
    `[relay] submitted via relayer — tx ${body.txHash ?? "unknown"} (${body.gasBurntNear} NEAR) ` +
      `https://nearblocks.io/txns/${body.txHash ?? ""}`
  );
  return body.outcome;
}

/** The relayer as an `EnvelopeSubmitter`. */
export function relaySubmitter(): EnvelopeSubmitter {
  return ({ target, payload }) => submitViaRelay({ target, payload });
}
