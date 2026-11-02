import type { Metadata } from "next";
import { PortfolioEditorLatest } from "@/features/portfolio-editor/components/portfolio-editor-latest";

export const metadata: Metadata = { title: "Composition" };

export default function MockCompositionPage() {
  return <PortfolioEditorLatest />;
}
