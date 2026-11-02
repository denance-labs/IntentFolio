import type { Metadata } from "next";
import { OverviewView } from "@/features/dashboard-shell/components/overview-view";

export const metadata: Metadata = {
  title: "Overview",
  description: "Your portfolio at a glance: value, how much is already in its target mix, current and target composition, and what it earned."
};

export default function OverviewPage() {
  return <OverviewView />;
}
