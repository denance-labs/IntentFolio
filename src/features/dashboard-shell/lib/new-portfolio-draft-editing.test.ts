import { describe, it, expect } from "vitest";
import { portfolioPresets } from "@/content/portfolio-presets";
import { isPortfolioOfferable } from "@/features/bridge/lib/token-availability";
import { depositableTokens } from "@/features/market/lib/token-registry";
import { APP_MAX_TOKENS_PER_PORTFOLIO, pctToBps } from "@/features/vault/lib/change-set-preflight";
import { validateNewPortfolioDraft, type NewPortfolioDraftRow } from "./new-portfolio-draft";
import {
  addDraftToken,
  draftDefaultTolerance,
  draftLockState,
  draftRowCeiling,
  draftToleranceViolations,
  normalizeDraftLocks,
  presetDraftRows,
  removeDraftToken,
  sanitizeDraftPctInput,
  setDraftTokenPct,
  toggleDraftTokenLock,
  uniqueDefaultName,
} from "./new-portfolio-draft-editing";

const BTC = "nep141:nbtc.bridge.near"; // nBTC: `btc.omft.near` has no buy route (D-491)
const ETH = "nep141:eth.bridge.near";
const NEAR = "near";
const SOL = "nep141:sol.omft.near";

const row = (tokenId: string, targetPct: number, locked = false, tolerancePct = 10): NewPortfolioDraftRow => ({
  tokenId,
  targetPct,
  tolerancePct,
  locked,
});
const pcts = (rows: NewPortfolioDraftRow[]) => rows.map((r) => r.targetPct);
const bpsSum = (rows: NewPortfolioDraftRow[]) => rows.reduce((s, r) => s + pctToBps(r.targetPct), 0);
const isValid = (rows: NewPortfolioDraftRow[]) =>
  validateNewPortfolioDraft({ name: "Mine", presetId: null, rows }, []).ok;

describe("presetDraftRows", () => {
  it.each(portfolioPresets.map((p) => [p.id, p] as const))(
    "%s loads its slots exactly, with the preset tolerance and nothing locked — and is valid",
    (_, preset) => {
      const rows = presetDraftRows(preset.id);
      expect(rows).toEqual(
        preset.slots.map((s) => ({ tokenId: s.tokenId, targetPct: s.targetPct, tolerancePct: preset.tolerancePct, locked: false }))
      );
      expect(isValid(rows)).toBe(true);
    }
  );
});

describe("draftDefaultTolerance", () => {
  it("is the preset's tolerance, or 10 from scratch", () => {
    expect(draftDefaultTolerance("balanced")).toBe(8);
    expect(draftDefaultTolerance("aggressive")).toBe(12);
    expect(draftDefaultTolerance(null)).toBe(10);
  });
});

describe("uniqueDefaultName", () => {
  it("keeps a free name and numbers a taken one, ignoring case like the duplicate check", () => {
    expect(uniqueDefaultName("Satoshi", [])).toBe("Satoshi");
    expect(uniqueDefaultName("Satoshi", ["satoshi"])).toBe("Satoshi 2");
    expect(uniqueDefaultName("Satoshi", ["Satoshi", "SATOSHI 2"])).toBe("Satoshi 3");
  });
});

describe("sanitizeDraftPctInput", () => {
  it.each([
    ["60", "60"],
    ["33,33", "33.33"],
    ["33.339", "33.33"],
    ["12.", "12."],
    ["1.2.3", "1.23"],
    ["a1b2", "12"],
    ["-5", "5"],
    ["", ""],
  ])("%j → %j", (raw, expected) => {
    expect(sanitizeDraftPctInput(raw)).toBe(expected);
  });

  it("cuts as text, so 33.33 stays 33.33 (Math.trunc(33.33 * 100) is 3332)", () => {
    expect(parseFloat(sanitizeDraftPctInput("33.33"))).toBe(33.33);
  });
});

describe("addDraftToken (E1: an equal share of the free part)", () => {
  it("from scratch: 100 → 50/50 → 33.33/33.34/33.33, valid after every add", () => {
    let rows: NewPortfolioDraftRow[] = [];
    rows = addDraftToken(rows, BTC, 10);
    expect(pcts(rows)).toEqual([100]);
    expect(isValid(rows)).toBe(true);
    rows = addDraftToken(rows, ETH, 10);
    expect(pcts(rows)).toEqual([50, 50]);
    expect(isValid(rows)).toBe(true);
    rows = addDraftToken(rows, NEAR, 10);
    expect(pcts(rows)).toEqual([33.33, 33.34, 33.33]);
    expect(isValid(rows)).toBe(true);
  });

  it("takes its share of what is not locked, and a locked row keeps its %", () => {
    const rows = addDraftToken([row(BTC, 70, true), row(ETH, 20), row(NEAR, 10)], SOL, 12);
    expect(rows).toEqual([row(BTC, 70, true), row(ETH, 13.33), row(NEAR, 6.67), row(SOL, 10, false, 12)]);
  });

  it("the free rows shrink in proportion", () => {
    const rows = addDraftToken([row(BTC, 70), row(ETH, 20), row(NEAR, 10)], SOL, 10);
    expect(pcts(rows)).toEqual([52.5, 15, 7.5, 25]);
  });

  it("ignores a duplicate and a token past the cap", () => {
    const rows = [row(BTC, 50), row(ETH, 50)];
    expect(addDraftToken(rows, BTC, 10)).toBe(rows);
    const full = depositableTokens.slice(0, APP_MAX_TOKENS_PER_PORTFOLIO).map((t) => row(t.id, 0));
    expect(addDraftToken(full, depositableTokens[APP_MAX_TOKENS_PER_PORTFOLIO].id, 10)).toBe(full);
  });
});

describe("removeDraftToken", () => {
  it("hands the removed % to the free rows in proportion", () => {
    const { rows, locksReleased } = removeDraftToken([row(BTC, 70), row(ETH, 20), row(NEAR, 10)], NEAR);
    expect(pcts(rows)).toEqual([77.78, 22.22]);
    expect(locksReleased).toBe(false);
  });

  it("E2: leaving one free row among several releases every lock, numbers unchanged", () => {
    const before = [row(BTC, 40, true), row(ETH, 30, true), row(NEAR, 20), row(SOL, 10)];
    const { rows, locksReleased } = removeDraftToken(before, SOL);
    expect(locksReleased).toBe(true);
    expect(rows).toEqual([row(BTC, 40), row(ETH, 30), row(NEAR, 30)]);
  });

  it("keeps the locks while two free rows remain", () => {
    const before = [row(BTC, 40, true), row(ETH, 30), row(NEAR, 20), row(SOL, 10)];
    const { rows, locksReleased } = removeDraftToken(before, SOL);
    expect(locksReleased).toBe(false);
    expect(rows[0].locked).toBe(true);
  });

  it("down to two rows nothing is locked; down to one it holds 100%; then empty", () => {
    const toTwo = removeDraftToken([row(BTC, 70, true), row(ETH, 20), row(NEAR, 10)], NEAR);
    const two = toTwo.rows;
    expect(two.every((r) => !r.locked)).toBe(true);
    // The lock control disappears with two rows: nothing to announce.
    expect(toTwo.locksReleased).toBe(false);
    expect(bpsSum(two)).toBe(10000);
    const one = removeDraftToken(two, ETH).rows;
    expect(one).toEqual([row(BTC, 100)]);
    expect(removeDraftToken(one, BTC).rows).toEqual([]);
  });

  it("ignores a token that is not in the draft", () => {
    const rows = [row(BTC, 50), row(ETH, 50)];
    expect(removeDraftToken(rows, SOL)).toEqual({ rows, locksReleased: false });
  });
});

describe("setDraftTokenPct", () => {
  it("re-spreads the other free rows to keep 100", () => {
    const { rows, clamped } = setDraftTokenPct([row(BTC, 70), row(ETH, 20), row(NEAR, 10)], BTC, 60);
    expect(pcts(rows)).toEqual([60, 26.67, 13.33]);
    expect(clamped).toBe(false);
  });

  it("caps at what the locked rows leave, and says so", () => {
    const { rows, clamped } = setDraftTokenPct([row(BTC, 70, true), row(ETH, 20), row(NEAR, 10)], ETH, 50);
    expect(pcts(rows)).toEqual([70, 30, 0]);
    expect(clamped).toBe(true);
  });

  it("does not move a lone row off 100", () => {
    const rows = [row(BTC, 100)];
    expect(setDraftTokenPct(rows, BTC, 40).rows).toBe(rows);
  });
});

describe("locks", () => {
  const three = [row(BTC, 70), row(ETH, 20), row(NEAR, 10)];

  it("are hidden with two rows or fewer", () => {
    expect(draftLockState([row(BTC, 50), row(ETH, 50)], BTC)).toEqual({ shown: false });
    expect(toggleDraftTokenLock([row(BTC, 50), row(ETH, 50)], BTC)).toEqual([row(BTC, 50), row(ETH, 50)]);
  });

  it("lock while three rows stay free; refuse the lock that would leave one", () => {
    expect(draftLockState(three, BTC)).toEqual({ shown: true, canToggle: true });
    const locked = toggleDraftTokenLock(three, BTC);
    expect(locked[0].locked).toBe(true);
    expect(draftLockState(locked, ETH)).toEqual({ shown: true, canToggle: false });
    expect(toggleDraftTokenLock(locked, ETH)).toBe(locked);
    // Unlocking is always allowed.
    expect(toggleDraftTokenLock(locked, BTC)[0].locked).toBe(false);
  });

  it("the ceiling of a row is what the other locked rows leave", () => {
    const locked = toggleDraftTokenLock(three, BTC);
    expect(draftRowCeiling(locked, ETH)).toBe(30);
    expect(draftRowCeiling(locked, BTC)).toBe(100);
  });

  it("normalizeDraftLocks: one row is 100% unlocked, two rows unlocked, more untouched", () => {
    expect(normalizeDraftLocks([row(BTC, 40, true)])).toEqual([row(BTC, 100)]);
    expect(normalizeDraftLocks([row(BTC, 60, true), row(ETH, 40)])).toEqual([row(BTC, 60), row(ETH, 40)]);
    const many = [row(BTC, 70, true), row(ETH, 20), row(NEAR, 10)];
    expect(normalizeDraftLocks(many)).toBe(many);
  });
});

describe("draftToleranceViolations (the shared rules engine, D-008)", () => {
  it("flags each row's band: < 2 and > 30 are errors, > 15 a warning", () => {
    const v = draftToleranceViolations([
      row(BTC, 25, false, 1),
      row(ETH, 25, false, 31),
      row(NEAR, 25, false, 16),
      row(SOL, 25, false, 10),
    ]);
    expect(v[BTC]).toMatchObject({ code: "tolerance-below-min", severity: "error" });
    expect(v[ETH]).toMatchObject({ code: "tolerance-above-max", severity: "error" });
    expect(v[NEAR]).toMatchObject({ code: "tolerance-high", severity: "warning" });
    expect(v[SOL]).toBeUndefined();
  });
});

// The draft becomes the Setup's composition verbatim (2.4). Whatever the user does in the
// editor, the rows must still add up to exactly 10000 bps with at most 2 decimals — the
// vault's gate — so the only way to an unsavable draft is a row at 0%, which the editor
// names. A seeded walk over random edits checks that invariant after every step.
describe("any sequence of edits keeps the composition signable", () => {
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  const pool = [BTC, ETH, NEAR, SOL, ...depositableTokens.filter((t) => isPortfolioOfferable(t.id)).slice(0, 12).map((t) => t.id)];
  const twoDecimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

  it("10000 bps and 2 decimals after every add / remove / set / lock", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = lcg(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      let rows = presetDraftRows(pick(portfolioPresets).id);
      for (let step = 0; step < 40; step++) {
        const op = rand();
        if (op < 0.3) rows = addDraftToken(rows, pick(pool), 10);
        else if (op < 0.45 && rows.length > 0) rows = removeDraftToken(rows, pick(rows).tokenId).rows;
        else if (op < 0.85 && rows.length > 0) {
          const typed = sanitizeDraftPctInput((rand() * 110).toFixed(3));
          rows = setDraftTokenPct(rows, pick(rows).tokenId, parseFloat(typed) || 0).rows;
        } else if (rows.length > 0) rows = toggleDraftTokenLock(rows, pick(rows).tokenId);

        if (rows.length === 0) continue;
        const context = { seed, step, rows: JSON.stringify(rows) };
        expect({ ...context, bps: bpsSum(rows) }).toEqual({ ...context, bps: 10000 });
        expect({ ...context, ok: rows.every((r) => twoDecimals(r.targetPct) && r.targetPct >= 0) }).toEqual({ ...context, ok: true });
        expect({ ...context, free: rows.length < 3 || rows.filter((r) => !r.locked).length >= 2 }).toEqual({ ...context, free: true });
        if (rows.every((r) => r.targetPct > 0)) {
          expect({ ...context, valid: isValid(rows) }).toEqual({ ...context, valid: true });
        }
      }
    }
  });
});
