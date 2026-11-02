"use client";

import { ExternalLink, Mail } from "lucide-react";
import { communityLinks } from "@/content/community-links";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";

// Brand marks as small inline SVGs: lucide-react has no Discord/Telegram glyphs
// and two shapes don't justify a new icon dependency.
function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M20.32 4.37A19.8 19.8 0 0 0 15.43 2.85l-.23.46a18.3 18.3 0 0 0-6.4 0l-.23-.46A19.8 19.8 0 0 0 3.68 4.37C.6 8.98-.24 13.47.18 17.9a19.9 19.9 0 0 0 6.01 3.04l1.3-2.1a12.9 12.9 0 0 1-2.05-.98l.5-.4a14.2 14.2 0 0 0 12.12 0l.5.4c-.65.39-1.34.72-2.05.98l1.3 2.1a19.9 19.9 0 0 0 6.01-3.04c.5-5.14-.85-9.58-3.5-13.53ZM8.52 15.17c-1.18 0-2.15-1.08-2.15-2.4s.95-2.4 2.15-2.4 2.17 1.08 2.15 2.4c0 1.32-.95 2.4-2.15 2.4Zm6.96 0c-1.18 0-2.15-1.08-2.15-2.4s.95-2.4 2.15-2.4 2.17 1.08 2.15 2.4c0 1.32-.95 2.4-2.15 2.4Z" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M21.94 4.1 18.72 19.3c-.24 1.07-.87 1.33-1.76.83l-4.86-3.58-2.35 2.26c-.26.26-.48.48-.98.48l.35-4.96 9.02-8.15c.39-.35-.09-.54-.61-.19L6.38 12.99 1.58 11.5c-1.04-.33-1.06-1.04.22-1.54l18.76-7.23c.87-.32 1.63.2 1.38 1.37Z" />
    </svg>
  );
}

const linkClass =
  "inline-flex items-center gap-1.5 rounded text-sm text-slate-300 hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400";

export function LandingFooter() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].footer;

  return (
    <footer className="border-t border-slate-800 bg-slate-950 py-8">
      <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row sm:justify-between gap-5 items-center">
        <p className="text-sm text-slate-400">
          {t.powered}{" "}
          <a
            href="https://metapool.app"
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-0.5"
          >
            {t.metaPool}
            <ExternalLink size={12} aria-hidden="true" className="inline" />
          </a>
        </p>
        <div className="flex flex-col items-center sm:items-end gap-2">
          <nav aria-label={t.contactLabel}>
            <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
              <li>
                <a
                  href={communityLinks.discord}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t.discord}
                  className={linkClass}
                >
                  <DiscordIcon />
                  {t.discord}
                </a>
              </li>
              <li>
                {communityLinks.telegram ? (
                  <a
                    href={communityLinks.telegram}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t.telegram}
                    className={linkClass}
                  >
                    <TelegramIcon />
                    {t.telegram}
                  </a>
                ) : (
                  <span
                    role="img"
                    aria-label={t.telegramSrLabel}
                    className="inline-flex cursor-not-allowed items-center gap-1.5 text-sm text-slate-400"
                  >
                    <TelegramIcon />
                    {t.telegram}
                    <span className="rounded-full border border-slate-700 px-1.5 py-px text-[10px] uppercase tracking-wide">
                      {t.telegramSoon}
                    </span>
                  </span>
                )}
              </li>
              <li>
                <a
                  href={`mailto:${communityLinks.email}`}
                  aria-label={`${t.email}: ${communityLinks.email}`}
                  className={linkClass}
                >
                  <Mail size={16} aria-hidden="true" />
                  {t.email}
                </a>
              </li>
            </ul>
          </nav>
          <p className="text-xs text-slate-400">{t.disclaimer}</p>
        </div>
      </div>
    </footer>
  );
}
