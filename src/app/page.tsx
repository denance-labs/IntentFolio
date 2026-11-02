import type { Metadata } from "next";
import { headers } from "next/headers";
import { profile } from "@/content/profile";
import { LandingPage } from "@/features/landing";
import { isComingSoonHost } from "@/features/landing/lib/coming-soon-domains";

const title = "IntentFolio — Build your portfolio, earn spread along the way";
const description =
  "Build your crypto portfolio with no fees, and earn spread along the way. Pick your mix and your portfolio moves toward it on its own. Incubated by Meta Pool.";

// The landing's own share preview: without it, openGraph/twitter fall back to the root
// layout's generic product description (Next replaces these objects, it does not merge them).
export const metadata: Metadata = {
  title,
  description,
  // Per page, never in the root layout: a root canonical would be inherited by every route
  // that does not override it and point them all at the home page (D-499).
  alternates: { canonical: "/" },
  openGraph: { title, description, type: "website", url: profile.siteUrl },
  twitter: { card: "summary_large_image", title, description },
};

// WebSite structured data: tells Google the site's name, so a search for the brand shows
// "IntentFolio" above the result instead of a guess from the domain (D-499).
const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: profile.productName,
  url: `${profile.siteUrl}/`,
};

// Which landing variant renders depends on the request's Host header (D-245 follow-up: hosts
// listed in coming-soon-domains.ts show "coming soon"; the list is empty since the public opening,
// D-474), so this page cannot be statically prerendered — same reasoning as
// tonconnect-manifest.json/route.ts.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const headersList = await headers();
  const host = headersList.get("x-forwarded-host") ?? headersList.get("host");
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
      />
      <LandingPage comingSoon={isComingSoonHost(host)} />
    </>
  );
}
