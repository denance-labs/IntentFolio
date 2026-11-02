"use client";

// The wallet balance a deposit may use (016 §5.3, block 2a), read when the "From your wallet"
// tab opens — never inside the click (Blink's 5 s activation window, memory
// `project-rpc-latency-popup-block`).
//
// Deliberately NOT `useWalletBalances` (D-338 deviation, s180): that hook walks the whole wallet
// and returns floats, and NEAR's 24 decimals do not survive a float — a "Max" built on it signs
// more or less than the balance. This reads one token, in exact base units.

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { readWalletDepositBalance, readWalletHoldings, walletDepositTarget } from "../lib/near-wallet-deposit";
import { readEvmWalletHoldings, type EvmWalletToken } from "../lib/evm-wallet-holdings";
import { getDepositAddress } from "../lib/bridge-client";
import {
  estimateNativeDepositFee,
  parseEvmDepositAddress,
  readEvmDepositBalance,
} from "../lib/evm-wallet-deposit";

/** Prefix match on `[WALLET_DEPOSIT_BALANCE_KEY, accountId]` invalidates every token of an account. */
export const WALLET_DEPOSIT_BALANCE_KEY = "wallet-deposit-balance";

export function walletDepositBalanceQueryKey(accountId: string, tokenId: string) {
  return [WALLET_DEPOSIT_BALANCE_KEY, accountId, tokenId] as const;
}

export function useWalletDepositBalance(params: {
  accountId: string | null | undefined;
  tokenId: string;
  enabled: boolean;
}) {
  const { accountId, tokenId, enabled } = params;
  const target = walletDepositTarget(tokenId);
  return useQuery({
    queryKey: walletDepositBalanceQueryKey(accountId ?? "", tokenId),
    queryFn: () => {
      // Unreachable while `enabled` holds; kept so a refactor that drops the guard fails loudly
      // instead of reading a balance for nobody.
      if (!target || !accountId) throw new Error("No wallet deposit target");
      return readWalletDepositBalance(target, accountId);
    },
    enabled: enabled && target !== null && !!accountId,
    // A balance someone is about to send: read fresh every time the tab opens, not from the
    // app-wide 5-minute cache.
    staleTime: 0,
    retry: 1,
  });
}

/**
 * Every token the NEAR wallet could deposit, for Receive's first step (D-445). Under the same key
 * prefix as the single-token read, so a settled deposit re-reads the list too.
 */
export function useWalletHoldings(params: { accountId: string | null | undefined; enabled: boolean }) {
  const { accountId, enabled } = params;
  return useQuery({
    queryKey: [WALLET_DEPOSIT_BALANCE_KEY, accountId ?? "", "holdings"] as const,
    queryFn: () => {
      if (!accountId) throw new Error("No wallet to read");
      return readWalletHoldings(accountId);
    },
    enabled: enabled && !!accountId,
    staleTime: 0,
    retry: 1,
  });
}

/**
 * D-445 part 2: the same list for an EVM login — what the wallet holds on the EVM chains Receive
 * takes (`EVM_WALLET_TOKENS`). Same prefix, so a settled deposit re-reads it too.
 */
export function useEvmWalletHoldings(params: { address: string | null | undefined; enabled: boolean }) {
  const { address, enabled } = params;
  return useQuery({
    queryKey: [WALLET_DEPOSIT_BALANCE_KEY, address?.toLowerCase() ?? "", "evm-holdings"] as const,
    queryFn: () => {
      if (!address) throw new Error("No wallet to read");
      return readEvmWalletHoldings(address);
    },
    enabled: enabled && !!address,
    staleTime: 0,
    retry: 1,
  });
}

/**
 * D-445 part 2B: one EVM token, exact, with the chain's native beside it (the gas). Read when the
 * tab opens and fresh every time, like the NEAR one; same prefix, so a deposit re-reads it.
 */
export function useEvmDepositBalance(params: { token: EvmWalletToken; owner: string; enabled: boolean }) {
  const { token, owner, enabled } = params;
  return useQuery({
    queryKey: [WALLET_DEPOSIT_BALANCE_KEY, owner.toLowerCase(), token.tokenId] as const,
    queryFn: () => readEvmDepositBalance(token, owner),
    enabled,
    staleTime: 0,
    retry: 1,
  });
}

/**
 * The bridge's deposit address for this account on this chain — the one the QR tab shows. Fixed
 * per (account, chain), so it is read once a page. Asked when the tab opens, never in the click.
 */
export function useEvmDepositAddress(params: { intentsAccountId: string; chainId: string; enabled: boolean }) {
  const { intentsAccountId, chainId, enabled } = params;
  return useQuery({
    queryKey: ["evm-deposit-address", intentsAccountId, chainId] as const,
    queryFn: async () => parseEvmDepositAddress((await getDepositAddress(intentsAccountId, chainId)).address),
    enabled: enabled && !!intentsAccountId,
    staleTime: Infinity,
    retry: 1,
  });
}

/**
 * What a native deposit's gas may cost, for "Max", and the gas limit its transaction names
 * (`estimateNativeDepositFee`). Natives only.
 */
export function useEvmNativeDepositFee(params: {
  token: EvmWalletToken;
  owner: string;
  depositAddress: string | undefined;
  enabled: boolean;
}) {
  const { token, owner, depositAddress, enabled } = params;
  return useQuery({
    queryKey: ["evm-native-deposit-fee", token.chainId, owner.toLowerCase(), depositAddress ?? ""] as const,
    queryFn: () => {
      if (!depositAddress) throw new Error("No deposit address yet");
      return estimateNativeDepositFee(token.chainId, owner, depositAddress);
    },
    enabled: enabled && token.erc20 === null && !!depositAddress,
    // Gas moves: a figure older than a minute is read again rather than trusted.
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * When balances are re-read after a wallet deposit settles, in ms from the verdict.
 *
 * One immediate read is not enough. The verdict comes from an `EXECUTED_OPTIMISTIC` outcome, the
 * balance reads ask at `finality: "final"`, which trails it by a couple of blocks — and the General
 * Balance query then counts as fresh for 5 minutes. A single read right away would cache the
 * pre-deposit figure next to a toast saying the deposit arrived. The later reads cover the lag
 * (to be confirmed against the real deposits of P4).
 */
export const POST_DEPOSIT_REFRESH_MS = [0, 3_000, 10_000] as const;

/** Re-reads the General Balance and both wallet reads on the schedule above. */
export function refreshBalancesAfterWalletDeposit(queryClient: QueryClient): void {
  for (const delay of POST_DEPOSIT_REFRESH_MS) {
    setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["intents-balances"] });
      void queryClient.invalidateQueries({ queryKey: ["wallet-balances"] });
      void queryClient.invalidateQueries({ queryKey: [WALLET_DEPOSIT_BALANCE_KEY] });
    }, delay);
  }
}
