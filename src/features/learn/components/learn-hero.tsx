"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { LEARN_LINK } from "../lib/styles";

type LearnHeroProps = {
  title: string;
  sub: string;
  backLabel: string;
};

// D-568: no label above the title (the nav already says Guide) and no entrance: the title is there
// on the first paint, with or without JavaScript.
export function LearnHero({ title, sub, backLabel }: LearnHeroProps) {
  return (
    <section aria-label={title} className="border-b border-bone/[0.08] pb-14 pt-10 sm:pb-16 sm:pt-12">
      <div className="mx-auto max-w-6xl px-6">
        <Link href="/" className={`${LEARN_LINK} -ml-1 inline-flex min-h-11 items-center gap-1.5 px-1 text-sm`}>
          <ArrowLeft size={14} aria-hidden="true" />
          {backLabel}
        </Link>
        <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-[1.04] tracking-[-0.015em] text-bone [font-stretch:110%] [text-wrap:balance] sm:text-5xl">
          {title}
        </h1>
        <p className="mt-4 max-w-2xl text-[1rem] leading-relaxed text-bone-dim sm:text-lg">{sub}</p>
      </div>
    </section>
  );
}
