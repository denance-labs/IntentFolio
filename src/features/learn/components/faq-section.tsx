"use client";

import { ChevronDown } from "lucide-react";
import { motion } from "framer-motion";

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
    <motion.section
      id={id}
      className="scroll-mt-24"
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      <h2 className="text-2xl font-bold text-white">{title}</h2>
      <div className="mt-6 divide-y divide-slate-800 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
        {items.map((item) => (
          <details
            key={item.q}
            name="learn-faq"
            className="group marker:hidden open:bg-slate-900/60"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-base font-medium text-white transition hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300/60">
              {item.q}
              <ChevronDown
                size={18}
                aria-hidden="true"
                className="shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-180"
              />
            </summary>
            <p className="px-5 pb-4 text-sm leading-relaxed text-slate-400">{item.a}</p>
          </details>
        ))}
      </div>
    </motion.section>
  );
}
