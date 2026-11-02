"use client";

// WHO can sign a live money path in this React tree (005.plan §8, Phase 5, block 5.4).
//
// Lifted verbatim out of PortfolioProvider, where it was a private memo, because the real
// withdrawal needs the same trio and duplicating it is how the two paths would drift on the
// question that matters most: which wallet is allowed to move real funds.
//
// Bundled rather than three parallel values: the signer, the chain recorded on-chain and
// the address the contract re-derives from MUST describe the same wallet. Returning them
// together makes a mismatched trio unrepresentable — and gives call sites the non-null
// chain they need without a cast.
//
// `realAllocateSigner` is required for EVERY family, not only NEAR, even though the five
// non-NEAR families do not sign with it. That context is the hard kill-switch for the whole
// live path (`RealAllocateDisabled` on /mock-dashboard), and QA must not be able to move
// real funds through ANY family — including a withdrawal, which does not touch the vault
// but does empty the General Balance.

import { useMemo } from "react";
import { useLoginWallet } from "@/features/login-wallet";
import { useRealAllocateSigner } from "../context/real-allocate-context";
import {
  ed25519VaultSigner,
  erc191VaultSigner,
  nep413VaultSigner,
  tip191VaultSigner,
  tonConnectVaultSigner,
  type NearSigner,
  type SignMessage,
  type VaultSigner,
} from "../lib/vault-signer";
import type { VaultChainKind } from "../lib/vault-payloads";

export type LiveSigner = {
  signer: VaultSigner;
  chain: VaultChainKind;
  address: string;
};

/**
 * Picks the signer for a login family (block 4.1).
 *
 * Split out of the memo below because the mapping is now a real decision per family rather
 * than "NEAR or not": each family signs the same flattened string but wraps it differently,
 * and two of them need the RAW wallet address instead of the intents account id (see
 * vault-signer.ts). Exhaustive by construction — a new family fails to compile here rather
 * than silently falling back to a scheme its wallet cannot produce.
 *
 * Exported for the mapping test: it is pure, and wiring a family to the wrong signer is not
 * something the hook's own types can catch.
 */
export function signerForFamily(
  family: VaultChainKind,
  deps: {
    intentsAccountId: string;
    address: string;
    signMessage: SignMessage;
    realAllocateSigner: NearSigner;
  }
): VaultSigner {
  const { intentsAccountId, address, signMessage, realAllocateSigner } = deps;
  switch (family) {
    case "near":
      return nep413VaultSigner(realAllocateSigner, intentsAccountId);
    case "evm":
      return erc191VaultSigner(signMessage, intentsAccountId);
    case "tron":
      return tip191VaultSigner(signMessage, intentsAccountId);
    case "solana":
    case "stellar":
      return ed25519VaultSigner({
        signMessage,
        family,
        signerId: intentsAccountId,
        walletAddress: address,
      });
    case "ton":
      // The TON adapter already reports the hex public key as its address (ton-bridge.tsx),
      // which is what both the account derivation and the SDK need.
      return tonConnectVaultSigner(signMessage, intentsAccountId, address);
  }
}

/**
 * The live signer for this login, or null when the real path is unavailable in this tree.
 *
 * NEAR keeps NEP-413 through the HOT Connect wallet; the other five sign the flattened
 * DefusePayload through the login adapter they already use for every other signature in
 * the app, each in its own scheme.
 */
export function useLiveSigner(): LiveSigner | null {
  const { intentsAccountId, signMessage, family: loginChainKind, connection } = useLoginWallet();
  // null outside the RealAllocateProvider (e.g. /mock-dashboard) — the real path is then
  // simply unavailable and everything falls back to the mock.
  const realAllocateSigner = useRealAllocateSigner();

  return useMemo<LiveSigner | null>(() => {
    if (!intentsAccountId || !loginChainKind || !realAllocateSigner || !connection) return null;
    return {
      signer: signerForFamily(loginChainKind, {
        intentsAccountId,
        address: connection.address,
        signMessage,
        realAllocateSigner,
      }),
      chain: loginChainKind,
      address: connection.address,
    };
  }, [intentsAccountId, loginChainKind, realAllocateSigner, signMessage, connection]);
}
