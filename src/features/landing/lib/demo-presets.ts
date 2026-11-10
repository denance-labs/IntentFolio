// Demo data for the "watch a portfolio build itself" animation.
//
// Derived from the real product presets (src/content/portfolio-presets.ts) and the
// token registry — no hardcoded allocations. The "stables" preset is intentionally
// omitted: four near-identical stablecoins make a dull, hard-to-read donut.
//
// Colors are keyed by tokenId (Defuse asset id) (not symbol) because some assets share a
// display symbol (e.g. several USDC/USDT representations); keying by id keeps slice
// and row colors stable and distinct. The color map is built ONCE from the union of
// all preset tokens (not per preset), so a token keeps the same color when the viewer
// switches presets — otherwise position-based coloring repaints BTC/USDC across presets.

import { portfolioPresets, type PresetId } from "@/content/portfolio-presets";
import { getTokenById } from "@/features/market/lib/token-registry";
import { mixLabels } from "@/features/market/lib/mix-labels";
import { buildTokenColorMap } from "@/features/portfolio-editor/lib/format";

export type DemoAllocation = {
  id: string;
  /** Short ticker for the donut/legend, e.g. "BTC", "USDC". */
  label: string;
  /** Full name for the row subtitle, e.g. "Bitcoin". */
  name: string;
  /** Registry symbol, which picks the logo (`TokenIcon`), e.g. "USDC(NEAR)", "NVDA". */
  symbol: string;
  pct: number;
  /** Slice/row color (hex). */
  color: string;
};

export type DemoPreset = {
  id: PresetId;
  /** Localized display name shown in the preset switcher and donut center. */
  title: string;
  allocations: DemoAllocation[];
  /** Where the portfolio stands before it moves toward `allocations`: one asset at 100%. */
  start: DemoAllocation;
};

// D-564: every demo starts fully in USDC on NEAR (the usual first funding) and moves toward its mix.
const START_TOKEN_ID = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

// Order used by the /demo recording route. "stables" excluded.
const DEMO_PRESET_ORDER: PresetId[] = ["satoshi", "balanced", "aggressive", "conservative"];

// D-568: the landing hero's switcher leads with the stock presets, and opens on the first one.
// D-576: AI Leaders and Everyday Tech join them.
export const HERO_PRESET_ORDER: PresetId[] = ["techTitans", "aiLeaders", "everydayTech", "nearStocks", ...DEMO_PRESET_ORDER];

const PRESET_TITLES: Record<PresetId, { en: string; es: string }> = {
  conservative: { en: "Conservative", es: "Conservador" },
  balanced: { en: "Balanced", es: "Equilibrado" },
  aggressive: { en: "Aggressive", es: "Agresivo" },
  stables: { en: "Stablecoins", es: "Estables" },
  satoshi: { en: "Satoshi", es: "Satoshi" },
  pioneers: { en: "Pioneers", es: "Pioneros" },
  techTitans: { en: "Tech Titans", es: "Tech Titans" },
  nearStocks: { en: "NEAR + Stocks", es: "NEAR + Acciones" },
  aiLeaders: { en: "AI Leaders", es: "Líderes en IA" },
  everydayTech: { en: "Everyday Tech", es: "Tech cotidiana" },
};

const slotIds = (ids: PresetId[]) =>
  ids.flatMap((id) => portfolioPresets.find((p) => p.id === id)?.slots.map((s) => s.tokenId) ?? []);

export function buildDemoPresets(lang: "en" | "es", order: PresetId[] = DEMO_PRESET_ORDER): DemoPreset[] {
  // One color per token across every demo preset, in first-seen order, so a
  // token (e.g. BTC, USDC) keeps the same slice/row color when switching presets.
  // D-568: the stock presets' tokens come last, so adding them leaves BTC, ETH, NEAR and USDC
  // with the colors they already had.
  const colorById = buildTokenColorMap([...slotIds(DEMO_PRESET_ORDER), START_TOKEN_ID, ...slotIds(HERO_PRESET_ORDER)]);
  const startToken = getTokenById(START_TOKEN_ID);
  const start: DemoAllocation = {
    id: START_TOKEN_ID,
    label: startToken?.assetName ?? startToken?.symbol ?? "USDC",
    name: startToken?.name ?? "",
    symbol: startToken?.symbol ?? "USDC",
    pct: 100,
    color: colorById.get(START_TOKEN_ID)?.hex ?? "#38bdf8",
  };

  return order.map((id) => {
    const preset = portfolioPresets.find((p) => p.id === id);
    if (!preset) return null;

    const labels = mixLabels(preset.slots.map((s) => s.tokenId));
    const allocations: DemoAllocation[] = preset.slots.map((slot) => {
      const token = getTokenById(slot.tokenId);
      return {
        id: slot.tokenId,
        label: labels.get(slot.tokenId) ?? slot.tokenId,
        name: token?.name ?? "",
        symbol: token?.symbol ?? slot.tokenId,
        pct: slot.targetPct,
        color: colorById.get(slot.tokenId)?.hex ?? "#38bdf8",
      };
    });

    return { id, title: PRESET_TITLES[id][lang], allocations, start } satisfies DemoPreset;
  }).filter((p): p is DemoPreset => p !== null);
}
