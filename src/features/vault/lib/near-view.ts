// Shared NEAR view-call helper for the vault round-trip slice (007.plan, Phase 1).
//
// Extracted exactly when vault-read-client.ts said it should be: "If a third view-call
// caller appears, extract a shared near-rpc helper then." Phase 1 adds that third caller —
// the Verifier's live `current_salt` (intents-read-client.ts) — so the vault reads and the
// salt read now share one RPC path. `wallet/lib/balance-fetcher.ts` deliberately keeps its
// own copy: it is a separate money-adjacent path and rewiring it is out of this scope.
//
// Reads only — no funds move here. Write paths go through the wallet's
// signAndSendTransaction (see allocate-submit.ts).

import { BROWSER_RPC_URL } from "@/features/wallet/config/network";
import type { AllowedViewMethod } from "@/features/wallet/lib/near-rpc-proxy";

const RPC_TIMEOUT_MS = 10_000;

type RpcRequest = {
  jsonrpc: "2.0";
  id: string;
  /**
   * `tx` joined `query` when the HOT delivery wait needed a transaction's receipt logs, `block`
   * when the never-executed proof needed the clock of the block it reads at (D-556).
   */
  method: "query" | "tx" | "block";
  params: Record<string, unknown>;
};

type CallFunctionResult = {
  result: number[];
  logs: string[];
  block_height: number;
  block_hash: string;
  error?: string;
};

type RpcResponse<T> = {
  result?: T;
  // NEAR's JSON-RPC puts the useful discriminator in `cause.name` (and echoes it in
  // `data`); `message` is the generic "Server error". Both are read by `accountExists`.
  error?: {
    code: number;
    message: string;
    data?: string;
    name?: string;
    cause?: { name?: string; info?: unknown };
  };
};

async function rpcPost<T>(body: RpcRequest): Promise<RpcResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(BROWSER_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    return res.json() as Promise<RpcResponse<T>>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Base64 of the UTF-8 bytes of `text` — what the contract parses as JSON. NOT `btoa(text)`:
 * `btoa` writes each UTF-16 unit as one byte, so "ó" becomes 0xF3 (not UTF-8; the contract's
 * JSON parse panics) and anything past U+00FF throws. A v2 `get_allocate_seal` carries the raw
 * Setup `msg`, whose portfolio name is free text (017-9a cross-review).
 */
export function utf8Base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// A single view call against `accountId`. Encodes args as base64 JSON, unwraps the
// byte-array result, decodes it, and JSON-parses. A wasm panic surfaces as
// callResult.error — callers decide whether that maps to an empty value (a fresh account)
// or a real failure. Money-adjacent: never swallow an error into a silent zero.
// `methodName` is typed to the proxy's allowlist: a read the route would refuse does not compile.
// Reads at FINAL, or at `at.blockHash` when the answer has to describe one known block.
export async function viewCall<T>(
  accountId: string,
  methodName: AllowedViewMethod,
  args: Record<string, unknown> = {},
  at?: { blockHash: string }
): Promise<T> {
  const argsBase64 = utf8Base64(JSON.stringify(args));
  const res = await rpcPost<CallFunctionResult>({
    jsonrpc: "2.0",
    id: methodName,
    method: "query",
    params: {
      request_type: "call_function",
      ...(at ? { block_id: at.blockHash } : { finality: "final" }),
      account_id: accountId,
      method_name: methodName,
      args_base64: argsBase64,
    },
  });
  if (res.error) throw new Error(`view ${accountId} ${methodName}: ${res.error.message}`);
  const callResult = res.result;
  if (!callResult) throw new Error(`view ${accountId} ${methodName}: empty RPC result`);
  if (callResult.error) throw new Error(`view ${accountId} ${methodName}: ${callResult.error}`);
  const text = new TextDecoder().decode(new Uint8Array(callResult.result));
  return JSON.parse(text) as T;
}

const NS_PER_MS = BigInt(1_000_000);

/**
 * The FINAL head as whichever node answered sees it: its hash, to pin reads to it, and its clock.
 *
 * Fails CLOSED: a caller draws a conclusion from this clock, so an answer without a usable hash
 * or timestamp throws instead of being read as "now" or as zero. A node hours behind answers
 * with its own old block, and that old timestamp is exactly what lets the caller notice.
 */
export async function readFinalHead(): Promise<{ hash: string; timestampMs: number }> {
  const res = await rpcPost<{ header?: { hash?: unknown; timestamp_nanosec?: unknown } }>({
    jsonrpc: "2.0",
    id: "final-head",
    method: "block",
    params: { finality: "final" },
  });
  if (res.error) throw new Error(`final head: ${res.error.message}`);
  const hash = res.result?.header?.hash;
  const nanos = res.result?.header?.timestamp_nanosec;
  if (typeof hash !== "string" || hash === "" || typeof nanos !== "string" || !/^\d+$/.test(nanos)) {
    throw new Error("final head: unreadable block header");
  }
  return { hash, timestampMs: Number(BigInt(nanos) / NS_PER_MS) };
}

/**
 * A transaction's execution outcome, receipts included.
 *
 * Added for the `hot-omni` delivery wait (008.plan block 4.3.4), which can only find its
 * withdrawal nonce by reading the settlement transaction's RECEIPT logs. `wait_until` and
 * the `intents.near` sender mirror what intents-sdk asks for (`parseWithdrawalNonces` via
 * `IntentRelayerPublic`, whose `tx.accountId` is the Verifier contract, not the user).
 *
 * Returns `unknown`: callers parse defensively, because a log format we cannot read must
 * degrade to "not found yet" rather than throw on a shape assumption.
 *
 * Attribution: see ATTRIBUTIONS.md #11.
 */
export async function fetchTxOutcome(txHash: string, senderAccountId: string): Promise<unknown> {
  const res = await rpcPost<unknown>({
    jsonrpc: "2.0",
    id: "tx",
    method: "tx",
    params: {
      tx_hash: txHash,
      sender_account_id: senderAccountId,
      wait_until: "EXECUTED_OPTIMISTIC",
    },
  });
  if (res.error) throw new Error(`tx ${txHash}: ${res.error.message}`);
  if (!res.result) throw new Error(`tx ${txHash}: empty RPC result`);
  return res.result;
}

/**
 * Whether a NEAR account exists (`view_account`). Added for the withdrawal destination
 * pre-flight (005.plan Phase 5) — the only caller today; it mirrors the SDK's
 * `accountExistsInNEAR` (direct-bridge-utils.ts) without adding that dependency.
 *
 * Money-critical distinction: ONLY a definite "unknown account" answer returns false.
 * Anything else — a transport error, an unrecognised RPC error — THROWS, because the caller
 * uses this to decide whether to ask for a signature, and a flaky RPC read must not be
 * mistaken for a confirmed answer in either direction.
 *
 * Attribution: see ATTRIBUTIONS.md #10.
 */
export async function accountExists(accountId: string): Promise<boolean> {
  const res = await rpcPost<{ amount: string }>({
    jsonrpc: "2.0",
    id: "view_account",
    method: "query",
    params: { request_type: "view_account", finality: "final", account_id: accountId },
  });
  if (res.error) {
    const definitelyMissing =
      res.error.cause?.name === "UNKNOWN_ACCOUNT" ||
      /does not exist/i.test(res.error.data ?? "") ||
      /does not exist/i.test(res.error.message);
    if (definitelyMissing) return false;
    throw new Error(`view_account ${accountId}: ${res.error.message}`);
  }
  if (!res.result) throw new Error(`view_account ${accountId}: empty RPC result`);
  return true;
}

/** The `code_hash` `view_account` reports for an account with no contract deployed. */
const NO_CONTRACT_CODE_HASH = "11111111111111111111111111111111";

/**
 * Whether a NEAR account has a contract on it (`view_account`), for the withdrawal warning
 * (D-386 d): a plain `ft_transfer` to a DEX or any other contract lands where the sender may
 * never get it back. An account running a global contract keeps the empty `code_hash` and
 * names the contract in `global_contract_hash` / `global_contract_account_id` instead.
 *
 * Throws on anything that is not a definite answer, like `accountExists`; the caller decides
 * what an unknown means (for the warning: say nothing).
 */
export async function accountHasContract(accountId: string): Promise<boolean> {
  const res = await rpcPost<{
    code_hash?: string;
    global_contract_hash?: string | null;
    global_contract_account_id?: string | null;
  }>({
    jsonrpc: "2.0",
    id: "view_account",
    method: "query",
    params: { request_type: "view_account", finality: "final", account_id: accountId },
  });
  if (res.error) throw new Error(`view_account ${accountId}: ${res.error.message}`);
  if (!res.result || typeof res.result.code_hash !== "string") {
    throw new Error(`view_account ${accountId}: no code_hash in RPC result`);
  }
  return (
    res.result.code_hash !== NO_CONTRACT_CODE_HASH ||
    !!res.result.global_contract_hash ||
    !!res.result.global_contract_account_id
  );
}
