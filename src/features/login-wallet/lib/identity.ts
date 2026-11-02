import { authIdentity, type AuthMethod } from "@defuse-protocol/internal-utils";
import type { ChainKind } from "../types";
import type { IntentsAccountId } from "@/features/intents-account/mock-contract/types";

// ChainKind is a strict subset of AuthMethod — names are identical (no webauthn in our enum).
function toAuthMethod(chainKind: ChainKind): AuthMethod {
  return chainKind as AuthMethod;
}

/**
 * Derives a deterministic IntentsAccountId from a wallet address + chain family.
 * Single source of truth for identity derivation (D-131).
 *
 * Per-family address expectations:
 *   near    — accountId as-is (e.g. "bob.near")
 *   evm     — 0x hex address (lowercased)
 *   solana  — base58 public key
 *   ton     — hex-encoded Ed25519 public key (64 chars); NOT the EQ/UQ user address
 *   stellar — G… address (Stellar public key)
 *   tron    — T… base58check address
 */
export function deriveIntentsAccountId(
  address: string,
  chainKind: ChainKind,
): IntentsAccountId {
  return authIdentity.authHandleToIntentsUserId(
    address,
    toAuthMethod(chainKind),
  ) as IntentsAccountId;
}

/**
 * Anti-squat pre-check (H8.1c). True iff `address`+`chainKind` derive to
 * `expectedAccountId` (case-insensitive — every family's derivation is lowercase).
 *
 * This mirrors on the FE side the contract's `apply_setup` guard
 * `authHandleToIntentsUserId(login_wallet) == signer_id` (`allocate.rs:154`,
 * `E_ACCOUNT_ID_MISMATCH`) and the CC-004 binding `assert_signer_bound`: a signature
 * only proves *which wallet signed*, so a payload recorded under account A but signed by
 * wallet B is exactly what the contract rejects. Enforcing it here fails fast (good UX)
 * instead of shipping a signature the contract will bounce.
 *
 * Returns `false` on any derivation error (e.g. a TON identifier that is not a 64-hex
 * pubkey): a wallet whose identifier cannot be derived cannot be proven to match, so the
 * caller must treat it as a mismatch.
 */
export function walletMatchesAccount(
  address: string,
  chainKind: ChainKind,
  expectedAccountId: IntentsAccountId,
): boolean {
  try {
    return (
      deriveIntentsAccountId(address, chainKind).toLowerCase() ===
      expectedAccountId.toLowerCase()
    );
  } catch {
    return false;
  }
}

/** The two wallets involved in a mismatch, as the user knows them: by address. */
export type WalletMismatchAddresses = {
  /** The wallet this session belongs to — the one the user actually signed in with. */
  expectedAddress: string;
  /** The wallet the extension has active right now. */
  connectedAddress: string;
};

/** `CTFu9LhC…biCN58` — same 8/6 shape the account chip uses, so the two are comparable. */
function shortAddress(address: string): string {
  return address.length > 20 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

/**
 * Thrown when the live wallet about to sign does not resolve to the account the
 * operation is recorded under (the restored-identity-A vs live-wallet-B seam).
 *
 * Prefer the `addresses` form. Without it the message can only name the two *derived*
 * account ids, which are 64 hex characters the user has never seen and cannot map back to
 * anything in their wallet — reported by the operator on 2026-08-06 after hitting this for
 * real (008.plan F4.2): the guard did its job and stopped the withdrawal, but the wording
 * gave no way to know WHICH wallet to switch back to. Addresses are what the extension and
 * the account chip both show, so they are what the sentence should be about.
 *
 * The id-only form is kept for callers that genuinely have no address to hand, so this
 * never degrades into throwing a worse error than before.
 */
export class WalletAccountMismatchError extends Error {
  constructor(
    readonly expectedAccountId: IntentsAccountId,
    readonly connectedAccountId: string,
    readonly addresses?: WalletMismatchAddresses,
  ) {
    super(
      addresses
        ? `You are signed in as ${shortAddress(addresses.expectedAddress)}, but the wallet ` +
            `connected right now is ${shortAddress(addresses.connectedAddress)}. Switch back ` +
            `to that wallet in your extension, or sign out to use a different account.`
        : `The connected wallet resolves to account "${connectedAccountId}", but this ` +
            `action belongs to account "${expectedAccountId}". Reconnect the wallet you ` +
            `used to create this account and try again.`,
    );
    this.name = "WalletAccountMismatchError";
  }
}
