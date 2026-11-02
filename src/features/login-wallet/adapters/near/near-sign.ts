import type { SignedMessage } from "@hot-labs/near-connect";
import type { Signature } from "@/features/intents-account/mock-contract/types";

/**
 * Converts a raw HOT Connect NEP-413 result into the canonical Signature union.
 * Pure function — testable without a wallet.
 */
export function buildNearSignature(raw: SignedMessage, message: string): Signature {
  return {
    scheme: "nep413",
    payload: message,
    signature: raw.signature,
    publicKey: raw.publicKey,
  };
}
