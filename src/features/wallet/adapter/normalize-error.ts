const CANCEL_KEYWORDS = ["cancel", "reject", "denied", "user closed"];
// Wallet is not usable right now (locked, disconnected, extension missing): an
// actionable state the user can recover from by unlocking/reconnecting, not a bug.
// Matched against the messages the login adapters throw on their hard prechecks
// ("Wallet not connected", "TronLink not available", "Freighter wallet not found",
// "Wallet does not support signMessage", "Freighter returned null signature").
const UNAVAILABLE_KEYWORDS = [
  "not connected",
  "not available",
  "not found",
  "does not support",
  "null signature",
  "locked",
];

// Errors that mean the chain reverted what the user signed. See the origin check below.
const CHAIN_REVERT_ERROR_NAMES = new Set(["VaultRejectedError", "VaultCommitRevertedError"]);

// The relayer's refusals that have their own copy (017-2, D-365; D-304 asked for no raw text).
// All four mean nothing was sent. Keyed by `RelayError.code` (relay-client.ts). `cap-exceeded`
// is the server's own per-process brake, not the user's pace: it reads as a pause.
const RELAY_REFUSAL_KINDS: Record<string, WalletErrorKind> = {
  paused: "relay-paused",
  blocked: "relay-paused",
  "cap-exceeded": "relay-paused",
  "rate-limited": "relay-busy",
  "would-fail": "relay-would-fail",
  "check-failed": "relay-check-failed",
};

export type WalletErrorKind =
  | "cancel"
  | "unavailable"
  | "error"
  // The relayer did not send it — nothing moved (017-2). Only the vault's money paths see these.
  | "relay-paused"
  | "relay-busy"
  | "relay-would-fail"
  | "relay-check-failed";

export function normalizeWalletError(
  e: unknown
): { kind: WalletErrorKind; message: string } {
  const raw = e instanceof Error ? e.message : String(e);
  // Origin before keywords (FE #5). The chain REVERTING an Allocate is not the user
  // declining in the wallet, but its message carries "rejected" — the very word the cancel
  // match looks for. Read as a cancel it showed "You cancelled the signature. You can retry",
  // and the retry signed again with nothing left to move (`922` §8 #15). The class carries
  // the origin; the text cannot. Matched by name, not `instanceof`, so this adapter does not
  // import the vault's module graph. `VaultCommitRevertedError` is the same case on the
  // commit path (D-301): a reverted withdrawal or composition change, never a cancel.
  if (e instanceof Error && CHAIN_REVERT_ERROR_NAMES.has(e.name)) {
    console.warn("[wallet] the chain rejected the transaction:", e);
    return { kind: "error", message: raw };
  }
  // The relayer's answers, before the keywords for the same reason as the reverts: their text
  // is the relay's, a node's or the chain's ("insufficient balance…", "not found"), never the
  // user's — so no keyword may turn one into a cancel or a locked wallet.
  if (e instanceof Error && e.name === "RelayError") {
    const kind = RELAY_REFUSAL_KINDS[(e as Error & { code?: string }).code ?? ""];
    console.warn("[wallet] the relayer did not send it:", e);
    return { kind: kind ?? "error", message: raw };
  }
  // The mock contract's own refusals ("Account … not found"): domain errors, not wallet
  // states, so no keyword may turn one into a locked or missing wallet (D-145).
  if (e instanceof Error && e.name === "ContractError") {
    return { kind: "error", message: raw };
  }
  const lower = raw.toLowerCase();
  // User intent wins: a "rejected"/"cancelled" message is a cancel even if it also
  // mentions an unavailable-sounding word.
  if (CANCEL_KEYWORDS.some((kw) => lower.includes(kw))) {
    return { kind: "cancel", message: raw };
  }
  if (UNAVAILABLE_KEYWORDS.some((kw) => lower.includes(kw))) {
    return { kind: "unavailable", message: raw };
  }
  // Any wallet call lands here (sign-in, sign-out, a deposit…): the label must not name one.
  console.warn("[wallet] unrecognized wallet error:", e);
  return { kind: "error", message: raw || "Wallet error" };
}
