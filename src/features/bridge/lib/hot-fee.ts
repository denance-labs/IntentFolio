// The live fee a `hot-omni` withdrawal has to carry (008.plan §Fase 4, block 4.3.1).
//
// Attribution: see ATTRIBUTIONS.md #11 (mirrors @defuse-protocol/intents-sdk 0.78.0
// `estimateWithdrawalFee` / `estimate-fee.ts` and @hot-labs/omni-sdk 2.25.5
// `getGaslessWithdrawFee` — re-review on version bump).
//
// WHY THIS IS NOT `withdrawal-fee.ts` WITH ANOTHER BRANCH
// On `omft` the fee is NOT signed: the envelope carries the gross amount and the bridge
// deducts on the far side, so a stale quote changes what LANDS, never whether the signature
// is valid. On HOT it is the opposite — `blockNumber` and the fee-paying `token_diff` go
// INSIDE the signed intent (4.3.2). A stale quote therefore does not mis-state a number,
// it invalidates the envelope. Two different things that happen to both be called "the fee",
// and collapsing them into one branch of one function is how the difference gets lost.
//
// Consequence for every caller: there is NO registry fallback here. `withdrawalRegistry`'s
// snapshot cannot stand in, because it carries no `blockNumber` and no solver quote — a
// withdrawal built on it would be refused by the contract, not merely mispriced. This module
// returns `null` when it cannot produce a signable quote, and `null` must block the
// withdrawal rather than degrade to the static figure.
//
// THE FEE IS DEDUCTED, LIKE EVERY OTHER ROUTE (decided session 103, built in 4.3.2)
// `intents-sdk`'s wrapper ADDS it (`amount + relayerFee`, delivering the full `amount`), but
// the primitive both wrappers call is neutral and HOT's own wrapper subtracts. We subtract:
// `feeRaw` below is taken OUT of what the user typed, so the debit is exactly the typed
// amount and delivery is `qty - fee`, as on `omft`. See the header of `hot-envelope.ts` for
// why, and do not re-derive it from `hot-bridge.js:96`.

import { createPublicClient, fallback, http } from "viem";
import { solverRelay, config } from "@defuse-protocol/internal-utils";
import { getWithdrawalEntry } from "./withdrawal-registry";
import { getTokenById } from "@/features/market/lib/token-registry";

/**
 * Native asset per destination chain, mirrored from `nativeTokenMapping`
 * (intents-sdk `hot-bridge-utils.ts`). This is a TABLE and not a derivation on purpose:
 * the EVM chains all encode the zero address as `11111111111111111111`, TON encodes native
 * as the EMPTY key, and Stellar (which block 4.4 curates) is a third form entirely
 * (`1100_111bzQBB5v…`). A rule read off the EVM entries would produce a plausible,
 * non-existent asset id for the other two.
 *
 * Only the chains `withdrawalRegistry` actually carries are listed; the remaining HOT chains
 * are absent from our catalog, and inventing entries for them would be untested code on the
 * money path. `hotFeeSupported` reports the gap instead of guessing.
 */
const HOT_NATIVE_ASSET_ID: Record<string, string> = {
  "eth:56": "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
  "eth:137": "nep245:v2_1.omni.hot.tg:137_11111111111111111111",
  "eth:43114": "nep245:v2_1.omni.hot.tg:43114_11111111111111111111",
  "eth:10": "nep245:v2_1.omni.hot.tg:10_11111111111111111111",
  "ton:mainnet": "nep245:v2_1.omni.hot.tg:1117_",
  "stellar:mainnet":
    "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz",
};

/**
 * Where the destination chain's gas price is read. The fee is the gas the HOT relayer will
 * spend delivering on that chain, so it can only come from that chain — there is no HOT API
 * to ask (the one measurable surprise of block 4.3's planning).
 *
 * Public endpoints, env-overridable. They are named individually rather than built from the
 * chain id because Next.js only inlines `process.env.NEXT_PUBLIC_*` when the reference is a
 * literal; a computed key would silently read `undefined` in the browser.
 *
 * An ordered list per chain, tried in turn (D-207, D-383): a single endpoint is a single point
 * of failure ON THE MONEY PATH. Block 4.3.6's wet test found `https://polygon-rpc.com` — the
 * previous default here — answering `401 "API key disabled, tenant disabled"`, which took every
 * Polygon `hot-omni` withdrawal out of service: no gas price, no signable quote, and (correctly)
 * no registry fallback, so the modal blocks. Then (s200) a tester's DNS (Telefónica/Movistar)
 * answered `127.9.9.9 walledgardenloopback.telefonica` for `polygon-bor-rpc.publicnode.com`.
 * It fails CLOSED either way — nothing is ever lost, but nothing can be withdrawn — so a
 * second endpoint is the difference.
 *
 * The Polygon backup was chosen by measurement (s201, from inside that DNS): of ~15 public
 * Polygon endpoints only `api.zan.top` both resolved there and answered `eth_gasPrice` without
 * a key; that DNS also blocks drpc, 1rpc, llamarpc and tenderly. It answers CORS for our
 * origin. The other chains have one endpoint each: none of them failed either measurement.
 * An env key, when set, goes FIRST and keeps the defaults behind it.
 */
function rpcList(envUrl: string | undefined, ...defaults: string[]): readonly string[] {
  // `||`-style emptiness: an env key present-but-empty must fall back, not become the URL
  // (same reasoning as RPC_ENDPOINTS in wallet/config/network.ts).
  return envUrl ? [envUrl, ...defaults.filter((u) => u !== envUrl)] : defaults;
}

const EVM_RPC_URLS: Record<string, readonly string[]> = {
  "eth:56": rpcList(process.env.NEXT_PUBLIC_EVM_RPC_BSC, "https://bsc-dataseed.bnbchain.org"),
  "eth:137": rpcList(
    process.env.NEXT_PUBLIC_EVM_RPC_POLYGON,
    "https://polygon-bor-rpc.publicnode.com",
    "https://api.zan.top/polygon-mainnet"
  ),
  "eth:43114": rpcList(process.env.NEXT_PUBLIC_EVM_RPC_AVALANCHE, "https://api.avax.network/ext/bc/C/rpc"),
  "eth:10": rpcList(process.env.NEXT_PUBLIC_EVM_RPC_OPTIMISM, "https://mainnet.optimism.io"),
};

// `BigInt(…)` and not `…n` throughout: tsconfig targets ES2017, where the literal form is a
// compile error. Every base-unit figure in this repo is written this way.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);

/** `defaultEvmWithdrawGasLimit` (omni-sdk `bridge.ts:53`). Never overridden by intents-sdk. */
const EVM_WITHDRAW_GAS_LIMIT = BigInt(200_000);

/** The relayer's headroom over the observed gas price, as the integer ratio upstream uses. */
const GAS_PRICE_MULTIPLIER_NUM = BigInt(130);
const GAS_PRICE_MULTIPLIER_DEN = BigInt(100);

/** TON is a flat constant upstream — no RPC, and `blockNumber` is genuinely `0`. */
const TON_RELAYER_FEE_RAW = BigInt(40_000_000);

/**
 * Stellar is two constants, and which one applies is a property of the DESTINATION, not of
 * the chain: delivering to an account that does not exist yet has to fund its base reserve.
 * (omni-sdk `bridge.ts` `getGaslessWithdrawFee`: `11000000n` when absent, `1000000n` when
 * present — 1.1 and 0.1 XLM at 7 decimals.)
 *
 * 🔴 WHICH WAY THIS FAILS IS THE WHOLE POINT. The two errors are not symmetric:
 *   - saying "exists" about an account that does not → 0.1 XLM cannot create it, and the
 *     bridge keeps a withdrawal that never lands. This is the session-111 Tron failure.
 *   - saying "does not exist" about one that does → the user overpays ~1 XLM (~$0.16) and
 *     the withdrawal succeeds.
 * So every uncertain answer — Horizon down, timeout, malformed body, address not typed yet —
 * resolves to NEW_ACCOUNT. That is the expensive answer, never the cheap one, and it is what
 * upstream does too (its `isAccountExists` catches into `false`).
 */
const STELLAR_FEE_NEW_ACCOUNT_RAW = BigInt(11_000_000);
const STELLAR_FEE_EXISTING_RAW = BigInt(1_000_000);
const STELLAR_HORIZON_URL =
  process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ?? "https://horizon.stellar.org";

/**
 * `withTimeout` budget from intents-sdk `estimateWithdrawalFee`, including its split: the
 * browser gets 10s because a user is watching a spinner, the server 3s because nothing is.
 */
const GAS_LOOKUP_TIMEOUT_MS = typeof window !== "undefined" ? 10_000 : 3_000;

/** Scale factors from `getFeeQuote`'s exact-in fallback, kept as the integers upstream uses. */
const USD_SCALE = 1e6;
const RATIO_SCALE = BigInt(1000);
/** Discard a fallback quote that buys more than 1.5x the gas actually needed. */
const MAX_FALLBACK_RATIO = BigInt(1500);
/** The 1.2x cushion upstream applies when sizing the exact-in leg, as `12/10`. */
const USD_CUSHION_NUM = BigInt(12);
const USD_CUSHION_DEN = BigInt(10);

/** A base-unit integer as the relay states it. Anything else is not arithmetic we can trust. */
function isBaseUnitString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

/**
 * The solver swap that buys the relayer's gas, when the withdrawn token is not that gas.
 *
 * It becomes the `token_diff` intent (4.3.2) AND the published `quote_hashes` (4.3.3), both
 * read off this one object so they cannot name different quotes. `quote_hashes` stays empty
 * on every route that has no swap here — `omft`, `near-native`, and the HOT tokens that are
 * their own chain's gas — which is D-147's rule, now applied per route instead of globally.
 */
export type HotFeeSwap = {
  quoteHash: string;
  /** Defuse asset id sold — the token being withdrawn. */
  assetIn: string;
  /** Defuse asset id bought — the destination chain's native. */
  assetOut: string;
  /** Base units of `assetIn` debited on top of the withdrawal. */
  amountIn: string;
  /** Base units of `assetOut` bought; at least `relayerFeeRaw`. */
  amountOut: string;
  /** The relay's own expiry for this quote, ISO-8601, verbatim. */
  expiresAt: string;
};

/**
 * WHERE THE RELAYER'S GAS COMES FROM. Read by `hotTokenFeeRaw` and by the screen, and it is
 * a field rather than something inferred from `swap === null` because the inference is wrong
 * in exactly one case and wrong by a factor of a thousand.
 *
 *   - `in-kind`       — the withdrawn token IS the chain's gas, or the relayer charges
 *                       nothing. `relayerFeeRaw` is already in the withdrawn token's units.
 *   - `swap`          — a solver sells part of the withdrawn token to buy the gas.
 *   - `native-balance`— the signer already holds the gas; `mt_withdraw` debits it directly and
 *                       NOTHING is sold. The fee in the withdrawn token is zero, and
 *                       `relayerFeeRaw` is denominated in a DIFFERENT token.
 *
 * Before this field existed, `swap === null` meant `in-kind` and `hotTokenFeeRaw` returned
 * `relayerFeeRaw` for it. A `native-balance` quote reaching that branch would have reported
 * TON's 40000000 base units (0.04 GRAM) as 40 USDT — a fee eight times the withdrawal, on the
 * screen and in the floor check. Hence a required discriminator: every construction site has
 * to state which of the three it is, and the compiler finds the ones that do not.
 */
export type HotFeePayment = "in-kind" | "swap" | "native-balance";

/** Everything the signed intent needs that the registry snapshot cannot supply. */
export type HotFeeDetail = {
  /** Gas the relayer charges, in the DESTINATION CHAIN's native base units — not the token's. */
  relayerFeeRaw: string;
  /** Destination-chain block the estimate is pinned to. Signed, so the quote expires by itself. */
  blockNumber: string;
  /** The chain's native asset id, so callers need not re-derive the table above. */
  nativeAssetId: string;
  /** How the gas is paid for. `swap` iff `payment === "swap"` — see `hotTokenFeeRaw`. */
  payment: HotFeePayment;
  /** `null` unless a solver swap was actually quoted. */
  swap: HotFeeSwap | null;
};

export type HotWithdrawalFee = {
  /**
   * The fee in the WITHDRAWN token's base units — `amount_in` of the swap, or the relayer fee
   * itself when the token is the chain's native. Mirrors what upstream reports as the fee
   * (`estimateWithdrawalFee`'s `amount`); we take it OUT of the typed amount rather than
   * adding it on top. `hotTokenFeeRaw` (hot-envelope.ts) recomputes exactly this from the
   * `HotFeeDetail` alone, and a test pins the two together.
   *
   * `"0"` on the `native-balance` path, and that zero is load-bearing rather than a missing
   * number: nothing is taken from the withdrawn token there. What the user pays is
   * `relayerFeeRaw` of ANOTHER token, which is why the screen cannot render this figure
   * alone without checking `hot.payment` first.
   */
  feeRaw: string;
  hot: HotFeeDetail;
};

/** A USD price as the exact-in fallback needs it: the figure and the scale it applies to. */
export type HotUsdPrice = { price: number; decimals: number };

/**
 * Price source for the fallback path only. Injected rather than imported because the assets
 * it must price include chain natives our own registry does not carry (Optimism's native has
 * no IntentFolio entry — only USDC and USDT on Optimism do). A lookup that returns `null`
 * skips the fallback, which is the safe direction: no quote at all, never a wrong one.
 */
export type HotUsdPriceLookup = (assetId: string) => HotUsdPrice | null;

/** Injected so the whole path is unit-testable with no network. */
export type HotFeeDeps = {
  /** Destination-chain gas. Defaults to a viem client against `EVM_RPC_URLS`. */
  evmGas?: (chainId: string, signal?: AbortSignal) => Promise<EvmGas>;
  /**
   * Whether a Stellar destination account already exists. Defaults to a Horizon lookup.
   * Injected like `evmGas` so the fee's two branches are testable without the network —
   * which matters more here, because the branch is worth 1 XLM.
   */
  stellarAccountExists?: (address: string, signal?: AbortSignal) => Promise<boolean>;
  /** Defaults to the solver relay. */
  quote?: typeof solverRelay.getQuote;
  /** Omitted => the exact-in fallback is skipped entirely. */
  usdPrices?: HotUsdPriceLookup;
};

export type EvmGas = { gasPriceWei: bigint; blockNumber: bigint };

/**
 * Whether a live HOT fee can be quoted at all. False for a chain missing from the tables
 * above — which today means Stellar and Solana, and is why `null` from `fetchHotWithdrawalFee`
 * is not automatically a network problem.
 *
 * Note this is NOT `supportsLiveWithdrawalFee` (withdrawal-fee.ts): that one gates the SCREEN.
 * With the subtract convention the screen's `qty - fee` is already the right arithmetic for
 * HOT, so flipping it is now only about freshness — block 4.3.5, where it stops being
 * optional (Avalanche and Optimism carry `withdrawalFeeRaw: "0"` against a live fee > 0).
 */
export function hotFeeSupported(tokenId: string): boolean {
  const entry = getWithdrawalEntry(tokenId);
  if (!entry || entry.bridgeRoute !== "hot-omni") return false;
  if (!(entry.chainId in HOT_NATIVE_ASSET_ID)) return false;
  return (
    entry.chainId === "ton:mainnet" ||
    entry.chainId === "stellar:mainnet" ||
    entry.chainId in EVM_RPC_URLS
  );
}

/** The chain's native asset id, or `null` for a chain this module does not cover. */
export function hotNativeAssetId(chainId: string): string | null {
  return HOT_NATIVE_ASSET_ID[chainId] ?? null;
}

/**
 * Base units of the destination chain's gas token the signer already holds, or `undefined`
 * when there is nothing to report (a chain with no curated native, no balance, an unknown
 * token). Feeds `nativeBalanceRaw` — see this module's header for why it is advisory and what
 * happens when it is wrong.
 *
 * ⚠️ `generalBalance` is in HUMAN units and is a double (D-206): for an 18-decimal native it
 * can land a few base units either side of the truth. `Math.floor` after scaling makes the
 * error point DOWNWARDS, so the worst case is declining a balance that would just barely have
 * covered the fee — a blocked screen — rather than signing an `mt_withdraw` the balance cannot
 * cover. The contract is the real boundary either way.
 *
 * 🔴 It lives HERE, and is exported, because the 1x purchase margin on the constant-fee chains
 * depends on this exact rounding (`gasPurchaseTargetRaw`). It used to be private to
 * `withdrawal-modal.tsx`, and a test that hand-copied its arithmetic instead of calling it
 * passed cleanly against a mutation that subtracted a base unit here — the very failure the
 * test existed to catch. A test may only pin this by calling it.
 */
export function nativeGasBalanceRaw(
  chainId: string,
  generalBalance: Map<string, number>
): string | undefined {
  const nativeAssetId = hotNativeAssetId(chainId);
  if (!nativeAssetId) return undefined;
  const held = generalBalance.get(nativeAssetId);
  if (held === undefined || !Number.isFinite(held) || held <= 0) return undefined;
  const decimals = getTokenById(nativeAssetId)?.decimals;
  if (decimals === undefined) return undefined;
  return BigInt(Math.floor(held * Math.pow(10, decimals))).toString();
}

/**
 * Horizon's account lookup. A 404 is the real "does not exist" and everything else is
 * "unknown" — but both return `false`, because the caller spends the difference in the safe
 * direction (see `STELLAR_FEE_NEW_ACCOUNT_RAW`). They are distinguished here anyway so the
 * next reader can see the choice was made rather than overlooked.
 *
 * Mirrors omni-sdk `StellarBridge.isAccountExists`, including its `balances.length > 0` test:
 * Horizon can answer 200 for an account that has been merged away.
 */
async function defaultStellarAccountExists(
  address: string,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const res = await fetch(`${STELLAR_HORIZON_URL}/accounts/${address}`, { signal });
    if (res.status === 404) return false; // definitively absent
    if (!res.ok) return false; // unknown → charge as if absent
    const body: unknown = await res.json();
    const balances = (body as { balances?: unknown })?.balances;
    return Array.isArray(balances) && balances.length > 0;
  } catch {
    return false; // network error, abort, malformed JSON → charge as if absent
  }
}

export async function defaultEvmGas(chainId: string, signal?: AbortSignal): Promise<EvmGas> {
  const urls = EVM_RPC_URLS[chainId];
  if (!urls?.length) throw new Error(`No EVM RPC configured for ${chainId}`);
  // No retries per endpoint: a blocked DNS or a dead key fails the same way on every try, and
  // the whole lookup has `GAS_LOOKUP_TIMEOUT_MS`. The fallback moves to the next one instead.
  // Each endpoint gets its share of the lookup budget: viem's own 10 s default would let a
  // first endpoint that hangs (rather than refuses) eat the whole budget before the next one.
  const perEndpointMs = Math.floor(GAS_LOOKUP_TIMEOUT_MS / urls.length);
  const transports = urls.map((url) =>
    http(url, { retryCount: 0, timeout: perEndpointMs, fetchOptions: signal ? { signal } : undefined })
  );
  const client = createPublicClient({
    transport: transports.length === 1 ? transports[0] : fallback(transports, { retryCount: 0 }),
  });
  // Upstream reads these sequentially; in parallel they cost one round trip instead of two,
  // and the pair is already inherently racy — the block can advance between any two calls.
  const [gasPriceWei, blockNumber] = await Promise.all([
    client.getGasPrice(),
    client.getBlockNumber(),
  ]);
  return { gasPriceWei, blockNumber };
}

/** Rejects with the given reason if `promise` has not settled in time. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`HOT fee lookup timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * The relayer's gas cost on the destination chain.
 *
 * ⚠️ The arithmetic mirrors omni-sdk `getGaslessWithdrawFee` INCLUDING its order: the 1.3x
 * headroom is applied to the gas price and truncated FIRST, and only then multiplied by the
 * gas limit. `gasPrice * gasLimit * 130n / 100n` is a different number, and this one is
 * signed.
 */
async function relayerFee(
  chainId: string,
  deps: HotFeeDeps,
  destinationAddress: string | undefined,
  signal?: AbortSignal
): Promise<{ feeRaw: bigint; blockNumber: bigint } | null> {
  if (chainId === "ton:mainnet") {
    return { feeRaw: TON_RELAYER_FEE_RAW, blockNumber: ZERO };
  }
  if (chainId === "stellar:mainnet") {
    // No address yet (the screen quotes while the user is still typing) means the cheap
    // branch cannot be justified, so it is not taken. `withTimeout` rather than an unbounded
    // await: a hanging Horizon must become the expensive answer, not a spinner.
    const exists = destinationAddress
      ? await withTimeout(
          (deps.stellarAccountExists ?? defaultStellarAccountExists)(destinationAddress, signal),
          GAS_LOOKUP_TIMEOUT_MS
        ).catch(() => false)
      : false;
    return {
      feeRaw: exists ? STELLAR_FEE_EXISTING_RAW : STELLAR_FEE_NEW_ACCOUNT_RAW,
      blockNumber: ZERO,
    };
  }
  if (!(chainId in EVM_RPC_URLS)) return null;
  try {
    const gas = await withTimeout(
      (deps.evmGas ?? defaultEvmGas)(chainId, signal),
      GAS_LOOKUP_TIMEOUT_MS
    );
    const withHeadroom =
      (gas.gasPriceWei * GAS_PRICE_MULTIPLIER_NUM) / GAS_PRICE_MULTIPLIER_DEN;
    return { feeRaw: withHeadroom * EVM_WITHDRAW_GAS_LIMIT, blockNumber: gas.blockNumber };
  } catch {
    // Includes the caller aborting. There is no snapshot to fall back to (see the header),
    // so an unavailable gas price is an unavailable withdrawal, not a cheaper one.
    return null;
  }
}

/** Reads a relay quote defensively — its numbers end up inside a signed intent. */
function toSwap(quote: unknown, assetIn: string, assetOut: string): HotFeeSwap | null {
  if (typeof quote !== "object" || quote === null) return null;
  const q = quote as Record<string, unknown>;
  if (typeof q.quote_hash !== "string" || q.quote_hash === "") return null;
  if (!isBaseUnitString(q.amount_in) || !isBaseUnitString(q.amount_out)) return null;
  // The relay echoes back which assets it priced. If it answered about a different pair than
  // we asked for, the swap would settle correctly and pay the wrong chain's gas.
  if (q.defuse_asset_identifier_in !== assetIn) return null;
  if (q.defuse_asset_identifier_out !== assetOut) return null;
  return {
    quoteHash: q.quote_hash,
    assetIn,
    assetOut,
    amountIn: q.amount_in,
    amountOut: q.amount_out,
    expiresAt: typeof q.expiration_time === "string" ? q.expiration_time : "",
  };
}

/**
 * `getFeeQuote` (intents-sdk `estimate-fee.ts`), mirrored.
 *
 * Preferred shape is EXACT-OUT: buy precisely the gas the relayer needs, so the user pays
 * whatever that costs. Only if the relay cannot fill that does it try exact-in, sized from
 * USD prices with a 1.2x cushion — and then it CHECKS the answer, because a price-derived
 * input is a guess: too little gas and the delivery stalls, wildly too much and the user
 * silently overpaid. Both rejections return `null` here where upstream rethrows; the caller
 * treats them identically, as "no signable quote".
 */
async function fetchFeeSwap(p: {
  tokenId: string;
  nativeAssetId: string;
  feeAmount: bigint;
  deps: HotFeeDeps;
  signal?: AbortSignal;
}): Promise<HotFeeSwap | null> {
  const getQuote = p.deps.quote ?? solverRelay.getQuote;
  const requestConfig = {
    baseURL: config.env.solverRelayBaseURL,
    logBalanceSufficient: false,
    ...(p.signal ? { fetchOptions: { signal: p.signal } } : {}),
  };

  try {
    const exactOut = await getQuote({
      quoteParams: {
        defuse_asset_identifier_in: p.tokenId,
        defuse_asset_identifier_out: p.nativeAssetId,
        exact_amount_out: p.feeAmount.toString(),
      },
      config: requestConfig,
    });
    return toSwap(exactOut, p.tokenId, p.nativeAssetId);
  } catch {
    // Upstream distinguishes QuoteError (no solver filled it — retry differently) from any
    // other throw (rethrow). Here both end at the same place, so the fallback simply runs and
    // a genuinely broken relay fails it too, one call later.
  }

  const prices = p.deps.usdPrices;
  if (!prices) return null;
  const feePrice = prices(p.nativeAssetId);
  const tokenPrice = prices(p.tokenId);
  if (!feePrice || !tokenPrice) return null;

  const feePriceScaled = BigInt(Math.round(feePrice.price * USD_SCALE));
  const tokenPriceScaled = BigInt(Math.round(tokenPrice.price * USD_SCALE));
  // Upstream divides by this unguarded. A token the price source reports as 0 (or rounds to
  // 0) would throw a RangeError mid-quote instead of declining to quote.
  if (tokenPriceScaled === ZERO) return null;

  const num =
    p.feeAmount * feePriceScaled * USD_CUSHION_NUM * TEN ** BigInt(tokenPrice.decimals);
  const den = tokenPriceScaled * TEN ** BigInt(feePrice.decimals) * USD_CUSHION_DEN;
  let exactAmountIn = num / den;
  if (num % den !== ZERO) exactAmountIn += ONE; // round UP: rounding down under-buys gas
  if (exactAmountIn === ZERO) exactAmountIn = ONE;

  let swap: HotFeeSwap | null;
  try {
    const exactIn = await getQuote({
      quoteParams: {
        defuse_asset_identifier_in: p.tokenId,
        defuse_asset_identifier_out: p.nativeAssetId,
        exact_amount_in: exactAmountIn.toString(),
      },
      config: requestConfig,
    });
    swap = toSwap(exactIn, p.tokenId, p.nativeAssetId);
  } catch {
    return null;
  }
  if (!swap) return null;

  const amountOut = BigInt(swap.amountOut);
  if ((amountOut * RATIO_SCALE) / p.feeAmount > MAX_FALLBACK_RATIO) return null;
  if (amountOut < p.feeAmount) return null;
  return swap;
}

/**
 * What the relayer has to be handed, independent of who pays for it or how.
 *
 * IT EXISTS BECAUSE `null` FROM A FEE LOOKUP CONFLATES TWO ANSWERS: "the gas cost cannot be
 * established" (the EVM RPC is down) and "the gas cost is known, but there is no way to pay
 * for it from the withdrawn token" (D-251: no solver quotes any `hot.tg` native). Both block
 * the withdrawal, but only the second can be UNBLOCKED — by buying the gas — and doing that
 * needs the figure the `null` says nothing about.
 *
 * ⚠️ THE SCREEN NO LONGER ASKS FOR THIS SEPARATELY, and that is deliberate rather than an
 * oversight to tidy up. It used to, and the second call was a SECOND, INDEPENDENT resolution
 * of a question that on Stellar is answered by Horizon per destination account: the two could
 * disagree by 11x and did, leaving the screen blocked over gas it had just bought (D-274).
 * `fetchHotFeeAndRequirement` now answers both questions from one pass and hands this out
 * alongside the fee. Reintroducing a caller here that runs in the same cycle as a fee lookup
 * reopens that bug — the type will not stop you, so this comment has to.
 *
 * It is deliberately NOT signable on its own: there is no `payment` and no swap here, and
 * nothing in `hot-envelope.ts` accepts it. It answers one question — how much gas, of which
 * asset — and a caller that wants to sign has to go through `fetchHotFeeAndRequirement`.
 */
export type HotGasRequirement = {
  /** Base units of the destination chain's native asset the relayer charges. */
  relayerFeeRaw: string;
  /** Destination-chain block the estimate is pinned to, `"0"` on the flat-fee chains. */
  blockNumber: string;
  /** The chain's native asset id — what has to be bought or held. */
  nativeAssetId: string;
};

export type FetchHotGasRequirementParams = {
  /** Full defuse asset id — the `withdrawalRegistry` key. */
  tokenId: string;
  /** Stellar only, and only to pick between its two constants — see `relayerFee`. */
  destinationAddress?: string;
  signal?: AbortSignal;
  deps?: HotFeeDeps;
};

/**
 * The relayer's gas cost for this token's route, or `null` when even that cannot be had.
 *
 * On TON it costs no network call at all — the fee is a constant — which is what makes it
 * cheap to ask for from a screen that is already blocked. On the EVM chains it is one
 * gas-price lookup. On Stellar it is a Horizon lookup whenever a destination address is
 * supplied, because the fee there is a property of the DESTINATION and not of the chain (see
 * `relayerFee`); with no address it is the expensive constant and costs nothing.
 *
 * `null` means the requirement itself is unknown — a state buying gas cannot fix, so the
 * caller must not offer to.
 */
export async function fetchHotGasRequirement(
  p: FetchHotGasRequirementParams
): Promise<HotGasRequirement | null> {
  const entry = getWithdrawalEntry(p.tokenId);
  if (!entry || entry.bridgeRoute !== "hot-omni") return null;

  const nativeAssetId = HOT_NATIVE_ASSET_ID[entry.chainId];
  if (!nativeAssetId) return null;

  const fee = await relayerFee(entry.chainId, p.deps ?? {}, p.destinationAddress, p.signal);
  if (!fee) return null;

  return {
    relayerFeeRaw: fee.feeRaw.toString(),
    blockNumber: fee.blockNumber.toString(),
    nativeAssetId,
  };
}

export type FetchHotWithdrawalFeeParams = {
  /** Full defuse asset id — the `withdrawalRegistry` key. */
  tokenId: string;
  /**
   * Only Stellar reads this, and only to pick between its two fee constants. Optional
   * because every other chain's fee is a property of the chain alone — but leaving it out
   * on Stellar is not an error, it is the expensive answer (see `relayerFee`).
   */
  destinationAddress?: string;
  /**
   * Base units of the destination chain's NATIVE asset the signer already holds in
   * `intents.near`. Supplied by the caller — this module never reads a balance, so it stays
   * network-free apart from the gas price and the quote.
   *
   * Omitted, or short of `relayerFeeRaw`, simply means the `native-balance` path is not
   * offered and the swap is attempted instead. It is ADVISORY, not a safety boundary: the
   * real check is the contract's, which rejects an `mt_withdraw` the balance cannot cover.
   * That is why a stale or slightly-optimistic figure here costs a rejected intent (nothing
   * moves) and never a wrong amount.
   */
  nativeBalanceRaw?: string;
  signal?: AbortSignal;
  deps?: HotFeeDeps;
};

/**
 * Both halves of one answer, produced from a SINGLE resolution of the gas requirement.
 *
 * `fee: null` with a non-null `requirement` is the blocked screen: the gas cost is known, and
 * there is no way to pay for it out of the withdrawn token (D-251 — no solver quotes a
 * `hot.tg` native). That combination is the reason this type exists. The requirement SURVIVES
 * the null, because the caller that has to offer a way out of the block — buying the gas —
 * needs the very figure the null used to discard, and asking for it again was a SECOND,
 * INDEPENDENT lookup that could answer differently.
 *
 * 🔴 D-274, and it is a money-path failure rather than a tidiness one. On Stellar the
 * requirement is a property of the DESTINATION ACCOUNT, resolved against Horizon, and every
 * uncertain answer resolves to the expensive constant by design (`relayerFee`). Two
 * independent lookups against an unstable Horizon therefore disagree by 11x: the purchase gets
 * sized against "account exists" (0.1 XLM) while the sufficiency check uses "account does not"
 * (1.1 XLM), so the screen stays blocked over gas it just bought and offers to buy again. Each
 * round is a 1Click quote, a wallet prompt and a transfer to a third party. Answering both
 * questions from one resolution closes it by construction — no cache, no margin, no retry
 * budget, none of which can make two independent lookups agree.
 *
 * `requirement: null` is the OTHER failure and must not be collapsed into the first: the cost
 * itself is unknown (the destination chain is unreachable), which is not a state a purchase
 * can fix, so nothing may be offered.
 */
export type HotFeeOutcome = {
  /** The relayer's gas cost. Present even when `fee` is `null` — see above. */
  requirement: HotGasRequirement | null;
  /** The signable quote, or `null` when there is no way to pay for that gas. */
  fee: HotWithdrawalFee | null;
};

/**
 * The live fee AND the requirement it was computed against, from one pass.
 *
 * This is the entry point every production caller uses. `fetchHotWithdrawalFee` below is the
 * same computation with the requirement dropped on the floor.
 */
export async function fetchHotFeeAndRequirement(
  p: FetchHotWithdrawalFeeParams
): Promise<HotFeeOutcome> {
  // The requirement is the first half of this answer, so it is asked for rather than
  // re-derived: two copies of the native table and the gas arithmetic would eventually
  // disagree, and the one that ends up inside the signed intent is this one.
  //
  // Asked ONCE, and every `return` below carries this same object out (D-274). A second call
  // here — for the swap, for the caller, for anything — reopens the disagreement this function
  // exists to prevent, and on Stellar it costs a real Horizon round trip that can answer
  // differently from the first.
  const requirement = await fetchHotGasRequirement(p);
  if (!requirement) return { requirement: null, fee: null };

  const deps = p.deps ?? {};
  const { nativeAssetId } = requirement;
  const feeRaw = BigInt(requirement.relayerFeeRaw);
  const base = { ...requirement, swap: null };

  // Two cases need no swap, and upstream spells out both: the withdrawn token already IS the
  // gas being paid, or the relayer is charging nothing on this chain. Quoting a 0-out swap
  // would be asking the relay to price nothing.
  if (p.tokenId === nativeAssetId || feeRaw === ZERO) {
    const detail: HotFeeDetail = { ...base, payment: "in-kind" };
    return { requirement, fee: { feeRaw: detail.relayerFeeRaw, hot: detail } };
  }

  // Already holding the gas beats buying it, so this is tried BEFORE the relay: selling part
  // of the withdrawal to buy something the signer already has would cost them a spread and a
  // solver's margin for nothing. It also skips a network call on the path that needs none.
  if (p.nativeBalanceRaw !== undefined && isBaseUnitString(p.nativeBalanceRaw)) {
    if (BigInt(p.nativeBalanceRaw) >= feeRaw) {
      // `feeRaw` is "0" and not `relayerFeeRaw`: the caller's contract is that `feeRaw` is
      // denominated in the WITHDRAWN token, and on this path nothing is taken from it. The
      // gas leaves the balance as a second `mt_withdraw` entry instead (hot-envelope.ts).
      return { requirement, fee: { feeRaw: "0", hot: { ...base, payment: "native-balance" } } };
    }
  }

  const swap = await fetchFeeSwap({
    tokenId: p.tokenId,
    nativeAssetId,
    feeAmount: feeRaw,
    deps,
    signal: p.signal,
  });
  // The blocked screen. `requirement` rides out with it — this is the exact return D-274 is
  // about, and the one a caller offering a gas purchase reads.
  if (!swap) return { requirement, fee: null };

  return {
    requirement,
    fee: { feeRaw: swap.amountIn, hot: { ...base, payment: "swap", swap } },
  };
}

/**
 * The live, signable fee for a `hot-omni` withdrawal, or `null` when there is not one.
 *
 * `null` is a real answer and not a degraded one: unlike `fetchWithdrawalFee`, this cannot
 * return the registry snapshot, because the snapshot carries neither the `blockNumber` the
 * intent must contain nor the solver quote that pays for the gas. A caller that treats `null`
 * as "fee unknown, proceed anyway" builds an envelope the contract rejects.
 *
 * ⚠️ NO PRODUCTION PATH COMES THROUGH HERE. `withdrawal-fee.ts` calls
 * `fetchHotFeeAndRequirement`, because a screen that has to offer a way out of a blocked
 * withdrawal needs the requirement this signature throws away (D-274). This stays as the
 * narrow view for tests that only assert the quote; a new caller should ask itself whether it
 * will ever have to explain the `null`, and take the other one if so.
 */
export async function fetchHotWithdrawalFee(
  p: FetchHotWithdrawalFeeParams
): Promise<HotWithdrawalFee | null> {
  return (await fetchHotFeeAndRequirement(p)).fee;
}
