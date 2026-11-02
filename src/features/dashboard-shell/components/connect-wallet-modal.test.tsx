// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { LanguageProvider } from "../context/language-context";

const mocks = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

// The picker is the real one; only the wallet state underneath it is scripted.
vi.mock("@/features/login-wallet/hooks/use-login-wallet", () => ({
  useLoginWallet: () => mocks.value,
}));
vi.mock("@/features/login-wallet", async () => ({
  useLoginWallet: () => mocks.value,
  WalletPicker: (await import("@/features/login-wallet/components/wallet-picker")).WalletPicker,
}));

import { ConnectWalletModal } from "./connect-wallet-modal";

function wallet(overrides: Record<string, unknown> = {}) {
  return {
    selectFamily: vi.fn(),
    lastUsedFamily: null,
    status: "idle",
    error: null,
    connection: null,
    clearError: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    family: null,
    ...overrides,
  };
}

function renderModal(onClose = vi.fn()) {
  const view = render(
    <LanguageProvider>
      <ConnectWalletModal onClose={onClose} />
    </LanguageProvider>
  );
  return { ...view, onClose };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("ConnectWalletModal (019-1)", () => {
  it("opens as a dialog titled Connect Wallet, with the wallet choices and a way out", () => {
    mocks.value = wallet();
    const { onClose } = renderModal();
    const dialog = screen.getByRole("dialog", { name: "Connect Wallet" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("button", { name: "MetaMask" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "NEAR Wallets" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("hands a family to the wallet with auto-connect", () => {
    const selectFamily = vi.fn();
    mocks.value = wallet({ selectFamily });
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Solana Wallets" }));
    expect(selectFamily).toHaveBeenCalledWith("solana", { autoConnect: true });
  });

  it("lets go of Escape and the modal flag while the wallet's own modal is up", () => {
    mocks.value = wallet();
    const { onClose, rerender } = renderModal();
    mocks.value = wallet({ status: "connecting" });
    rerender(
      <LanguageProvider>
        <ConnectWalletModal onClose={onClose} />
      </LanguageProvider>
    );
    // Still on screen behind the wallet's modal…
    const dialog = screen.getByRole("dialog", { name: "Connect Wallet" });
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    // …but Escape belongs to the wallet now.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // Cancelled in the wallet: the dialog takes the keys back.
    mocks.value = wallet({ status: "idle" });
    rerender(
      <LanguageProvider>
        <ConnectWalletModal onClose={onClose} />
      </LanguageProvider>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a failed sign-in inside the dialog, with its retry", () => {
    mocks.value = wallet({ status: "error", error: "TronLink not available" });
    renderModal();
    const dialog = screen.getByRole("dialog", { name: "Connect Wallet" });
    const alert = screen.getByRole("alert");
    expect(dialog.contains(alert)).toBe(true);
    expect(alert.textContent).toContain("TronLink not available");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("hands over to the wallet's own modal when a new family mounts, but not on a retry (D-498)", () => {
    // Solana, TON and Reown stay `idle` while their modal is up: left open, this dialog would
    // keep its focus trap over theirs.
    mocks.value = wallet();
    const { onClose, rerender } = renderModal();
    mocks.value = wallet({ family: "solana" });
    rerender(
      <LanguageProvider>
        <ConnectWalletModal onClose={onClose} />
      </LanguageProvider>
    );
    expect(onClose).toHaveBeenCalledTimes(1);

    cleanup();
    const retry = renderModal();
    mocks.value = wallet({ family: "solana", status: "connecting" });
    retry.rerender(
      <LanguageProvider>
        <ConnectWalletModal onClose={retry.onClose} />
      </LanguageProvider>
    );
    expect(retry.onClose).not.toHaveBeenCalled();
  });

  it("closes itself once connected", () => {
    mocks.value = wallet({ status: "connecting" });
    const { onClose, rerender } = renderModal();
    expect(onClose).not.toHaveBeenCalled();
    mocks.value = wallet({ status: "connected", connection: { chainKind: "near", address: "alice.near" } });
    rerender(
      <LanguageProvider>
        <ConnectWalletModal onClose={onClose} />
      </LanguageProvider>
    );
    expect(onClose).toHaveBeenCalled();
  });
});
