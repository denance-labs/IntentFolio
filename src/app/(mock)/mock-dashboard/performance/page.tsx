import type { Metadata } from "next";
import { PerformanceView } from "@/features/dashboard-shell/components/performance-view";

export const metadata: Metadata = { title: "Performance" };

export default function MockPerformancePage() {
  return <PerformanceView />;
}
