"use client";

import { useQuery } from "@tanstack/react-query";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import {
  NEAR_REGISTRY_TOKEN_ID,
  WNEAR_INTENTS_TOKEN_ID,
} from "@/features/market/lib/intents-token-id";
import { BROWSER_RPC_URL, INTENTS_CONTRACT_ID } from "../config/network";
import { fetchMtBatchBalance } from "../lib/balance-fetcher";

// Token ID (Defuse asset id) → human-readable quantity (raw / 10^decimals)
export type IntentsBalances = Map<string, number>;

type TokenMapping = { registryId: string; intentsTokenId: string; decimals: number };

// Registry ids ARE the canonical Defuse asset ids, so nep141: and nep245: both go
// through unchanged. NEP-245 (HOT Omni) is not a special case here: once bridged into
// Intents, intents.near carries the balance under the very same
// "nep245:v2_1.omni.hot.tg:<id>" key.
//
// This used to skip nep245 with the justification "they are HOT Bridge
// (v2_1.omni.hot.tg), not intents.near". That fact is true of the *wallet* reader —
// use-wallet-balances.ts:61 strips the prefix and queries that contract directly —
// but not of the General Balance, which lives inside intents.near and holds both
// standards. The consequence was that 13 depositable tokens were offered by the
// Receive modal and their balance was never even asked for (D-175 / ADR-0016).
// Verified 2026-07-30: intents.near custodies nonzero HOT Omni balances at
// v2_1.omni.hot.tg, and all 13 registry nep245 ids match the canonical
// 1click.chaindefuser.com/v0/tokens asset ids, decimals included.
//
// NEAR native (id:"near") has no contractId; map to wNEAR token_id in intents.near.
function buildTokenMappings(): TokenMapping[] {
  return tokenRegistry.flatMap((t) => {
    // NEAR native lives in intents.near as wNEAR; map it back to the "near" registry key.
    // The write half of this same mapping is `toIntentsTokenId` — keep them together.
    if (t.id === NEAR_REGISTRY_TOKEN_ID) {
      return [
        {
          registryId: NEAR_REGISTRY_TOKEN_ID,
          intentsTokenId: WNEAR_INTENTS_TOKEN_ID,
          decimals: t.decimals,
        },
      ];
    }
    if (t.id.startsWith("nep141:") || t.id.startsWith("nep245:")) {
      return [{ registryId: t.id, intentsTokenId: t.id, decimals: t.decimals }];
    }
    return [];
  });
}

// Computed once at module load; token registry is static.
const TOKEN_MAPPINGS = buildTokenMappings();
const INTENTS_TOKEN_IDS = TOKEN_MAPPINGS.map((m) => m.intentsTokenId);

/**
 * The cache key, exported rather than spelled out at each site.
 *
 * Callers outside this hook read the cache directly — the gas purchase watches this very
 * balance to know the gas landed (D-251) — and a key that drifted from this one would not
 * fail loudly: `getQueryData` would answer `undefined` and the reader would conclude the
 * money never arrived. One definition means that drift cannot happen.
 */
export function intentsBalancesQueryKey(intentsAccountId: string) {
  return ["intents-balances", intentsAccountId] as const;
}

export function useIntentsBalances(intentsAccountId: string) {
  return useQuery({
    queryKey: intentsBalancesQueryKey(intentsAccountId),
    queryFn: async (): Promise<IntentsBalances> => {
      if (!intentsAccountId) return new Map();
      const rpcUrl = BROWSER_RPC_URL;
      const rawBalances = await fetchMtBatchBalance(
        intentsAccountId,
        INTENTS_CONTRACT_ID,
        INTENTS_TOKEN_IDS,
        rpcUrl
      );
      const result = new Map<string, number>();
      for (let i = 0; i < TOKEN_MAPPINGS.length; i++) {
        const { registryId, decimals } = TOKEN_MAPPINGS[i];
        const raw = rawBalances[i] ?? "0";
        const qty = Number(BigInt(raw)) / 10 ** decimals;
        if (qty > 0) result.set(registryId, qty);
      }
      return result;
    },
    enabled: !!intentsAccountId,
    staleTime: 5 * 60 * 1000,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8_000),
    refetchOnWindowFocus: true,
  });
}
