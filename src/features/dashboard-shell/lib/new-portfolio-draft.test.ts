// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { depositableTokens, tokenRegistry } from "@/features/market/lib/token-registry";
import { isPortfolioOfferable } from "@/features/bridge/lib/token-availability";
import { portfolioPresets } from "@/content/portfolio-presets";
import { buildChangeSet } from "@/features/portfolio-editor/lib/changeset";
import { MAX_TOKENS_PER_PORTFOLIO } from "@/features/vault/lib/change-set-preflight";
import {
  ANONYMOUS_DRAFT_SLOT,
  NEW_PORTFOLIO_DRAFT_KEY,
  discardNewPortfolioDraft,
  discardNewPortfolioDraftIfUnchanged,
  draftToTargets,
  draftsReplacedOnConnect,
  moveAnonymousDraftToAccount,
  parseNewPortfolioDraft,
  readNewPortfolioDraft,
  saveNewPortfolioDraft,
  saveNewPortfolioDraftSimulationUsd,
  subscribeNewPortfolioDrafts,
  validateNewPortfolioDraft,
  type NewPortfolioDraftInput,
  type NewPortfolioDraftRow,
} from "./new-portfolio-draft";

const BTC = "nep141:nbtc.bridge.near"; // nBTC: `btc.omft.near` has no buy route (D-491)
const ETH = "nep141:eth.omft.near";
const SOL = "nep141:sol.omft.near";
const NEAR = "near";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const row = (tokenId: string, targetPct: number, tolerancePct = 8, locked = false): NewPortfolioDraftRow => ({
  tokenId,
  targetPct,
  tolerancePct,
  locked,
});

// The Balanced preset, as the editor would save it.
const balanced = (overrides: Partial<NewPortfolioDraftInput> = {}): NewPortfolioDraftInput => ({
  name: "My first portfolio",
  presetId: "balanced",
  rows: [row(BTC, 30), row(ETH, 20), row(USDC, 20), row(NEAR, 15), row(SOL, 15)],
  ...overrides,
});

const withRows = (...rows: NewPortfolioDraftRow[]) => balanced({ rows });

const reasonOf = (draft: NewPortfolioDraftInput, existingNames: string[] = []) => {
  const result = validateNewPortfolioDraft(draft, existingNames);
  return result.ok ? "ok" : result.reason;
};

describe("validateNewPortfolioDraft", () => {
  it("accepts the Balanced preset", () => {
    expect(validateNewPortfolioDraft(balanced(), [])).toEqual({ ok: true });
  });

  it("accepts every preset as shipped (a preset preloaded into the editor must be savable)", () => {
    for (const preset of portfolioPresets) {
      const draft = balanced({
        presetId: preset.id,
        rows: preset.slots.map((s) => row(s.tokenId, s.targetPct, preset.tolerancePct)),
      });
      expect(reasonOf(draft), preset.id).toBe("ok");
    }
  });

  describe("targets sum to exactly 10000 bps", () => {
    it("accepts 33.33 + 33.33 + 33.34 (what the editor's redistribution produces)", () => {
      expect(reasonOf(withRows(row(BTC, 33.33), row(ETH, 33.33), row(SOL, 33.34)))).toBe("ok");
    });

    it("refuses 33.333 × 3 before the bps gate: more precision than one basis point", () => {
      const draft = withRows(row(BTC, 33.333), row(ETH, 33.333), row(SOL, 33.334));
      expect(validateNewPortfolioDraft(draft, [])).toEqual({
        ok: false,
        reason: "target-precision",
        tokenId: BTC,
      });
    });

    it("refuses 50 + 49.99 — the bps composition gate, not a row rule", () => {
      expect(reasonOf(withRows(row(BTC, 50), row(ETH, 49.99)))).toBe("targets-not-100");
    });

    it("refuses 50 + 50.01", () => {
      expect(reasonOf(withRows(row(BTC, 50), row(ETH, 50.01)))).toBe("targets-not-100");
    });

    it("accepts a single token at 100%", () => {
      expect(reasonOf(withRows(row(BTC, 100)))).toBe("ok");
    });
  });

  describe("name", () => {
    it("refuses an empty or blank name", () => {
      expect(validateNewPortfolioDraft(balanced({ name: "   " }), [])).toEqual({
        ok: false,
        reason: "invalid-name",
        nameError: "nameEmpty",
      });
    });

    it("accepts 25 characters and refuses 26", () => {
      expect(reasonOf(balanced({ name: "a".repeat(25) }))).toBe("ok");
      const result = validateNewPortfolioDraft(balanced({ name: "a".repeat(26) }), []);
      expect(result).toMatchObject({ ok: false, reason: "invalid-name", nameError: "nameTooLong" });
    });

    it("refuses a name an existing portfolio already has, case-insensitively", () => {
      const result = validateNewPortfolioDraft(balanced({ name: "Savings" }), ["savings"]);
      expect(result).toMatchObject({ ok: false, reason: "invalid-name", nameError: "nameDuplicate" });
    });
  });

  describe("rows", () => {
    it("refuses a draft with no tokens", () => {
      expect(reasonOf(withRows())).toBe("no-rows");
    });

    // Fewer tokens are offerable (D-389) than the vault takes, so the cap is checked before
    // the tokens: 33 rows are refused as too many whatever they hold.
    // D-528: the editor and saving stop at the app's 10; a stored draft is read against the vault's 32.
    it("accepts 10 tokens and refuses 11 (the app's cap)", () => {
      const offerable = depositableTokens.filter((t) => isPortfolioOfferable(t.id)).map((t) => t.id);
      expect(reasonOf(withRows(...offerable.slice(0, 10).map((id) => row(id, 10))))).toBe("ok");
      // 10 × 9.5 + 5 = 100.00
      const eleven = offerable.slice(0, 11).map((id, i) => row(id, i === 10 ? 5 : 9.5));
      expect(reasonOf(withRows(...eleven))).toBe("too-many-rows");
    });

    it("reading a stored draft: every offerable token at once passes, 33 does not (the vault's cap)", () => {
      const offerable = depositableTokens.filter((t) => isPortfolioOfferable(t.id)).map((t) => t.id);
      expect(offerable).toHaveLength(29);
      // 28 × 3.25 + 9 = 100.00
      const all = offerable.map((id, i) => row(id, i === 28 ? 9 : 3.25));
      expect(validateNewPortfolioDraft(withRows(...all), [], MAX_TOKENS_PER_PORTFOLIO).ok).toBe(true);
      const ids = depositableTokens.slice(0, 33).map((t) => t.id);
      const rows33 = ids.map((id, i) => row(id, i === 32 ? 0.8 : 3.1));
      expect(validateNewPortfolioDraft(withRows(...rows33), [], MAX_TOKENS_PER_PORTFOLIO)).toMatchObject({
        ok: false,
        reason: "too-many-rows",
      });
    });

    it("refuses ZEC, in the catalog but not withdrawable yet (D-389)", () => {
      const zec = "nep141:zec.omft.near";
      expect(validateNewPortfolioDraft(withRows(row(BTC, 50), row(zec, 50)), [])).toEqual({
        ok: false,
        reason: "unknown-token",
        tokenId: zec,
      });
    });

    it("refuses a token outside the curated catalog (D-396), which the picker does not offer", () => {
      const dai = "nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near";
      expect(validateNewPortfolioDraft(withRows(row(BTC, 50), row(dai, 50)), [])).toEqual({
        ok: false,
        reason: "unknown-token",
        tokenId: dai,
      });
    });

    it("refuses a token that is not in the registry (it left since the draft was saved)", () => {
      const draft = withRows(row(BTC, 50), row("nep141:gone.near", 50));
      expect(validateNewPortfolioDraft(draft, [])).toEqual({
        ok: false,
        reason: "unknown-token",
        tokenId: "nep141:gone.near",
      });
    });

    it("refuses a registry token that is not depositable", () => {
      const notDepositable = tokenRegistry.find((t) => !t.depositable);
      expect(notDepositable).toBeDefined();
      expect(reasonOf(withRows(row(BTC, 50), row(notDepositable!.id, 50)))).toBe("unknown-token");
    });

    it("refuses the same token twice", () => {
      expect(reasonOf(withRows(row(BTC, 50), row(BTC, 50)))).toBe("duplicate-token");
    });

    it("refuses a 0%, negative or non-numeric target (a draft row at 0% is removed instead)", () => {
      expect(reasonOf(withRows(row(BTC, 100), row(ETH, 0)))).toBe("target-not-positive");
      expect(reasonOf(withRows(row(BTC, 110), row(ETH, -10)))).toBe("target-not-positive");
      expect(reasonOf(withRows(row(BTC, 100), row(ETH, Number.NaN)))).toBe("target-not-positive");
    });
  });

  describe("tolerance (D-008: 2%-30%, the vault's 200-3000 bps)", () => {
    it.each([2, 5, 12.5, 30])("accepts ±%s%%", (tol) => {
      expect(reasonOf(withRows(row(BTC, 100, tol)))).toBe("ok");
    });

    it.each([1.99, 0, 30.01, Number.NaN])("refuses ±%s%%", (tol) => {
      expect(reasonOf(withRows(row(BTC, 100, tol)))).toBe("tolerance-out-of-range");
    });

    it("refuses more precision than one basis point", () => {
      expect(reasonOf(withRows(row(BTC, 100, 5.555)))).toBe("tolerance-precision");
    });
  });
});

describe("draftToTargets", () => {
  it("maps rows 1:1, keeping tolerance and lock per row", () => {
    const draft = withRows(row(BTC, 60, 5, true), row(ETH, 40, 12));
    expect(draftToTargets(draft)).toEqual([
      { id: `target-${BTC}`, tokenId: BTC, targetPct: 60, tolerancePct: 5, locked: true },
      { id: `target-${ETH}`, tokenId: ETH, targetPct: 40, tolerancePct: 12, locked: false },
    ]);
  });

  it("becomes exactly the Setup's composition through buildChangeSet, row by row", () => {
    const draft = withRows(row(BTC, 33.33, 5), row(ETH, 33.33, 8), row(NEAR, 33.34, 30));
    const changeset = buildChangeSet([], draftToTargets(draft), { [BTC]: 0.001 });
    expect(changeset.tokenAdditions).toEqual([
      { tokenId: BTC, initialTargetPct: 33.33, initialTolerancePct: 5 },
      { tokenId: ETH, initialTargetPct: 33.33, initialTolerancePct: 8 },
      { tokenId: NEAR, initialTargetPct: 33.34, initialTolerancePct: 30 },
    ]);
    expect(changeset.allocations).toEqual([{ tokenId: BTC, qty: 0.001 }]);
  });
});

describe("parseNewPortfolioDraft", () => {
  const stored = (overrides: Record<string, unknown> = {}) => ({
    v: 1,
    ...balanced(),
    updatedAt: 1_700_000_000_000,
    ...overrides,
  });

  it("reads back a valid stored draft", () => {
    expect(parseNewPortfolioDraft(stored())).toEqual(stored());
  });

  it.each([
    ["null", null],
    ["a string", "draft"],
    ["an array", []],
    ["another version", stored({ v: 2 })],
    ["no name", stored({ name: undefined })],
    ["rows not an array", stored({ rows: {} })],
    ["a row with a string %", stored({ rows: [{ tokenId: BTC, targetPct: "100", tolerancePct: 8, locked: false }] })],
    ["a row without lock", stored({ rows: [{ tokenId: BTC, targetPct: 100, tolerancePct: 8 }] })],
    ["a non-numeric updatedAt", stored({ updatedAt: "yesterday" })],
    ["a numeric presetId", stored({ presetId: 3 })],
  ])("returns null (never throws) for %s", (_label, value) => {
    expect(parseNewPortfolioDraft(value)).toBeNull();
  });

  it("returns null for a draft the vault would refuse (e.g. a tightened rule)", () => {
    expect(parseNewPortfolioDraft(stored({ rows: [row(BTC, 100, 40)] }))).toBeNull();
    expect(parseNewPortfolioDraft(stored({ rows: [row(BTC, 50), row(ETH, 49.99)] }))).toBeNull();
  });

  it("keeps the draft but drops the label when its preset was retired", () => {
    expect(parseNewPortfolioDraft(stored({ presetId: "retired-preset" }))?.presetId).toBeNull();
  });

  // D-457 — the simulation's amount travels with the draft.
  it("reads the simulation's amount; a draft saved before it has none ($100 on screen)", () => {
    expect(parseNewPortfolioDraft(stored({ simulationUsd: 10.5 }))?.simulationUsd).toBe(10.5);
    expect(parseNewPortfolioDraft(stored())).not.toHaveProperty("simulationUsd");
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["above the field's ceiling", 1_000_000_001],
    ["a string", "10"],
    ["null (what JSON makes of NaN and Infinity)", null],
  ])("drops an unusable amount (%s) and keeps the draft", (_label, simulationUsd) => {
    const draft = parseNewPortfolioDraft(stored({ simulationUsd }));
    expect(draft).toEqual(stored());
    expect(draft).not.toHaveProperty("simulationUsd");
  });
});

describe("storage per account", () => {
  const ALICE = "alice.near";
  const BOB = "bob.near";

  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("has no draft until one is saved", () => {
    expect(readNewPortfolioDraft(ALICE)).toBeNull();
  });

  // D-528: a draft saved before the app's 10-token cap is kept, to be trimmed in the editor.
  it("keeps a stored draft of 11 tokens instead of dropping it", () => {
    const offerable = depositableTokens.filter((t) => isPortfolioOfferable(t.id)).map((t) => t.id);
    const rows = offerable.slice(0, 11).map((id, i) => row(id, i === 10 ? 5 : 9.5));
    const stored = { v: 1, name: "Wide", presetId: null, rows, updatedAt: Date.now() };
    window.localStorage.setItem(NEW_PORTFOLIO_DRAFT_KEY, JSON.stringify({ [ALICE]: stored }));
    expect(readNewPortfolioDraft(ALICE)?.rows).toHaveLength(11);
    expect(reasonOf(withRows(...rows))).toBe("too-many-rows");
  });

  it("round-trips a draft, stamping version and time and trimming the name", () => {
    const result = saveNewPortfolioDraft(ALICE, balanced({ name: "  Mine  " }), []);
    expect(result).toEqual({ ok: true });
    expect(readNewPortfolioDraft(ALICE)).toEqual({
      v: 1,
      ...balanced({ name: "Mine" }),
      updatedAt: Date.parse("2026-09-29T12:00:00Z"),
    });
  });

  it("keeps one draft per account: saving again replaces it", () => {
    saveNewPortfolioDraft(ALICE, balanced({ name: "First" }), []);
    saveNewPortfolioDraft(ALICE, balanced({ name: "Second" }), []);
    expect(readNewPortfolioDraft(ALICE)?.name).toBe("Second");
  });

  it("isolates accounts", () => {
    saveNewPortfolioDraft(ALICE, balanced({ name: "Alice's" }), []);
    saveNewPortfolioDraft(BOB, balanced({ name: "Bob's" }), []);
    discardNewPortfolioDraft(ALICE);
    expect(readNewPortfolioDraft(ALICE)).toBeNull();
    expect(readNewPortfolioDraft(BOB)?.name).toBe("Bob's");
  });

  it("does not write an invalid draft and leaves the saved one untouched", () => {
    saveNewPortfolioDraft(ALICE, balanced({ name: "Good" }), []);
    const result = saveNewPortfolioDraft(ALICE, withRows(row(BTC, 50), row(ETH, 49.99)), []);
    expect(result).toEqual({ ok: false, reason: "targets-not-100" });
    expect(readNewPortfolioDraft(ALICE)?.name).toBe("Good");
  });

  it("refuses a duplicate name on save", () => {
    const result = saveNewPortfolioDraft(ALICE, balanced({ name: "Savings" }), ["Savings"]);
    expect(result).toMatchObject({ ok: false, reason: "invalid-name", nameError: "nameDuplicate" });
    expect(readNewPortfolioDraft(ALICE)).toBeNull();
  });

  it("does not drop a saved draft whose name a portfolio took since (fixable in the editor)", () => {
    saveNewPortfolioDraft(ALICE, balanced({ name: "Savings" }), []);
    // A portfolio named "Savings" now exists; the read does not know or care.
    expect(readNewPortfolioDraft(ALICE)?.name).toBe("Savings");
  });

  it("without an account: nothing is read or written", () => {
    expect(saveNewPortfolioDraft("", balanced(), [])).toEqual({ ok: false, reason: "no-account" });
    expect(window.localStorage.getItem(NEW_PORTFOLIO_DRAFT_KEY)).toBeNull();
    expect(readNewPortfolioDraft("")).toBeNull();
  });

  it("reads corrupt storage as no draft and recovers on the next save", () => {
    window.localStorage.setItem(NEW_PORTFOLIO_DRAFT_KEY, "{not json");
    expect(readNewPortfolioDraft(ALICE)).toBeNull();
    expect(saveNewPortfolioDraft(ALICE, balanced(), [])).toEqual({ ok: true });
    expect(readNewPortfolioDraft(ALICE)?.name).toBe("My first portfolio");
  });

  it("one account's corrupt entry does not hide another account's draft", () => {
    saveNewPortfolioDraft(BOB, balanced({ name: "Bob's" }), []);
    const store = JSON.parse(window.localStorage.getItem(NEW_PORTFOLIO_DRAFT_KEY)!);
    store[ALICE] = { v: 1, name: 42 };
    window.localStorage.setItem(NEW_PORTFOLIO_DRAFT_KEY, JSON.stringify(store));
    expect(readNewPortfolioDraft(ALICE)).toBeNull();
    expect(readNewPortfolioDraft(BOB)?.name).toBe("Bob's");
  });

  it("uses a key outside the provider's portfolio.portfolios.* sweep and the edit draft's key", () => {
    expect(NEW_PORTFOLIO_DRAFT_KEY.startsWith("portfolio.portfolios.")).toBe(false);
    expect(NEW_PORTFOLIO_DRAFT_KEY).not.toBe("portfolio.state");
    expect(NEW_PORTFOLIO_DRAFT_KEY).not.toBe("portfolio.draft.v1");
  });

  it("an account id that is an Object.prototype key is just another account", () => {
    expect(readNewPortfolioDraft("constructor")).toBeNull();
    discardNewPortfolioDraft("toString"); // no throw, no write
    discardNewPortfolioDraftIfUnchanged("toString", 1); // same
    expect(window.localStorage.getItem(NEW_PORTFOLIO_DRAFT_KEY)).toBeNull();
  });

  // 016 block 2.4 (F2): a confirmation retires the draft it signed, not a newer one another
  // tab saved meanwhile.
  describe("discardNewPortfolioDraftIfUnchanged", () => {
    it("discards the draft saved at that time", () => {
      saveNewPortfolioDraft(ALICE, balanced({ name: "Signed" }), []);
      const signed = readNewPortfolioDraft(ALICE)!;
      discardNewPortfolioDraftIfUnchanged(ALICE, signed.updatedAt);
      expect(readNewPortfolioDraft(ALICE)).toBeNull();
    });

    it("keeps a draft saved since", () => {
      saveNewPortfolioDraft(ALICE, balanced({ name: "Signed" }), []);
      const signed = readNewPortfolioDraft(ALICE)!;
      vi.advanceTimersByTime(1000);
      saveNewPortfolioDraft(ALICE, balanced({ name: "Newer" }), []);
      discardNewPortfolioDraftIfUnchanged(ALICE, signed.updatedAt);
      expect(readNewPortfolioDraft(ALICE)?.name).toBe("Newer");
    });

    it("touches no other account, and nothing when there is no draft", () => {
      saveNewPortfolioDraft(BOB, balanced({ name: "Bob's" }), []);
      const bobs = readNewPortfolioDraft(BOB)!;
      discardNewPortfolioDraftIfUnchanged(ALICE, bobs.updatedAt);
      expect(readNewPortfolioDraft(BOB)?.name).toBe("Bob's");
    });
  });

  // D-457 — the simulation's amount: saved with the draft by the editor, alone by its tab.
  describe("simulation amount", () => {
    it("the editor's save keeps it, and drops an unusable one", () => {
      saveNewPortfolioDraft(ALICE, balanced({ simulationUsd: 10 }), []);
      expect(readNewPortfolioDraft(ALICE)?.simulationUsd).toBe(10);
      saveNewPortfolioDraft(ALICE, balanced({ simulationUsd: 0 }), []);
      expect(readNewPortfolioDraft(ALICE)).not.toHaveProperty("simulationUsd");
    });

    it("writing the amount alone does not move updatedAt", () => {
      saveNewPortfolioDraft(ALICE, balanced({ name: "Mine" }), []);
      const saved = readNewPortfolioDraft(ALICE)!;
      vi.advanceTimersByTime(60_000);
      saveNewPortfolioDraftSimulationUsd(ALICE, 25);
      expect(readNewPortfolioDraft(ALICE)).toEqual({ ...saved, simulationUsd: 25 });
    });

    it("a confirmation still retires the draft it signed after the amount changed", () => {
      saveNewPortfolioDraft(ALICE, balanced({ name: "Signed" }), []);
      const signed = readNewPortfolioDraft(ALICE)!;
      vi.advanceTimersByTime(1000);
      saveNewPortfolioDraftSimulationUsd(ALICE, 25);
      discardNewPortfolioDraftIfUnchanged(ALICE, signed.updatedAt);
      expect(readNewPortfolioDraft(ALICE)).toBeNull();
    });

    it("writes nothing without a draft, for an unusable amount or for the same amount", () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      saveNewPortfolioDraftSimulationUsd(ALICE, 25);
      expect(window.localStorage.getItem(NEW_PORTFOLIO_DRAFT_KEY)).toBeNull();

      saveNewPortfolioDraft(ALICE, balanced({ simulationUsd: 25 }), []);
      setItem.mockClear();
      saveNewPortfolioDraftSimulationUsd(ALICE, 25);
      saveNewPortfolioDraftSimulationUsd(ALICE, 0);
      saveNewPortfolioDraftSimulationUsd(ALICE, Number.NaN);
      saveNewPortfolioDraftSimulationUsd("", 30);
      expect(setItem).not.toHaveBeenCalled();
      setItem.mockRestore();
    });

    it("does not write over an invalid stored entry, nor touch another account", () => {
      window.localStorage.setItem(NEW_PORTFOLIO_DRAFT_KEY, JSON.stringify({ [ALICE]: { v: 1, name: "" } }));
      saveNewPortfolioDraft(BOB, balanced({ name: "Bob's" }), []);
      const before = window.localStorage.getItem(NEW_PORTFOLIO_DRAFT_KEY);
      saveNewPortfolioDraftSimulationUsd(ALICE, 25);
      expect(window.localStorage.getItem(NEW_PORTFOLIO_DRAFT_KEY)).toBe(before);
    });
  });
});

// D-359 — a draft built with no wallet connected, and its move to the account on connecting.
describe("anonymous draft", () => {
  const ALICE = "alice.near";
  const T0 = Date.parse("2026-09-29T12:00:00Z");
  const rawStore = () => window.localStorage.getItem(NEW_PORTFOLIO_DRAFT_KEY);
  const putRaw = (entries: Record<string, unknown>) =>
    window.localStorage.setItem(NEW_PORTFOLIO_DRAFT_KEY, JSON.stringify(entries));

  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("cannot collide with an intents account id (named, implicit hex, 0x)", () => {
    for (const id of ["alice.near", "a".repeat(64), "0x1234567890abcdef1234567890abcdef12345678"]) {
      expect(id).not.toContain("*");
    }
    expect(ANONYMOUS_DRAFT_SLOT).toContain("*");
  });

  it("saves, reads and discards like an account's, without touching the accounts'", () => {
    saveNewPortfolioDraft(ALICE, balanced({ name: "Alice's" }), []);
    expect(saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, balanced({ name: "Anon" }), [])).toEqual({ ok: true });
    expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)?.name).toBe("Anon");
    discardNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT);
    expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)).toBeNull();
    expect(readNewPortfolioDraft(ALICE)?.name).toBe("Alice's");
  });

  describe("moveAnonymousDraftToAccount", () => {
    it("without an anonymous draft: nothing to move and nothing written", () => {
      saveNewPortfolioDraft(ALICE, balanced({ name: "Alice's" }), []);
      const before = rawStore();
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      expect(moveAnonymousDraftToAccount(ALICE)).toBe("none");
      expect(setItem).not.toHaveBeenCalled();
      expect(rawStore()).toBe(before);
    });

    it("moves it to an account with no draft, keeping its time, and empties the slot", () => {
      saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, balanced({ name: "Anon" }), []);
      vi.advanceTimersByTime(60_000);
      expect(moveAnonymousDraftToAccount(ALICE)).toBe("moved");
      expect(readNewPortfolioDraft(ALICE)).toEqual({ v: 1, ...balanced({ name: "Anon" }), updatedAt: T0 });
      expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)).toBeNull();
      expect(Object.keys(JSON.parse(rawStore()!))).toEqual([ALICE]);
    });

    it("a newer anonymous draft replaces the account's", () => {
      saveNewPortfolioDraft(ALICE, balanced({ name: "Alice's" }), []);
      vi.advanceTimersByTime(1000);
      saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, balanced({ name: "Anon" }), []);
      expect(moveAnonymousDraftToAccount(ALICE)).toBe("moved");
      expect(readNewPortfolioDraft(ALICE)?.name).toBe("Anon");
      expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)).toBeNull();
    });

    it("a newer account draft stays, and the anonymous one is dropped", () => {
      saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, balanced({ name: "Anon" }), []);
      vi.advanceTimersByTime(1000);
      saveNewPortfolioDraft(ALICE, balanced({ name: "Alice's" }), []);
      const own = readNewPortfolioDraft(ALICE);
      expect(moveAnonymousDraftToAccount(ALICE)).toBe("kept-account");
      expect(readNewPortfolioDraft(ALICE)).toEqual(own);
      expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)).toBeNull();
    });

    // D-457: an amount typed later does not make a draft "newer" — the design decides.
    it("keeps its amount when moved, and an amount typed later does not make it win", () => {
      saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, balanced({ name: "Anon", simulationUsd: 10 }), []);
      expect(moveAnonymousDraftToAccount(ALICE)).toBe("moved");
      expect(readNewPortfolioDraft(ALICE)?.simulationUsd).toBe(10);

      window.localStorage.clear();
      saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, balanced({ name: "Anon" }), []);
      vi.advanceTimersByTime(1000);
      saveNewPortfolioDraft(ALICE, balanced({ name: "Alice's" }), []);
      vi.advanceTimersByTime(1000);
      saveNewPortfolioDraftSimulationUsd(ANONYMOUS_DRAFT_SLOT, 10);
      expect(moveAnonymousDraftToAccount(ALICE)).toBe("kept-account");
      expect(readNewPortfolioDraft(ALICE)?.name).toBe("Alice's");
    });

    it("a tie keeps the account's", () => {
      saveNewPortfolioDraft(ALICE, balanced({ name: "Alice's" }), []);
      saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, balanced({ name: "Anon" }), []);
      expect(moveAnonymousDraftToAccount(ALICE)).toBe("kept-account");
      expect(readNewPortfolioDraft(ALICE)?.name).toBe("Alice's");
      expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)).toBeNull();
    });

    it("an invalid anonymous entry is dropped and the account's draft is untouched", () => {
      saveNewPortfolioDraft(ALICE, balanced({ name: "Alice's" }), []);
      const store = JSON.parse(rawStore()!);
      store[ANONYMOUS_DRAFT_SLOT] = { v: 1, ...withRows(row(BTC, 50), row(ETH, 49.99)), updatedAt: T0 + 5000 };
      putRaw(store);
      expect(moveAnonymousDraftToAccount(ALICE)).toBe("none");
      expect(readNewPortfolioDraft(ALICE)?.name).toBe("Alice's");
      expect(Object.keys(JSON.parse(rawStore()!))).toEqual([ALICE]);
    });

    it("an invalid account entry does not beat a valid anonymous draft, however new", () => {
      putRaw({
        [ALICE]: { v: 1, name: 42, updatedAt: T0 + 5000 },
        [ANONYMOUS_DRAFT_SLOT]: { v: 1, ...balanced({ name: "Anon" }), updatedAt: T0 },
      });
      expect(moveAnonymousDraftToAccount(ALICE)).toBe("moved");
      expect(readNewPortfolioDraft(ALICE)?.name).toBe("Anon");
    });

    it("writes the store once and notifies once", () => {
      saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, balanced({ name: "Anon" }), []);
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const listener = vi.fn();
      const unsubscribe = subscribeNewPortfolioDrafts(listener);
      moveAnonymousDraftToAccount(ALICE);
      unsubscribe();
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("leaves other accounts' drafts alone", () => {
      saveNewPortfolioDraft("bob.near", balanced({ name: "Bob's" }), []);
      saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, balanced({ name: "Anon" }), []);
      moveAnonymousDraftToAccount(ALICE);
      expect(readNewPortfolioDraft("bob.near")?.name).toBe("Bob's");
    });

    it("needs a real account: with none (or the slot itself) nothing moves", () => {
      saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, balanced({ name: "Anon" }), []);
      expect(moveAnonymousDraftToAccount("")).toBe("none");
      expect(moveAnonymousDraftToAccount(ANONYMOUS_DRAFT_SLOT)).toBe("none");
      expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)?.name).toBe("Anon");
    });

    it("corrupt storage: nothing to move and nothing written", () => {
      window.localStorage.setItem(NEW_PORTFOLIO_DRAFT_KEY, "{not json");
      expect(moveAnonymousDraftToAccount(ALICE)).toBe("none");
      expect(rawStore()).toBe("{not json");
    });
  });
});

describe("subscribeNewPortfolioDrafts", () => {
  beforeEach(() => window.localStorage.clear());

  it("notifies on a same-tab save and discard", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNewPortfolioDrafts(listener);
    saveNewPortfolioDraft("alice.near", balanced(), []);
    discardNewPortfolioDraft("alice.near");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("does not notify for a refused save", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNewPortfolioDrafts(listener);
    saveNewPortfolioDraft("alice.near", withRows(), []);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("notifies on another tab's write to this key (or a clear), not on other keys", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNewPortfolioDrafts(listener);
    window.dispatchEvent(new StorageEvent("storage", { key: NEW_PORTFOLIO_DRAFT_KEY }));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    window.dispatchEvent(new StorageEvent("storage", { key: "portfolio.draft.v1" }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    subscribeNewPortfolioDrafts(listener)();
    saveNewPortfolioDraft("alice.near", balanced(), []);
    window.dispatchEvent(new StorageEvent("storage", { key: NEW_PORTFOLIO_DRAFT_KEY }));
    expect(listener).not.toHaveBeenCalled();
  });
});

// D-397 (plan 041, P3): the same rule `moveAnonymousDraftToAccount` applies, told beforehand.
describe("draftsReplacedOnConnect", () => {
  const stored = (name: string, updatedAt: number) => ({
    v: 1,
    name,
    presetId: null,
    updatedAt,
    rows: [{ tokenId: "near", targetPct: 100, tolerancePct: 10, locked: false }],
  });
  const raw = (store: Record<string, unknown>) => JSON.stringify(store);

  it("lists the accounts' older drafts, the most recent first", () => {
    expect(
      draftsReplacedOnConnect(
        raw({ [ANONYMOUS_DRAFT_SLOT]: stored("Anon", 100), "a.near": stored("Old", 10), "b.near": stored("Recent", 90) })
      )
    ).toEqual([
      { accountId: "b.near", name: "Recent" },
      { accountId: "a.near", name: "Old" },
    ]);
  });

  it.each([
    ["no anonymous draft", { "a.near": stored("Mine", 10) }],
    ["an invalid anonymous draft", { [ANONYMOUS_DRAFT_SLOT]: { v: 1 }, "a.near": stored("Mine", 10) }],
    ["no account draft", { [ANONYMOUS_DRAFT_SLOT]: stored("Anon", 100) }],
    ["an invalid account draft", { [ANONYMOUS_DRAFT_SLOT]: stored("Anon", 100), "a.near": { v: 1 } }],
    // Then the anonymous one is what goes on connecting, so there is nothing to warn about.
    ["a newer account draft", { [ANONYMOUS_DRAFT_SLOT]: stored("Anon", 100), "a.near": stored("Mine", 200) }],
    ["a tie, which keeps the account's", { [ANONYMOUS_DRAFT_SLOT]: stored("Anon", 100), "a.near": stored("Mine", 100) }],
  ])("lists nothing with %s", (_label, store) => {
    expect(draftsReplacedOnConnect(raw(store))).toEqual([]);
  });

  it("lists nothing on corrupt or empty storage", () => {
    expect(draftsReplacedOnConnect("{not json")).toEqual([]);
    expect(draftsReplacedOnConnect("")).toEqual([]);
  });

  it("agrees with what connecting does", () => {
    window.localStorage.setItem(
      NEW_PORTFOLIO_DRAFT_KEY,
      raw({ [ANONYMOUS_DRAFT_SLOT]: stored("Anon", 100), "a.near": stored("Mine", 10), "b.near": stored("Later", 200) })
    );
    const listed = draftsReplacedOnConnect(window.localStorage.getItem(NEW_PORTFOLIO_DRAFT_KEY) ?? "");
    expect(listed.map((d) => d.accountId)).toEqual(["a.near"]);
    expect(moveAnonymousDraftToAccount("a.near")).toBe("moved");
    expect(readNewPortfolioDraft("a.near")?.name).toBe("Anon");
  });
});
