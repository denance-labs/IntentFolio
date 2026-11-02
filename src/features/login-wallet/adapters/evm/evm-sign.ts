import type { Signature } from "@/features/intents-account/mock-contract/types";

type EvmSignature = Extract<Signature, { scheme: "erc191" }>;

/**
 * Converts a raw wagmi personal_sign hex result into the canonical Signature union.
 * Pure function — testable without a wallet.
 * publicKey is omitted: ERC-191 pubkey is recovered from (signature, payload) at verify time.
 */
export function buildEvmSignature(rawHex: string, message: string): EvmSignature {
  return { scheme: "erc191", payload: message, signature: rawHex };
}
