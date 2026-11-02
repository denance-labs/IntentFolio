import type { Metadata } from "next";
import { OverviewView } from "@/features/dashboard-shell/components/overview-view";

export const metadata: Metadata = { title: "Overview" };

export default function MockOverviewPage() {
  return <OverviewView basePath="/mock-dashboard" />;
}
