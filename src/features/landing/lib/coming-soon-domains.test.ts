import { describe, expect, it } from "vitest";
import { isComingSoonHost } from "./coming-soon-domains";

describe("isComingSoonHost", () => {
  // D-474: the public domains opened on 2026-10-12, so none of them is coming-soon anymore.
  it.each([
    "intentfolio.app",
    "www.intentfolio.app",
    "intentfolio.com",
    "www.intentfolio.com",
    "intentfolio.online",
    "www.intentfolio.online",
    "INTENTFOLIO.APP",
    "intentfolio.app:443",
  ])("does not flag the public domain %s", (host) => {
    expect(isComingSoonHost(host)).toBe(false);
  });

  it("does not flag the staging team-testing subdomain", () => {
    expect(isComingSoonHost("staging.intentfolio.app")).toBe(false);
  });

  it("does not flag localhost or a Vercel preview/production alias", () => {
    expect(isComingSoonHost("localhost:3000")).toBe(false);
    expect(isComingSoonHost("portfolio-frontend-fb3mr99bw-pablozavis-projects.vercel.app")).toBe(
      false
    );
  });

  it("returns false for null/undefined/empty host", () => {
    expect(isComingSoonHost(null)).toBe(false);
    expect(isComingSoonHost(undefined)).toBe(false);
    expect(isComingSoonHost("")).toBe(false);
    expect(isComingSoonHost("   ")).toBe(false);
  });
});
