import bs58 from "bs58";
import type { Signature } from "@/features/intents-account/mock-contract/types";

type SolanaSignature = Extract<Signature, { scheme: "raw_ed25519" }>;

/**
 * Converts raw Solana signMessage output into the canonical Signature union.
 * Pure function — testable without a wallet.
 * Both signature and publicKey are base58-encoded (raw_ed25519 convention).
 */
export function buildSolanaSignature(
  sigBytes: Uint8Array,
  publicKeyBase58: string,
  message: string,
): SolanaSignature {
  return {
    scheme: "raw_ed25519",
    payload: message,
    signature: bs58.encode(sigBytes),
    publicKey: publicKeyBase58,
  };
}
