import type { Metadata } from "next";
import { buildDemoPresets } from "@/features/landing/lib/demo-presets";
import { DemoStage } from "./demo-stage";

// Recording/sharing surface for the portfolio-build animation — not for search.
export const metadata: Metadata = {
  title: "IntentFolio — portfolio composition demo",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Vertical/square clips read better stacked; wide reads better side by side.
const ORIENTATION_BY_FORMAT: Record<string, "row" | "stack"> = {
  square: "stack",
  vertical: "stack",
  wide: "row",
};

export default async function DemoPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;

  const lang = first(params.lang) === "en" ? "en" : "es";
  const format = first(params.format) ?? "square";
  const orientation = ORIENTATION_BY_FORMAT[format] ?? "stack";

  // Resolve the preset by id (e.g. ?preset=balanced); fall back to the first one.
  const presetId = first(params.preset);
  const presets = buildDemoPresets(lang);
  const requested = presets.findIndex((p) => p.id === presetId);
  const presetIndex = requested >= 0 ? requested : 0;

  return <DemoStage lang={lang} presetIndex={presetIndex} orientation={orientation} />;
}
