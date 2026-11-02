"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";

type LogoFit = "full" | "name" | "mark";

/**
 * The app icon (`src/app/icon.svg`), inline so it needs no request. D-502: the donut around a
 * target dot, as explicit filled paths (no `pathLength` dashes, which rasterizers drop) so it
 * matches `favicon.ico` and `apple-icon.png`. Keep it in sync with `icon.svg`.
 */
function AppMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="7" fill="#0B1220" />
      <path d="M17.2 3.056A13 13 0 0 1 24.579 25.767L21.62 21.694A8 8 0 0 0 17.2 8.091Z" fill="#22D3EE" />
      <path d="M22.638 27.178A13 13 0 0 1 3.308 18.813L8.303 18.182A8 8 0 0 0 19.678 23.104Z" fill="#34D399" />
      <path d="M3.007 16.432A13 13 0 0 1 14.8 3.056L14.8 8.091A8 8 0 0 0 8.002 15.801Z" fill="#A78BFA" />
      <circle cx="16" cy="16" r="3.5" fill="#F8FAFC" />
    </svg>
  );
}

function Wordmark({ withDomain }: { withDomain: boolean }) {
  return (
    <span className="flex items-baseline gap-0.5 whitespace-nowrap">
      <span className="bg-gradient-to-r from-white to-cyan-300 bg-clip-text text-lg font-semibold tracking-tight text-transparent">
        IntentFolio
      </span>
      {withDomain && <span className="text-xs font-normal text-slate-400">.app</span>}
    </span>
  );
}

/**
 * The header's logo in three sizes (022-J, D-460): "IntentFolio.app", then "IntentFolio", then
 * the app icon alone. It takes the room the header's right side leaves and shows the largest
 * that fits — measured, not by breakpoint, since that room depends on the language and on the
 * wallet's name. Before this, the wordmark was cut to "I…" at 390 with a wallet.
 */
export function HeaderLogo({ home }: { home: boolean }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLSpanElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  // The server renders the full logo; the measure runs before the first paint.
  const [fit, setFit] = useState<LogoFit>("full");

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const full = fullRef.current;
    const name = nameRef.current;
    if (!slot || !full || !name || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const room = slot.clientWidth;
      setFit(full.offsetWidth <= room ? "full" : name.offsetWidth <= room ? "name" : "mark");
    };
    // The measured copies too: their width changes when the web font arrives.
    const observer = new ResizeObserver(update);
    for (const el of [slot, full, name]) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const logo: ReactNode =
    fit === "mark" ? (
      <>
        <AppMark size={28} />
        <span className="sr-only">IntentFolio.app</span>
      </>
    ) : (
      <Wordmark withDomain={fit === "full"} />
    );

  return (
    <div ref={slotRef} className="relative flex min-w-0 flex-1 items-center">
      {/* Off-screen copies at their natural width, to know which one fits. */}
      <span aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0">
        <span ref={fullRef} className="inline-block">
          <Wordmark withDomain />
        </span>
        <span ref={nameRef} className="absolute left-0 top-0 inline-block">
          <Wordmark withDomain={false} />
        </span>
      </span>
      {/* D-408: signed out, the header had no way back to the home page — the guide lived only
          in the wallet menu, which exists once connected. The logo links home then. Signed in
          it stays inert: a same-tab click would leave the editor mid-edit. */}
      {home ? (
        <Link
          href="/"
          className="flex items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        >
          {logo}
        </Link>
      ) : (
        <span className="flex items-center">{logo}</span>
      )}
    </div>
  );
}
