import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StockTestPanel } from "@/features/stocks/components/stock-test-panel";
import { STOCK_TEST_ENABLED } from "@/features/stocks/lib/stock-swap";

export const metadata: Metadata = {
  title: "Cambiar tokens (prueba)",
  robots: { index: false, follow: false },
};

// The operator's screen (plan 039). Without the flag this route does not exist. It lives outside
// /dashboard on purpose: DashboardShell only renders its children for an account that has a
// portfolio, and shows My Account otherwise. The wallet providers come from the root layout.
export default function StocksTestPage() {
  if (!STOCK_TEST_ENABLED) notFound();
  return <StockTestPanel />;
}
