import type { TokenPrice, TokenPriceMap } from "@/features/market/types";
import type { NewPortfolioDraftRow } from "./new-portfolio-draft";

// D-358 — "With $10,000 your portfolio's targets would be approximately…": what a New Portfolio
// Draft would be made of, for an amount the user picks, at today's prices. A reference for
// someone still deciding, not a quote: no fees, no slippage, and the amounts move with the
// price. Nothing here touches funds or signatures; the amount is kept with the draft (D-457).

/** The amount a draft opens with until one is saved with it (D-358 (2), D-457). */
export const SIMULATION_DEFAULT_USD = 10_000;

/** The field's ceiling, so a held-down key cannot turn the list into exponent notation. */
export const SIMULATION_MAX_USD = 1_000_000_000;

export type SimulatedHolding = {
  tokenId: string;
  /** The row's share of the amount, in USD. Known with or without a price. */
  usd: number;
  /** Token units at today's price; null when there is no real price to divide by. */
  amount: number | null;
  /** The real price used, or null. Callers need it to format `amount` (decimals by price). */
  price: number | null;
};

/**
 * A price the simulation may divide by: a live or recently cached quote. The registry's
 * hand-written `fallbackUsdPrice` is not one — it never ages and can be several times off,
 * so showing units computed from it would present an invented number as real (D-179).
 */
export function isRealPrice(price: TokenPrice | undefined): price is TokenPrice {
  return !!price && price.source !== "fallback" && Number.isFinite(price.usdPrice) && price.usdPrice > 0;
}

export function simulateDraftHoldings(
  rows: readonly NewPortfolioDraftRow[],
  amountUsd: number,
  prices: TokenPriceMap
): SimulatedHolding[] {
  return rows.map((row) => {
    const usd = (amountUsd * Math.max(0, row.targetPct)) / 100;
    const quote = prices[row.tokenId];
    if (!isRealPrice(quote)) return { tokenId: row.tokenId, usd, amount: null, price: null };
    return { tokenId: row.tokenId, usd, amount: usd / quote.usdPrice, price: quote.usdPrice };
  });
}

const GROUPED_USD = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * The amount field's text (D-503): whole dollars grouped with commas while typing, in both
 * languages, as every USD amount in the app is (`formatUsd` is en-US). Cents are dropped on
 * purpose: with the comma taken by the thousands, "10,5" could no longer mean ten and a half,
 * and a preview at approximate prices gains nothing from them. A typed point is read as the
 * decimal point, so what follows it is cut, not glued on ("10.50" is $10, never $1,050).
 */
export function formatSimulationAmountInput(raw: string): string {
  const digits = raw.split(".")[0].replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (digits === "") return "";
  return GROUPED_USD.format(Math.min(Number(digits), SIMULATION_MAX_USD));
}

/** The dollars a field text from `formatSimulationAmountInput` stands for; 0 when empty. */
export function parseSimulationAmountInput(text: string): number {
  const digits = text.replace(/\D/g, "");
  return digits === "" ? 0 : Math.min(Number(digits), SIMULATION_MAX_USD);
}

/** Field text for a stored amount: rounded to whole dollars; empty below fifty cents. */
export function simulationAmountText(amountUsd: number): string {
  const whole = Math.round(amountUsd);
  return Number.isFinite(whole) && whole > 0 ? GROUPED_USD.format(Math.min(whole, SIMULATION_MAX_USD)) : "";
}
