// Browser side of the in-flight trade read (D-471). One GET, a 2 s budget, and every failure
// reads as "no trade": the wait narrows a race, it never guards funds (solver 945 D3).

const ENDPOINT = "/api/ops/portfolio-trade-in-flight";

/** Past this the modal stops waiting for an answer and lets the user go ahead. */
export const TRADE_IN_FLIGHT_TIMEOUT_MS = 2_000;

export type TradeInFlightAnswer = { inFlight: boolean; remainingMs: number };

const GO_AHEAD: TradeInFlightAnswer = { inFlight: false, remainingMs: 0 };

export async function fetchTradeInFlight(
  portfolioId: string,
  fetchImpl: typeof fetch = fetch
): Promise<TradeInFlightAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRADE_IN_FLIGHT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${ENDPOINT}?portfolio=${encodeURIComponent(portfolioId)}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return GO_AHEAD;
    const body = (await response.json()) as { ok?: unknown; inFlight?: unknown; remainingMs?: unknown };
    if (body.ok !== true || body.inFlight !== true) return GO_AHEAD;
    const remainingMs = Number(body.remainingMs);
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return GO_AHEAD;
    return { inFlight: true, remainingMs };
  } catch {
    return GO_AHEAD;
  } finally {
    clearTimeout(timer);
  }
}
