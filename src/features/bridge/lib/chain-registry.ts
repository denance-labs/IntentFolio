// Attribution: see ATTRIBUTIONS.md #2 (derived data — monthly upstream re-review).
// 31 chains derived from the live PoA bridge catalog (bridge.chaindefuser.com/rpc,
// supported_tokens as of 2026-06-01). Source of truth is the live catalog, not
// PoaBridgeNetworkReference (which is missing Plasma eth:9745 and ADI eth:36900).
// Aurora (eth:1313161554) is intentionally excluded — present in docs but 0 tokens in live API.

export type ChainMeta = {
  displayName: string;
  memoRequired: boolean;
  explorerTxUrl: (txHash: string) => string;
};

export const chainRegistry: Record<string, ChainMeta> = {
  // ── EVM (14) ──────────────────────────────────────────────────────────────
  "eth:1": {
    displayName: "Ethereum",
    memoRequired: false,
    explorerTxUrl: (h) => `https://etherscan.io/tx/${h}`,
  },
  "eth:8453": {
    displayName: "Base",
    memoRequired: false,
    explorerTxUrl: (h) => `https://basescan.org/tx/${h}`,
  },
  "eth:56": {
    displayName: "BNB Chain",
    memoRequired: false,
    explorerTxUrl: (h) => `https://bscscan.com/tx/${h}`,
  },
  "eth:100": {
    displayName: "Gnosis",
    memoRequired: false,
    explorerTxUrl: (h) => `https://gnosisscan.io/tx/${h}`,
  },
  "eth:42161": {
    displayName: "Arbitrum",
    memoRequired: false,
    explorerTxUrl: (h) => `https://arbiscan.io/tx/${h}`,
  },
  "eth:10": {
    displayName: "Optimism",
    memoRequired: false,
    explorerTxUrl: (h) => `https://optimistic.etherscan.io/tx/${h}`,
  },
  "eth:137": {
    displayName: "Polygon",
    memoRequired: false,
    explorerTxUrl: (h) => `https://polygonscan.com/tx/${h}`,
  },
  "eth:43114": {
    displayName: "Avalanche",
    memoRequired: false,
    explorerTxUrl: (h) => `https://snowscan.xyz/tx/${h}`,
  },
  "eth:143": {
    displayName: "Monad",
    memoRequired: false,
    explorerTxUrl: (h) => `https://explorer.monad.xyz/tx/${h}`,
  },
  "eth:196": {
    displayName: "XLayer",
    memoRequired: false,
    explorerTxUrl: (h) => `https://explorer.xlayer.tech/tx/${h}`,
  },
  "eth:534352": {
    displayName: "Scroll",
    memoRequired: false,
    explorerTxUrl: (h) => `https://scrollscan.com/tx/${h}`,
  },
  "eth:80094": {
    displayName: "Berachain",
    memoRequired: false,
    explorerTxUrl: (h) => `https://berascan.com/tx/${h}`,
  },
  // Plasma and ADI are absent from PoaBridgeNetworkReference but present in live API
  "eth:9745": {
    displayName: "Plasma",
    memoRequired: false,
    explorerTxUrl: (h) => `https://explorer.plasma.group/tx/${h}`,
  },
  "eth:36900": {
    displayName: "ADI",
    memoRequired: false,
    explorerTxUrl: (h) => `https://explorer.adichain.com/tx/${h}`,
  },
  // ── Non-EVM (17) ──────────────────────────────────────────────────────────
  "near:mainnet": {
    displayName: "NEAR",
    memoRequired: false,
    explorerTxUrl: (h) => `https://nearblocks.io/txns/${h}`,
  },
  "sol:mainnet": {
    displayName: "Solana",
    memoRequired: false,
    explorerTxUrl: (h) => `https://solscan.io/tx/${h}`,
  },
  "ton:mainnet": {
    displayName: "TON",
    memoRequired: false,
    explorerTxUrl: (h) => `https://tonscan.org/tx/${h}`,
  },
  "tron:mainnet": {
    displayName: "Tron",
    memoRequired: false,
    explorerTxUrl: (h) => `https://tronscan.org/#/transaction/${h}`,
  },
  "stellar:mainnet": {
    displayName: "Stellar",
    memoRequired: true, // Stellar deposits require a memo field (deposit_mode: "MEMO")
    explorerTxUrl: (h) => `https://stellar.expert/explorer/public/tx/${h}`,
  },
  "aleo:mainnet": {
    displayName: "Aleo",
    memoRequired: false,
    explorerTxUrl: (h) => `https://explorer.aleo.org/transaction/${h}`,
  },
  "aptos:mainnet": {
    displayName: "Aptos",
    memoRequired: false,
    explorerTxUrl: (h) => `https://aptoscan.com/transaction/${h}`,
  },
  "sui:mainnet": {
    displayName: "Sui",
    memoRequired: false,
    explorerTxUrl: (h) => `https://suiscan.xyz/mainnet/tx/${h}`,
  },
  "starknet:mainnet": {
    displayName: "Starknet",
    memoRequired: false,
    explorerTxUrl: (h) => `https://starkscan.co/tx/${h}`,
  },
  "cardano:mainnet": {
    displayName: "Cardano",
    memoRequired: false,
    explorerTxUrl: (h) => `https://cardanoscan.io/transaction/${h}`,
  },
  "xrp:mainnet": {
    displayName: "XRP Ledger",
    memoRequired: false,
    explorerTxUrl: (h) => `https://xrpscan.com/tx/${h}`,
  },
  "btc:mainnet": {
    displayName: "Bitcoin",
    memoRequired: false,
    explorerTxUrl: (h) => `https://mempool.space/tx/${h}`,
  },
  "bch:mainnet": {
    displayName: "Bitcoin Cash",
    memoRequired: false,
    explorerTxUrl: (h) => `https://blockchair.com/bitcoin-cash/transaction/${h}`,
  },
  "ltc:mainnet": {
    displayName: "Litecoin",
    memoRequired: false,
    explorerTxUrl: (h) => `https://blockchair.com/litecoin/transaction/${h}`,
  },
  "doge:mainnet": {
    displayName: "Dogecoin",
    memoRequired: false,
    explorerTxUrl: (h) => `https://blockchair.com/dogecoin/transaction/${h}`,
  },
  "dash:mainnet": {
    displayName: "Dash",
    memoRequired: false,
    explorerTxUrl: (h) => `https://blockchair.com/dash/transaction/${h}`,
  },
  "zec:mainnet": {
    displayName: "Zcash",
    memoRequired: false,
    explorerTxUrl: (h) => `https://zcashblockexplorer.com/transactions/${h}`,
  },
};

export function getChainMeta(chainId: string): ChainMeta | undefined {
  return chainRegistry[chainId];
}
