"use client";

// Selling a stock from the Funding Account for USDC on NEAR (plan 039). It is the way out of a stock:
// none has a withdrawal route, so without this a user who moved one out of a portfolio would be stuck.
//
// The money path and its guards live in `features/stocks`. The quote on screen is the one signed, and
// an answer that cannot prove nothing moved is never shown as a failure (`runStockSwap`).

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { readHeldOnVerifier } from "@/features/bridge/lib/run-real-withdraw";
import { NearKeyJustVerifiedError, NearKeyNotVerifiedError, ensureCanOperate, useLoginWallet } from "@/features/login-wallet";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { getTokenById } from "@/features/market/lib/token-registry";
import { Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import { runStockSwap, type StockSwapResult, type StockSwapStage } from "@/features/stocks/lib/run-stock-swap";
import {
  MAX_TRADE_USD,
  STOCK_DECIMALS,
  STOCK_REFERENCE_MAX_AGE_MS,
  STOCK_SALE_ASSET,
  StockSwapNotSignableError,
  formatRaw,
  parseAmountToRaw,
  quoteStockSwap,
  type StockSwapQuote,
  type StockSwapRefusal,
} from "@/features/stocks/lib/stock-swap";
import { useLiveSigner } from "@/features/vault/hooks/use-live-signer";
import { announceOperation } from "@/features/vault/hooks/use-real-portfolio-history";
import { intentsBalancesQueryKey } from "@/features/wallet/hooks/use-intents-balances";
import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";

const SALE_LABEL = "USDC";
const FIELD =
  "min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2.5 text-sm tabular-nums text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50";
const BUTTON =
  "rounded-xl px-4 py-2.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = `${BUTTON} border border-slate-700 text-slate-200 hover:border-slate-500`;
const PRIMARY = `${BUTTON} bg-cyan-500 text-slate-950 hover:bg-cyan-400`;

export function StockSellModal({ tokenId, onClose }: { tokenId: string; onClose: () => void }) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { intentsAccountId, keyVerification, verifyKey } = useLoginWallet();
  const liveSigner = useLiveSigner();
  const { prices } = useTokenPrices();
  const queryClient = useQueryClient();
  const token = getTokenById(tokenId);
  const symbol = token?.symbol ?? tokenId;

  const [held, setHeld] = useState<bigint | null>(null);
  const [heldUnread, setHeldUnread] = useState(false);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<StockSwapQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [stage, setStage] = useState<StockSwapStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StockSwapResult | null>(null);
  const running = useRef(false);

  const busy = stage !== null;
  // Told not to try again, so nothing here offers to. The balance may still change under it.
  const settled = result?.kind === "unconfirmed";
  const locked = busy || quoting || settled;
  // Up to the transfer, closing would lose a signature in flight. From `converting` on, the swap is
  // 1Click's and can take minutes: it delivers or refunds with or without this dialog.
  const canClose = stage === null || stage === "converting";
  const close = useCallback(() => {
    if (canClose) onClose();
  }, [canClose, onClose]);

  const readHeld = useCallback(async () => {
    if (!intentsAccountId) return;
    try {
      setHeld(await readHeldOnVerifier(intentsAccountId, tokenId));
      setHeldUnread(false);
    } catch {
      // Fail closed: an unread balance is never shown as zero.
      setHeld(null);
      setHeldUnread(true);
    }
  }, [intentsAccountId, tokenId]);

  useEffect(() => {
    void readHeld();
  }, [readHeld]);

  const refusalText: Record<StockSwapRefusal, string> = {
    no_liquidity: t.stockSellNoLiquidity,
    cost_too_high: t.stockSellCostTooHigh,
    unavailable: t.stockSellUnavailable,
  };

  const handleQuote = async () => {
    const amountRaw = parseAmountToRaw(amount, STOCK_DECIMALS);
    if (!amountRaw || !intentsAccountId) {
      setError(t.stockSellInvalidAmount);
      return;
    }
    if (held !== null && BigInt(amountRaw) > held) {
      setError(t.stockSellAboveBalance);
      return;
    }
    if (!token) return;
    // A hand-written fallback is no reference for anything, and neither is an old price.
    const price = prices[tokenId];
    const priceAgeMs = price ? Date.now() - Date.parse(price.updatedAt) : Number.NaN;
    const reference =
      price && price.source !== "fallback" && priceAgeMs <= STOCK_REFERENCE_MAX_AGE_MS ? price.usdPrice : null;
    // Without one, only an amount that could not hurt much: sized at the registry's price, not 1Click's.
    if (reference === null && (Number(amountRaw) / 10 ** STOCK_DECIMALS) * token.fallbackUsdPrice > MAX_TRADE_USD) {
      setError(t.stockSellUnavailable);
      return;
    }
    setQuoting(true);
    setError(null);
    setResult(null);
    const answer = await quoteStockSwap({
      side: "sell",
      stock: { ticker: token.symbol, name: token.name, id: token.id, decimals: token.decimals },
      funding: STOCK_SALE_ASSET,
      amountRaw,
      accountId: intentsAccountId,
      maxTradeUsd: null,
      referenceUsdPrice: reference,
    });
    setQuoting(false);
    if (answer.ok) {
      setQuote(answer.quote);
    } else {
      console.warn(`[stocks] no quote for ${symbol}: ${answer.detail}`);
      setQuote(null);
      setError(refusalText[answer.reason]);
    }
  };

  const handleSign = async () => {
    if (!quote || !liveSigner || !intentsAccountId || running.current) return;
    running.current = true;
    setStage("preparing");
    setError(null);
    setResult(null);
    try {
      await ensureCanOperate(keyVerification, verifyKey, lang);
      const outcome = await runStockSwap({
        accountId: intentsAccountId,
        quote,
        signer: liveSigner.signer,
        onStage: setStage,
      });
      setResult(outcome);
      setQuote(null);
      setAmount("");
      void queryClient.invalidateQueries({ queryKey: intentsBalancesQueryKey(intentsAccountId) });
      void announceOperation(queryClient, intentsAccountId, outcome.txHash);
      await readHeld();
    } catch (e) {
      // `runStockSwap` only throws what proves nothing moved: a refusal, an expired quote, a cancel.
      console.warn(`[stocks] sale of ${symbol} not sent: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof NearKeyNotVerifiedError || e instanceof NearKeyJustVerifiedError) {
        // These say what to do next, and the quote may still be good for "press again".
        setError(e.message);
      } else if (e instanceof StockSwapNotSignableError) {
        // An old quote or a balance that moved: nothing was signed, and it is not "still all there".
        setQuote(null);
        setError(t.stockSellQuoteStale);
      } else {
        setQuote(null);
        setError(t.stockSellNotSent.replaceAll("{symbol}", symbol));
      }
    } finally {
      running.current = false;
      setStage(null);
    }
  };

  const stageText: Record<StockSwapStage, string> = {
    preparing: t.stockSellStagePreparing,
    signing: t.stockSellStageSigning,
    publishing: t.stockSellStageSending,
    "awaiting-settlement": t.stockSellStageSending,
    converting: t.stockSellStageConverting,
  };

  return (
    <Modal titleId="stock-sell-title" onClose={close}>
      <h2 id="stock-sell-title" className="text-lg font-semibold text-slate-100">
        {t.stockSellTitle.replaceAll("{symbol}", symbol)}
      </h2>
      <p className="mt-1 text-sm text-slate-400">{t.stockSellHint.replaceAll("{symbol}", symbol)}</p>

      <div className="mt-4 flex flex-col gap-1.5 text-xs text-slate-400">
        <span className="flex items-baseline justify-between gap-3">
          <label htmlFor="stock-sell-amount">{t.stockSellAmount}</label>
          <span className="tabular-nums">
            {held !== null
              ? `${t.stockSellAvailable}: ${formatRaw(held, STOCK_DECIMALS)} ${symbol}`
              : heldUnread
                ? t.stockSellBalanceUnread
                : ""}
          </span>
        </span>
        <span className="flex gap-2">
          <input
            id="stock-sell-amount"
            className={FIELD}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            disabled={locked}
            onChange={(event) => {
              setAmount(event.target.value);
              setQuote(null);
              setError(null);
            }}
          />
          <button
            type="button"
            disabled={locked || held === null || held === BigInt(0)}
            className={SECONDARY}
            onClick={() => {
              // Every decimal: a rounded Max would leave dust no sale can ever take.
              setAmount(formatRaw(held ?? BigInt(0), STOCK_DECIMALS, STOCK_DECIMALS));
              setQuote(null);
              setError(null);
            }}
          >
            {t.stockSellMax}
          </button>
        </span>
      </div>

      {quote ? (
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-2xl border border-slate-800 px-4 py-3 text-sm">
          <dt className="text-slate-400">{t.stockSellYouSell}</dt>
          <dd className="text-right tabular-nums text-slate-100">
            {formatRaw(quote.amountInRaw, STOCK_DECIMALS)} {symbol}
          </dd>
          <dt className="text-slate-400">{t.stockSellYouReceive}</dt>
          <dd className="text-right tabular-nums text-slate-100">
            {formatRaw(quote.amountOutRaw, STOCK_SALE_ASSET.decimals, 2)} {SALE_LABEL}
          </dd>
          <dt className="text-slate-400">{t.stockSellMinimum}</dt>
          <dd className="text-right tabular-nums text-slate-100">
            {formatRaw(quote.minAmountOutRaw, STOCK_SALE_ASSET.decimals, 2)} {SALE_LABEL}
          </dd>
          <dt className="text-slate-400">{t.stockSellCost}</dt>
          <dd className="text-right tabular-nums text-slate-100">{(Math.max(quote.costBps, 0) / 100).toFixed(2)} %</dd>
        </dl>
      ) : null}

      <div aria-live="polite" className="mt-3 flex flex-col gap-2 text-sm empty:hidden">
        {stage ? <p className="text-slate-200">{stageText[stage]}</p> : null}
        {error ? <p className="text-amber-300">{error}</p> : null}
        {result ? <SaleOutcome result={result} symbol={symbol} t={t} /> : null}
        {!liveSigner && intentsAccountId ? <p className="text-amber-300">{t.stockSellNoSigner}</p> : null}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" disabled={!canClose} onClick={close} className={SECONDARY}>
          {t.stockSellClose}
        </button>
        {quote ? (
          <button type="button" disabled={busy || !liveSigner} onClick={() => void handleSign()} className={PRIMARY}>
            {t.stockSellConfirm}
          </button>
        ) : (
          <button type="button" disabled={locked || !amount.trim()} onClick={() => void handleQuote()} className={PRIMARY}>
            {quoting ? t.stockSellQuoting : t.stockSellGetQuote}
          </button>
        )}
      </div>
    </Modal>
  );
}

function SaleOutcome({
  result,
  symbol,
  t,
}: {
  result: StockSwapResult;
  symbol: string;
  t: typeof shellTranslations.en;
}) {
  if (result.kind === "delivered") {
    const received =
      result.amountOutRaw !== null ? `${formatRaw(result.amountOutRaw, STOCK_SALE_ASSET.decimals, 2)} ${SALE_LABEL}` : SALE_LABEL;
    return <p className="text-emerald-300">{t.stockSellDelivered.replaceAll("{amount}", received)}</p>;
  }
  if (result.kind === "refunded") {
    return <p className="text-amber-300">{t.stockSellRefunded.replaceAll("{symbol}", symbol)}</p>;
  }
  return (
    <div className="text-amber-300">
      <p>{t.stockSellUnconfirmed.replaceAll("{symbol}", symbol)}</p>
      {/* What support needs to find it: without these the user has nothing to point at. */}
      <p className="mt-1 text-xs text-slate-400">{t.stockSellReference}</p>
      <p className="break-all font-mono text-xs text-slate-400">{result.depositAddress}</p>
      {result.txHash ? <p className="break-all font-mono text-xs text-slate-400">{result.txHash}</p> : null}
    </div>
  );
}
