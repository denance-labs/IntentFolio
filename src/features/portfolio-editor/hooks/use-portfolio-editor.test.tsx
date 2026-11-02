// @vitest-environment jsdom
// D-314: a live withdrawal that settled is confirmed by a toast with what came back, long
// enough to read. The hooks this one composes are stubbed; only the wrapper is under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { translations } from "../lib/translations";
import { formatCrypto } from "../lib/format";

const h = vi.hoisted(() => ({
  live: true,
  committed: true,
  preview: null as null | {
    changeset: { unallocations: unknown[] };
    summary: { unallocations: Array<{ tokenId: string; symbol: string; qty: number }> };
  },
}));

vi.mock("@/features/market/hooks/use-token-prices", () => ({ useTokenPrices: () => ({ prices: {} }) }));
vi.mock("@/features/dashboard-shell/context/language-context", () => ({ useLanguage: () => ({ lang: "en" }) }));
vi.mock("@/features/dashboard-shell/context/portfolio-context", () => ({
  usePortfolio: () => ({ activePortfolio: { id: "p1", isReal: true }, realUnallocateStage: null }),
}));
vi.mock("@/features/login-wallet", () => ({ useLoginWallet: () => ({ family: "near" }) }));
vi.mock("@/features/vault/context/real-allocate-context", () => ({ useRealAllocateSigner: () => ({}) }));
vi.mock("@/features/vault/lib/vault-flag", () => ({ isLiveVaultRoute: () => h.live }));
vi.mock("@/features/vault/hooks/use-maturity-countdown", () => ({ useMaturityCountdown: () => undefined }));
vi.mock("./use-portfolio-computed", () => ({ usePortfolioComputed: () => ({}) }));
vi.mock("./use-withdraw-dialog", () => ({ useWithdrawDialog: () => ({}) }));
vi.mock("./use-portfolio-targets", () => ({
  usePortfolioTargets: () => ({
    preview: h.preview,
    confirmCommit: vi.fn(async () => h.committed),
  }),
}));

import { usePortfolioEditor } from "./use-portfolio-editor";

const t = translations.en;
const WITHDRAWAL = {
  changeset: { unallocations: [] },
  summary: { unallocations: [{ tokenId: "near", symbol: "NEAR", qty: 1.5 }, { tokenId: "usdc", symbol: "USDC", qty: 20 }] },
};

async function confirm() {
  const { result } = renderHook(() => usePortfolioEditor());
  await act(async () => {
    await result.current.confirmCommit();
  });
  return result;
}

beforeEach(() => {
  h.live = true;
  h.committed = true;
  h.preview = WITHDRAWAL;
});
afterEach(cleanup);

describe("usePortfolioEditor — the confirmation of a withdrawal (D-314)", () => {
  it("a settled live withdrawal shows what came back, and stays up long enough to read", async () => {
    const result = await confirm();
    const toast = result.current.toast!;
    expect(toast.text).toBe(t.unallocateSettledToast.replace("{amounts}", `${formatCrypto(1.5)}\u00a0NEAR · ${formatCrypto(20)}\u00a0USDC`));
    expect(toast.durationMs).toBeGreaterThanOrEqual(8_000);
  });

  it.each([
    ["the commit did not go through", () => (h.committed = false)],
    ["the commit moved no funds", () => (h.preview = { changeset: { unallocations: [] }, summary: { unallocations: [] } })],
    ["a mock portfolio (still releasing, its banner says so)", () => (h.live = false)],
  ])("no toast when %s", async (_label, arrange) => {
    arrange();
    const result = await confirm();
    expect(result.current.toast).toBeNull();
  });
});
