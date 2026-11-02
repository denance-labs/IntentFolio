import type { ChainKind } from "../types";
import type { IntentsAccountId } from "@/features/intents-account/mock-contract/types";

const LAST_USED_FAMILY_KEY = "intentfolio.lastUsedWalletFamily";
const IDENTITY_KEY = "intentfolio.identity";
const NEAR_KEY_PROOF_KEY = "intentfolio.near-key-proof.v1";

export type PersistedIdentity = {
  chainKind: ChainKind;
  address: string;
  intentsAccountId: IntentsAccountId;
};

/** A public tuple previously proven by a NEP-413 signature. */
export type PersistedNearKeyProof = {
  accountId: string;
  walletId: string;
  publicKey: string;
};

export function readLastUsedFamily(): ChainKind | null {
  try {
    const raw = localStorage.getItem(LAST_USED_FAMILY_KEY);
    return raw as ChainKind | null;
  } catch {
    return null;
  }
}

export function writeLastUsedFamily(chainKind: ChainKind): void {
  try {
    localStorage.setItem(LAST_USED_FAMILY_KEY, chainKind);
  } catch {
    // storage unavailable — silently ignore
  }
}

export function readIdentity(): PersistedIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedIdentity;
  } catch {
    return null;
  }
}

export function writeIdentity(identity: PersistedIdentity): void {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // storage unavailable — silently ignore
  }
}

export function readNearKeyProof(): PersistedNearKeyProof | null {
  try {
    const raw = localStorage.getItem(NEAR_KEY_PROOF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedNearKeyProof>;
    if (
      typeof parsed.accountId !== "string" ||
      typeof parsed.walletId !== "string" ||
      typeof parsed.publicKey !== "string" ||
      !parsed.accountId ||
      !parsed.walletId ||
      !parsed.publicKey
    ) {
      return null;
    }
    return {
      accountId: parsed.accountId,
      walletId: parsed.walletId,
      publicKey: parsed.publicKey,
    };
  } catch {
    return null;
  }
}

export function writeNearKeyProof(proof: PersistedNearKeyProof): void {
  try {
    localStorage.setItem(NEAR_KEY_PROOF_KEY, JSON.stringify(proof));
  } catch {
    // storage unavailable — the safe fallback is a fresh verification on reload
  }
}

export function clearNearKeyProof(): void {
  try {
    localStorage.removeItem(NEAR_KEY_PROOF_KEY);
  } catch {
    // storage unavailable — silently ignore
  }
}

/**
 * Clears the signed-in session. Deliberately does NOT touch LAST_USED_FAMILY_KEY:
 * that key is a UI preference (the "Recent" badge on the wallet picker) and outliving
 * sign-out is the whole point of it — a returning user should still be offered the
 * wallet they used last. The identity and its NEAR ownership proof are session data.
 *
 * Because the family key survives, whatever restores `activeFamily` on mount must gate
 * on the identity rather than on the family alone, or signing out would remount the
 * family's adapter and let a still-live SDK connection silently sign the user back in.
 */
export function clearIdentity(): void {
  try {
    localStorage.removeItem(IDENTITY_KEY);
    localStorage.removeItem(NEAR_KEY_PROOF_KEY);
  } catch {
    // storage unavailable — silently ignore
  }
}
