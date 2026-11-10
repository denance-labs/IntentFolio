// D-568: the world's shared surfaces, so the hero, the middle sections and /learn's closing call to
// action draw the same panel, heading and button instead of near-identical copies. D-571: shared
// with the app too (src/features/world/).

/**
 * The frosted panel: translucent bone over graphite, a lit top edge and a soft drop. The glass
 * itself is `.glass` (globals.css), shared with the app's panels; only the landing blurs.
 */
export const WORLD_PANEL = "rounded-2xl glass backdrop-blur-md";

/** Section headings: one step below the hero's h1, same face and width. */
export const WORLD_H2 =
  "text-3xl font-bold leading-[1.1] tracking-[-0.015em] text-bone [font-stretch:108%] [text-wrap:balance] sm:text-4xl";

/** The bone button with its pressed lower edge (the nav's "Open app" uses the same, smaller). */
export const WORLD_CTA =
  "inline-flex items-center justify-center rounded-md bg-bone px-5 py-3 font-semibold text-graphite shadow-[inset_0_-3px_0_rgb(185_177_156)] transition hover:bg-[#f3eddf] focus:outline-none focus-visible:ring-2 focus-visible:ring-bone/70 focus-visible:ring-offset-2 focus-visible:ring-offset-graphite";

/** Small labels inside a panel (the hero's mix title, the multi-chain rows). Not for headings. */
export const WORLD_LABEL = "text-xs uppercase tracking-[0.14em] text-bone-dim";
