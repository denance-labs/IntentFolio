// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StockSwapQuote } from "../lib/stock-swap";

const mocks = vi.hoisted(() => ({
  account: "pablofork.near" as string | null,
  ensureCanOperate: vi.fn(),
  readHeld: vi.fn(),
  quote: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@/features/login-wallet", () => ({
  useLoginWallet: () => ({ intentsAccountId: mocks.account, keyVerification: { kind: "verified" }, verifyKey: vi.fn() }),
  ensureCanOperate: mocks.ensureCanOperate,
}));
vi.mock("@/features/dashboard-shell/components/connect-wallet-modal", () => ({
  ConnectWalletModal: () => <div>modal de wallet</div>,
}));
vi.mock("@/features/vault/hooks/use-live-signer", () => ({
  useLiveSigner: () => (mocks.account ? { signer: { scheme: "nep413" }, chain: "near", address: mocks.account } : null),
}));
vi.mock("@/features/bridge/lib/run-real-withdraw", () => ({ readHeldOnVerifier: mocks.readHeld }));
vi.mock("../lib/run-stock-swap", () => ({ runStockSwap: mocks.run }));
vi.mock("../lib/stock-swap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/stock-swap")>()),
  quoteStockSwap: mocks.quote,
}));

import { STOCK_TEST_ASSETS, STOCK_TEST_FUNDING_ASSETS } from "../lib/stock-swap";
import { StockTestPanel } from "./stock-test-panel";

const QUOTE: StockSwapQuote = {
  side: "buy",
  stock: STOCK_TEST_ASSETS[0],
  funding: STOCK_TEST_FUNDING_ASSETS[0],
  originAsset: STOCK_TEST_FUNDING_ASSETS[0].id,
  destinationAsset: STOCK_TEST_ASSETS[0].id,
  accountId: "pablofork.near",
  maxTradeUsd: 120,
  depositAddress: "c2285b251eff358ddf799a190e264badcf8cd33d7811ad1312c137968a772225",
  amountInRaw: "10000000",
  amountOutRaw: "29820653812812409",
  minAmountOutRaw: "29522447274684285",
  amountInUsd: 9.98,
  amountOutUsd: 9.93,
  costBps: 50,
  requestedDeadlineMs: 0,
  quoteDeadlineMs: 0,
  timeEstimateSecs: 10,
  signature: "ed25519:abc",
  quotedAtMs: 0,
};

async function quoted() {
  render(<StockTestPanel />);
  fireEvent.change(screen.getByLabelText("Monto en USDT (NEAR)"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Cotizar" }));
  return screen.findByRole("button", { name: "Firmar y enviar" });
}

beforeEach(() => {
  mocks.account = "pablofork.near";
  mocks.ensureCanOperate.mockResolvedValue(undefined);
  mocks.readHeld.mockResolvedValue(BigInt(12000000));
  mocks.quote.mockResolvedValue({ ok: true, quote: QUOTE });
  mocks.run.mockResolvedValue({ kind: "delivered", intentHash: "HASH", txHash: "TX", amountOutRaw: "1" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StockTestPanel", () => {
  it("shows what the account holds", async () => {
    render(<StockTestPanel />);
    expect(await screen.findByText("12")).toBeTruthy();
  });

  it("never shows an unread balance as zero", async () => {
    mocks.readHeld.mockRejectedValue(new Error("rpc down"));
    render(<StockTestPanel />);
    expect(await screen.findByText(/No se pudo leer el saldo: rpc down/)).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("cannot quote without a wallet", () => {
    mocks.account = null;
    render(<StockTestPanel />);
    expect((screen.getByRole("button", { name: "Cotizar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers to connect a wallet when there is none, and names the account when there is", async () => {
    mocks.account = null;
    render(<StockTestPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Conectar wallet" }));
    expect(screen.getByText("modal de wallet")).toBeTruthy();
    cleanup();
    mocks.account = "pablofork.near";
    render(<StockTestPanel />);
    expect(screen.getByText("Cuenta: pablofork.near")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Conectar wallet" })).toBeNull();
  });

  it("does not ask 1Click for an amount that is not one", async () => {
    render(<StockTestPanel />);
    fireEvent.change(screen.getByLabelText("Monto en USDT (NEAR)"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Cotizar" }));
    expect(await screen.findByText("Escribe un monto válido")).toBeTruthy();
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it("offers no signature until there is a quote, and drops it when the trade changes", async () => {
    render(<StockTestPanel />);
    expect(screen.queryByRole("button", { name: "Firmar y enviar" })).toBeNull();
    cleanup();
    await quoted();
    fireEvent.change(screen.getByLabelText("Monto en USDT (NEAR)"), { target: { value: "11" } });
    expect(screen.queryByRole("button", { name: "Firmar y enviar" })).toBeNull();
  });

  it("signs the quote on screen, once, after the key check", async () => {
    const sign = await quoted();
    fireEvent.click(sign);
    fireEvent.click(sign);
    expect(await screen.findByText("Entregado.")).toBeTruthy();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0][0]).toMatchObject({ accountId: "pablofork.near", quote: QUOTE });
    expect(mocks.ensureCanOperate.mock.invocationCallOrder[0]).toBeLessThan(mocks.run.mock.invocationCallOrder[0]);
  });

  it("does not run the swap when the key check refuses", async () => {
    mocks.ensureCanOperate.mockRejectedValue(new Error("clave sin verificar"));
    fireEvent.click(await quoted());
    expect(await screen.findByText("clave sin verificar")).toBeTruthy();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("does not word an unconfirmed swap as a failure, and warns against retrying", async () => {
    mocks.run.mockResolvedValue({ kind: "unconfirmed", detail: "sin respuesta", intentHash: "HASH", txHash: null });
    fireEvent.click(await quoted());
    expect(await screen.findByText(/Sin confirmar: no lo reintentes/)).toBeTruthy();
  });

  it("quotes and reads the balance of the stablecoin chosen", async () => {
    const usdcArb = STOCK_TEST_FUNDING_ASSETS.find((asset) => asset.label === "USDC (Arbitrum)")!;
    render(<StockTestPanel />);
    fireEvent.change(screen.getByLabelText("Pagar con"), { target: { value: usdcArb.id } });
    await waitFor(() => expect(mocks.readHeld).toHaveBeenCalledWith("pablofork.near", usdcArb.id));
    fireEvent.change(screen.getByLabelText("Monto en USDC (Arbitrum)"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Cotizar" }));
    await waitFor(() => expect(mocks.quote).toHaveBeenCalledTimes(1));
    expect(mocks.quote.mock.calls[0][0]).toMatchObject({ side: "buy", funding: usdcArb, amountRaw: "10000000" });
  });

  it("calls it where the money comes back when selling", async () => {
    render(<StockTestPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Vender" }));
    expect(await screen.findByLabelText("Recibir en")).toBeTruthy();
  });

  it("reads the balances again after the swap", async () => {
    fireEvent.click(await quoted());
    await screen.findByText("Entregado.");
    await waitFor(() => expect(mocks.readHeld.mock.calls.length).toBeGreaterThanOrEqual(4));
  });
});
