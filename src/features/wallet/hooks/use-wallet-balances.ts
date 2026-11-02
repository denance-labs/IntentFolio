"use client";

import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import { useWallet } from "@/features/dashboard-shell/context/wallet-context";
import { BROWSER_RPC_URL, WNEAR_CONTRACT_ID } from "../config/network";
import { fetchFtBalance, fetchMtBalance, fetchNearUnified } from "../lib/balance-fetcher";
import { fastnearListFts } from "../lib/fastnear-client";
import { fetchFtMetadata } from "../lib/ft-metadata";
import type { TokenDefinition } from "@/features/market/types";

// Keys are token.id (not symbol) — symbols are not unique across the registry (e.g. two ETH entries).
export type WalletBalances = Record<string, number>;

export type WalletBalancesResult = {
  balances: WalletBalances;
  // Tokens discovered via FastNear that are not in the curated registry.
  // Always depositable: false — shown in wallet view for visibility only.
  unknownTokens: TokenDefinition[];
};

// Allows mock/test code to inject hardcoded balances without hitting the network.
// When a provider is present in the tree, useWalletBalances returns its value immediately.
// The provider component lives in mock-wallet-balances-provider.tsx (needs JSX / .tsx).
export const WalletBalancesOverrideContext = createContext<WalletBalancesResult | null>(null);

// Registry NEP-141 tokens indexed by contractId for O(1) lookup during FastNear discovery.
const registryByContractId = new Map<string, TokenDefinition>(
  tokenRegistry
    .filter((t) => t.contractId !== null && t.id.startsWith("nep141:"))
    .map((t) => [t.contractId!, t])
);

// NEAR native and NEP-245 tokens: FastNear covers NEP-141 only, so these go via RPC.
const rpcOnlyTokens = tokenRegistry.filter(
  (t) => t.symbol === "NEAR" || t.id.startsWith("nep245:")
);

// Registry NEP-141 tokens used only in the FastNear-down fallback path.
const registryNep141Tokens = tokenRegistry.filter(
  (t) => t.id.startsWith("nep141:") && t.contractId !== null
);

export function useWalletBalances() {
  const override = useContext(WalletBalancesOverrideContext);
  const { signedAccountId } = useWallet();
  return useQuery({
    queryKey: ["wallet-balances", signedAccountId, override ? "mock" : "real"],
    queryFn: async (): Promise<WalletBalancesResult> => {
      if (override) return override;
      if (!signedAccountId) return { balances: {}, unknownTokens: [] };
      const rpcUrl = BROWSER_RPC_URL;

      // Always fetch NEAR native and NEP-245 tokens via RPC (FastNear doesn't index these).
      const rpcResults = await Promise.allSettled(
        rpcOnlyTokens.map(async (token) => {
          let raw: bigint;
          if (token.symbol === "NEAR") {
            raw = await fetchNearUnified(signedAccountId, WNEAR_CONTRACT_ID, rpcUrl);
          } else if (token.id.startsWith("nep245:")) {
            // NEP-245 (HOT Omni): token id encodes contractId + tokenId as "nep245:contract:tokenId"
            const mtTokenId = token.id.split(":").slice(2).join(":");
            raw = await fetchMtBalance(signedAccountId, token.contractId!, mtTokenId, rpcUrl);
          } else {
            raw = await fetchFtBalance(signedAccountId, token.contractId!, rpcUrl);
          }
          return [token.id, Number(raw) / 10 ** token.decimals] as const;
        })
      );
      const rpcBalances: WalletBalances = Object.fromEntries(
        rpcResults.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
      );

      // Discover all NEP-141 tokens the account has ever touched via FastNear indexer.
      const fastnearFts = await fastnearListFts(signedAccountId);

      if (fastnearFts.length === 0) {
        // FastNear down or new account with no FT history — fall back to registry RPC.
        const fallbackResults = await Promise.allSettled(
          registryNep141Tokens.map(async (token) => {
            const raw = await fetchFtBalance(signedAccountId, token.contractId!, rpcUrl);
            return [token.id, Number(raw) / 10 ** token.decimals] as const;
          })
        );
        const rpcAllFailed = rpcResults.every((r) => r.status === "rejected");
        const fallbackAllFailed = fallbackResults.every((r) => r.status === "rejected");
        // FastNear empty + RPC totally unreachable → no source produced any data; surface as error.
        if (rpcAllFailed && fallbackAllFailed) {
          throw new Error("All balance sources unavailable");
        }
        const fallbackBalances: WalletBalances = Object.fromEntries(
          fallbackResults.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
        );
        return { balances: { ...fallbackBalances, ...rpcBalances }, unknownTokens: [] };
      }

      // Resolve each discovered FT: registry token (use curated def) or unknown (fetch metadata).
      const unknownTokens: TokenDefinition[] = [];
      const discoveredResults = await Promise.allSettled(
        fastnearFts
          .filter((ft) => ft.contract_id !== WNEAR_CONTRACT_ID) // wNEAR included in NEAR unified
          .filter((ft) => ft.balance !== "0")                   // zero-balance: skip
          .map(async (ft) => {
            const registryToken = registryByContractId.get(ft.contract_id);
            const token = registryToken ?? (await fetchFtMetadata(ft.contract_id, rpcUrl));
            if (!token) return null;
            if (!registryToken) unknownTokens.push(token);
            const balance = Number(BigInt(ft.balance)) / 10 ** token.decimals;
            return [token.id, balance] as const;
          })
      );
      const discoveredBalances: WalletBalances = Object.fromEntries(
        discoveredResults.flatMap((r) =>
          r.status === "fulfilled" && r.value !== null ? [r.value] : []
        )
      );

      return {
        balances: { ...discoveredBalances, ...rpcBalances },
        unknownTokens,
      };
    },
    initialData: override ?? undefined,
    enabled: !!signedAccountId,
    staleTime: 5 * 60 * 1000,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    refetchOnWindowFocus: true,
  });
}
