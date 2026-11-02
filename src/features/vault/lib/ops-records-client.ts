"use client";

// Browser side of the Allocate rescue record ingest (ADR-0017 §3, P-OPS v1 point 3).
//
// THREE calls with deliberately different failure rules, and the difference is not a style
// choice — it is which of them can still stop funds from moving:
//   - `postAllocateRecord` is FAIL-CLOSED. If it does not succeed, the caller must not ask the
//     wallet to sign: a submitted Allocate whose raw `msg` nobody kept is a potentially
//     unrecoverable orphan (ADR-0017 §4).
//   - `patchSignedEnvelope` is FAIL-CLOSED TOO (ADR-0017 §5 as amended 2026-08-18, D-289). It
//     runs after the signature but BEFORE the envelope is submitted, which is the last instant
//     at which "fail-closed" still means anything: nothing has moved yet, so aborting costs a
//     wasted signature instead of leaving stranded funds nobody can attribute.
//   - `patchAllocateRecord` is best-effort and never throws. A lost status update is
//     recoverable; a lost pre-image, and now a lost envelope, are not.
//     (`patchAllocateRecordResult` is the same call keeping the failure code, for the one
//     caller that has to act differently on `not-found`.)
//
// ⚠️ THE POST RUNS INSIDE THE BROWSER'S USER-ACTIVATION WINDOW. See OPS_WRITE_BUDGET_MS.

import {
  OPS_RECORDS_ENDPOINT,
  type CreateAllocateRecordBody,
  type OpsRecordErrorCode,
  type OpsRecordResponseBody,
  type PatchAllocateRecordBody,
} from "./ops-records-types";

/**
 * How long the pre-signature write may take before it gives up.
 *
 * ADR-0017 §4 specifies "~5s timeout, 2 retries". That number cannot be spent HERE, and the
 * reason is a constraint the ADR does not model: this write sits on the click that has to
 * reach a wallet prompt, and browsers only open one inside the user-activation window that
 * the click created (~5s in Blink). The Allocate click already spends ~0.6s on two NEAR view
 * calls (`snapshotPortfolios`, `getCurrentSalt`); a 5s write with two retries is up to 15s,
 * which would not slow the prompt down — it would silently EAT it, which is a bug this repo
 * has already shipped once (see `network.ts` and `FEE_RECHECK_BUDGET_MS` in the withdrawal
 * modal, both written after that incident).
 *
 * So the retries are not removed, they are moved: ONE attempt inside the window, and a
 * failure throws instead of retrying. The Allocate aborts before signing — fail-closed, as
 * specified — the modal keeps the user's inputs, and the retry is the user clicking again,
 * which is what a FRESH user gesture requires anyway (the same reasoning as
 * `near-key-verification.ts`). Three human-paced attempts, not three silent ones.
 *
 * 1200ms is the budget the withdrawal path already measured for in-click network work.
 */
export const OPS_WRITE_BUDGET_MS = 1_200;

/** The PATCHes run after the prompt, off the activation window, so they can afford more. */
export const OPS_PATCH_BUDGET_MS = 5_000;

/**
 * Attempts the envelope write gets before it gives up and aborts the Allocate.
 *
 * ADR-0017 §4 specifies "~5s timeout, 2 retries" and `postAllocateRecord` above cannot honour
 * the retries — it sits inside the browser's user-activation window, where 15s of retrying
 * would eat the wallet prompt. THIS write has no such constraint: the prompt has already
 * resolved, and the only clock left is the envelope's own 600s submission deadline, against
 * which ~16s worst case is nothing. So the ADR's number is spent here, where it fits.
 *
 * It is worth spending: failing this write costs the user a signature they already approved,
 * so a single transient blip must not be what does that.
 */
export const OPS_ENVELOPE_ATTEMPTS = 3;
const OPS_ENVELOPE_RETRY_DELAY_MS = 300;

export class OpsRecordError extends Error {
  constructor(
    message: string,
    readonly code: OpsRecordErrorCode | "network",
    readonly status: number
  ) {
    super(message);
    this.name = "OpsRecordError";
  }
}

type RequestOptions = { timeoutMs?: number; fetchImpl?: typeof fetch };

async function send(
  method: "POST" | "PATCH",
  body: unknown,
  options: RequestOptions
): Promise<OpsRecordResponseBody & { ok: true }> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? OPS_WRITE_BUDGET_MS;
  // AbortController and not Promise.race: a race leaves the request in flight, and an
  // abandoned write that lands anyway would make the next retry look like a duplicate.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await doFetch(OPS_RECORDS_ENDPOINT, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new OpsRecordError(
      aborted
        ? `Storing the rescue record timed out after ${timeoutMs}ms`
        : `Could not reach the rescue-record store: ${e instanceof Error ? e.message : String(e)}`,
      "network",
      0
    );
  } finally {
    clearTimeout(timer);
  }

  let parsed: OpsRecordResponseBody | null = null;
  try {
    parsed = (await response.json()) as OpsRecordResponseBody;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    throw new OpsRecordError(
      `The rescue-record store returned an unreadable response (HTTP ${response.status})`,
      "write-failed",
      response.status
    );
  }
  if (parsed.ok !== true) {
    throw new OpsRecordError(parsed.error, parsed.code, response.status);
  }
  return parsed;
}

/**
 * Inserts the record. THROWS on any failure — the caller aborts the Allocate instead of
 * signing. Idempotent: the id is the primary key, so a retry after a lost response is a no-op
 * and comes back with `created: false`.
 */
export async function postAllocateRecord(
  body: CreateAllocateRecordBody,
  options: RequestOptions = {}
): Promise<{ created: boolean }> {
  const result = await send("POST", body, options);
  return { created: result.created === true };
}

export type PatchAllocateRecordResult =
  | { ok: true }
  | { ok: false; code: OpsRecordErrorCode | "network"; message: string };

/**
 * Updates the lifecycle columns and says WHY when it could not. NEVER throws.
 *
 * Same call as `patchAllocateRecord`, with the failure code kept instead of swallowed: the
 * `suspected_orphan → credited` flip on app load (009.plan FE #4) has to tell a `not-found`
 * — a record from before the database existed, nothing to fix off-client — from every other
 * failure, which it must leave for the next load to retry.
 */
export async function patchAllocateRecordResult(
  patch: PatchAllocateRecordBody,
  options: RequestOptions = {}
): Promise<PatchAllocateRecordResult> {
  try {
    await send("PATCH", patch, { timeoutMs: OPS_PATCH_BUDGET_MS, ...options });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: e instanceof OpsRecordError ? e.code : "network",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Updates the lifecycle columns. NEVER throws: it runs on paths that are already reporting
 * something else (a rejected signature, a revert, an observed credit) and an exception here
 * would replace a real message with a storage one.
 */
export async function patchAllocateRecord(
  patch: PatchAllocateRecordBody,
  options: RequestOptions = {}
): Promise<boolean> {
  const result = await patchAllocateRecordResult(patch, options);
  if (!result.ok) {
    // Second channel, same reasoning as the store's console.log: a session with devtools open
    // keeps a trace of what the database did not get.
    console.warn(
      `[ops] rescue-record patch failed for ${patch.id} — the record keeps its previous status`,
      result.message
    );
  }
  return result.ok;
}

/**
 * Which failures are worth another attempt.
 *
 * A `bad-request` will be malformed again next time, a `not-found` means the row the POST
 * confirmed is not there (alarming, but not something a retry fixes), a `conflict` means the
 * row already holds a DIFFERENT envelope (a resend of the same one succeeds), and `not-configured`
 * is a property of the deployment. Retrying those would only make the user wait ~16s before
 * an abort that was decided on the first response.
 */
function isTransient(e: unknown): boolean {
  if (!(e instanceof OpsRecordError)) return false;
  return e.code === "network" || e.code === "write-failed" || e.code === "too-many-requests";
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Stores the signed envelope. THROWS on failure — the caller must abort BEFORE submitting.
 *
 * This is the write D-289 exists about. `NEXT.md` carried the pre-amendment version of
 * ADR-0017 §5, in which this was best-effort; the amended §5 makes it load-bearing, because
 * the solver's rescue tool refuses to sign a credit without an envelope (`rescue-verifier.ts`
 * reports `signature: 'absent'` and blocks). Best-effort would mean shipping the exact gap the
 * decision exists to close, only one step later than the one §4 closed.
 *
 * Placing it between the signature and the submit is the whole point, and it is not
 * interchangeable with "after the submit, but retried harder": after the submit the funds may
 * already be in the vault, and there is nothing left to fail closed on. Here there is.
 */
export async function patchSignedEnvelope(
  id: string,
  signedEnvelope: unknown,
  options: RequestOptions & { attempts?: number } = {}
): Promise<void> {
  const attempts = options.attempts ?? OPS_ENVELOPE_ATTEMPTS;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await send("PATCH", { id, signedEnvelope }, { timeoutMs: OPS_PATCH_BUDGET_MS, ...options });
      return;
    } catch (e) {
      last = e;
      if (!isTransient(e) || attempt === attempts) break;
      await wait(OPS_ENVELOPE_RETRY_DELAY_MS);
    }
  }
  throw last instanceof Error
    ? last
    : new OpsRecordError(String(last), "write-failed", 0);
}
