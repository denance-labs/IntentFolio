import { poaBridge } from "@defuse-protocol/internal-utils";

// Attribution: see ATTRIBUTIONS.md #4 (wraps internal-utils — re-review on version bump).
// Pinned: @defuse-protocol/internal-utils@0.34.0
// Thin adapter over poaBridgeHttpClient. Keeps internal-utils as an implementation detail.
// Route handler (supported-tokens) calls getSupportedTokens server-side.
// getDepositAddress / getDepositStatus / getPendingDeposits are called client-side (per-user).

export type BridgeChainId = string; // e.g., "eth:1", "near:mainnet", "stellar:mainnet"

export type SupportedToken = Awaited<
  ReturnType<typeof poaBridge.httpClient.getSupportedTokens>
>["tokens"][number];

export type DepositAddressResult = Awaited<
  ReturnType<typeof poaBridge.httpClient.getDepositAddress>
>;

export type DepositStatusEntry = Awaited<
  ReturnType<typeof poaBridge.httpClient.getDepositStatus>
>["deposits"][number];

export type PendingDeposit = Awaited<
  ReturnType<typeof poaBridge.getPendingDeposits>
>[number];

export async function getSupportedTokens(
  chains?: BridgeChainId[]
): Promise<SupportedToken[]> {
  const result = await poaBridge.httpClient.getSupportedTokens({ chains });
  return result.tokens;
}

export async function getDepositAddress(
  accountId: string,
  chain: BridgeChainId,
  depositMode?: "MEMO" | "SIMPLE"
): Promise<DepositAddressResult> {
  return poaBridge.httpClient.getDepositAddress({
    account_id: accountId,
    chain,
    ...(depositMode !== undefined && { deposit_mode: depositMode }),
  });
}

export async function getDepositStatus(
  accountId: string,
  opts?: { chain?: BridgeChainId; limit?: number; offset?: number }
): Promise<{ deposits: DepositStatusEntry[]; total: number; limit: number; offset: number }> {
  return poaBridge.httpClient.getDepositStatus({ account_id: accountId, ...opts });
}

export async function getPendingDeposits(
  accountId: string
): Promise<PendingDeposit[]> {
  type InternalId = Parameters<typeof poaBridge.getPendingDeposits>[0];
  return poaBridge.getPendingDeposits(accountId as InternalId);
}
