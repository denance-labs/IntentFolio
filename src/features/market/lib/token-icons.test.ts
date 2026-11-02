import { describe, expect, it } from "vitest";
import { hasTokenIcon } from "./token-icons";
import { tokenRegistry } from "./token-registry";

// Tokens whose contract publishes no usable logo; they render the initial fallback on purpose.
const NO_LOGO_EXCEPTIONS = new Set<string>([]);

describe("token icons", () => {
  it("every catalog token has an icon or a documented exception", () => {
    const missing = tokenRegistry
      .filter((t) => !hasTokenIcon(t.symbol) && !NO_LOGO_EXCEPTIONS.has(t.symbol))
      .map((t) => t.symbol);
    expect(missing).toEqual([]);
  });

  it("resolves the GRAM ticker however a screen writes it", () => {
    expect(hasTokenIcon("GRAM")).toBe(true);
    expect(hasTokenIcon("GRAM (ex-TON)")).toBe(true);
  });

  it("still resolves per-network tickers and rejects unknown ones", () => {
    expect(hasTokenIcon("USDT(ETH)")).toBe(true);
    expect(hasTokenIcon("NOT-A-TOKEN")).toBe(false);
  });
});
