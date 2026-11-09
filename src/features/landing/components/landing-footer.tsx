"use client";

import { ExternalLink, Mail } from "lucide-react";
import { communityLinks } from "@/content/community-links";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";

// Brand marks as small inline SVGs: lucide-react has no Discord/Telegram/X glyphs
// and a few shapes don't justify a new icon dependency.
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

// Drawn here from plain shapes (D-549): the X mark, Instagram's camera outline and LinkedIn's "in".
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M3.5 3h5l12 18h-5z" fill="currentColor" />
      <path d="M20 3.2 13.6 10.4M10.4 13.6 4 20.8" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.3" cy="6.7" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="3" fill="currentColor" />
      <g fill="#151413">
        <rect x="5.6" y="9.6" width="3" height="8.8" />
        <circle cx="7.1" cy="6.6" r="1.75" />
        <path d="M10.7 9.6h2.9v1.3c.5-.9 1.6-1.5 3-1.5 2.3 0 3.4 1.4 3.4 4v5h-3v-4.5c0-1.2-.4-1.9-1.5-1.9s-1.8.8-1.8 2v4.4h-3z" />
      </g>
    </svg>
  );
}

/** A channel without a working link yet: shown, disabled, with a "Soon" pill. */
function SoonEntry({ icon, label, srLabel, soon }: { icon: React.ReactNode; label: string; srLabel: string; soon: string }) {
  return (
    <span role="img" aria-label={srLabel} className="inline-flex cursor-not-allowed items-center gap-1.5 text-sm text-bone-dim">
      {icon}
      {label}
      <span className="rounded-full border border-bone/20 px-1.5 py-px text-xs uppercase tracking-wide">{soon}</span>
    </span>
  );
}

// 44 px touch height under `sm`; the list's row gap drops there to keep the same rhythm.
const linkClass =
  "inline-flex min-h-11 items-center gap-1.5 sm:min-h-0 rounded text-sm text-bone-dim transition hover:text-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bone/70";

export function LandingFooter() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].footer;

  return (
    <footer className="border-t border-bone/10 py-8">
      <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row sm:justify-between gap-5 items-center">
        <p className="text-sm text-bone-dim">
          {t.powered}{" "}
          <a
            href="https://metapool.app"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-0.5 text-bone underline decoration-bone/30 underline-offset-4 transition hover:decoration-bone sm:min-h-0"
          >
            {t.metaPool}
            <ExternalLink size={12} aria-hidden="true" className="inline" />
          </a>
        </p>
        <div className="flex flex-col items-center sm:items-end gap-2">
          <nav aria-label={t.contactLabel}>
            <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-0 sm:gap-y-2">
              <li>
                {communityLinks.discord ? (
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
                ) : (
                  <SoonEntry icon={<DiscordIcon />} label={t.discord} srLabel={t.discordSrLabel} soon={t.soon} />
                )}
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
                  <SoonEntry icon={<TelegramIcon />} label={t.telegram} srLabel={t.telegramSrLabel} soon={t.soon} />
                )}
              </li>
              <li>
                <a
                  href={communityLinks.x}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t.x}
                  className={linkClass}
                >
                  <XIcon />
                  {t.x}
                </a>
              </li>
              <li>
                <a
                  href={communityLinks.instagram}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t.instagram}
                  className={linkClass}
                >
                  <InstagramIcon />
                  {t.instagram}
                </a>
              </li>
              <li>
                <a
                  href={communityLinks.linkedin}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t.linkedin}
                  className={linkClass}
                >
                  <LinkedInIcon />
                  {t.linkedin}
                </a>
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
          <p className="text-xs text-bone-dim">{t.disclaimer}</p>
        </div>
      </div>
    </footer>
  );
}
