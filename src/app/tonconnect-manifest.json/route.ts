// GET /tonconnect-manifest.json — the file Tonkeeper reads before it will show the approval
// screen (008.plan, D-245).
//
// WHY THIS IS A ROUTE AND NOT A FILE IN `public/`. Tonkeeper refuses to connect unless
// `manifest.url` is byte-identical to the origin actually serving the dapp; when they differ it
// shows an anti-phishing block ("the dApp with the real domain X is trying to authorise itself
// as Y") instead of connecting. A static file hardcodes one origin, so every origin that is not
// that one — a preview deployment, a staging subdomain, the production domain before the DNS
// moves — silently loses TON login. Deriving the origin from the request means the manifest is
// correct wherever it is served, and there is no second place to keep in sync.
//
// The failure this replaces was real and lasted months: the manifest declared
// `https://intentfolio.app` while the app ran anywhere else, and `iconUrl` pointed at an
// `icon-192.png` that did not exist in `public/` at all (D-245, verified 2026-08-09).
//
// WHO ACTUALLY FETCHES THIS. Not the browser: Tonkeeper hands the URL to `c.tonapi.io`, which
// fetches it server-to-server (measured by decoding the base64 in its 404). Two consequences —
// the origin must be publicly reachable over HTTPS (no localhost, no WAF challenge, no login),
// and CORS is not in that path but is still required by the spec for clients that do fetch it
// directly, hence the header below.

import { NextResponse } from "next/server";
import { resolveOrigin } from "./resolve-origin";

// Depends on the request's Host header, so it must never be statically generated at build time:
// a prerendered manifest would bake in whatever host the build machine reported.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = resolveOrigin(request.headers);

  // Fail closed rather than fall back to a hardcoded domain. A manifest with the wrong `url`
  // does not degrade — it triggers the anti-phishing block, which reads to the user as "this
  // app is impersonating someone" and is far harder to diagnose than a missing manifest.
  if (origin === null) {
    return NextResponse.json(
      { error: "Cannot determine the request origin, so no valid manifest can be produced." },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      url: origin,
      name: "IntentFolio",
      iconUrl: `${origin}/icon-192.png`,
    },
    {
      headers: {
        // Required by the TonConnect spec for clients that fetch the manifest from the page
        // context. Tonkeeper's own path (via c.tonapi.io) is server-to-server and never sees
        // this, which is why the header being present was not enough to make TON work (D-244).
        "Access-Control-Allow-Origin": "*",
        // The origin is part of the response, so a shared cache must key on the host.
        Vary: "x-forwarded-host, host",
      },
    }
  );
}
