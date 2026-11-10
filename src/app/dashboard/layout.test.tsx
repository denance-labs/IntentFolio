import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/features/dashboard-shell", () => ({ DashboardShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
// next/font only runs inside Next; the layout only needs the CSS variable's class name.
vi.mock("@/features/world/fonts", () => ({ archivo: { variable: "font-archivo-var" } }));

import DashboardLayout from "./layout";

describe("dashboard layout without JavaScript (D-566b)", () => {
  it("tells the visitor in both languages that the app needs JavaScript", () => {
    const html = renderToString(<DashboardLayout>x</DashboardLayout>);
    expect(html).toContain("<noscript>");
    expect(html).toContain("IntentFolio needs JavaScript");
    expect(html).toContain("IntentFolio necesita JavaScript");
    expect(html).toContain('href="/"');
  });
});
