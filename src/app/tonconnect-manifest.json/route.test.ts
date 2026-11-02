import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GET } from "./route";
import { resolveOrigin } from "./resolve-origin";

const get = (headers: Record<string, string>) =>
  GET(new Request("https://ignored.example/tonconnect-manifest.json", { headers }));

describe("resolveOrigin", () => {
  it("prefers the forwarded host, which is what a managed host sends", () => {
    expect(
      resolveOrigin(
        new Headers({
          host: "internal-7f3a.vercel-internal",
          "x-forwarded-host": "staging.intentfolio.app",
          "x-forwarded-proto": "https",
        })
      )
    ).toBe("https://staging.intentfolio.app");
  });

  it("falls back to Host when nothing is forwarded", () => {
    expect(resolveOrigin(new Headers({ host: "intentfolio.app" }))).toBe("https://intentfolio.app");
  });

  it("assumes https for a public host with no forwarded scheme", () => {
    expect(resolveOrigin(new Headers({ host: "app.example.com" }))).toBe("https://app.example.com");
  });

  // Only loopback gets http. TON login cannot work here at all — Tonkeeper rejects localhost as
  // a manifest host under any scheme (D-245, measured against https://localhost:3443) — but
  // producing `https://localhost:3000` would be a lie about the running server.
  it.each(["localhost:3000", "127.0.0.1:3100", "[::1]:3000", "LOCALHOST:3100"])(
    "uses http for loopback host %s",
    (host) => {
      expect(resolveOrigin(new Headers({ host }))).toMatch(/^http:\/\//);
    }
  );

  it("takes the first value when a proxy chain appends to x-forwarded-proto", () => {
    expect(
      resolveOrigin(new Headers({ host: "intentfolio.app", "x-forwarded-proto": "https, http" }))
    ).toBe("https://intentfolio.app");
  });

  it("returns null when there is no host to derive from", () => {
    expect(resolveOrigin(new Headers())).toBeNull();
    expect(resolveOrigin(new Headers({ host: "   " }))).toBeNull();
  });
});

describe("GET /tonconnect-manifest.json", () => {
  // The invariant the whole route exists for: Tonkeeper compares `url` against the origin it
  // is connecting to and shows an anti-phishing block when they differ. If this ever returns a
  // constant, TON login breaks on every origin except that one.
  it("declares the serving origin as `url`, whatever that origin is", async () => {
    for (const host of ["staging.intentfolio.app", "intentfolio.app", "preview-abc.vercel.app"]) {
      const body = await (await get({ host })).json();
      expect(body.url).toBe(`https://${host}`);
      expect(body.iconUrl).toBe(`https://${host}/icon-192.png`);
    }
  });

  it("names the product and points the icon at a PNG that exists in public/", async () => {
    const body = await (await get({ host: "intentfolio.app" })).json();
    expect(body.name).toBe("IntentFolio");
    // The path is asserted here; `public/icon-192.png` being present is asserted below.
    expect(body.iconUrl.endsWith("/icon-192.png")).toBe(true);
  });

  it("is CORS-readable, as the TonConnect spec requires", async () => {
    const res = await get({ host: "intentfolio.app" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("varies on the host, so a shared cache cannot serve one origin's manifest to another", async () => {
    const res = await get({ host: "intentfolio.app" });
    expect(res.headers.get("vary")?.toLowerCase()).toContain("host");
  });

  // Fail closed: a wrong `url` triggers the anti-phishing block, which is much harder to
  // diagnose than a missing manifest.
  // The other half of D-245: the old manifest pointed at an icon that was never in the repo.
  // A 404 icon is not cosmetic — TonConnect requires the manifest icon to resolve.
  it("has the icon it advertises, as a real 192x192 PNG", () => {
    const png = readFileSync("public/icon-192.png");
    // PNG signature, then the IHDR width/height as big-endian uint32s.
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(192);
    expect(png.readUInt32BE(20)).toBe(192);
  });

  it("returns 500 rather than guessing a domain when the host is unknown", async () => {
    // Verified: `new Request` does not synthesise a Host header, so this reaches the branch.
    const req = new Request("https://ignored.example/tonconnect-manifest.json");
    expect(req.headers.get("host")).toBeNull();

    const res = await GET(req);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/origin/i);
  });
});
