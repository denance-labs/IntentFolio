// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { STOCK_TOKENS } from "@/features/market/lib/stock-tokens";
import type { StockSwapQuote } from "@/features/stocks/lib/stock-swap";

const NVDA = STOCK_TOKENS.find((token) => token.symbol === "NVDA")!;

const mocks = vi.hoisted(() => ({
  account: "pablofork.near" as string | null,
  signer: true,
  price: { usdPrice: 200, source: "coingecko", updatedAt: new Date().toISOString() } as {
    usdPrice: number;
    source: string;
    updatedAt: string;
  },
  ensureCanOperate: vi.fn(),
  readHeld: vi.fn(),
  quote: vi.fn(),
  run: vi.fn(),
  invalidate: vi.fn(),
  announce: vi.fn(),
}));

vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: "en", setLang: vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock("@/features/login-wallet", async () => ({
  ...(await vi.importActual<typeof import("@/features/login-wallet/lib/near-key-verification")>(
    "@/features/login-wallet/lib/near-key-verification"
  )),
  useLoginWallet: () => ({ intentsAccountId: mocks.account, keyVerification: { kind: "verified" }, verifyKey: vi.fn() }),
  ensureCanOperate: mocks.ensureCanOperate,
}));
vi.mock("@/features/market/hooks/use-token-prices", () => ({
  useTokenPrices: () => ({ prices: { [NVDA_ID]: mocks.price } }),
}));
vi.mock("@/features/vault/hooks/use-live-signer", () => ({
  useLiveSigner: () => (mocks.signer ? { signer: { scheme: "nep413" }, chain: "near", address: mocks.account } : null),
}));
vi.mock("@/features/vault/hooks/use-real-portfolio-history", () => ({ announceOperation: mocks.announce }));
vi.mock("@/features/wallet/hooks/use-intents-balances", () => ({
  intentsBalancesQueryKey: (account: string) => ["intents-balances", account],
}));
vi.mock("@/features/bridge/lib/run-real-withdraw", () => ({ readHeldOnVerifier: mocks.readHeld }));
vi.mock("@/features/stocks/lib/run-stock-swap", () => ({ runStockSwap: mocks.run }));
vi.mock("@/features/stocks/lib/stock-swap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/stocks/lib/stock-swap")>()),
  quoteStockSwap: mocks.quote,
}));

const NVDA_ID = "nep141:bnb-0xa9ee28c80f960b889dfbd1902055218cba016f75.omdep.near";
const HELD = BigInt("67666915436389676");

const QUOTE = {
  side: "sell",
  amountInRaw: HELD.toString(),
  amountOutRaw: "13400000",
  minAmountOutRaw: "13266000",
  costBps: 60,
} as unknown as StockSwapQuote;

import { NearKeyJustVerifiedError } from "@/features/login-wallet/lib/near-key-verification";
import { StockSwapNotSignableError } from "@/features/stocks/lib/stock-swap";
import { StockSellModal } from "./stock-sell-modal";

// The default 1 s runs out when the whole suite is running in parallel.
configure({ asyncUtilTimeout: 4000 });

function open(onClose = vi.fn()) {
  render(<StockSellModal tokenId={NVDA.id} onClose={onClose} />);
  return onClose;
}

async function quoted() {
  mocks.quote.mockResolvedValue({ ok: true, quote: QUOTE });
  await screen.findByText(/^Available:/); // Max stays disabled until the balance is read.
  fireEvent.click(screen.getByRole("button", { name: "Max" }));
  fireEvent.click(screen.getByRole("button", { name: "Get price" }));
  await screen.findByText("You receive about");
}

beforeEach(() => {
  mocks.account = "pablofork.near";
  mocks.signer = true;
  mocks.price = { usdPrice: 200, source: "coingecko", updatedAt: new Date().toISOString() };
  mocks.readHeld.mockReset().mockResolvedValue(HELD);
  mocks.quote.mockReset();
  mocks.run.mockReset();
  mocks.ensureCanOperate.mockReset().mockResolvedValue(undefined);
  mocks.invalidate.mockReset();
  mocks.announce.mockReset();
});

afterEach(cleanup);

describe("StockSellModal", () => {
  it("sells every decimal on Max, for USDC, with no ceiling and against the live price", async () => {
    open();
    await quoted();
    expect(mocks.quote).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "sell",
        amountRaw: HELD.toString(),
        maxTradeUsd: null,
        referenceUsdPrice: 200,
        accountId: "pablofork.near",
        funding: expect.objectContaining({ label: "USDC (NEAR)" }),
        stock: expect.objectContaining({ id: NVDA_ID }),
      })
    );
    expect(screen.getByText("13.4 USDC")).toBeTruthy();
    expect(screen.getByText("13.26 USDC")).toBeTruthy();
  });

  it("never takes a hand-written price as the reference", async () => {
    mocks.price = { usdPrice: 204, source: "fallback", updatedAt: new Date().toISOString() };
    open();
    await quoted();
    expect(mocks.quote).toHaveBeenCalledWith(expect.objectContaining({ referenceUsdPrice: null }));
  });

  it("never takes an old price as the reference either", async () => {
    mocks.price = { usdPrice: 200, source: "cached", updatedAt: new Date(Date.now() - 16 * 60_000).toISOString() };
    open();
    await quoted();
    expect(mocks.quote).toHaveBeenCalledWith(expect.objectContaining({ referenceUsdPrice: null }));
  });

  it("without a reference, refuses a sale past the ceiling at the registry's price, before asking 1Click", async () => {
    mocks.price = { usdPrice: 204, source: "fallback", updatedAt: new Date().toISOString() };
    mocks.readHeld.mockResolvedValue(BigInt("1000000000000000000")); // 1 NVDA, ~$204 at the registry's price
    open();
    await screen.findByText(/^Available:/);
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    fireEvent.click(screen.getByRole("button", { name: "Get price" }));
    expect(await screen.findByText(/We couldn't get a price/)).toBeTruthy();
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it("refuses more than the balance without asking for a quote", async () => {
    open();
    await screen.findByText(/Available: 0\.067666 NVDA/);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Get price" }));
    expect(await screen.findByText("That's more than you have available")).toBeTruthy();
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it("does not show an unread balance as zero, and still lets the user try", async () => {
    mocks.readHeld.mockRejectedValue(new Error("rpc down"));
    open();
    expect(await screen.findByText("We couldn't read your balance")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Max" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["no_liquidity", "There is no price for this amount right now"],
    ["cost_too_high", "too far from the stock's value"],
    ["unavailable", "We couldn't get a price"],
  ])("explains a refusal for %s without the upstream's words", async (reason, text) => {
    mocks.quote.mockResolvedValue({ ok: false, reason, detail: "1Click respondió 400" });
    open();
    await screen.findByText(/^Available:/); // Max stays disabled until the balance is read.
  fireEvent.click(screen.getByRole("button", { name: "Max" }));
    fireEvent.click(screen.getByRole("button", { name: "Get price" }));
    expect(await screen.findByText(new RegExp(text))).toBeTruthy();
    expect(screen.queryByText(/1Click/)).toBeNull();
  });

  it("signs exactly the quote on screen, and refreshes the balance and the history", async () => {
    mocks.run.mockResolvedValue({ kind: "delivered", intentHash: "i", txHash: "tx1", amountOutRaw: "13350000" });
    open();
    await quoted();
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    expect(await screen.findByText("Sold. You received 13.35 USDC in your funding account.")).toBeTruthy();
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ quote: QUOTE, accountId: "pablofork.near" }));
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["intents-balances", "pablofork.near"] });
    expect(mocks.announce).toHaveBeenCalledWith(expect.anything(), "pablofork.near", "tx1");
  });

  it("says a refund is a refund", async () => {
    mocks.run.mockResolvedValue({ kind: "refunded", intentHash: "i", txHash: "tx1", refundedAmountRaw: HELD.toString() });
    open();
    await quoted();
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    expect(await screen.findByText("The sale couldn't complete. Your NVDA went back to your funding account.")).toBeTruthy();
  });

  it("never calls an unconfirmed sale a failure, and tells the user not to retry", async () => {
    mocks.run.mockResolvedValue({ kind: "unconfirmed", detail: "timeout", intentHash: "i", txHash: "tx9", depositAddress: "deposit-address" });
    open();
    await quoted();
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    expect(await screen.findByText(/We couldn't confirm the sale yet. Don't try again/)).toBeTruthy();
    expect(screen.getByText("tx9")).toBeTruthy();
    expect(screen.getByText("deposit-address")).toBeTruthy();
    expect(screen.queryByText(/wasn't sent/)).toBeNull();
    // Told not to try again, so nothing here offers to.
    expect((screen.getByRole("button", { name: "Max" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Get price" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says nothing moved when the run throws, and drops the quote", async () => {
    mocks.run.mockRejectedValue(new Error("User rejected"));
    open();
    await quoted();
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    expect(await screen.findByText("The sale wasn't sent. Your NVDA is still in your funding account.")).toBeTruthy();
    expect(screen.queryByText("You receive about")).toBeNull();
  });

  it("does not claim the stock is all there when the quote could no longer be signed", async () => {
    mocks.run.mockRejectedValue(new StockSwapNotSignableError("El saldo no alcanza para esta cotización"));
    open();
    await quoted();
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    expect(await screen.findByText(/This price can't be used anymore/)).toBeTruthy();
    expect(screen.queryByText(/still in your funding account/)).toBeNull();
  });

  it("passes on what to do next from the key check, and keeps the quote for pressing again", async () => {
    mocks.ensureCanOperate.mockRejectedValue(new NearKeyJustVerifiedError("en"));
    open();
    await quoted();
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    expect(await screen.findByText(new NearKeyJustVerifiedError("en").message)).toBeTruthy();
    expect(screen.getByText("You receive about")).toBeTruthy();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("can be closed once the swap is 1Click's", async () => {
    mocks.run.mockImplementation((p: { onStage: (stage: string) => void }) => {
      p.onStage("converting");
      return new Promise(() => {});
    });
    const onClose = open();
    await quoted();
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    expect(await screen.findByText(/You can close this/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("cannot be closed while the sale is running", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.run.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const onClose = open();
    await quoted();
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalled());
    fireEvent.keyDown(document, { key: "Escape" });
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    finish({ kind: "delivered", intentHash: "i", txHash: "t", amountOutRaw: null });
    await screen.findByText(/^Sold\./);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("asks for the wallet when there is no signer, and does not offer to sign", async () => {
    mocks.signer = false;
    open();
    await quoted();
    expect(screen.getByText("Connect your wallet to sign the sale.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sell" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
