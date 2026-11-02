// One FastNEAR transaction → the rows the history recorder writes (plan 028-2, D-492). Pure: no
// I/O. The table contract is the header of `intentfolio-solver/db/migrations/008_history.sql`;
// the trust rules are those of the browser's rebalance reader (D-493, retired in 028-3),
// generalised to every event:
//   - only receipts EXECUTED BY THE VAULT count: a log line carries no author, and any contract
//     can print an `intentfolio-vault` envelope;
//   - only SUCCESSFUL receipts: a receipt that panics keeps the logs it wrote before panicking,
//     while its state changes roll back.
//
// Two kinds of surprise, handled in opposite ways on purpose:
//   - What the CONTRACT writes (event names, versions, amounts, portfolio ids) is ours. A shape
//     this file does not expect means it is out of date, so it throws, and the recorder holds
//     the transaction back — visibly — instead of storing a guess.
//   - What a USER writes (a portfolio's name, a call's arguments) is arbitrary. It must never be
//     able to stop the recorder for everyone, so it is made storable (`sanitizeJsonText`) or,
//     for the optional call arguments, dropped with a reason.
//
// Attribution: see ATTRIBUTIONS.md #8 (IntentFolio vault contract events) and #21 (FastNEAR).

import type { FastNearReceipt, FastNearTx } from "@/features/vault/lib/vault-history-client";

const LOG_PREFIX = "EVENT_JSON:";
export const EVENT_STANDARD = "intentfolio-vault";

/** The event shapes this file knows (contract `events.rs`, `EVENT_VERSION` 2.0.0). */
const KNOWN_MAJOR = "2";

/**
 * The calls whose arguments are kept (decision 9, D-489): an edit's signed change set and a
 * creation's whole composition travel in the call, not in the events. Every other vault call
 * either says everything in its events or is the solver's (`reconcile_balances`, the bulk of
 * the traffic).
 */
export const KEPT_CALL_METHODS: ReadonlySet<string> = new Set(["commit_portfolio_changes", "on_auth"]);

const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);

/** A transaction the vault shows up in, as `vault_tx` keeps it. */
export type TxRow = { txHash: string; blockHeight: number; blockTsMs: number };

export type CallRow = {
  receiptId: string;
  actionIndex: number;
  blockHeight: number;
  blockTsMs: number;
  method: string;
  /** The decoded argument text, made storable; never re-serialised (u64 > 2^53). */
  argsText: string;
};

export type PortfolioRow = {
  ord: number;
  portfolioId: string;
  /** Minimal units, decimal strings; `null` when the row moves nothing (see the 008 header). */
  qtyIn: string | null;
  qtyOut: string | null;
  spread: string | null;
  /** For a rebalance row: the token its swap and spread are counted in (`token_out`). */
  swapToken: string | null;
};

export type EventRow = {
  receiptId: string;
  logIndex: number;
  blockHeight: number;
  blockTsMs: number;
  event: string;
  version: string;
  accountId: string | null;
  /** The line after `EVENT_JSON:`, made storable; never re-serialised. */
  rawText: string;
  portfolios: PortfolioRow[];
  /** Set on `portfolio_created`: the portfolio → account map. */
  owner: { portfolioId: string; accountId: string } | null;
};

/** A kept-method call whose arguments could not be stored, and why. */
export type DroppedCall = { receiptId: string; actionIndex: number; reason: string };

export type ExtractedTx =
  | {
      complete: true;
      tx: TxRow;
      calls: CallRow[];
      events: EventRow[];
      droppedCalls: DroppedCall[];
    }
  | {
      complete: false;
      tx: TxRow;
      /** Receipts some outcome created that the service has not returned yet. */
      missingReceipts: number;
    };

/** The data does not have the shape this file was written for: hold the transaction back. */
export class HistoryShapeError extends Error {}

// ── Making JSON text storable as `jsonb` ─────────────────────────────────────────────────

const REPLACEMENT_ESCAPE = "\\ufffd";

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The code of a `\uXXXX` escape starting at `i`, or -1. */
function unicodeEscapeAt(text: string, i: number): number {
  if (text[i] !== "\\" || text[i + 1] !== "u") return -1;
  const hex = text.slice(i + 2, i + 6);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
}

/**
 * The same JSON text, with the escapes Postgres's `jsonb` refuses replaced by `�` (U+FFFD,
 * "replacement character"): `\u0000` ("unsupported Unicode escape sequence") and a surrogate
 * escape that is not half of a pair. Every other character is left exactly as it was — no
 * parse, no re-serialisation — so a u64 above 2^53 keeps its digits.
 *
 * Why it exists: the contract checks a portfolio name's LENGTH only (allocate.rs:185,
 * unallocate.rs:151), so a name may hold U+0000, and serde writes it as `\u0000`. Stored as is,
 * that one `portfolio_created` line would fail its INSERT on every pass. Lone surrogates cannot
 * come out of serde (Rust strings are valid UTF-8), but they can in a call's arguments.
 *
 * Walks escape by escape rather than matching a pattern: `\\u0000` is an escaped backslash
 * followed by the letters "u0000", valid, and must not be touched; only a scan that consumes
 * `\\` as one unit tells the two apart. Outside a string a backslash is invalid JSON, so every
 * one this meets is inside a string.
 */
export function sanitizeJsonText(text: string): string {
  if (!text.includes("\\u")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "\\") {
      out += text[i];
      i += 1;
      continue;
    }
    const code = unicodeEscapeAt(text, i);
    if (code === -1) {
      // `\\`, `\"`, `\n`, … — or a malformed escape, which the JSON parse then refuses.
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (isHighSurrogate(code)) {
      const next = unicodeEscapeAt(text, i + 6);
      if (next !== -1 && isLowSurrogate(next)) {
        out += text.slice(i, i + 12);
        i += 12;
        continue;
      }
      out += REPLACEMENT_ESCAPE;
    } else if (code === 0 || isLowSurrogate(code)) {
      out += REPLACEMENT_ESCAPE;
    } else {
      out += text.slice(i, i + 6);
    }
    i += 6;
  }
  return out;
}

// ── Receipts ─────────────────────────────────────────────────────────────────────────────

export function receiptSucceeded(status: Record<string, unknown> | undefined): boolean {
  return !!status && ("SuccessValue" in status || "SuccessReceiptId" in status);
}

/**
 * How many receipts some outcome of this transaction created that are not in it yet. Zero is
 * "finished": every receipt that will ever run is here. That is what replaces waiting a fixed
 * time: a callback, or a refund, lands in a later block, and a transaction recorded before it
 * would never be read again. Measured 2026-10-16: 139 of the vault's 139 transactions finished
 * by this rule.
 */
export function countMissingReceipts(tx: FastNearTx): number {
  const present = new Set<string>();
  for (const r of receiptsOf(tx)) {
    if (typeof r.execution_outcome.id === "string") present.add(r.execution_outcome.id);
  }
  // A missing list must not read as "creates nothing": that would call every transaction
  // finished the moment it is seen, and a recorded transaction is never read again.
  const created = (ids: unknown, what: string): string[] => {
    if (!Array.isArray(ids)) throw new HistoryShapeError(`${what}: no receipt_ids`);
    return ids as string[];
  };
  const referenced = [
    ...created(tx.execution_outcome?.outcome?.receipt_ids, "transaction"),
    ...receiptsOf(tx).flatMap((r) => created(r.execution_outcome.outcome.receipt_ids, "receipt")),
  ];
  return new Set(referenced.filter((id) => !present.has(id))).size;
}

/** The transaction's receipts, each with an outcome; throws on a shape this file cannot read. */
function receiptsOf(tx: FastNearTx): FastNearReceipt[] {
  if (!Array.isArray(tx.receipts)) throw new HistoryShapeError("transaction: no receipts list");
  for (const r of tx.receipts) {
    if (!isObject(r?.execution_outcome) || !isObject(r.execution_outcome.outcome)) {
      throw new HistoryShapeError("receipt: no outcome");
    }
  }
  return tx.receipts;
}

export function requireId(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new HistoryShapeError(`${what}: not an id`);
  }
  return value;
}

export function requireHeight(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HistoryShapeError(`${what}: no block height`);
  }
  return value;
}

/**
 * Nanoseconds → milliseconds, the precision `block_ts` is stored at (checked in 008). The JSON
 * number is already rounded to a double (~256 ns at today's magnitude), so a block a few
 * nanoseconds before a millisecond boundary may land 1 ms late — harmless: blocks are hundreds
 * of milliseconds apart, and the value is the same every time it is recomputed.
 */
export function blockMs(ns: unknown, what: string): number {
  if (typeof ns !== "number" || !Number.isFinite(ns) || ns <= 0) {
    throw new HistoryShapeError(`${what}: no block timestamp`);
  }
  return Math.floor(ns / 1e6);
}

// ── Events ───────────────────────────────────────────────────────────────────────────────

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function u128(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^\d{1,39}$/.test(value) || BigInt(value) > U128_MAX) {
    throw new HistoryShapeError(`${what}: not a u128`);
  }
  return BigInt(value).toString(); // drops leading zeros, so equal amounts compare equal
}

function portfolioIdOf(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new HistoryShapeError(`${what}: not a portfolio id`);
  }
  return value;
}

function arrayOf(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new HistoryShapeError(`${what}: not a list`);
  return value;
}

function single(portfolioId: string, qty: { qtyIn?: string; qtyOut?: string } = {}): PortfolioRow[] {
  return [
    { ord: 0, portfolioId, qtyIn: qty.qtyIn ?? null, qtyOut: qty.qtyOut ?? null, spread: null, swapToken: null },
  ];
}

/**
 * The portfolios an event touches and what each one's held balance did — the rule written in
 * the 008 header, which makes the rows of one (portfolio, token) fold to the contract's
 * `qty_held` (verified against the chain in 028-0).
 */
export function portfolioRowsOf(event: string, data: Record<string, unknown>): PortfolioRow[] {
  const where = `event ${event}`;
  switch (event) {
    case "allocate":
      return single(portfolioIdOf(data.portfolio_id, where), { qtyIn: u128(data.qty, where) });
    case "unallocate":
      return single(portfolioIdOf(data.portfolio_id, where), { qtyOut: u128(data.qty, where) });
    // Moves nothing: lifecycle, a deferred withdrawal (nothing moved), and a rescue claim
    // (its legs are the `allocate` rows of the same receipt, counted there, once).
    case "portfolio_created":
    case "portfolio_deleted":
    case "portfolio_renamed":
    case "portfolio_composition_changed":
    case "unallocate_deferred":
    case "pending_allocation_claimed":
      return single(portfolioIdOf(data.portfolio_id, where));
    case "external_rebalance":
    case "forced_internal_rebalance": {
      const external = event === "external_rebalance";
      if (typeof data.token_out !== "string" || data.token_out.length === 0) {
        throw new HistoryShapeError(`${where}: no token_out`);
      }
      const tokenOut = data.token_out;
      return arrayOf(data.attributions, where).map((row, ord) => {
        if (!isObject(row)) throw new HistoryShapeError(`${where}: attribution ${ord} is not an object`);
        return {
          ord,
          portfolioId: portfolioIdOf(row.portfolio_id, where),
          qtyIn: u128(row.qty_in, where),
          qtyOut: u128(row.qty_out, where),
          // A forced rebalance runs at cost: no spread.
          spread: external ? u128(row.attributed_spread, where) : null,
          swapToken: tokenOut,
        };
      });
    }
    // The debit is the later `unallocate` (callback or `resolve_stale_unallocation`): a quantity
    // here would count every withdrawal twice.
    case "pending_unallocation_opened":
      return arrayOf(data.legs, where).map((leg, ord) => {
        const [portfolioId] = arrayOf(leg, where);
        return {
          ord,
          portfolioId: portfolioIdOf(portfolioId, where),
          qtyIn: null,
          qtyOut: null,
          spread: null,
          swapToken: null,
        };
      });
    case "reconciliation_repaired":
      return arrayOf(data.corrections, where).map((correction, ord) => {
        const [portfolioId, , delta] = arrayOf(correction, where);
        if (typeof delta !== "string" || !/^-?\d{1,39}$/.test(delta)) {
          throw new HistoryShapeError(`${where}: correction ${ord} has no signed delta`);
        }
        const value = BigInt(delta);
        const magnitude = value < BigInt(0) ? -value : value;
        if (magnitude > U128_MAX) throw new HistoryShapeError(`${where}: correction ${ord} out of range`);
        return {
          ord,
          portfolioId: portfolioIdOf(portfolioId, where),
          qtyIn: value > BigInt(0) ? magnitude.toString() : null,
          qtyOut: value < BigInt(0) ? magnitude.toString() : null,
          spread: null,
          swapToken: null,
        };
      });
    // `unallocate_failed` names no portfolio; the rest are accounts, keys, pauses, admin.
    default:
      return [];
  }
}

/** One log line as an event row, or null when it is not a vault event. Throws on a bad shape. */
function eventOf(
  line: string,
  at: { receiptId: string; logIndex: number; blockHeight: number; blockTsMs: number }
): EventRow | null {
  if (!line.startsWith(LOG_PREFIX)) return null;
  const rawText = sanitizeJsonText(line.slice(LOG_PREFIX.length));
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null; // not JSON: no standard to claim, nothing a row could hold
  }
  if (!isObject(parsed) || parsed.standard !== EVENT_STANDARD) return null;

  // From here the line is the vault's own event: what does not fit is this file's fault.
  const { event, version, data } = parsed;
  if (typeof event !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(event)) {
    throw new HistoryShapeError("an event without a valid name");
  }
  if (typeof version !== "string" || version.length < 1 || version.length > 16) {
    throw new HistoryShapeError(`event ${event}: no valid version`);
  }
  if (version.split(".")[0] !== KNOWN_MAJOR) {
    throw new HistoryShapeError(`event ${event}: version ${version} is not one this recorder reads`);
  }
  const first = Array.isArray(data) ? data[0] : undefined;
  if (!isObject(first)) throw new HistoryShapeError(`event ${event}: no data object`);

  // Must equal `raw #>> '{data,0,account_id}'` (checked in 008): a JSON null reads as NULL there.
  const account = first.account_id;
  let accountId: string | null = null;
  if (account !== undefined && account !== null) {
    if (typeof account !== "string" || account.length < 2 || account.length > 128) {
      throw new HistoryShapeError(`event ${event}: account_id is not an account`);
    }
    accountId = account;
  }

  const portfolios = portfolioRowsOf(event, first);
  let owner: EventRow["owner"] = null;
  if (event === "portfolio_created") {
    if (!accountId) throw new HistoryShapeError("portfolio_created without its account");
    owner = { portfolioId: portfolios[0].portfolioId, accountId };
  }
  return { ...at, event, version, accountId, rawText, portfolios, owner };
}

// ── Calls ────────────────────────────────────────────────────────────────────────────────

/** The argument text of a kept call, or why it cannot be stored. */
function argsTextOf(args: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof args !== "string") return { ok: false, reason: "no base64 arguments" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(args, "base64"));
  } catch {
    return { ok: false, reason: "arguments are not UTF-8" };
  }
  const sanitized = sanitizeJsonText(text);
  try {
    if (!isObject(JSON.parse(sanitized))) return { ok: false, reason: "arguments are not a JSON object" };
  } catch {
    return { ok: false, reason: "arguments are not JSON" };
  }
  return { ok: true, text: sanitized };
}

function callsOf(
  receipt: FastNearReceipt,
  at: { receiptId: string; blockHeight: number; blockTsMs: number }
): { calls: CallRow[]; dropped: DroppedCall[] } {
  const calls: CallRow[] = [];
  const dropped: DroppedCall[] = [];
  const actions = receipt.receipt?.receipt?.Action?.actions ?? [];
  actions.forEach((action, actionIndex) => {
    const call = action.FunctionCall;
    if (!isObject(call) || typeof call.method_name !== "string" || !KEPT_CALL_METHODS.has(call.method_name)) return;
    const args = argsTextOf(call.args);
    if (!args.ok) {
      dropped.push({ receiptId: at.receiptId, actionIndex, reason: args.reason });
      return;
    }
    calls.push({ ...at, actionIndex, method: call.method_name, argsText: args.text });
  });
  return { calls, dropped };
}

// ── The transaction ──────────────────────────────────────────────────────────────────────

/**
 * Everything the recorder keeps from one transaction, or `complete: false` while some of its
 * receipts are still to come. Throws `HistoryShapeError` when the data is not what this file
 * was written for.
 */
export function extractTx(tx: FastNearTx, vaultId: string): ExtractedTx {
  if (!isObject(tx?.execution_outcome)) throw new HistoryShapeError("transaction: no outcome");
  const txRow: TxRow = {
    txHash: requireId(tx.transaction?.hash, "transaction"),
    blockHeight: requireHeight(tx.execution_outcome.block_height, "transaction"),
    blockTsMs: blockMs(tx.execution_outcome.block_timestamp, "transaction"),
  };
  const missingReceipts = countMissingReceipts(tx);
  if (missingReceipts > 0) return { complete: false, tx: txRow, missingReceipts };

  const calls: CallRow[] = [];
  const events: EventRow[] = [];
  const droppedCalls: DroppedCall[] = [];
  // The same receipt twice would put its rows twice into one INSERT: the table keeps one, but
  // whatever is summed from the list would count it twice. An exact repeat is dropped; two
  // different bodies under one id cannot both be true.
  const seen = new Map<string, string>();
  for (const receipt of receiptsOf(tx)) {
    const id = receipt.execution_outcome.id;
    if (typeof id === "string") {
      const body = JSON.stringify(receipt);
      const before = seen.get(id);
      if (before !== undefined) {
        if (before !== body) throw new HistoryShapeError(`receipt ${id} listed twice with different content`);
        continue;
      }
      seen.set(id, body);
    }
    const { outcome } = receipt.execution_outcome;
    if (outcome.executor_id !== vaultId) continue;
    if (!receiptSucceeded(outcome.status)) continue;
    const at = {
      receiptId: requireId(receipt.execution_outcome.id, "receipt"),
      blockHeight: requireHeight(receipt.execution_outcome.block_height, "receipt"),
      blockTsMs: blockMs(receipt.execution_outcome.block_timestamp, "receipt"),
    };
    (outcome.logs ?? []).forEach((line, logIndex) => {
      // `logIndex` counts every line, so it is the same number whoever recomputes it.
      const event = eventOf(line, { ...at, logIndex });
      if (event) events.push(event);
    });
    const kept = callsOf(receipt, at);
    calls.push(...kept.calls);
    droppedCalls.push(...kept.dropped);
  }
  return { complete: true, tx: txRow, calls, events, droppedCalls };
}
