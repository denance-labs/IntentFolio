import { describe, it, expect, vi } from "vitest";
import { decodeFunctionData, erc20Abi, UserRejectedRequestError, type Hex } from "viem";
import { EvmChainSwitchError, EvmChainSwitchTimeoutError } from "@/features/login-wallet/lib/evm-send-errors";
import { getDepositStatus, type DepositStatusEntry } from "./bridge-client";
import {
  BRIDGE_WATCH_ATTEMPTS,
  buildEvmDepositTransaction,
  classifyEvmSendError,
  estimateNativeDepositFee,
  evmChainNumber,
  evmWalletDepositToken,
  parseEvmDepositAddress,
  readEvmDepositBalance,
  runEvmWalletDeposit,
  spendableForDeposit,
  type RunEvmWalletDepositInput,
} from "./evm-wallet-deposit";

vi.mock("./bridge-client", () => ({ getDepositStatus: vi.fn() }));

const big = (v: string) => BigInt(v);
const OWNER = "0x7A11Ce0000000000000000000000000000000a53";
const DEPOSIT = "0x1111111111111111111111111111111111111111" as const;
const HASH = "0xabc0000000000000000000000000000000000000000000000000000000000001" as Hex;

const USDT_ETH = evmWalletDepositToken("nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near")!;
const ETH_ARB = evmWalletDepositToken("nep141:arb.omft.near")!;
const USDC_BASE = evmWalletDepositToken("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near")!;

describe("the tokens and chains", () => {
  it("serves the EVM tokens only", () => {
    expect(USDT_ETH.chainId).toBe("eth:1");
    expect(evmWalletDepositToken("nep141:usdt.tether-token.near")).toBeNull();
  });

  it("reads the chain number off the bridge's chain id, and refuses a non-EVM one", () => {
    expect(evmChainNumber("eth:42161")).toBe(42161);
    expect(() => evmChainNumber("near:mainnet")).toThrow();
  });

  it("accepts only an EVM deposit address", () => {
    expect(parseEvmDepositAddress(DEPOSIT)).toBe(DEPOSIT);
    expect(() => parseEvmDepositAddress("bridge.address.near")).toThrow();
  });
});

describe("the wire shape of an EVM deposit", () => {
  it("a native goes as value to the deposit address, on its chain, with no data", () => {
    expect(buildEvmDepositTransaction({ token: ETH_ARB, depositAddress: DEPOSIT, amount: big("50000000000000000") })).toEqual({
      chainId: 42161,
      to: DEPOSIT,
      value: big("50000000000000000"),
    });
  });

  it("an ERC-20 is transfer(depositAddress, amount) on its contract, with no value", () => {
    const tx = buildEvmDepositTransaction({ token: USDT_ETH, depositAddress: DEPOSIT, amount: big("40000000") });
    expect(tx.chainId).toBe(1);
    expect(tx.to).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7");
    expect(tx.value).toBe(big("0"));
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect(call.functionName).toBe("transfer");
    expect(call.args).toEqual([DEPOSIT, big("40000000")]);
  });

  it("a native carries the gas limit its fee counted; an ERC-20 never does", () => {
    const eth = evmWalletDepositToken("nep141:eth.omft.near")!;
    expect(buildEvmDepositTransaction({ token: eth, depositAddress: DEPOSIT, amount: big("1"), gasLimit: big("22000") })).toEqual({
      chainId: 1,
      to: DEPOSIT,
      value: big("1"),
      gas: big("22000"),
    });
    const usdt = buildEvmDepositTransaction({ token: USDT_ETH, depositAddress: DEPOSIT, amount: big("1"), gasLimit: big("22000") });
    expect(usdt.gas).toBeUndefined();
  });

  it("refuses a zero amount", () => {
    expect(() => buildEvmDepositTransaction({ token: USDC_BASE, depositAddress: DEPOSIT, amount: big("0") })).toThrow();
  });
});

describe("readEvmDepositBalance", () => {
  it("an ERC-20 reads the token and the chain's native, which pays the gas", async () => {
    const reads = {
      native: vi.fn(async () => big("1000")),
      erc20: vi.fn(async () => big("12500000")),
    };
    expect(await readEvmDepositBalance(USDC_BASE, OWNER, reads)).toEqual({ available: big("12500000"), native: big("1000") });
    expect(reads.erc20).toHaveBeenCalledWith("eth:8453", USDC_BASE.erc20, OWNER);
    expect(reads.native).toHaveBeenCalledWith("eth:8453", OWNER);
  });

  it("a native is one read, and it is both figures", async () => {
    const reads = { native: vi.fn(async () => big("7")), erc20: vi.fn() };
    expect(await readEvmDepositBalance(ETH_ARB, OWNER, reads)).toEqual({ available: big("7"), native: big("7") });
    expect(reads.erc20).not.toHaveBeenCalled();
  });

  it("fails as a whole when either read fails: no form on half a balance", async () => {
    const reads = { native: vi.fn(async () => { throw new Error("rpc down"); }), erc20: vi.fn(async () => big("1")) };
    await expect(readEvmDepositBalance(USDC_BASE, OWNER, reads)).rejects.toThrow();
  });
});

describe("the native fee and what Max may send", () => {
  it("is ((gas + 1k) × maxFeePerGas + 0.000001 ETH) × 1.6 + 0.00005 ETH, the limit left to the wallet", async () => {
    const client = {
      estimateGas: vi.fn(async () => big("21000")),
      estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: big("2000000000") })),
      getGasPrice: vi.fn(),
    };
    // (22 000 × 2 gwei + 1e12) × 1.6 + 5e13 = (4.4e13 + 1e12) × 1.6 + 5e13 = 1.22e14
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await estimateNativeDepositFee("eth:42161", OWNER, DEPOSIT, client as any)).toEqual({
      fee: big("122000000000000"),
      gasLimit: null,
    });
    expect(client.estimateGas).toHaveBeenCalledWith({ account: OWNER, to: DEPOSIT, value: big("0") });
  });

  it("on Ethereum counts the wallet's 2 gwei tip and names the limit it counted", async () => {
    const client = {
      estimateGas: vi.fn(async () => big("21000")),
      estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: big("2000000000") })),
      getGasPrice: vi.fn(),
    };
    // (22 000 × (2 + 2) gwei + 1e12) × 1.6 + 5e13 = 8.9e13 × 1.6 + 5e13 = 1.924e14
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await estimateNativeDepositFee("eth:1", OWNER, DEPOSIT, client as any)).toEqual({
      fee: big("192400000000000"),
      gasLimit: big("22000"),
    });
  });

  it("on Ethereum leaves the wallet what it reserves itself (MetaMask, measured 2026-10-26)", async () => {
    // The RPC's max fee then (base 0.0577 gwei × 1.2 + a near-zero tip), against MetaMask's own
    // 2.065383677 gwei max fee: with the limit named, the wallet reserves 22 000 × that.
    const client = {
      estimateGas: vi.fn(async () => big("21000")),
      estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: big("69243036") })),
      getGasPrice: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { fee, gasLimit } = await estimateNativeDepositFee("eth:1", OWNER, DEPOSIT, client as any);
    expect(fee).toBeGreaterThanOrEqual(gasLimit! * big("2065383677"));
  });

  it("counts a plain transfer when the estimate fails, names no limit, and falls back to the gas price", async () => {
    const client = {
      estimateGas: vi.fn(async () => { throw new Error("no"); }),
      estimateFeesPerGas: vi.fn(async () => { throw new Error("no 1559"); }),
      getGasPrice: vi.fn(async () => big("1000000000")),
    };
    // (22 000 × (1 + 2) gwei + 1e12) × 1.6 + 5e13 = 6.7e13 × 1.6 + 5e13 = 1.572e14
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await estimateNativeDepositFee("eth:1", OWNER, DEPOSIT, client as any)).toEqual({
      fee: big("157200000000000"),
      gasLimit: null,
    });
  });

  it("rejects when no gas price can be read at all", async () => {
    const client = {
      estimateGas: vi.fn(async () => big("21000")),
      estimateFeesPerGas: vi.fn(async () => { throw new Error("no"); }),
      getGasPrice: vi.fn(async () => { throw new Error("rpc down"); }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(estimateNativeDepositFee("eth:1", OWNER, DEPOSIT, client as any)).rejects.toThrow();
  });

  it("a native spends its balance minus the fee, never below zero; an ERC-20 its whole balance", () => {
    expect(spendableForDeposit(ETH_ARB, { available: big("1000"), native: big("1000") }, big("300"))).toBe(big("700"));
    expect(spendableForDeposit(ETH_ARB, { available: big("200"), native: big("200") }, big("300"))).toBe(big("0"));
    expect(spendableForDeposit(USDC_BASE, { available: big("5000000"), native: big("1") }, big("300"))).toBe(big("5000000"));
  });
});

describe("classifyEvmSendError", () => {
  it("a decline, wrapped or not, is declined", () => {
    expect(classifyEvmSendError(new UserRejectedRequestError(new Error("User rejected the request.")))).toEqual({ kind: "declined" });
    expect(classifyEvmSendError({ message: "x", cause: { code: 4001 } })).toEqual({ kind: "declined" });
  });

  it("a network switch that failed or timed out says so — nothing was sent", () => {
    expect(classifyEvmSendError(new EvmChainSwitchTimeoutError(8453))).toEqual({ kind: "switch-failed", timedOut: true });
    expect(classifyEvmSendError(new EvmChainSwitchError(8453, new Error("unsupported")))).toEqual({
      kind: "switch-failed",
      timedOut: false,
    });
  });

  it("not enough gas, refused by the wallet before sending, is a retryable failure", () => {
    expect(classifyEvmSendError(new Error("insufficient funds for gas * price + value"))).toEqual({
      kind: "failed",
      cause: "insufficient-funds",
      txHash: null,
    });
  });

  it("a wallet off the chain at send time sent nothing", () => {
    expect(classifyEvmSendError(Object.assign(new Error("mismatch"), { name: "ChainMismatchError" }))).toMatchObject({
      kind: "failed",
      cause: "not-sent",
    });
  });

  it("anything else may have been broadcast: unconfirmed", () => {
    expect(classifyEvmSendError(new Error("Request timed out"))).toEqual({
      kind: "unconfirmed",
      txHash: null,
      message: "Request timed out",
    });
  });
});

describe("runEvmWalletDeposit", () => {
  const tx = buildEvmDepositTransaction({ token: USDC_BASE, depositAddress: DEPOSIT, amount: big("5000000") });

  function entry(status: DepositStatusEntry["status"], txHash: string = HASH): DepositStatusEntry {
    return {
      tx_hash: txHash,
      chain: "eth:8453",
      defuse_asset_identifier: "eth:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      near_token_id: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      decimals: 6,
      amount: 5000000,
      account_id: OWNER.toLowerCase(),
      address: DEPOSIT,
      status,
    };
  }

  function input(overrides: Partial<RunEvmWalletDepositInput> = {}): RunEvmWalletDepositInput {
    return {
      token: USDC_BASE,
      tx,
      amount: big("5000000"),
      intentsAccountId: OWNER.toLowerCase(),
      send: vi.fn(async () => HASH),
      waitForReceipt: vi.fn(async () => ({ kind: "success" as const, txHash: HASH })),
      findDeposit: vi.fn(async () => entry("COMPLETED")),
      sleep: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it("sends exactly the built transaction, then credits once the bridge lists it completed", async () => {
    const onSent = vi.fn();
    const onConfirmed = vi.fn();
    const run = input({ onSent, onConfirmed });
    expect(await runEvmWalletDeposit(run)).toEqual({ kind: "credited", txHash: HASH, amount: big("5000000") });
    expect(run.send).toHaveBeenCalledWith(tx);
    expect(run.waitForReceipt).toHaveBeenCalledWith("eth:8453", HASH);
    expect(run.findDeposit).toHaveBeenCalledWith(OWNER.toLowerCase(), HASH);
    expect(onSent).toHaveBeenCalledWith(HASH);
    expect(onConfirmed).toHaveBeenCalledWith(HASH);
  });

  it("calls the wallet before anything else is awaited", () => {
    const run = input();
    void runEvmWalletDeposit(run);
    expect(run.send).toHaveBeenCalledTimes(1);
  });

  it("a decline in the wallet is declined, and nothing is watched", async () => {
    const run = input({ send: vi.fn(async () => { throw new UserRejectedRequestError(new Error("no")); }) });
    expect(await runEvmWalletDeposit(run)).toEqual({ kind: "declined" });
    expect(run.waitForReceipt).not.toHaveBeenCalled();
  });

  it("waits while the bridge has it pending, then credits", async () => {
    const findDeposit = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(entry("PENDING"))
      .mockResolvedValueOnce(entry("COMPLETED"));
    const run = input({ findDeposit });
    expect(await runEvmWalletDeposit(run)).toMatchObject({ kind: "credited" });
    expect(run.sleep).toHaveBeenCalledTimes(2);
  });

  it("finds its own transaction in the account's deposits, whatever case or prefix the bridge writes", async () => {
    vi.mocked(getDepositStatus).mockResolvedValue({
      deposits: [entry("COMPLETED", "0xfff0000000000000000000000000000000000000000000000000000000000009"), entry("COMPLETED", HASH.slice(2).toUpperCase())],
      total: 2,
      limit: 50,
      offset: 0,
    });
    const run = input({ findDeposit: undefined });
    expect(await runEvmWalletDeposit(run)).toMatchObject({ kind: "credited", txHash: HASH });
    expect(getDepositStatus).toHaveBeenCalledWith(OWNER.toLowerCase());
  });

  it("another transaction completed is not this one", async () => {
    vi.mocked(getDepositStatus).mockResolvedValue({
      deposits: [entry("COMPLETED", "0xfff0000000000000000000000000000000000000000000000000000000000009")],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(await runEvmWalletDeposit(input({ findDeposit: undefined }))).toEqual({ kind: "sent", txHash: HASH });
  });

  it("past the watch the deposit is sent, on its way — not unconfirmed", async () => {
    const run = input({ findDeposit: vi.fn(async () => entry("PENDING")) });
    expect(await runEvmWalletDeposit(run)).toEqual({ kind: "sent", txHash: HASH });
    expect(run.findDeposit).toHaveBeenCalledTimes(BRIDGE_WATCH_ATTEMPTS);
  });

  it("a bridge read that fails is waited out, not read as a verdict", async () => {
    const findDeposit = vi.fn().mockRejectedValueOnce(new Error("bridge down")).mockResolvedValueOnce(entry("COMPLETED"));
    expect(await runEvmWalletDeposit(input({ findDeposit }))).toMatchObject({ kind: "credited" });
  });

  it("a deposit the bridge reports failed is unconfirmed: the funds left the wallet", async () => {
    expect(await runEvmWalletDeposit(input({ findDeposit: vi.fn(async () => entry("FAILED")) }))).toMatchObject({
      kind: "unconfirmed",
      txHash: HASH,
    });
  });

  it("reverted on chain: failed, and the bridge is never asked", async () => {
    const run = input({ waitForReceipt: vi.fn(async () => ({ kind: "reverted" as const, txHash: HASH })) });
    expect(await runEvmWalletDeposit(run)).toEqual({ kind: "failed", cause: "reverted", txHash: HASH });
    expect(run.findDeposit).not.toHaveBeenCalled();
  });

  it("cancelled from the wallet after sending: failed, nothing moved", async () => {
    const run = input({ waitForReceipt: vi.fn(async () => ({ kind: "cancelled" as const, txHash: HASH })) });
    expect(await runEvmWalletDeposit(run)).toMatchObject({ kind: "failed", cause: "cancelled" });
  });

  it("a speed-up follows the new hash to the bridge", async () => {
    const SPED_UP = "0xdef0000000000000000000000000000000000000000000000000000000000002" as Hex;
    const run = input({
      waitForReceipt: vi.fn(async () => ({ kind: "success" as const, txHash: SPED_UP })),
      findDeposit: vi.fn(async () => entry("COMPLETED", SPED_UP)),
    });
    expect(await runEvmWalletDeposit(run)).toMatchObject({ kind: "credited", txHash: SPED_UP });
    expect(run.findDeposit).toHaveBeenCalledWith(OWNER.toLowerCase(), SPED_UP);
  });

  it("no receipt in time, a replacement we did not build, or a receipt read that fails: unconfirmed", async () => {
    for (const waitForReceipt of [
      vi.fn(async () => ({ kind: "timeout" as const })),
      vi.fn(async () => ({ kind: "replaced" as const, txHash: HASH })),
      vi.fn(async () => { throw new Error("rpc down"); }),
    ]) {
      expect(await runEvmWalletDeposit(input({ waitForReceipt }))).toMatchObject({ kind: "unconfirmed", txHash: HASH });
    }
  });
});
