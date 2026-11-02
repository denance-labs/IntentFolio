import { describe, expect, it } from "vitest";
import {
  DAY_ONE_TOKEN_IDS,
  NO_BUY_ROUTE_TOKEN_IDS,
  NO_NEAR_VERSION_TOKEN_IDS,
  NOT_RECEIVED_TOKEN_IDS,
  NO_SELL_ROUTE_TOKEN_IDS,
  isInCatalog,
  isPortfolioOfferable,
  isReceivable,
  isTokenAvailable,
} from "./token-availability";
import { validateAddress } from "./address-validation";
import { withdrawalRegistry, isWithdrawable } from "./withdrawal-registry";
import { depositGroups } from "./deposit-registry";
import { depositableTokens, getTokenById } from "@/features/market/lib/token-registry";

const routeOf = (id: string) => withdrawalRegistry[id]?.bridgeRoute;

describe("day-1 allowlist", () => {
  // The numbers the operator locked. They are asserted rather than described because the
  // whole point of the block is that the enabled set is a decision, not a side effect: a
  // row that changes side has to change this line too.
  it("enables 39 of the 56 withdrawal rows, leaving 17 not available yet", () => {
    expect(Object.keys(withdrawalRegistry)).toHaveLength(56);
    expect(DAY_ONE_TOKEN_IDS.size).toBe(39);
  });

  it("splits 12 near-native / 21 omft / 5 hot-omni / 1 near-unwrap", () => {
    const byRoute: Record<string, number> = {};
    for (const id of DAY_ONE_TOKEN_IDS) {
      const route = routeOf(id) ?? "unknown";
      byRoute[route] = (byRoute[route] ?? 0) + 1;
    }
    expect(byRoute).toEqual({
      "near-native": 12,
      omft: 21,
      "hot-omni": 5,
      "near-unwrap": 1,
    });
  });

  // The failure this catches is silent in production: a mistyped id matches no registry
  // row, so the token it was meant to enable just renders as "Not available yet" forever and the
  // allowlist still looks the right length.
  it("every allowlisted id exists in withdrawalRegistry", () => {
    const orphans = [...DAY_ONE_TOKEN_IDS].filter((id) => !isWithdrawable(id));
    expect(orphans, `not in withdrawalRegistry: ${orphans.join(", ")}`).toHaveLength(0);
  });

  it("takes every near-native row — a NEAR destination needs no bridge floor or validator", () => {
    const nearRows = Object.keys(withdrawalRegistry).filter((id) => routeOf(id) === "near-native");
    expect(nearRows.every(isTokenAvailable)).toBe(true);
  });

  // The two reasons a row is deferred, asserted as the only two.
  // `xrp:mainnet` left this list on 2026-08-20 — not because it got a validator, but because
  // the row itself was removed (D-195). Deferring it was never enough: "Not available yet" is a UI
  // state, and the safety of the destination-tag hole rested on the withdrawal flag being off
  // globally. Turning that flag on for the team origin is what forced the row out.
  // BTC, DOGE and LTC left this list with their validators (D-278, 017-4b).
  it("defers exactly the 7 omft rows with no address validator", () => {
    const deferred = Object.keys(withdrawalRegistry)
      .filter((id) => routeOf(id) === "omft" && !isTokenAvailable(id))
      .map((id) => withdrawalRegistry[id].chainId)
      .sort();
    expect(deferred).toEqual([
      "aptos:mainnet", "aptos:mainnet", "aptos:mainnet",
      "cardano:mainnet",
      "sui:mainnet", "sui:mainnet",
      "zec:mainnet",
    ]);
  });

  // The pair has to be off at BOTH ends. Removing only the withdrawal row would make XRP a
  // Deposit-only token — the invariant D-176 just drove to zero — and removing only
  // `depositable` would leave a live withdrawal route for a balance acquired elsewhere.
  it("has XRP off at both ends, not merely deferred", () => {
    expect(isWithdrawable("nep141:xrp.omft.near")).toBe(false);
    expect(depositableTokens.some((t) => t.id === "nep141:xrp.omft.near")).toBe(false);
  });

  // The tie between the two halves of this change, and the reason the list above is not just
  // a count: every deferred omft chain must be one `validateAddress` has no branch for, and
  // every enabled one must have a real validator. If someone re-enables BTC without writing
  // its validator, this fails — which is the whole point of D-278 being a prerequisite.
  it("enables no chain whose address it cannot validate", () => {
    const unvalidated = [...DAY_ONE_TOKEN_IDS]
      .map((id) => withdrawalRegistry[id].chainId)
      .filter((chainId) => validateAddress("definitely not an address", chainId).valid);
    expect(unvalidated, `no validator for: ${unvalidated.join(", ")}`).toHaveLength(0);
  });

  it("defers exactly the 10 non-native hot-omni rows that need the gas purchase (D-257)", () => {
    const hot = Object.keys(withdrawalRegistry).filter((id) => routeOf(id) === "hot-omni");
    expect(hot.filter((id) => !isTokenAvailable(id))).toHaveLength(10);
    // hot-omni spans six chains, and four of them keep a live native while their stablecoins
    // wait — so the cut is per (asset, chain) pair and never per chain. This is the assertion
    // that fails if someone "simplifies" the allowlist into a chain list.
    const mixed = ["eth:137", "eth:56", "eth:43114", "stellar:mainnet"];
    for (const chainId of mixed) {
      const rows = hot.filter((id) => withdrawalRegistry[id].chainId === chainId);
      expect(rows.some(isTokenAvailable), chainId).toBe(true);
      expect(rows.some((id) => !isTokenAvailable(id)), chainId).toBe(true);
    }
  });

  it("treats an unknown id as not available yet, never as available", () => {
    expect(isTokenAvailable("nep141:not-a-real-token.near")).toBe(false);
    expect(isTokenAvailable("")).toBe(false);
    // NEAR native was the counter-example here until D-176 gave it a withdrawal route.
    expect(isTokenAvailable("near")).toBe(true);
  });
});

// The invariant the block exists to protect: we never offer a deposit we cannot give back.
// Before the allowlist this held because every depositable token had a withdrawal row; now
// it also has to survive the 21 rows being switched off.
describe("deposit/withdrawal invariant", () => {
  it("every selectable (asset, chain) pair is withdrawable AND allowlisted", () => {
    const offending: string[] = [];
    for (const token of depositableTokens) {
      if (token.id === "near") continue; // direct transfer, no bridge chain
      const group = depositGroups.find((g) => (token.assetName ?? token.symbol) === g.assetName);
      const chainId = withdrawalRegistry[token.id]?.chainId;
      if (!group || !chainId) continue;
      // A pair is selectable exactly when its chain is in the group's available set AND the
      // pair itself is allowlisted — the second half matters because one chain can carry
      // both a live and a deferred asset.
      const selectable = group.availableChainIds.includes(chainId) && isTokenAvailable(token.id);
      if (selectable && !isWithdrawable(token.id)) {
        offending.push(`${token.id} is selectable for deposit but has no withdrawal route`);
      }
      if (isTokenAvailable(token.id) && !isWithdrawable(token.id)) {
        offending.push(`${token.id} is allowlisted but has no withdrawal route`);
      }
    }
    expect(offending, offending.join("\n")).toHaveLength(0);
  });

  it("no deposit group offers a chain whose pairs are all deferred", () => {
    const offending: string[] = [];
    for (const group of depositGroups) {
      for (const chainId of group.availableChainIds) {
        const live = depositableTokens.some(
          (t) =>
            (t.assetName ?? t.symbol) === group.assetName &&
            withdrawalRegistry[t.id]?.chainId === chainId &&
            isTokenAvailable(t.id)
        );
        if (!live) offending.push(`${group.assetName} offers ${chainId} with no live pair`);
      }
      // `availableChainIds` must stay a subset of what the picker renders, or step 2 would
      // enable a row it never draws.
      for (const chainId of group.availableChainIds) {
        if (!group.chainIds.includes(chainId)) {
          offending.push(`${group.assetName}: ${chainId} available but not listed`);
        }
      }
    }
    expect(offending, offending.join("\n")).toHaveLength(0);
  });

  // What "Not available yet" is FOR: the deferred rows stay visible. If a future change filtered
  // them out of `chainIds` instead of disabling them, the label would have nothing to mark
  // and the 21 pairs would quietly vanish from the product.
  it("keeps the deferred pairs listed in their deposit groups", () => {
    const deferredChains = new Set(
      Object.keys(withdrawalRegistry)
        .filter((id) => !isTokenAvailable(id))
        .map((id) => withdrawalRegistry[id].chainId)
    );
    const listed = new Set(depositGroups.flatMap((g) => g.chainIds));
    const missing = [...deferredChains].filter((c) => !listed.has(c));
    expect(missing, `deferred chains dropped from Receive: ${missing.join(", ")}`).toHaveLength(0);
  });
});

// D-396 (018.plan §"Decisiones del operador (s203)"): the 16 assets with no NEAR version.
describe("curated catalog", () => {
  it("leaves out exactly the 16 assets with no NEAR version", () => {
    const symbols = [...NO_NEAR_VERSION_TOKEN_IDS].map((id) => getTokenById(id)?.symbol.split("(")[0].trim());
    expect(symbols.sort()).toEqual(
      ["AAVE", "ADA", "APT", "ARB", "AVAX", "BNB", "DAI", "DOGE", "GRAM", "LINK", "LTC", "POL", "SUI", "TRX", "UNI", "XLM"]
    );
  });

  // A typo would leave the token offered with nothing failing; the list only ever subtracts.
  it("names only depositable registry tokens that are not on NEAR", () => {
    for (const id of NO_NEAR_VERSION_TOKEN_IDS) {
      expect(getTokenById(id)?.depositable, id).toBe(true);
      expect(routeOf(id), id).not.toMatch(/^near-/);
    }
  });

  it("keeps the BTC, ETH and stable pairs that reach a NEAR wallet", () => {
    for (const id of [
      "nep141:btc.omft.near",
      "nep141:nbtc.bridge.near",
      "nep141:eth.omft.near",
      "nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near", // USDC(SUI): USDC reaches NEAR
    ]) {
      expect(isInCatalog(id), id).toBe(true);
    }
  });

  // Leaving the catalog is not leaving the withdrawal: a held DOGE must still get out.
  it("takes them out of Receive but not out of the withdrawal", () => {
    for (const id of ["nep141:doge.omft.near", "nep245:v2_1.omni.hot.tg:1117_"]) {
      expect(isTokenAvailable(id), id).toBe(true);
      expect(isReceivable(id), id).toBe(false);
    }
    expect(isReceivable("nep141:nbtc.bridge.near")).toBe(true);
    expect(isReceivable("nep141:btc.omft.near")).toBe(true);
  });
});

// D-389: a portfolio is offered what Receive is — in the catalog AND withdrawable today.
describe("portfolio offer", () => {
  it("blocks the 14 catalog tokens that cannot be withdrawn yet, ZEC among them", () => {
    const blocked = depositableTokens
      .filter((t) => isInCatalog(t.id) && !isPortfolioOfferable(t.id) && !NO_BUY_ROUTE_TOKEN_IDS.has(t.id))
      .map((t) => t.symbol)
      .sort();
    expect(blocked).toEqual([
      "USDC(APT)", "USDC(AVAX)", "USDC(BSC)", "USDC(OP)", "USDC(POL)", "USDC(STELLAR)", "USDC(SUI)",
      "USDT(APT)", "USDT(AVAX)", "USDT(BSC)", "USDT(OP)", "USDT(POL)", "USDT(TON)", "ZEC",
    ]);
  });

  it("offers what Receive offers, minus the tokens with no buy route", () => {
    for (const t of depositableTokens) {
      expect(isPortfolioOfferable(t.id), t.id).toBe(isReceivable(t.id) && !NO_BUY_ROUTE_TOKEN_IDS.has(t.id));
    }
  });
});

// D-491: measured with no buy route ⇒ not a target, but still receivable and withdrawable.
describe("no buy route", () => {
  it("is exactly BTC, mpDAO, RHEA, SWEAT and SWEAT(ARB)", () => {
    const symbols = [...NO_BUY_ROUTE_TOKEN_IDS].map((id) => getTokenById(id)?.symbol).sort();
    expect(symbols).toEqual(["BTC", "RHEA", "SWEAT", "SWEAT(ARB)", "mpDAO"]);
  });

  it("is not offered as a target but stays withdrawable", () => {
    for (const id of NO_BUY_ROUTE_TOKEN_IDS) {
      expect(isPortfolioOfferable(id), id).toBe(false);
      expect(isTokenAvailable(id), id).toBe(true);
    }
  });

  it("stops receiving RHEA and both SWEATs but keeps BTC and mpDAO, which sell", () => {
    const symbols = [...NOT_RECEIVED_TOKEN_IDS].map((id) => getTokenById(id)?.symbol).sort();
    expect(symbols).toEqual(["RHEA", "SWEAT", "SWEAT(ARB)"]);
    for (const id of NOT_RECEIVED_TOKEN_IDS) {
      expect(NO_BUY_ROUTE_TOKEN_IDS.has(id), id).toBe(true);
      expect(isReceivable(id), id).toBe(false);
    }
    expect(isReceivable("nep141:btc.omft.near")).toBe(true);
    expect(isReceivable("nep141:mpdao-token.near")).toBe(true);
  });

  it("nests: no sell route ⊂ not received ⊂ no buy route", () => {
    for (const id of NO_SELL_ROUTE_TOKEN_IDS) expect(NOT_RECEIVED_TOKEN_IDS.has(id), id).toBe(true);
    for (const id of NOT_RECEIVED_TOKEN_IDS) expect(NO_BUY_ROUTE_TOKEN_IDS.has(id), id).toBe(true);
    expect([...NO_SELL_ROUTE_TOKEN_IDS].map((id) => getTokenById(id)?.symbol).sort()).toEqual(["SWEAT", "SWEAT(ARB)"]);
  });

  it("keeps nBTC, the BTC the presets use, as a target", () => {
    expect(isPortfolioOfferable("nep141:nbtc.bridge.near")).toBe(true);
  });
});
