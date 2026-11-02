import type { TokenDefinition } from "../types";
import { toRegistryTokenId } from "./intents-token-id";

// Source: 1Click intent solver token catalog (https://1click.chaindefuser.com/v0/tokens)
// plus a few NEAR-native tokens kept for wallet visibility even if not routable.
//
// `depositable: true`  -> token is in 1Click; can be deposited into the portfolio.
// `depositable: false` -> token is NEAR-native but NOT in 1Click; shown in wallet for
//                          visibility only (e.g. legacy bridged stables, LINEAR, REF, $META).
//
// wNEAR (nep141:wrap.near) is intentionally absent — it is internal to the
// NEAR-unified balance concept and handled via WNEAR_CONTRACT_ID in
// wallet/config/network.ts.
// Two ETH entries coexist (eth.bridge.near / eth.omft.near): they are distinct assets.
// Each entry is a first-class token keyed by its Defuse asset id — there is no
// canonical grouping (root ADR-0007; reverses D-016). `assetName` is only an
// optional label used by the Receive/Withdraw routing pickers.
export const tokenRegistry: TokenDefinition[] = [
  // Native NEAR — unified entry; balance fetcher sums native + wNEAR (see D-011, WNEAR_CONTRACT_ID)
  {
    id: "near",
    symbol: "NEAR",
    name: "NEAR Protocol",
    contractId: null,
    decimals: 24,
    category: "Core",
    fallbackUsdPrice: 1.58,
    depositable: true,
    assetName: "NEAR",
  },

  // ---- Stablecoins ----------------------------------------------------------
  {
    id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    symbol: "USDC(NEAR)",
    name: "USDC (on NEAR)",
    contractId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999678,
    depositable: true,
    assetName: "USDC",
  },
  {
    id: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    symbol: "USDC(ETH)",
    name: "USDC (on Ethereum)",
    contractId: "eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999867,
    depositable: true,
    assetName: "USDC",
  },
  {
    id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    symbol: "USDC(ARB)",
    name: "USDC (on Arbitrum)",
    contractId: "arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999715,
    depositable: true,
    assetName: "USDC",
  },
  {
    id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    symbol: "USDC(BASE)",
    name: "USDC (on Base)",
    contractId: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999715,
    depositable: true,
    assetName: "USDC",
  },
  {
    id: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    symbol: "USDC(SOL)",
    name: "USDC (on Solana)",
    contractId: "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999721,
    depositable: true,
    assetName: "USDC",
  },
  {
    id: "nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near",
    symbol: "USDC(SUI)",
    name: "USDC (on Sui)",
    contractId: "sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999715,
    depositable: true,
    assetName: "USDC",
  },
  {
    id: "nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near",
    symbol: "USDC(APT)",
    name: "USDC (on Aptos)",
    contractId: "aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999715,
    depositable: true,
    assetName: "USDC",
  },
  {
    id: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",
    symbol: "USDC(POL)",
    name: "USDC (on Polygon)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999721,
    depositable: true,
    assetName: "USDC",
  },
  {
    id: "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r",
    symbol: "USDC(BSC)",
    name: "USDC (on BNB Chain)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 18,
    category: "Stable",
    fallbackUsdPrice: 0.999715,
    depositable: true,
    assetName: "USDC",
  },
  {
    id: "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o",
    symbol: "USDC(AVAX)",
    name: "USDC (on Avalanche)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999715,
    depositable: true,
    assetName: "USDC",
  },
  {
    id: "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ",
    symbol: "USDC(OP)",
    name: "USDC (on Optimism)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999715,
    depositable: true,
    assetName: "USDC",
  },
  // The only USDC with 7 decimals, not 6: Stellar denominates in stroops (1e-7) and the
  // bridge reports the asset that way. Measured against the live PoA catalog and 1Click,
  // which agree. Copying the shape of the entries above would silently be off by 10x.
  {
    id: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu",
    symbol: "USDC(STELLAR)",
    name: "USDC (on Stellar)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 7,
    category: "Stable",
    fallbackUsdPrice: 0.999635,
    depositable: true,
    assetName: "USDC",
  },
  {
    id: "nep141:usdt.tether-token.near",
    symbol: "USDT(NEAR)",
    name: "USDT (on NEAR)",
    contractId: "usdt.tether-token.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999663,
    depositable: true,
    assetName: "USDT",
  },
  {
    id: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    symbol: "USDT(ETH)",
    name: "USDT (on Ethereum)",
    contractId: "eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999861,
    depositable: true,
    assetName: "USDT",
  },
  // The bridge names this asset "USDT0" (Tether's LayerZero rebrand on Arbitrum); we keep the
  // registry's USDT(<CHAIN>) label so it groups with the other USDT entries in the routing pickers.
  {
    id: "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near",
    symbol: "USDT(ARB)",
    name: "USDT (on Arbitrum)",
    contractId: "arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.99875,
    depositable: true,
    assetName: "USDT",
  },
  {
    id: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
    symbol: "USDT(TRON)",
    name: "USDT (on Tron)",
    contractId: "tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999009,
    depositable: true,
    assetName: "USDT",
  },
  {
    id: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
    symbol: "USDT(SOL)",
    name: "USDT (on Solana)",
    contractId: "sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999682,
    depositable: true,
    assetName: "USDT",
  },
  {
    id: "nep141:aptos-88cb7619440a914fe6400149a12b443c3ac21d59.omft.near",
    symbol: "USDT(APT)",
    name: "USDT (on Aptos)",
    contractId: "aptos-88cb7619440a914fe6400149a12b443c3ac21d59.omft.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999009,
    depositable: true,
    assetName: "USDT",
  },
  {
    id: "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr",
    symbol: "USDT(POL)",
    name: "USDT (on Polygon)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999682,
    depositable: true,
    assetName: "USDT",
  },
  {
    id: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g",
    symbol: "USDT(BSC)",
    name: "USDT (on BNB Chain)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 18,
    category: "Stable",
    fallbackUsdPrice: 0.999009,
    depositable: true,
    assetName: "USDT",
  },
  {
    id: "nep245:v2_1.omni.hot.tg:43114_372BeH7ENZieCaabwkbWkBiTTgXp",
    symbol: "USDT(AVAX)",
    name: "USDT (on Avalanche)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999009,
    depositable: true,
    assetName: "USDT",
  },
  {
    id: "nep245:v2_1.omni.hot.tg:10_359RPSJVdTxwTJT9TyGssr2rFoWo",
    symbol: "USDT(OP)",
    name: "USDT (on Optimism)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999009,
    depositable: true,
    assetName: "USDT",
  },
  {
    id: "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR",
    symbol: "USDT(TON)",
    name: "USDT (on TON)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999009,
    depositable: true,
    assetName: "USDT",
  },
  {
    id: "nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near",
    symbol: "DAI",
    name: "Dai Stablecoin (on Ethereum)",
    contractId: "eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near",
    decimals: 18,
    category: "Stable",
    fallbackUsdPrice: 0.999502,
    depositable: true,
    assetName: "DAI",
  },

  // ---- Stable (legacy, NOT in 1Click — wallet-visible only) -----------------
  {
    id: "nep141:a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near",
    symbol: "USDC.e",
    name: "USDC bridged from Ethereum (on NEAR)",
    contractId: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999733,
    depositable: false,
  },
  {
    id: "nep141:dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near",
    symbol: "USDT.e",
    name: "USDT bridged from Ethereum (on NEAR)",
    contractId: "dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near",
    decimals: 6,
    category: "Stable",
    fallbackUsdPrice: 0.999671,
    depositable: false,
  },
  {
    id: "nep141:usn",
    symbol: "USN",
    name: "USN",
    contractId: "usn",
    decimals: 18,
    category: "Stable",
    fallbackUsdPrice: 0.08538689,
    depositable: false,
  },

  // ---- Core (NEAR + major L1s + BTC/ETH) ------------------------------------
  {
    id: "nep141:btc.omft.near",
    symbol: "BTC",
    name: "Bitcoin (on Bitcoin)",
    contractId: "btc.omft.near",
    decimals: 8,
    category: "Core",
    fallbackUsdPrice: 81144,
    depositable: true,
    assetName: "BTC",
  },
  // nBTC: the BTC a portfolio should hold (D-396). 1Click sells it (`btc.omft.near` has no buy
  // liquidity there) and it reaches a NEAR account as a plain NEP-141 (public
  // `storage_deposit`, 0.00125 NEAR). Reaching Bitcoin goes through 1Click, which is the
  // universal withdrawal (D-392), not a route here yet. `btc.omft.near` above stays: it is
  // what a Bitcoin deposit lands as.
  {
    id: "nep141:nbtc.bridge.near",
    symbol: "nBTC",
    name: "Bitcoin (on NEAR)",
    contractId: "nbtc.bridge.near",
    decimals: 8,
    category: "Core",
    fallbackUsdPrice: 83770,
    depositable: true,
    assetName: "BTC",
  },
  {
    id: "nep141:eth.omft.near",
    symbol: "ETH",
    // D-407: two ETH sit side by side in every picker; the name says where each one goes
    // out to, not which bridge minted it (that is what the user cannot resolve alone).
    name: "Ethereum (on Ethereum)",
    contractId: "eth.omft.near",
    decimals: 18,
    category: "Core",
    fallbackUsdPrice: 2272.1,
    depositable: true,
    assetName: "ETH",
  },
  {
    id: "nep141:eth.bridge.near",
    symbol: "ETH",
    name: "Ethereum (on NEAR)",
    contractId: "eth.bridge.near",
    decimals: 18,
    category: "Core",
    fallbackUsdPrice: 2304.86710575,
    depositable: true,
    assetName: "ETH",
  },
  {
    id: "nep141:arb.omft.near",
    symbol: "ETH(ARB)",
    name: "Ethereum (on Arbitrum)",
    contractId: "arb.omft.near",
    decimals: 18,
    category: "Core",
    fallbackUsdPrice: 1904.51,
    depositable: true,
    assetName: "ETH",
  },
  {
    id: "nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near",
    symbol: "WBTC",
    name: "Wrapped Bitcoin (on NEAR)",
    contractId: "2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near",
    decimals: 8,
    category: "Core",
    fallbackUsdPrice: 80795,
    depositable: true,
  },
  {
    id: "nep141:sol.omft.near",
    symbol: "SOL",
    name: "Solana (on Solana)",
    contractId: "sol.omft.near",
    decimals: 9,
    category: "Core",
    fallbackUsdPrice: 84.15,
    depositable: true,
  },
  // XRP is `depositable: false` on purpose, and it is NOT an oversight (D-195, 2026-08-20).
  // Withdrawing to XRP Ledger needs a destination tag that we do not ask for, and most
  // exchange addresses require one: without it the funds land in a pooled account with
  // nothing to attribute them by — settled, unrecoverable, and silent. Its
  // `withdrawalRegistry` row was removed in the same change, so the pair is off at BOTH
  // ends and the Deposit-only set stays empty.
  //
  // It stays in the registry (rather than being deleted) because the asset itself is fine:
  // a portfolio can hold XRP today, and the landing lists XRP Ledger. What is missing is
  // only the native exit. Re-enabling it is D-195: port `validateWithdrawal` from
  // `intents-sdk` (destination tag + `depositAuth` + account reserve, all three from one
  // XRPL `getAccountInfo`), which also needs `memoSupported` split from `memoRequired`
  // across 31 `ChainMeta` entries and an XRPL RPC the repo does not have yet.
  {
    id: "nep141:xrp.omft.near",
    symbol: "XRP",
    name: "XRP (on XRP Ledger)",
    contractId: "xrp.omft.near",
    decimals: 6,
    category: "Core",
    fallbackUsdPrice: 1.35,
    depositable: false,
  },
  {
    id: "nep141:doge.omft.near",
    symbol: "DOGE",
    name: "Dogecoin (on Dogecoin)",
    contractId: "doge.omft.near",
    decimals: 8,
    category: "Core",
    fallbackUsdPrice: 0.102633,
    depositable: true,
    assetName: "DOGE",
  },
  {
    id: "nep141:cardano.omft.near",
    symbol: "ADA",
    name: "Cardano (on Cardano)",
    contractId: "cardano.omft.near",
    decimals: 6,
    category: "Core",
    fallbackUsdPrice: 0.247881,
    depositable: true,
  },
  {
    id: "nep141:ltc.omft.near",
    symbol: "LTC",
    name: "Litecoin (on Litecoin)",
    contractId: "ltc.omft.near",
    decimals: 8,
    category: "Core",
    fallbackUsdPrice: 53.84,
    depositable: true,
  },
  {
    id: "nep141:tron.omft.near",
    symbol: "TRX",
    name: "Tron (on Tron)",
    contractId: "tron.omft.near",
    decimals: 6,
    category: "Core",
    fallbackUsdPrice: 0.355635,
    depositable: true,
  },
  {
    id: "nep141:sui.omft.near",
    symbol: "SUI",
    name: "Sui (on Sui)",
    contractId: "sui.omft.near",
    decimals: 9,
    category: "Core",
    fallbackUsdPrice: 1.032,
    depositable: true,
  },
  {
    id: "nep141:aptos.omft.near",
    symbol: "APT",
    name: "Aptos (on Aptos)",
    contractId: "aptos.omft.near",
    decimals: 8,
    category: "Core",
    fallbackUsdPrice: 0.930426,
    depositable: true,
  },
  {
    id: "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
    symbol: "BNB",
    name: "BNB (on BNB Chain)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 18,
    category: "Core",
    fallbackUsdPrice: 638.28,
    depositable: true,
    assetName: "BNB",
  },
  {
    id: "nep245:v2_1.omni.hot.tg:43114_11111111111111111111",
    symbol: "AVAX",
    name: "Avalanche (on Avalanche)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 18,
    category: "Core",
    fallbackUsdPrice: 9.09,
    depositable: true,
  },
  {
    id: "nep245:v2_1.omni.hot.tg:137_11111111111111111111",
    symbol: "POL",
    name: "Polygon (on Polygon)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 18,
    category: "Core",
    fallbackUsdPrice: 0.089313,
    depositable: true,
  },
  {
    id: "nep245:v2_1.omni.hot.tg:1117_",
    // D-247: Toncoin rebranded to GRAM, and calling it "TON" stopped the operator TWICE in
    // five minutes during the 4.5 wet test — once choosing what to send, once hunting for
    // "GRAM" in the receive list. The wallet says GRAM and the chain is still called TON, so
    // the ticker carries BOTH names, the way near.com does. `symbol.split("(")[0].trim()`
    // (the same rule that turns "USDT(ETH)" into "USDT") leaves the chip reading "GRAM".
    symbol: "GRAM (ex-TON)",
    name: "GRAM, ex-TON (on TON)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 9,
    category: "Core",
    fallbackUsdPrice: 1.98,
    depositable: true,
  },
  // No `assetName`: XLM has a single representation, so it groups by symbol like TON above.
  // 7 decimals is Stellar's native precision (stroops), not a copy of a neighbour.
  {
    id: "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz",
    symbol: "XLM",
    name: "Stellar Lumens (on Stellar)",
    contractId: "v2_1.omni.hot.tg",
    decimals: 7,
    category: "Core",
    fallbackUsdPrice: 0.159733,
    depositable: true,
  },

  // ---- Liquid Staking -------------------------------------------------------
  {
    id: "nep141:meta-pool.near",
    symbol: "stNEAR",
    name: "Staked NEAR (Meta Pool)",
    contractId: "meta-pool.near",
    decimals: 24,
    category: "Liquid Staking",
    fallbackUsdPrice: 2.34,
    depositable: true,
  },
  {
    id: "nep141:linear-protocol.near",
    symbol: "LINEAR",
    name: "LiNEAR",
    contractId: "linear-protocol.near",
    decimals: 24,
    category: "Liquid Staking",
    fallbackUsdPrice: 2.2,
    depositable: false,
  },

  // ---- DeFi -----------------------------------------------------------------
  {
    id: "nep141:mpdao-token.near",
    symbol: "mpDAO",
    name: "Meta Pool DAO",
    contractId: "mpdao-token.near",
    decimals: 6,
    category: "DeFi",
    fallbackUsdPrice: 0.00541499,
    depositable: true,
  },
  {
    id: "nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near",
    symbol: "AAVE",
    name: "Aave (on Ethereum)",
    contractId: "eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near",
    decimals: 18,
    category: "DeFi",
    fallbackUsdPrice: 86.84,
    depositable: true,
  },
  {
    id: "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near",
    symbol: "UNI",
    name: "Uniswap (on Ethereum)",
    contractId: "eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near",
    decimals: 18,
    category: "DeFi",
    fallbackUsdPrice: 3.44,
    depositable: true,
  },
  {
    id: "nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near",
    symbol: "LINK",
    name: "Chainlink (on Ethereum)",
    contractId: "eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near",
    decimals: 18,
    category: "DeFi",
    fallbackUsdPrice: 9.45,
    depositable: true,
  },
  {
    id: "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near",
    symbol: "ARB",
    name: "Arbitrum (on Arbitrum)",
    contractId: "arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near",
    decimals: 18,
    category: "DeFi",
    fallbackUsdPrice: 0.113186,
    depositable: true,
  },

  // ---- DeFi (NEAR-native, NOT in 1Click — wallet-visible only) --------------
  {
    id: "nep141:token.v2.ref-finance.near",
    symbol: "REF",
    name: "Ref Finance",
    contractId: "token.v2.ref-finance.near",
    decimals: 18,
    category: "DeFi",
    fallbackUsdPrice: 0.04597759,
    depositable: false,
  },
  {
    id: "nep141:meta-token.near",
    symbol: "$META",
    name: "Meta Token",
    contractId: "meta-token.near",
    decimals: 24,
    category: "DeFi",
    fallbackUsdPrice: 0.00450045,
    depositable: false,
  },
  {
    id: "nep141:far-token.fewandfar-protocol.near",
    symbol: "FAR",
    name: "Far",
    contractId: "far-token.fewandfar-protocol.near",
    decimals: 18,
    category: "DeFi",
    fallbackUsdPrice: 0.01003153,
    depositable: false,
  },

  // ---- Privacy --------------------------------------------------------------
  {
    id: "nep141:zec.omft.near",
    symbol: "ZEC",
    name: "Zcash (on Zcash)",
    contractId: "zec.omft.near",
    decimals: 8,
    category: "Privacy",
    fallbackUsdPrice: 546.75,
    depositable: true,
    assetName: "ZEC",
  },

  // ---- Web3 / Ecosystem -----------------------------------------------------
  {
    id: "nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near",
    symbol: "AURORA",
    name: "Aurora",
    contractId: "aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near",
    decimals: 18,
    category: "Web3",
    fallbackUsdPrice: 0.02784485,
    depositable: true,
  },
  {
    id: "nep141:token.sweat",
    symbol: "SWEAT",
    name: "SWEAT Economy (on NEAR)",
    contractId: "token.sweat",
    decimals: 18,
    category: "Web3",
    fallbackUsdPrice: 0.00175015,
    depositable: true,
    assetName: "SWEAT",
  },
  {
    id: "nep141:arb-0xca7dec8550f43a5e46e3dfb95801f64280e75b27.omft.near",
    symbol: "SWEAT(ARB)",
    name: "SWEAT Economy (on Arbitrum)",
    contractId: "arb-0xca7dec8550f43a5e46e3dfb95801f64280e75b27.omft.near",
    decimals: 18,
    category: "Web3",
    fallbackUsdPrice: 0.00037714,
    depositable: true,
    assetName: "SWEAT",
  },
  {
    id: "nep141:token.publicailab.near",
    symbol: "PUBLIC",
    name: "Public AI",
    contractId: "token.publicailab.near",
    decimals: 18,
    category: "Web3",
    fallbackUsdPrice: 0.01545004,
    depositable: true,
  },
  {
    id: "nep141:token.rhealab.near",
    symbol: "RHEA",
    name: "Rhea",
    contractId: "token.rhealab.near",
    decimals: 18,
    category: "Web3",
    fallbackUsdPrice: 0.01071121,
    depositable: true,
  },
  {
    id: "nep141:npro.nearmobile.near",
    symbol: "NPRO",
    name: "NEAR Mobile Pro",
    contractId: "npro.nearmobile.near",
    decimals: 24,
    category: "Web3",
    fallbackUsdPrice: 0.208939,
    depositable: true,
  },

  // ---- Web3 (NEAR-native, NOT in 1Click — wallet-visible only) --------------
  {
    id: "nep141:walc.near",
    symbol: "WALC",
    name: "WALC",
    contractId: "walc.near",
    decimals: 24,
    category: "Web3",
    fallbackUsdPrice: 0.00519835,
    depositable: false,
  },
];

export function getTokenById(id: string): TokenDefinition | null {
  return tokenRegistry.find((token) => token.id === id) ?? null;
}

// Derives the canonical Defuse asset id for a PoA bridge `near_token_id`. NEP-245 (HOT
// Omni) ids embed the token id after a colon (`<contract>:<token_id>`); NEP-141 ids are
// bare contract accounts. `contractId` alone can't disambiguate NEP-245 tokens — every
// HOT Omni entry shares the same `v2_1.omni.hot.tg` contract (D-235).
export function assetIdForNearTokenId(nearTokenId: string): string {
  return nearTokenId.includes(":") ? `nep245:${nearTokenId}` : `nep141:${nearTokenId}`;
}

// Resolves a bridge `near_token_id` to its registry entry, or null if unknown. The bridge names
// NEAR `wrap.near`, which the registry keys `near` (D-421).
export function getTokenByNearTokenId(nearTokenId: string): TokenDefinition | null {
  return getTokenById(toRegistryTokenId(assetIdForNearTokenId(nearTokenId)));
}

// Display ticker for a token id (Defuse asset id). Resolves through the registry; for a token
// the registry doesn't know (off-registry deposits, hand-seeded data) it falls back to
// something short, so the UI never surfaces the raw asset id.
//
// The fallback used to be `replace(/^nep141:/, "")`, which is fine for NEP-141 — the id is a
// readable account (`usdc.near`) — but leaves a NEP-245 id whole: `contract:token_id`, where
// the token segment is ~60 chars. That churro was what overflowed the history table and read
// as garbage in the feed (D-235). It also covers ids already persisted in the wrong shape.
export function symbolForTokenId(tokenId: string): string {
  const token = getTokenById(tokenId);
  if (token) return token.symbol;

  const bare = tokenId.replace(/^nep(?:141|245):/, "");
  const sep = bare.indexOf(":");
  if (sep === -1) return bare;

  const inner = bare.slice(sep + 1);
  return `${bare.slice(0, sep)}:${inner.slice(0, 4)}…${inner.slice(-4)}`;
}

export const depositableTokens: TokenDefinition[] = tokenRegistry.filter(
  (t) => t.depositable
);
