import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { DashboardShell } from "@/features/dashboard-shell";
import { noJavaScriptNotice } from "@/content/no-javascript";
import { archivo } from "@/features/world/fonts";

export const metadata: Metadata = {
  title: {
    default: "Dashboard",
    template: "%s | IntentFolio"
  },
  description: "Manage portfolios on the Meta Pool shared pool: composition, history, performance and settings.",
  // The app behind a wallet: nothing here is useful as a search result, and the landing is
  // the page that should rank for the brand (D-499). Links stay followable.
  robots: { index: false, follow: true }
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <noscript>
        <div role="alert" className="mx-auto max-w-xl px-6 py-10 text-center">
          {(["en", "es"] as const).map((lang) => (
            <section key={lang} lang={lang} className="mb-6">
              <h1 className="text-lg font-semibold text-slate-100">{noJavaScriptNotice[lang].title}</h1>
              <p className="mt-2 text-sm text-slate-300">{noJavaScriptNotice[lang].body}</p>
            </section>
          ))}
          <Link href="/" className="text-sm text-accent underline">
            {noJavaScriptNotice.en.back} / {noJavaScriptNotice.es.back}
          </Link>
        </div>
      </noscript>
      {/* D-571: the world's face; the shell sets font-world on its root. */}
      <div className={archivo.variable}>
        <DashboardShell>{children}</DashboardShell>
      </div>
    </>
  );
}
