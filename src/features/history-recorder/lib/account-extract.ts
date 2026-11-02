// One FastNEAR transaction, seen from one account → the rows the account recorder writes (plan
// 028-6, D-492 stage 2). Pure: no I/O. The table contract is the header of
// `intentfolio-solver/db/migrations/009_account_history.sql`:
//   - `intents_event`: every event line of a SUCCESSFUL receipt EXECUTED BY `intents.near` that
//     names the account (NEP-245 `owner_id` / `old_owner_id` / `new_owner_id`; NEAR Intents
//     `account_id` / `receiver_id`), stored as logged, byte for byte;
//   - `account_movement`: the account's own entries in those lines — `deposit` (`mt_mint`),
//     `withdrawal` (`mt_burn`) and `transfer_out` (a `transfer` the account signed). Not the
//     NEP-245 `mt_transfer` legs: most of them are legs of swaps, and a solver's batch nets them
//     (028-4). Incoming transfers and swaps get no movement; their lines are kept raw;
//   - the vault's own rows of the same transaction, from `extractTx` (008), unchanged.
//
// The trust rules are `history-extract.ts`'s, applied to `intents.near`: what its envelope says
// is the contract's, and a shape this file does not know throws (the transaction is held back,
// visibly). What anyone can choose — a memo, the id of a token anyone can mint (`imt:`, an NFT
// of any contract) — must never hold an account back: Postgres `text` cannot store U+0000, so a
// memo gets it replaced and an identifier carrying it drops that one movement, named in
// `skipped`. The raw line keeps it either way (its JSON escape is plain ASCII).
//
// Attribution: see ATTRIBUTIONS.md #21 (FastNEAR transaction API).

import type { FastNearTx } from "@/features/vault/lib/vault-history-client";
import {
  HistoryShapeError,
  blockMs,
  extractTx,
  isObject,
  receiptSucceeded,
  requireHeight,
  requireId,
  u128,
  type ExtractedTx,
  type TxRow,
} from "./history-extract";

export const INTENTS_CONTRACT_ID = "intents.near";

const LOG_PREFIX = "EVENT_JSON:";
/** NEAR caps what one receipt may log at 16 KiB (009 `intents_event_line_shape`). */
const LINE_MAX_BYTES = 16_384;
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** Where each standard names an account. */
const NAMING_FIELDS: Record<IntentsStandard, readonly string[]> = {
  nep245: ["owner_id", "old_owner_id", "new_owner_id"],
  dip4: ["account_id", "receiver_id"],
};

export type IntentsStandard = "nep245" | "dip4";

/** One `intents_event` row. */
export type IntentsLine = {
  receiptId: string;
  logIndex: number;
  blockHeight: number;
  blockTsMs: number;
  standard: IntentsStandard;
  event: string;
  line: string;
};

export type MovementKind = "deposit" | "withdrawal" | "transfer_out";

/** One `account_movement` row. */
export type Movement = {
  receiptId: string;
  logIndex: number;
  entryIndex: number;
  tokenIndex: number;
  kind: MovementKind;
  tokenId: string;
  amount: string;
  /** `transfer_out` only: the transfer's `receiver_id`. */
  counterparty: string | null;
  memo: string | null;
  /** `transfer_out` only, when the event carries one. */
  intentHash: string | null;
  blockHeight: number;
  blockTsMs: number;
};

type FinishedVaultTx = Extract<ExtractedTx, { complete: true }>;

export type AccountTx =
  | {
      complete: true;
      tx: TxRow;
      lines: IntentsLine[];
      movements: Movement[];
      /** Movements not stored, with why (a value Postgres cannot hold). For the log. */
      skipped: string[];
      /** The vault's rows of this transaction, or null when it has none to write. */
      vault: FinishedVaultTx | null;
    }
  | { complete: false; tx: TxRow; missingReceipts: number };

const NUL = "\u0000";

/** An identifier `account_movement` can hold, or null (U+0000, out of the column's bounds). */
function storableId(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" && value.length >= min && value.length <= max && !value.includes(NUL)
    ? value
    : null;
}

function memoOf(value: unknown): string | null {
  return typeof value === "string" ? value.replaceAll(NUL, "�") : null;
}

function parseEnvelope(line: string): { standard: IntentsStandard; event: unknown; entries: Record<string, unknown>[] } | null {
  if (!line.startsWith(LOG_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(LOG_PREFIX.length));
  } catch {
    return null;
  }
  if (!isObject(parsed) || (parsed.standard !== "nep245" && parsed.standard !== "dip4")) return null;
  const data = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  return { standard: parsed.standard, event: parsed.event, entries: data.filter(isObject) };
}

/**
 * Everything the account recorder keeps from one transaction for `accountId`, or
 * `complete: false` while some of its receipts are still to come (the rule of 008: a recorded
 * transaction is never read again). Throws `HistoryShapeError` on a shape this code does not know.
 */
export function extractAccountTx(tx: FastNearTx, accountId: string, vaultId: string): AccountTx {
  // The transaction row, the "finished" rule and the duplicate-receipt check are 008's.
  const vault = extractTx(tx, vaultId);
  if (!vault.complete) return vault;

  const lines: IntentsLine[] = [];
  const movements: Movement[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const receipt of tx.receipts) {
    const { outcome } = receipt.execution_outcome;
    if (outcome.executor_id !== INTENTS_CONTRACT_ID || !receiptSucceeded(outcome.status)) continue;
    const receiptId = requireId(receipt.execution_outcome.id, "receipt");
    // `extractTx` already refused two different bodies under one id: a repeat is the same one.
    if (seen.has(receiptId)) continue;
    seen.add(receiptId);
    const at = {
      receiptId,
      blockHeight: requireHeight(receipt.execution_outcome.block_height, "receipt"),
      blockTsMs: blockMs(receipt.execution_outcome.block_timestamp, "receipt"),
    };

    (outcome.logs ?? []).forEach((line, logIndex) => {
      const envelope = parseEnvelope(line);
      if (!envelope) return;
      const { standard, event, entries } = envelope;
      if (!entries.some((e) => NAMING_FIELDS[standard].some((f) => e[f] === accountId))) return;
      const where = `${receiptId}#${logIndex}`;
      if (typeof event !== "string" || !EVENT_NAME.test(event)) {
        throw new HistoryShapeError(`${where}: an intents.near event without a valid name`);
      }
      // NEAR caps a receipt's logs below this; a line past it is kept out rather than allowed to
      // fail its transaction for good. (A raw U+0000 never gets here: JSON.parse refuses it.)
      if (Buffer.byteLength(line, "utf8") > LINE_MAX_BYTES) {
        skipped.push(`${where}: line not storable`);
        return;
      }
      lines.push({ ...at, logIndex, standard, event, line });
      const base = { ...at, logIndex };

      if (standard === "nep245" && (event === "mt_mint" || event === "mt_burn")) {
        const kind: MovementKind = event === "mt_mint" ? "deposit" : "withdrawal";
        entries.forEach((entry, entryIndex) => {
          if (entry.owner_id !== accountId) return;
          const tokens = entry.token_ids;
          const amounts = entry.amounts;
          if (!Array.isArray(tokens) || !Array.isArray(amounts) || tokens.length === 0 || tokens.length !== amounts.length) {
            throw new HistoryShapeError(`${where}: ${event} entry ${entryIndex} without matching tokens and amounts`);
          }
          tokens.forEach((token, tokenIndex) => {
            const tokenId = storableId(token, 1, 256);
            if (tokenId === null) {
              skipped.push(`${where} entry ${entryIndex} token ${tokenIndex}: token id not storable`);
              return;
            }
            movements.push({
              ...base,
              entryIndex,
              tokenIndex,
              kind,
              tokenId,
              amount: u128(amounts[tokenIndex], `${where} amount`),
              counterparty: null,
              memo: memoOf(entry.memo),
              intentHash: null,
            });
          });
        });
      }

      if (standard === "dip4" && event === "transfer") {
        entries.forEach((entry, entryIndex) => {
          if (entry.account_id !== accountId) return;
          if (!isObject(entry.tokens)) throw new HistoryShapeError(`${where}: transfer entry ${entryIndex} without tokens`);
          const counterparty = storableId(entry.receiver_id, 2, 128);
          const intentHash = entry.intent_hash === undefined ? null : storableId(entry.intent_hash, 1, 64);
          // Token ids are prefixed (`nep141:`, `imt:`, …), never integer-like, so the key order
          // of the parsed object is the order logged — the order `token_index` counts.
          Object.entries(entry.tokens).forEach(([token, amount], tokenIndex) => {
            const tokenId = storableId(token, 1, 256);
            if (tokenId === null || counterparty === null || (entry.intent_hash !== undefined && intentHash === null)) {
              skipped.push(`${where} entry ${entryIndex} token ${tokenIndex}: transfer field not storable`);
              return;
            }
            movements.push({
              ...base,
              entryIndex,
              tokenIndex,
              kind: "transfer_out",
              tokenId,
              amount: u128(amount, `${where} amount`),
              counterparty,
              memo: memoOf(entry.memo),
              intentHash,
            });
          });
        });
      }
    });
  }

  const hasVaultRows = vault.events.length > 0 || vault.calls.length > 0;
  return { complete: true, tx: vault.tx, lines, movements, skipped, vault: hasVaultRows ? vault : null };
}
