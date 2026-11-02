"use client";

// My Account notice for Allocates still in transit (D-293, 012.plan B2). It answers the
// question the create modal points the user to — "where did those funds go?" — until the
// portfolio shows up in the list, or until funds added to an existing one arrive (D-321).
// Informational only: no actions, nothing written.
//
// A <section>, not a live region: it is present on arrival, and announcing it on every
// re-evaluation would repeat the same news.

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { getTokenById } from "@/features/market/lib/token-registry";
import { toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { formatCrypto } from "@/features/portfolio-editor/lib/format";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { shellTranslations } from "@/features/dashboard-shell/lib/translations";
import { usePendingAllocates } from "../hooks/use-pending-allocates";
import { fromBaseUnits } from "../lib/base-units";
import { formatAllocateAge, type PendingAllocate, type PendingAllocateKind } from "../lib/pending-allocates";

// Same pills as the activity feed: cyan = in hand and moving (TX_BROADCASTED), amber = not
// confirmed yet (PENDING). None is red — nothing here is a failure, not even a record under
// the team's review (D-448), which shares the amber of "not settled yet".
const KIND_STYLES: Record<PendingAllocateKind, string> = {
  completing: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  confirming: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  review: "border-amber-500/40 bg-amber-500/10 text-amber-300",
};

function truncateId(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 10)}…${id.slice(-4)}`;
}

/**
 * One leg in human units. The record holds INTENTS ids (`nep141:wrap.near` for NEAR), so the
 * id goes back through `toRegistryTokenId` before the registry lookup. A token the registry
 * does not know shows its id and no amount: without its decimals the base units would read
 * as a number off by orders of magnitude.
 */
function legLabel(leg: PendingAllocate["legs"][number]): string {
  const token = getTokenById(toRegistryTokenId(leg.tokenId));
  if (!token) return truncateId(leg.tokenId);
  let qty: number;
  try {
    qty = fromBaseUnits(BigInt(leg.amount), token.decimals);
  } catch {
    return token.symbol;
  }
  return `${formatCrypto(qty)} ${token.symbol}`;
}

const MINUTE_MS = 60_000;

export function PendingAllocatesBanner({ signerId }: { signerId: string | null | undefined }) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { pending } = usePendingAllocates(signerId);

  // The ages are relative, so they tick. Once a minute is the finest unit shown.
  const [now, setNow] = useState(() => Date.now());
  const visible = !!pending && pending.length > 0;
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, [visible]);

  if (!visible) return null;

  const many = pending.length > 1;
  // D-321: "being created" is only true of a Setup. With a top-up in the list the copy says
  // where the funds are going instead.
  const anyTopUp = pending.some((p) => p.op === "allocate_into");
  const title = many
    ? (anyTopUp ? t.pendingAllocatesTitleMixedMany : t.pendingAllocatesTitleMany).replace(
        "{count}",
        String(pending.length)
      )
    : anyTopUp
      ? t.pendingAllocatesTitleAddOne
      : t.pendingAllocatesTitleOne;
  const body = many
    ? anyTopUp
      ? t.pendingAllocatesBodyMixedMany
      : t.pendingAllocatesBodyMany
    : anyTopUp
      ? t.pendingAllocatesBodyAddOne
      : t.pendingAllocatesBodyOne;

  return (
    <section
      aria-labelledby="pending-allocates-heading"
      className="flex items-start gap-3 rounded-2xl border border-cyan-500/30 bg-cyan-500/10 px-5 py-4"
    >
      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 id="pending-allocates-heading" className="font-semibold text-cyan-200">
          {title}
        </h2>
        <p className="mt-0.5 text-sm text-cyan-300/70">
          {body}
        </p>
        {/* D-448: the body promises the funds will show up by themselves, which a record under
            review cannot keep. Said once, not per row. */}
        {pending.some((p) => p.kind === "review") ? (
          <p className="mt-1 text-sm text-amber-300/80">{t.pendingAllocatesReviewNote}</p>
        ) : null}
        <ul className="mt-3 divide-y divide-cyan-500/20">
          {pending.map((p) => (
            <li key={p.id} className="py-2 first:pt-0 last:pb-0">
              {/* Wraps instead of truncating: the portfolio name is what says where the funds
                  are going, and at 390 px "Adding funds to …" left no room for it. */}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <p className="min-w-0 break-words text-sm font-medium text-slate-100">
                  {p.op === "allocate_into"
                    ? t.pendingAllocateAddingTo.replace("{name}", p.portfolioName)
                    : p.portfolioName}
                </p>
                <span
                  className={`ml-auto shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${KIND_STYLES[p.kind]}`}
                >
                  {p.kind === "confirming"
                    ? t.pendingAllocateConfirming
                    : p.kind === "review"
                      ? t.pendingAllocateReview
                      : p.op === "allocate_into"
                      ? t.pendingAllocateCompletingAdd
                      : t.pendingAllocateCompleting}
                </span>
              </div>
              <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-xs text-slate-400">
                {/* The separator TRAILS each leg inside its no-wrap span, so a wrapped line ends
                    with "·" instead of starting with one (QA at 390 px). The age always follows. */}
                {p.legs.map((leg, i) => (
                  <span key={`${leg.tokenId}:${i}`} className="whitespace-nowrap tabular-nums">
                    {legLabel(leg)}
                    <span aria-hidden="true" className="ml-1.5 text-slate-600">·</span>
                  </span>
                ))}
                <time dateTime={new Date(p.createdAt).toISOString()} className="whitespace-nowrap">
                  {formatAllocateAge(p.createdAt, now, lang)}
                </time>
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
