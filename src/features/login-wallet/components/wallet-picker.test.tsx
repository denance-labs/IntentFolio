// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { NEAR_NETWORK_MISMATCH_ERROR } from "../adapters/near/near-bridge";

const mocks = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../hooks/use-login-wallet", () => ({
  useLoginWallet: () => mocks.value,
}));

import { WalletPicker } from "./wallet-picker";

function base(overrides: Record<string, unknown> = {}) {
  return {
    selectFamily: vi.fn(),
    lastUsedFamily: null,
    status: "error",
    error: null,
    connection: null,
    clearError: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    family: null,
    ...overrides,
  };
}

describe("WalletPicker error surfacing (D-120)", () => {
  it("shows the actionable mainnet message for the network-mismatch sentinel", () => {
    mocks.value = base({ status: "error", error: NEAR_NETWORK_MISMATCH_ERROR });
    const { container } = render(<WalletPicker lang="es" />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").toMatch(/Cambia tu wallet NEAR a mainnet/);
  });

  it("shows the generic error message for non-network errors", () => {
    mocks.value = base({ status: "error", error: "boom" });
    const { container } = render(<WalletPicker lang="en" />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").toMatch(/Connection error/);
  });
});

// Found in a browser during 4.5's pre-flight, not by a test: with no Stellar wallet installed
// the banner said "Connection error" and nothing else. The adapter's message was being used
// only as an `===` comparison and never rendered, so every family's specific message — and
// every distinct failure of a real-money run — collapsed into the same four words.
describe("WalletPicker error detail", () => {
  it("renders the adapter's own message under the translated title", () => {
    const detail = "Varial wallet not found. Install Varial and reload the page.";
    mocks.value = base({ status: "error", error: detail });
    const { container } = render(<WalletPicker lang="en" />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").toMatch(/Connection error/);
    expect(alert?.textContent ?? "").toContain(detail);
  });

  it("keeps the title translated while the detail stays in the adapter's words", () => {
    // The reason the detail is a second line instead of replacing the title: adapter messages
    // are English-only and this component is bilingual.
    mocks.value = base({ status: "error", error: "TronLink not available" });
    const { container } = render(<WalletPicker lang="es" />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").toMatch(/Error de conexión/);
    expect(alert?.textContent ?? "").toContain("TronLink not available");
  });

  it("does not repeat itself for the network-mismatch sentinel", () => {
    // That one already has a full translated sentence, so printing the raw value too would
    // say the same thing twice.
    mocks.value = base({ status: "error", error: NEAR_NETWORK_MISMATCH_ERROR });
    const { container } = render(<WalletPicker lang="en" />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").not.toMatch(/Connection error/);
  });

  it("says nothing extra when the adapter supplied no message", () => {
    mocks.value = base({ status: "error", error: null });
    const { container } = render(<WalletPicker lang="en" />);
    const paragraphs = container.querySelectorAll('[role="alert"] p');
    expect(paragraphs).toHaveLength(1);
  });
});

describe("WalletPicker retry", () => {
  it("actually retries instead of only dismissing the banner", () => {
    // The button is labelled "Try again" but used to just clear state, which reads as
    // "I tried and nothing is wrong" — worse than offering no retry at all.
    const connect = vi.fn().mockResolvedValue(undefined);
    const clearError = vi.fn();
    mocks.value = base({ status: "error", error: "boom", family: "stellar", connect, clearError });
    const { container } = render(<WalletPicker lang="en" />);

    const retry = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Try again"),
    );
    fireEvent.click(retry!);

    expect(clearError).toHaveBeenCalled();
    expect(connect).toHaveBeenCalled();
  });

  it("survives a retry that fails again without escaping as an unhandled rejection", () => {
    const connect = vi.fn().mockRejectedValue(new Error("still no wallet"));
    mocks.value = base({ status: "error", error: "boom", family: "stellar", connect });
    const { container } = render(<WalletPicker lang="en" />);

    const retry = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Try again"),
    );
    expect(() => fireEvent.click(retry!)).not.toThrow();
    expect(connect).toHaveBeenCalled();
  });
});

// Regression for D-215, found during the 4.2 real-money run: the badge was derived from
// `lastUsedFamily` but painted on a BRAND card, so choosing "Solana Wallets" lit up Phantom
// — an uninstalled wallet the operator had never selected. The picker only ever learns the
// family (the brand is picked inside the chain-specific modal), so the family card is the
// only thing it can honestly badge.
describe('WalletPicker "Recent" badge (D-215)', () => {
  /** aria-labels of the cards currently showing the badge. */
  function badgedCards(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("button"))
      .filter((b) => (b.textContent ?? "").includes("Recent"))
      .map((b) => b.getAttribute("aria-label") ?? "");
  }

  it("badges the family card when that family was last used", () => {
    mocks.value = base({ status: "idle", lastUsedFamily: "solana" });
    const { container } = render(<WalletPicker lang="en" />);
    expect(badgedCards(container)).toEqual(["Solana Wallets"]);
  });

  it("never badges Phantom just because the solana family was used", () => {
    mocks.value = base({ status: "idle", lastUsedFamily: "solana" });
    const { container } = render(<WalletPicker lang="en" />);
    expect(badgedCards(container)).not.toContain("Phantom");
  });

  // The same shape held for every family with a brand shortcut, not just Solana.
  it("never badges MetaMask or Meteor for their families either", () => {
    for (const [family, brand, familyCard] of [
      ["evm", "MetaMask", "EVM Wallets"],
      ["near", "Meteor", "NEAR Wallets"],
    ] as const) {
      mocks.value = base({ status: "idle", lastUsedFamily: family });
      const { container, unmount } = render(<WalletPicker lang="en" />);
      const badged = badgedCards(container);
      expect(badged).not.toContain(brand);
      expect(badged).toEqual([familyCard]);
      unmount();
    }
  });

  it("badges nothing when no family has been used yet", () => {
    mocks.value = base({ status: "idle", lastUsedFamily: null });
    const { container } = render(<WalletPicker lang="en" />);
    expect(badgedCards(container)).toEqual([]);
  });
});

// D-281: every choice owned by this picker must identify a real wallet or network
// visually. A letter or a decorative glyph is not enough when users are selecting the
// wallet that controls their funds.
describe("WalletPicker wallet and network marks (D-281)", () => {
  it("renders a real icon for every individual shortcut and wallet family", () => {
    mocks.value = base({ status: "idle" });
    const { container } = render(<WalletPicker lang="en" />);

    for (const label of [
      "MetaMask",
      "Phantom",
      "Meteor",
      "NEAR Wallets",
      "EVM Wallets",
      "Solana Wallets",
      "TON Wallets",
      "Stellar Wallets",
      "Tron",
    ]) {
      const card = Array.from(container.querySelectorAll("button")).find(
        (button) => button.getAttribute("aria-label") === label,
      );
      expect(card).toBeDefined();
      expect(card?.querySelector("svg, img")).not.toBeNull();
    }
  });

  it("does not fall back to the former decorative family glyphs", () => {
    mocks.value = base({ status: "idle" });
    const { container } = render(<WalletPicker lang="en" />);

    for (const [label, oldGlyph] of [
      ["EVM Wallets", "⬡"],
      ["Solana Wallets", "◎"],
      ["TON Wallets", "◆"],
      ["Stellar Wallets", "✦"],
    ]) {
      const card = Array.from(container.querySelectorAll("button")).find(
        (button) => button.getAttribute("aria-label") === label,
      );
      expect(card?.textContent).not.toContain(oldGlyph);
    }
  });
});
