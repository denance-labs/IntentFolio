import type { Metadata } from "next";
import { LearnPage } from "@/features/learn";
import { learnTranslations } from "@/features/learn/lib/translations";
import { alt as ogImageAlt, size as ogImageSize } from "../opengraph-image";

// Static metadata is server-rendered in the default locale (en); the page body itself
// localizes at runtime from the language context.
const shareTitle = `${learnTranslations.en.meta.title} | IntentFolio`;
// This page's own openGraph replaces the root one, so the shared image and URL have to be
// named here or the link preview loses them (D-473). Same image as the landing.
const shareImage = { url: "/opengraph-image", ...ogImageSize, alt: ogImageAlt };

export const metadata: Metadata = {
  title: learnTranslations.en.meta.title,
  description: learnTranslations.en.meta.description,
  alternates: { canonical: "/learn" },
  openGraph: {
    title: shareTitle,
    description: learnTranslations.en.meta.description,
    type: "article",
    url: "/learn",
    images: [shareImage],
  },
  twitter: {
    card: "summary_large_image",
    title: shareTitle,
    description: learnTranslations.en.meta.description,
    images: [shareImage],
  },
};

// FAQPage structured data so the guide's Q&A can surface as rich results. Built from
// the same English copy the page renders, so the two never disagree.
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: learnTranslations.en.faq.items.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

export default function LearnRoute() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <LearnPage />
    </>
  );
}
