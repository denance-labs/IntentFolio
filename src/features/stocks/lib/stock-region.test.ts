import { describe, expect, it } from "vitest";
import {
  COUNTRY_COOKIE,
  countryFromCookies,
  isStockBlockedCountry,
  isStockBlockedRequest,
  normalizeCountry,
} from "./stock-region";

// D-569: the operator chose near.com's list, by the country of the visitor's IP.
describe("stock region (D-569)", () => {
  it("blocks the United States and Canada, as near.com does", () => {
    expect(isStockBlockedCountry("US")).toBe(true);
    expect(isStockBlockedCountry("CA")).toBe(true);
    expect(isStockBlockedCountry(" us ")).toBe(true);
  });

  it("leaves every other country open, Puerto Rico included, as near.com does", () => {
    for (const code of ["AR", "MX", "GB", "DE", "BR", "PR"]) expect(isStockBlockedCountry(code)).toBe(false);
  });

  it("never blocks a country it does not know", () => {
    for (const value of [null, undefined, "", "USA", "U", "1A"]) expect(isStockBlockedCountry(value)).toBe(false);
  });

  it("only takes two letters as a country", () => {
    expect(normalizeCountry("ar")).toBe("AR");
    expect(normalizeCountry("USA")).toBeNull();
    expect(normalizeCountry("U S")).toBeNull();
  });

  it("on a request, trusts Vercel's header first and falls back to the cookie", () => {
    expect(isStockBlockedRequest("US", null)).toBe(true);
    expect(isStockBlockedRequest("AR", `${COUNTRY_COOKIE}=US`)).toBe(false);
    expect(isStockBlockedRequest(null, `${COUNTRY_COOKIE}=CA`)).toBe(true);
    expect(isStockBlockedRequest(null, null)).toBe(false);
  });

  it("reads the country from the cookies, among others", () => {
    expect(countryFromCookies(`a=1; ${COUNTRY_COOKIE}=US; b=2`)).toBe("US");
    expect(countryFromCookies(`${COUNTRY_COOKIE}=ca`)).toBe("CA");
    expect(countryFromCookies("a=1; b=2")).toBeNull();
    expect(countryFromCookies("")).toBeNull();
    expect(countryFromCookies(`${COUNTRY_COOKIE}-old=US`)).toBeNull();
    expect(countryFromCookies(`${COUNTRY_COOKIE}=`)).toBeNull();
  });
});
