import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTENTS_CONTRACT_ID, VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import type { RelayGateVerdict } from "@/features/vault/lib/relay-gate";

const { sentTransactions, gateVerdict } = vi.hoisted(() => ({
  sentTransactions: [] as Array<{
    privateKey: string;
    receiverId: string;
    methodName: string;
    gas: string;
    deposit: string;
  }>,
  gateVerdict: { current: null as RelayGateVerdict | null },
}));

// What the envelope checks decide is relay-gate.test.ts's subject; here only the wiring is.
// A fresh replay key per call: the relay sends each signed operation once per process, and these
// tests post the same fixture many times.
let replayCounter = 0;
vi.mock("@/features/vault/lib/relay-gate", () => ({
  createRelayGate: () => async () =>
    gateVerdict.current ?? { ok: true, signerId: "tester.near", replayKey: `tester.near:${++replayCounter}` },
}));

vi.mock("near-api-js", () => ({
  Account: class MockAccount {
    constructor(
      _accountId: string,
      _provider: unknown,
      private readonly privateKey: string
    ) {}

    async createSignedTransaction(input: {
      receiverId: string;
      actions: Array<{ methodName: string; gas: string; deposit: string }>;
    }) {
      sentTransactions.push({
        privateKey: this.privateKey,
        receiverId: input.receiverId,
        methodName: input.actions[0].methodName,
        gas: input.actions[0].gas,
        deposit: input.actions[0].deposit,
      });
      return { transaction: { signed: false }, signature: "sig" };
    }
  },
  // The relay builds its keyed provider per request (relay-rpc-provider.ts); inert here.
  JsonRpcProvider: class MockJsonRpcProvider {
    constructor(readonly connection: unknown) {}
    async viewAccessKey() {
      return { nonce: BigInt(1), permission: "FullAccess" };
    }
  },
  // The route derives each key's public half for the allowance watcher.
  KeyPair: {
    fromString: (privateKey: string) => ({ getPublicKey: () => ({ toString: () => `${privateKey}-public` }) }),
  },
  encodeTransaction: () => new Uint8Array([1, 2, 3]),
  baseEncode: () => "tx-hash",
  actions: {
    functionCall: (_methodName: string, _args: unknown, gas: bigint, deposit: bigint) => ({
      methodName: _methodName,
      gas: gas.toString(),
      deposit: deposit.toString(),
    }),
  },
}));

/** What the one `send_tx` POST answers (relay-rpc-provider.ts `sendOnce`). */
function rpcAnswers(response: () => Promise<Response>) {
  const fetchMock = vi.fn(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const EXECUTED = () =>
  Promise.resolve(
    Response.json({
      jsonrpc: "2.0",
      id: "relay-send",
      result: {
        transaction_outcome: { id: "tx-hash", outcome: { tokens_burnt: "1" } },
        receipts_outcome: [],
        status: { SuccessValue: "" },
      },
    })
  );

import { GET, POST } from "./route";

function request(target: "verifier" | "vault", recipient: string): Request {
  return new Request("http://localhost/api/relay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target,
      payload: {
        standard: "nep413",
        payload: {
          message: JSON.stringify({ signer_id: "tester.near" }),
          nonce: "nonce",
          recipient,
        },
        public_key: "ed25519:public",
        signature: "ed25519:signature",
      },
    }),
  });
}

describe("POST /api/relay — D-246 FunctionCall key routing", () => {
  beforeEach(() => {
    sentTransactions.length = 0;
    vi.stubEnv("RELAYER_ACCOUNT_ID", "relayer.near");
    vi.stubEnv("RELAYER_VERIFIER_PRIVATE_KEY", "ed25519:verifier-key");
    vi.stubEnv("RELAYER_VAULT_PRIVATE_KEY", "ed25519:vault-key");
    rpcAnswers(EXECUTED);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("signs verifier calls with only the intents.near FunctionCall key", async () => {
    const response = await POST(request("verifier", INTENTS_CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(sentTransactions).toEqual([
      {
        privateKey: "ed25519:verifier-key",
        receiverId: INTENTS_CONTRACT_ID,
        methodName: "execute_intents",
        gas: "300000000000000",
        deposit: "0",
      },
    ]);
  });

  it("signs vault calls with only the vault FunctionCall key", async () => {
    const response = await POST(request("vault", VAULT_CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(sentTransactions).toEqual([
      {
        privateKey: "ed25519:vault-key",
        receiverId: VAULT_CONTRACT_ID,
        methodName: "commit_portfolio_changes",
        gas: "300000000000000",
        deposit: "0",
      },
    ]);
  });

  it("fails closed when the same key is configured for both targets", async () => {
    vi.stubEnv("RELAYER_VAULT_PRIVATE_KEY", "ed25519:verifier-key");

    const response = await POST(request("verifier", INTENTS_CONTRACT_ID));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "not-configured",
      error: expect.stringMatching(/must be different/i),
    });
    expect(sentTransactions).toEqual([]);
  });
});

describe("POST /api/relay — one send, and an unanswered one is not a failure (D-329, D-330)", () => {
  beforeEach(() => {
    sentTransactions.length = 0;
    vi.stubEnv("RELAYER_ACCOUNT_ID", "relayer.near");
    vi.stubEnv("RELAYER_VERIFIER_PRIVATE_KEY", "ed25519:verifier-key");
    vi.stubEnv("RELAYER_VAULT_PRIVATE_KEY", "ed25519:vault-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("answers 504 unknown-outcome with the hash when the node returns a 503 — and posts once", async () => {
    const fetchMock = rpcAnswers(() => Promise.resolve(new Response("unavailable", { status: 503 })));

    const response = await POST(request("verifier", INTENTS_CONTRACT_ID));

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ ok: false, code: "unknown-outcome", txHash: "tx-hash" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentTransactions).toHaveLength(1);
  });

  it("answers 200 with the outcome when the node executed it", async () => {
    rpcAnswers(EXECUTED);
    const response = await POST(request("vault", VAULT_CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, txHash: "tx-hash" });
  });
});

describe("/api/relay — no token, a pause switch, and the gate before the send (017-2, D-365)", () => {
  beforeEach(() => {
    sentTransactions.length = 0;
    gateVerdict.current = null;
    vi.stubEnv("RELAYER_ACCOUNT_ID", "relayer.near");
    vi.stubEnv("RELAYER_VERIFIER_PRIVATE_KEY", "ed25519:verifier-key");
    vi.stubEnv("RELAYER_VAULT_PRIVATE_KEY", "ed25519:vault-key");
    rpcAnswers(EXECUTED);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("GET says whether the relay is paused, uncached", async () => {
    let response = await GET();
    expect(await response.json()).toEqual({ paused: false });
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    vi.stubEnv("RELAY_PAUSED", "true");
    response = await GET();
    expect(await response.json()).toEqual({ paused: true });
  });

  it("GET answers even where the relay is not configured (a Preview): paused is about the switch only", async () => {
    vi.stubEnv("RELAYER_ACCOUNT_ID", "");
    expect(await (await GET()).json()).toEqual({ paused: false });
  });

  it("POST while paused answers 503 paused and signs nothing", async () => {
    vi.stubEnv("RELAY_PAUSED", "true");
    const response = await POST(request("verifier", INTENTS_CONTRACT_ID));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: "paused" });
    expect(sentTransactions).toEqual([]);
  });

  it("POST with a body past 32 KB answers 413 bad-request without reading it", async () => {
    const big = new Request("http://localhost/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "verifier", payload: { pad: "x".repeat(40_000) } }),
    });
    const response = await POST(big);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, code: "bad-request" });
    expect(sentTransactions).toEqual([]);
  });

  it("POST refused by the gate answers 422 would-fail and signs nothing", async () => {
    gateVerdict.current = { ok: false, code: "would-fail", reason: "insufficient balance or overflow" };
    const response = await POST(request("verifier", INTENTS_CONTRACT_ID));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, code: "would-fail", error: "insufficient balance or overflow" });
    expect(sentTransactions).toEqual([]);
  });
});
