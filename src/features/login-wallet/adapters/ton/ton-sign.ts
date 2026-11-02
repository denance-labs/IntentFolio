import type { Signature } from "@/features/intents-account/mock-contract/types";

type TonSignature = Extract<Signature, { scheme: "ton_connect" }>;

/**
 * Converts TonConnect signData output into the canonical Signature union.
 * Pure function — testable without a wallet.
 * timestamp is serialised to string (ISO-like representation of unix seconds).
 */
export function buildTonSignature(
  address: string,
  domain: string,
  timestamp: number,
  text: string,
  signature: string,
  publicKey: string,
): TonSignature {
  return {
    scheme: "ton_connect",
    address,
    domain,
    timestamp: String(timestamp),
    text,
    signature,
    publicKey,
  };
}
