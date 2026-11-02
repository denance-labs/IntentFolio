import type { Metadata } from "next";
import { EvolutionView } from "@/features/dashboard-shell/components/evolution-view";

export const metadata: Metadata = {
  title: "Evolution",
  description: "How the portfolio's value was split between its tokens, day by day."
};

export default function EvolutionPage() {
  return <EvolutionView />;
}
