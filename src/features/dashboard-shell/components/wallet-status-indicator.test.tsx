// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { LanguageProvider } from "../context/language-context";

const mocks = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("@/features/login-wallet", () => ({
  useLoginWallet: () => mocks.value,
}));

import { WalletStatusIndicator } from "./wallet-status-indicator";

function connected(chainKind: string, address: string) {
  return { status: "connected", connection: { chainKind, address }, signOut: vi.fn() };
}

function renderMenu(onGettingStarted?: () => void) {
  return render(
    <LanguageProvider>
      <WalletStatusIndicator onGettingStarted={onGettingStarted} />
    </LanguageProvider>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// Triage 016, sub-block 1.3 (T3 + H4): the wallet menu is where a signed-in user finds the
// full address, the guide, the language and sign-out — on mobile and desktop alike.
describe("WalletStatusIndicator menu", () => {
  it("is closed until the trigger is pressed, then shows the full address and every entry", () => {
    mocks.value = connected("near", "a-rather-long-account-name.near");
    renderMenu();
    const trigger = screen.getByRole("button", { expanded: false });
    const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(panel.hasAttribute("hidden")).toBe(true);

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hasAttribute("hidden")).toBe(false);
    expect(panel.textContent).toContain("NEAR wallet");
    expect(panel.textContent).toContain("Address");
    expect(panel.textContent).toContain("a-rather-long-account-name.near");
    const guide = screen.getByRole("link", { name: /Guide/ });
    expect(guide.getAttribute("href")).toBe("/learn");
    expect(guide.getAttribute("target")).toBe("_blank");
    expect(screen.getByRole("group", { name: "Language" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    mocks.value = connected("evm", "0x1234567890abcdef1234567890abcdef12345678");
    renderMenu();
    const trigger = screen.getByRole("button", { expanded: false });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when focus leaves the menu", () => {
    mocks.value = connected("near", "alice.near");
    render(
      <LanguageProvider>
        <WalletStatusIndicator />
        <button type="button">outside</button>
      </LanguageProvider>
    );
    const trigger = screen.getByRole("button", { expanded: false });
    fireEvent.click(trigger);
    fireEvent.blur(trigger, { relatedTarget: screen.getByRole("button", { name: "outside" }) });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("labels a TON login's value as a public key, not an address", () => {
    // TON logins store the wallet's public key (LoginWalletConnection), not the EQ… address.
    mocks.value = connected("ton", "a".repeat(64));
    renderMenu();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Public key")).toBeTruthy();
    expect(screen.queryByText("Address")).toBeNull();
  });

  it("switches the language from inside the menu", () => {
    mocks.value = connected("solana", "So11111111111111111111111111111111111111112");
    renderMenu();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: "ES" }));
    expect(screen.getByRole("link", { name: /Guía/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeTruthy();
  });
});

// 016 block 2.5: "Getting started" reopens the welcome, next to the guide.
describe("WalletStatusIndicator — Getting started", () => {
  it("is there only when the shell hands it a way to reopen the welcome", () => {
    mocks.value = connected("near", "alice.near");
    renderMenu();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.queryByRole("button", { name: "Getting started" })).toBeNull();
  });

  it("closes the menu and reopens the welcome; the guide stays", () => {
    mocks.value = connected("near", "alice.near");
    const onGettingStarted = vi.fn();
    renderMenu(onGettingStarted);
    const trigger = screen.getByRole("button", { expanded: false });
    fireEvent.click(trigger);
    expect(screen.getByRole("link", { name: /Guide/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Getting started" }));
    expect(onGettingStarted).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // Where the welcome will return focus when it closes.
    expect(document.activeElement).toBe(trigger);
  });
});

// 019-1 (D-393): signed out, the header carries the way in instead of nothing.
describe("WalletStatusIndicator signed out", () => {
  function renderSignedOut(status: string, onConnect?: () => void) {
    mocks.value = { status, connection: null, signOut: vi.fn() };
    return render(
      <LanguageProvider>
        <WalletStatusIndicator onConnect={onConnect} />
      </LanguageProvider>
    );
  }

  it("shows Connect Wallet and opens the picker with it", () => {
    const onConnect = vi.fn();
    renderSignedOut("idle", onConnect);
    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("says just Connect under sm, keeping the full accessible name (D-408)", () => {
    renderSignedOut("idle", vi.fn());
    const button = screen.getByRole("button", { name: "Connect Wallet" });
    const short = screen.getByText("Connect", { exact: true });
    expect(button.contains(short)).toBe(true);
    expect(short.getAttribute("aria-hidden")).toBe("true");
    expect(short.className).toContain("sm:hidden");
    expect(screen.getByText("Connect Wallet").className).toContain("sr-only sm:not-sr-only");
  });

  it("offers it again after a failed sign-in", () => {
    renderSignedOut("error", vi.fn());
    expect(screen.getByRole("button", { name: "Connect Wallet" })).toBeTruthy();
  });

  it("shows nothing when no one can open the picker", () => {
    const { container } = renderSignedOut("idle");
    expect(container.textContent).toBe("");
  });
});
