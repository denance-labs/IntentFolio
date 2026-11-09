"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { useLanguage } from "../context/language-context";
import { shellTranslations, type ShellTranslations } from "../lib/translations";

type SubNavLabelKey = keyof Pick<
  ShellTranslations,
  "subNavOverview" | "subNavComposition" | "subNavEvolution" | "subNavActivity" | "subNavPerformance"
>;

type SubNavEntry = { subpath: string; labelKey: SubNavLabelKey };

const SUBPATHS: SubNavEntry[] = [
  // D-518: a portfolio to look at first, before the tabs that edit or log it.
  { subpath: "overview",    labelKey: "subNavOverview"    as const },
  { subpath: "composition", labelKey: "subNavComposition" as const },
  // D-516: right after the split it shows how that split came to be.
  { subpath: "evolution",   labelKey: "subNavEvolution"   as const },
  { subpath: "activity",    labelKey: "subNavActivity"    as const },
  { subpath: "performance", labelKey: "subNavPerformance" as const },
  // No Settings tab (016 Q4): language moved to the wallet menu and the default band was
  // dropped, so it would be empty. Bring it back with real settings (rename/delete).
];

// 019-4 (D-393 Q2): on the New Portfolio Draft's tab the view is Composition whatever the
// route, and History and Performance stay in sight, disabled — there is nothing to show yet.
export function SubNav({ basePath = "/dashboard", draft = false }: { basePath?: string; draft?: boolean }) {
  const pathname = usePathname();
  const { lang } = useLanguage();
  const t = shellTranslations[lang];

  return (
    // D-562: sticky under the header and the portfolio strip, so switching sections on a long
    // view needs no scroll back up. Below the strip's z-30, so its tab menus open over it.
    <nav
      aria-label={t.subNavLabel}
      className="sticky top-[calc(var(--dashboard-header-h,0px)+var(--portfolio-strip-h,0px))] z-20 border-b border-slate-800 bg-slate-950"
    >
      <ul className="mx-auto flex max-w-7xl gap-1 overflow-x-auto whitespace-nowrap pl-4 pr-0 sm:pl-6 sm:pr-0">
        {SUBPATHS.map((item) => {
          const href = `${basePath}/${item.subpath}` as Route;
          const isComposition = item.subpath === "composition";
          if (draft && !isComposition) {
            return (
              <li key={href}>
                <span
                  aria-disabled="true"
                  // D-408: in sight but inert; the hint says why.
                  title={t.subNavDraftDisabledHint}
                  className="inline-flex cursor-not-allowed items-center justify-center border-b-2 border-transparent px-3 py-3 text-sm font-medium text-slate-600"
                >
                  {t[item.labelKey]}
                </span>
              </li>
            );
          }
          const isActive = draft ? isComposition : (pathname?.startsWith(href) ?? false);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={`inline-flex items-center justify-center px-3 py-3 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
                  isActive
                    ? "border-b-2 border-cyan-300 text-white"
                    : "border-b-2 border-transparent text-slate-400 hover:text-slate-100"
                }`}
              >
                  {t[item.labelKey]}
              </Link>
            </li>
          );
        })}
        {/* Trailing spacer so the last tab isn't clipped in overflow-x-auto */}
        <li aria-hidden="true" className="w-4 shrink-0 sm:w-6" />
      </ul>
    </nav>
  );
}
