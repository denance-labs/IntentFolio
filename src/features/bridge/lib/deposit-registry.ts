// Curated Token (ADR-0016, D-175): the token registry is the source of truth for
// deposits. The Receive picker offers an (asset, chain) pair only when we curate a
// token for it — which means the pair round-trips end to end: its balance is read
// (use-intents-balances), it can be allocated to a portfolio, and it has a
// withdrawal route.
//
// Why this module exists. Step 2 of Receive used to come from the live PoA bridge
// catalog while step 1 came from the registry, so the two halves disagreed: the
// picker offered chains whose token id the app did not know (D-178 measured 18 such
// pairs, e.g. ETH on Base). The failure mode was not an error — the deposit landed
// and the screen showed zero, because `use-intents-balances` never asks for a token
// id outside the registry. Deposit and withdrawal are now symmetric: both derive
// their chains from the same curated data.
//
// The live catalog is still needed, for minimum deposit amounts and chain-family
// validation (ADR-0015). It just no longer decides what the picker offers.
//
// NEAR USED TO BE A SPECIAL CASE HERE and no longer is (D-176, 2026-08-20). It carried an
// `isNear` flag, no chain at all, and the modal showed the user their OWN NEAR account as
// the deposit address — a "direct transfer" that credits nothing, because intents.near only
// ever sees funds that arrive through a deposit address. It now derives its chain from
// `withdrawalRegistry` like every other asset (`near:mainnet`, via the `near-unwrap` row),
// so the rule this file is built on — offered here only if it round-trips — finally holds
// for NEAR too instead of being suspended for it.

import { isStockToken } from "@/features/market/lib/stock-tokens";
import { depositableTokens } from "@/features/market/lib/token-registry";
import { chainRegistry } from "./chain-registry";
import { withdrawalRegistry } from "./withdrawal-registry";
import { isReceivable } from "./token-availability";

export type DepositGroup = {
  /** Grouping key shown in the picker — `assetName`, or `symbol` for one-off tokens. */
  assetName: string;
  ticker: string;
  /**
   * Curated deposit chains for this asset, in registry order, deduplicated.
   *
   * Includes the chains deferred to the next MVP. They stay in the list on purpose: the
   * picker renders them disabled and labelled "Not available yet" rather than dropping them, so
   * a missing network reads as not-yet instead of as a bug (008.plan §Alcance).
   */
  chainIds: string[];
  /**
   * Subset of `chainIds` the user can actually pick today. A group whose set is empty is
   * entirely deferred and is disabled in step 1.
   */
  availableChainIds: string[];
};

function buildDepositGroups(): DepositGroup[] {
  const seen = new Map<string, DepositGroup>();
  const order: string[] = [];

  for (const token of depositableTokens) {
    // A stock is a target, never a deposit: without this it would be a group with no chain (plan 039).
    if (isStockToken(token.id)) continue;
    const key = token.assetName ?? token.symbol;
    if (!seen.has(key)) {
      order.push(key);
      seen.set(key, {
        assetName: key,
        ticker: token.symbol.split("(")[0].trim(),
        chainIds: [],
        availableChainIds: [],
      });
    }
    const group = seen.get(key)!;

    // A curated token with no withdrawal route, or one on a chain we have no metadata
    // for, is not offered: we could take the deposit but not give it back.
    const chainId = withdrawalRegistry[token.id]?.chainId;
    if (!chainId || !chainRegistry[chainId]) continue;
    if (!group.chainIds.includes(chainId)) group.chainIds.push(chainId);
    // Availability is per (asset, chain) pair, so it is decided here and not per chain:
    // USDC on Polygon is deferred while ETH on Arbitrum is live and ARB there is not (D-396).
    if (isReceivable(token.id) && !group.availableChainIds.includes(chainId)) {
      group.availableChainIds.push(chainId);
    }
  }

  return order.map((k) => seen.get(k)!);
}

/** Computed once at module load; both registries are static. */
export const depositGroups: DepositGroup[] = buildDepositGroups();

/** The picker group a curated token belongs to (the key `buildDepositGroups` uses), or null. */
export function depositGroupKeyFor(tokenId: string): string | null {
  const token = depositableTokens.find((t) => t.id === tokenId);
  return token ? (token.assetName ?? token.symbol) : null;
}

/**
 * Step 1's order. Selectable groups come before fully deferred ones, each block in curated
 * order. `preferred` (group keys) moves those groups ahead of the rest in its own order —
 * the assets of the New Portfolio Draft the deposit is for (016 block 2.3) — with deferred
 * ones still last within it. The last used asset leads whichever of the two parts it is in,
 * so it never jumps above the draft's assets and it never loses its place among the rest.
 */
export function orderDepositGroups(
  groups: DepositGroup[],
  { lastUsed, preferred = [] }: { lastUsed: string | null; preferred?: string[] }
): DepositGroup[] {
  const selectable = (g: DepositGroup) => g.availableChainIds.length > 0;
  const ordered = [...groups.filter(selectable), ...groups.filter((g) => !selectable(g))];

  const rank = new Map<string, number>();
  preferred.forEach((key, i) => {
    if (!rank.has(key)) rank.set(key, i);
  });
  const first = ordered
    .filter((g) => rank.has(g.assetName))
    .sort(
      (a, b) =>
        Number(!selectable(a)) - Number(!selectable(b)) || rank.get(a.assetName)! - rank.get(b.assetName)!
    );
  const rest = ordered.filter((g) => !rank.has(g.assetName));

  // Only a selectable one: an asset the catalog dropped since (DAI, D-396) would otherwise
  // open the list as a row the user cannot pick.
  const lead = lastUsed && groups.some((g) => g.assetName === lastUsed && selectable(g)) ? lastUsed : null;
  const lastUsedFirst = (list: DepositGroup[]) =>
    lead
      ? [...list.filter((g) => g.assetName === lead), ...list.filter((g) => g.assetName !== lead)]
      : list;
  return [...lastUsedFirst(first), ...lastUsedFirst(rest)];
}

/**
 * The curated token behind a (group, chain) pair the picker offered, or null.
 *
 * The picker works in groups and chains; everything that moves money works in token ids. This
 * is the inverse of `buildDepositGroups` — the same key (`assetName ?? symbol`) and the same
 * chain source (`withdrawalRegistry`) — so a pair the picker can show always maps back to the
 * one token it was built from.
 */
export function depositTokenIdFor(assetName: string, chainId: string): string | null {
  const token = depositableTokens.find(
    (t) => (t.assetName ?? t.symbol) === assetName && withdrawalRegistry[t.id]?.chainId === chainId
  );
  return token?.id ?? null;
}
