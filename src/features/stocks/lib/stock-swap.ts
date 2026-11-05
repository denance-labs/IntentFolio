// Swaps a stablecoin and an Ondo tokenized stock inside the Funding Account through 1Click. Production
// only sells (`StockSellModal`, plan 039). The operator's `/stocks-test` screen, behind
// `NEXT_PUBLIC_STOCKS_TEST`, also buys.
//
// Attribution: see ATTRIBUTIONS.md #24 (Ondo asset ids from near.com's public bundle) and #13
// (1Click API v0 `/v0/quote`).
//
// 🔴 THE TRUST IS A CONVERTING WITHDRAWAL'S (ADR-0024). The signed `transfer` puts the input in
// 1Click's deposit account until it delivers or refunds, so the request is the contract and the
// response is only believed where it repeats it. The guards mirror `quoteConversion` and
// `buildConversionSignRequest`, which cannot be reused as they are: both refuse any pair outside
// the same-asset delivery table, and a stock is by definition a different asset.
//
// ⚠️ WHAT IS NOT INDEPENDENT. `MAX_COST_BPS` over 1Click's own USD figures would pass a wrong
// valuation. A sale is also held against `referenceUsdPrice` when the screen has a recent one. Without
// one, `StockSellModal` refuses anything worth more than `MAX_TRADE_USD` at the registry's own price,
// which owes nothing to 1Click. Below that, what remains is the USDC shown before signing and the
// guaranteed minimum.
//
// WHAT WAS MEASURED (2026-11-04, US pre-market, dry quotes): these stocks cost 39–85 bps on 100 USDT,
// 20 of them 1Click's fee. AAPLon holds ~53 bps up to 10 000 USDT and has no quote at
// 100 000. Below roughly US$5–7 the answer is "No liquidity available", in both directions.

import { messageFactory, config } from "@defuse-protocol/internal-utils";
import type { Intent } from "@defuse-protocol/contract-types";
import { toIntentsTokenId } from "@/features/market/lib/intents-token-id";
import { STOCK_TOKENS, isStockToken } from "@/features/market/lib/stock-tokens";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import { CONVERSION_MIN_QUOTE_REMAINING_SECS, CONVERSION_TRANSFER_DEADLINE_MARGIN_SECS } from "@/features/bridge/lib/conversion-envelope";
import { ONE_CLICK_BASE_URL } from "@/features/bridge/lib/oneclick-base-url";
import { CONVERSION_QUOTE_DEADLINE_SECS } from "@/features/bridge/lib/oneclick-conversion-quote";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";

/** Only the `/stocks-test` route. Next.js inlines this at build time: it has to stay a static literal. */
export const STOCK_TEST_ENABLED = process.env.NEXT_PUBLIC_STOCKS_TEST === "true";

export type FundingAsset = { label: string; id: string; decimals: number };

/**
 * What a test trade may pay with and be paid back in. Each row is its own balance: USDC on one
 * chain does not add to USDC on another, and a swap spends from exactly one of them.
 */
export const STOCK_TEST_FUNDING_ASSETS: readonly FundingAsset[] = [
  { label: "USDT (NEAR)", id: "nep141:usdt.tether-token.near", decimals: 6 },
  { label: "USDC (NEAR)", id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
  { label: "USDC (Ethereum)", id: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", decimals: 6 },
  { label: "USDC (Base)", id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6 },
  { label: "USDC (Arbitrum)", id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6 },
  { label: "USDC (Solana)", id: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", decimals: 6 },
];
/** Every Ondo token on NEAR reports 18 decimals (`ft_metadata`, read on-chain 2026-11-04). */
export const STOCK_DECIMALS = 18;

export type StockAsset = { ticker: string; name: string; id: string; decimals: number };

// What `/stocks-test` swaps against the funding assets: the stocks first, then every other token in the
// app, so whoever funds a test can get what its portfolio needs (operator, plan 039).
export const STOCK_TEST_ASSETS: readonly StockAsset[] = [
  ...STOCK_TOKENS.map((token) => ({ ticker: token.symbol, name: token.name, id: token.id, decimals: token.decimals })),
  ...tokenRegistry
    .filter((token) => !isStockToken(token.id))
    .map((token) => ({ ticker: token.symbol, name: token.name, id: toIntentsTokenId(token.id), decimals: token.decimals })),
];

/** Where a sale lands in Production: the Funding Account's USDC on NEAR. */
export const STOCK_SALE_ASSET: FundingAsset = STOCK_TEST_FUNDING_ASSETS[1];

/** The most one trade on the operator's `/stocks-test` screen may move, in USD, in either direction. */
export const MAX_TRADE_USD = 120;
/** About twice the worst one-way cost measured on these stocks. Past it, nothing is signed. */
export const MAX_COST_BPS = 200;
/** A price older than this is no reference for a sale, however it reached the screen. */
export const STOCK_REFERENCE_MAX_AGE_MS = 15 * 60_000;
/** A quote older than this is re-priced instead of signed: the market keeps moving. */
export const STOCK_QUOTE_MAX_AGE_MS = 60_000;
const SLIPPAGE_BPS = 100;

const ZERO = BigInt(0);
const BPS = BigInt(10_000);
const DEPOSIT_ADDRESS_RE = /^[0-9a-f]{64}$/;

export type StockSwapSide = "buy" | "sell";

export type StockSwapQuote = {
  side: StockSwapSide;
  stock: StockAsset;
  funding: FundingAsset;
  originAsset: string;
  destinationAsset: string;
  /** The signer's intents account: the recipient, and where a failed swap is refunded. */
  accountId: string;
  /** The ceiling this quote was asked under, asked again before signing. `null`: none. */
  maxTradeUsd: number | null;
  depositAddress: string;
  amountInRaw: string;
  amountOutRaw: string;
  minAmountOutRaw: string;
  amountInUsd: number;
  amountOutUsd: number;
  costBps: number;
  requestedDeadlineMs: number;
  quoteDeadlineMs: number;
  timeEstimateSecs: number | null;
  signature: string;
  quotedAtMs: number;
};

export type StockSwapRefusal = "no_liquidity" | "cost_too_high" | "unavailable";

export type StockSwapQuoteResult =
  | { ok: true; quote: StockSwapQuote }
  /** `detail` is for the operator's screen. A product screen says something from `reason`. */
  | { ok: false; reason: StockSwapRefusal; detail: string };

export type StockSwapQuoteParams = {
  side: StockSwapSide;
  stock: StockAsset;
  funding: FundingAsset;
  amountRaw: string;
  accountId: string;
  /** Required so no caller drops it by omission. `null`: no ceiling, the amount is the user's. */
  maxTradeUsd: number | null;
  /** A live price of the stock from outside 1Click, to hold a sale against. Optional by nature. */
  referenceUsdPrice?: number | null;
  signal?: AbortSignal;
  deps?: { fetchImpl?: typeof fetch; now?: () => number };
};

function isBaseUnitString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function positiveUsd(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isAllowedPair(side: StockSwapSide, origin: string, destination: string): boolean {
  const stockId = side === "buy" ? destination : origin;
  const fundingId = side === "buy" ? origin : destination;
  return (
    origin !== destination &&
    STOCK_TEST_FUNDING_ASSETS.some((asset) => asset.id === fundingId) &&
    STOCK_TEST_ASSETS.some((asset) => asset.id === stockId)
  );
}

/** "12.5" → base units as a string, or `null` when it is not a positive amount at these decimals. */
export function parseAmountToRaw(value: string, decimals: number): string | null {
  const text = value.trim().replace(",", ".");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  const raw = BigInt(match[1] + fraction.padEnd(decimals, "0"));
  return raw > ZERO ? raw.toString() : null;
}

/** Base units → text, cut (never rounded up) to `maxFraction` digits. */
export function formatRaw(raw: bigint | string, decimals: number, maxFraction = 6): string {
  const padded = raw.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals, padded.length - decimals + maxFraction).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** USD per whole stock token, as 1Click values it inside this quote. */
export function impliedStockPriceUsd(quote: StockSwapQuote): number {
  const raw = quote.side === "buy" ? quote.amountOutRaw : quote.amountInRaw;
  const usd = quote.side === "buy" ? quote.amountOutUsd : quote.amountInUsd;
  return usd / (Number(raw) / 10 ** quote.stock.decimals);
}

export async function quoteStockSwap(p: StockSwapQuoteParams): Promise<StockSwapQuoteResult> {
  const unavailable = (detail: string, reason: StockSwapRefusal = "unavailable"): StockSwapQuoteResult => ({
    ok: false,
    reason,
    detail,
  });

  const originAsset = p.side === "buy" ? p.funding.id : p.stock.id;
  const destinationAsset = p.side === "buy" ? p.stock.id : p.funding.id;
  if (!isAllowedPair(p.side, originAsset, destinationAsset)) return unavailable("Par fuera de la lista de prueba");
  if (!isBaseUnitString(p.amountRaw) || BigInt(p.amountRaw) <= ZERO) return unavailable("Monto inválido");
  if (!p.accountId) return unavailable("Sin cuenta conectada");
  if (
    p.maxTradeUsd !== null &&
    p.side === "buy" &&
    BigInt(p.amountRaw) > BigInt(p.maxTradeUsd) * BigInt(10) ** BigInt(p.funding.decimals)
  ) {
    return unavailable(`Supera el tope de ${p.maxTradeUsd} USD por operación`);
  }

  const now = p.deps?.now?.() ?? Date.now();
  // Whole seconds: the `.000Z` form is the one measured to come back verbatim in the echo.
  const requestedDeadlineMs = Math.floor((now + CONVERSION_QUOTE_DEADLINE_SECS * 1000) / 1000) * 1000;

  const body = {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: SLIPPAGE_BPS,
    originAsset,
    depositType: "INTENTS",
    destinationAsset,
    amount: p.amountRaw,
    refundTo: p.accountId,
    refundType: "INTENTS",
    recipient: p.accountId,
    recipientType: "INTENTS",
    deadline: new Date(requestedDeadlineMs).toISOString(),
  };

  let payload: unknown;
  try {
    const res = await (p.deps?.fetchImpl ?? fetch)(`${ONE_CLICK_BASE_URL}/v0/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: p.signal,
    });
    payload = await res.json().catch(() => null);
    if (!res.ok) {
      const message = (payload as { message?: unknown } | null)?.message;
      const detail = `1Click respondió ${res.status}${typeof message === "string" ? `: ${message}` : ""}`;
      // Measured: too small an amount and no market at all both answer with this message.
      return unavailable(detail, typeof message === "string" && /no liquidity/i.test(message) ? "no_liquidity" : "unavailable");
    }
  } catch {
    return unavailable("No se pudo contactar a 1Click");
  }

  const root = payload as { quote?: unknown; quoteRequest?: unknown; signature?: unknown } | null;
  if (typeof root?.quote !== "object" || root.quote === null) return unavailable("Respuesta sin cotización");
  if (typeof root.quoteRequest !== "object" || root.quoteRequest === null) return unavailable("Respuesta sin eco del pedido");
  const q = root.quote as Record<string, unknown>;
  const echo = root.quoteRequest as Record<string, unknown>;

  // The echo: every field sent comes back identical, and nothing we did not send redirects it.
  for (const [field, sent] of Object.entries(body)) {
    if (echo[field] !== sent) return unavailable(`El eco no coincide en ${field}`);
  }
  for (const field of ["customRecipientMsg", "virtualChainRecipient", "virtualChainRefundRecipient"]) {
    const value = echo[field];
    if (value !== undefined && value !== null && value !== "") return unavailable(`El eco trae ${field}, que no se pidió`);
  }
  if (echo.confidentiality !== undefined && echo.confidentiality !== "public") return unavailable("El eco pide manejo confidencial");
  if (echo.depositMode !== undefined && echo.depositMode !== "SIMPLE") return unavailable("El modo de depósito no es SIMPLE");
  if (q.depositMemo !== undefined && q.depositMemo !== null && q.depositMemo !== "") return unavailable("La cotización pide un memo");

  // Where the money goes: a per-quote implicit account, never the signer.
  const depositAddress = q.depositAddress;
  if (typeof depositAddress !== "string" || !DEPOSIT_ADDRESS_RE.test(depositAddress) || depositAddress === p.accountId) {
    return unavailable("La dirección de depósito no es válida");
  }

  // What leaves and what arrives. Inside Intents neither direction has a network fee to pay.
  const { amountIn, minAmountIn, amountOut, minAmountOut, withdrawFee, refundFee } = q;
  if (!isBaseUnitString(amountIn) || amountIn !== p.amountRaw) return unavailable("amountIn no es el monto pedido");
  if (!isBaseUnitString(minAmountIn) || BigInt(minAmountIn) > BigInt(amountIn)) return unavailable("minAmountIn supera amountIn");
  if (!isBaseUnitString(amountOut) || !isBaseUnitString(minAmountOut)) return unavailable("Montos de salida inválidos");
  if (BigInt(minAmountOut) <= ZERO || BigInt(minAmountOut) > BigInt(amountOut)) return unavailable("minAmountOut fuera de rango");
  if (BigInt(minAmountOut) * BPS < BigInt(amountOut) * (BPS - BigInt(SLIPPAGE_BPS + 1))) {
    return unavailable("El mínimo garantizado queda por debajo de la tolerancia pedida");
  }
  if (!isBaseUnitString(withdrawFee) || BigInt(withdrawFee) !== ZERO) return unavailable("La cotización cobra un withdrawFee");
  if (!isBaseUnitString(refundFee) || BigInt(refundFee) !== ZERO) return unavailable("La cotización cobra un refundFee");

  const amountInUsd = positiveUsd(q.amountInUsd);
  const amountOutUsd = positiveUsd(q.amountOutUsd);
  if (amountInUsd === null || amountOutUsd === null) return unavailable("La cotización no trae valores en USD");
  if (p.maxTradeUsd !== null && amountInUsd > p.maxTradeUsd) {
    return unavailable(`Supera el tope de ${p.maxTradeUsd} USD por operación`);
  }
  const costBps = ((amountInUsd - amountOutUsd) / amountInUsd) * 10_000;
  if (costBps > MAX_COST_BPS) {
    return unavailable(`El costo (${costBps.toFixed(0)} bps) supera el tope de ${MAX_COST_BPS} bps`, "cost_too_high");
  }
  // What the sale pays, in the stablecoin itself, against what the stock is worth outside 1Click.
  if (p.side === "sell" && p.referenceUsdPrice && p.referenceUsdPrice > 0) {
    const worthUsd = (Number(amountIn) / 10 ** p.stock.decimals) * p.referenceUsdPrice;
    const paidUsd = Number(amountOut) / 10 ** p.funding.decimals;
    const belowBps = ((worthUsd - paidUsd) / worthUsd) * 10_000;
    if (belowBps > MAX_COST_BPS) {
      return unavailable(`Paga ${belowBps.toFixed(0)} bps menos que el precio de referencia`, "cost_too_high");
    }
  }

  const signature = root.signature;
  if (typeof signature !== "string" || signature === "") return unavailable("La cotización no viene firmada");
  const quoteDeadlineMs = typeof q.deadline === "string" ? Date.parse(q.deadline) : Number.NaN;
  if (!Number.isFinite(quoteDeadlineMs)) return unavailable("La cotización no trae un vencimiento legible");

  return {
    ok: true,
    quote: {
      side: p.side,
      stock: p.stock,
      funding: p.funding,
      originAsset,
      destinationAsset,
      accountId: p.accountId,
      maxTradeUsd: p.maxTradeUsd,
      depositAddress,
      amountInRaw: amountIn,
      amountOutRaw: amountOut,
      minAmountOutRaw: minAmountOut,
      amountInUsd,
      amountOutUsd,
      costBps,
      requestedDeadlineMs,
      quoteDeadlineMs,
      timeEstimateSecs: typeof q.timeEstimate === "number" ? q.timeEstimate : null,
      signature,
      quotedAtMs: now,
    },
  };
}

/** Raised before anything is signed, so the balance is intact and the answer is to re-quote. */
export class StockSwapNotSignableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockSwapNotSignableError";
  }
}

export type BuildStockSwapParams = {
  signerId: string;
  /** EXACTLY the quote the screen displayed and the operator accepted. */
  quote: StockSwapQuote;
  /** The signer's exact balance of the input token, read on click. */
  heldRaw: bigint;
  nowMs?: number;
  nonce?: Uint8Array;
};

export type StockSwapSignRequest = {
  nep413: { message: string; recipient: string; nonce: Uint8Array };
  erc191Message: string;
  /** Exactly one `transfer`. */
  intents: Intent[];
  deadlineSecs: number;
};

export function buildStockSwapSignRequest(p: BuildStockSwapParams): StockSwapSignRequest {
  const { quote } = p;
  const refuse = (message: string): never => {
    throw new StockSwapNotSignableError(message);
  };

  // A quote is a plain value, so what it is about is asked again here.
  if (!isAllowedPair(quote.side, quote.originAsset, quote.destinationAsset)) refuse("Par fuera de la lista de prueba");
  if (quote.maxTradeUsd !== null && quote.amountInUsd > quote.maxTradeUsd) {
    refuse(`Supera el tope de ${quote.maxTradeUsd} USD por operación`);
  }
  if (!isBaseUnitString(quote.amountInRaw) || BigInt(quote.amountInRaw) <= ZERO) refuse("Monto inválido");
  if (!DEPOSIT_ADDRESS_RE.test(quote.depositAddress) || quote.depositAddress === p.signerId) {
    refuse("La dirección de depósito no es válida");
  }
  // 🔴 The refund and the delivery were fixed by the request. Signing from another account would
  // send THIS account's money into a swap that pays and refunds someone else.
  if (quote.accountId !== p.signerId) refuse(`La cotización es de ${quote.accountId} y firma ${p.signerId}`);

  // Never shrunk to fit: a transfer below `amountIn` is an incomplete deposit that 1Click does not
  // convert, and the money would sit until the refund deadline.
  if (p.heldRaw < BigInt(quote.amountInRaw)) refuse("El saldo no alcanza para esta cotización");

  const nowMs = p.nowMs ?? Date.now();
  if (nowMs - quote.quotedAtMs > STOCK_QUOTE_MAX_AGE_MS) refuse("La cotización venció: vuelve a cotizar");
  const expiresAtMs = Math.min(quote.requestedDeadlineMs, quote.quoteDeadlineMs);
  if (expiresAtMs - nowMs < CONVERSION_MIN_QUOTE_REMAINING_SECS * 1000) refuse("La cotización está por vencer: vuelve a cotizar");
  // The signature dies before the quote, so a late settlement cannot pay a dead quote.
  const deadlineSecs = Math.floor(expiresAtMs / 1000) - CONVERSION_TRANSFER_DEADLINE_MARGIN_SECS;

  if (config.env.contractID !== INTENTS_CONTRACT_ID) {
    throw new Error(`SDK is configured for "${config.env.contractID}" but must address ${INTENTS_CONTRACT_ID}`);
  }

  const intents: Intent[] = [
    {
      intent: "transfer",
      receiver_id: quote.depositAddress,
      tokens: { [quote.originAsset]: quote.amountInRaw },
    } as Intent,
  ];
  const message = messageFactory.makeSwapMessage({
    innerMessage: {
      signer_id: p.signerId,
      deadline: new Date(deadlineSecs * 1000).toISOString(),
      intents,
    },
    nonce: p.nonce,
  });

  return {
    nep413: {
      message: message.NEP413.message,
      recipient: message.NEP413.recipient,
      nonce: message.NEP413.nonce,
    },
    erc191Message: message.ERC191.message,
    intents,
    deadlineSecs,
  };
}
