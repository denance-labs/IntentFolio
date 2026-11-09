"use client";

import Link from "next/link";
import type { Route } from "next";

type Props = {
  href: Route<string>;
  label: string;
  className: string;
  comingSoon: boolean;
  soonBadge: string;
  soonSrLabel: string;
};

/**
 * The one "Open app" control, shared by nav/hero/closing sections so the coming-soon
 * treatment lives in a single place instead of three near-identical branches.
 */
export function AppCta({
  href,
  label,
  className,
  comingSoon,
  soonBadge,
  soonSrLabel,
}: Props) {
  if (comingSoon) {
    return (
      <span className="relative inline-flex">
        <span
          data-testid="app-cta-disabled"
          aria-disabled="true"
          className={`${className} cursor-not-allowed opacity-60`}
        >
          {label}
          <span className="sr-only"> ({soonSrLabel})</span>
        </span>
        <span
          aria-hidden="true"
          className="absolute -right-2 -top-2 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-950 shadow-sm"
        >
          {soonBadge}
        </span>
      </span>
    );
  }

  return (
    <Link href={href} className={className}>
      {label}
    </Link>
  );
}
