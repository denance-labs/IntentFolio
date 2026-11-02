// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { mockContract } from "@/features/intents-account/mock-contract";
import type { Signature } from "@/features/intents-account/mock-contract/types";
import { buildChangeSet } from "@/features/portfolio-editor/lib/changeset";
import type { TargetAllocation } from "@/features/portfolio-editor/types";
import { getPreset } from "@/content/portfolio-presets";

// The 5.6 first-time creation path at the data level: a preset composition + the chosen
// funds become a changeset, applied atomically by createPortfolio. Mirrors what
// createPortfolioWithChangeSet does in the context, minus the signature gesture.
const SIG: Signature = { scheme: "raw_ed25519", payload: "", signature: "", publicKey: "" };

describe("preset create flow (changeset → createPortfolio)", () => {
  beforeEach(() => mockContract._reset());

  it("creates a funded portfolio with the preset composition and debits General Balance", async () => {
    const account = "qa-demo.near";
    const preset = getPreset("balanced")!;
    const fundedToken = preset.slots[0].tokenId;

    // Deposit lands in General Balance first (deferred registration).
    mockContract.creditReceive(account, fundedToken, 200, "near:mainnet", "tx-1");

    const presetTargets: TargetAllocation[] = preset.slots.map((slot) => ({
      id: `target-${slot.tokenId}`,
      tokenId: slot.tokenId,
      targetPct: slot.targetPct,
      tolerancePct: preset.tolerancePct,
      locked: false,
    }));
    const changeset = buildChangeSet([], presetTargets, { [fundedToken]: 200 });

    const { portfolioId } = await mockContract.createPortfolio(account, "Equilibrado", changeset, SIG);

    const acc = mockContract.getIntentsAccount(account)!;
    const created = acc.portfolios.find((p) => p.id === portfolioId)!;

    // Composition equals the preset, with the preset band on every slot.
    expect(created.composition.map((c) => c.tokenId).sort()).toEqual(
      preset.slots.map((s) => s.tokenId).sort()
    );
    expect(created.composition.every((c) => c.tolerancePct === preset.tolerancePct)).toBe(true);

    // Funds moved into the portfolio and out of General Balance.
    expect(mockContract.getPortfolioBalance(account, portfolioId).get(fundedToken)).toBe(200);
    expect(mockContract.getGeneralBalance(account).get(fundedToken) ?? 0).toBe(0);
  });

  it("allocating a token outside the preset leaves it funded with no composition slot", async () => {
    const account = "qa-demo2.near";
    const preset = getPreset("conservative")!;
    // USDT(ETH) is not in the conservative preset (which holds USDC/USDT-NEAR/DAI/BTC/ETH)
    // — the realistic single-stable depositor funding a token with no composition slot.
    const offPreset = "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near";

    mockContract.creditReceive(account, offPreset, 500, "near:mainnet", "tx-2");

    const presetTargets: TargetAllocation[] = preset.slots.map((slot) => ({
      id: `target-${slot.tokenId}`,
      tokenId: slot.tokenId,
      targetPct: slot.targetPct,
      tolerancePct: preset.tolerancePct,
      locked: false,
    }));
    const changeset = buildChangeSet([], presetTargets, { [offPreset]: 500 });

    const { portfolioId } = await mockContract.createPortfolio(account, "Conservador", changeset, SIG);

    const created = mockContract.getIntentsAccount(account)!.portfolios.find((p) => p.id === portfolioId)!;
    // The off-preset token funds the portfolio (held-no-target) but is not a composition slot.
    expect(created.composition.some((c) => c.tokenId === offPreset)).toBe(false);
    expect(mockContract.getPortfolioBalance(account, portfolioId).get(offPreset)).toBe(500);
  });
});
