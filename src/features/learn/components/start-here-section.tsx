"use client";

import { FlaskConical, Globe, Hourglass, SlidersHorizontal, Sprout } from "lucide-react";
import { WORLD_PANEL } from "@/features/world/world";
import { LEARN_H2, LEARN_H3, LEARN_ICON_BOX, LEARN_TILE, LEARN_TILE_BODY } from "../lib/styles";

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

// The guide's first section (029 B-2): trying it needs no funds — the draft and its simulation
// work without a wallet (CONTEXT.md "New Portfolio Draft") — and who it's for.
// D-568: "Try it without funds" is the guide's one frosted panel; the audiences are plain tiles.
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
      <h2 className={LEARN_H2}>{title}</h2>

      <div className={`${WORLD_PANEL} mt-6 flex flex-col gap-3 p-5 sm:flex-row sm:gap-4 sm:p-6`}>
        <span className={LEARN_ICON_BOX} aria-hidden="true">
          <FlaskConical size={18} strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <h3 className={LEARN_H3}>{tryTitle}</h3>
          <p className="mt-1.5 max-w-[68ch] text-sm leading-relaxed text-bone/[0.82] sm:text-[0.9375rem]">
            {tryBody}
          </p>
        </div>
      </div>

      <h3 className="mt-10 text-lg font-semibold text-bone [font-stretch:104%]">{audienceTitle}</h3>
      <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {audiences.map((item, i) => {
          const Icon = AUDIENCE_ICONS[i] ?? Sprout;
          return (
            <li key={item.title} className={LEARN_TILE}>
              <div className="flex items-center gap-3">
                <span className={LEARN_ICON_BOX} aria-hidden="true">
                  <Icon size={18} strokeWidth={1.75} />
                </span>
                <h4 className={LEARN_H3}>{item.title}</h4>
              </div>
              <p className={`${LEARN_TILE_BODY} mt-3`}>{item.body}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
