// D-569: where the stocks can't be bought. Ondo, which issues them, bars a longer list (plan 038,
// "Restricciones"); the operator chose to block what near.com blocks, by the country of the
// visitor's IP. Vercel sends that country as `x-vercel-ip-country`, and the middleware keeps it in
// a cookie the page can read. Selling stays open everywhere, so nobody who already holds a stock is
// left unable to get out of it.
//
// Without the header (local, or a host that does not send it) there is no cookie and nothing is
// blocked, as on near.com. A VPN gets past it, also as on near.com.
//
// Attribution: see ATTRIBUTIONS.md #24 (the country set behind near.com's `ondo-country` gate).

/** ISO 3166-1 alpha-2 codes where the stocks can't be bought: near.com's list (D-569). */
export const STOCK_BLOCKED_COUNTRIES: ReadonlySet<string> = new Set(["US", "CA"]);

/** The cookie the middleware writes from `x-vercel-ip-country`. Not HttpOnly: the page reads it. */
export const COUNTRY_COOKIE = "intentfolio-country";

/** A two-letter country code in upper case, or null when the value is not one. */
export function normalizeCountry(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Whether stocks can't be bought from this country. Unknown is never blocked. */
export function isStockBlockedCountry(country: string | null | undefined): boolean {
  const code = normalizeCountry(country);
  return code !== null && STOCK_BLOCKED_COUNTRIES.has(code);
}

/**
 * For a page rendered on each request (the landing): Vercel's country header, or, where there is
 * none (local), the cookie, so a test can set it by hand as on the app.
 */
export function isStockBlockedRequest(countryHeader: string | null, cookieHeader: string | null): boolean {
  return isStockBlockedCountry(normalizeCountry(countryHeader) ?? countryFromCookies(cookieHeader ?? ""));
}

/** The country kept in a `document.cookie` string, or null when there is none. */
export function countryFromCookies(cookies: string): string | null {
  for (const part of cookies.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === COUNTRY_COOKIE) return normalizeCountry(part.slice(eq + 1));
  }
  return null;
}
