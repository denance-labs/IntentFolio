"use client";

import { WORLD_LABEL } from "@/features/world/world";
import { LEARN_LINK } from "../lib/styles";

type LearnIndexProps = {
  label: string;
  items: ReadonlyArray<{ id: string; label: string }>;
};

// Desktop-only sticky table of contents. Hidden below lg so it never competes with
// content on narrow screens; the sections still carry their own ids for the in-page
// anchors. The nav is 56px tall (h-14), so top-20 keeps the list clear of it.
export function LearnIndex({ label, items }: LearnIndexProps) {
  return (
    <nav aria-label={label} className="hidden lg:block">
      <div className="sticky top-20">
        <p className={WORLD_LABEL}>{label}</p>
        <ul className="mt-4 space-y-2.5 border-l border-bone/[0.1] pl-4">
          {items.map((item) => (
            <li key={item.id}>
              <a href={`#${item.id}`} className={`${LEARN_LINK} block text-sm`}>
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
