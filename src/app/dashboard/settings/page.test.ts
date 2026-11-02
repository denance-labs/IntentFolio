import { describe, it, expect, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect }));

import SettingsPage from "./page";
import MockSettingsPage from "../../(mock)/mock-dashboard/settings/page";

// 016 Q4: the Settings tab is hidden; an old link or bookmark must land on Overview, the
// default tab (D-518), instead of a 404 or an empty page.
describe("/settings routes", () => {
  it("redirects the real dashboard to Overview", () => {
    SettingsPage();
    expect(redirect).toHaveBeenLastCalledWith("/dashboard/overview");
  });

  it("redirects the mock dashboard to its own Overview", () => {
    MockSettingsPage();
    expect(redirect).toHaveBeenLastCalledWith("/mock-dashboard/overview");
  });
});
