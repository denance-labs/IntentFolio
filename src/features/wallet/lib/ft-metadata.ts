import type { TokenDefinition } from "@/features/market/types";

const METADATA_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — ft_metadata is immutable in practice
const LS_PREFIX = "ft_metadata_cache_";

type CacheEntry = { def: TokenDefinition; expiresAt: number };

const inMemoryCache = new Map<string, CacheEntry>();

type FtMetadataRpc = {
  name: string;
  symbol: string;
  decimals: number;
};

type CallFunctionResult = {
  result: number[];
  error?: string;
};

type RpcResponse<T> = {
  result?: T;
  error?: { code: number; message: string };
};

async function fetchFtMetadataRpc(
  contractId: string,
  rpcUrl: string
): Promise<FtMetadataRpc | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "ft_metadata",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: contractId,
          method_name: "ft_metadata",
          args_base64: btoa("{}"),
        },
      }),
    });
    if (!res.ok) return null;
    const rpcData = (await res.json()) as RpcResponse<CallFunctionResult>;
    if (rpcData.error || !rpcData.result || rpcData.result.error) return null;
    const text = new TextDecoder().decode(new Uint8Array(rpcData.result.result));
    return JSON.parse(text) as FtMetadataRpc;
  } catch {
    return null;
  }
}

function lsGet(contractId: string): TokenDefinition | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + contractId);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() > entry.expiresAt) {
      localStorage.removeItem(LS_PREFIX + contractId);
      return null;
    }
    return entry.def;
  } catch {
    return null;
  }
}

function lsSet(contractId: string, def: TokenDefinition): void {
  try {
    const entry: CacheEntry = { def, expiresAt: Date.now() + METADATA_TTL_MS };
    localStorage.setItem(LS_PREFIX + contractId, JSON.stringify(entry));
  } catch {
    // localStorage full or unavailable — in-memory cache still works
  }
}

// Exposed for tests only.
export function _clearFtMetadataCache(): void {
  inMemoryCache.clear();
}

export async function fetchFtMetadata(
  contractId: string,
  rpcUrl: string
): Promise<TokenDefinition | null> {
  const cached = inMemoryCache.get(contractId);
  if (cached && Date.now() < cached.expiresAt) return cached.def;

  const lsCached = lsGet(contractId);
  if (lsCached) {
    inMemoryCache.set(contractId, { def: lsCached, expiresAt: Date.now() + METADATA_TTL_MS });
    return lsCached;
  }

  const meta = await fetchFtMetadataRpc(contractId, rpcUrl);
  if (!meta) return null;

  const def: TokenDefinition = {
    id: `nep141:${contractId}`,
    symbol: meta.symbol,
    name: meta.name,
    contractId,
    decimals: meta.decimals,
    category: "Other",
    fallbackUsdPrice: 0,
    depositable: false,
  };

  inMemoryCache.set(contractId, { def, expiresAt: Date.now() + METADATA_TTL_MS });
  lsSet(contractId, def);
  return def;
}
