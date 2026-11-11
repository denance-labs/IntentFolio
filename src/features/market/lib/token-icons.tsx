import type { ComponentType } from "react";
import Image from "next/image";
import {
  TokenBTC,
  TokenETH,
  TokenSOL,
  TokenNEAR,
  TokenUSDC,
  TokenUSDT,
  TokenAVAX,
  TokenBNB,
  TokenADA,
  TokenDOGE,
  TokenXRP,
  TokenXLM,
  TokenLTC,
  TokenUNI,
  TokenLINK,
  TokenDAI,
  TokenAAVE,
  TokenTON,
  TokenTRX,
  TokenAPT,
  TokenARB,
  TokenAURORA,
  TokenPOL,
  TokenREF,
  TokenSUI,
  TokenSWEAT,
  TokenUSN,
  TokenZEC,
  WalletMetamask,
  WalletPhantom,
  WalletWalletConnect,
  NetworkEthereum,
  NetworkBase,
  NetworkBinanceSmartChain,
  NetworkGnosis,
  NetworkArbitrumOne,
  NetworkOptimism,
  NetworkPolygon,
  NetworkAvalanche,
  NetworkMonad,
  NetworkXLayer,
  NetworkScroll,
  NetworkBerachain,
  NetworkPlasma,
  NetworkNearProtocol,
  NetworkSolana,
  NetworkTon,
  NetworkTron,
  NetworkStellar,
  NetworkAptos,
  NetworkSui,
  NetworkStarknet,
  NetworkCardano,
  NetworkXrp,
  NetworkBitcoin,
  NetworkLitecoin,
} from "@web3icons/react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Web3IconComponent = ComponentType<{
  variant?: "branded" | "mono" | "background";
  size?: number;
  className?: string;
}>;

type IconProps = {
  size?: number;
  className?: string;
  variant?: "branded" | "mono" | "background";
};

// Marks whose branded variant is a single pure-black fill disappear on the app's dark ground (D-571
// part 6). They draw with the mono variant (fill: currentColor) in the ink color instead. Keys are
// chain ids and resolved token symbols; other variants are left alone.
const BLACK_BRAND_MARKS = new Set([
  "stellar:mainnet",
  "aptos:mainnet",
  "eth:196", // X Layer
  "eth:9745", // Plasma
  "XLM",
]);

function inkMarkClass(className?: string): string {
  return className ? `text-slate-100 ${className}` : "text-slate-100";
}

// ---------------------------------------------------------------------------
// Token symbol → web3icons component
// Chain-specific stables fall back to their base asset icon.
// ---------------------------------------------------------------------------

const TOKEN_ICON_MAP: Record<string, Web3IconComponent> = {
  BTC: TokenBTC,
  WBTC: TokenBTC,
  nBTC: TokenBTC,
  ETH: TokenETH,
  "ETH.e": TokenETH,
  SOL: TokenSOL,
  NEAR: TokenNEAR,
  USDC: TokenUSDC,
  "USDC.e": TokenUSDC,
  "USDC(NEAR)": TokenUSDC,
  "USDC(ETH)": TokenUSDC,
  "USDC(ARB)": TokenUSDC,
  "USDC(BASE)": TokenUSDC,
  "USDC(SOL)": TokenUSDC,
  "USDC(SUI)": TokenUSDC,
  "USDC(APT)": TokenUSDC,
  "USDC(POL)": TokenUSDC,
  "USDC(BSC)": TokenUSDC,
  "USDC(AVAX)": TokenUSDC,
  "USDC(OP)": TokenUSDC,
  "USDC(STELLAR)": TokenUSDC,
  "ETH(ARB)": TokenETH,
  "SWEAT(ARB)": TokenSWEAT,
  USDT: TokenUSDT,
  "USDT.e": TokenUSDT,
  "USDT(NEAR)": TokenUSDT,
  "USDT(ETH)": TokenUSDT,
  "USDT(ARB)": TokenUSDT,
  "USDT(TRON)": TokenUSDT,
  "USDT(SOL)": TokenUSDT,
  "USDT(APT)": TokenUSDT,
  "USDT(POL)": TokenUSDT,
  "USDT(BSC)": TokenUSDT,
  "USDT(AVAX)": TokenUSDT,
  "USDT(OP)": TokenUSDT,
  "USDT(TON)": TokenUSDT,
  AVAX: TokenAVAX,
  BNB: TokenBNB,
  ADA: TokenADA,
  DOGE: TokenDOGE,
  XRP: TokenXRP,
  XLM: TokenXLM,
  LTC: TokenLTC,
  UNI: TokenUNI,
  LINK: TokenLINK,
  DAI: TokenDAI,
  AAVE: TokenAAVE,
  TON: TokenTON,
  // Toncoin rebranded to GRAM (D-247). Both keys point at the same mark: the chain is still
  // TON, only the coin was renamed, and a returning user should not see the icon vanish.
  GRAM: TokenTON,
  TRX: TokenTRX,
  APT: TokenAPT,
  ARB: TokenARB,
  AURORA: TokenAURORA,
  POL: TokenPOL,
  REF: TokenREF,
  SUI: TokenSUI,
  SWEAT: TokenSWEAT,
  USN: TokenUSN,
  ZEC: TokenZEC,
};

// ---------------------------------------------------------------------------
// NEAR-native tokens: SVGs fetched from on-chain ft_metadata and stored locally.
// ---------------------------------------------------------------------------

const LOCAL_SVG_ICON_MAP: Record<string, string> = {
  stNEAR: "/token-icons/stNEAR.svg",
  mpDAO: "/token-icons/mpDAO.svg",
  LINEAR: "/token-icons/LINEAR.svg",
  META: "/token-icons/META.svg",
  // Logos taken from each contract's on-chain ft_metadata (2026-10-18).
  RHEA: "/token-icons/RHEA.png",
  NPRO: "/token-icons/NPRO.svg",
  PUBLIC: "/token-icons/PUBLIC.svg",
  FAR: "/token-icons/FAR.png",
  WALC: "/token-icons/WALC.svg",
  // Same on-chain logo as META (the Meta Pool token): the two catalog entries differ in contract only.
  $META: "/token-icons/META.svg",
  // The Ondo stocks (plan 039, D-576). Attribution: see ATTRIBUTIONS.md #24.
  AAPL: "/token-icons/AAPL.png",
  AMZN: "/token-icons/AMZN.png",
  NVDA: "/token-icons/NVDA.png",
  QQQ: "/token-icons/QQQ.png",
  TSLA: "/token-icons/TSLA.png",
  GOOGL: "/token-icons/GOOGL.png",
  MSFT: "/token-icons/MSFT.png",
  // Not "META": that key is Meta Pool's logo (D-576).
  METAon: "/token-icons/METAon.png",
};

// Catalog tickers can carry a suffix ("GRAM (ex-TON)", D-247) while the icon maps are keyed by the
// bare symbol. A key that is mapped as written ("USDC(NEAR)") wins; otherwise fall back to the
// part before the "(". Doing it here keeps every screen working however it writes the symbol.
function resolveIconSymbol(symbol: string): string {
  if (symbol in TOKEN_ICON_MAP || symbol in LOCAL_SVG_ICON_MAP) return symbol;
  return symbol.split("(")[0].trim();
}

// ---------------------------------------------------------------------------
// TokenIcon — renders a web3icon or local SVG for a given symbol, or null if unknown
// ---------------------------------------------------------------------------

export function TokenIcon({
  symbol,
  size = 24,
  className,
  variant = "branded",
}: IconProps & { symbol: string }) {
  const key = resolveIconSymbol(symbol);
  const Icon = TOKEN_ICON_MAP[key];
  if (Icon && variant === "branded" && BLACK_BRAND_MARKS.has(key)) {
    return <Icon variant="mono" size={size} className={inkMarkClass(className)} />;
  }
  if (Icon) return <Icon variant={variant} size={size} className={className} />;
  const localSrc = LOCAL_SVG_ICON_MAP[key];
  if (localSrc) {
    return (
      <Image
        src={localSrc}
        alt={key}
        width={size}
        height={size}
        className={className}
        unoptimized
      />
    );
  }
  return null;
}

// True when a real branded icon exists for this symbol — lets callers decide
// whether to render an initials fallback alongside TokenIcon.
export function hasTokenIcon(symbol: string): boolean {
  const key = resolveIconSymbol(symbol);
  return key in TOKEN_ICON_MAP || key in LOCAL_SVG_ICON_MAP;
}

// ---------------------------------------------------------------------------
// Chain icon map — chainId → Network* web3icon or local SVG
// ---------------------------------------------------------------------------

const CHAIN_ICON_MAP: Record<string, Web3IconComponent> = {
  "eth:1":          NetworkEthereum,
  "eth:8453":       NetworkBase,
  "eth:56":         NetworkBinanceSmartChain,
  "eth:100":        NetworkGnosis,
  "eth:42161":      NetworkArbitrumOne,
  "eth:10":         NetworkOptimism,
  "eth:137":        NetworkPolygon,
  "eth:43114":      NetworkAvalanche,
  "eth:143":        NetworkMonad,
  "eth:196":        NetworkXLayer,
  "eth:534352":     NetworkScroll,
  "eth:80094":      NetworkBerachain,
  "eth:9745":       NetworkPlasma,
  "near:mainnet":   NetworkNearProtocol,
  "sol:mainnet":    NetworkSolana,
  "ton:mainnet":    NetworkTon,
  "tron:mainnet":   NetworkTron,
  "stellar:mainnet": NetworkStellar,
  "aptos:mainnet":  NetworkAptos,
  "sui:mainnet":    NetworkSui,
  "starknet:mainnet": NetworkStarknet,
  "cardano:mainnet": NetworkCardano,
  "xrp:mainnet":    NetworkXrp,
  "btc:mainnet":    NetworkBitcoin,
  "ltc:mainnet":    NetworkLitecoin,
};

const LOCAL_CHAIN_SVG_MAP: Record<string, string> = {
  "bch:mainnet":  "/chain-icons/BCH.svg",
  "doge:mainnet": "/chain-icons/DOGE.svg",
  "dash:mainnet": "/chain-icons/DASH.svg",
  "zec:mainnet":  "/chain-icons/ZEC.svg",
};

export function ChainIcon({
  chainId,
  size = 24,
  className,
  variant = "branded",
}: {
  chainId: string;
  size?: number;
  className?: string;
  variant?: "branded" | "mono" | "background";
}) {
  const Icon = CHAIN_ICON_MAP[chainId];
  if (Icon && variant === "branded" && BLACK_BRAND_MARKS.has(chainId)) {
    return <Icon variant="mono" size={size} className={inkMarkClass(className)} />;
  }
  if (Icon) return <Icon variant={variant} size={size} className={className} />;
  const localSrc = LOCAL_CHAIN_SVG_MAP[chainId];
  if (localSrc) {
    return (
      <Image
        src={localSrc}
        alt={chainId}
        width={size}
        height={size}
        className={className}
        unoptimized
      />
    );
  }
  return null;
}

export function hasChainIcon(chainId: string): boolean {
  return chainId in CHAIN_ICON_MAP || chainId in LOCAL_CHAIN_SVG_MAP;
}

// ---------------------------------------------------------------------------
// Wallet icon map — MetaMask/Phantom via web3icons; Meteor via local PNG
// ---------------------------------------------------------------------------

type WalletIconId =
  | "metamask"
  | "phantom"
  | "walletconnect"
  | "meteor"
  | "tonkeeper"
  | "varial"
  | "tronlink";

const WALLET_WEB3_MAP: Partial<Record<WalletIconId, Web3IconComponent>> = {
  metamask: WalletMetamask as Web3IconComponent,
  phantom: WalletPhantom as Web3IconComponent,
  walletconnect: WalletWalletConnect as Web3IconComponent,
};

// Wallets without a web3icons component — official brand marks stored locally.
// Attribution: see ATTRIBUTIONS.md #7.
const LOCAL_WALLET_PNG_MAP: Partial<Record<WalletIconId, { src: string; alt: string }>> = {
  meteor: { src: "/meteor-icon.png", alt: "Meteor Wallet" },
  tonkeeper: { src: "/wallet-icons/tonkeeper.png", alt: "Tonkeeper" },
  varial: { src: "/wallet-icons/varial.png", alt: "Varial" },
  tronlink: { src: "/wallet-icons/tronlink.png", alt: "TronLink" },
};

export function WalletIcon({
  walletId,
  size = 24,
  className,
}: {
  walletId: string;
  size?: number;
  className?: string;
}) {
  const id = walletId.toLowerCase() as WalletIconId;

  const local = LOCAL_WALLET_PNG_MAP[id];
  if (local) {
    return (
      <Image
        src={local.src}
        alt={local.alt}
        width={size}
        height={size}
        className={className}
        unoptimized
      />
    );
  }

  const Icon = WALLET_WEB3_MAP[id];
  if (!Icon) return null;
  return <Icon variant="branded" size={size} className={className} />;
}
