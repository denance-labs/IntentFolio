import type { Metadata } from "next";
import { PortfolioEditorLatest } from "@/features/portfolio-editor/components/portfolio-editor-latest";

export const metadata: Metadata = {
  title: "Composition",
  description: "Define your target allocation per token and tolerance bands for the active portfolio."
};

export default function CompositionPage() {
  return <PortfolioEditorLatest />;
}
