// New Portfolio Draft (016 block 2, §7). A portfolio the user designs BEFORE depositing:
// tokens, target %, tolerances and a name, kept in this browser until funds arrive and the
// user confirms it with the one Setup signature. It is not a Portfolio — nothing is on
// chain until that signature — and it is unrelated to `DraftState` / "portfolio.draft.v1",
// which is the in-flight EDIT of an existing portfolio's composition.
//
// One per intents account, plus one for a visitor with no wallet connected (D-359), which
// moves to their account when they connect. Its own key namespace ("portfolio.new-draft.v1"),
// outside the provider's one-time sweep of "portfolio.portfolios.*", like portfolio-draft-store.
//
// Validated on save AND on read with the vault's own composition check, because the draft
// becomes the Setup's composition verbatim: a draft the vault would refuse must never
// survive to the moment the user has already deposited and is asked to sign.

import type { TokenId } from "@/features/intents-account/mock-contract/types";
import {
  TOLERANCE_MAX_PCT,
  TOLERANCE_MIN_PCT,
} from "@/features/intents-account/mock-contract/rules";
import { isPortfolioOfferable } from "@/features/bridge/lib/token-availability";
import { depositableTokens } from "@/features/market/lib/token-registry";
import { toIntentsTokenId } from "@/features/market/lib/intents-token-id";
import {
  APP_MAX_TOKENS_PER_PORTFOLIO,
  ChangeSetPreflightError,
  MAX_TOKENS_PER_PORTFOLIO,
  assertValidComposition,
  pctToBps,
} from "@/features/vault/lib/change-set-preflight";
import { getPreset, type PresetId } from "@/content/portfolio-presets";
import type { TargetAllocation } from "@/features/portfolio-editor/types";
import { validatePortfolioName } from "./portfolio-validation";
import { SIMULATION_MAX_USD } from "./new-portfolio-draft-simulation";
// 029 B-23: a draft that goes takes its "funds to assign" answer with it.
import { DRAFT_SUBJECT, forgetAssignFundsPrompt } from "./assign-funds-prompt";

export const NEW_PORTFOLIO_DRAFT_KEY = "portfolio.new-draft.v1";

/**
 * D-359 — where a signed-out visitor's draft lives, in the same store as the accounts'. `*`
 * appears in no intents account id (a NEAR name, implicit hex, `0x…`), so it cannot collide.
 */
export const ANONYMOUS_DRAFT_SLOT = "*anonymous";

export type NewPortfolioDraftRow = {
  tokenId: TokenId;
  targetPct: number;
  tolerancePct: number;
  locked: boolean;
};

export type NewPortfolioDraft = {
  v: 1;
  name: string;
  // The preset the draft started from, or null for "start from scratch". A label of origin
  // only: the rows are what gets signed.
  presetId: PresetId | null;
  rows: NewPortfolioDraftRow[];
  updatedAt: number;
  // D-457 — the D-358 simulation's amount, so it follows the draft from the editor to its tab,
  // across reloads and into the account on connecting. Absent (drafts saved before it) reads as
  // `SIMULATION_DEFAULT_USD`. Not part of the design: it is never signed or validated with it.
  simulationUsd?: number;
};

/** What the editor hands over on save; the store stamps `v` and `updatedAt`. */
export type NewPortfolioDraftInput = Pick<NewPortfolioDraft, "name" | "presetId" | "rows" | "simulationUsd">;

/** An amount the simulation can open with: finite, positive and within its field's ceiling. */
export function isValidSimulationUsd(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= SIMULATION_MAX_USD;
}

export type NewPortfolioDraftInvalidReason =
  | "invalid-name"
  | "no-rows"
  | "too-many-rows"
  | "unknown-token"
  | "duplicate-token"
  | "target-not-positive"
  | "target-precision"
  | "tolerance-out-of-range"
  | "tolerance-precision"
  | "targets-not-100"
  | "composition-rejected"
  | "no-account";

export type NewPortfolioDraftValidation =
  | { ok: true }
  | {
      ok: false;
      reason: NewPortfolioDraftInvalidReason;
      tokenId?: TokenId;
      // The `validatePortfolioName` error key (a translation key) when reason is "invalid-name".
      nameError?: string;
    };

// What a draft may hold: what the editor's picker offers — depositable and in the curated
// catalog (D-396) and withdrawable today (D-389). A saved draft with any other token reads
// as invalid.
const DEPOSITABLE_IDS = new Set<string>(
  depositableTokens.filter((t) => isPortfolioOfferable(t.id)).map((t) => t.id)
);

// The editor's redistribution works at 2 decimals (`Number(x.toFixed(2))`), and 2 decimals
// of a percent is exactly one basis point. More precision would be rounded by `pctToBps`, so
// the user would sign a number other than the one on screen — refused instead.
function hasAtMostTwoDecimals(n: number): boolean {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

/**
 * Whether a draft can be saved and, later, signed as a Setup composition.
 *
 * `existingNames` are the account's current portfolio names (duplicate check). Pass `[]`
 * to validate only what the draft itself controls — which is what a read does: a name that
 * collides with a portfolio created since is fixable in the editor, and dropping the whole
 * draft for it would throw away the user's work.
 *
 * Rows are checked before the bps composition gate so the reason names the row at fault;
 * the gate then runs anyway, on the same ids and units `run-real-allocate` sends.
 */
export function validateNewPortfolioDraft(
  draft: NewPortfolioDraftInput,
  existingNames: string[],
  /**
   * The app's cap (D-528) for the editor and for saving. Reading a stored draft passes the
   * vault's 32: a draft saved before the cap would otherwise vanish without a word; the editor
   * then shows it as too many tokens, to trim.
   */
  maxRows: number = APP_MAX_TOKENS_PER_PORTFOLIO
): NewPortfolioDraftValidation {
  const name = validatePortfolioName(draft.name, existingNames);
  if (!name.ok) return { ok: false, reason: "invalid-name", nameError: name.error };

  if (draft.rows.length === 0) return { ok: false, reason: "no-rows" };
  if (draft.rows.length > maxRows) return { ok: false, reason: "too-many-rows" };

  const seen = new Set<string>();
  for (const row of draft.rows) {
    const { tokenId } = row;
    if (!DEPOSITABLE_IDS.has(tokenId)) return { ok: false, reason: "unknown-token", tokenId };
    if (seen.has(tokenId)) return { ok: false, reason: "duplicate-token", tokenId };
    seen.add(tokenId);

    // A 0% row is not allowed: in a draft there are no funds to keep it alive
    // (`zero-target-zero-balance`), so the token is removed instead.
    if (!Number.isFinite(row.targetPct) || row.targetPct <= 0) {
      return { ok: false, reason: "target-not-positive", tokenId };
    }
    if (!hasAtMostTwoDecimals(row.targetPct)) return { ok: false, reason: "target-precision", tokenId };

    if (
      !Number.isFinite(row.tolerancePct) ||
      row.tolerancePct < TOLERANCE_MIN_PCT ||
      row.tolerancePct > TOLERANCE_MAX_PCT
    ) {
      return { ok: false, reason: "tolerance-out-of-range", tokenId };
    }
    if (!hasAtMostTwoDecimals(row.tolerancePct)) {
      return { ok: false, reason: "tolerance-precision", tokenId };
    }
  }

  // The same conversion and the same check the Setup runs before asking for a signature
  // (run-real-allocate.ts), so a saved draft is one the vault accepts.
  try {
    assertValidComposition(
      draft.rows.map((row) => ({
        tokenId: toIntentsTokenId(row.tokenId),
        targetBps: pctToBps(row.targetPct),
        toleranceBps: pctToBps(row.tolerancePct),
      }))
    );
  } catch (e) {
    if (e instanceof ChangeSetPreflightError && e.reason === "targets-not-100") {
      return { ok: false, reason: "targets-not-100" };
    }
    return { ok: false, reason: "composition-rejected" };
  }

  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRow(value: unknown): NewPortfolioDraftRow | null {
  if (!isRecord(value)) return null;
  const { tokenId, targetPct, tolerancePct, locked } = value;
  if (typeof tokenId !== "string") return null;
  if (typeof targetPct !== "number" || typeof tolerancePct !== "number") return null;
  if (typeof locked !== "boolean") return null;
  return { tokenId, targetPct, tolerancePct, locked };
}

/**
 * A stored value → a draft, or null. Never throws: storage is user-writable and outlives
 * releases (a token can leave the registry, a rule can tighten), so anything that is not a
 * currently valid draft reads as "no draft".
 */
export function parseNewPortfolioDraft(value: unknown): NewPortfolioDraft | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const { name, presetId, rows, updatedAt, simulationUsd } = value;
  if (typeof name !== "string" || !Array.isArray(rows)) return null;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  if (presetId !== null && typeof presetId !== "string") return null;

  const parsedRows: NewPortfolioDraftRow[] = [];
  for (const row of rows) {
    const parsed = parseRow(row);
    if (!parsed) return null;
    parsedRows.push(parsed);
  }

  const draft: NewPortfolioDraft = {
    v: 1,
    name,
    // A preset retired since the draft was saved only loses its label; the rows stand alone.
    presetId: presetId !== null && getPreset(presetId as PresetId) ? (presetId as PresetId) : null,
    rows: parsedRows,
    updatedAt,
  };
  // An unusable amount is dropped, not the draft: it is a reference figure, not the design.
  if (isValidSimulationUsd(simulationUsd)) draft.simulationUsd = simulationUsd;
  return validateNewPortfolioDraft(draft, [], MAX_TOKENS_PER_PORTFOLIO).ok ? draft : null;
}

/**
 * Draft rows → the editor's `TargetAllocation[]`, the shape `buildChangeSet([], targets,
 * allocations)` turns into the Setup's `tokenAdditions`. Row ids (`target-<tokenId>`) are UI-only
 * and never reach the changeset.
 */
export function draftToTargets(draft: Pick<NewPortfolioDraft, "rows">): TargetAllocation[] {
  return draft.rows.map((row) => ({
    id: `target-${row.tokenId}`,
    tokenId: row.tokenId,
    targetPct: row.targetPct,
    tolerancePct: row.tolerancePct,
    locked: row.locked,
  }));
}

// ── Storage, per intents account ─────────────────────────────────────────────

// intentsAccountId (or ANONYMOUS_DRAFT_SLOT) -> stored draft (unvalidated)
type DraftStore = Record<string, unknown>;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * The raw stored string: the `useSyncExternalStore` snapshot. A string compares by value,
 * so an unchanged store yields the same snapshot and no re-render; parsing happens per
 * account in the reader.
 */
export function getNewPortfolioDraftsSnapshot(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(NEW_PORTFOLIO_DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Same-tab writes notify directly; another tab's writes arrive as a `storage` event. */
export function subscribeNewPortfolioDrafts(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    // `key === null` is a `localStorage.clear()` from another tab.
    if (e.key === NEW_PORTFOLIO_DRAFT_KEY || e.key === null) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

function parseStore(raw: string): DraftStore {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {}; // corrupt storage — no drafts
  }
}

/** The account's draft within a snapshot string, validated. */
export function draftFromSnapshot(raw: string, accountId: string): NewPortfolioDraft | null {
  if (!accountId) return null;
  const store = parseStore(raw);
  return Object.prototype.hasOwnProperty.call(store, accountId)
    ? parseNewPortfolioDraft(store[accountId])
    : null;
}

export function readNewPortfolioDraft(accountId: string): NewPortfolioDraft | null {
  return draftFromSnapshot(getNewPortfolioDraftsSnapshot(), accountId);
}

function writeStore(store: DraftStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NEW_PORTFOLIO_DRAFT_KEY, JSON.stringify(store));
  } catch {
    /* ignore quota / serialization errors */
  }
  notify();
}

/**
 * Save (create or replace) the account's draft. Refuses an invalid one — the editor's
 * button is disabled for it, and this is the second lock on the same door.
 */
export function saveNewPortfolioDraft(
  accountId: string,
  input: NewPortfolioDraftInput,
  existingNames: string[]
): NewPortfolioDraftValidation {
  if (!accountId) return { ok: false, reason: "no-account" };
  const draft: NewPortfolioDraftInput = {
    name: input.name.trim(),
    presetId: input.presetId,
    rows: input.rows.map((row) => ({ ...row })),
  };
  const result = validateNewPortfolioDraft(draft, existingNames);
  if (!result.ok) return result;

  const store = parseStore(getNewPortfolioDraftsSnapshot());
  const stored: NewPortfolioDraft = { v: 1, ...draft, updatedAt: Date.now() };
  if (isValidSimulationUsd(input.simulationUsd)) stored.simulationUsd = input.simulationUsd;
  store[accountId] = stored;
  writeStore(store);
  return result;
}

/**
 * D-457 — the draft's tab writes the simulation's amount alone. `updatedAt` stays: it says when
 * the design was last saved, and it decides which draft wins on connecting
 * (`moveAnonymousDraftToAccount`) and whether a signed draft is still the one to discard
 * (`discardNewPortfolioDraftIfUnchanged`). Typing an amount must change neither. No draft, an
 * invalid one or an unusable amount writes nothing.
 */
export function saveNewPortfolioDraftSimulationUsd(accountId: string, simulationUsd: number): void {
  if (!accountId || !isValidSimulationUsd(simulationUsd)) return;
  const store = parseStore(getNewPortfolioDraftsSnapshot());
  const stored = store[accountId];
  if (!isRecord(stored) || !parseNewPortfolioDraft(stored)) return;
  if (stored.simulationUsd === simulationUsd) return;
  store[accountId] = { ...stored, simulationUsd };
  writeStore(store);
}

export function discardNewPortfolioDraft(accountId: string): void {
  if (!accountId) return;
  const store = parseStore(getNewPortfolioDraftsSnapshot());
  if (!Object.prototype.hasOwnProperty.call(store, accountId)) return;
  delete store[accountId];
  writeStore(store);
  forgetAssignFundsPrompt(accountId, DRAFT_SUBJECT);
}

/**
 * Discard the account's draft only if it is still the one saved at `updatedAt` — the one a
 * confirmation just signed. Another tab may have replaced it meanwhile (discarded it and saved
 * a new design): that newer draft is not what was signed, and deleting it would throw away the
 * user's work.
 */
export function discardNewPortfolioDraftIfUnchanged(accountId: string, updatedAt: number): void {
  if (!accountId) return;
  const store = parseStore(getNewPortfolioDraftsSnapshot());
  const stored = store[accountId];
  if (!isRecord(stored) || stored.updatedAt !== updatedAt) return;
  delete store[accountId];
  writeStore(store);
  forgetAssignFundsPrompt(accountId, DRAFT_SUBJECT);
}

export type ReplacedOnConnect = { accountId: string; name: string };

/**
 * D-397 (plan 041, P3): the accounts' drafts in this browser that the anonymous draft would replace
 * if that account connected, the most recently saved first. Only those saved before it: the older
 * of the two is the one `moveAnonymousDraftToAccount` drops, so with a newer account draft it is the
 * anonymous one that goes, and there is nothing to warn about here.
 */
export function draftsReplacedOnConnect(raw: string): ReplacedOnConnect[] {
  const store = parseStore(raw);
  if (!Object.prototype.hasOwnProperty.call(store, ANONYMOUS_DRAFT_SLOT)) return [];
  const anonymous = parseNewPortfolioDraft(store[ANONYMOUS_DRAFT_SLOT]);
  if (!anonymous) return [];
  return Object.entries(store)
    .flatMap(([accountId, stored]) => {
      if (accountId === ANONYMOUS_DRAFT_SLOT) return [];
      const draft = parseNewPortfolioDraft(stored);
      return draft && anonymous.updatedAt > draft.updatedAt ? [{ accountId, draft }] : [];
    })
    .sort((a, b) => b.draft.updatedAt - a.draft.updatedAt)
    .map(({ accountId, draft }) => ({ accountId, name: draft.name }));
}

export type MoveAnonymousDraftResult = "moved" | "kept-account" | "none";

/**
 * D-359 — on connecting, the draft built without a wallet goes to the account. With a draft
 * of the account's own in this browser as well, the one saved last wins (E2) and the other is
 * dropped; a tie keeps the account's. The anonymous slot is emptied either way, invalid
 * entries included.
 *
 * One read and one write of the whole store, so the draft is never in both places or in
 * neither. The moved draft keeps its `updatedAt`: it is the same design, not a new save.
 */
export function moveAnonymousDraftToAccount(accountId: string): MoveAnonymousDraftResult {
  if (!accountId || accountId === ANONYMOUS_DRAFT_SLOT) return "none";
  const store = parseStore(getNewPortfolioDraftsSnapshot());
  if (!Object.prototype.hasOwnProperty.call(store, ANONYMOUS_DRAFT_SLOT)) return "none";

  const anonymous = parseNewPortfolioDraft(store[ANONYMOUS_DRAFT_SLOT]);
  delete store[ANONYMOUS_DRAFT_SLOT];
  let result: MoveAnonymousDraftResult = "none";
  if (anonymous) {
    const own = Object.prototype.hasOwnProperty.call(store, accountId)
      ? parseNewPortfolioDraft(store[accountId])
      : null;
    if (own === null || anonymous.updatedAt > own.updatedAt) {
      store[accountId] = anonymous;
      result = "moved";
    } else {
      result = "kept-account";
    }
  }
  writeStore(store);
  return result;
}
