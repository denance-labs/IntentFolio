import type { Signature } from "@/features/intents-account/mock-contract/types";

type StellarSignature = Extract<Signature, { scheme: "sep53" }>;

/**
 * Converts Freighter signMessage output into the canonical Signature union.
 * Pure function — testable without a wallet.
 * In Stellar, the public key is the G… address itself.
 */
export function buildStellarSignature(
  signerAddress: string,
  message: string,
  signedMessage: string,
): StellarSignature {
  return {
    scheme: "sep53",
    payload: message,
    signature: signedMessage,
    publicKey: signerAddress,
  };
}
