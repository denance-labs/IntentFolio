// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INTENTS_CONTRACT_ID, VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import { RELAY_GAS } from "./relay-types";
import {
  LEGACY_RELAY_TOKEN_KEY,
  RelayError,
  clearLegacyRelayToken,
  fetchRelayPaused,
  relayRefusedBeforeSending,
  submitViaRelay,
} from "./relay-client";
import { resolveEnvelopeSubmitter, usesRelay, walletSubmitter } from "./envelope-submitter";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("the old relayer token (017-2, D-365)", () => {
  beforeEach(() => window.localStorage.clear());

  it("is deleted from the browsers that still hold it", () => {
    window.localStorage.setItem(LEGACY_RELAY_TOKEN_KEY, "old-secret");
    clearLegacyRelayToken();
    expect(window.localStorage.getItem(LEGACY_RELAY_TOKEN_KEY)).toBeNull();
    expect(LEGACY_RELAY_TOKEN_KEY).toBe("vault.relayer-token.v1");
  });

  it("is never sent, even when a browser still has it stored", async () => {
    window.localStorage.setItem(LEGACY_RELAY_TOKEN_KEY, "old-secret");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true, txHash: null, outcome: {}, gasBurntNear: "0" }));

    await submitViaRelay({ target: "vault", payload: {}, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ "Content-Type": "application/json" });
  });
});

describe("fetchRelayPaused", () => {
  it("reads the switch, uncached", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { paused: true }));
    await expect(fetchRelayPaused(fetchImpl as unknown as typeof fetch)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("/api/relay", { method: "GET", cache: "no-store" });
  });

  it("is false for anything but an explicit pause — the POST refuses on its own", async () => {
    const answers = [
      () => Promise.resolve(jsonResponse(200, { paused: false })),
      () => Promise.resolve(jsonResponse(200, { paused: "true" })),
      () => Promise.resolve(new Response("<html>", { status: 500 })),
      () => Promise.reject(new TypeError("Failed to fetch")),
    ];
    for (const answer of answers) {
      await expect(fetchRelayPaused(vi.fn(answer) as unknown as typeof fetch)).resolves.toBe(false);
    }
  });
});

describe("submitViaRelay", () => {
  beforeEach(() => window.localStorage.clear());

  it("posts the target and payload and returns the raw outcome", async () => {
    const outcome = { transaction_outcome: { id: "Tx1" }, status: { SuccessValue: "" } };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { ok: true, txHash: "Tx1", outcome, gasBurntNear: "0.001040" })
      );

    const result = await submitViaRelay({
      target: "verifier",
      payload: { standard: "nep413" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual(outcome);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/relay");
    expect(JSON.parse(init.body as string)).toEqual({
      target: "verifier",
      payload: { standard: "nep413" },
    });
  });

  it("surfaces the relayer's own error message and code", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(422, { ok: false, code: "would-fail", error: "insufficient balance or overflow" }));

    await expect(
      submitViaRelay({
        target: "verifier",
        payload: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ name: "RelayError", code: "would-fail", status: 422, message: "insufficient balance or overflow" });
  });

  // The firewall stamps its answers with `x-vercel-mitigated` (value `deny` on both, measured on
  // staging, s196); the function never does. D-370: the header is the proof, not the status.
  const MITIGATED = { "x-vercel-mitigated": "deny" };

  it("reads the firewall's rate limit (429 with its mark, not our JSON) as refused before sending", async () => {
    for (const page of [
      new Response("Too Many Requests", { status: 429, headers: MITIGATED }),
      new Response(JSON.stringify({ error: { code: "429" } }), { status: 429, headers: { ...MITIGATED, "Content-Type": "application/json" } }),
    ]) {
      const fetchImpl = vi.fn().mockResolvedValue(page);
      const error = await submitViaRelay({ target: "vault", payload: {}, fetchImpl: fetchImpl as unknown as typeof fetch }).catch(
        (e: unknown) => e
      );
      expect(error).toMatchObject({ name: "RelayError", code: "rate-limited", status: 429 });
      expect(relayRefusedBeforeSending(error)).toBe(true);
    }
  });

  it("the relay's own JSON wins over the status: a 429 or 403 carrying unknown-outcome stays ambiguous", async () => {
    for (const status of [429, 403]) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse(status, { ok: false, code: "unknown-outcome", error: "x", txHash: "H" }));
      const error = await submitViaRelay({ target: "vault", payload: {}, fetchImpl: fetchImpl as unknown as typeof fetch }).catch(
        (e: unknown) => e
      );
      expect(error).toMatchObject({ code: "unknown-outcome", txHash: "H" });
      expect(relayRefusedBeforeSending(error)).toBe(false);
    }
  });

  it("any other status without the relay's JSON stays ambiguous, JSON or not", async () => {
    for (const page of [jsonResponse(502, { error: "Bad gateway" }), jsonResponse(504, { message: "timeout" })]) {
      const fetchImpl = vi.fn().mockResolvedValue(page);
      const error = await submitViaRelay({ target: "vault", payload: {}, fetchImpl: fetchImpl as unknown as typeof fetch }).catch(
        (e: unknown) => e
      );
      expect(error).toMatchObject({ code: "unknown-outcome" });
      expect(relayRefusedBeforeSending(error)).toBe(false);
    }
  });

  it("reads the firewall's deny brake (403, not our JSON) as refused before sending", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>Forbidden</html>", { status: 403, headers: MITIGATED }));
    const error = await submitViaRelay({ target: "verifier", payload: {}, fetchImpl: fetchImpl as unknown as typeof fetch }).catch(
      (e: unknown) => e
    );
    expect(error).toMatchObject({ code: "blocked", status: 403 });
    expect(relayRefusedBeforeSending(error)).toBe(true);
  });

  it("D-370: a 403 or 429 WITHOUT the firewall's mark stays ambiguous — a proxy may have blocked the answer", async () => {
    for (const page of [
      new Response("<html>Forbidden</html>", { status: 403 }),
      new Response("Too Many Requests", { status: 429 }),
    ]) {
      const fetchImpl = vi.fn().mockResolvedValue(page);
      const error = await submitViaRelay({ target: "verifier", payload: {}, fetchImpl: fetchImpl as unknown as typeof fetch }).catch(
        (e: unknown) => e
      );
      expect(error).toMatchObject({ code: "unknown-outcome" });
      expect(relayRefusedBeforeSending(error)).toBe(false);
    }
  });

  it("fails loudly on a non-JSON response instead of returning undefined", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 }));

    // Returning undefined here would look downstream like "submitted, no events" — the exact
    // misreport the round-trip must never make.
    await expect(
      submitViaRelay({
        target: "verifier",
        payload: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ name: "RelayError", code: "unknown-outcome", status: 502 });
  });

  it("carries the hash of an unknown-outcome answer (D-329)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(504, { ok: false, code: "unknown-outcome", error: "no answer", txHash: "SentTxHash" })
    );

    await expect(
      submitViaRelay({ target: "vault", payload: {}, fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toMatchObject({ code: "unknown-outcome", txHash: "SentTxHash" });
  });

  it("reads a dropped connection as unknown-outcome — the request may have arrived", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(
      submitViaRelay({ target: "verifier", payload: {}, fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toMatchObject({ name: "RelayError", code: "unknown-outcome", txHash: null });
  });
});

describe("relayRefusedBeforeSending", () => {
  it("is true only for the codes that prove nothing reached the chain", () => {
    for (const code of [
      "bad-request",
      "destination-mismatch",
      "cap-exceeded",
      "not-configured",
      "paused",
      "would-fail",
      "check-failed",
      "send-failed",
      "rate-limited",
      "blocked",
    ]) {
      expect(relayRefusedBeforeSending(new RelayError("x", code, 400))).toBe(true);
    }
    expect(relayRefusedBeforeSending(new RelayError("x", "unknown-outcome", 504))).toBe(false);
    expect(relayRefusedBeforeSending(new RelayError("x", "brand-new-code", 500))).toBe(false);
    // The token gate is gone: its old code no longer proves anything.
    expect(relayRefusedBeforeSending(new RelayError("x", "unauthorized", 401))).toBe(false);
    expect(relayRefusedBeforeSending(new Error("wallet threw"))).toBe(false);
  });
});

// NEXT_PUBLIC_VAULT_RELAY is inlined at build time, so these assert the DEFAULT (flag off)
// behaviour, which is the one that ships: NEAR self-submits, everyone else must relay.
describe("usesRelay (flag off)", () => {
  it("forces the relayer for every non-NEAR family", () => {
    for (const family of ["evm", "solana", "ton", "stellar", "tron", null, undefined]) {
      expect(usesRelay(family)).toBe(true);
    }
  });

  it("keeps NEAR on its own wallet, the control path", () => {
    expect(usesRelay("near")).toBe(false);
  });

  it("refuses to invent a submitter for a non-NEAR family with no wallet", () => {
    // Silently self-submitting here would prompt a wallet the user does not have.
    expect(() => resolveEnvelopeSubmitter({ loginChain: "near", wallet: null })).toThrow(
      /no NEAR wallet/
    );
  });
});

describe("walletSubmitter", () => {
  it("builds the same FunctionCall the wallet path always built (Verifier)", async () => {
    const wallet = { signAndSendTransaction: vi.fn().mockResolvedValue({ ok: 1 }) };
    const payload = { standard: "nep413" };

    await walletSubmitter(wallet)({ target: "verifier", payload });

    expect(wallet.signAndSendTransaction).toHaveBeenCalledWith({
      receiverId: INTENTS_CONTRACT_ID,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "execute_intents",
            args: { signed: [payload] },
            gas: RELAY_GAS,
            deposit: "0",
          },
        },
      ],
    });
  });

  it("builds the commit FunctionCall against the vault, never the Verifier", async () => {
    const wallet = { signAndSendTransaction: vi.fn().mockResolvedValue({ ok: 1 }) };
    const payload = { standard: "nep413" };

    await walletSubmitter(wallet)({ target: "vault", payload });

    const call = wallet.signAndSendTransaction.mock.calls[0][0];
    expect(call.receiverId).toBe(VAULT_CONTRACT_ID);
    expect(call.receiverId).not.toBe(INTENTS_CONTRACT_ID);
    expect(call.actions[0].params.methodName).toBe("commit_portfolio_changes");
    expect(call.actions[0].params.args).toEqual({ payload });
  });
});
