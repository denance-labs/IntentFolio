import { NextResponse } from "next/server";
import { chainRegistry } from "@/features/bridge/lib/chain-registry";
import { withdrawalRegistry } from "@/features/bridge/lib/withdrawal-registry";
import { getFamilyValidationMap } from "@/features/bridge/lib/family-validation";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import { MIN_DEPOSIT_RAW } from "@/features/bridge/lib/deposit-minimums";

// Receive groups tokens by OUR assetName, so the minimums are keyed by it.
const registryAssetName = new Map(tokenRegistry.map((t) => [t.id, t.assetName ?? t.symbol]));

// Static now, but the family-validation flags come from the environment: keep the short cache.
export const revalidate = 300;

// Minimums are in base units (e.g. ETH "100000000000" with decimals 18 == 1e-7 ETH). Convert to a human-readable decimal string so the
// Receive modal shows "0.0000001 ETH" instead of a raw hundred-billion integer.
function formatBaseUnits(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw) || decimals <= 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

export async function GET() {
  // minDeposit[assetName][chainId] = the minimum in human-readable units, for the pairs Receive offers.
  const minDeposit: Record<string, Record<string, string>> = {};
  for (const token of tokenRegistry) {
    const raw = MIN_DEPOSIT_RAW[token.id];
    const chainId = withdrawalRegistry[token.id]?.chainId;
    if (raw === undefined || !chainId || !chainRegistry[chainId]) continue;
    const key = registryAssetName.get(token.id) ?? token.symbol;
    (minDeposit[key] ??= {})[chainId] = formatBaseUnits(raw, token.decimals);
  }

  return NextResponse.json({
    // PoA's live catalog closed with its Bridge API (D-584); kept empty for the response's shape.
    assetToChains: {},
    minDeposit,
    familyValidation: getFamilyValidationMap(),
    updatedAt: new Date().toISOString(),
  });
}
