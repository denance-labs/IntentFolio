// Two jobs, both on the app's routes only, so the landing and /learn stay static:
//
// 1. Blocks direct navigation to /dashboard on any host in "coming soon" mode (D-245 follow-up).
//    The landing CTAs already render disabled there (src/app/page.tsx), but a visitor who bookmarks
//    or types /dashboard would otherwise reach the live app anyway — this closes that path with a
//    redirect back to "/". The coming-soon list is empty since the public opening (D-474), so today
//    this lets every request through. staging.intentfolio.app, Vercel preview/production aliases
//    and localhost are never in the coming-soon list (see coming-soon-domains.ts), so this never
//    touches the team-testing origin.
// 2. D-569: keeps the visitor's country, from Vercel's `x-vercel-ip-country`, in a cookie the page
//    reads to know whether stocks can be bought (stock-region.ts). Without the header nothing is
//    written, so a cookie set by hand for testing stays.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isComingSoonHost } from "@/features/landing/lib/coming-soon-domains";
import { COUNTRY_COOKIE, normalizeCountry } from "@/features/stocks/lib/stock-region";

const COUNTRY_COOKIE_MAX_AGE_S = 60 * 60 * 24;

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/dashboard")) {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (isComingSoonHost(host)) {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }
  const response = NextResponse.next();
  const country = normalizeCountry(request.headers.get("x-vercel-ip-country"));
  if (country !== null && request.cookies.get(COUNTRY_COOKIE)?.value !== country) {
    response.cookies.set(COUNTRY_COOKIE, country, {
      path: "/",
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      maxAge: COUNTRY_COOKIE_MAX_AGE_S,
    });
  }
  return response;
}

export const config = {
  matcher: ["/dashboard/:path*", "/stocks-test"],
};
