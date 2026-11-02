import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assertSolanaDestinationUsable,
  defaultSolanaDestinationProbe,
  nativeSolClearsRent,
  SolanaDestinationUnusableError,
  SOL_RENT_EXEMPT_MINIMUM_LAMPORTS,
  type SolanaAccountInfo,
  type SolanaDestinationProbe,
} from "./solana-destination";
import { withdrawalRegistry } from "./withdrawal-registry";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function probeReturning(info: SolanaAccountInfo | null): SolanaDestinationProbe {
  return { getAccountInfo: async () => info };
}

describe("assertSolanaDestinationUsable", () => {
  // Shapes measured against mainnet on 2026-08-06 via getAccountInfo, not invented:
  // a wallet is System-owned with space 0; an SPL token account is Tokenkeg-owned with
  // space 165 and 2_039_280 lamports of rent.
  it("passes a plain System-owned wallet with no warning", async () => {
    const result = await assertSolanaDestinationUsable({
      destinationAddress: WALLET,
      probe: probeReturning({ owner: SYSTEM_PROGRAM, executable: false, lamports: 10_755_444 }),
    });
    expect(result.warning).toBeNull();
  });

  it("refuses an SPL token account", async () => {
    await expect(
      assertSolanaDestinationUsable({
        destinationAddress: WALLET,
        probe: probeReturning({ owner: TOKEN_PROGRAM, executable: false, lamports: 2_039_280 }),
      })
    ).rejects.toMatchObject({ problem: "token-account" });
  });

  it("refuses a Token-2022 account", async () => {
    await expect(
      assertSolanaDestinationUsable({
        destinationAddress: WALLET,
        probe: probeReturning({
          owner: TOKEN_2022_PROGRAM,
          executable: false,
          lamports: 2_039_280,
        }),
      })
    ).rejects.toMatchObject({ problem: "token-account" });
  });

  it("refuses an executable program account", async () => {
    await expect(
      assertSolanaDestinationUsable({
        destinationAddress: WALLET,
        probe: probeReturning({ owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true, lamports: 1 }),
      })
    ).rejects.toMatchObject({ problem: "program-account" });
  });

  // The decision of block 4.2: an absent destination is advisory, not a refusal (D-213).
  it("warns but does not throw when the account does not exist", async () => {
    const result = await assertSolanaDestinationUsable({
      destinationAddress: WALLET,
      probe: probeReturning(null),
    });
    expect(result.warning).toBe("new-account");
  });

  it("warns for an account owned by some other program", async () => {
    const result = await assertSolanaDestinationUsable({
      destinationAddress: WALLET,
      probe: probeReturning({ owner: "Stake11111111111111111111111111111111111111", executable: false, lamports: 5 }),
    });
    expect(result.warning).toBe("new-account");
  });

  // Fails CLOSED: a read we could not complete must never read as "the account is fine".
  it("refuses when the probe throws", async () => {
    await expect(
      assertSolanaDestinationUsable({
        destinationAddress: WALLET,
        probe: {
          getAccountInfo: async () => {
            throw new Error("401 tenant disabled");
          },
        },
      })
    ).rejects.toBeInstanceOf(SolanaDestinationUnusableError);
    await expect(
      assertSolanaDestinationUsable({
        destinationAddress: WALLET,
        probe: {
          getAccountInfo: async () => {
            throw new Error("401 tenant disabled");
          },
        },
      })
    ).rejects.toMatchObject({ problem: "unverified" });
  });
});

/**
 * The parsing layer, where 4.3.6's actual bug lived (D-212): `BigInt(hex || "0x0")` read a
 * `401` body as a zero and asserted invented numbers about real money. The equivalent slip
 * here would be `body.result?.value ?? null` — every one of these responses would come back
 * as "the account does not exist", which is the verdict that lets a withdrawal through.
 */
describe("defaultSolanaDestinationProbe — fails closed on anything it cannot read", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(response: { ok?: boolean; status?: number; body: unknown }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: response.ok ?? true,
        status: response.status ?? 200,
        statusText: "",
        json: async () => response.body,
      }))
    );
  }

  it("throws on a non-2xx response instead of reading it as absent", async () => {
    stubFetch({ ok: false, status: 401, body: { error: "tenant disabled" } });
    await expect(defaultSolanaDestinationProbe.getAccountInfo(WALLET)).rejects.toThrow(/401/);
  });

  it("throws on a JSON-RPC error envelope", async () => {
    stubFetch({ body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } } });
    await expect(defaultSolanaDestinationProbe.getAccountInfo(WALLET)).rejects.toThrow(/bad params/);
  });

  it("throws on a body with no result at all", async () => {
    stubFetch({ body: { jsonrpc: "2.0", id: 1 } });
    await expect(defaultSolanaDestinationProbe.getAccountInfo(WALLET)).rejects.toThrow(
      /Unrecognised/
    );
  });

  it("throws on an account whose fields are not the shape we reason about", async () => {
    stubFetch({ body: { result: { value: { owner: 11111, executable: "no" } } } });
    await expect(defaultSolanaDestinationProbe.getAccountInfo(WALLET)).rejects.toThrow(
      /Unrecognised Solana account shape/
    );
  });

  // The ONE case that legitimately means "does not exist".
  it("returns null only for an explicit value: null", async () => {
    stubFetch({ body: { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: null } } });
    await expect(defaultSolanaDestinationProbe.getAccountInfo(WALLET)).resolves.toBeNull();
  });

  // Two free endpoints exist and no paid one does, so the list IS the contingency for D-207's
  // failure shape. What matters is which outcomes advance to the next endpoint and which stop.
  describe("the endpoint fallback", () => {
    /** Answers each URL from `byUrl`, recording the order they were tried in. */
    function stubEndpoints(byUrl: Record<string, { ok?: boolean; status?: number; body: unknown }>) {
      const tried: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          tried.push(url);
          const r = byUrl[url];
          if (!r) throw new Error(`unexpected endpoint ${url}`);
          return {
            ok: r.ok ?? true,
            status: r.status ?? 200,
            statusText: "",
            json: async () => r.body,
          };
        })
      );
      return tried;
    }

    const PRIMARY = "https://solana-rpc.publicnode.com";
    const SECONDARY = "https://api.mainnet-beta.solana.com";
    const walletBody = {
      result: { value: { executable: false, lamports: 7, owner: SYSTEM_PROGRAM, space: 0 } },
    };

    it("stops at the first endpoint when it answers", async () => {
      const tried = stubEndpoints({ [PRIMARY]: { body: walletBody } });
      await expect(defaultSolanaDestinationProbe.getAccountInfo(WALLET)).resolves.toMatchObject({
        owner: SYSTEM_PROGRAM,
      });
      expect(tried).toEqual([PRIMARY]);
    });

    // The D-207 scenario: the default starts answering 401 the way polygon-rpc.com did.
    it("falls through to the second endpoint when the first is dead", async () => {
      const tried = stubEndpoints({
        [PRIMARY]: { ok: false, status: 401, body: { error: "tenant disabled" } },
        [SECONDARY]: { body: walletBody },
      });
      await expect(defaultSolanaDestinationProbe.getAccountInfo(WALLET)).resolves.toMatchObject({
        owner: SYSTEM_PROGRAM,
      });
      expect(tried).toEqual([PRIMARY, SECONDARY]);
    });

    // The property that keeps the list from becoming a way to shop for a friendlier verdict.
    it("does NOT retry elsewhere when an endpoint says the account does not exist", async () => {
      const tried = stubEndpoints({
        [PRIMARY]: { body: { result: { value: null } } },
        [SECONDARY]: { body: walletBody },
      });
      await expect(defaultSolanaDestinationProbe.getAccountInfo(WALLET)).resolves.toBeNull();
      expect(tried).toEqual([PRIMARY]);
    });

    it("throws naming every endpoint when they all fail", async () => {
      stubEndpoints({
        [PRIMARY]: { ok: false, status: 401, body: {} },
        [SECONDARY]: { ok: false, status: 503, body: {} },
      });
      const err = await defaultSolanaDestinationProbe
        .getAccountInfo(WALLET)
        .then(() => null)
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain(PRIMARY);
      expect(err!.message).toContain(SECONDARY);
      expect(err!.message).toContain("401");
      expect(err!.message).toContain("503");
    });
  });

  it("reads a real wallet response", async () => {
    stubFetch({
      body: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          context: { slot: 437607686 },
          value: {
            data: ["", "base64"],
            executable: false,
            lamports: 10755444111314303,
            owner: SYSTEM_PROGRAM,
            space: 0,
          },
        },
      },
    });
    await expect(defaultSolanaDestinationProbe.getAccountInfo(WALLET)).resolves.toEqual({
      owner: SYSTEM_PROGRAM,
      executable: false,
      lamports: 10755444111314303,
    });
  });
});

describe("native SOL rent-exemption invariant", () => {
  // getMinimumBalanceForRentExemption(0) on mainnet, 2026-08-06.
  it("pins the rent-exempt minimum this module reasons about", () => {
    expect(SOL_RENT_EXEMPT_MINIMUM_LAMPORTS).toBe(890_880);
  });

  /**
   * The reason the Solana pre-flight does NOT check rent: the bridge's own minimum already
   * guarantees the margin. If a registry refresh ever lowers `minWithdrawalRaw` or raises the
   * fee past that point, this test is what says so — before a mainnet withdrawal bounces.
   */
  it("the registry's own minimum for sol.omft.near clears rent-exemption", () => {
    const entry = withdrawalRegistry["nep141:sol.omft.near"];
    expect(entry).toBeDefined();
    expect(entry.chainId).toBe("sol:mainnet");
    expect(nativeSolClearsRent(entry.minWithdrawalRaw, entry.withdrawalFeeRaw)).toBe(true);
    // The measured margin as of 2026-08-06: 1_250_000 - 14_000 = 1_236_000 delivered.
    expect(BigInt(entry.minWithdrawalRaw) - BigInt(entry.withdrawalFeeRaw)).toBe(BigInt(1_236_000));
  });

  it("reports false when the minimum stops covering rent", () => {
    expect(nativeSolClearsRent("900000", "14000")).toBe(false);
    expect(nativeSolClearsRent("904880", "14000")).toBe(true);
  });
});
