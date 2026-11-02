// Blocks direct navigation to /dashboard on any host in "coming soon" mode (D-245 follow-up). The
// landing CTAs already render disabled there (src/app/page.tsx), but a visitor who bookmarks or
// types /dashboard would otherwise reach the live app anyway — this closes that path with a
// redirect back to "/". The coming-soon list is empty since the public opening (D-474), so today
// this lets every request through.
//
// staging.intentfolio.app, Vercel preview/production aliases and localhost are never in the
// coming-soon list (see coming-soon-domains.ts), so this never touches the team-testing origin.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isComingSoonHost } from "@/features/landing/lib/coming-soon-domains";

export function middleware(request: NextRequest) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (isComingSoonHost(host)) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
