"use client";

import { MotionConfig } from "framer-motion";
import { LandingNav } from "./components/landing-nav";
import { HeroSection } from "./components/hero-section";
import { HowItWorksSection } from "./components/how-it-works-section";
import { CompositionDemoSection } from "./components/composition-demo-section";
import { MultiChainSection } from "./components/multi-chain-section";
import { RebalancingSection } from "./components/rebalancing-section";
import { PerformanceSection } from "./components/performance-section";
import { MetaPoolSection } from "./components/meta-pool-section";
import { LearnTeaserSection } from "./components/learn-teaser-section";
import { ClosingCta } from "./components/closing-cta";
import { LandingFooter } from "./components/landing-footer";

export function LandingPage({ comingSoon = false }: { comingSoon?: boolean }) {
  return (
    // reducedMotion="user" lets framer disable transform/slide for users who prefer
    // reduced motion while keeping the opacity fade — handled at the animation layer,
    // so render output is identical on server and client (no hydration mismatch from
    // branching on the client-only useReducedMotion() value).
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-slate-950 text-white">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-cyan-500 focus:px-4 focus:py-2 focus:font-semibold focus:text-slate-950"
        >
          Skip to main content
        </a>
        <LandingNav comingSoon={comingSoon} />
        <main id="main-content">
          <HeroSection comingSoon={comingSoon} />
          <HowItWorksSection />
          <CompositionDemoSection />
          <MultiChainSection />
          <RebalancingSection />
          <PerformanceSection />
          <MetaPoolSection />
          <LearnTeaserSection />
          <ClosingCta comingSoon={comingSoon} />
        </main>
        <LandingFooter />
      </div>
    </MotionConfig>
  );
}
