import type { Metadata } from "next";
import { HistoryView } from "@/features/dashboard-shell/components/history-view";

export const metadata: Metadata = { title: "Activity" };

export default function MockHistoryPage() {
  return <HistoryView />;
}
