"use client";

import { Coins, Wallet, Sliders, RefreshCw } from "lucide-react";
import { motion } from "framer-motion";

type StepItem = { title: string; body: string };

type StepsSectionProps = {
  id: string;
  title: string;
  intro: string;
  items: ReadonlyArray<StepItem>;
};

// Build first, connect and fund second (D-393): the same order as the signed-out start. Then it
// moves toward its targets and earns along the way: the landing's "How it works" icons (D-454).
const STEP_ICONS = [Sliders, Wallet, RefreshCw, Coins] as const;

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1 } },
};

const itemVariants = {
  hidden: { opacity: 0, x: -12 },
  show: { opacity: 1, x: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

export function StepsSection({ id, title, intro, items }: StepsSectionProps) {
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
      <p className="mt-3 text-base text-slate-400">{intro}</p>

      <motion.ol
        className="mt-8 flex flex-col gap-0"
        variants={containerVariants}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
      >
        {items.map((item, i) => {
          const Icon = STEP_ICONS[i];
          const isLast = i === items.length - 1;
          return (
            <motion.li key={item.title} variants={itemVariants} className="flex gap-5">
              {/* Timeline column */}
              <div className="flex flex-col items-center">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-500/40 bg-cyan-500/20 text-cyan-400">
                  <Icon size={20} aria-hidden="true" />
                </div>
                {!isLast ? (
                  <div className="mt-1 w-px flex-1 bg-slate-800" aria-hidden="true" />
                ) : null}
              </div>

              {/* Content */}
              <div className={isLast ? "pb-0" : "pb-8"}>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-cyan-400/70">0{i + 1}</span>
                  <h3 className="text-base font-semibold text-white">{item.title}</h3>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{item.body}</p>
              </div>
            </motion.li>
          );
        })}
      </motion.ol>
    </section>
  );
}
