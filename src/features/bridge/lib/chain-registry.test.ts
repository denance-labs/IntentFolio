// @vitest-environment node
import { describe, it, expect } from "vitest";
import { chainRegistry, getChainMeta } from "./chain-registry";

const EXPECTED_CHAIN_COUNT = 31;
const AURORA_CHAIN_ID = "eth:1313161554";

describe("chainRegistry", () => {
  it("contains exactly 31 chains", () => {
    expect(Object.keys(chainRegistry)).toHaveLength(EXPECTED_CHAIN_COUNT);
  });

  it("excludes Aurora (present in docs but 0 tokens in live bridge)", () => {
    expect(chainRegistry[AURORA_CHAIN_ID]).toBeUndefined();
  });

  it("only Stellar has memoRequired:true", () => {
    const memoChains = Object.entries(chainRegistry)
      .filter(([, meta]) => meta.memoRequired)
      .map(([id]) => id);
    expect(memoChains).toEqual(["stellar:mainnet"]);
  });

  it("all entries have a non-empty displayName", () => {
    for (const [id, meta] of Object.entries(chainRegistry)) {
      expect(meta.displayName, `${id} missing displayName`).toBeTruthy();
    }
  });

  it("all explorerTxUrl functions include the hash in the result", () => {
    const HASH = "0xdeadbeef1234";
    for (const [id, meta] of Object.entries(chainRegistry)) {
      const url = meta.explorerTxUrl(HASH);
      expect(url, `${id} explorerTxUrl does not include hash`).toContain(HASH);
    }
  });

  it("includes the 14 EVM chains", () => {
    const evmChains = [
      "eth:1", "eth:8453", "eth:56", "eth:100", "eth:42161", "eth:10",
      "eth:137", "eth:43114", "eth:143", "eth:196", "eth:534352",
      "eth:80094", "eth:9745", "eth:36900",
    ];
    for (const id of evmChains) {
      expect(chainRegistry[id], `missing EVM chain ${id}`).toBeDefined();
    }
  });

  it("includes the 17 non-EVM chains", () => {
    const nonEvmChains = [
      "near:mainnet", "sol:mainnet", "ton:mainnet", "tron:mainnet",
      "stellar:mainnet", "aleo:mainnet", "aptos:mainnet", "sui:mainnet",
      "starknet:mainnet", "cardano:mainnet", "xrp:mainnet", "btc:mainnet",
      "bch:mainnet", "ltc:mainnet", "doge:mainnet", "dash:mainnet", "zec:mainnet",
    ];
    for (const id of nonEvmChains) {
      expect(chainRegistry[id], `missing non-EVM chain ${id}`).toBeDefined();
    }
  });
});

describe("getChainMeta", () => {
  it("returns metadata for a known chain", () => {
    const meta = getChainMeta("eth:1");
    expect(meta?.displayName).toBe("Ethereum");
    expect(meta?.memoRequired).toBe(false);
  });

  it("returns stellar with memoRequired:true", () => {
    const meta = getChainMeta("stellar:mainnet");
    expect(meta?.memoRequired).toBe(true);
  });

  it("returns undefined for an unknown chain", () => {
    expect(getChainMeta("unknown:chain")).toBeUndefined();
  });

  it("returns undefined for Aurora", () => {
    expect(getChainMeta(AURORA_CHAIN_ID)).toBeUndefined();
  });
});
