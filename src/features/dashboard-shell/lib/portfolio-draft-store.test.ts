// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { readDraft, writeDraft, clearDraft } from "./portfolio-draft-store";
import type { DraftState } from "../context/portfolio-context";

const draft = (id: string): DraftState => ({
  id,
  targets: [
    { id: `target-${id}`, tokenId: "eth", targetPct: 60, tolerancePct: 10, locked: false },
    { id: `target-${id}-2`, tokenId: "usdc", targetPct: 40, tolerancePct: 10, locked: false },
  ],
  balanceDeltas: { eth: 1.5, usdc: -200 },
});

describe("portfolio-draft-store", () => {
  beforeEach(() => window.localStorage.clear());

  it("returns null when there is no persisted draft", () => {
    expect(readDraft("alice.near")).toBeNull();
  });

  it("round-trips a draft (targets + balanceDeltas) for an account", () => {
    const d = draft("p1");
    writeDraft("alice.near", d);
    expect(readDraft("alice.near")).toEqual(d);
  });

  it("isolates drafts by account", () => {
    writeDraft("alice.near", draft("p1"));
    writeDraft("bob.near", draft("p9"));
    expect(readDraft("alice.near")?.id).toBe("p1");
    expect(readDraft("bob.near")?.id).toBe("p9");
  });

  it("overwrites the previous draft for the same account", () => {
    writeDraft("alice.near", draft("p1"));
    writeDraft("alice.near", draft("p2"));
    expect(readDraft("alice.near")?.id).toBe("p2");
  });

  it("clears only the targeted account's draft", () => {
    writeDraft("alice.near", draft("p1"));
    writeDraft("bob.near", draft("p9"));
    clearDraft("alice.near");
    expect(readDraft("alice.near")).toBeNull();
    expect(readDraft("bob.near")?.id).toBe("p9");
  });

  it("clearing a missing account is a no-op (does not throw)", () => {
    expect(() => clearDraft("nobody.near")).not.toThrow();
    expect(readDraft("nobody.near")).toBeNull();
  });

  it("recovers from corrupt storage by returning null", () => {
    window.localStorage.setItem("portfolio.draft.v1", "{not json");
    expect(readDraft("alice.near")).toBeNull();
  });
});
