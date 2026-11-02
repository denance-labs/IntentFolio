"use client";

import { motion } from "framer-motion";
import { FlaskConical, Globe, Hourglass, SlidersHorizontal, Sprout } from "lucide-react";

type ListItem = { title: string; body: string };

type StartHereSectionProps = {
  id: string;
  title: string;
  tryTitle: string;
  tryBody: string;
  audienceTitle: string;
  audiences: ReadonlyArray<ListItem>;
};

// Icons in the order of the audiences in the translations (029 B-2): starting out, knows
// crypto, comes from another network, holds for the long term.
const AUDIENCE_ICONS = [Sprout, SlidersHorizontal, Globe, Hourglass];

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

// The guide's first section (029 B-2): trying it needs no funds — the draft and its simulation
// work without a wallet (CONTEXT.md "New Portfolio Draft") — and who it's for.
export function StartHereSection({
  id,
  title,
  tryTitle,
  tryBody,
  audienceTitle,
  audiences,
}: StartHereSectionProps) {
  return (
    <section id={id} className="scroll-mt-24">
      <motion.h2
        className="text-2xl font-bold text-white"
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        {title}
      </motion.h2>

      <div className="mt-6 flex flex-col gap-3 rounded-2xl sm:flex-row sm:gap-4 border border-cyan-500/30 bg-cyan-500/5 p-5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-400/15 text-cyan-300">
          <FlaskConical size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-white">{tryTitle}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{tryBody}</p>
        </div>
      </div>

      <h3 className="mt-10 text-lg font-semibold text-white">{audienceTitle}</h3>
      <motion.ul
        className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2"
        variants={containerVariants}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
      >
        {audiences.map((item, i) => {
          const Icon = AUDIENCE_ICONS[i] ?? Sprout;
          return (
            <motion.li
              key={item.title}
              variants={cardVariants}
              className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5"
            >
              <span className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-slate-800 text-cyan-300">
                <Icon size={16} aria-hidden="true" />
              </span>
              <h4 className="text-base font-semibold text-white">{item.title}</h4>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{item.body}</p>
            </motion.li>
          );
        })}
      </motion.ul>
    </section>
  );
}
