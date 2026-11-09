"use client";

import { Coins, Wallet, Sliders, RefreshCw } from "lucide-react";
import { LEARN_H2, LEARN_H3, LEARN_ICON_BOX, LEARN_ICON_BOX_EARN, LEARN_INTRO } from "../lib/styles";

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
// D-568: the same reading as the landing's How it works track. The line between steps brightens as the
// portfolio gets closer, and step 4, the differentiator (every move aims to leave a spread), is in the
// gain green of the app's history amounts.
const EARN_STEP = 3;
const CONNECTOR_FILL = ["bg-bone/20", "bg-bone/40", "bg-bone/60"] as const;

export function StepsSection({ id, title, intro, items }: StepsSectionProps) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className={LEARN_H2}>{title}</h2>
      <p className={LEARN_INTRO}>{intro}</p>

      <ol className="mt-8 flex flex-col">
        {items.map((item, i) => {
          const Icon = STEP_ICONS[i];
          const isLast = i === items.length - 1;
          const earn = i === EARN_STEP;
          return (
            <li key={item.title} className="flex gap-5">
              {/* Timeline column */}
              <div className="flex flex-col items-center">
                <span aria-hidden="true" className={earn ? LEARN_ICON_BOX_EARN : LEARN_ICON_BOX}>
                  <Icon size={18} strokeWidth={1.75} />
                </span>
                {!isLast ? (
                  <span
                    className={`my-1.5 w-px flex-1 rounded-full ${CONNECTOR_FILL[i] ?? "bg-bone/20"}`}
                    aria-hidden="true"
                  />
                ) : null}
              </div>

              {/* Content */}
              <div className={isLast ? "min-w-0 pb-0" : "min-w-0 pb-8"}>
                <span
                  className={`block pt-0.5 text-xs font-semibold tabular-nums ${earn ? "text-emerald-400" : "text-bone-dim"}`}
                >
                  0{i + 1}
                </span>
                <h3 className={LEARN_H3}>{item.title}</h3>
                <p className="mt-1.5 max-w-[68ch] text-sm leading-relaxed text-bone-dim sm:text-[0.9375rem]">
                  {item.body}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
