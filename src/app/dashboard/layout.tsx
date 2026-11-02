import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DashboardShell } from "@/features/dashboard-shell";

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
  return <DashboardShell>{children}</DashboardShell>;
}
