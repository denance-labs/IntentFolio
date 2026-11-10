// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { appPortalRoot } from "./portal-root";

// D-571: portals land in the theme root, so they keep the app's face; <body> outside the app.

afterEach(() => {
  document.body.innerHTML = "";
});

describe("appPortalRoot", () => {
  it("is the app's theme root when the app is on the page", () => {
    const root = document.createElement("div");
    root.setAttribute("data-app-theme", "");
    document.body.append(root);
    expect(appPortalRoot()).toBe(root);
  });

  it("falls back to <body> outside the app", () => {
    expect(appPortalRoot()).toBe(document.body);
  });
});
