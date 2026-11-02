// Feature switch for depositing from the NEAR wallet (016 §5.3, block 2a, D-338).
//
// Default OFF: the "From your wallet" tab does not render and the Receive step is the QR step it
// has always been. It must stay off in Preview, because Preview is mock without exceptions
// (D-297) — and nothing else stops this path there: only /mock-dashboard nulls the sender. So
// `NEXT_PUBLIC_WALLET_DEPOSIT` is set in Vercel Production only, AND the vault switch must be on
// too: that one is already false in Preview, so a stray Preview entry for this variable still
// opens nothing (cross-review s197). D-357: it rode on the vault switch alone until then, which
// meant this path could not be turned off without turning off the vault; now it can.
//
// ⚠️ Next.js INLINES `NEXT_PUBLIC_` variables into the bundle at BUILD time: changing one in
// `.env.local` does nothing to an existing build. Rebuild and hard-reload.

import { VAULT_ROUNDTRIP_ENABLED } from "@/features/vault/lib/vault-flag";
import { evmWalletDepositToken } from "./evm-wallet-deposit";
import { isWalletDepositToken } from "./near-wallet-deposit";

export const WALLET_DEPOSIT_ENABLED =
  process.env.NEXT_PUBLIC_WALLET_DEPOSIT === "true" && VAULT_ROUNDTRIP_ENABLED;

/**
 * Whether the Receive step offers depositing `tokenId` straight from the wallet.
 *
 * Every condition closes on its own, and none has a default that opens:
 *   - the flag;
 *   - a NEAR login — the other five families have no NEAR account to send from;
 *   - a sender — null below `RealAllocateDisabled`, which is what keeps `/mock-dashboard` (whose
 *     QA identity presents as a NEAR login) from ever reaching a real wallet;
 *   - an account id to sign as — without it `signerId` would be empty and the wallet would pick;
 *   - a token this path serves (`walletDepositTarget`).
 */
export function isWalletDepositRoute(params: {
  hasSender: boolean;
  loginChain: string | null | undefined;
  accountId: string | null | undefined;
  tokenId: string;
}): boolean {
  if (!WALLET_DEPOSIT_ENABLED) return false;
  if (params.loginChain !== "near") return false;
  if (!params.hasSender) return false;
  if (!params.accountId) return false;
  return isWalletDepositToken(params.tokenId);
}

/**
 * D-445 part 2B: whether the Receive step offers depositing `tokenId` from the connected EVM
 * wallet. Same switch and same real-context sentinel as the NEAR route above; then:
 *   - the wallet plugged in is the session's own address (an EVM address is the account);
 *   - the wallet can send (`sendEvmTransaction` — only the EVM adapter publishes it);
 *   - a token this path serves (`EVM_WALLET_TOKENS`).
 */
export function isEvmWalletDepositRoute(params: {
  hasSender: boolean;
  sameWallet: boolean;
  canSend: boolean;
  tokenId: string;
}): boolean {
  if (!WALLET_DEPOSIT_ENABLED) return false;
  if (!params.hasSender) return false;
  if (!params.sameWallet) return false;
  if (!params.canSend) return false;
  return evmWalletDepositToken(params.tokenId) !== null;
}
