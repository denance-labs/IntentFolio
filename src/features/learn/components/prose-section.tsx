"use client";

import { type ReactNode } from "react";
import { Info } from "lucide-react";
import { motion } from "framer-motion";

type ProseSectionProps = {
  id: string;
  title: string;
  paragraphs: ReadonlyArray<string>;
  note?: string;
  /** Optional visual element rendered between the paragraphs and the note callout. */
  diagram?: ReactNode;
};

// scroll-mt-24 offsets the anchor target below the sticky nav so headings aren't
// hidden behind it when jumped to from the table of contents.
export function ProseSection({ id, title, paragraphs, note, diagram }: ProseSectionProps) {
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
      <div className="mt-4 space-y-4">
        {paragraphs.map((paragraph, i) => (
          <p key={i} className="text-base leading-relaxed text-slate-300">
            {paragraph}
          </p>
        ))}
      </div>
      {diagram ?? null}
      {note ? (
        <div className="mt-5 flex gap-3 rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-4">
          <Info size={18} className="mt-0.5 shrink-0 text-cyan-400" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-slate-300">{note}</p>
        </div>
      ) : null}
    </motion.section>
  );
}
