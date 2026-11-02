import { describe, it, expect } from "vitest";
import sitemap from "./sitemap";

// D-499: only the public pages go to search engines; the app (/dashboard) is noindex.
describe("sitemap", () => {
  it("lists the landing and the guide, and nothing under /dashboard", () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual(["https://intentfolio.app", "https://intentfolio.app/learn"]);
  });
});
