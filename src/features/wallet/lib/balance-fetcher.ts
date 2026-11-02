const RPC_TIMEOUT_MS = 10_000;

type RpcRequest = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: Record<string, unknown>;
};

type ViewAccountResult = {
  amount: string;
};

type CallFunctionResult = {
  result: number[];
  logs: string[];
  block_height: number;
  block_hash: string;
  error?: string;
};

type RpcResponse<T> = {
  result?: T;
  error?: { code: number; message: string; data?: string };
};

async function rpcPost<T>(rpcUrl: string, body: RpcRequest): Promise<RpcResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    return res.json() as Promise<RpcResponse<T>>;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNativeNearBalance(accountId: string, rpcUrl: string): Promise<bigint> {
  const res = await rpcPost<ViewAccountResult>(rpcUrl, {
    jsonrpc: "2.0",
    id: "view_account",
    method: "query",
    params: { request_type: "view_account", finality: "final", account_id: accountId },
  });
  if (res.error) throw new Error(res.error.message);
  return BigInt(res.result!.amount);
}

export type NearAccountState = {
  /** Liquid balance, in yocto. */
  amount: bigint;
  /** Bytes the account occupies on chain; each one pins `storage_amount_per_byte` yocto. */
  storageUsage: bigint;
};

/**
 * `view_account` with the storage figure `fetchNativeNearBalance` drops (016 §5.3, block 2a).
 *
 * Fails CLOSED on a result it cannot read: the caller turns this into the most a user may send,
 * and a missing field read as zero would be a made-up balance.
 */
export async function fetchNearAccountState(
  accountId: string,
  rpcUrl: string
): Promise<NearAccountState> {
  const res = await rpcPost<{ amount?: unknown; storage_usage?: unknown }>(rpcUrl, {
    jsonrpc: "2.0",
    id: "view_account",
    method: "query",
    params: { request_type: "view_account", finality: "final", account_id: accountId },
  });
  if (res.error) throw new Error(res.error.message);
  const amount = res.result?.amount;
  const storageUsage = res.result?.storage_usage;
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
    throw new Error(`view_account ${accountId}: unreadable amount`);
  }
  if (typeof storageUsage !== "number" || !Number.isSafeInteger(storageUsage) || storageUsage < 0) {
    throw new Error(`view_account ${accountId}: unreadable storage_usage`);
  }
  return { amount: BigInt(amount), storageUsage: BigInt(storageUsage) };
}

export async function fetchFtBalance(
  accountId: string,
  contractId: string,
  rpcUrl: string
): Promise<bigint> {
  const argsBase64 = btoa(JSON.stringify({ account_id: accountId }));
  const res = await rpcPost<CallFunctionResult>(rpcUrl, {
    jsonrpc: "2.0",
    id: "ft_balance_of",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: "ft_balance_of",
      args_base64: argsBase64,
    },
  });
  if (res.error) throw new Error(res.error.message);
  const callResult = res.result!;
  // NEP-145: unregistered account triggers a wasm panic → result.error is set; treat as zero.
  if (callResult.error) return BigInt(0);
  const text = new TextDecoder().decode(new Uint8Array(callResult.result));
  return BigInt(JSON.parse(text) as string);
}

export async function fetchMtBalance(
  accountId: string,
  contractId: string,
  tokenId: string,
  rpcUrl: string
): Promise<bigint> {
  const argsBase64 = btoa(JSON.stringify({ account_id: accountId, token_id: tokenId }));
  const res = await rpcPost<CallFunctionResult>(rpcUrl, {
    jsonrpc: "2.0",
    id: "mt_balance_of",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: "mt_balance_of",
      args_base64: argsBase64,
    },
  });
  if (res.error) throw new Error(res.error.message);
  const callResult = res.result!;
  if (callResult.error) return BigInt(0);
  const text = new TextDecoder().decode(new Uint8Array(callResult.result));
  return BigInt(JSON.parse(text) as string);
}

export async function fetchMtBatchBalance(
  accountId: string,
  contractId: string,
  tokenIds: string[],
  rpcUrl: string
): Promise<string[]> {
  if (tokenIds.length === 0) return [];
  const argsBase64 = btoa(JSON.stringify({ account_id: accountId, token_ids: tokenIds }));
  const res = await rpcPost<CallFunctionResult>(rpcUrl, {
    jsonrpc: "2.0",
    id: "mt_batch_balance_of",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: "mt_batch_balance_of",
      args_base64: argsBase64,
    },
  });
  if (res.error) throw new Error(res.error.message);
  const callResult = res.result!;
  if (callResult.error) return tokenIds.map(() => "0");
  const text = new TextDecoder().decode(new Uint8Array(callResult.result));
  return JSON.parse(text) as string[];
}

export async function fetchNearUnified(
  accountId: string,
  wnearContractId: string,
  rpcUrl: string
): Promise<bigint> {
  const [native, wrapped] = await Promise.all([
    fetchNativeNearBalance(accountId, rpcUrl),
    fetchFtBalance(accountId, wnearContractId, rpcUrl),
  ]);
  return native + wrapped;
}
