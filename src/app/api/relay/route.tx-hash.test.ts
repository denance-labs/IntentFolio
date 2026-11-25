// The relay notes a withdrawal's hash without waiting for it, and only where withdrawal records are
// on (D-593). What it writes is withdraw-relay-tx-hash.test.ts's subject; here only the wiring is.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

type NoteInput = { payload: unknown; response: unknown; resolveDb: () => unknown };

const { afterTasks, afterThrows, flag, handled, note, resolveOpsDb } = vi.hoisted(() => ({
  afterTasks: [] as unknown[],
  afterThrows: { current: false },
  flag: { enabled: true },
  handled: { current: null as unknown },
  note: vi.fn<(input: NoteInput) => Promise<void>>(),
  resolveOpsDb: vi.fn(() => ({ ok: false, issues: [] })),
}));

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: (task: unknown) => {
    if (afterThrows.current) throw new Error("no waitUntil");
    afterTasks.push(task);
  },
}));
vi.mock("@/features/bridge/lib/withdraw-records-flag", () => ({
  get WITHDRAW_RECORDS_ENABLED() {
    return flag.enabled;
  },
}));
vi.mock("@/features/bridge/lib/withdraw-relay-tx-hash", () => ({ noteRelayedTxHash: note }));
vi.mock("@/features/vault/lib/ops-db-pool", () => ({ resolveOpsDb }));
vi.mock("@/features/vault/lib/relay-service", async (original) => ({
  ...(await original<typeof import("@/features/vault/lib/relay-service")>()),
  handleRelayRequest: async () => handled.current,
}));
vi.mock("near-api-js", async (original) => ({
  ...(await original<typeof import("near-api-js")>()),
  KeyPair: { fromString: (k: string) => ({ getPublicKey: () => ({ toString: () => `${k}-public` }) }) },
}));

import { POST } from "./route";

const payload = { standard: "nep413", payload: {} };
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/relay", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/relay — notes the withdrawal's hash without waiting for it (D-593)", () => {
  beforeEach(() => {
    afterTasks.length = 0;
    afterThrows.current = false;
    flag.enabled = true;
    handled.current = { status: 200, body: { ok: true, txHash: "tx", outcome: {}, gasBurntNear: "0" } };
    note.mockReset().mockResolvedValue(undefined);
    resolveOpsDb.mockClear();
    vi.stubEnv("RELAYER_ACCOUNT_ID", "relayer.near");
    vi.stubEnv("RELAYER_VERIFIER_PRIVATE_KEY", "ed25519:verifier-key");
    vi.stubEnv("RELAYER_VAULT_PRIVATE_KEY", "ed25519:vault-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("answers while the note is still pending, and keeps the function alive for it", async () => {
    const pending = new Promise<void>(() => {});
    note.mockReturnValue(pending);
    const response = await post({ target: "verifier", payload });
    expect(response.status).toBe(200);
    // The promise itself: a callback would wait for the response's `close` (see the route).
    expect(afterTasks).toEqual([pending]);
    expect(afterTasks[0]).toBe(pending);
  });

  it("hands it the envelope, the answer and the withdrawal pool", async () => {
    await post({ target: "verifier", payload });
    const input = note.mock.calls[0][0];
    expect(input).toMatchObject({ payload, response: (handled.current as { body: unknown }).body });
    input.resolveDb();
    expect(resolveOpsDb).toHaveBeenCalledWith(process.env, "withdraw");
  });

  it("also runs on unknown-outcome, whose answer carries the hash", async () => {
    handled.current = { status: 504, body: { ok: false, code: "unknown-outcome", error: "x", txHash: "tx" } };
    expect((await post({ target: "verifier", payload })).status).toBe(504);
    expect(note).toHaveBeenCalledTimes(1);
  });

  it("answers the same when `after` itself throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    afterThrows.current = true;
    const response = await post({ target: "verifier", payload });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual((handled.current as { body: unknown }).body);
  });

  it("does nothing for the vault target, or with withdrawal records off", async () => {
    await post({ target: "vault", payload });
    flag.enabled = false;
    await post({ target: "verifier", payload });
    expect(note).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(0);
  });

  it("does not break on a body that is not an object", async () => {
    for (const body of [null, 7, "x"]) await post(body);
    expect(note).not.toHaveBeenCalled();
  });
});
