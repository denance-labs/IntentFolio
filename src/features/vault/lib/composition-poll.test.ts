import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitForCompositionCommit } from "./composition-poll";
import { getPortfolio } from "./vault-read-client";
import type { CompositionRowBps } from "./change-set-preflight";

vi.mock("./vault-read-client", () => ({ getPortfolio: vi.fn() }));

const mockGetPortfolio = vi.mocked(getPortfolio);

/** Shape as the CHAIN returns it: snake_case, bps. */
const chainRow = (token_id: string, target_bps: number, tolerance_bps = 500) => ({
  token_id,
  target_bps,
  tolerance_bps,
});

const portfolio = (composition: ReturnType<typeof chainRow>[]) =>
  ({
    owner: "0xabc",
    name: "P",
    composition,
    held_tokens: [],
    created_at: 0,
    deleted: false,
    deleted_at: 0,
  }) as Awaited<ReturnType<typeof getPortfolio>>;

const expected: CompositionRowBps[] = [
  { tokenId: "USDC", targetBps: 6700, toleranceBps: 500 },
  { tokenId: "SOL", targetBps: 3300, toleranceBps: 1000 },
];

const noSleep = () => Promise.resolve();

beforeEach(() => {
  mockGetPortfolio.mockReset();
});

describe("waitForCompositionCommit", () => {
  it("resolves true as soon as the chain reports the expected composition", async () => {
    mockGetPortfolio.mockResolvedValue(
      portfolio([chainRow("USDC", 6700), chainRow("SOL", 3300, 1000)])
    );
    await expect(
      waitForCompositionCommit({ portfolioId: "p_1", expected, sleep: noSleep })
    ).resolves.toBe(true);
    expect(mockGetPortfolio).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while the chain still reports the PRE-commit composition", async () => {
    // The exact race that caused the bug: the first read lands before the commit is visible.
    mockGetPortfolio
      .mockResolvedValueOnce(portfolio([chainRow("USDC", 10000)]))
      .mockResolvedValueOnce(portfolio([chainRow("USDC", 10000)]))
      .mockResolvedValue(portfolio([chainRow("USDC", 6700), chainRow("SOL", 3300, 1000)]));

    await expect(
      waitForCompositionCommit({ portfolioId: "p_1", expected, sleep: noSleep })
    ).resolves.toBe(true);
    expect(mockGetPortfolio).toHaveBeenCalledTimes(3);
  });

  it("ignores row ORDER — the poll must not fail on an ordering assumption", async () => {
    mockGetPortfolio.mockResolvedValue(
      portfolio([chainRow("SOL", 3300, 1000), chainRow("USDC", 6700)])
    );
    await expect(
      waitForCompositionCommit({ portfolioId: "p_1", expected, sleep: noSleep })
    ).resolves.toBe(true);
  });

  it("does not match when a tolerance differs, even with targets right", async () => {
    let now = 0;
    mockGetPortfolio.mockResolvedValue(
      portfolio([chainRow("USDC", 6700), chainRow("SOL", 3300, 500)]) // tol 500 ≠ 1000
    );
    await expect(
      waitForCompositionCommit({
        portfolioId: "p_1",
        expected,
        sleep: noSleep,
        now: () => (now += 10_000),
        timeoutMs: 20_000,
      })
    ).resolves.toBe(false);
  });

  it("does not match a partial composition (extra/missing row)", async () => {
    let now = 0;
    mockGetPortfolio.mockResolvedValue(portfolio([chainRow("USDC", 6700)]));
    await expect(
      waitForCompositionCommit({
        portfolioId: "p_1",
        expected,
        sleep: noSleep,
        now: () => (now += 10_000),
        timeoutMs: 20_000,
      })
    ).resolves.toBe(false);
  });

  it("resolves FALSE on timeout instead of throwing — an unobserved commit is not a lost one", async () => {
    let now = 0;
    mockGetPortfolio.mockResolvedValue(portfolio([chainRow("USDC", 10000)]));
    await expect(
      waitForCompositionCommit({
        portfolioId: "p_1",
        expected,
        sleep: noSleep,
        now: () => (now += 10_000),
        timeoutMs: 20_000,
      })
    ).resolves.toBe(false);
  });

  it("survives transient read errors and still confirms", async () => {
    mockGetPortfolio
      .mockRejectedValueOnce(new Error("RPC 503"))
      .mockResolvedValue(portfolio([chainRow("USDC", 6700), chainRow("SOL", 3300, 1000)]));
    await expect(
      waitForCompositionCommit({ portfolioId: "p_1", expected, sleep: noSleep })
    ).resolves.toBe(true);
  });

  it("treats an unknown portfolio as not-yet-visible rather than an error", async () => {
    mockGetPortfolio
      .mockResolvedValueOnce(null)
      .mockResolvedValue(portfolio([chainRow("USDC", 6700), chainRow("SOL", 3300, 1000)]));
    await expect(
      waitForCompositionCommit({ portfolioId: "p_1", expected, sleep: noSleep })
    ).resolves.toBe(true);
  });
});
