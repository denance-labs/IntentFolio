import type { Metadata } from "next";
import { EvolutionView } from "@/features/dashboard-shell/components/evolution-view";

export const metadata: Metadata = { title: "Evolution" };

export default function MockEvolutionPage() {
  return <EvolutionView />;
}
