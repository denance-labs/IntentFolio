import type { Metadata } from "next";
import type { ReactNode } from "react";
import { MockDashboardProviders } from "./mock-providers";
import { archivo } from "@/features/world/fonts";

export const metadata: Metadata = {
  title: {
    default: "Mock Dashboard",
    template: "%s | Mock Dashboard"
  },
  description: "QA-only mock dashboard for testing the deposit picker and balance display without a real wallet.",
  robots: { index: false, follow: false },
};

export default function MockDashboardLayout({ children }: { children: ReactNode }) {
  // D-571: the world's face, as in /dashboard's layout.
  return (
    <div className={archivo.variable}>
      <MockDashboardProviders>{children}</MockDashboardProviders>
    </div>
  );
}
