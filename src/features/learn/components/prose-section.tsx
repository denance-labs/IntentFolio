"use client";

import { type ReactNode } from "react";
import { Info } from "lucide-react";
import { LEARN_H2, LEARN_PROSE } from "../lib/styles";

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
    <section id={id} className="scroll-mt-24">
      <h2 className={LEARN_H2}>{title}</h2>
      <div className="mt-4 space-y-4">
        {paragraphs.map((paragraph, i) => (
          <p key={i} className={LEARN_PROSE}>
            {paragraph}
          </p>
        ))}
      </div>
      {diagram ?? null}
      {note ? (
        <div className="mt-5 flex gap-3 rounded-xl border border-bone/[0.1] bg-bone/[0.025] p-4">
          <Info size={18} className="mt-0.5 shrink-0 text-bone-dim" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-bone/[0.82]">{note}</p>
        </div>
      ) : null}
    </section>
  );
}
