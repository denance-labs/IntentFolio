// D-445 part 2B: depositing from the connected EVM wallet. The wallet sends the token to the
// account's deposit address on its chain (the same address the QR tab shows), and the bridge
// credits the funding account once it sees the transfer — the same way as a deposit from any
// other wallet. What this module adds is everything around the click: the exact transaction, the
// gas a native "Max" leaves behind, and an honest verdict afterwards.
//
// Attribution: see ATTRIBUTIONS.md #23 (near.com's EVM deposit: transaction shapes, the native fee
// estimate and its buffers).
//
// The verdict rules, in the order money can be lost:
//   - Only an error that proves nothing was sent may offer the form again: a decline, a failed
//     network switch, the wallet refusing for lack of gas. Anything else after the click may have
//     been broadcast, so it is `unconfirmed` and asks the user to check before depositing again.
//   - A receipt decides the chain's part: `reverted` moved nothing but gas.
//   - The bridge decides the rest: `credited` once it lists this transaction as completed. If it
//     has not within the watch, the deposit is `sent`, on its way; the dashboard's deposit poller
//     credits and announces it when it lands (the same path as a QR deposit).

import {
  encodeFunctionData,
  erc20Abi,
  isAddress,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
} from "viem";
import type { EvmTransactionRequest } from "@/features/login-wallet/types";
import { EvmChainSwitchError, EvmChainSwitchTimeoutError } from "@/features/login-wallet/lib/evm-send-errors";
import { getDepositStatus, type DepositStatusEntry } from "./bridge-client";
import { isDepositCredited } from "./deposit-status";
import { evmDepositClient } from "./evm-rpc";
import { EVM_WALLET_TOKENS, defaultEvmHoldingReads, type EvmHoldingReads, type EvmWalletToken } from "./evm-wallet-holdings";

const ZERO = BigInt(0);

/** The token this path deposits, or null for one it does not serve. */
export function evmWalletDepositToken(tokenId: string): EvmWalletToken | null {
  return EVM_WALLET_TOKENS.find((t) => t.tokenId === tokenId) ?? null;
}

/** `eth:42161` → 42161: the bridge names EVM chains `eth:<chain id>`. */
export function evmChainNumber(chainId: string): number {
  const match = /^eth:(\d+)$/.exec(chainId);
  if (!match) throw new Error(`Not an EVM chain: ${chainId}`);
  return Number(match[1]);
}

// ── Balance ────────────────────────────────────────────────────────────────────

/** The token's balance and the chain's native one, which pays the gas. Both in base units. */
export type EvmDepositBalance = { available: bigint; native: bigint };

/** Both reads or none: a deposit is never offered on a figure that failed to load. */
export async function readEvmDepositBalance(
  token: EvmWalletToken,
  owner: string,
  reads: EvmHoldingReads = defaultEvmHoldingReads
): Promise<EvmDepositBalance> {
  if (!isAddress(owner, { strict: false })) throw new Error("Not an EVM address");
  const address = owner as Address;
  if (!token.erc20) {
    const native = await reads.native(token.chainId, address);
    return { available: native, native };
  }
  const [available, native] = await Promise.all([
    reads.erc20(token.chainId, token.erc20, address),
    reads.native(token.chainId, address),
  ]);
  return { available, native };
}

// ── The fee a native "Max" leaves ─────────────────────────────────────────────

// near.com's buffers (`estimateService.ts`), kept as they are: the estimate is read when the tab
// opens and signed seconds or minutes later, and an under-estimate fails in the wallet while an
// over-estimate only leaves a little ETH behind.
const EXTRA_GAS_LIMIT = BigInt(1_000);
const FLAT_L1_FEE_WEI = BigInt("1000000000000"); // 0.000001 ETH
const PERCENT_MULTIPLIER = BigInt(160); // +60 %
const ABSOLUTE_BUFFER_WEI = BigInt("50000000000000"); // 0.00005 ETH
const PLAIN_TRANSFER_GAS = BigInt(21_000);

// Ethereum only, where near.com's buffers fall short (measured with MetaMask, 2026-10-26). The
// wallet checks `value + gas limit × max fee ≤ balance` before it lets the user confirm, and builds
// both on its own: its estimate padded by 50 % (21 000 → 31 500) and a 2 gwei tip ("Market"),
// against the RPC's ~0.07 gwei max fee the buffers multiply. A "Max" that left 0.000054 ETH came
// out "insufficient funds" against the 0.000065 the wallet reserved. So on Ethereum the deposit
// names its own limit — a transfer to an address with no code costs exactly its estimate — and the
// fee counts the wallet's tip. On Arbitrum the limit carries the L1 part and moves with it, so the
// wallet keeps its padding there, which the 0.00005 ETH buffer covers at L2 prices.
const ETHEREUM = "eth:1";
const ETHEREUM_WALLET_TIP_WEI = BigInt(2_000_000_000); // 2 gwei

/** A native deposit's fee for "Max", and the gas limit the transaction names (null: the wallet's). */
export type NativeDepositFee = { fee: bigint; gasLimit: bigint | null };

/**
 * What a native deposit's gas may cost, in wei: `((gas + 1k) × pricePerGas + 0.000001 ETH) × 1.6
 * + 0.00005 ETH`, where the price is the RPC's max fee plus, on Ethereum, the wallet's tip. The gas
 * is estimated for this very transfer (on Arbitrum it includes the L1 part); a failed estimate
 * counts a plain transfer's 21 000 and names no limit. Rejects if no gas price can be read — the
 * panel then offers no deposit rather than a "Max" that would fail in the wallet.
 */
export async function estimateNativeDepositFee(
  chainId: string,
  from: string,
  to: string,
  client = evmDepositClient(chainId)
): Promise<NativeDepositFee> {
  const estimated = await client
    .estimateGas({ account: from as Address, to: to as Address, value: ZERO })
    .catch(() => null);
  const gas = (estimated ?? PLAIN_TRANSFER_GAS) + EXTRA_GAS_LIMIT;
  let pricePerGas: bigint;
  try {
    const fees = await client.estimateFeesPerGas();
    pricePerGas = fees.maxFeePerGas ?? (await client.getGasPrice());
  } catch {
    pricePerGas = await client.getGasPrice();
  }
  const onEthereum = chainId === ETHEREUM;
  if (onEthereum) pricePerGas += ETHEREUM_WALLET_TIP_WEI;
  const base = gas * pricePerGas + FLAT_L1_FEE_WEI;
  return {
    fee: (base * PERCENT_MULTIPLIER) / BigInt(100) + ABSOLUTE_BUFFER_WEI,
    gasLimit: onEthereum && estimated !== null ? gas : null,
  };
}

/**
 * What the form may deposit: an ERC-20's whole balance, or a native's balance minus its fee.
 * Never negative.
 */
export function spendableForDeposit(token: EvmWalletToken, balance: EvmDepositBalance, nativeFee: bigint): bigint {
  if (token.erc20) return balance.available;
  return balance.available > nativeFee ? balance.available - nativeFee : ZERO;
}

// ── The transaction ────────────────────────────────────────────────────────────

/** The bridge's deposit address for this account and chain, refused unless it is an EVM address. */
export function parseEvmDepositAddress(address: string): Address {
  if (!isAddress(address, { strict: false })) throw new Error("The bridge returned no EVM deposit address");
  return address as Address;
}

/**
 * The deposit as the wallet sends it. A native goes as value to the deposit address; an ERC-20 as
 * `transfer(depositAddress, amount)` on its contract, encoded by hand and sent as a plain
 * transaction (near.com does the same) — so USDT on Ethereum, whose `transfer` returns nothing,
 * needs no special case. A native carries the gas limit its fee counted, when there is one.
 */
export function buildEvmDepositTransaction(params: {
  token: EvmWalletToken;
  depositAddress: Address;
  amount: bigint;
  /** `NativeDepositFee.gasLimit`; ignored for an ERC-20. */
  gasLimit?: bigint | null;
}): EvmTransactionRequest {
  const { token, depositAddress, amount, gasLimit } = params;
  if (amount <= ZERO) throw new Error("A deposit needs an amount above zero");
  const chainId = evmChainNumber(token.chainId);
  if (!token.erc20) {
    const tx: EvmTransactionRequest = { chainId, to: depositAddress, value: amount };
    if (gasLimit) tx.gas = gasLimit;
    return tx;
  }
  return {
    chainId,
    to: token.erc20,
    value: ZERO,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [depositAddress, amount] }),
  };
}

// ── Verdicts ───────────────────────────────────────────────────────────────────

export type EvmDepositFailureCause =
  /** The wallet refused before sending: not enough native to pay the gas. */
  | "insufficient-funds"
  /** Mined, and reverted: nothing moved but the gas. */
  | "reverted"
  /** The user cancelled it from the wallet after sending (a replacement to self). */
  | "cancelled"
  /** The wallet is not connected, or moved off the chain between the switch and the send. */
  | "not-sent";

export type EvmDepositResult =
  | { kind: "declined" }
  | { kind: "switch-failed"; timedOut: boolean }
  | { kind: "failed"; cause: EvmDepositFailureCause; txHash: Hex | null }
  | { kind: "unconfirmed"; txHash: Hex | null; message: string }
  | { kind: "sent"; txHash: Hex }
  | { kind: "credited"; txHash: Hex; amount: bigint };

/** Results after which sending again is safe: each one proves nothing moved. */
export const EVM_RETRYABLE: ReadonlySet<EvmDepositResult["kind"]> = new Set(["declined", "switch-failed", "failed"]);

type ErrorLike = { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };

function causes(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  for (let e: unknown = error; e && typeof e === "object" && chain.length < 8; e = (e as ErrorLike).cause) {
    chain.push(e as ErrorLike);
  }
  return chain;
}

/**
 * Reads why the wallet's send threw. Only causes that prove nothing was broadcast are named; any
 * other error leaves `unconfirmed`, because a wallet (WalletConnect above all) can fail to answer
 * after it has already sent.
 */
export function classifyEvmSendError(error: unknown): EvmDepositResult {
  const chain = causes(error);
  if (chain.some((e) => e instanceof EvmChainSwitchTimeoutError)) return { kind: "switch-failed", timedOut: true };
  if (chain.some((e) => e instanceof EvmChainSwitchError)) return { kind: "switch-failed", timedOut: false };
  if (chain.some((e) => e.name === "UserRejectedRequestError" || e.code === 4001)) return { kind: "declined" };
  if (
    chain.some(
      (e) =>
        e.name === "InsufficientFundsError" ||
        (typeof e.message === "string" && /insufficient funds/i.test(e.message))
    )
  ) {
    return { kind: "failed", cause: "insufficient-funds", txHash: null };
  }
  if (
    chain.some(
      (e) =>
        e.name === "ChainMismatchError" ||
        e.name === "ConnectorNotConnectedError" ||
        e.message === "WalletNotConnectedError"
    )
  ) {
    return { kind: "failed", cause: "not-sent", txHash: null };
  }
  const message = chain[0] && typeof chain[0].message === "string" ? chain[0].message : String(error);
  return { kind: "unconfirmed", txHash: null, message };
}

// ── The run ────────────────────────────────────────────────────────────────────

export type EvmReceiptOutcome =
  | { kind: "success" | "reverted" | "cancelled" | "replaced"; txHash: Hex }
  | { kind: "timeout" };

/** How long the chain gets to include the transaction before the verdict says unconfirmed. */
export const EVM_RECEIPT_TIMEOUT_MS = 5 * 60_000;

/**
 * How long the bridge is watched after the chain confirmed: 15 minutes. Measured in the real-money
 * test (2026-10-26), from the block to the credit: ~11 s on Arbitrum, ~70 s on Ethereum (twice).
 * Past it the deposit is `sent`, not lost: the dashboard's poller credits it.
 */
export const BRIDGE_WATCH_ATTEMPTS = 60;
export const BRIDGE_WATCH_INTERVAL_MS = 15_000;

async function defaultWaitForReceipt(chainId: string, hash: Hex): Promise<EvmReceiptOutcome> {
  let reason: "replaced" | "repriced" | "cancelled" | null = null;
  try {
    const receipt = await evmDepositClient(chainId).waitForTransactionReceipt({
      hash,
      timeout: EVM_RECEIPT_TIMEOUT_MS,
      onReplaced: (replacement) => {
        reason = replacement.reason;
      },
    });
    const txHash = receipt.transactionHash;
    // A speed-up keeps the deposit, under a new hash; a cancel is a 0-value send to oneself; a
    // replacement by anything else is a transaction we did not build.
    if (reason === "cancelled") return { kind: "cancelled", txHash };
    if (reason === "replaced") return { kind: "replaced", txHash };
    return { kind: receipt.status === "success" ? "success" : "reverted", txHash };
  } catch (error) {
    if (error instanceof WaitForTransactionReceiptTimeoutError) return { kind: "timeout" };
    throw error;
  }
}

/** Same hash, whatever case or prefix the bridge writes it in. */
function sameHash(a: string, b: string): boolean {
  return a.toLowerCase().replace(/^0x/, "") === b.toLowerCase().replace(/^0x/, "");
}

async function defaultFindDeposit(intentsAccountId: string, hash: Hex): Promise<DepositStatusEntry | null> {
  const { deposits } = await getDepositStatus(intentsAccountId);
  return deposits.find((d) => sameHash(d.tx_hash, hash)) ?? null;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type RunEvmWalletDepositInput = {
  token: EvmWalletToken;
  tx: EvmTransactionRequest;
  /** What was signed, in base units: what `credited` reports. */
  amount: bigint;
  /** Whose funding account the deposit address credits. */
  intentsAccountId: string;
  send: (tx: EvmTransactionRequest) => Promise<Hex>;
  /** The wallet returned a hash: it broadcast the deposit. */
  onSent?: (hash: Hex) => void;
  /** The chain confirmed it: the funds left the wallet. */
  onConfirmed?: (hash: Hex) => void;
  waitForReceipt?: (chainId: string, hash: Hex) => Promise<EvmReceiptOutcome>;
  findDeposit?: (intentsAccountId: string, hash: Hex) => Promise<DepositStatusEntry | null>;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Sends the deposit and follows it to a verdict. 🔴 Calls `send` before any `await`: the click
 * that started it should reach the wallet with nothing in between.
 */
export async function runEvmWalletDeposit(input: RunEvmWalletDepositInput): Promise<EvmDepositResult> {
  let hash: Hex;
  try {
    hash = await input.send(input.tx);
  } catch (error) {
    return classifyEvmSendError(error);
  }
  input.onSent?.(hash);

  let receipt: EvmReceiptOutcome;
  try {
    receipt = await (input.waitForReceipt ?? defaultWaitForReceipt)(input.token.chainId, hash);
  } catch (error) {
    return { kind: "unconfirmed", txHash: hash, message: `Receipt read failed: ${String(error)}` };
  }
  switch (receipt.kind) {
    case "timeout":
      return { kind: "unconfirmed", txHash: hash, message: "No receipt in time" };
    case "reverted":
      return { kind: "failed", cause: "reverted", txHash: receipt.txHash };
    case "cancelled":
      return { kind: "failed", cause: "cancelled", txHash: receipt.txHash };
    case "replaced":
      return { kind: "unconfirmed", txHash: receipt.txHash, message: "Replaced by another transaction" };
    case "success":
      break;
  }
  const minedHash = receipt.txHash;
  input.onConfirmed?.(minedHash);

  const find = input.findDeposit ?? defaultFindDeposit;
  const sleep = input.sleep ?? realSleep;
  for (let attempt = 0; attempt < BRIDGE_WATCH_ATTEMPTS; attempt++) {
    const entry = await find(input.intentsAccountId, minedHash).catch(() => null);
    if (entry && isDepositCredited(entry.status)) {
      return { kind: "credited", txHash: minedHash, amount: input.amount };
    }
    if (entry?.status === "FAILED") {
      return { kind: "unconfirmed", txHash: minedHash, message: "The bridge reported the deposit as failed" };
    }
    await sleep(BRIDGE_WATCH_INTERVAL_MS);
  }
  return { kind: "sent", txHash: minedHash };
}
