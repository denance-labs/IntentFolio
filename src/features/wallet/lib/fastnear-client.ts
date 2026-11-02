const FASTNEAR_BASE_URL = "https://api.fastnear.com";
const FASTNEAR_TIMEOUT_MS = 8_000;

export type FastNearFt = {
  contract_id: string;
  balance: string;
  last_update_block_height: number;
};

type FastNearFtsResponse = {
  account_id: string;
  tokens: FastNearFt[];
};

// Returns [] on any error so callers can fall back gracefully.
export async function fastnearListFts(accountId: string): Promise<FastNearFt[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FASTNEAR_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${FASTNEAR_BASE_URL}/v1/account/${encodeURIComponent(accountId)}/ft`,
      { signal: controller.signal }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as FastNearFtsResponse;
    return data.tokens ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
