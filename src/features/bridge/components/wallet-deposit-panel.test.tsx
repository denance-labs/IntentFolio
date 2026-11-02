// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  getWalletDepositPhase,
  resetWalletDepositPhases,
  setWalletDepositPhase,
  walletDepositPhaseKey,
} from "../hooks/use-wallet-deposit-phase";
import type { WalletDepositResult } from "../lib/near-wallet-deposit";
import { bridgeTranslations } from "../lib/translations";

// B1 (016 block 2.4): after a wallet deposit made for the New Portfolio Draft, the finished
// state leads with "Confirm my portfolio" — but only for a verdict that credited the login.

const state = vi.hoisted(() => ({
  available: BigInt(10) ** BigInt(24),
  prices: {} as Record<string, { usdPrice: number }>,
}));

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/features/market/hooks/use-token-prices", () => ({ useTokenPrices: () => ({ prices: state.prices }) }));
const run = vi.hoisted(() => vi.fn());
vi.mock("../lib/near-wallet-deposit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/near-wallet-deposit")>()),
  runWalletDeposit: run,
}));
vi.mock("../hooks/use-wallet-deposit-balance", () => ({
  useWalletDepositBalance: () => ({
    data: { kind: "native", available: state.available, wrapped: BigInt(0), registrationCost: BigInt(0), generalBalance: BigInt(0) },
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  refreshBalancesAfterWalletDeposit: vi.fn(),
}));

import { WalletDepositPanel } from "./wallet-deposit-panel";

const t = bridgeTranslations.en;
const ACCOUNT = "alice.near";
const TOKEN = "near";
const KEY = walletDepositPhaseKey(ACCOUNT, TOKEN);
const AMOUNT = BigInt(3) * BigInt(10) ** BigInt(23);

function renderDone(result: WalletDepositResult, { withContinue = true } = {}) {
  setWalletDepositPhase(KEY, { kind: "done", result, runId: 1 });
  const onContinue = vi.fn();
  const onAgain = vi.fn();
  const onDone = vi.fn();
  render(
    <WalletDepositPanel
      tokenId={TOKEN}
      accountId={ACCOUNT}
      send={vi.fn()}
      t={t}
      onCredited={vi.fn()}
      onUseAddress={vi.fn()}
      onAgain={onAgain}
      onContinue={withContinue ? onContinue : undefined}
      onDone={onDone}
    />
  );
  return { onContinue, onAgain, onDone };
}

const confirm = () => screen.queryByRole("button", { name: t.walletDepositConfirmDraft });

beforeEach(() => {
  resetWalletDepositPhases();
  state.available = BigInt(10) ** BigInt(24);
  state.prices = {};
  run.mockReset();
  run.mockReturnValue(new Promise(() => {}));
});
afterEach(cleanup);

describe("WalletDepositPanel — B1, continuing into the draft", () => {
  it.each([
    ["credited", { kind: "credited", amount: AMOUNT, txHash: "tx1" }, AMOUNT],
    ["partial", { kind: "partial", credited: AMOUNT - BigInt(1), txHash: "tx1" }, AMOUNT - BigInt(1)],
  ] as const)("%s: leads with the confirmation, handed what was credited", (_kind, result, credited) => {
    const { onContinue, onAgain } = renderDone(result);
    // The other way on stays.
    expect(screen.getByRole("button", { name: t.walletDepositAgain })).toBeTruthy();

    fireEvent.click(confirm()!);
    expect(onContinue).toHaveBeenCalledWith({ tokenId: TOKEN, amount: credited, txHash: "tx1" });
    expect(onAgain).not.toHaveBeenCalled();
    // The verdict was seen: the next visit to this token starts from the form.
    expect(getWalletDepositPhase(KEY)).toEqual({ kind: "form" });
  });

  // 🔴 A verdict that did not credit the login must not invite a signature over funds that
  // are not there (unconfirmed may still land; wrong-signer landed in someone else's balance).
  it.each([
    ["unconfirmed", { kind: "unconfirmed" }],
    ["refunded", { kind: "refunded", txHash: "tx1" }],
    ["wrong-signer", { kind: "wrong-signer", signerId: "bob.near", credited: AMOUNT, txHash: "tx1" }],
  ] as const)("%s: no confirmation", (_kind, result) => {
    renderDone(result as WalletDepositResult);
    expect(confirm()).toBeNull();
  });

  it("with the draft's confirmation, no 'Done': never three buttons (027 A-6)", () => {
    renderDone({ kind: "credited", amount: AMOUNT, txHash: "tx1" });
    expect(screen.queryByRole("button", { name: t.receiveDone })).toBeNull();
  });
});

// 027 A-6: a finished deposit with no confirmation to lead gets "Done", first, which closes the
// modal; "Make another deposit" stays under it.
describe("WalletDepositPanel — Done after a finished deposit (027 A-6)", () => {
  it.each([
    ["credited, no draft", { kind: "credited", amount: AMOUNT, txHash: "tx1" }, false, t.walletDepositAgain],
    ["unconfirmed", { kind: "unconfirmed" }, false, t.walletDepositUnconfirmedAck],
    ["refunded, with a draft", { kind: "refunded", txHash: "tx1" }, true, t.walletDepositAgain],
  ] as const)("%s: Done leads and closes", (_label, result, withContinue, againLabel) => {
    const { onDone, onAgain } = renderDone(result as WalletDepositResult, { withContinue });
    expect(confirm()).toBeNull();
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual([t.receiveDone, againLabel]);
    fireEvent.click(screen.getByRole("button", { name: t.receiveDone }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onAgain).not.toHaveBeenCalled();
  });

  it("not while the wallet is still answering", () => {
    setWalletDepositPhase(KEY, { kind: "waiting", runId: 1 });
    render(
      <WalletDepositPanel
        tokenId={TOKEN}
        accountId={ACCOUNT}
        send={vi.fn()}
        t={t}
        onCredited={vi.fn()}
        onUseAddress={vi.fn()}
        onAgain={vi.fn()}
        onDone={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: t.receiveDone })).toBeNull();
  });
});

// D-417: Max showed 24 raw decimals and the button cut them; no USD figure at all.
describe("WalletDepositPanel — the amount (D-417)", () => {
  // 0.628169186586101728438266 NEAR, the operator's stNEAR figure.
  const RAW = BigInt("628169186586101728438266");
  const field = () => screen.getByLabelText(t.walletDepositAmountLabel) as HTMLInputElement;

  function renderForm() {
    render(
      <WalletDepositPanel
        tokenId={TOKEN}
        accountId={ACCOUNT}
        send={vi.fn()}
        t={t}
        onCredited={vi.fn()}
        onUseAddress={vi.fn()}
        onAgain={vi.fn()}
        onDone={vi.fn()}
      />
    );
  }

  // D-446: the origin is a row of its own — "From your NEAR wallet" over the account, which
  // keeps its full id in the title when it is cut.
  it("names the wallet it sends from, with the account on its own line", () => {
    renderForm();
    expect(screen.getByText(t.walletDepositFrom)).toBeTruthy();
    expect(screen.getByText(ACCOUNT).getAttribute("title")).toBe(ACCOUNT);
  });

  it("Max shows the figure cut to 6 decimals and signs every unit", () => {
    state.available = RAW;
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: t.walletDepositMax }));
    expect(field().value).toBe("0.628169");
    const deposit = screen.getByRole("button", { name: "Deposit 0.628169… NEAR" });
    fireEvent.click(deposit);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].amount).toBe(RAW);
  });

  it("typing after Max signs what was typed", () => {
    state.available = RAW;
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: t.walletDepositMax }));
    fireEvent.change(field(), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.5 NEAR" }));
    expect(run.mock.calls[0][0].amount).toBe(BigInt(5) * BigInt(10) ** BigInt(23));
  });

  it("says what the amount is worth at the live price, and nothing without one", () => {
    renderForm();
    fireEvent.change(field(), { target: { value: "0.5" } });
    expect(screen.queryByText(/^≈/)).toBeNull();

    cleanup();
    state.prices = { [TOKEN]: { usdPrice: 4 } };
    renderForm();
    fireEvent.change(field(), { target: { value: "0.5" } });
    expect(screen.getByText("≈ $2.00")).toBeTruthy();
  });
});
