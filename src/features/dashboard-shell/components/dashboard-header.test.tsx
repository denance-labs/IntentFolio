// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LanguageProvider } from "../context/language-context";

const mocks = vi.hoisted(() => ({ status: "disconnected" }));

vi.mock("@/features/login-wallet", () => ({ useLoginWallet: () => ({ status: mocks.status }) }));
vi.mock("./wallet-status-indicator", () => ({ WalletStatusIndicator: () => null }));

import { DashboardHeader } from "./dashboard-header";

function renderHeader(onGettingStarted?: () => void, inWalletMenuOnly?: boolean) {
  return render(
    <LanguageProvider>
      <DashboardHeader onGettingStarted={onGettingStarted} inWalletMenuOnly={inWalletMenuOnly} />
    </LanguageProvider>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// D-408: signed out, the app had no way to the home page or the guide but the back button.
describe("DashboardHeader", () => {
  it("signed out: the wordmark goes home and the guide opens in a new tab", () => {
    mocks.status = "disconnected";
    renderHeader();
    expect(screen.getByRole("link", { name: /IntentFolio/ }).getAttribute("href")).toBe("/");
    const guide = screen.getByRole("link", { name: /Guide/ });
    expect(guide.getAttribute("href")).toBe("/learn");
    expect(guide.getAttribute("target")).toBe("_blank");
  });

  // 022-J (D-460): with a wallet the language, "Getting started" and the guide stay in the header
  // (also in the wallet menu). Only the wordmark changes: inert, not to leave the editor.
  it.each(["disconnected", "connected"])("%s: the language, \"Getting started\" and the guide", (status) => {
    mocks.status = status;
    const onGettingStarted = vi.fn();
    renderHeader(onGettingStarted);
    expect(screen.getByRole("group", { name: "Language" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Guide/ }).getAttribute("href")).toBe("/learn");
    fireEvent.click(screen.getByRole("button", { name: "Getting started" }));
    expect(onGettingStarted).toHaveBeenCalledTimes(1);
  });

  // Under `sm` signed out, the language is one button that switches to the other.
  it("signed out: the compact language button switches the language", () => {
    mocks.status = "disconnected";
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Language: EN" }));
    expect(screen.getByRole("button", { name: "Idioma: ES" })).toBeTruthy();
  });

  it("signed in: no compact language button (under `sm` the language is in the wallet menu)", () => {
    mocks.status = "connected";
    renderHeader();
    expect(screen.queryByRole("button", { name: /Language:/ })).toBeNull();
  });

  it("signed in: the wordmark is not a link", () => {
    mocks.status = "connected";
    renderHeader();
    expect(screen.queryByRole("link", { name: /IntentFolio/ })).toBeNull();
  });

  it("without a way to open the welcome (a session restoring), no \"Getting started\"", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "Getting started" })).toBeNull();
  });

  // 027 A-3: an account with a portfolio has the three in the wallet menu only.
  it("signed in with a portfolio: no language, \"Getting started\" nor guide", () => {
    mocks.status = "connected";
    renderHeader(vi.fn(), true);
    expect(screen.queryByRole("group", { name: "Language" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Getting started" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Guide/ })).toBeNull();
  });

  // Whose account it is is not known yet: hidden, so they never show up and then leave.
  it("while the session restores: no language nor guide", () => {
    mocks.status = "restoring";
    renderHeader();
    expect(screen.queryByRole("group", { name: "Language" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Guide/ })).toBeNull();
  });

  // Signed out they are the only way out (D-408): the flag cannot take them away.
  it.each(["disconnected", "connecting"])("%s: the flag does not hide them", (status) => {
    mocks.status = status;
    renderHeader(vi.fn(), true);
    expect(screen.getByRole("group", { name: "Language" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Guide/ }).getAttribute("href")).toBe("/learn");
  });
});
