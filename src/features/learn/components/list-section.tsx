"use client";

import { LEARN_H2, LEARN_H3, LEARN_INTRO, LEARN_TILE, LEARN_TILE_BODY } from "../lib/styles";

type ListItem = { title: string; body: string };

type ListSectionProps = {
  id: string;
  title: string;
  intro?: string;
  items: ReadonlyArray<ListItem>;
};

// An unordered set of tiles (the tips). The steps have their own timeline (StepsSection).
export function ListSection({ id, title, intro, items }: ListSectionProps) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className={LEARN_H2}>{title}</h2>
      {intro ? <p className={LEARN_INTRO}>{intro}</p> : null}

      <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.title} className={LEARN_TILE}>
            <h3 className={LEARN_H3}>{item.title}</h3>
            <p className={LEARN_TILE_BODY}>{item.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
