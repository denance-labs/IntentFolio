"use client";

import { ChevronDown } from "lucide-react";
import { LEARN_H2 } from "../lib/styles";

type FaqItem = { q: string; a: string };

type FaqSectionProps = {
  id: string;
  title: string;
  items: ReadonlyArray<FaqItem>;
};

// Native <details>/<summary> accordion: accessible and keyboard-operable with no JS,
// works without hydration, and degrades gracefully. Sharing one `name` makes the
// group exclusive — opening one closes the rest (HTML's native accordion behavior).
// The chevron rotates via the open: variant; marker:hidden removes the default triangle.
export function FaqSection({ id, title, items }: FaqSectionProps) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className={LEARN_H2}>{title}</h2>
      <div className="mt-6 divide-y divide-bone/[0.08] overflow-hidden rounded-2xl border border-bone/[0.1] bg-bone/[0.02]">
        {items.map((item) => (
          <details key={item.q} name="learn-faq" className="group marker:hidden open:bg-bone/[0.035]">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[1rem] font-medium text-bone transition hover:bg-bone/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bone/70">
              {item.q}
              <ChevronDown
                size={18}
                aria-hidden="true"
                className="shrink-0 text-bone-dim transition-transform duration-200 group-open:rotate-180"
              />
            </summary>
            <p className="max-w-[68ch] px-5 pb-5 text-[0.9375rem] leading-relaxed text-bone/[0.82]">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
