"use client";

import { motion } from "framer-motion";

type ListItem = { title: string; body: string };

type ListSectionProps = {
  id: string;
  title: string;
  intro?: string;
  items: ReadonlyArray<ListItem>;
  // When true, each card shows its 1-based position as a numbered badge (used for the
  // step-by-step section); otherwise the cards are an unordered set (presets, tips).
  numbered?: boolean;
};

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

export function ListSection({ id, title, intro, items, numbered }: ListSectionProps) {
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
      {intro ? <p className="mt-3 text-base text-slate-400">{intro}</p> : null}

      <motion.ul
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2"
        variants={containerVariants}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
      >
        {items.map((item, i) => (
          <motion.li
            key={item.title}
            variants={cardVariants}
            className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5"
          >
            {numbered ? (
              <div className="mb-3 flex h-7 w-7 items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-500/20 text-sm font-bold text-cyan-400">
                {i + 1}
              </div>
            ) : null}
            <h3 className="text-base font-semibold text-white">{item.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{item.body}</p>
          </motion.li>
        ))}
      </motion.ul>
    </section>
  );
}
