"use client";

// The operator's screen for one real swap inside the Funding Account: a stock or any other token of the
// app against the funding assets. Spanish only and without translations on purpose: it is open only
// behind `NEXT_PUBLIC_STOCKS_TEST`, for a supervised test, and is not a product surface. Users sell
// stocks from `StockSellModal`.

import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { readHeldOnVerifier } from "@/features/bridge/lib/run-real-withdraw";
import type { OneClickStatus } from "@/features/bridge/lib/oneclick-status";
import { ConnectWalletModal } from "@/features/dashboard-shell/components/connect-wallet-modal";
import { ensureCanOperate, useLoginWallet } from "@/features/login-wallet";
import { useLiveSigner } from "@/features/vault/hooks/use-live-signer";
import { runStockSwap, type StockSwapResult, type StockSwapStage } from "../lib/run-stock-swap";
import {
  MAX_TRADE_USD,
  STOCK_TEST_ASSETS,
  STOCK_TEST_FUNDING_ASSETS,
  formatRaw,
  impliedStockPriceUsd,
  parseAmountToRaw,
  quoteStockSwap,
  type StockSwapQuote,
  type StockSwapSide,
} from "../lib/stock-swap";

const STAGE_LABEL: Record<StockSwapStage, string> = {
  preparing: "Leyendo el saldo…",
  signing: "Esperando la firma en tu wallet…",
  publishing: "Publicando…",
  "awaiting-settlement": "Esperando que se liquide…",
  converting: "1Click está ejecutando el cambio…",
};

type Balances = { funding: bigint; stock: bigint };

const FIELD = "rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 disabled:opacity-50";
const BUTTON =
  "rounded-xl px-4 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-50";

export function StockTestPanel() {
  const { intentsAccountId, keyVerification, verifyKey } = useLoginWallet();
  const liveSigner = useLiveSigner();

  const [side, setSide] = useState<StockSwapSide>("buy");
  const [assetId, setAssetId] = useState(STOCK_TEST_ASSETS[0].id);
  const [fundingId, setFundingId] = useState(STOCK_TEST_FUNDING_ASSETS[0].id);
  const [amount, setAmount] = useState("");
  const [balances, setBalances] = useState<Balances | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [quote, setQuote] = useState<StockSwapQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [stage, setStage] = useState<StockSwapStage | null>(null);
  const [status, setStatus] = useState<OneClickStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StockSwapResult | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const closeConnect = useCallback(() => setConnectOpen(false), []);
  const running = useRef(false);

  const stock = STOCK_TEST_ASSETS.find((asset) => asset.id === assetId) ?? STOCK_TEST_ASSETS[0];
  const funding = STOCK_TEST_FUNDING_ASSETS.find((asset) => asset.id === fundingId) ?? STOCK_TEST_FUNDING_ASSETS[0];
  const inDecimals = side === "buy" ? funding.decimals : stock.decimals;
  const outDecimals = side === "buy" ? stock.decimals : funding.decimals;
  const inSymbol = side === "buy" ? funding.label : stock.ticker;
  const outSymbol = side === "buy" ? stock.ticker : funding.label;
  const busy = stage !== null;
  // A quote in flight belongs to the inputs it was asked with, so they cannot change under it.
  const locked = busy || quoting;

  const refreshBalances = useCallback(async () => {
    if (!intentsAccountId) {
      setBalances(null);
      return;
    }
    try {
      const [fundingHeld, held] = await Promise.all([
        readHeldOnVerifier(intentsAccountId, funding.id),
        readHeldOnVerifier(intentsAccountId, stock.id),
      ]);
      setBalances({ funding: fundingHeld, stock: held });
      setBalanceError(null);
    } catch (e) {
      // Fail closed: an unread balance is never shown as zero.
      setBalances(null);
      setBalanceError(e instanceof Error ? e.message : String(e));
    }
  }, [intentsAccountId, funding.id, stock.id]);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  // Anything that changes the trade makes the quote on screen a quote about another trade.
  const resetQuote = () => {
    setQuote(null);
    setError(null);
  };

  const handleQuote = async () => {
    const amountRaw = parseAmountToRaw(amount, inDecimals);
    if (!amountRaw) {
      setError("Escribe un monto válido");
      return;
    }
    if (!intentsAccountId) {
      setError("Inicia sesión con tu wallet");
      return;
    }
    setQuoting(true);
    setError(null);
    setResult(null);
    setStatus(null);
    const answer = await quoteStockSwap({ side, stock, funding, amountRaw, accountId: intentsAccountId, maxTradeUsd: MAX_TRADE_USD });
    setQuoting(false);
    if (answer.ok) {
      setQuote(answer.quote);
    } else {
      setQuote(null);
      setError(answer.detail);
    }
  };

  const handleSign = async () => {
    if (!quote || !liveSigner || !intentsAccountId || running.current) return;
    running.current = true;
    // Before the key check: that prompt can stay open, and the inputs must not change under it.
    setStage("preparing");
    setError(null);
    setResult(null);
    setStatus(null);
    try {
      await ensureCanOperate(keyVerification, verifyKey, "es");
      const outcome = await runStockSwap({
        accountId: intentsAccountId,
        quote,
        signer: liveSigner.signer,
        onStage: setStage,
        onStatus: setStatus,
      });
      setResult(outcome);
      setQuote(null);
      await refreshBalances();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
      setStage(null);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-5 px-4 py-8">
      <h1 className="text-xl font-semibold text-slate-100">Cambiar tokens (prueba)</h1>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="break-all text-sm text-slate-300">
          {intentsAccountId ? `Cuenta: ${intentsAccountId}` : "Sin wallet conectada"}
        </p>
        {!liveSigner ? (
          <button
            type="button"
            onClick={() => setConnectOpen(true)}
            className={`${BUTTON} border border-cyan-500/50 text-cyan-200`}
          >
            Conectar wallet
          </button>
        ) : null}
      </div>

      <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
        <p className="text-sm text-amber-200">
          Prueba interna con dinero real. Tope de {MAX_TRADE_USD} USD por operación. Mínimo aproximado: 7 USD, y algunos montos no cotizan según el stock: si pasa, prueba con otro monto.
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3" aria-label="Saldos en la cuenta de fondos">
        <div className="rounded-2xl border border-slate-800 px-4 py-3">
          <p className="text-xs text-slate-400">{funding.label}</p>
          <p className="text-sm font-medium tabular-nums text-slate-100">
            {balances ? formatRaw(balances.funding, funding.decimals) : "—"}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 px-4 py-3">
          <p className="text-xs text-slate-400">{stock.ticker}</p>
          <p className="text-sm font-medium tabular-nums text-slate-100">
            {balances ? formatRaw(balances.stock, stock.decimals) : "—"}
          </p>
        </div>
      </section>
      {intentsAccountId ? (
        <button
          type="button"
          disabled={locked}
          onClick={() => void refreshBalances()}
          className={`${BUTTON} self-start border border-slate-700 text-slate-200`}
        >
          Actualizar saldos
        </button>
      ) : null}
      {balanceError ? <p className="text-sm text-amber-300">No se pudo leer el saldo: {balanceError}</p> : null}

      <section className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Operación">
          {(["buy", "sell"] as const).map((option) => (
            <button
              key={option}
              type="button"
              disabled={locked}
              aria-pressed={side === option}
              onClick={() => {
                setSide(option);
                setAmount("");
                resetQuote();
              }}
              className={`${BUTTON} ${side === option ? "bg-cyan-500 text-slate-950" : "border border-slate-700 text-slate-200"}`}
            >
              {option === "buy" ? "Comprar" : "Vender"}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Token
          <select
            className={FIELD}
            value={stock.id}
            disabled={locked}
            onChange={(event) => {
              setAssetId(event.target.value);
              resetQuote();
            }}
          >
            {STOCK_TEST_ASSETS.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.ticker} · {asset.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          {side === "buy" ? "Pagar con" : "Recibir en"}
          <select
            className={FIELD}
            value={funding.id}
            disabled={locked}
            onChange={(event) => {
              setFundingId(event.target.value);
              resetQuote();
            }}
          >
            {STOCK_TEST_FUNDING_ASSETS.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Monto en {inSymbol}
          <span className="flex gap-2">
            <input
              className={`${FIELD} min-w-0 flex-1 tabular-nums`}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              disabled={locked}
              onChange={(event) => {
                setAmount(event.target.value);
                resetQuote();
              }}
            />
            {side === "sell" && balances ? (
              <button
                type="button"
                disabled={locked}
                className={`${BUTTON} border border-slate-700 text-slate-200`}
                onClick={() => {
                  setAmount(formatRaw(balances.stock, stock.decimals, stock.decimals));
                  resetQuote();
                }}
              >
                Todo
              </button>
            ) : null}
          </span>
        </label>

        <button
          type="button"
          disabled={locked || !intentsAccountId}
          onClick={() => void handleQuote()}
          className={`${BUTTON} border border-cyan-500/50 text-cyan-200`}
        >
          {quoting ? "Cotizando…" : "Cotizar"}
        </button>
      </section>

      {quote ? (
        <section className="flex flex-col gap-3 rounded-2xl border border-slate-800 px-4 py-3" aria-label="Cotización">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-slate-400">Pagas</dt>
            <dd className="text-right tabular-nums text-slate-100">
              {formatRaw(quote.amountInRaw, inDecimals)} {inSymbol} (${quote.amountInUsd.toFixed(2)})
            </dd>
            <dt className="text-slate-400">Recibes aprox.</dt>
            <dd className="text-right tabular-nums text-slate-100">
              {formatRaw(quote.amountOutRaw, outDecimals)} {outSymbol} (${quote.amountOutUsd.toFixed(2)})
            </dd>
            <dt className="text-slate-400">Mínimo garantizado</dt>
            <dd className="text-right tabular-nums text-slate-100">
              {formatRaw(quote.minAmountOutRaw, outDecimals)} {outSymbol}
            </dd>
            <dt className="text-slate-400">Precio de {stock.ticker}</dt>
            <dd className="text-right tabular-nums text-slate-100">${impliedStockPriceUsd(quote).toFixed(2)}</dd>
            <dt className="text-slate-400">Costo</dt>
            <dd className="text-right tabular-nums text-slate-100">{(quote.costBps / 100).toFixed(2)} %</dd>
            <dt className="text-slate-400">Depósito de 1Click</dt>
            <dd className="break-all text-right font-mono text-xs text-slate-300">{quote.depositAddress}</dd>
          </dl>
          <button
            type="button"
            disabled={busy || !liveSigner}
            onClick={() => void handleSign()}
            className={`${BUTTON} bg-cyan-500 text-slate-950`}
          >
            Firmar y enviar
          </button>
          {!liveSigner ? <p className="text-xs text-amber-300">Conecta la wallet para firmar.</p> : null}
        </section>
      ) : null}

      <div aria-live="polite" className="flex flex-col gap-2 text-sm">
        {stage ? <p className="text-slate-200">{STAGE_LABEL[stage]}</p> : null}
        {status ? <p className="text-xs text-slate-400">Estado en 1Click: {status}</p> : null}
        {error ? <p className="text-amber-300">{error}</p> : null}
        {result ? <StockSwapResultView result={result} /> : null}
      </div>

      {connectOpen ? <ConnectWalletModal onClose={closeConnect} /> : null}
    </main>
  );
}

function StockSwapResultView({ result }: { result: StockSwapResult }) {
  const title =
    result.kind === "delivered"
      ? "Entregado."
      : result.kind === "refunded"
        ? "1Click lo devolvió a tu cuenta de fondos."
        : "Sin confirmar: no lo reintentes, revisa el saldo y la dirección de depósito.";
  return (
    <div className="rounded-2xl border border-slate-800 px-4 py-3">
      <p className="font-medium text-slate-100">{title}</p>
      {result.kind === "unconfirmed" ? <p className="mt-1 text-xs text-amber-300">{result.detail}</p> : null}
      <p className="mt-2 break-all font-mono text-xs text-slate-400">Intent: {result.intentHash ?? "—"}</p>
      <p className="break-all font-mono text-xs text-slate-400">Tx: {result.txHash ?? "—"}</p>
    </div>
  );
}
