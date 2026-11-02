// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WithdrawalModal, type WithdrawConversions } from "./withdrawal-modal";

// D-392, block 020-3: the withdrawal modal with Converting Withdrawals on (plan 020 §5.3). The
// money path itself is `run-conversion-withdraw.test.ts`; what this suite pins is what the screen
// offers, which quote it shows, and that the button hands over EXACTLY that quote.

vi.mock("@/features/dashboard-shell/hooks/use-available-general-balance", () => ({
  useAvailableGeneralBalance: vi.fn(() => new Map<string, number>()),
}));
vi.mock("@/features/login-wallet", () => ({
  useLoginWallet: vi.fn(() => ({ connection: null })),
}));
vi.mock("@/features/market/hooks/use-token-prices", () => ({
  useTokenPrices: vi.fn(() => ({ prices: {} })),
}));
vi.mock("../lib/withdraw-submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/withdraw-submit")>();
  return {
    ...actual,
    assertNearDestinationUsable: vi.fn(async () => {}),
    nearDestinationIsContract: vi.fn(async () => false),
  };
});
vi.mock("../lib/solana-destination", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/solana-destination")>();
  return { ...actual, assertSolanaDestinationUsable: vi.fn(async () => ({ warning: null })) };
});
vi.mock("@/features/vault/context/real-allocate-context", () => ({
  useSendTransactionAs: vi.fn(() => null),
}));

import { useAvailableGeneralBalance } from "@/features/dashboard-shell/hooks/use-available-general-balance";
import { assertNearDestinationUsable } from "../lib/withdraw-submit";
import { bridgeTranslations } from "../lib/translations";
import { ConversionNotSignableError } from "../lib/conversion-envelope";
import { WithdrawRelayRejectedError } from "../lib/withdraw-errors";
import { AmountExceedsBalanceError } from "@/features/vault/lib/base-units";
import type { ConversionQuote, ConversionQuoteResult } from "../lib/oneclick-conversion-quote";

const t = bridgeTranslations.en;
const mockBalance = useAvailableGeneralBalance as ReturnType<typeof vi.fn>;
const mockPreflight = assertNearDestinationUsable as ReturnType<typeof vi.fn>;

const USDT_POL = "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr";
const USDT_ETH = "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near";
const USDT_NEAR = "nep141:usdt.tether-token.near";
const NEAR = "near:mainnet";

function quote(overrides: Partial<ConversionQuote> = {}): ConversionQuote {
  return {
    originTokenId: USDT_POL,
    deliveryTokenId: USDT_NEAR,
    chainId: NEAR,
    destinationAsset: USDT_NEAR,
    recipient: "alice.near",
    refundTo: "alice.near",
    depositAddress: "a".repeat(64),
    amountInRaw: "5000000",
    amountOutRaw: "4999000",
    minAmountOutRaw: "4974005",
    withdrawFeeRaw: "0",
    createsTokenAccount: false,
    refundFeeRaw: "0",
    slippageBps: 50,
    requestedDeadlineMs: Date.now() + 600_000,
    quoteDeadlineMs: Date.now() + 600_000,
    timeEstimateSecs: 10,
    signature: "ed25519:sig",
    quotedAtMs: Date.now(),
    ...overrides,
  };
}

const ok = (q: ConversionQuote): ConversionQuoteResult => ({ ok: true, quote: q });

function conversions(
  quoteImpl: WithdrawConversions["quote"] = vi.fn(async () => ok(quote())),
  isRoute: WithdrawConversions["isRoute"] = () => true
): WithdrawConversions {
  return { isRoute, quote: quoteImpl };
}

function renderModal(props: Partial<React.ComponentProps<typeof WithdrawalModal>> = {}) {
  return render(<WithdrawalModal open={true} lang="en" onClose={vi.fn()} {...props} />);
}

/** Step 1 → step 3 for a USDT balance held only on Polygon: its row, then Continue on the
 * network step 2 shows preselected (D-488). */
function openUsdt() {
  fireEvent.click(screen.getByRole("button", { name: /USDT/ }));
  fireEvent.click(screen.getByRole("button", { name: t.continueButton }));
}

function destinationButtons() {
  return within(screen.getByRole("group", { name: t.withdrawDestinationLabel })).getAllByRole("button");
}

async function toStep4(address = "alice.near", qty = "5") {
  fireEvent.change(screen.getByLabelText(t.addressLabel), { target: { value: address } });
  fireEvent.change(screen.getByLabelText(t.amountLabel), { target: { value: qty } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: t.continueButton }));
  });
}

beforeEach(() => {
  mockBalance.mockReturnValue(new Map([[USDT_POL, 5]]));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

describe("WithdrawalModal — conversions off: today's screen", () => {
  it("USDT held only on Polygon stays 'Not available yet' without the seams", () => {
    renderModal();
    const usdt = screen.getByRole("button", { name: /USDT/ });
    expect((usdt as HTMLButtonElement).disabled).toBe(true);
    expect(within(usdt).getByText(t.notAvailableYet)).toBeTruthy();
  });

  it("step 2 keeps today's title", () => {
    mockBalance.mockReturnValue(new Map([[USDT_ETH, 3], [USDT_NEAR, 2]]));
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /USDT/ }));
    expect(screen.getByRole("heading", { name: t.withdrawStep2Title })).toBeTruthy();
  });
});

describe("WithdrawalModal — conversions on: steps 1 to 3", () => {
  it("a balance with no direct route can leave by converting, through step 2 with its network preselected", () => {
    renderModal({ conversions: conversions() });
    fireEvent.click(screen.getByRole("button", { name: /USDT/ }));
    // D-488: step 2 is shown even for the one network the balance is held on
    expect(screen.getByRole("heading", { name: t.withdrawStep2TitleConversions })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.continueButton }));
    expect(screen.getByRole("heading", { name: t.withdrawStep3Title })).toBeTruthy();
    // The family's delivery chains, NEAR first: Polygon itself is not one (plan 020 §4).
    expect(destinationButtons().map((b) => b.textContent)).toEqual([
      "NEAR",
      "Ethereum",
      "Arbitrum",
      "Tron",
      "Solana",
    ]);
    expect(destinationButtons()[0].getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Delivered as USDT on NEAR, with a conversion cost")).toBeTruthy();
  });

  it("names what arrives on the network picked", () => {
    renderModal({ conversions: conversions() });
    openUsdt();
    fireEvent.click(screen.getByRole("button", { name: "Tron" }));
    expect(screen.getByText("Delivered as USDT on Tron, with a conversion cost")).toBeTruthy();
  });

  it("only offers the networks the gate opens; with none, the balance stays disabled", () => {
    renderModal({ conversions: conversions(undefined, (_held, chainId) => chainId === NEAR) });
    openUsdt();
    expect(destinationButtons).toThrow(); // a single destination shows no picker at all
    cleanup();

    renderModal({ conversions: conversions(undefined, () => false) });
    expect((screen.getByRole("button", { name: /USDT/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("step 2 asks which balance is used", () => {
    mockBalance.mockReturnValue(new Map([[USDT_ETH, 3], [USDT_POL, 5]]));
    renderModal({ conversions: conversions() });
    fireEvent.click(screen.getByRole("button", { name: /USDT/ }));
    expect(screen.getByRole("heading", { name: t.withdrawStep2TitleConversions })).toBeTruthy();
  });

  it("D-426: says so when the balance already holds what the chosen network delivers", () => {
    mockBalance.mockReturnValue(new Map([[USDT_POL, 5], [USDT_NEAR, 2]]));
    renderModal({ conversions: conversions() });
    fireEvent.click(screen.getByRole("button", { name: /USDT/ }));
    // Step 2 asks which balance; pick Polygon's, whose path to NEAR converts.
    fireEvent.click(screen.getByRole("button", { name: /Polygon/ }));
    const note = t.withdrawHoldsDeliveryToken.replace("{ticker}", "USDT").replace("{chain}", "NEAR");
    expect(screen.getByText(note)).toBeTruthy();
    // Another network, where the balance holds no Delivery Token, has no such note.
    fireEvent.click(screen.getByRole("button", { name: "Tron" }));
    expect(screen.queryByText(/skips the conversion/)).toBeNull();
  });

  it("a held Delivery Token keeps its own chain first, as a direct withdrawal", () => {
    mockBalance.mockReturnValue(new Map([[USDT_ETH, 3]]));
    const quoteSeam = vi.fn(async () => ok(quote()));
    renderModal({ conversions: conversions(quoteSeam) });
    fireEvent.click(screen.getByRole("button", { name: /USDT/ }));
    fireEvent.click(screen.getByRole("button", { name: t.continueButton }));
    expect(destinationButtons()[0].textContent).toBe("Ethereum");
    expect(destinationButtons()[0].getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText(/Delivered as/)).toBeNull();
  });

  it("a token that lives on NEAR, sent to NEAR, has no 'arrives as the token' note", () => {
    // 020-3 QA: with conversions on, USDT(NEAR) gets a destination grid for the first time, and
    // the direct-to-NEAR note (meant for bridged tokens) said "not as native USDT … choose NEAR".
    mockBalance.mockReturnValue(new Map([[USDT_NEAR, 2]]));
    renderModal({ conversions: conversions() });
    fireEvent.click(screen.getByRole("button", { name: /USDT/ }));
    fireEvent.click(screen.getByRole("button", { name: t.continueButton }));
    expect(destinationButtons()[0].textContent).toBe("NEAR");
    expect(destinationButtons()[0].getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText(/arrives in the NEAR account/i)).toBeNull();
  });

  it("checks a NEAR destination against the Delivery Token, without asking for registration", async () => {
    renderModal({ conversions: conversions() });
    openUsdt();
    await toStep4();
    expect(mockPreflight).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenAccountId: "usdt.tether-token.near",
        destinationAddress: "alice.near",
        requireStorageRegistration: false,
      })
    );
  });
});

describe("WithdrawalModal — conversions on: step 4", () => {
  it("asks for the quote with what the form holds, and shows it", async () => {
    const quoteSeam = vi.fn(async () => ok(quote()));
    renderModal({ conversions: conversions(quoteSeam) });
    openUsdt();
    await toStep4();
    expect(quoteSeam).toHaveBeenCalledWith(
      expect.objectContaining({ originTokenId: USDT_POL, chainId: NEAR, qty: 5, recipient: "alice.near" })
    );
    expect(screen.getByText("~4.999 USDT")).toBeTruthy();
    expect(screen.getByText("4.974005 USDT")).toBeTruthy();
    expect(screen.getByText(t.conversionCostLabel)).toBeTruthy();
    expect(screen.getByText("~0.02%")).toBeTruthy();
    expect(screen.getByText("~10 s")).toBeTruthy();
    expect(screen.getByText(t.freeLabel)).toBeTruthy();
  });

  it("the button hands over exactly the quote on screen", async () => {
    const shown = quote();
    const onConfirmed = vi.fn(async () => {});
    renderModal({ conversions: conversions(vi.fn(async () => ok(shown))), onConfirmed });
    openUsdt();
    await toStep4();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.confirmWithdrawalButton }));
    });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    const params = (onConfirmed.mock.calls[0] as unknown as [{ conversionQuote?: ConversionQuote }])[0];
    expect(params.conversionQuote).toBe(shown);
    expect(params).toMatchObject({ tokenId: USDT_POL, chainId: NEAR, address: "alice.near" });
  });

  // Operator, s227, after near.com's swap review: a better quote is silent; a worse one — against
  // what is ON SCREEN — says "Price updated: <old> → <new>" with Cancel / Accept.
  const banner = () => screen.queryByText(/Price updated:/);

  it("a re-price that gives less: 'Price updated', old struck, and Accept signs the new quote", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = quote();
    const second = quote({ amountOutRaw: "4998000", minAmountOutRaw: "4973010", depositAddress: "b".repeat(64) });
    const quoteSeam = vi.fn().mockResolvedValueOnce(ok(first)).mockResolvedValue(ok(second));
    const onConfirmed = vi.fn(async () => {});
    renderModal({ conversions: conversions(quoteSeam), onConfirmed });
    openUsdt();
    await toStep4();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(quoteSeam).toHaveBeenCalledTimes(2);
    expect(banner()).toBeTruthy();
    expect(screen.getByText("4.999 USDT", { selector: "s" })).toBeTruthy();
    expect(screen.getByText("4.998 USDT", { selector: "span" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.confirmWithdrawalButton })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.conversionAcceptButton }));

    // A click the instant Accept appears was aimed at Confirm, which just left: it signs nothing.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.conversionAcceptButton }));
    });
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(banner()).toBeTruthy();

    // Accept is the confirmation: one click, the figures just shown, straight to the wallet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.conversionAcceptButton }));
    });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
    const params = (onConfirmed.mock.calls[0] as unknown as [{ conversionQuote?: ConversionQuote }])[0];
    expect(params.conversionQuote).toBe(second);
  });

  it("a re-price that gives more replaces the figures silently", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const better = quote({ amountOutRaw: "4999500", minAmountOutRaw: "4974500" });
    const quoteSeam = vi.fn().mockResolvedValueOnce(ok(quote())).mockResolvedValue(ok(better));
    const onConfirmed = vi.fn(async () => {});
    renderModal({ conversions: conversions(quoteSeam), onConfirmed });
    openUsdt();
    await toStep4();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText("~4.9995 USDT")).toBeTruthy();
    expect(banner()).toBeNull();
    expect(document.querySelector("s")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.confirmWithdrawalButton }));
    });
    const params = (onConfirmed.mock.calls[0] as unknown as [{ conversionQuote?: ConversionQuote }])[0];
    expect(params.conversionQuote).toBe(better);
  });

  it("measured against what is on screen: up silently, then down a little still asks", async () => {
    // near.com's own sequence: 2.31849 → 2.32074 (silent) → 2.32029 (asks, though above the first).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const better = quote({ amountOutRaw: "4999500", minAmountOutRaw: "4974500" });
    const dip = quote({ amountOutRaw: "4999200", minAmountOutRaw: "4974200" });
    const quoteSeam = vi
      .fn()
      .mockResolvedValueOnce(ok(quote()))
      .mockResolvedValueOnce(ok(better))
      .mockResolvedValue(ok(dip));
    renderModal({ conversions: conversions(quoteSeam) });
    openUsdt();
    await toStep4();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(quoteSeam).toHaveBeenCalledTimes(3);
    expect(banner()).toBeTruthy();
    expect(screen.getByText("4.9995 USDT", { selector: "s" })).toBeTruthy();
  });

  it("Cancel goes back to step 3 with the form as it was", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const quoteSeam = vi
      .fn()
      .mockResolvedValueOnce(ok(quote()))
      .mockResolvedValue(ok(quote({ amountOutRaw: "4990000", minAmountOutRaw: "4965050" })));
    const onConfirmed = vi.fn(async () => {});
    renderModal({ conversions: conversions(quoteSeam), onConfirmed });
    openUsdt();
    await toStep4();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    fireEvent.click(screen.getByRole("button", { name: t.conversionCancelButton }));
    expect(screen.getByRole("heading", { name: t.withdrawStep3Title })).toBeTruthy();
    expect((screen.getByLabelText(t.addressLabel) as HTMLInputElement).value).toBe("alice.near");
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("a failed refresh keeps the quote on screen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const quoteSeam = vi
      .fn()
      .mockResolvedValueOnce(ok(quote()))
      .mockResolvedValue({ ok: false, reason: "unavailable", detail: "1Click unreachable" });
    renderModal({ conversions: conversions(quoteSeam) });
    openUsdt();
    await toStep4();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText("~4.999 USDT")).toBeTruthy();
    expect(screen.queryByText(t.conversionUnavailable)).toBeNull();
    expect((screen.getByRole("button", { name: t.confirmWithdrawalButton }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a refresh that finds the balance no longer covers the amount takes the quote down and says why", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const quoteSeam = vi
      .fn()
      .mockResolvedValueOnce(ok(quote()))
      .mockRejectedValue(new AmountExceedsBalanceError(BigInt(5_000_000), BigInt(4_000_000)));
    renderModal({ conversions: conversions(quoteSeam) });
    openUsdt();
    await toStep4();
    expect(screen.getByText("~4.999 USDT")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // Signable no longer: every click would be refused for the balance (C1) and look like a re-price.
    expect(screen.getByText(t.withdrawErrorExceedsBalance)).toBeTruthy();
    expect(screen.queryByText("~4.999 USDT")).toBeNull();
    expect((screen.getByRole("button", { name: t.confirmWithdrawalButton }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("no quote: says so and the button stays off", async () => {
    renderModal({
      conversions: conversions(vi.fn(async () => ({ ok: false, reason: "unavailable", detail: "x" }) as const)),
    });
    openUsdt();
    await toStep4();
    expect(screen.getByText(t.conversionUnavailable)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.confirmWithdrawalButton }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("no quote: 'Try again' asks at once, without going back a step (D-441 b)", async () => {
    const quoteSeam = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "unavailable", detail: "1Click unreachable" })
      .mockResolvedValue(ok(quote()));
    renderModal({ conversions: conversions(quoteSeam) });
    openUsdt();
    await toStep4();
    expect(screen.getByText(t.conversionUnavailable)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.conversionRetryButton }));
    });
    expect(quoteSeam).toHaveBeenCalledTimes(2);
    expect(screen.getByText("~4.999 USDT")).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.conversionRetryButton })).toBeNull();
    const confirm = screen.getByRole("button", { name: t.confirmWithdrawalButton }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    // The clicked button left with the message; the keyboard is not dropped on the page.
    expect(document.activeElement).toBe(confirm);
  });

  describe("a Solana wallet with no account for the token yet (D-441 a)", () => {
    const SOLANA_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const toSolana = async (result: ConversionQuoteResult) => {
      renderModal({ conversions: conversions(vi.fn(async () => result)) });
      openUsdt();
      fireEvent.click(screen.getByRole("button", { name: "Solana" }));
      await toStep4(SOLANA_WALLET);
    };

    it("a fee that opens the account is shown and said in plain words", async () => {
      await toSolana(ok(quote({ withdrawFeeRaw: "314842", amountOutRaw: "4684158", createsTokenAccount: true })));
      expect(screen.getByText("0.314842 USDT")).toBeTruthy();
      expect(
        screen.getByText(
          "Includes a one-time Solana charge to open that wallet's USDT account."
        )
      ).toBeTruthy();
      expect((screen.getByRole("button", { name: t.confirmWithdrawalButton }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("too small for the account's fee: names the live fee and the minimum, no retry", async () => {
      await toSolana({ ok: false, reason: "token-account-below-minimum", minAmountRaw: "628674", feeRaw: "314337" });
      expect(
        screen.getByText(
          "Solana charges 0.314337 USDT to open that wallet's USDT account, so the minimum to send to it is 0.628674 USDT."
        )
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: t.conversionRetryButton })).toBeNull();
      expect((screen.getByRole("button", { name: t.confirmWithdrawalButton }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("an ordinary fee says nothing about accounts", async () => {
      await toSolana(ok(quote({ withdrawFeeRaw: "10159", amountOutRaw: "4988841" })));
      expect(screen.queryByText(/one-time Solana charge/)).toBeNull();
    });

  });

  it("below the network's minimum: names it, in the held token's units", async () => {
    renderModal({
      conversions: conversions(
        vi.fn(async () => ({ ok: false, reason: "below-minimum", minAmountRaw: "1932777" }) as const)
      ),
    });
    openUsdt();
    await toStep4("alice.near", "1");
    expect(screen.getByText("The minimum to send to NEAR is 1.932777 USDT.")).toBeTruthy();
    expect((screen.getByRole("button", { name: t.confirmWithdrawalButton }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a balance read the caller refused shows its own sentence", async () => {
    const { HeldReadTimeoutError } = await import("../lib/run-real-withdraw");
    renderModal({ conversions: conversions(vi.fn(async () => Promise.reject(new HeldReadTimeoutError()))) });
    openUsdt();
    await toStep4();
    expect(screen.getByText(t.withdrawErrorBalanceSlow)).toBeTruthy();
  });

  it("a click refused for a stale quote re-prices and says so — not as an error", async () => {
    const quoteSeam = vi.fn(async () => ok(quote()));
    const onConfirmed = vi.fn(async () => {
      throw new ConversionNotSignableError("quote-expiring", "expiring");
    });
    renderModal({ conversions: conversions(quoteSeam), onConfirmed });
    openUsdt();
    await toStep4();
    expect(quoteSeam).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.confirmWithdrawalButton }));
    });
    expect(quoteSeam).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(t.withdrawNotSent)).toBeNull();
    expect(screen.getByText(t.conversionRequoted)).toBeTruthy();
    // Same figures: confirming again is enough, and it clears the notice.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.confirmWithdrawalButton }));
    });
    expect(onConfirmed).toHaveBeenCalledTimes(2);
  });

  it("a stale click whose re-price fails says why — never 'price updated' over the old figures", async () => {
    const quoteSeam = vi
      .fn()
      .mockResolvedValueOnce(ok(quote()))
      .mockResolvedValue({ ok: false, reason: "unavailable", detail: "1Click unreachable" });
    const onConfirmed = vi.fn(async () => {
      throw new ConversionNotSignableError("quote-expiring", "expiring");
    });
    renderModal({ conversions: conversions(quoteSeam), onConfirmed });
    openUsdt();
    await toStep4();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.confirmWithdrawalButton }));
    });
    expect(quoteSeam).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(t.conversionRequoted)).toBeNull();
    expect(screen.queryByText("~4.999 USDT")).toBeNull();
    expect(screen.getByText(t.conversionUnavailable)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.confirmWithdrawalButton }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it("a stale click whose re-price gives less asks to accept the new figures", async () => {
    const quoteSeam = vi
      .fn()
      .mockResolvedValueOnce(ok(quote()))
      .mockResolvedValue(ok(quote({ amountOutRaw: "4990000", minAmountOutRaw: "4965050" })));
    const onConfirmed = vi.fn(async () => {
      throw new ConversionNotSignableError("balance-short", "short");
    });
    renderModal({ conversions: conversions(quoteSeam), onConfirmed });
    openUsdt();
    await toStep4();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.confirmWithdrawalButton }));
    });
    expect(screen.getByText(/Price updated:/)).toBeTruthy();
    expect(screen.getByRole("button", { name: t.conversionAcceptButton })).toBeTruthy();
    expect(screen.getByText("4.999 USDT", { selector: "s" })).toBeTruthy();
  });

  it("a quote for another account is an error, not a re-price", async () => {
    const quoteSeam = vi.fn(async () => ok(quote()));
    const onConfirmed = vi.fn(async () => {
      throw new ConversionNotSignableError("signer-mismatch", "mismatch");
    });
    renderModal({ conversions: conversions(quoteSeam), onConfirmed });
    openUsdt();
    await toStep4();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.confirmWithdrawalButton }));
    });
    expect(quoteSeam).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t.conversionSignerMismatch)).toBeTruthy();
  });

  it("a signature refused in the wallet says so, without the wallet library's raw text", async () => {
    // viem's shape (020-3 QA): code 4001, and a message carrying "Version: viem@…".
    const refusal = Object.assign(new Error("User rejected the request. Version: viem@2.51.3"), {
      name: "UserRejectedRequestError",
      code: 4001,
    });
    const onConfirmed = vi.fn(async () => {
      throw refusal;
    });
    renderModal({ conversions: conversions(), onConfirmed });
    openUsdt();
    await toStep4();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.confirmWithdrawalButton }));
    });
    expect(screen.getByText(t.withdrawNotSent)).toBeTruthy();
    expect(screen.getByText(t.withdrawErrorWalletRefused)).toBeTruthy();
    expect(screen.queryByText(/viem/)).toBeNull();
  });

  it("a refusal by the relay keeps its own detail", async () => {
    const onConfirmed = vi.fn(async () => {
      // The real class, with a reason that quotes a user refusal: still the relay's, detail kept.
      throw new WithdrawRelayRejectedError("UNKNOWN_ERROR", "The user denied the request");
    });
    renderModal({ conversions: conversions(), onConfirmed });
    openUsdt();
    await toStep4();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.confirmWithdrawalButton }));
    });
    expect(screen.getByText(/The relay rejected the withdrawal/)).toBeTruthy();
    expect(screen.queryByText(t.withdrawErrorWalletRefused)).toBeNull();
  });

  it("names the Delivery Token on each side when they differ (BTC → nBTC), and a refund cost", async () => {
    const BTC = "nep141:btc.omft.near";
    mockBalance.mockReturnValue(new Map([[BTC, 0.001]]));
    const btcQuote = quote({
      originTokenId: BTC,
      deliveryTokenId: "nep141:nbtc.bridge.near",
      destinationAsset: "nep141:nbtc.bridge.near",
      amountInRaw: "100000",
      amountOutRaw: "99993",
      minAmountOutRaw: "99493",
      refundFeeRaw: "10",
    });
    renderModal({ conversions: conversions(vi.fn(async () => ok(btcQuote))) });
    fireEvent.click(screen.getByRole("button", { name: /BTC/ }));
    fireEvent.click(screen.getByRole("button", { name: t.continueButton }));
    fireEvent.click(screen.getByRole("button", { name: "NEAR" }));
    expect(screen.getByText("Delivered as nBTC on NEAR, with a conversion cost")).toBeTruthy();
    await toStep4("alice.near", "0.001");
    expect(screen.getByText(/your BTC on Bitcoin becomes nBTC on NEAR/)).toBeTruthy();
    expect(screen.getByText(/less up to 0\.0000001 BTC/)).toBeTruthy();
  });

  it("a Network Fee is stated in the Delivery Token", async () => {
    renderModal({
      conversions: conversions(vi.fn(async () => ok(quote({ withdrawFeeRaw: "6693", amountOutRaw: "4992307" })))),
    });
    openUsdt();
    await toStep4();
    expect(screen.getByText("0.006693 USDT")).toBeTruthy();
  });
});
