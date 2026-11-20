// Browser side of `/api/deposit-address` (D-584): Receive's fixed address for an account on one
// network, from 1Click through our server. Replaces PoA's `getDepositAddress`, closed 2026-11-11.

export type DepositAddress = { address: string; memo?: string };

export async function getDepositAddress(accountId: string, chainId: string): Promise<DepositAddress> {
  const params = new URLSearchParams({ account: accountId, chain: chainId });
  const res = await fetch(`/api/deposit-address?${params}`, { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; address?: unknown; memo?: unknown; error?: unknown } | null;
  if (!res.ok || !body?.ok || typeof body.address !== "string" || body.address.length === 0) {
    throw new Error(typeof body?.error === "string" ? body.error : `Deposit address request failed (${res.status})`);
  }
  return typeof body.memo === "string" && body.memo.length > 0 ? { address: body.address, memo: body.memo } : { address: body.address };
}
