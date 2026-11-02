// D-445 part 2: what the connected EVM wallet holds of the tokens Receive takes on EVM chains, for
// Receive's first step ("From your connected wallet"). Display only: nothing here is signed.

import { erc20Abi, isAddress, type Address } from "viem";
import { getTokenById } from "@/features/market/lib/token-registry";
import { evmDepositClient } from "./evm-rpc";
import type { WalletHolding } from "./near-wallet-deposit";

const ZERO = BigInt(0);

export type EvmWalletToken = {
  tokenId: string;
  chainId: string;
  /** The ERC-20 contract on `chainId`; null for the chain's native asset. */
  erc20: Address | null;
};

/**
 * Every (token, chain) pair Receive takes on an EVM chain. An explicit list, like
 * `DAY_ONE_TOKEN_IDS`: a token added to the registry later does not start reading a contract by
 * being typed into a table. `evm-wallet-holdings.test.ts` fails when a receivable EVM token is
 * missing here, and checks each contract against the address inside its `omft` id.
 */
export const EVM_WALLET_TOKENS: readonly EvmWalletToken[] = [
  // Ethereum
  { tokenId: "nep141:eth.omft.near", chainId: "eth:1", erc20: null },
  {
    tokenId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    chainId: "eth:1",
    erc20: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  },
  {
    tokenId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    chainId: "eth:1",
    erc20: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  },
  // Arbitrum
  { tokenId: "nep141:arb.omft.near", chainId: "eth:42161", erc20: null },
  {
    tokenId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    chainId: "eth:42161",
    erc20: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  },
  {
    tokenId: "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near",
    chainId: "eth:42161",
    erc20: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
  },
  // Base
  {
    tokenId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    chainId: "eth:8453",
    erc20: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
];

export type EvmWalletHolding = WalletHolding & { chainId: string };

export type EvmHoldingReads = {
  native: (chainId: string, owner: Address) => Promise<bigint>;
  erc20: (chainId: string, token: Address, owner: Address) => Promise<bigint>;
};

export const defaultEvmHoldingReads: EvmHoldingReads = {
  native: (chainId, owner) => evmDepositClient(chainId).getBalance({ address: owner }),
  erc20: (chainId, token, owner) =>
    evmDepositClient(chainId).readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    }),
};

/**
 * What `address` holds of each token in `EVM_WALLET_TOKENS`, those with a balance only.
 *
 * Fails closed per token, like `readWalletHoldings`: a read that fails leaves that token out, it is
 * never listed as zero. The decimals are the registry's — measured equal to each contract's
 * `decimals()` on 2026-10-25.
 */
export async function readEvmWalletHoldings(
  address: string,
  reads: EvmHoldingReads = defaultEvmHoldingReads
): Promise<EvmWalletHolding[]> {
  // Not strict: a lowercase address is as good as a checksummed one for reading.
  if (!isAddress(address, { strict: false })) throw new Error("Not an EVM address");
  const owner = address as Address;
  const settled = await Promise.allSettled(
    EVM_WALLET_TOKENS.map((token) =>
      token.erc20 ? reads.erc20(token.chainId, token.erc20, owner) : reads.native(token.chainId, owner)
    )
  );
  return EVM_WALLET_TOKENS.flatMap((token, i) => {
    const read = settled[i];
    const decimals = getTokenById(token.tokenId)?.decimals;
    if (read.status !== "fulfilled" || decimals === undefined || read.value <= ZERO) return [];
    return [{ tokenId: token.tokenId, chainId: token.chainId, available: read.value, decimals }];
  });
}
