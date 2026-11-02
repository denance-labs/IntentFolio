"use client";

import { useEffect, useMemo } from "react";
import { getTokenById } from "@/features/market/lib/token-registry";
import { buildTokenColorMap, colorForSymbol, formatUsd } from "@/features/portfolio-editor/lib/format";
import { focusLandingIfLost } from "@/features/portfolio-editor/hooks/use-dialog-focus";
import { useLanguage } from "../context/language-context";
import type { NewPortfolioDraft } from "../lib/new-portfolio-draft";
import { shellTranslations } from "../lib/translations";
import { SkeletonBlock } from "./view-states";

// How many tokens the card names before "+N": the whole mix is one click away, in its tab.
const MAX_CHIPS = 6;

const symbolFor = (tokenId: string) => getTokenById(tokenId)?.symbol ?? tokenId;

type CardProps = {
  draft: NewPortfolioDraft;
  /** The draft's tab (019-4): where it is seen whole, edited and discarded. */
  onView: () => void;
} & (
  | { variant: "waiting"; onDeposit: () => void }
  // D-486: the General Balance is still being read — no claim about funds, no money action yet.
  | { variant: "loading" }
  // The General Balance can fund it now (≥ $1): one signature away. `amountUsd` is how much.
  | { variant: "ready"; onConfirm: () => void; amountUsd: number }
  // 022-B (D-453): no wallet connected — the draft lives in this browser, connecting comes first.
  | { variant: "signed-out"; onConnect: () => void }
);

// 016 block 2.3 — My Account's card for a New Portfolio Draft still waiting for funds: what
// was designed (name and mix) and the deposit for it.
//
// 016 block 2.4 — the same card once the funds arrived: confirm it.
//
// 019-4 (D-393 Q3) — the draft has a tab of its own now, and it is the one place to edit or
// discard it. The card keeps the money action that belongs to My Account and points there.
//
// 022-B (D-453) — My Account opens signed out too; there the card's action is connecting, with
// the same copy as the draft's tab signed out.
export function NewPortfolioDraftCard(props: CardProps) {
  const { draft, onView } = props;
  const { lang } = useLanguage();
  const t = shellTranslations[lang];

  // D-360: confirming removes the card with the focus in it; the landing takes it.
  useEffect(() => focusLandingIfLost, []);

  const colors = useMemo(() => buildTokenColorMap(draft.rows.map((r) => r.tokenId)), [draft.rows]);
  const colorOf = (tokenId: string) => colors.get(tokenId) ?? colorForSymbol(symbolFor(tokenId));
  const shown = draft.rows.slice(0, MAX_CHIPS);
  const hidden = draft.rows.length - shown.length;
  const ready = props.variant === "ready";

  return (
    <section
      aria-labelledby="new-portfolio-draft-card-title"
      className={`rounded-2xl border bg-slate-900 px-5 py-4 ${ready ? "border-cyan-400/40" : "border-slate-700"}`}
    >
      {/* D-360: the landing for the focus when the control that opened the editor is gone. */}
      <h2
        id="new-portfolio-draft-card-title"
        tabIndex={-1}
        data-focus-landing
        className="rounded font-semibold text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
      >
        {props.variant === "ready"
          ? t.draftReadyTitle.replace("{amount}", formatUsd(props.amountUsd)).replace("{name}", draft.name)
          : props.variant === "loading"
            ? draft.name
            : (props.variant === "signed-out" ? t.draftSignedOutCardTitle : t.draftCardTitle).replace("{name}", draft.name)}
      </h2>
      {props.variant === "loading" ? (
        // D-486: the body line's place while the balance loads, so the card neither looks done nor
        // grows when it resolves (s283 QA).
        <div data-testid="draft-loading-line" className="mt-0.5 flex h-5 items-center">
          <SkeletonBlock className="h-3 w-56 max-w-full" />
        </div>
      ) : ready ? null : (
        <p className="mt-0.5 text-sm text-slate-400">
          {props.variant === "signed-out" ? t.draftSignedOutCardBody : t.draftCardBody}
        </p>
      )}

      <div aria-hidden="true" className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-slate-800">
        {draft.rows.map((r) => (
          <span key={r.tokenId} className="h-full" style={{ width: `${r.targetPct}%`, backgroundColor: colorOf(r.tokenId).hex }} />
        ))}
      </div>
      <ul aria-label={t.presetReviewComposition} className="mt-2 flex flex-wrap gap-1">
        {shown.map((r) => (
          <li
            key={r.tokenId}
            className="flex items-center gap-1 rounded-md bg-slate-800 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-300"
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colorOf(r.tokenId).hex }} />
            {symbolFor(r.tokenId)} {r.targetPct}%
          </li>
        ))}
        {hidden > 0 ? (
          <li className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-400">+{hidden}</li>
        ) : null}
      </ul>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        {props.variant === "loading" ? null : (
          <button
            type="button"
            onClick={
              props.variant === "ready" ? props.onConfirm : props.variant === "signed-out" ? props.onConnect : props.onDeposit
            }
            className="rounded-xl bg-cyan-500 px-5 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
          >
            {{ ready: t.draftReadyConfirm, waiting: t.draftCardDeposit, "signed-out": t.walletConnect }[props.variant]}
          </button>
        )}
        <button
          type="button"
          onClick={onView}
          className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-200 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        >
          {t.draftCardView}
        </button>
      </div>
    </section>
  );
}
