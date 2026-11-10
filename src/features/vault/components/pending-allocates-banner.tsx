"use client";

// My Account notice for Allocates still in transit (D-293, 012.plan B2). It answers the
// question the create modal points the user to — "where did those funds go?" — until the
// portfolio shows up in the list, or until funds added to an existing one arrive (D-321).
// Informational only: no actions, nothing written.
//
// Above it, the notice for an Allocate that provably never ran (D-556): the user's funds never
// moved and they can try again. It stays until dismissed, the one thing written from here.
//
// <section>s, not live regions: they are present on arrival, and announcing them on every
// re-evaluation would repeat the same news.

import { useEffect, useState } from "react";
import { Clock, Info } from "lucide-react";
import { getTokenById } from "@/features/market/lib/token-registry";
import { toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { formatCrypto } from "@/features/portfolio-editor/lib/format";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { shellTranslations } from "@/features/dashboard-shell/lib/translations";
import { usePendingAllocates } from "../hooks/use-pending-allocates";
import { fromBaseUnits } from "../lib/base-units";
import {
  formatAllocateAge,
  type NotExecutedAllocate,
  type PendingAllocate,
  type PendingAllocateKind,
} from "../lib/pending-allocates";

// Same pills as the activity feed: accent = in hand and moving (TX_BROADCASTED), amber = not
// confirmed yet (PENDING). None is red — nothing here is a failure, not even a record under
// the team's review (D-448), which shares the amber of "not settled yet".
const KIND_STYLES: Record<PendingAllocateKind, string> = {
  completing: "border-accent/40 bg-accent/10 text-accent",
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

/** The amounts and the age of one row. */
function RowDetail({ allocate, now }: { allocate: NotExecutedAllocate; now: number }) {
  const { lang } = useLanguage();
  return (
    <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-xs text-slate-400">
      {/* The separator TRAILS each leg inside its no-wrap span, so a wrapped line ends
          with "·" instead of starting with one (QA at 390 px). The age always follows. */}
      {allocate.legs.map((leg, i) => (
        <span key={`${leg.tokenId}:${i}`} className="whitespace-nowrap tabular-nums">
          {legLabel(leg)}
          <span aria-hidden="true" className="ml-1.5 text-slate-600">·</span>
        </span>
      ))}
      <time dateTime={new Date(allocate.createdAt).toISOString()} className="whitespace-nowrap">
        {formatAllocateAge(allocate.createdAt, now, lang)}
      </time>
    </p>
  );
}

/** Amber, not red: nothing was lost, and the way forward is simply to try again. */
function NotExecutedNotice({
  allocates,
  now,
  onDismiss,
}: {
  allocates: NotExecutedAllocate[];
  now: number;
  onDismiss: () => void;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const title =
    allocates.length > 1
      ? t.notExecutedAllocatesTitleMany.replace("{count}", String(allocates.length))
      : t.notExecutedAllocatesTitleOne;
  return (
    <section
      aria-labelledby="not-executed-allocates-heading"
      className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 id="not-executed-allocates-heading" className="font-semibold text-amber-200">
          {title}
        </h2>
        <p className="mt-0.5 text-sm text-amber-300/70">{t.notExecutedAllocatesBody}</p>
        <ul className="mt-3 divide-y divide-amber-500/20">
          {allocates.map((allocate) => (
            <li key={allocate.id} className="py-2 first:pt-0 last:pb-0">
              <p className="min-w-0 break-words text-sm font-medium text-slate-100">{allocate.portfolioName}</p>
              <RowDetail allocate={allocate} now={now} />
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-3 rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-medium text-amber-100 transition hover:bg-amber-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
        >
          {t.notExecutedAllocatesDismiss}
        </button>
      </div>
    </section>
  );
}

export function PendingAllocatesBanner({ signerId }: { signerId: string | null | undefined }) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { pending, notExecuted, dismissNotExecuted } = usePendingAllocates(signerId);

  // The ages are relative, so they tick. Once a minute is the finest unit shown.
  const [now, setNow] = useState(() => Date.now());
  const anyPending = !!pending && pending.length > 0;
  const visible = anyPending || notExecuted.length > 0;
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, [visible]);

  if (!visible) return null;

  const notice =
    notExecuted.length > 0 ? (
      <NotExecutedNotice
        allocates={notExecuted}
        now={now}
        onDismiss={() => dismissNotExecuted(notExecuted.map((n) => n.id))}
      />
    ) : null;
  if (!anyPending) return notice;

  const many = pending.length > 1;
  // D-321: "being created" is only true of a Setup. With a top-up in the list the copy says
  // where the funds are going instead.
  const anyTopUp = pending.some((p) => p.op === "allocate_into");
  // D-552: "these funds already left" only when every row has the burnt nonce behind it. A single
  // unproven row makes the whole notice say what is known, since it is one sentence over the list.
  const anyUnproven = pending.some((p) => p.kind === "confirming");
  const title = many
    ? (anyTopUp || anyUnproven ? t.pendingAllocatesTitleMixedMany : t.pendingAllocatesTitleMany).replace(
        "{count}",
        String(pending.length)
      )
    : anyUnproven
      ? t.pendingAllocatesTitleUnconfirmedOne
      : anyTopUp
        ? t.pendingAllocatesTitleAddOne
        : t.pendingAllocatesTitleOne;
  const body = anyUnproven
    ? many
      ? t.pendingAllocatesBodyUnconfirmedMany
      : t.pendingAllocatesBodyUnconfirmedOne
    : many
      ? anyTopUp
        ? t.pendingAllocatesBodyMixedMany
        : t.pendingAllocatesBodyMany
      : anyTopUp
        ? t.pendingAllocatesBodyAddOne
        : t.pendingAllocatesBodyOne;

  return (
    <>
      {notice}
      <section
        aria-labelledby="pending-allocates-heading"
        className="flex items-start gap-3 rounded-2xl border border-accent/30 bg-accent/10 px-5 py-4"
      >
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="pending-allocates-heading" className="font-semibold text-accent">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-accent/70">
            {body}
          </p>
          {/* D-448: the body promises the funds will show up by themselves, which a record under
              review cannot keep. Said once, not per row. */}
          {pending.some((p) => p.kind === "review") ? (
            <p className="mt-1 text-sm text-amber-300/80">{t.pendingAllocatesReviewNote}</p>
          ) : null}
          <ul className="mt-3 divide-y divide-accent/20">
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
                <RowDetail allocate={p} now={now} />
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
