// Attribution: see ATTRIBUTIONS.md #6 (derived data — monthly upstream re-review).
// Source: PoA bridge supported_tokens + per-chain queries (bridge.chaindefuser.com/rpc)
// as of 2026-06-08. Each entry maps one IntentFolio token to its withdrawal destination.
// The date stays 2026-06-08 on purpose: it is NOT a global re-measure date. Only some
// entries have been re-measured since (USDT-TRON in 4.2, the two Stellar ones in 4.4);
// each says so at its own definition.
//
// Rules (locked in 6.0):
//   - One chain per token (its native chain, inferred from the token-id prefix).
//   - Only chains present in chainRegistry are included; bridge chains without a
//     chainRegistry entry (movement:mainnet, etc.) are excluded.
//   - NEAR (native) is the one row that is NOT a bridge withdrawal: it leaves through
//     intents.near's own `native_withdraw`, to a NEAR account. Added 2026-08-20 — see the
//     `near-unwrap` note below and the entry itself.
//
// Bridge routes:
//   "omft"        – NEP-141 OMFT token; ft_withdraw intent → PoA bridge → external chain.
//   "hot-omni"    – NEP-245 HOT Omni token; mt_withdraw intent + hotOmniWithdraw call.
//   "near-native" – NEP-141 token that lives on NEAR; ft_withdraw intent → NEAR account.
//   "near-unwrap" – NEAR itself; `native_withdraw` intent → unwraps wNEAR and sends NATIVE
//                   NEAR to a NEAR account. No bridge and no token contract in the loop.
//   "omni"        – NEP-141 token migrated from PoA to the Omni Bridge, sent STRAIGHT to Omni:
//                   ft_withdraw intent → `omni.bridge.near` with the destination in `msg`. Its
//                   fee is signed and only live (omni-bridge.ts). ZEC only (D-580).
//
// Fee fields are in the token's own base units (same precision as the token decimals).
// Use getWithdrawalEstimate(nearTokenId, dummyAddress, chain) to get a live fee for
// OMFT tokens before the user enters their destination address.
// HOT Omni tokens: getWithdrawalEstimate is unsupported; use withdrawalFeeRaw directly.

import { chainRegistry } from "./chain-registry";
import {
  INTENTS_CONTRACT_ID,
  RETIRED_VAULT_CONTRACT_IDS,
  VAULT_CONTRACT_ID,
} from "@/features/wallet/config/network";

export type BridgeRoute = "omft" | "hot-omni" | "near-native" | "near-unwrap" | "omni";

export type WithdrawalEntry = {
  chainId: string;
  nearTokenId: string;  // near_token_id for getWithdrawalEstimate (no "nep141:" prefix)
  withdrawalFeeRaw: string;
  minWithdrawalRaw: string;
  bridgeRoute: BridgeRoute;
};

// Record<intents_token_id, WithdrawalEntry>
export const withdrawalRegistry: Record<string, WithdrawalEntry> = {

  // ── NEAR ───────────────────────────────────────────────────────────────────
  // The only key here that is NOT a Defuse asset id: it is the REGISTRY id, because that
  // is what every caller holds (`getWithdrawalEntry` is fed the same id as `getTokenById`).
  // Inside intents.near the balance is `nep141:wrap.near` — see intents-token-id.ts.
  //
  // `nearTokenId: "wrap.near"` is what gets unwrapped, not a contract we call: the
  // `native_withdraw` intent names no token. It is kept for the destination pre-flight and
  // for symmetry with the other rows. Fee 0 and minimum 1 are the live catalog's own
  // figures for `near:mainnet:native` (measured 2026-08-20).
  //
  // ⚠️ NEAR is redeemable on `sol:mainnet` too (same `nep141:wrap.near`), which no other
  // token in this table does — every other multi-chain asset is several distinct ids, so
  // one-chain-per-token holds for them by construction and not by choice. Supporting it
  // would turn this Record into one-to-many. That is D-286, and it is why this stays one
  // chain for now.
  "near": {
    chainId: "near:mainnet", nearTokenId: "wrap.near",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-unwrap",
  },

  // ── USDC ───────────────────────────────────────────────────────────────────
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": {
    chainId: "near:mainnet", nearTokenId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
  },
  "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near": {
    chainId: "eth:1", nearTokenId: "eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    withdrawalFeeRaw: "300000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near": {
    chainId: "eth:42161", nearTokenId: "arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    withdrawalFeeRaw: "5300", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near": {
    chainId: "eth:8453", nearTokenId: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    withdrawalFeeRaw: "2400", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near": {
    chainId: "sol:mainnet", nearTokenId: "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    withdrawalFeeRaw: "30000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near": {
    chainId: "sui:mainnet", nearTokenId: "sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near",
    withdrawalFeeRaw: "20000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near": {
    chainId: "aptos:mainnet", nearTokenId: "aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near",
    withdrawalFeeRaw: "2500", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L": {
    chainId: "eth:137", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "1000", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },
  "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r": {
    chainId: "eth:56", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "30000000000000000", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },
  "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o": {
    chainId: "eth:43114", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },
  "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ": {
    chainId: "eth:10", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },
  // Raw units here are 1e-7, not 1e-6 like every other USDC: see the decimals note in
  // token-registry. Fee and minimum re-measured 2026-08-07 against the live catalog.
  "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu": {
    chainId: "stellar:mainnet", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },

  // ── USDT ───────────────────────────────────────────────────────────────────
  "nep141:usdt.tether-token.near": {
    chainId: "near:mainnet", nearTokenId: "usdt.tether-token.near",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
  },
  "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near": {
    chainId: "eth:1", nearTokenId: "eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    withdrawalFeeRaw: "300000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near": {
    chainId: "eth:42161", nearTokenId: "arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near",
    withdrawalFeeRaw: "5300", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  // `minWithdrawalRaw` was "1" until the 4.2 pre-flight re-measured the live catalog: the
  // bridge floor for this token is a whole USDT, and withdraw-envelope compares the NET
  // against it. At "1" the app signed withdrawals that settle BELOW the floor, which the
  // bridge keeps silently — so a fix here is a loss window closing, not a limit tightening.
  // With fee 1e6 too, the smallest useful withdrawal is 2 USDT gross to deliver 1 USDT.
  "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near": {
    chainId: "tron:mainnet", nearTokenId: "tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
    withdrawalFeeRaw: "1000000", minWithdrawalRaw: "1000000", bridgeRoute: "omft",
  },
  "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near": {
    chainId: "sol:mainnet", nearTokenId: "sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
    withdrawalFeeRaw: "30000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:aptos-88cb7619440a914fe6400149a12b443c3ac21d59.omft.near": {
    chainId: "aptos:mainnet", nearTokenId: "aptos-88cb7619440a914fe6400149a12b443c3ac21d59.omft.near",
    withdrawalFeeRaw: "2500", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr": {
    chainId: "eth:137", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "1000", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },
  "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g": {
    chainId: "eth:56", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "30000000000000000", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },
  "nep245:v2_1.omni.hot.tg:43114_372BeH7ENZieCaabwkbWkBiTTgXp": {
    chainId: "eth:43114", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },
  "nep245:v2_1.omni.hot.tg:10_359RPSJVdTxwTJT9TyGssr2rFoWo": {
    chainId: "eth:10", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },
  "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR": {
    chainId: "ton:mainnet", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1000000", bridgeRoute: "hot-omni",
  },

  // ── DAI ────────────────────────────────────────────────────────────────────
  "nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near": {
    chainId: "eth:1", nearTokenId: "eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near",
    withdrawalFeeRaw: "300000000000000000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },

  // ── BTC / ETH / L1s ────────────────────────────────────────────────────────
  "nep141:btc.omft.near": {
    chainId: "btc:mainnet", nearTokenId: "btc.omft.near",
    withdrawalFeeRaw: "1500", minWithdrawalRaw: "700", bridgeRoute: "omft",
  },
  "nep141:eth.omft.near": {
    chainId: "eth:1", nearTokenId: "eth.omft.near",
    withdrawalFeeRaw: "35000000000000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:arb.omft.near": {
    chainId: "eth:42161", nearTokenId: "arb.omft.near",
    withdrawalFeeRaw: "1200000000000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:eth.bridge.near": {
    chainId: "near:mainnet", nearTokenId: "eth.bridge.near",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
  },
  "nep141:nbtc.bridge.near": {
    chainId: "near:mainnet", nearTokenId: "nbtc.bridge.near",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
  },
  "nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near": {
    chainId: "near:mainnet", nearTokenId: "2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
  },
  "nep141:sol.omft.near": {
    chainId: "sol:mainnet", nearTokenId: "sol.omft.near",
    withdrawalFeeRaw: "14000", minWithdrawalRaw: "1250000", bridgeRoute: "omft",
  },
  // XRP REMOVED 2026-08-20 (D-195), together with `depositable: false` on its registry row.
  // The row was `xrp:mainnet` / `xrp.omft.near` / fee 0 / min 1 / omft — restore it verbatim
  // once the XRPL pre-flight exists, and not before: a withdrawal to an exchange address
  // without a destination tag lands in a pooled account and is gone, with no error anywhere.
  // Taken out as the flags were turned on for the team-testing origin, because "the flag is
  // off" WAS this hole's entire safety argument.
  "nep141:doge.omft.near": {
    chainId: "doge:mainnet", nearTokenId: "doge.omft.near",
    withdrawalFeeRaw: "45000000", minWithdrawalRaw: "1000000", bridgeRoute: "omft",
  },
  "nep141:cardano.omft.near": {
    chainId: "cardano:mainnet", nearTokenId: "cardano.omft.near",
    withdrawalFeeRaw: "200000", minWithdrawalRaw: "1000000", bridgeRoute: "omft",
  },
  "nep141:ltc.omft.near": {
    chainId: "ltc:mainnet", nearTokenId: "ltc.omft.near",
    withdrawalFeeRaw: "500", minWithdrawalRaw: "7098", bridgeRoute: "omft",
  },
  "nep141:tron.omft.near": {
    chainId: "tron:mainnet", nearTokenId: "tron.omft.near",
    withdrawalFeeRaw: "290000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:sui.omft.near": {
    chainId: "sui:mainnet", nearTokenId: "sui.omft.near",
    withdrawalFeeRaw: "5000000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:aptos.omft.near": {
    chainId: "aptos:mainnet", nearTokenId: "aptos.omft.near",
    withdrawalFeeRaw: "50000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },

  // ── BNB / AVAX / POL / TON / OP (native gas tokens via HOT Omni) ───────────
  "nep245:v2_1.omni.hot.tg:56_11111111111111111111": {
    chainId: "eth:56", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "22000000000000", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },
  "nep245:v2_1.omni.hot.tg:43114_11111111111111111111": {
    chainId: "eth:43114", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },
  "nep245:v2_1.omni.hot.tg:137_11111111111111111111": {
    chainId: "eth:137", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "1500000000000000", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },
  "nep245:v2_1.omni.hot.tg:1117_": {
    chainId: "ton:mainnet", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },
  // XLM — the entry that makes stellar:mainnet the first live chain with memoRequired,
  // so this is what takes the deposit-memo path out of dead code (005.plan §5.4).
  "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz": {
    chainId: "stellar:mainnet", nearTokenId: "v2_1.omni.hot.tg",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "hot-omni",
  },

  // ── Liquid Staking ─────────────────────────────────────────────────────────
  "nep141:meta-pool.near": {
    chainId: "near:mainnet", nearTokenId: "meta-pool.near",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
  },

  // ── DeFi ───────────────────────────────────────────────────────────────────
  "nep141:mpdao-token.near": {
    chainId: "near:mainnet", nearTokenId: "mpdao-token.near",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
  },
  "nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near": {
    chainId: "eth:1", nearTokenId: "eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near",
    withdrawalFeeRaw: "1300000000000000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near": {
    chainId: "eth:1", nearTokenId: "eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near",
    withdrawalFeeRaw: "40000000000000000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near": {
    chainId: "eth:1", nearTokenId: "eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near",
    withdrawalFeeRaw: "20000000000000000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near": {
    chainId: "eth:42161", nearTokenId: "arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near",
    withdrawalFeeRaw: "10000000000000000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },

  // ── Privacy ────────────────────────────────────────────────────────────────
  "nep141:zec.omft.near": {
    // D-580: straight to the Omni Bridge, not PoA's legacy relay (which still works but charges
    // 0.00047 on top). The fee is signed and only ever live (omni-bridge.ts); these two figures
    // are the screen's starting point and the envelope's offline backstop, read from
    // `/api/v2/transfer-fee` on 2026-11-12: gas ceiling 22000 + protocol fee 10000, and
    // `min_amount` 100000 on the GROSS — expressed here as fee + minimum net (32000 + 68000).
    chainId: "zec:mainnet", nearTokenId: "zec.omft.near",
    withdrawalFeeRaw: "32000", minWithdrawalRaw: "68000", bridgeRoute: "omni",
  },

  // ── Web3 / Ecosystem ───────────────────────────────────────────────────────
  "nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near": {
    chainId: "near:mainnet", nearTokenId: "aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
  },
  "nep141:token.sweat": {
    chainId: "near:mainnet", nearTokenId: "token.sweat",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
  },
  "nep141:arb-0xca7dec8550f43a5e46e3dfb95801f64280e75b27.omft.near": {
    chainId: "eth:42161", nearTokenId: "arb-0xca7dec8550f43a5e46e3dfb95801f64280e75b27.omft.near",
    withdrawalFeeRaw: "2300000000000000000", minWithdrawalRaw: "1", bridgeRoute: "omft",
  },
  "nep141:token.publicailab.near": {
    chainId: "near:mainnet", nearTokenId: "token.publicailab.near",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
  },
  "nep141:token.rhealab.near": {
    chainId: "near:mainnet", nearTokenId: "token.rhealab.near",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
  },
  "nep141:npro.nearmobile.near": {
    chainId: "near:mainnet", nearTokenId: "npro.nearmobile.near",
    withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
  },
};

/** The one destination an `omft` row can take besides its native chain (D-384). */
export const NEAR_DESTINATION_CHAIN_ID = "near:mainnet";

/**
 * The `omft` tokens a NEAR account can actually be registered with, and therefore receive.
 *
 * The PoA token ships in two builds (`near/intents` `contracts/poa/token`): in the
 * `no-registration` one, `storage_deposit` is `only(self, owner)` — only the bridge factory
 * `omft.near` registers accounts, as a side effect of a bridge deposit. NEP-141 `ft_transfer`
 * refuses an unregistered receiver, so on those tokens a withdrawal to a NEAR account dead-ends:
 * the user cannot register (the wallet reports "Method is private"), and the pre-flight refuses.
 *
 * Measured 2026-09-30 (s202): code hash `Ba6uZKxs…` registers publicly (`towanda187.near` on
 * `sol.omft.near`, tx `Dr4V4i…`); `CFCLCkzf…` (`eth.omft.near`, `btc.omft.near`) panics "Method is
 * private" (tx `6coDiA14…`). `2VUeqHTx…` (ARB, Ethereum/Arbitrum/Base stablecoins, TRON, DOGE,
 * LTC, Sui, Cardano) is unmeasured: no user registration in its recent history either way.
 *
 * An explicit list, like `token-availability.ts`, so it fails closed: a token not measured is
 * simply not offered NEAR. If the factory ever redeploys one of these as `no-registration`,
 * the pre-flight still refuses the withdrawal and the register button costs only gas.
 */
export const NEAR_REGISTRABLE_OMFT: ReadonlySet<string> = new Set([
  "nep141:sol.omft.near",                                          // SOL
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", // USDC (SOL)
  "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", // USDT (SOL)
  "nep141:aptos.omft.near",                                        // APT
  "nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near", // USDC (APT)
  "nep141:aptos-88cb7619440a914fe6400149a12b443c3ac21d59.omft.near", // USDT (APT)
]);

/**
 * The withdrawal route for a token, sent to a destination chain.
 *
 * With no `chainId`, or with the row's own chain, this is the registry row. With
 * `near:mainnet` on an `omft` row it is a DERIVED `near-native` entry (D-384): the same NEP-141
 * (`sol.omft.near`, …) leaves intents.near with a plain `ft_withdraw` to a NEAR account, as
 * near.com's Universal Send does, and arrives there as that token — not as the native asset,
 * which only the bridge delivers. Fee 0 and minimum 1 because no bridge is involved: the same
 * figures as every other `near-native` row.
 *
 * Derived, not stored, so the registry stays one row per token (D-286). Only for the tokens in
 * `NEAR_REGISTRABLE_OMFT`. Any other pair is `undefined`: `hot-omni` is NEP-245, which a NEAR
 * wallet does not show, and a chain nobody offered must not route money because a caller
 * asked for it.
 */
export function getWithdrawalEntry(tokenId: string, chainId?: string): WithdrawalEntry | undefined {
  const entry = withdrawalRegistry[tokenId];
  if (!entry || chainId === undefined || chainId === entry.chainId) return entry;
  if (
    chainId === NEAR_DESTINATION_CHAIN_ID &&
    entry.bridgeRoute === "omft" &&
    NEAR_REGISTRABLE_OMFT.has(tokenId)
  ) {
    // Cached, so the derived entry keeps one identity like a registry row does: components
    // read it during render and hooks list it as a dependency, and a fresh object on every
    // call re-ran those hooks without end.
    let derived = nearDestinationEntries.get(tokenId);
    if (!derived) {
      derived = {
        chainId: NEAR_DESTINATION_CHAIN_ID,
        nearTokenId: entry.nearTokenId,
        withdrawalFeeRaw: "0",
        minWithdrawalRaw: "1",
        bridgeRoute: "near-native",
      };
      nearDestinationEntries.set(tokenId, derived);
    }
    return derived;
  }
  return undefined;
}

const nearDestinationEntries = new Map<string, WithdrawalEntry>();

/**
 * The NEAR token an `omft` row lands as when withdrawn to NEAR instead of its own chain
 * (D-384), e.g. `sol.omft.near` for SOL; null on every other pair. What the toasts and the
 * activity row name after the send (D-386 a), as steps 3 and 4 already do.
 */
export function nearTokenArrival(tokenId: string, chainId: string): string | null {
  if (chainId !== NEAR_DESTINATION_CHAIN_ID || withdrawalRegistry[tokenId]?.chainId === chainId) return null;
  return getWithdrawalEntry(tokenId, chainId)?.nearTokenId ?? null;
}

/**
 * Why a NEAR account cannot be the receiver of a withdrawal on a NEAR route, or null if it can.
 *
 * - `token-contract`: the token's own contract. On an `omft` token that is the PoA bridge's
 *   withdrawal shape without the memo saying where to (D-384); no NEP-141 holds its own balance.
 * - `system-contract`: `intents.near` or a vault, the configured one or a retired one. They are
 *   registered on every token, so the pre-flight passes, and a plain `ft_transfer` to one lands
 *   nowhere the user can reach — while the withdrawal settles and reads as delivered. A retired
 *   vault is worse: once deleted, anyone can register its name again.
 */
export function unreceivableNearDestination(
  entry: WithdrawalEntry,
  address: string
): "token-contract" | "system-contract" | null {
  if (entry.bridgeRoute !== "near-native" && entry.bridgeRoute !== "near-unwrap") return null;
  if (address === entry.nearTokenId) return "token-contract";
  if (address === INTENTS_CONTRACT_ID || address === VAULT_CONTRACT_ID || RETIRED_VAULT_CONTRACT_IDS.has(address)) {
    return "system-contract";
  }
  return null;
}

/** Every destination chain a token can be withdrawn to, its native chain first. */
export function withdrawalDestinations(tokenId: string): string[] {
  const entry = withdrawalRegistry[tokenId];
  if (!entry) return [];
  return entry.bridgeRoute === "omft" && NEAR_REGISTRABLE_OMFT.has(tokenId)
    ? [entry.chainId, NEAR_DESTINATION_CHAIN_ID]
    : [entry.chainId];
}

// Returns true if the given token has a known withdrawal path. Every depositable token has one
// (NEAR native since `near-unwrap`, D-176): Receive derives its pairs from this registry (D-467).
export function isWithdrawable(tokenId: string): boolean {
  return tokenId in withdrawalRegistry;
}

// Validates that all chainIds in the registry exist in chainRegistry.
// Called in tests; not exported for production use.
export function _validateChainIds(): string[] {
  return Object.entries(withdrawalRegistry)
    .filter(([, entry]) => !(entry.chainId in chainRegistry))
    .map(([tokenId, entry]) => `${tokenId} → unknown chainId "${entry.chainId}"`);
}
