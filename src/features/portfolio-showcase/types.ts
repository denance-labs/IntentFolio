import type { BandState } from "@/features/portfolio-editor/types";
import type { DayCount } from "./lib/showcase-geometry";

/** One token of the showcase, already priced and colored by whoever feeds it. */
export type ShowcaseToken = {
  tokenId: string;
  /** What the donuts and chips call it: the symbol, or the registry name when a symbol repeats. */
  label: string;
  /** Registry name, under the symbol where there is room. */
  name: string;
  symbol: string;
  /** The network it lives on, where known: tells apart two tokens with the same symbol. */
  network?: string;
  color: string;
  currentPct: number;
  targetPct: number;
  currentUsd: number;
  targetUsd: number;
  bandState: BandState;
};

export type ShowcaseNetwork = { name: string; tokens: number; usd: number };

export type ShowcaseEarnings =
  | { status: "loading" }
  | { status: "failed" }
  | {
      status: "ready";
      spreadUsd: number;
      /** Some spread could not be valued: the amount is a floor. */
      spreadIsMinimum: boolean;
      swaps: number;
      /** Oldest day first, UTC days. */
      daily: DayCount[];
    };

/** How much the prices of what the portfolio holds moved today (D-523). */
export type ShowcaseDayChange = {
  usd: number;
  pct: number;
  /** When the reference price was taken (ms). */
  since: number;
};

/** Every string the showcase draws, so the dashboard and the landing can each pass their own. */
export type ShowcaseLabels = {
  value: string;
  moving: string;
  onTargetStatus: string;
  since: string;
  sinceToday: string;
  dayOne: string;
  dayMany: string;
  tokenOne: string;
  tokenMany: string;
  networkOne: string;
  networkMany: string;
  inPlace: string;
  inPlaceSub: string;
  inPlaceEmpty: string;
  onTargetCount: string;
  allOnTarget: string;
  /** The count chip of a portfolio that targets a single token. */
  oneOnTarget: string;
  oneOffTarget: string;
  inPlaceLegendIn: string;
  inPlaceLegendRest: string;
  stageTitle: string;
  editTargets: string;
  now: string;
  target: string;
  yourMix: string;
  movesToward: string;
  notInMix: string;
  intoOthers: string;
  hoverHint: string;
  tapHint: string;
  /** Before the chips of tokens with no label beside the donuts: "Under {pct}%"… */
  underShare: string;
  /** …or this, when one of them lost its label for lack of room rather than for its size. */
  alsoInPortfolio: string;
  currentMixAria: string;
  targetMixAria: string;
  spread: string;
  spreadInfo: string;
  spreadNote: string;
  spreadNone: string;
  earningsFailed: string;
  swaps: string;
  swapsNote: string;
  swapsWindow: string;
  networks: string;
  /** "{tokens}, managed as one portfolio". */
  networksNote: string;
  networksOther: string;
  /** After the change under the value, e.g. "today". */
  dayChangeToday: string;
  /** What the change measures; "{time}" is when its reference price was taken, in the viewer's time. */
  dayChangeInfo: string;
};
