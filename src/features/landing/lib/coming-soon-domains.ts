// Which hostnames serve the "coming soon" landing instead of the live app (D-245 follow-up).
//
// Empty since the public opening (D-474, 2026-10-12): every domain serves the live app.
// `intentfolio.app` is the canonical domain; `intentfolio.com` / `intentfolio.online` and the
// `www.` aliases redirect to it at the Vercel domain level, not here. The mechanism stays so a
// domain can be put back into coming-soon mode with one line, e.g. `"intentfolio.app"`.
// `staging.intentfolio.app`, Vercel preview/production aliases and localhost must never go in.
const COMING_SOON_HOSTS = new Set<string>([]);

export function isComingSoonHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const bareHost = host.split(":")[0]?.trim().toLowerCase();
  if (!bareHost) return false;
  return COMING_SOON_HOSTS.has(bareHost);
}
