"use client";

import { useMemo } from "react";
import { PortfolioBuildDemo } from "@/features/landing/components/portfolio-build-demo";
import { buildDemoPresets } from "@/features/landing/lib/demo-presets";

type Props = {
  lang: "en" | "es";
  presetIndex: number;
  orientation: "row" | "stack";
};

/**
 * Full-screen stage for recording the portfolio-build animation to video.
 * No nav/footer — just the animation looping on a controlled background, so a
 * headless capture (scripts/record-demo.mjs) produces a clean social clip.
 */
export function DemoStage({ lang, presetIndex, orientation }: Props) {
  const presets = useMemo(() => buildDemoPresets(lang), [lang]);

  return (
    <main className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-slate-950 px-10 py-10 text-white">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgb(6_182_212_/_0.10)_0%,_transparent_65%)]"
      />
      <div className="relative w-full">
        <PortfolioBuildDemo
          presets={presets}
          lang={lang}
          showControls={false}
          autoPlayLoop
          initialPresetIndex={presetIndex}
          orientation={orientation}
          variant="showcase"
        />
      </div>
    </main>
  );
}
