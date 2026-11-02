// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  discoverTronProviders,
  selectTronProvider,
  tronNetworkWarning,
  readTronChainId,
  TRONLINK_RDNS,
  TRON_MAINNET_CHAIN_ID,
  type AnnouncedTronProvider,
  type TronProvider,
} from "./tron-discovery";

function fakeProvider(extra: Partial<TronProvider> = {}): TronProvider {
  return { request: vi.fn().mockResolvedValue([]), ...extra };
}

/**
 * Stands in for an installed extension: answers the TIP-6963 request event by announcing
 * itself, exactly as TronLink and Backpack were both observed doing on 2026-08-07.
 */
function installWallet(opts: {
  rdns: string;
  name: string;
  announceEvent: string;
  requestEvent: string;
  provider?: TronProvider;
}) {
  const provider = opts.provider ?? fakeProvider();
  const onRequest = () => {
    window.dispatchEvent(
      new CustomEvent(opts.announceEvent, {
        detail: { info: { uuid: `uuid-${opts.rdns}`, name: opts.name, icon: "", rdns: opts.rdns }, provider },
      }),
    );
  };
  window.addEventListener(opts.requestEvent, onRequest);
  return { provider, cleanup: () => window.removeEventListener(opts.requestEvent, onRequest) };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  delete (window as { tron?: unknown }).tron;
  delete (window as { tronLink?: unknown }).tronLink;
  delete (window as { tronWeb?: unknown }).tronWeb;
});

describe("discoverTronProviders", () => {
  it("hears BOTH casings — TronLink announces TIP6963, Backpack announces tip6963", async () => {
    // The exact split measured in the operator's browser. Listening for one casing only is
    // how half the installed wallets become invisible.
    cleanups.push(
      installWallet({
        rdns: TRONLINK_RDNS, name: "TronLink",
        announceEvent: "TIP6963:announceProvider", requestEvent: "TIP6963:requestProvider",
      }).cleanup,
    );
    cleanups.push(
      installWallet({
        rdns: "app.backpack", name: "Backpack",
        announceEvent: "tip6963:announceProvider", requestEvent: "tip6963:requestProvider",
      }).cleanup,
    );

    const found = await discoverTronProviders(50);
    expect(found.map((f) => f.info.rdns).sort()).toEqual(["app.backpack", TRONLINK_RDNS]);
  });

  it("de-duplicates a wallet that answers more than one request event", async () => {
    const provider = fakeProvider();
    for (const requestEvent of ["TIP6963:requestProvider", "tip6963:requestProvider"]) {
      cleanups.push(
        installWallet({
          rdns: "app.backpack", name: "Backpack",
          announceEvent: "tip6963:announceProvider", requestEvent, provider,
        }).cleanup,
      );
    }
    const found = await discoverTronProviders(50);
    expect(found).toHaveLength(1);
  });

  it("ignores an announcement without a usable provider", async () => {
    const onRequest = () => {
      window.dispatchEvent(
        new CustomEvent("TIP6963:announceProvider", {
          detail: { info: { uuid: "u", name: "Broken", icon: "", rdns: "app.broken" }, provider: {} },
        }),
      );
    };
    window.addEventListener("TIP6963:requestProvider", onRequest);
    cleanups.push(() => window.removeEventListener("TIP6963:requestProvider", onRequest));

    expect(await discoverTronProviders(50)).toHaveLength(0);
  });
});

describe("selectTronProvider", () => {
  const announced = (rdns: string, provider: TronProvider): AnnouncedTronProvider => ({
    info: { uuid: `uuid-${rdns}`, name: rdns, icon: "", rdns },
    provider,
  });

  it("picks TronLink even when another wallet announced first", () => {
    // THE bug, in one assertion. Backpack announces itself as a Tron provider, and under the
    // legacy globals it simply won — silently, with no way to tell who answered.
    const backpack = fakeProvider();
    const tronlink = fakeProvider();
    const selected = selectTronProvider([announced("app.backpack", backpack), announced(TRONLINK_RDNS, tronlink)]);
    expect(selected?.provider).toBe(tronlink);
    expect(selected?.info?.rdns).toBe(TRONLINK_RDNS);
  });

  it("falls back to another announced wallet when TronLink is absent", () => {
    // A Backpack-only user must still be able to sign in; announcing is a claim to serve Tron.
    const backpack = fakeProvider();
    const selected = selectTronProvider([announced("app.backpack", backpack)]);
    expect(selected?.provider).toBe(backpack);
  });

  it("falls back to window.tron when it identifies itself as TronLink", () => {
    const provider = fakeProvider({ isTronLink: true });
    (window as { tron?: unknown }).tron = provider;
    expect(selectTronProvider([])?.provider).toBe(provider);
  });

  it("refuses a window.tron that does NOT claim to be TronLink", () => {
    (window as { tron?: unknown }).tron = fakeProvider();
    expect(selectTronProvider([])).toBeNull();
  });

  it("never falls back to the hijackable legacy globals", () => {
    // The regression guard. `window.tronLink` and `window.tronWeb` were the slots found taken
    // by another extension; reaching for them here would restore the original bug.
    (window as { tronLink?: unknown }).tronLink = fakeProvider({ isTronLink: true });
    (window as { tronWeb?: unknown }).tronWeb = { ready: true, defaultAddress: { base58: "T…", hex: "41" } };
    expect(selectTronProvider([])).toBeNull();
  });
});

describe("network check", () => {
  it("stays quiet on mainnet", () => {
    expect(tronNetworkWarning(TRON_MAINNET_CHAIN_ID)).toBeNull();
  });

  it("names the testnet it found", () => {
    expect(tronNetworkWarning("0x94a9059e")).toContain("Shasta");
    expect(tronNetworkWarning("0xcd8690dc")).toContain("Nile");
  });

  it("warns on an unrecognised chain instead of assuming it is fine", () => {
    expect(tronNetworkWarning("0xdeadbeef")).toContain("unrecognised");
  });

  it("says nothing when the chain could not be read — unknown is not wrong", () => {
    expect(tronNetworkWarning(null)).toBeNull();
  });

  it("reads the chain id, lowercased, and returns null when the wallet refuses", async () => {
    expect(await readTronChainId(fakeProvider({ request: vi.fn().mockResolvedValue("0x2B6653DC") })))
      .toBe(TRON_MAINNET_CHAIN_ID);
    expect(await readTronChainId(fakeProvider({ request: vi.fn().mockRejectedValue(new Error("nope")) })))
      .toBeNull();
  });
});
