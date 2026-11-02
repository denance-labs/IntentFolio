import type { Metadata } from "next";
import { PerformanceView } from "@/features/dashboard-shell/components/performance-view";

export const metadata: Metadata = {
  title: "Performance",
  description: "Portfolio value over time, earned spread from external rebalances, and benchmark comparison."
};

export default function PerformancePage() {
  return <PerformanceView />;
}
