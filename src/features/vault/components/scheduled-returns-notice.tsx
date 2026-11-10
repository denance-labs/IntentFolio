"use client";

// My Account notice for funds the vault is sending back to the General Balance (D-302 h2):
// a scheduled Return, e.g. a credit that landed on a portfolio deleted in the meantime. Those
// funds have left every balance the user can see and only reappear when the timelock runs
// out, so without this they would look lost for up to a week. Informational only: no
// actions, nothing written.
//
// Placed right after the pending-allocates notice and styled like it — both answer "where
// are those funds?". A <section>, not a live region, for the same reason as that one: it is
// present on arrival, and re-announcing it on every refetch would repeat the same news.

import { useEffect, useState } from "react";
import { Undo2 } from "lucide-react";
import { getTokenById } from "@/features/market/lib/token-registry";
import { formatCrypto } from "@/features/portfolio-editor/lib/format";
import type { Language } from "@/features/portfolio-editor/types";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { shellTranslations } from "@/features/dashboard-shell/lib/translations";
import { scheduledReturnsReadable, useScheduledReturns } from "../hooks/use-scheduled-returns";
import { fromBaseUnits } from "../lib/base-units";
import type { ReturnView } from "../lib/vault-read-client";

function truncateId(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 10)}…${id.slice(-4)}`;
}

/**
 * The amount in human units. `token` is already a registry id (the read client translates
 * it). Same rule as the pending-allocates legs: a token the registry does not know shows its
 * id and no amount — without its decimals the base units would be off by orders of magnitude.
 */
function amountLabel(r: ReturnView): string {
  const token = getTokenById(r.token);
  if (!token) return truncateId(r.token);
  let qty: number;
  try {
    qty = fromBaseUnits(BigInt(r.amount), token.decimals);
  } catch {
    return token.symbol;
  }
  return `${formatCrypto(qty)} ${token.symbol}`;
}

/** The arrival day, in the UI language (same locales as the history view). */
export function formatReturnDate(etaSecs: number, lang: Language): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-AR" : "en-US", {
    day: "numeric",
    month: "long",
  }).format(new Date(etaSecs * 1000));
}

const MINUTE_MS = 60_000;

type Props = { accountId: string | null | undefined };

/**
 * Renders nothing on a build that cannot read Returns (flag off, or no vault). The gate is
 * a build-time constant, so the inner component — and its query — is either always mounted
 * or never, which keeps the hook order stable.
 */
export function ScheduledReturnsNotice({ accountId }: Props) {
  if (!scheduledReturnsReadable() || !accountId) return null;
  return <ScheduledReturnsList accountId={accountId} />;
}

function ScheduledReturnsList({ accountId }: { accountId: string }) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { returns } = useScheduledReturns(accountId);

  // An eta can pass while the page is open; the row then switches from its date to "soon".
  // Once a minute is plenty for a timelock measured in days.
  const [now, setNow] = useState(() => Date.now());
  const visible = !!returns && returns.length > 0;
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, [visible]);

  if (!visible) return null;

  return (
    <section
      aria-labelledby="scheduled-returns-heading"
      className="flex items-start gap-3 rounded-2xl border border-accent/30 bg-accent/10 px-5 py-4"
    >
      <Undo2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 id="scheduled-returns-heading" className="font-semibold text-accent">
          {t.scheduledReturnsTitle}
        </h2>
        <p className="mt-0.5 text-sm text-accent/70">{t.scheduledReturnsBody}</p>
        <ul className="mt-3 divide-y divide-accent/20">
          {returns.map((r) => {
            const amount = amountLabel(r);
            // Past its eta but still listed (not executed yet), or being executed right now:
            // a date in the past would read as "late", so it says "soon" instead.
            const soon = r.executing || r.eta * 1000 <= now;
            if (soon) {
              return (
                <li key={r.id} className="py-2 text-sm text-slate-100 first:pt-0 last:pb-0">
                  <span className="tabular-nums">
                    {t.scheduledReturnArrivesSoon.replace("{amount}", amount)}
                  </span>
                </li>
              );
            }
            // Split around {date} so the date sits in a <time> with a machine-readable value.
            const [before, after = ""] = t.scheduledReturnArrivesOn.split("{date}");
            return (
              <li key={r.id} className="py-2 text-sm text-slate-100 first:pt-0 last:pb-0">
                <span className="tabular-nums">{before.replace("{amount}", amount)}</span>
                <time dateTime={new Date(r.eta * 1000).toISOString()} className="whitespace-nowrap">
                  {formatReturnDate(r.eta, lang)}
                </time>
                {after.replace("{amount}", amount)}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
