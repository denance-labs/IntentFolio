// Publishes the app's withdrawals and 1Click transfers through IntentFolio's own relay (D-589).
//
// The solver relay (`solver-relay-v2.chaindefuser.com/rpc`) has answered 403 to everyone since
// 2026-11-19. It did two jobs for the four flows that sign straight against `intents.near` — the
// direct withdrawal, the Converting Withdrawal, the gas purchase and the stock swap — and both are
// rebuilt here over ONE call to `/api/relay` (target `verifier`, `execute_intents`):
//
//   - publishing (`WithdrawPublisher`): answers in the solver relay's own response shape, so
//     `parsePublishResponse` and each flow's error taxonomy stay exactly as they are;
//   - waiting for the settlement (`SettlementWaiter`): the call above only returns once the
//     transaction executed, so the wait resolves at once with that transaction's hash.
//
// What each answer proves, and what it becomes:
//   - the relay refused before sending (`relayRefusedBeforeSending`) — except "already sent",
//     whose first copy may have landed — or the transaction's FIRST receipt, `execute_intents`
//     run by `intents.near`, failed (it rolled back, nothing moved) → FAILED with the
//     NOT_EXECUTED prefix → `untouched`;
//   - that receipt succeeded and its `intents_executed` event names this signer and nonce → OK,
//     with that event's intent hash;
//   - anything else — an unanswered send, no such receipt, an executed transaction that does not
//     name this intent — throws `OwnRelayUnconfirmedError` → `unknown`, carrying the tx hash when
//     known so the record keeps it. Never a hash made up here: the nonce stays the proof
//     (withdraw-publication-check.ts).
//
// The FIRST receipt, not the transaction's final status: that status follows whatever promise the
// call returns, so a failing tail would read as a Failure after the debit committed. A receipt
// failing AFTER `execute_intents` (a token's `ft_transfer`, refunded by the Verifier) is a
// settlement here, as the solver relay reported it: the intent executed.
//
// Attribution: see ATTRIBUTIONS.md #10 (the solver relay's response shape this answers in, and the
// `intents_executed` event it reads) and #21 (NEAR Intents' `dip4` events).

import { RelayError, relayRefusedBeforeSending, submitViaRelay } from "@/features/vault/lib/relay-client";
import { RELAY_ALREADY_SENT_ERROR } from "@/features/vault/lib/relay-types";
import { findExecutionFailure } from "@/features/vault/lib/vault-events";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";
import type { MultiPayload } from "@/features/vault/lib/vault-signer";
import { NOT_EXECUTED_REASON_PREFIX } from "./withdraw-errors";
import type { SettlementWaiter } from "./withdraw-poll";
import type { WithdrawPublisher } from "./withdraw-submit";

/** Sends one signed envelope to `/api/relay` and resolves with the execution outcome. */
export type VerifierSubmit = (input: { target: "verifier"; payload: unknown }) => Promise<unknown>;

export type OwnRelayPublication = {
  publish: WithdrawPublisher;
  waitForSettlement: SettlementWaiter;
  /**
   * Who signed a transaction this page published: the relayer, not `intents.near`. HOT's delivery
   * wait passes it to the RPC when it reads the settlement back. Lost on a reload, which is fine:
   * the RPC finds the transaction under any sender (measured 2026-11-25, see hot-delivery.ts).
   */
  senderOf: (txHash: string) => string | undefined;
};

type Signed = { signerId: string; nonce: string };

/** The publish may have executed: `unknown`. `txHash` is the transaction to follow, when known. */
export class OwnRelayUnconfirmedError extends Error {
  constructor(
    message: string,
    readonly txHash: string | null,
    cause?: unknown
  ) {
    super(txHash === null ? message : `${message} (tx ${txHash})`, { cause });
    this.name = "OwnRelayUnconfirmedError";
  }
}

/**
 * The tx hash an unconfirmed publish carried, found down an error's `cause` chain (the flows wrap
 * the publisher's throw), or null. For the rescue record, which otherwise keeps only the text.
 */
export function unconfirmedPublishTxHash(e: unknown): string | null {
  for (let cur: unknown = e, depth = 0; cur instanceof Error && depth < 5; cur = cur.cause, depth++) {
    if (cur instanceof OwnRelayUnconfirmedError) return cur.txHash;
  }
  return null;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
const notExecuted = (reason: string) => ({ status: "FAILED", reason: `${NOT_EXECUTED_REASON_PREFIX}${reason}` });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The signer and nonce (base64) of a signed envelope, as each family puts them on the wire — the
 * same reading as the relay's `extractDefuseEnvelope`, which is server-only. Null when unreadable.
 */
export function readSignerAndNonce(signed: unknown): Signed | null {
  if (!isObject(signed)) return null;
  const inner = signed.payload;
  let fields: Record<string, unknown> | null;
  let nonce: unknown;
  if (signed.standard === "nep413") {
    if (!isObject(inner)) return null;
    fields = parseObject(inner.message);
    nonce = inner.nonce;
  } else if (signed.standard === "ton_connect") {
    fields = isObject(inner) ? parseObject(inner.text) : null;
    nonce = fields?.nonce;
  } else {
    fields = parseObject(inner);
    nonce = fields?.nonce;
  }
  if (!fields || typeof fields.signer_id !== "string" || typeof nonce !== "string") return null;
  return { signerId: fields.signer_id, nonce };
}

/** Two base64 nonces name the same bytes. A URL-safe one throws in `atob`: no match, so unknown. */
function sameNonce(a: string, b: string): boolean {
  try {
    return atob(a) === atob(b);
  } catch {
    return false;
  }
}

type Receipt = { outcome?: { executor_id?: unknown; status?: unknown; logs?: unknown } };

/**
 * The intent hash the Verifier logged for this signer and nonce (`dip4` `intents_executed`), or
 * null. Only receipts `intents.near` executed successfully: a log line carries no author.
 */
export function executedIntentHash(outcome: unknown, signed: Signed): string | null {
  const receipts = (outcome as { receipts_outcome?: Receipt[] } | null)?.receipts_outcome;
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    const o = receipt?.outcome;
    if (o?.executor_id !== INTENTS_CONTRACT_ID || !isObject(o.status) || !("SuccessValue" in o.status)) continue;
    for (const line of Array.isArray(o.logs) ? o.logs : []) {
      if (typeof line !== "string" || !line.startsWith("EVENT_JSON:")) continue;
      const event = parseObject(line.slice("EVENT_JSON:".length));
      if (event?.standard !== "dip4" || event.event !== "intents_executed" || !Array.isArray(event.data)) continue;
      for (const entry of event.data) {
        if (!isObject(entry) || entry.account_id !== signed.signerId || typeof entry.intent_hash !== "string") continue;
        if (typeof entry.nonce === "string" && sameNonce(entry.nonce, signed.nonce)) return entry.intent_hash;
      }
    }
  }
  return null;
}

type TxOutcome = {
  transaction_outcome?: { id?: unknown; outcome?: { receipt_ids?: unknown } };
  receipts_outcome?: Array<Receipt & { id?: unknown }>;
};

function txHashOf(outcome: unknown): string | null {
  const id = (outcome as TxOutcome | null)?.transaction_outcome?.id;
  return typeof id === "string" ? id : null;
}

/** The status of the transaction's first receipt when `intents.near` ran it, else undefined. */
function executeIntentsStatus(outcome: unknown): Record<string, unknown> | undefined {
  const o = outcome as TxOutcome | null;
  const ids = o?.transaction_outcome?.outcome?.receipt_ids;
  const firstId = Array.isArray(ids) ? ids[0] : undefined;
  if (typeof firstId !== "string") return undefined;
  const first = (Array.isArray(o?.receipts_outcome) ? o.receipts_outcome : []).find((r) => r?.id === firstId);
  if (first?.outcome?.executor_id !== INTENTS_CONTRACT_ID) return undefined;
  return isObject(first.outcome.status) ? first.outcome.status : undefined;
}

export function createOwnRelayPublication(
  submit: VerifierSubmit = (input) => submitViaRelay(input)
): OwnRelayPublication {
  /** Intent hash → the transaction that executed it, from the publish to the wait right after. */
  const settled = new Map<string, string>();
  /** Transaction → its signer, for the delivery wait after the settlement. A handful per page. */
  const senders = new Map<string, string>();

  const publish: WithdrawPublisher = async ({ quote_hashes, signed_data }) => {
    // Only HOT's fee swap carries a quote, and only the solver relay could honour it.
    if (quote_hashes.length > 0) return notExecuted("a quoted swap cannot be published without the solver relay");
    const signed = readSignerAndNonce(signed_data as MultiPayload);
    if (!signed) return notExecuted("the signed envelope could not be read");

    let outcome: unknown;
    try {
      outcome = await submit({ target: "verifier", payload: signed_data });
    } catch (e) {
      // "Already sent" is a refusal before THIS send, but the first copy may have landed.
      const alreadySent = e instanceof RelayError && e.message === RELAY_ALREADY_SENT_ERROR;
      if (relayRefusedBeforeSending(e) && !alreadySent) return notExecuted(describe(e));
      // `unknown-outcome` and anything unprovable: the caller wraps it as `unknown`.
      const txHash = e instanceof RelayError ? e.txHash : null;
      throw new OwnRelayUnconfirmedError(describe(e), txHash, e);
    }

    const txHash = txHashOf(outcome);
    const status = executeIntentsStatus(outcome);
    if (status && "Failure" in status) {
      return notExecuted(findExecutionFailure({ status }) ?? "execute_intents reverted");
    }
    if (!status || !("SuccessValue" in status || "SuccessReceiptId" in status)) {
      throw new OwnRelayUnconfirmedError("the relay's outcome does not show execute_intents ending", txHash);
    }
    if (txHash === null) throw new OwnRelayUnconfirmedError("the relay's outcome has no transaction hash", null);
    const intentHash = executedIntentHash(outcome, signed);
    if (intentHash === null) {
      throw new OwnRelayUnconfirmedError("execute_intents ran but its events do not name this intent", txHash);
    }
    settled.set(intentHash, txHash);
    const signer = (outcome as { transaction?: { signer_id?: unknown } }).transaction?.signer_id;
    if (typeof signer === "string") senders.set(txHash, signer);
    return { status: "OK", intent_hash: intentHash };
  };

  const waitForSettlement: SettlementWaiter = async ({ intentHash, onTxHashKnown }) => {
    const txHash = settled.get(intentHash);
    // Not published by this page: nothing here can follow it any more.
    if (txHash === undefined) throw new Error(`no settlement known for intent ${intentHash}`);
    settled.delete(intentHash);
    onTxHashKnown?.(txHash);
    return { txHash, intentHash };
  };

  return { publish, waitForSettlement, senderOf: (txHash) => senders.get(txHash) };
}

/** The app's one instance: the publish and the wait after it must share what was settled. */
export const ownRelayPublication = createOwnRelayPublication();
