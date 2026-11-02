import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requiresKeyRegistration, checkKeyRegistration } from "./near-key-registration";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";
import type { ChainKind } from "../types";

// D-280 B1. The gate these tests defend: a NEAR named account whose key is not registered
// on `intents.near` gets its intents rejected. Every assertion below is about not answering
// that question with a guess — a read that did not complete must not read as either answer.
//
// Fixtures are the accounts and keys actually measured in mainnet during B0 (s133), so a
// failure here is comparable against the probe's output.

const ACCOUNT = "pablofork.near";
const SIGNING_KEY = "ed25519:2EVgyHyRbaLZjSDPzR8bnLTiPWtTYQ9GLNvtDoHZ4qGB";
/** 64 lowercase hex — the key IS the account, so the contract authenticates it alone. */
const IMPLICIT_ACCOUNT = "8b58bb68e6ba82b2ba0f9dc4e5f9f4e0f2c4de5c0a0a1c2b3d4e5f60718293a4";

function mockViewResult(value: unknown): Response {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
  return new Response(
    JSON.stringify({ result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/** A wasm panic: HTTP 200, `result.error` set. `viewCall` throws on it. */
function mockContractPanic(message: string): Response {
  return new Response(
    JSON.stringify({
      result: { result: [], logs: [], block_height: 1, block_hash: "h", error: message },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("requiresKeyRegistration", () => {
  it.each(["pablofork.near", "intentfolio-admin.near", "sub.account.near", "alice"])(
    "requires it for the NEAR named account %j",
    (accountId) => {
      expect(requiresKeyRegistration("near", accountId)).toBe(true);
    }
  );

  it("does not require it for a NEAR implicit account — measured: that envelope was accepted", () => {
    expect(requiresKeyRegistration("near", IMPLICIT_ACCOUNT)).toBe(false);
  });

  it.each<ChainKind>(["evm", "solana", "ton", "stellar", "tron"])(
    "does not require it for the %s family, whose id derives from the address itself",
    (chainKind) => {
      expect(requiresKeyRegistration(chainKind, "0xabc")).toBe(false);
    }
  );

  // Account ids are lowercase, so this is not an implicit account. Falling through to the
  // on-chain check is the safe direction; short-circuiting it would skip the gate.
  it("does not treat 64 UPPERCASE hex chars as an implicit account", () => {
    expect(requiresKeyRegistration("near", IMPLICIT_ACCOUNT.toUpperCase())).toBe(true);
  });

  it.each([63, 65])("does not treat %i hex chars as an implicit account", (length) => {
    expect(requiresKeyRegistration("near", "a".repeat(length))).toBe(true);
  });
});

describe("checkKeyRegistration", () => {
  it("asks has_public_key for the EXACT (account, key) pair and reports registered", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult(true));

    const status = await checkKeyRegistration({
      chainKind: "near",
      accountId: ACCOUNT,
      publicKey: SIGNING_KEY,
    });

    expect(status).toBe("registered");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.params.account_id).toBe(INTENTS_CONTRACT_ID);
    expect(body.params.method_name).toBe("has_public_key");
    // The args carry the pair. `pablofork.near` has three FullAccess keys and one
    // registered, so an argument list without the key would answer a different question.
    expect(JSON.parse(atob(body.params.args_base64))).toEqual({
      account_id: ACCOUNT,
      public_key: SIGNING_KEY,
    });
  });

  it("reports not-registered when the contract says false", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult(false));
    await expect(
      checkKeyRegistration({ chainKind: "near", accountId: ACCOUNT, publicKey: SIGNING_KEY })
    ).resolves.toBe("not-registered");
  });

  // The three ways the read can fail to complete. None of them is an answer.
  it("reports unknown, not not-registered, when the RPC returns an HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("gateway down", { status: 502 }));
    await expect(
      checkKeyRegistration({ chainKind: "near", accountId: ACCOUNT, publicKey: SIGNING_KEY })
    ).resolves.toBe("unknown");
  });

  it("reports unknown when the network request itself rejects", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("fetch failed"));
    await expect(
      checkKeyRegistration({ chainKind: "near", accountId: ACCOUNT, publicKey: SIGNING_KEY })
    ).resolves.toBe("unknown");
  });

  it("reports unknown when the contract panics", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockContractPanic("wasm execution failed"));
    await expect(
      checkKeyRegistration({ chainKind: "near", accountId: ACCOUNT, publicKey: SIGNING_KEY })
    ).resolves.toBe("unknown");
  });

  // A changed ABI must not decode into a confident `false`.
  it.each([null, "true", 1, {}, []])(
    "reports unknown for the non-boolean on-chain value %j",
    async (value) => {
      vi.mocked(fetch).mockResolvedValueOnce(mockViewResult(value));
      await expect(
        checkKeyRegistration({ chainKind: "near", accountId: ACCOUNT, publicKey: SIGNING_KEY })
      ).resolves.toBe("unknown");
    }
  );

  it("leaves a trace in the console instead of swallowing the failure silently", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("fetch failed"));
    await checkKeyRegistration({
      chainKind: "near",
      accountId: ACCOUNT,
      publicKey: SIGNING_KEY,
    });
    expect(console.warn).toHaveBeenCalled();
  });

  describe("short-circuits without touching the network", () => {
    it("for a NEAR implicit account", async () => {
      await expect(
        checkKeyRegistration({
          chainKind: "near",
          accountId: IMPLICIT_ACCOUNT,
          publicKey: SIGNING_KEY,
        })
      ).resolves.toBe("not-required");
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each<ChainKind>(["evm", "solana", "ton", "stellar", "tron"])(
      "for the %s family",
      async (chainKind) => {
        await expect(
          checkKeyRegistration({
            chainKind,
            accountId: "0x1111111111111111111111111111111111111111",
            publicKey: "",
          })
        ).resolves.toBe("not-required");
        expect(fetch).not.toHaveBeenCalled();
      }
    );
  });

  // Without a key there is no question to ask. `unknown` blocks; `not-registered` would
  // offer a registration transaction for a key the caller cannot name.
  it("reports unknown for a named account with no public key, without calling the RPC", async () => {
    await expect(
      checkKeyRegistration({ chainKind: "near", accountId: ACCOUNT, publicKey: "" })
    ).resolves.toBe("unknown");
    expect(fetch).not.toHaveBeenCalled();
  });
});
