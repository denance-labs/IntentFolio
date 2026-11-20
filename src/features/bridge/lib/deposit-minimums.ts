// Attribution: see ATTRIBUTIONS.md #13 (1Click API v0 — measured minimums).

/**
 * Minimum deposit per intents token id, in base units (D-584): what 1Click answers to a `dry` quote
 * of the token to itself below it — "Amount is too low for bridge, try at least N" — measured
 * 2026-11-15 for every pair Receive offers. PoA's own catalog closed with its Bridge API. Tokens
 * that answered "try at least 0" (Omni-routed chains, Solana tokens) and NEAR-native tokens have
 * no row: no minimum line. ZEC is the Omni Zcash connector's `min_deposit_amount` (D-580), and
 * 1Click answers the same.
 */
export const MIN_DEPOSIT_RAW: Readonly<Record<string, string>> = {
  "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near": "1000",
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near": "1000",
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near": "150000",
  "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near": "1000",
  "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near": "1000",
  "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near": "1000000",
  "nep141:btc.omft.near": "6400",
  "nep141:eth.omft.near": "100000000000",
  "nep141:arb.omft.near": "100000000000",
  "nep141:sol.omft.near": "890880",
  "nep141:zec.omft.near": "100000",
};
