// Colocated with the route that uses it because a Next.js `route.ts` may only export the HTTP
// handlers and its config — exporting a helper from there fails the build's route type check.

/**
 * The origin that served this request, as the wallet will see it.
 *
 * `x-forwarded-*` first because every managed host (Vercel, Netlify, a reverse proxy on a VPS)
 * terminates TLS ahead of the app and passes the public host that way; `host` is the direct
 * case. The scheme is only assumed for loopback, where TON login cannot work anyway — that
 * assumption is what D-245 measured: Tonkeeper rejects `localhost` as a manifest host under
 * any scheme, `https://localhost:3443` included.
 */
export function resolveOrigin(headers: Headers): string | null {
  const host = headers.get("x-forwarded-host")?.trim() || headers.get("host")?.trim();
  if (!host) return null;

  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const proto = forwardedProto || (isLoopback ? "http" : "https");

  return `${proto}://${host}`;
}
