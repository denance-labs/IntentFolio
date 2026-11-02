import type { Metadata } from "next";
import type { ReactNode } from "react";
import { MockDashboardProviders } from "./mock-providers";

export const metadata: Metadata = {
  title: {
    default: "Mock Dashboard",
    template: "%s | Mock Dashboard"
  },
  description: "QA-only mock dashboard for testing the deposit picker and balance display without a real wallet.",
  robots: { index: false, follow: false },
};

export default function MockDashboardLayout({ children }: { children: ReactNode }) {
  return <MockDashboardProviders>{children}</MockDashboardProviders>;
}
