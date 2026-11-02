// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@defuse-protocol/internal-utils", () => ({
  poaBridge: {
    httpClient: {
      getSupportedTokens: vi.fn(),
      getDepositAddress: vi.fn(),
      getDepositStatus: vi.fn(),
    },
    getPendingDeposits: vi.fn(),
  },
}));

const {
  getSupportedTokens,
  getDepositAddress,
  getDepositStatus,
  getPendingDeposits,
} = await import("./bridge-client");

const { poaBridge } = await import("@defuse-protocol/internal-utils");
const spySupportedTokens = poaBridge.httpClient.getSupportedTokens as ReturnType<typeof vi.fn>;
const spyDepositAddress = poaBridge.httpClient.getDepositAddress as ReturnType<typeof vi.fn>;
const spyDepositStatus = poaBridge.httpClient.getDepositStatus as ReturnType<typeof vi.fn>;
const spyPendingDeposits = poaBridge.getPendingDeposits as ReturnType<typeof vi.fn>;

const MOCK_TOKEN = {
  intents_token_id: "nep141:usdc.near",
  standard: "nep141",
  near_token_id: "usdc.near",
  asset_name: "USDC",
  decimals: 6,
  min_deposit_amount: "1000000",
  min_withdrawal_amount: "1000000",
  withdrawal_fee: "500000",
  defuse_asset_identifier: "USDC",
};

describe("getSupportedTokens", () => {
  beforeEach(() => spySupportedTokens.mockClear());

  it("calls lib with no chains filter and unwraps tokens", async () => {
    spySupportedTokens.mockResolvedValue({ tokens: [MOCK_TOKEN] });
    const result = await getSupportedTokens();
    expect(spySupportedTokens).toHaveBeenCalledWith({ chains: undefined });
    expect(result).toEqual([MOCK_TOKEN]);
  });

  it("passes chains filter through", async () => {
    spySupportedTokens.mockResolvedValue({ tokens: [] });
    await getSupportedTokens(["eth:1", "sol:mainnet"]);
    expect(spySupportedTokens).toHaveBeenCalledWith({ chains: ["eth:1", "sol:mainnet"] });
  });

  it("returns empty array when catalog has no tokens", async () => {
    spySupportedTokens.mockResolvedValue({ tokens: [] });
    const result = await getSupportedTokens();
    expect(result).toEqual([]);
  });
});

describe("getDepositAddress", () => {
  beforeEach(() => spyDepositAddress.mockClear());

  const MOCK_RESPONSE = { address: "0xabc123", chain: "eth:1" };

  it("passes accountId and chain correctly", async () => {
    spyDepositAddress.mockResolvedValue(MOCK_RESPONSE);
    const result = await getDepositAddress("alice.near", "eth:1");
    expect(spyDepositAddress).toHaveBeenCalledWith({
      account_id: "alice.near",
      chain: "eth:1",
    });
    expect(result).toEqual(MOCK_RESPONSE);
  });

  it("includes deposit_mode when provided", async () => {
    spyDepositAddress.mockResolvedValue({ address: "GABC", chain: "stellar:mainnet", memo: "12345" });
    await getDepositAddress("alice.near", "stellar:mainnet", "MEMO");
    expect(spyDepositAddress).toHaveBeenCalledWith({
      account_id: "alice.near",
      chain: "stellar:mainnet",
      deposit_mode: "MEMO",
    });
  });

  it("omits deposit_mode when not provided", async () => {
    spyDepositAddress.mockResolvedValue(MOCK_RESPONSE);
    await getDepositAddress("alice.near", "eth:1");
    const call = spyDepositAddress.mock.calls[0][0] as Record<string, unknown>;
    expect("deposit_mode" in call).toBe(false);
  });
});

describe("getDepositStatus", () => {
  beforeEach(() => spyDepositStatus.mockClear());

  const MOCK_RESULT = { deposits: [{ status: "PENDING", tx_hash: "0xaaa" }], total: 1, limit: 20, offset: 0 };

  it("passes accountId correctly", async () => {
    spyDepositStatus.mockResolvedValue(MOCK_RESULT);
    const result = await getDepositStatus("alice.near");
    expect(spyDepositStatus).toHaveBeenCalledWith({ account_id: "alice.near" });
    expect(result).toEqual(MOCK_RESULT);
  });

  it("passes optional chain and limit through", async () => {
    spyDepositStatus.mockResolvedValue(MOCK_RESULT);
    await getDepositStatus("alice.near", { chain: "eth:1", limit: 5 });
    expect(spyDepositStatus).toHaveBeenCalledWith({
      account_id: "alice.near",
      chain: "eth:1",
      limit: 5,
    });
  });
});

describe("getPendingDeposits", () => {
  beforeEach(() => spyPendingDeposits.mockClear());

  it("calls lib with accountId and returns result", async () => {
    const MOCK_PENDING = [{ tx_hash: "0xbbb", status: "PENDING" as const }];
    spyPendingDeposits.mockResolvedValue(MOCK_PENDING);
    const result = await getPendingDeposits("alice.near");
    expect(spyPendingDeposits).toHaveBeenCalledWith("alice.near");
    expect(result).toEqual(MOCK_PENDING);
  });

  it("returns empty array when no pending deposits", async () => {
    spyPendingDeposits.mockResolvedValue([]);
    const result = await getPendingDeposits("bob.near");
    expect(result).toEqual([]);
  });
});
