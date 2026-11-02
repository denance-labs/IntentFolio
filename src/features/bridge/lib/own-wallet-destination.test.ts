import { describe, it, expect } from "vitest";
import type { LoginWalletConnection } from "@/features/login-wallet";
import { ownWalletDestination } from "./own-wallet-destination";

const near: LoginWalletConnection = { chainKind: "near", address: "alice.near" };
const evm: LoginWalletConnection = {
  chainKind: "evm",
  address: "0x1234567890abcdef1234567890abcdef12345678",
};
const solana: LoginWalletConnection = {
  chainKind: "solana",
  address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
};
const stellar: LoginWalletConnection = {
  chainKind: "stellar",
  address: "GCLROWV43E4RIHPWUFOLFWGS2VJTRW46KXOPBQPGFKYJXQL47P6RTQDA",
};
const tron: LoginWalletConnection = { chainKind: "tron", address: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE" };
const ton: LoginWalletConnection = { chainKind: "ton", address: "a".repeat(64) };

describe("ownWalletDestination", () => {
  it("offers the login address on a chain of its own family", () => {
    expect(ownWalletDestination(near, "near:mainnet")).toBe("alice.near");
    expect(ownWalletDestination(solana, "sol:mainnet")).toBe(solana.address);
    expect(ownWalletDestination(stellar, "stellar:mainnet")).toBe(stellar.address);
    expect(ownWalletDestination(tron, "tron:mainnet")).toBe(tron.address);
  });

  it("offers an EVM login on every EVM chain, not only Ethereum", () => {
    for (const chainId of ["eth:1", "eth:10", "eth:56", "eth:137", "eth:8453", "eth:42161", "eth:43114"]) {
      expect(ownWalletDestination(evm, chainId)).toBe(evm.address);
    }
  });

  it("never offers a TON login: its stored address is the public key, not a destination", () => {
    expect(ownWalletDestination(ton, "ton:mainnet")).toBeNull();
  });

  it("hides the button when the chain belongs to another family", () => {
    expect(ownWalletDestination(near, "eth:1")).toBeNull();
    expect(ownWalletDestination(evm, "near:mainnet")).toBeNull();
    expect(ownWalletDestination(evm, "tron:mainnet")).toBeNull();
    expect(ownWalletDestination(solana, "stellar:mainnet")).toBeNull();
  });

  it("hides the button on chains with no login family", () => {
    for (const chainId of ["btc:mainnet", "aptos:mainnet", "sui:mainnet", "doge:mainnet"]) {
      expect(ownWalletDestination(evm, chainId)).toBeNull();
      expect(ownWalletDestination(near, chainId)).toBeNull();
    }
  });

  it("hides the button with no session or an empty address", () => {
    expect(ownWalletDestination(null, "near:mainnet")).toBeNull();
    expect(ownWalletDestination({ chainKind: "near", address: "" }, "near:mainnet")).toBeNull();
  });
});
