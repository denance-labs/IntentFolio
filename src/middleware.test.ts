import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { COUNTRY_COOKIE } from "@/features/stocks/lib/stock-region";
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

// D-569: the visitor's country, kept where the page can read it to know whether stocks can be bought.
describe("middleware — the visitor's country (D-569)", () => {
  const visit = (path: string, { country, cookie }: { country?: string; cookie?: string } = {}) => {
    const headers: Record<string, string> = { host: "intentfolio.app" };
    if (country) headers["x-vercel-ip-country"] = country;
    if (cookie) headers.cookie = cookie;
    return middleware(new NextRequest(new URL(path, "https://intentfolio.app"), { headers }));
  };

  it("keeps the country Vercel reports in a cookie the page can read", () => {
    const cookie = visit("/dashboard", { country: "US" }).cookies.get(COUNTRY_COOKIE);
    expect(cookie?.value).toBe("US");
    expect(cookie?.httpOnly).toBeFalsy();
    expect(cookie?.path).toBe("/");
    expect(cookie?.secure).toBe(true);
  });

  it("does it on a nested route and on /stocks-test too", () => {
    expect(visit("/dashboard/composition", { country: "CA" }).cookies.get(COUNTRY_COOKIE)?.value).toBe("CA");
    expect(visit("/stocks-test", { country: "US" }).cookies.get(COUNTRY_COOKIE)?.value).toBe("US");
  });

  it("writes nothing without the header, so a cookie set by hand stays", () => {
    expect(visit("/dashboard", { cookie: `${COUNTRY_COOKIE}=US` }).cookies.get(COUNTRY_COOKIE)).toBeUndefined();
  });

  it("does not write it again when it already says the same", () => {
    expect(visit("/dashboard", { country: "US", cookie: `${COUNTRY_COOKIE}=US` }).cookies.get(COUNTRY_COOKIE)).toBeUndefined();
  });

  it("updates it when the visitor shows up from another country", () => {
    expect(visit("/dashboard", { country: "AR", cookie: `${COUNTRY_COOKIE}=US` }).cookies.get(COUNTRY_COOKIE)?.value).toBe("AR");
  });

  it("ignores a header that is not a country code", () => {
    expect(visit("/dashboard", { country: "USA" }).cookies.get(COUNTRY_COOKIE)).toBeUndefined();
  });

  it("never redirects /stocks-test, even on a coming-soon domain", () => {
    const response = middleware(requestTo("/stocks-test", "soon.example"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});
