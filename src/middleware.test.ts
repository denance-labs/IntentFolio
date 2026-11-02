import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

// The real coming-soon list is empty since the public opening (D-474; covered by
// coming-soon-domains.test.ts), so the redirect mechanism is exercised against a fake host.
vi.mock("@/features/landing/lib/coming-soon-domains", () => ({
  isComingSoonHost: (host: string | null | undefined) =>
    ["soon.example", "www.soon.example"].includes(host?.split(":")[0] ?? ""),
}));

const requestTo = (path: string, host: string) =>
  new NextRequest(new URL(path, `https://${host}`), { headers: { host } });

describe("middleware — /dashboard on coming-soon domains", () => {
  it("redirects /dashboard to / on a coming-soon domain", () => {
    const response = middleware(requestTo("/dashboard", "soon.example"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://soon.example/");
  });

  it("redirects a nested /dashboard route too", () => {
    const response = middleware(requestTo("/dashboard/composition", "www.soon.example"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://www.soon.example/");
  });

  it("lets /dashboard through on a host that is not coming-soon", () => {
    const response = middleware(requestTo("/dashboard", "intentfolio.app"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("lets /dashboard through on localhost", () => {
    const response = middleware(requestTo("/dashboard", "localhost:3000"));
    expect(response.status).toBe(200);
  });

  it("prefers x-forwarded-host over host", () => {
    const request = new NextRequest(new URL("/dashboard", "https://intentfolio.app"), {
      headers: { host: "internal-alias.vercel-internal", "x-forwarded-host": "soon.example" },
    });
    const response = middleware(request);
    expect(response.status).toBe(307);
  });
});
