import type { Metadata } from "next";
import { HistoryView } from "@/features/dashboard-shell/components/history-view";

export const metadata: Metadata = {
  title: "Activity",
  description: "Audit trail of portfolio events: deposits, withdrawals, and solver rebalances with before/after composition."
};

export default function HistoryPage() {
  return <HistoryView />;
}
