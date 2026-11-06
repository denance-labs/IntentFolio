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
  pct: number;
  /** Slice/row color (hex). */
  color: string;
};

export type DemoPreset = {
  id: PresetId;
  /** Localized display name shown in the preset switcher and donut center. */
  title: string;
  allocations: DemoAllocation[];
};

// Order shown in the landing switcher / used as recording defaults. "stables" excluded.
const DEMO_PRESET_ORDER: PresetId[] = ["satoshi", "balanced", "aggressive", "conservative"];

const PRESET_TITLES: Record<PresetId, { en: string; es: string }> = {
  conservative: { en: "Conservative", es: "Conservador" },
  balanced: { en: "Balanced", es: "Equilibrado" },
  aggressive: { en: "Aggressive", es: "Agresivo" },
  stables: { en: "Stablecoins", es: "Estables" },
  satoshi: { en: "Satoshi", es: "Satoshi" },
  pioneers: { en: "Pioneers", es: "Pioneros" },
  bigTech: { en: "Big Tech", es: "Big Tech" },
  nearStocks: { en: "NEAR + Stocks", es: "NEAR + Acciones" },
};

export function buildDemoPresets(lang: "en" | "es"): DemoPreset[] {
  // One color per token across every demo preset, in first-seen order, so a
  // token (e.g. BTC, USDC) keeps the same slice/row color when switching presets.
  const colorById = buildTokenColorMap(
    DEMO_PRESET_ORDER.flatMap(
      (id) => portfolioPresets.find((p) => p.id === id)?.slots.map((s) => s.tokenId) ?? []
    )
  );

  return DEMO_PRESET_ORDER.map((id) => {
    const preset = portfolioPresets.find((p) => p.id === id);
    if (!preset) return null;

    const labels = mixLabels(preset.slots.map((s) => s.tokenId));
    const allocations: DemoAllocation[] = preset.slots.map((slot) => {
      const token = getTokenById(slot.tokenId);
      return {
        id: slot.tokenId,
        label: labels.get(slot.tokenId) ?? slot.tokenId,
        name: token?.name ?? "",
        pct: slot.targetPct,
        color: colorById.get(slot.tokenId)?.hex ?? "#38bdf8",
      };
    });

    return { id, title: PRESET_TITLES[id][lang], allocations } satisfies DemoPreset;
  }).filter((p): p is DemoPreset => p !== null);
}
