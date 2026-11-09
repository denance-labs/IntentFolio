"use client";

import { useSyncExternalStore } from "react";
import { countryFromCookies, isStockBlockedCountry } from "../lib/stock-region";

// The cookie has no change event. The server writes it on the request that loads or navigates to
// the page, so it is in place before anything here renders. False on the server and while
// hydrating, so the markup matches, and the real answer comes on the render after.
const subscribe = () => () => {};
const readBlocked = () => isStockBlockedCountry(countryFromCookies(document.cookie));
const serverBlocked = () => false;

/** D-569: whether stocks can't be bought from where this visitor is. Selling is never gated. */
export function useStocksRegionBlocked(): boolean {
  return useSyncExternalStore(subscribe, readBlocked, serverBlocked);
}
