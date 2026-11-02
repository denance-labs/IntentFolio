"use client";

// Browser side of the withdrawal tracking record ingest (ADR-0025).
//
// ONE rule, unlike the Allocate client's three: nothing here throws and nothing waits on it.
// The record is best-effort (ADR-0025 §2) — a withdrawal never stops because the database is
// down — so every call resolves to a result the caller may ignore.
//
// `keepalive: true` is the point of this file. The case ADR-0025 exists for is a tab that
// closes between the publish and the settlement; a plain fetch dies with the page, a
// keepalive one is finished by the browser. Its cost is a 64 KiB budget shared by all
// keepalive requests in flight; a record is ~1 KB.

import {
  WITHDRAW_RECORDS_ENDPOINT,
  type CreateWithdrawRecordBody,
  type PatchWithdrawRecordBody,
  type WithdrawRecordErrorCode,
  type WithdrawRecordResponseBody,
} from "./withdraw-records-types";

/**
 * How long a write may take. Generous on purpose: nobody waits on it, and it only bounds how
 * long a queued PATCH stays behind a hung POST (`withdraw-record-sink.ts`).
 */
export const WITHDRAW_RECORD_TIMEOUT_MS = 10_000;

export type WithdrawRecordSendResult =
  | { ok: true }
  | { ok: false; code: WithdrawRecordErrorCode | "network"; message: string };

type SendOptions = { fetchImpl?: typeof fetch; timeoutMs?: number };

export async function sendWithdrawRecord(
  method: "POST" | "PATCH",
  body: CreateWithdrawRecordBody | PatchWithdrawRecordBody,
  options: SendOptions = {}
): Promise<WithdrawRecordSendResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? WITHDRAW_RECORD_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(WITHDRAW_RECORDS_ENDPOINT, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
      signal: controller.signal,
    });
    let parsed: WithdrawRecordResponseBody | null = null;
    try {
      parsed = (await response.json()) as WithdrawRecordResponseBody;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      return { ok: false, code: "write-failed", message: `Unreadable response (HTTP ${response.status})` };
    }
    if (parsed.ok !== true) return { ok: false, code: parsed.code, message: parsed.error };
    return { ok: true };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      code: "network",
      message: aborted ? `No answer within ${timeoutMs}ms` : e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}
