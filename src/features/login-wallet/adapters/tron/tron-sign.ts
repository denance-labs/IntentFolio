import type { Signature } from "@/features/intents-account/mock-contract/types";

type TronSignature = Extract<Signature, { scheme: "tip191" }>;

/**
 * Converts TronLink signMessageV2 output into the canonical Signature union.
 * Pure function — testable without a wallet.
 * TIP-191 is Tron's signed-message standard (analogous to ERC-191 on Ethereum).
 * publicKey is omitted — TronLink does not expose it directly (address is the identifier).
 */
export function buildTronSignature(message: string, signature: string): TronSignature {
  return {
    scheme: "tip191",
    payload: message,
    signature,
  };
}
