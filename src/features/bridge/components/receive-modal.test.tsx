// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/features/login-wallet", () => ({
  useLoginWallet: vi.fn(() => ({ intentsAccountId: "near:alice.near" })),
}));

vi.mock("../lib/bridge-client", () => ({
  getDepositAddress: vi.fn(),
}));

import { ReceiveModal } from "./receive-modal";
import { getDepositAddress } from "../lib/bridge-client";

const BRIDGE_ADDRESS = "0xbr1dge0000000000000000000000000000000000";

function renderModal() {
  return render(<ReceiveModal open={true} lang="en" onClose={vi.fn()} />);
}

/** Tick the network acknowledgment that gates the address (see DepositStep). */
function acknowledgeNetwork() {
  fireEvent.click(screen.getByRole("checkbox"));
}

/** The row whose leading label is exactly `label` (asset ticker in step 1, chain name in step 2). */
function row(label: string): HTMLButtonElement {
  for (const li of screen.getAllByRole("listitem")) {
    if (li.querySelector("p")?.textContent === label) {
      return li.querySelector("button") as HTMLButtonElement;
    }
  }
  throw new Error(`no row labelled "${label}"`);
}

/** An asset curated on one network: its row, then Continue on the network step 2 shows
 * preselected (D-488). */
function pickSingleNetwork(label: string) {
  fireEvent.click(row(label));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

function rowLabels(): string[] {
  return screen.getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent ?? "");
}

beforeEach(() => {
  vi.mocked(getDepositAddress).mockResolvedValue({
    address: BRIDGE_ADDRESS,
    chain: "eth:1",
    memo: undefined,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ json: async () => ({ minDeposit: {}, familyValidation: {} }) })
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ReceiveModal — chain step", () => {
  it("offers a network choice only for the multi-chain assets", () => {
    renderModal();
    fireEvent.click(row("USDC"));
    expect(screen.getByText("Select a network")).toBeTruthy();
    expect(rowLabels()).toContain("Arbitrum");
    // Curated Token (ADR-0016): the live catalog lists USDC on Gnosis, we do not curate it.
    expect(rowLabels()).not.toContain("Gnosis");
  });

  it("shows the network step with the only network preselected for a single-chain asset, and still uses the bridge address (D-488)", async () => {
    renderModal();
    fireEvent.click(row("SOL")); // curated on Solana only

    expect(screen.getByText("Select a network")).toBeTruthy();
    expect(rowLabels()).toContain("Solana");
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
    acknowledgeNetwork();
    expect(screen.getByText(BRIDGE_ADDRESS)).toBeTruthy();
    // The trap D-182 warned about: a single network must NOT imply a direct transfer.
    expect(getDepositAddress).toHaveBeenCalledWith("near:alice.near", "sol:mainnet", undefined);
  });

  // D-176. NEAR used to skip step 2 as a "direct transfer" and show `alice.near` — the
  // user's OWN account, which credits nothing: intents.near only ever sees what arrives at
  // a deposit address. It is now an ordinary single-chain asset.
  it("asks the bridge for a NEAR deposit address instead of showing the user's account", async () => {
    renderModal();
    pickSingleNetwork("NEAR");

    expect(screen.queryByText("Select a network")).toBeNull();
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
    acknowledgeNetwork();

    expect(getDepositAddress).toHaveBeenCalledWith("near:alice.near", "near:mainnet", undefined);
    expect(screen.getByText(BRIDGE_ADDRESS)).toBeTruthy();
    expect(screen.queryByText("alice.near")).toBeNull();
  });

  // Regression: a chain held for one asset used to survive into the next — NEAR was
  // labelled "NEAR · Ethereum". The preselected network must not leak either (D-488).
  it("does not carry the preselected network into the next asset", async () => {
    renderModal();
    pickSingleNetwork("SOL");
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Back"));
    fireEvent.click(screen.getByLabelText("Back"));
    fireEvent.click(row("NEAR"));
    expect(rowLabels()).not.toContain("Solana");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());

    expect(screen.queryByText(/Solana/)).toBeNull();
    expect(screen.getByText(/Send only NEAR on NEAR\./)).toBeTruthy();
  });

  it("goes back from a single-chain asset's address to the network step, then to the asset list (D-488)", async () => {
    renderModal();
    pickSingleNetwork("SOL");
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Back"));
    expect(screen.getByText("Select a network")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Back"));
    expect(screen.getByText("Select an asset")).toBeTruthy();
  });

  // Confirming the only network is not a choice among several: it must not reorder step 2
  // of the next asset (the "last used" network only reflects explicit picks).
  it("does not mark a preselected network as last used (D-488)", () => {
    renderModal();
    pickSingleNetwork("SOL");
    expect(localStorage.getItem("last-used-receive-chain")).toBeNull();
  });

  it("goes back to the network step when it was shown", () => {
    renderModal();
    fireEvent.click(row("USDC"));
    fireEvent.click(row("Arbitrum"));
    fireEvent.click(screen.getByLabelText("Back"));
    expect(screen.getByText("Select a network")).toBeTruthy();
  });

  it("lists networks even when the live catalog request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("catalog down")));
    renderModal();
    fireEvent.click(row("USDC"));
    // No spinner, no retry button: the list no longer depends on the network.
    expect(rowLabels()).toContain("Arbitrum");
    await waitFor(() => expect(screen.queryByText("Couldn't load networks")).toBeNull());
  });

  it("hides the address until the network is acknowledged, and names the network in both the warning and the tick", async () => {
    renderModal();
    pickSingleNetwork("SOL");
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());

    expect(screen.queryByText(BRIDGE_ADDRESS)).toBeNull();
    expect(
      screen.getByText(/Send only SOL on Solana\./)
    ).toBeTruthy();
    expect(screen.getByText(/I confirm I.ll send SOL on Solana/)).toBeTruthy();

    acknowledgeNetwork();
    expect(screen.getByText(BRIDGE_ADDRESS)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // 029 B-21: once acknowledged, the warning again (no checkbox), above the QR and the address.
    const reminder = screen.getByText(/Send only SOL on Solana\./);
    const qr = screen.getByLabelText("Deposit address");
    expect(reminder.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // D-443: after copying, a way out below the address — not only the × up top.
  it("closes from a Done button under the address, which only appears with it", async () => {
    const onClose = vi.fn();
    render(<ReceiveModal open={true} lang="en" onClose={onClose} />);
    pickSingleNetwork("SOL");
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();

    acknowledgeNetwork();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("labels each asset with the number of curated networks", () => {
    renderModal();
    expect(row("SOL").textContent).toContain("1 chain");
    expect(row("BTC").textContent).toContain("2 chains"); // Bitcoin, and NEAR since nBTC
    expect(row("USDC").textContent).toContain("12 chains"); // 12th is Stellar (4.4)
    expect(row("NEAR").textContent).toContain("1 chain");
  });
});

// The visible half of the day-1 allowlist (008.plan §Alcance). The rule these tests fix is
// that a deferred pair is SHOWN and not selectable: dropping it from the list would read as
// "IntentFolio does not support Polygon", and the tester files a bug we would then have to
// answer. `token-availability.test.ts` fixes which pairs are deferred; these fix what the
// screen does about it.
describe("ReceiveModal — deferred pairs (008 MVP allowlist)", () => {
  it("disables a deferred network but keeps it in the list", () => {
    renderModal();
    fireEvent.click(row("USDC")); // 12 curated chains, 5 of them deferred

    const polygon = row("Polygon");
    expect(polygon.disabled).toBe(true);
    expect(polygon.textContent).toContain("Not available yet");

    // …and the live ones on that same list are untouched.
    const arbitrum = row("Arbitrum");
    expect(arbitrum.disabled).toBe(false);
    expect(arbitrum.textContent).not.toContain("Not available yet");
  });

  it("does not advance when a deferred network is clicked", () => {
    renderModal();
    fireEvent.click(row("USDC"));
    fireEvent.click(row("Polygon"));
    // Still on the network step: no acknowledgment checkbox, so no address is ever fetched.
    expect(screen.getByText("Select a network")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(getDepositAddress).not.toHaveBeenCalled();
  });

  // Purely alphabetical put Aptos — disabled — at the top of the 12-row USDC list, so the
  // first row the eye reached was the one row it could not use.
  it("sinks the deferred networks below every selectable one", () => {
    renderModal();
    fireEvent.click(row("USDC"));

    const labels = rowLabels();
    const lastLive = Math.max(...["Arbitrum", "Base", "Ethereum", "NEAR", "Solana"].map((c) => labels.indexOf(c)));
    const firstDeferred = Math.min(...["Aptos", "Polygon", "Stellar"].map((c) => labels.indexOf(c)));
    expect(firstDeferred).toBeGreaterThan(lastLive);
    // Alphabetical still holds inside each block.
    expect(labels.indexOf("Arbitrum")).toBeLessThan(labels.indexOf("Base"));
    expect(labels.indexOf("Aptos")).toBeLessThan(labels.indexOf("Polygon"));
  });

  it("sinks a fully deferred asset below the selectable ones", () => {
    renderModal();
    const labels = rowLabels();
    // XRP was in this list until D-195 took it out of the registry entirely (2026-08-20).
    // It is no longer deferred here — it is absent, which the next test fixes.
    for (const deferred of ["ADA", "SUI", "APT", "ZEC"]) {
      expect(labels.indexOf(deferred), deferred).toBeGreaterThan(labels.indexOf("BTC"));
    }
  });

  // D-195. "Not available yet" would have been the wrong answer for XRP: a deferred row is still a
  // row, and what made the destination-tag hole safe was the withdrawal flag being off — which
  // it no longer is on the team origin. So the asset is not offered at all, at either end.
  it("does not offer XRP for deposit at all, not even as Not available yet", () => {
    renderModal();
    expect(rowLabels()).not.toContain("XRP");
  });

  it("disables an asset whose every network is deferred", () => {
    renderModal();
    // ADA is curated on Cardano alone, and Cardano has no address validator yet (D-278).
    const ada = row("ADA");
    expect(ada.disabled).toBe(true);
    expect(ada.textContent).toContain("Not available yet");

    fireEvent.click(ada);
    expect(screen.queryByText("Select a network")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  // The pair-not-chain rule, from the Receive side: Arbitrum carries a live ETH and an ARB
  // that is out of the catalog, so the chain itself can never be the unit of the decision.
  it("keeps a live asset selectable on a chain that also carries a deferred one", () => {
    renderModal();
    fireEvent.click(row("ETH"));
    expect(row("Arbitrum").disabled).toBe(false);

    fireEvent.click(screen.getByLabelText("Back"));
    expect(row("ARB").disabled).toBe(true);
  });

  // D-396: an asset with no NEAR version is out of the catalog even where its withdrawal
  // works (DOGE, BNB and DAI are all withdrawable), and it reads the same as every other gap.
  it("disables the assets with no NEAR version, with the one label", () => {
    renderModal();
    for (const symbol of ["DAI", "DOGE", "BNB", "GRAM"]) {
      const r = row(symbol);
      expect(r.disabled, symbol).toBe(true);
      expect(r.textContent, symbol).toContain("Not available yet");
    }
    expect(row("BTC").disabled).toBe(false);
  });
});

describe("ReceiveModal — step indicator (016 T5)", () => {
  function currentStep(): string | null | undefined {
    const progress = screen.getByRole("list", { name: "Deposit steps" });
    return progress.querySelector('[aria-current="step"]')?.textContent;
  }

  it("follows the user through asset, network and address", async () => {
    renderModal();
    expect(currentStep()).toBe("1Asset");
    fireEvent.click(row("USDC"));
    expect(currentStep()).toBe("2Network");
    fireEvent.click(row("Arbitrum"));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
    expect(currentStep()).toBe("3Address");
  });

  // D-488: a single-chain asset walks the same three steps, stopping on the network one.
  it("stops on the network step when the asset has a single network", async () => {
    renderModal();
    fireEvent.click(row("SOL"));
    const progress = screen.getByRole("list", { name: "Deposit steps" });
    expect(progress.querySelectorAll("li")).toHaveLength(3);
    expect(currentStep()).toBe("2Network");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
    expect(currentStep()).toBe("3Address");
  });

  it("tells the user the login wallet is their identity, not the required origin", async () => {
    renderModal();
    pickSingleNetwork("SOL");
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
    expect(screen.getByText(/Your wallet is your identity in IntentFolio/)).toBeTruthy();
  });
});

// 016 block 2.3: "Deposit to create this portfolio" opens the same modal framed around the
// New Portfolio Draft. The plain "Deposit" is unchanged.
describe("ReceiveModal — for a New Portfolio Draft", () => {
  const NEAR = "near";
  const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

  // The step indicator's items are list items too; they carry no <p>.
  const assetLabels = () => rowLabels().filter(Boolean);

  function renderForDraft(tokenIds: string[]) {
    return render(
      <ReceiveModal open={true} lang="en" onClose={vi.fn()} draftContext={{ name: "My mix", tokenIds }} />
    );
  }

  it("names the draft instead of the generic subtitle", () => {
    renderForDraft([NEAR]);
    expect(screen.getByText("To create “My mix”: deposit any token.")).toBeTruthy();
    expect(screen.queryByText(/It goes to your funding account/)).toBeNull();
  });

  it("keeps the generic subtitle without a draft", () => {
    renderModal();
    expect(screen.getByText(/It goes to your funding account/)).toBeTruthy();
  });

  it("lists the draft's assets first, in the draft's order, one row per asset", () => {
    renderForDraft([USDC_NEAR, NEAR, USDC_BASE]);
    const labels = assetLabels();
    expect(labels.slice(0, 2)).toEqual(["USDC", "NEAR"]);
    expect(labels.filter((l) => l === "USDC")).toHaveLength(1);
  });

  it("puts the last used asset first among the rest when it is not in the draft", () => {
    localStorage.setItem("last-used-receive-token", "SOL");
    renderForDraft([NEAR, USDC_NEAR]);
    expect(assetLabels().slice(0, 3)).toEqual(["NEAR", "USDC", "SOL"]);
  });

  // D-396 took DAI out of the catalog; someone whose last deposit was DAI must not open the
  // list on a row they cannot pick.
  it("does not lead with a last used asset that is no longer selectable", () => {
    localStorage.setItem("last-used-receive-token", "DAI");
    renderModal();
    const labels = assetLabels();
    expect(labels[0]).not.toBe("DAI");
    expect(labels.indexOf("DAI")).toBeGreaterThan(labels.indexOf("BTC"));
    expect(row("DAI").textContent).not.toContain("Last used");
  });

  it("still offers every asset, not only the draft's", () => {
    const all = (renderModal(), assetLabels());
    cleanup();
    renderForDraft([NEAR]);
    expect([...assetLabels()].sort()).toEqual([...all].sort());
  });
});

// D-483: 31 assets — step 1 searches by symbol or name.
describe("ReceiveModal — asset search", () => {
  it("filters the asset list by symbol or name, and says when nothing matches", () => {
    renderModal();
    const all = rowLabels().filter(Boolean).length;
    expect(all).toBeGreaterThan(20);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search asset…" }), { target: { value: "usd" } });
    expect(rowLabels()).toEqual(expect.arrayContaining(["USDC", "USDT"]));
    expect(rowLabels().filter(Boolean).length).toBeLessThan(all);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bitcoin" } });
    expect(rowLabels()).toContain("BTC");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    // The step indicator's items carry no label; no asset row is left.
    expect(rowLabels().filter(Boolean)).toHaveLength(0);
    expect(screen.getByText("No assets found")).toBeTruthy();
  });

  // D-487: jsdom has no layout, so the sheet's measured height is stubbed.
  it("keeps the sheet's full-list height while filtering, and lets go past step 1", () => {
    const spy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "dialog" ? 700 : 0;
    });
    onTestFinished(() => spy.mockRestore());
    renderModal();
    const sheet = screen.getByRole("dialog");
    expect(sheet.style.minHeight).toBe("min(700px, 85dvh)");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "usd" } });
    expect(sheet.style.minHeight).toBe("min(700px, 85dvh)");

    fireEvent.click(row("USDC"));
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(sheet.style.minHeight).toBe("");
  });
});
