import { NextResponse } from "next/server";
import { getSupportedTokens } from "@/features/bridge/lib/bridge-client";
import { chainRegistry } from "@/features/bridge/lib/chain-registry";
import { getFamilyValidationMap } from "@/features/bridge/lib/family-validation";
import { tokenRegistry } from "@/features/market/lib/token-registry";

// The bridge labels assets on its own terms and those labels drift from ours: it calls
// Arbitrum USDT "USDT0" and Wrapped Bitcoin "wBTC". Keying the catalog by the bridge label
// hides the chain from the Receive modal, which groups tokens by OUR assetName. Resolve each
// bridge token through intents_token_id — the id both sides share — and fall back to the
// bridge label for tokens the registry does not carry.
const registryAssetName = new Map(tokenRegistry.map((t) => [t.id, t.assetName ?? t.symbol]));

// Cache the per-chain token catalog server-side. Changes rarely; same for all users.
export const revalidate = 300;

/**
 * Minimums PoA states but does not enforce, by intents token id. ZEC (D-580): PoA lists 0.01, but
 * the deposit is credited by the Omni Bridge's Zcash connector, whose own minimum is 0.001
 * (`zcash-connector.bridge.near` `get_config`: `min_deposit_amount` 100000, read 2026-11-13), and
 * a 0.002 ZEC deposit was credited in full on chain (`2ijfsQ53…`, `verify_deposit_details`).
 */
const MIN_DEPOSIT_OVERRIDE_RAW: Record<string, string> = {
  "nep141:zec.omft.near": "100000",
};

// The bridge returns min_deposit_amount in base units (e.g. ETH min "100000000000"
// with decimals 18 == 1e-7 ETH). Convert to a human-readable decimal string so the
// Receive modal shows "0.0000001 ETH" instead of a raw hundred-billion integer.
function formatBaseUnits(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw) || decimals <= 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

export async function GET() {
  const chainIds = Object.keys(chainRegistry);

  const results = await Promise.allSettled(
    chainIds.map(async (chainId) => {
      const tokens = await getSupportedTokens([chainId]);
      return { chainId, tokens };
    })
  );

  // One chain is one option in the picker, but the bridge can list several tokens for the same
  // asset on the same chain (two BTC on btc:mainnet), so collect chains in a Set.
  const assetChains: Record<string, Set<string>> = {};
  // minDeposit[assetName][chainId] = min_deposit_amount in human-readable units
  const minDeposit: Record<string, Record<string, string>> = {};

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { chainId, tokens } = result.value;
    for (const token of tokens) {
      const { asset_name, min_deposit_amount, decimals } = token;
      const known = registryAssetName.get(token.intents_token_id);
      const key = known ?? asset_name;

      if (!assetChains[key]) assetChains[key] = new Set();
      assetChains[key].add(chainId);

      if (!minDeposit[key]) minDeposit[key] = {};
      // On a shared asset+chain slot, show the registry token's minimum, not whichever came last.
      if (known || minDeposit[key][chainId] === undefined) {
        const minRaw = MIN_DEPOSIT_OVERRIDE_RAW[token.intents_token_id] ?? min_deposit_amount;
        minDeposit[key][chainId] = formatBaseUnits(minRaw, decimals);
      }
    }
  }

  // ⚠️ `assetToChains` is NO LONGER the source of the Receive chain picker. Under
  // Curated Token (ADR-0016, D-175) step 2 derives its chains from our own registry
  // (bridge/lib/deposit-registry.ts), because this catalog lists (asset, chain) pairs
  // whose token id the app cannot read — the deposit landed and the screen showed zero
  // (D-178). Do not wire the picker back to this field. It is kept as the live view of
  // the upstream catalog, which is what the curation-drift alert will diff (D-177 #7).
  const assetToChains: Record<string, string[]> = {};
  for (const [asset, chains] of Object.entries(assetChains)) {
    assetToChains[asset] = [...chains];
  }

  return NextResponse.json({
    assetToChains,
    minDeposit,
    familyValidation: getFamilyValidationMap(),
    updatedAt: new Date().toISOString(),
  });
}
