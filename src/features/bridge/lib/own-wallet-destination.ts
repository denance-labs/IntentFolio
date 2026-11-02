import type { LoginWalletConnection } from "@/features/login-wallet";
import { familyForChainId } from "./family-validation";

/**
 * The address «Use my wallet» fills into the withdrawal destination, or null when the button
 * must not show (016 §5.1, 1.2).
 *
 * It only ever PREFILLS the input: address validation, the wrong-chain check and the
 * destination pre-flights all run on the value exactly as if the user had typed it.
 *
 * Shown only when the destination chain belongs to the login wallet's own family, because
 * that is the one case where the login address is also a receiving address there:
 * - EVM: one address for every EVM chain. Safe because the login is an EOA — intents.near
 *   verifies the login signature by ERC-191 ecrecover, which a contract wallet cannot pass,
 *   so the same address is controlled by the same key on every chain.
 * - NEAR / Solana / Stellar / Tron: the stored address is the account itself.
 * - TON: never. The stored address is the wallet's 64-hex PUBLIC KEY, not its EQ… user
 *   address (`LoginWalletConnection.address`), so it is not a destination at all.
 * Chains with no login family (BTC, Aptos, Sui…) return null through `familyForChainId`.
 */
export function ownWalletDestination(
  connection: LoginWalletConnection | null,
  chainId: string
): string | null {
  if (!connection || !connection.address) return null;
  if (connection.chainKind === "ton") return null;
  return familyForChainId(chainId) === connection.chainKind ? connection.address : null;
}
