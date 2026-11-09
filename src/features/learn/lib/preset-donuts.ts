// Donut/legend data for the /learn "Presets, explained" cards.
//
// Built directly from the real product presets (src/content/portfolio-presets.ts) so
// the visuals never drift from the actual allocations. It covers every preset, so the guide can
// show any of them (preset-section.tsx picks which). Colors are keyed by tokenId (Defuse asset id)
// across the union of all presets, so a token (BTC, USDC…) keeps the same color in every card.

import { portfolioPresets, type PresetId } from "@/content/portfolio-presets";
import { mixLabels } from "@/features/market/lib/mix-labels";
import { buildTokenColorMap } from "@/features/portfolio-editor/lib/format";

export type PresetSlice = { id: string; label: string; pct: number; color: string };

const colorById = buildTokenColorMap(
  portfolioPresets.flatMap((p) => p.slots.map((s) => s.tokenId))
);

export const presetDonutsById: Record<PresetId, PresetSlice[]> = Object.fromEntries(
  portfolioPresets.map((preset) => {
    const labels = mixLabels(preset.slots.map((s) => s.tokenId));
    return [
      preset.id,
      preset.slots.map((slot) => ({
        id: slot.tokenId,
        label: labels.get(slot.tokenId) ?? slot.tokenId,
        pct: slot.targetPct,
        color: colorById.get(slot.tokenId)?.hex ?? "#38bdf8",
      })),
    ];
  })
) as Record<PresetId, PresetSlice[]>;
