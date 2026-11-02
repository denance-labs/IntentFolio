import { describe, it, expect, vi } from "vitest";
import { depositableTokens } from "@/features/market/lib/token-registry";
import { EVM_DEPOSIT_RPC_URLS } from "./evm-rpc";
import {
  EVM_WALLET_TOKENS,
  readEvmWalletHoldings,
  type EvmHoldingReads,
} from "./evm-wallet-holdings";
import { isReceivable } from "./token-availability";
import { withdrawalRegistry } from "./withdrawal-registry";

const big = (v: string) => BigInt(v);
const OWNER = "0x7A11Ce0000000000000000000000000000000a53";

const USDC_ETH = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const ETH_ARB = "nep141:arb.omft.near";

function readsWith(overrides: Partial<EvmHoldingReads> = {}): EvmHoldingReads {
  return {
    native: vi.fn(async () => big("0")),
    erc20: vi.fn(async () => big("0")),
    ...overrides,
  };
}

describe("EVM_WALLET_TOKENS", () => {
  it("is exactly the tokens Receive takes on an EVM chain", () => {
    const receivableOnEvm = depositableTokens
      .map((t) => t.id)
      .filter((id) => withdrawalRegistry[id]?.chainId.startsWith("eth:") && isReceivable(id));
    expect(EVM_WALLET_TOKENS.map((t) => t.tokenId).sort()).toEqual([...receivableOnEvm].sort());
  });

  it("reads each token on the chain its withdrawal route names, and every chain has an RPC", () => {
    for (const token of EVM_WALLET_TOKENS) {
      expect(token.chainId).toBe(withdrawalRegistry[token.tokenId]?.chainId);
      expect(EVM_DEPOSIT_RPC_URLS[token.chainId]?.length).toBeGreaterThan(0);
    }
  });

  it("reads the contract inside the omft id, and the native when the id carries none", () => {
    for (const token of EVM_WALLET_TOKENS) {
      const inId = token.tokenId.match(/-(0x[0-9a-f]{40})\.omft\.near$/)?.[1] ?? null;
      expect(token.erc20).toBe(inId);
    }
  });
});

describe("readEvmWalletHoldings", () => {
  it("lists only what the wallet holds, with its chain and the registry's decimals", async () => {
    const reads = readsWith({
      native: vi.fn(async (chainId: string) => (chainId === "eth:42161" ? big("50000000000000000") : big("0"))),
      erc20: vi.fn(async (_chainId: string, token: string) =>
        token === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ? big("12500000") : big("0")
      ),
    });
    const holdings = await readEvmWalletHoldings(OWNER, reads);
    expect(holdings).toEqual([
      { tokenId: ETH_ARB, chainId: "eth:42161", available: big("50000000000000000"), decimals: 18 },
      { tokenId: USDC_BASE, chainId: "eth:8453", available: big("12500000"), decimals: 6 },
    ]);
  });

  it("asks the native balance for natives and balanceOf for ERC-20s, on the right chain", async () => {
    const reads = readsWith();
    await readEvmWalletHoldings(OWNER, reads);
    expect(reads.native).toHaveBeenCalledWith("eth:1", OWNER);
    expect(reads.native).toHaveBeenCalledWith("eth:42161", OWNER);
    expect(reads.native).toHaveBeenCalledTimes(2);
    expect(reads.erc20).toHaveBeenCalledWith("eth:1", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", OWNER);
    expect(reads.erc20).toHaveBeenCalledWith("eth:8453", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", OWNER);
    expect(reads.erc20).toHaveBeenCalledTimes(5);
  });

  it("leaves out a token whose read failed — never shown as zero — and keeps the rest", async () => {
    const reads = readsWith({
      erc20: vi.fn(async (chainId: string) => {
        if (chainId === "eth:1") throw new Error("rpc down");
        return big("1000000");
      }),
    });
    const holdings = await readEvmWalletHoldings(OWNER, reads);
    const ids = holdings.map((h) => h.tokenId);
    expect(ids).not.toContain(USDC_ETH);
    expect(ids).toContain(USDC_BASE);
  });

  it("refuses what is not an EVM address instead of reading for nobody", async () => {
    const reads = readsWith();
    await expect(readEvmWalletHoldings("pablofork.near", reads)).rejects.toThrow();
    expect(reads.native).not.toHaveBeenCalled();
    expect(reads.erc20).not.toHaveBeenCalled();
  });

  it("takes a lowercase address as well as a checksummed one", async () => {
    await expect(readEvmWalletHoldings(OWNER.toLowerCase(), readsWith())).resolves.toEqual([]);
  });
});
