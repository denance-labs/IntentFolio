import { describe, expect, it } from "vitest";
import { NEAR_WALLET_FEATURES } from "./near-wallet-provider";

// D-282 regression guard.
//
// What went wrong: the provider asked for `features: { mainnet: true }`, which looks like
// "we are a mainnet app". It is not what the connector does with it. Six wallets —
// hot-wallet, intear-wallet, nightly-wallet, mynearwallet, okx-wallet, hana-wallet —
// disappeared from the NEAR picker, so a tester using any of them could not sign in at all
// and saw no error, just a list without their wallet. It went unnoticed because every
// measurement had been done with Meteor, which was one of the four that survived the filter.
//
// Reading the provider cannot catch this: the bug lives in the interaction between our
// requested features and how completely each upstream manifest entry is populated. So the
// fixture below is the manifest AS MEASURED on 2026-08-13 (v1.1.0), and the filter is the
// SDK's own, copied verbatim.

/**
 * Verbatim from `@hot-labs/near-connect` `NearConnector.availableWallets`.
 *
 * Attribution: see ATTRIBUTIONS.md #14.
 */
function applyConnectorFilter(
  wallets: ManifestEntry[],
  features: Record<string, boolean>,
): string[] {
  return wallets
    .filter((wallet) =>
      Object.entries(features).every(([key, value]) => {
        if (value && !wallet.features?.[key]) return false;
        return true;
      }),
    )
    .map((w) => w.id);
}

type ManifestEntry = { id: string; features: Partial<Record<string, boolean>> };

// Measured against
// raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json
// on 2026-08-13 (v1.1.0). An ABSENT key is absent on purpose — that is the whole bug.
//
// Attribution: see ATTRIBUTIONS.md #14.
const MANIFEST: ManifestEntry[] = [
  { id: "hot-wallet", features: { signMessage: true } },
  { id: "meteor-wallet", features: { signMessage: true, mainnet: true } },
  { id: "intear-wallet", features: { signMessage: true } },
  { id: "ledger", features: { signMessage: true, mainnet: true } },
  { id: "mynearwallet", features: { signMessage: true } },
  { id: "okx-wallet", features: { signMessage: true } },
  { id: "near-mobile", features: { signMessage: true, mainnet: true } },
  { id: "trezu-wallet", features: {} },
  { id: "nightly-wallet", features: { signMessage: true } },
  { id: "wallet-connect", features: { signMessage: true } },
  { id: "unity-wallet", features: { signMessage: true } },
  { id: "hana-wallet", features: { signMessage: true } },
  { id: "near-cli", features: { signMessage: true, mainnet: true } },
];

/** The four whose end-to-end signing was measured on mainnet in D-280 block B0. */
const MEASURED_WALLETS = ["meteor-wallet", "hot-wallet", "nightly-wallet", "intear-wallet"];

describe("NEAR wallet picker features (D-282)", () => {
  it("offers every wallet whose signing was measured against mainnet", () => {
    const offered = applyConnectorFilter(MANIFEST, { ...NEAR_WALLET_FEATURES });
    for (const id of MEASURED_WALLETS) expect(offered).toContain(id);
  });

  it("offers mynearwallet, which a Meta Pool tester is likely to arrive with", () => {
    expect(applyConnectorFilter(MANIFEST, { ...NEAR_WALLET_FEATURES })).toContain(
      "mynearwallet",
    );
  });

  it("excludes only the wallet that cannot sign a message at all", () => {
    const offered = applyConnectorFilter(MANIFEST, { ...NEAR_WALLET_FEATURES });
    expect(offered).not.toContain("trezu-wallet");
    expect(offered).toHaveLength(MANIFEST.length - 1);
  });

  // The counter-case, kept executable rather than described in a comment: it is the exact
  // configuration that shipped, and it is what makes the assertions above mean something.
  it("would hide six wallets if `mainnet` were requested again", () => {
    const offered = applyConnectorFilter(MANIFEST, { mainnet: true });
    expect(offered).toEqual(["meteor-wallet", "ledger", "near-mobile", "near-cli"]);
    for (const id of ["hot-wallet", "intear-wallet", "nightly-wallet", "mynearwallet"]) {
      expect(offered).not.toContain(id);
    }
  });

  it("requests no capability that the upstream manifest under-populates", () => {
    // `mainnet` is declared by 4 of 13; `signMessage` by 12 of 13. Requiring a key that most
    // entries omit filters on manifest completeness, not on capability — the D-282 mistake.
    for (const key of Object.keys(NEAR_WALLET_FEATURES)) {
      const declaring = MANIFEST.filter((w) => w.features?.[key]).length;
      expect(declaring).toBeGreaterThan(MANIFEST.length / 2);
    }
  });
});
