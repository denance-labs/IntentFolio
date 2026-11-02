import { describe, expect, it, vi } from "vitest";
import {
  MAX_REGISTRATION_COST_YOCTO,
  REGISTRATION_CHECK_ATTEMPTS,
  buildStorageDepositTransaction,
  readRegistrationCost,
  registerNearDestination,
  type StorageRegistrationReads,
} from "./near-storage-registration";

const META_POOL = "meta-pool.near";
const ME = "pablofork.near";
/** 0.00125 NEAR, the NEP-145 standard minimum. */
const COST = BigInt("1250000000000000000000");

function reads(overrides: Partial<StorageRegistrationReads> = {}): StorageRegistrationReads {
  return {
    storageBalanceBounds: vi.fn(async () => ({ min: COST.toString() })),
    storageBalanceOf: vi.fn(async () => null),
    ...overrides,
  };
}

describe("readRegistrationCost (D-316)", () => {
  it("reads the token's own minimum", async () => {
    expect(await readRegistrationCost(META_POOL, reads())).toBe(COST);
  });

  it("refuses a malformed answer", async () => {
    const r = reads({ storageBalanceBounds: async () => ({ min: "" }) });
    await expect(readRegistrationCost(META_POOL, r)).rejects.toThrow(/U128/);
  });

  it("refuses a zero cost: the build could never sign it", async () => {
    const r = reads({ storageBalanceBounds: async () => ({ min: "0" }) });
    await expect(readRegistrationCost(META_POOL, r)).rejects.toThrow(/is 0/);
  });

  it("refuses a cost above the cap", async () => {
    const r = reads({
      storageBalanceBounds: async () => ({ min: (MAX_REGISTRATION_COST_YOCTO + BigInt(1)).toString() }),
    });
    await expect(readRegistrationCost(META_POOL, r)).rejects.toThrow(/cap/);
  });
});

describe("buildStorageDepositTransaction (D-316)", () => {
  it("registers the destination named in the arguments, refunding any excess", () => {
    expect(buildStorageDepositTransaction(META_POOL, ME, COST)).toEqual({
      receiverId: META_POOL,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "storage_deposit",
            args: { account_id: ME, registration_only: true },
            gas: "30000000000000",
            deposit: "1250000000000000000000",
          },
        },
      ],
    });
  });

  it("never builds a zero-deposit registration", () => {
    expect(() => buildStorageDepositTransaction(META_POOL, ME, BigInt(0))).toThrow(/positive/);
  });
});

describe("registerNearDestination (D-316)", () => {
  const noWait = async () => {};

  it("asks the wallet to sign as the account it registers", async () => {
    const send = vi.fn(async () => ({}));
    const r = reads({ storageBalanceOf: vi.fn(async () => ({ total: COST.toString() })) });
    await registerNearDestination({ send, tokenAccountId: META_POOL, accountId: ME, cost: COST, reads: r, wait: noWait });
    expect(send).toHaveBeenCalledWith({ signerId: ME, ...buildStorageDepositTransaction(META_POOL, ME, COST) });
  });

  it("is registered once the chain says so, even a few reads later", async () => {
    const storageBalanceOf = vi
      .fn<StorageRegistrationReads["storageBalanceOf"]>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("RPC 502"))
      .mockResolvedValueOnce({ total: COST.toString() });
    const result = await registerNearDestination({
      send: async () => ({}),
      tokenAccountId: META_POOL,
      accountId: ME,
      cost: COST,
      reads: reads({ storageBalanceOf }),
      wait: noWait,
    });
    expect(result).toEqual({ kind: "registered" });
    expect(storageBalanceOf).toHaveBeenCalledTimes(3);
  });

  it("the chain wins over a wallet that threw after sending", async () => {
    const result = await registerNearDestination({
      send: async () => {
        throw new Error("Timed out waiting for the wallet");
      },
      tokenAccountId: META_POOL,
      accountId: ME,
      cost: COST,
      reads: reads({ storageBalanceOf: async () => ({ total: COST.toString() }) }),
      wait: noWait,
    });
    expect(result).toEqual({ kind: "registered" });
  });

  it("a cancel is re-read like any answer, and reported only if nothing landed (D-348)", async () => {
    const storageBalanceOf = vi.fn(async () => null);
    const result = await registerNearDestination({
      send: async () => {
        throw new Error("User rejected the request");
      },
      tokenAccountId: META_POOL,
      accountId: ME,
      cost: COST,
      reads: reads({ storageBalanceOf }),
      wait: noWait,
    });
    expect(result).toEqual({ kind: "declined" });
    expect(storageBalanceOf).toHaveBeenCalledTimes(REGISTRATION_CHECK_ATTEMPTS);
  });

  it("a cancel that landed anyway is a registration", async () => {
    const storageBalanceOf = vi
      .fn<StorageRegistrationReads["storageBalanceOf"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ total: COST.toString() });
    const result = await registerNearDestination({
      send: async () => {
        throw new Error("User rejected the request");
      },
      tokenAccountId: META_POOL,
      accountId: ME,
      cost: COST,
      reads: reads({ storageBalanceOf }),
      wait: noWait,
    });
    expect(result).toEqual({ kind: "registered" });
  });

  it("never claims a failure it did not see: still unregistered is 'not-confirmed'", async () => {
    const storageBalanceOf = vi.fn(async () => null);
    const result = await registerNearDestination({
      send: async () => ({}),
      tokenAccountId: META_POOL,
      accountId: ME,
      cost: COST,
      reads: reads({ storageBalanceOf }),
      wait: noWait,
    });
    expect(result).toEqual({ kind: "not-confirmed" });
    expect(storageBalanceOf).toHaveBeenCalledTimes(REGISTRATION_CHECK_ATTEMPTS);
  });

  // D-374: no wallet to ask is refused before sending — it proves nothing left, so it needs no read.
  it("no connected wallet is its own answer, with nothing to read", async () => {
    const storageBalanceOf = vi.fn(async () => null);
    const notConnected = Object.assign(new Error("No accounts found"), { name: "WalletNotConnectedError" });
    const result = await registerNearDestination({
      send: async () => {
        throw notConnected;
      },
      tokenAccountId: META_POOL,
      accountId: ME,
      cost: COST,
      reads: reads({ storageBalanceOf }),
      wait: noWait,
    });
    expect(result).toEqual({ kind: "wallet-not-connected" });
    expect(storageBalanceOf).not.toHaveBeenCalled();
  });
});
