"use client";

import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { LandingNav } from "@/features/landing/components/landing-nav";
import { LandingFooter } from "@/features/landing/components/landing-footer";
import { ClosingCta } from "@/features/landing/components/closing-cta";
import { archivo } from "@/features/landing/lib/fonts";
import { learnTranslations } from "./lib/translations";
import { LearnHero } from "./components/learn-hero";
import { LearnIndex } from "./components/learn-index";
import { ProseSection } from "./components/prose-section";
import { StepsSection } from "./components/steps-section";
import { PresetSection } from "./components/preset-section";
import { ListSection } from "./components/list-section";
import { FaqSection } from "./components/faq-section";
import { BandDiagram } from "./components/band-diagram";
import { StartHereSection } from "./components/start-here-section";

export function LearnPage() {
  const { lang } = useLanguage();
  const t = learnTranslations[lang];

  return (
    // Same world as the landing: ground, face, selection and focus colors (D-568). Nothing on this
    // page moves, so every section is there on the first paint, with or without JavaScript.
    <div data-landing-world className={`${archivo.variable} min-h-screen font-world text-bone`}>
      <a
        href="#learn-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-bone focus:px-4 focus:py-2 focus:font-semibold focus:text-graphite"
      >
        Skip to main content
      </a>
      <LandingNav />
      <LearnHero
        title={t.hero.title}
        sub={t.hero.sub}
        backLabel={t.backToHome}
      />
      <main id="learn-content" className="mx-auto max-w-6xl px-6 py-16">
        <div className="lg:grid lg:grid-cols-[200px_1fr] lg:gap-12">
          <LearnIndex label={t.index.label} items={t.index.items} />
          <div className="min-w-0 space-y-16">
            <StartHereSection
              id={t.startHere.id}
              title={t.startHere.title}
              tryTitle={t.startHere.tryTitle}
              tryBody={t.startHere.tryBody}
              audienceTitle={t.startHere.audienceTitle}
              audiences={t.startHere.audiences}
            />
            <ProseSection
              id={t.coreIdea.id}
              title={t.coreIdea.title}
              paragraphs={t.coreIdea.paragraphs}
            />
            <StepsSection
              id={t.steps.id}
              title={t.steps.title}
              intro={t.steps.intro}
              items={t.steps.items}
            />
            <ProseSection
              id={t.rebalancing.id}
              title={t.rebalancing.title}
              paragraphs={t.rebalancing.paragraphs}
              note={t.rebalancing.note}
              diagram={
                <BandDiagram
                  targetLabel={t.rebalancing.diagram.targetLabel}
                  bandLabel={t.rebalancing.diagram.bandLabel}
                  buildingLabel={t.rebalancing.diagram.buildingLabel}
                  onTargetLabel={t.rebalancing.diagram.onTargetLabel}
                  spreadLabel={t.rebalancing.diagram.spreadLabel}
                />
              }
            />
            <PresetSection />
            <ListSection id={t.tips.id} title={t.tips.title} items={t.tips.items} />
            <FaqSection id={t.faq.id} title={t.faq.title} items={t.faq.items} />
          </div>
        </div>
      </main>
      <ClosingCta />
      <LandingFooter />
    </div>
  );
}
