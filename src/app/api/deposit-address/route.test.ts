import { afterEach, describe, expect, it, vi } from "vitest";

const resolveDepositAddressDb = vi.fn();
vi.mock("@/features/vault/lib/ops-db-pool", () => ({ resolveDepositAddressDb: (env: unknown) => resolveDepositAddressDb(env) }));

import { GET } from "./route";

const req = (q: string) => new Request(`https://x.test/api/deposit-address?${q}`, { headers: { "x-forwarded-for": "9.9.9.9" } });
const SET = [{ blockchain: "eth", address: "0x00000000000000000000000000000000000000e1" }];

afterEach(() => vi.clearAllMocks());

describe("GET /api/deposit-address", () => {
  it("answers 503 and no address when the database is not configured", async () => {
    resolveDepositAddressDb.mockReturnValue({ ok: false, issues: ["missing"] });
    const res = await GET(req("account=alice.near&chain=eth:1"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "not-configured" });
  });

  it("answers 503 and no address when the database throws", async () => {
    resolveDepositAddressDb.mockReturnValue({ ok: true, db: { query: vi.fn().mockRejectedValue(new Error("permission denied")) } });
    const res = await GET(req("account=alice.near&chain=eth:1"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, code: "unavailable" });
    expect(body).not.toHaveProperty("address");
  });

  it("serves a stored address uncached", async () => {
    resolveDepositAddressDb.mockReturnValue({ ok: true, db: { query: vi.fn().mockResolvedValue({ rows: [{ chain_addresses: SET }], rowCount: 1 }) } });
    const res = await GET(req("account=alice.near&chain=eth:1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, address: SET[0].address });
  });
});
