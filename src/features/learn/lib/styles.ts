// D-568: /learn in the landing's world (graphite, bone, Archivo), tuned for reading: smaller section
// headings than the landing's (a guide has seven of them under one page title), longer line height and
// a capped measure for the prose. The panel and the label come from the landing's world.ts.

/** Section headings: the landing's face and tracking, one size down. */
export const LEARN_H2 =
  "text-2xl font-bold leading-tight tracking-[-0.01em] text-bone [font-stretch:106%] [text-wrap:balance] sm:text-[1.75rem]";

/** Body paragraphs: brighter than the landing's dim bone, since this page is read end to end. */
export const LEARN_PROSE = "max-w-[68ch] text-[1rem] leading-[1.7] text-bone/[0.82]";

/** Intro line under a heading. */
export const LEARN_INTRO = "mt-3 max-w-[68ch] text-[1rem] leading-relaxed text-bone-dim";

/** Repeated items (audiences, presets, tips): the landing's How it works tile, border only, no shadow. */
export const LEARN_TILE = "rounded-2xl border border-bone/[0.1] bg-bone/[0.025] p-5";

/** Small titles inside a tile. */
export const LEARN_H3 = "text-[1rem] font-semibold leading-snug text-bone [font-stretch:104%]";

/** Tile body text. */
export const LEARN_TILE_BODY = "mt-1.5 text-sm leading-relaxed text-bone-dim";

/** The glass square that holds a lucide icon, as in the landing's How it works. */
const ICON_BOX_SHAPE =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]";
export const LEARN_ICON_BOX = `${ICON_BOX_SHAPE} border-bone/[0.13] bg-bone/[0.06] text-bone`;
/** The same square in gain green, for the step where the portfolio earns. */
export const LEARN_ICON_BOX_EARN = `${ICON_BOX_SHAPE} border-emerald-400/30 bg-emerald-400/10 text-emerald-300`;

/** Text links: dim bone that brightens, with the world's focus ring. */
export const LEARN_LINK =
  "rounded text-bone-dim transition hover:text-bone focus:outline-none focus-visible:ring-2 focus-visible:ring-bone/70";
