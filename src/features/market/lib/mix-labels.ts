import { getTokenById } from "./token-registry";

/**
 * Labels for the tokens of one mix (a preset's donut and legend), keyed by token id.
 *
 * Each token is named by its clean ticker (`assetName`: "USDC", not "USDC(NEAR)") — unless that
 * ticker appears more than once in the same mix, where it alone would read as two identical
 * slices (D-429: Stablecoins had three "USDC" and two "USDT"). Those fall back to the registry
 * symbol, which carries the network ("USDC(BASE)") and is what the app shows for the same row.
 */
export function mixLabels(tokenIds: readonly string[]): Map<string, string> {
  const ticker = (id: string) => {
    const token = getTokenById(id);
    return token?.assetName ?? token?.symbol ?? id;
  };
  const counts = new Map<string, number>();
  for (const id of tokenIds) counts.set(ticker(id), (counts.get(ticker(id)) ?? 0) + 1);
  return new Map(
    tokenIds.map((id) => {
      const name = ticker(id);
      return [id, (counts.get(name) ?? 0) > 1 ? (getTokenById(id)?.symbol ?? name) : name];
    })
  );
}
