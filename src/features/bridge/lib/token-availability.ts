// Day-1 scope of the team testing MVP (008.plan §"Alcance del MVP de testeo del equipo",
// LOCKED 2026-08-12). 40 of the 56 `withdrawalRegistry` rows are enabled; the other 16 are
// shown as "Not available yet" and cannot be selected. (35 of 56 at the lock; XRP left the registry
// with D-195, and BTC/DOGE/LTC came in with their validators, D-278.)
//
// WHY THE CUT IS WHERE IT IS. Not by chain and not by token family, but by withdrawal route
// and by native/non-native:
//
//   - `near-native` (12) — all in. Withdrawing lands in a NEAR account; no bridge floor to
//     get wrong, no external address format to validate.
//   - `near-unwrap` (1, NEAR itself) — in, for the same reason: it lands in a NEAR account.
//     Added 2026-08-20 with the route (D-176). Before it existed NEAR was deposit-only, and
//     the paragraph below about stranded tokens applied to our own flagship asset.
//   - `omft` (21 of 27) — in only where `validateAddress` has a real validator for the
//     destination chain, which is what makes a typo detectable before an irreversible
//     transfer. That leaves out the 6 rows on chains with no validator (Aptos, Cardano, Sui).
//   - `omni` (1, ZEC) — in since 2026-11-13 (D-580): straight to the Omni Bridge, to a
//     transparent Zcash address `validateZcash` checks. Opened by the operator before its own
//     real-money withdrawal, which runs right after publishing (D-579's rule, changed).
//
//     BTC, DOGE and LTC were briefly enabled here (2026-08-12) on the assumption that D-278
//     would land first; it did not, and shipping them would have meant forwarding a typo to
//     the bridge. Removed 2026-08-13, and back 2026-09-30 (017-4b) in the order that note
//     asked for: base58check/bech32 validators first, then the three ids.
//   - `hot-omni` (5 of 15) — natives only. `hot-fee.ts:652` returns `payment: "in-kind"` for
//     the chain's native asset, so a native pays its gas in itself: one signature, no swap.
//     The 10 non-native rows need the gas purchase (D-257) and wait for it.
//
// WHY THE ALLOWLIST IS AN EXPLICIT LIST OF IDS AND NOT A RULE OVER `bridgeRoute`. A rule
// would auto-enable whatever gets added to the registry later — a new row would become live
// money by being typed into a table, which is the failure `withdraw-flag.ts` already refuses.
// Listing the enabled ids means the default for anything new is "Not available yet": it fails
// closed, and turning a row on stays a deliberate edit. `token-availability.test.ts` fixes
// the counts and asserts every id here still exists in the registry, so a typo shows up as a
// failing test rather than as a row that silently disappeared from the product.
//
// WHY DEFERRED ROWS ARE SHOWN RATHER THAN HIDDEN. Every depositable token is now also
// withdrawable — NEAR was the last exception and D-176 closed it. Restricting the
// withdrawal while Receive kept offering everything would manufacture 21 stranded tokens —
// the dishonesty of D-201, except self-inflicted. And hiding them outright would read as
// "IntentFolio forgot Polygon", which a tester reports as a bug. One label, both flows.

import { isStockToken } from "@/features/market/lib/stock-tokens";

export type TokenAvailability = "available" | "not-available-yet";

/**
 * Defuse asset ids withdrawable on day 1. Keys of `withdrawalRegistry`; anything absent
 * here is "Not available yet", including ids that are not in the registry at all.
 */
export const DAY_ONE_TOKEN_IDS: ReadonlySet<string> = new Set([
  // ── near-unwrap (1) — NEAR itself, out through `native_withdraw` ─────────────
  "near",

  // ── near-native (12) — every NEAR row ────────────────────────────────────────
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // USDC (NEAR)
  "nep141:usdt.tether-token.near",                                           // USDT (NEAR)
  "nep141:eth.bridge.near",                                                  // ETH (NEAR)
  "nep141:nbtc.bridge.near",                                                 // nBTC
  "nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near",     // WBTC
  "nep141:meta-pool.near",                                                   // stNEAR
  "nep141:mpdao-token.near",                                                 // mpDAO
  "nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near",     // AURORA
  "nep141:token.sweat",                                                      // SWEAT
  "nep141:token.publicailab.near",                                           // PUBLIC
  "nep141:token.rhealab.near",                                               // RHEA
  "nep141:npro.nearmobile.near",                                             // NPRO

  // ── omft (21) — only the chains `validateAddress` can actually check ─────────
  // Ethereum (7)
  "nep141:eth.omft.near",                                                    // ETH
  "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",         // USDC
  "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",         // USDT
  "nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near",         // DAI
  "nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near",         // LINK
  "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near",         // UNI
  "nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near",         // AAVE
  // Arbitrum (5)
  "nep141:arb.omft.near",                                                    // ETH (ARB)
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",         // USDC (ARB)
  "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near",         // USDT (ARB)
  "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near",         // ARB
  "nep141:arb-0xca7dec8550f43a5e46e3dfb95801f64280e75b27.omft.near",         // SWEAT (ARB)
  // Base (1)
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",        // USDC (BASE)
  // Solana (3)
  "nep141:sol.omft.near",                                                    // SOL
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",           // USDC (SOL)
  "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",           // USDT (SOL)
  // Tron (2)
  "nep141:tron.omft.near",                                                   // TRX
  "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",          // USDT (TRON)
  // Bitcoin and its forks (3) — base58check + bech32/bech32m validators (D-278)
  "nep141:btc.omft.near",                                                    // BTC
  "nep141:doge.omft.near",                                                   // DOGE
  "nep141:ltc.omft.near",                                                    // LTC

  // ── omni (1) — ZEC straight to the Omni Bridge, to a t1/t3 address (D-580) ──
  "nep141:zec.omft.near",                                                    // ZEC

  // ── hot-omni (5) — natives only; they pay gas in kind, so no purchase ────────
  "nep245:v2_1.omni.hot.tg:137_11111111111111111111",                        // POL
  "nep245:v2_1.omni.hot.tg:56_11111111111111111111",                         // BNB
  "nep245:v2_1.omni.hot.tg:43114_11111111111111111111",                      // AVAX
  "nep245:v2_1.omni.hot.tg:1117_",                                           // GRAM (TON)
  "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz", // XLM
]);

/** Whether this (asset, chain) pair is in the day-1 scope. Unknown ids are not. */
export function isTokenAvailable(tokenId: string): boolean {
  return DAY_ONE_TOKEN_IDS.has(tokenId);
}

export function tokenAvailability(tokenId: string): TokenAvailability {
  return isTokenAvailable(tokenId) ? "available" : "not-available-yet";
}

// THE CURATED CATALOG (D-396, 018.plan §"Decisiones del operador (s203)"). A token belongs in
// a portfolio only if it can leave both to a NEAR wallet and to its own network. These 16 have
// no NEAR version at all (1Click: "recipient is not valid"), so they fail the first half.
//
// They leave what IntentFolio OFFERS — Receive and "Add tokens to portfolio" — and nothing else. The
// withdrawal keeps `DAY_ONE_TOKEN_IDS` as it is: the General Balance is the user's
// `intents.near` balance, which near.com fills too, so someone can hold DOGE without ever
// having received it here, and taking the exit away would strand it.
//
// A list of what is OUT, not of what is in, because both flows already have their own
// fail-closed gate (`DAY_ONE_TOKEN_IDS` for Receive, `depositable` for the portfolio); this
// only subtracts from them. Per (asset, chain) id like the allowlist above: USDC on Sui is
// not here, because USDC reaches a NEAR wallet as USDC(NEAR).
export const NO_NEAR_VERSION_TOKEN_IDS: ReadonlySet<string> = new Set([
  "nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near",         // DAI
  "nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near",         // AAVE
  "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near",         // UNI
  "nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near",         // LINK
  "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near",         // ARB
  "nep141:doge.omft.near",                                                   // DOGE
  "nep141:ltc.omft.near",                                                    // LTC
  "nep141:tron.omft.near",                                                   // TRX
  "nep141:cardano.omft.near",                                                // ADA
  "nep141:sui.omft.near",                                                    // SUI
  "nep141:aptos.omft.near",                                                  // APT
  "nep245:v2_1.omni.hot.tg:56_11111111111111111111",                         // BNB
  "nep245:v2_1.omni.hot.tg:43114_11111111111111111111",                      // AVAX
  "nep245:v2_1.omni.hot.tg:137_11111111111111111111",                        // POL
  "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz", // XLM
  "nep245:v2_1.omni.hot.tg:1117_",                                           // GRAM (TON)
]);

/** Whether the token has a NEAR version, i.e. is in the curated catalog (D-396). */
export function isInCatalog(tokenId: string): boolean {
  return !NO_NEAR_VERSION_TOKEN_IDS.has(tokenId);
}

// NO BUY ROUTE (D-491, 029 B-4). A portfolio converges by buying its targets; these five had no
// buy route in any of three measurements (2026-10-18/19, `scripts/measure-token-availability.py`,
// 1Click `dry: true` quotes from USDC(NEAR) at ~$20 and ~$1,000):
//
//   - BTC (`btc.omft.near`) and mpDAO — "No liquidity available" to buy; selling quotes.
//   - RHEA — buys at $20 only at −28…−38 %, none at $1,000; selling quotes.
//   - SWEAT and SWEAT(ARB) — no quote in either direction.
//
// A target nobody can fill leaves the portfolio short of it forever, so these are not offered as
// a target. They stay receivable, holdable, sellable and withdrawable: a Bitcoin deposit lands as
// `btc.omft.near`, and a portfolio that holds one can still sell it towards its other targets.
// An explicit list like the two above, so a token comes back only by a deliberate edit once a
// re-measurement shows a buy route (D-491 step 3).
//
// stNEAR is here for a different reason (D-554, operator decision 2026-11-11): it does quote, but
// almost nobody swaps it, so a target in it would leave the portfolio far from its mix. Same
// treatment: no new target, still receivable, holdable, sellable and withdrawable.
export const NO_BUY_ROUTE_TOKEN_IDS: ReadonlySet<string> = new Set([
  "nep141:btc.omft.near",                                                    // BTC
  "nep141:mpdao-token.near",                                                 // mpDAO
  "nep141:token.rhealab.near",                                               // RHEA
  "nep141:token.sweat",                                                      // SWEAT
  "nep141:arb-0xca7dec8550f43a5e46e3dfb95801f64280e75b27.omft.near",         // SWEAT (ARB)
  "nep141:meta-pool.near",                                                   // stNEAR (D-554: low activity)
]);

// NOT RECEIVED (D-491). Of the five above, three are not received either: SWEAT and SWEAT(ARB)
// cannot even be sold, and RHEA was the operator's call (thin, and a deposit IntentFolio can
// only hand back is not worth taking). BTC and mpDAO stay receivable because they sell: a
// Bitcoin deposit can go into a portfolio as funds and be sold towards its targets. Like the
// catalog cut, this subtracts from Receive only — a held RHEA still gets out.
export const NOT_RECEIVED_TOKEN_IDS: ReadonlySet<string> = new Set([
  "nep141:token.rhealab.near",                                               // RHEA
  "nep141:token.sweat",                                                      // SWEAT
  "nep141:arb-0xca7dec8550f43a5e46e3dfb95801f64280e75b27.omft.near",         // SWEAT (ARB)
]);

// NO SELL ROUTE (D-491). The two SWEATs did not quote towards USDC(NEAR) either, so funds of
// them inside a portfolio could never be converted into its targets. They are not offered as
// funds for a new portfolio; they stay in the funding account, withdrawable.
export const NO_SELL_ROUTE_TOKEN_IDS: ReadonlySet<string> = new Set([
  "nep141:token.sweat",                                                      // SWEAT
  "nep141:arb-0xca7dec8550f43a5e46e3dfb95801f64280e75b27.omft.near",         // SWEAT (ARB)
]);

// WITHDRAWAL PENDING (D-579, operator decision 2026-11-11): a token received, held, bought and sold
// while its withdrawal stays "Not available yet" (it is not in `DAY_ONE_TOKEN_IDS`). EMPTY since
// 2026-11-13: ZEC, the one token it was made for, opened with the `omni` route (D-580). Kept as the
// mechanism for the next token that needs the same two stages.
//
// This is the one exception to D-389 below, and why it is safe: D-389 kept unwithdrawable tokens
// out of portfolios because a portfolio that bought one would strand it. ZEC has a sell route
// (1Click quotes it towards USDC(NEAR) at $20 and $1,000, measured 2026-11-11), so a holder can
// always leave it as USDC. Opening the withdrawal means moving the id to `DAY_ONE_TOKEN_IDS` and
// out of this set.
export const WITHDRAWAL_PENDING_TOKEN_IDS: ReadonlySet<string> = new Set<string>([]);

// In the catalog is not enough to go into a portfolio: 13 catalog tokens (the Sui/Aptos stables
// and the non-native hot-omni stables) cannot be withdrawn yet, so a portfolio that bought one
// would strand it (D-389). The portfolio gets the set Receive offers, minus the tokens it could
// never buy (D-491).
/** Whether IntentFolio offers this token as a portfolio target (D-396, D-389, D-491). */
export function isPortfolioOfferable(tokenId: string): boolean {
  // A stock has no withdrawal route: the way out is selling it inside the Funding Account (plan 039).
  if (isStockToken(tokenId)) return true;
  return isReceivable(tokenId) && !NO_BUY_ROUTE_TOKEN_IDS.has(tokenId);
}

/**
 * Whether Receive offers this (asset, chain) pair: withdrawable today (or pending its withdrawal
 * with a sell route, D-579), in the catalog, not cut (D-491).
 */
export function isReceivable(tokenId: string): boolean {
  return (
    (isTokenAvailable(tokenId) || WITHDRAWAL_PENDING_TOKEN_IDS.has(tokenId)) &&
    isInCatalog(tokenId) &&
    !NOT_RECEIVED_TOKEN_IDS.has(tokenId)
  );
}
