// Offline mirror of the vault's composition validators, run BEFORE the wallet is asked to
// sign (008.plan, Phase 2). Every rule here is a rule the contract already enforces; the
// point is *where* the user finds out.
//
// Why this is not belt-and-braces:
//   - On the COMMIT path a rejection is cheap (nothing moves, the funds stay in the
//     portfolio) but it still costs a signature, a transaction and a confusing
//     `E_INVALID_COMPOSITION` — one opaque string for all fourteen distinct failures.
//   - On the ALLOCATE path it is not cheap at all. A Setup whose composition the vault
//     refuses is the orphan case: `execute_intents` settles the Transfer, `on_auth` panics,
//     and the funds sit in the vault credited to no portfolio until an operator runs
//     `credit_pending_allocation`. Catching a malformed composition here is the difference
//     between an inline error and a manual rescue.
//
// THE ROUNDING RULE IS THE REASON THIS EXISTS. The editor works in percent floats; the
// contract demands `Σ target_bps == 10000` EXACTLY. A composition of 33.333/33.333/33.334
// sums to 100.0 in floats and to 9999 in basis points. The editor's own gate
// (`Math.abs(sum - 100) > 0.001`) passes it; the vault rejects it. Only a check performed
// after the pct→bps conversion can see that, so every value below is in bps, converted by
// the caller, never re-derived here.
//
// Attribution: see ATTRIBUTIONS.md #8 (IntentFolio vault contract — composition.rs
// `validate_composition` / `validate_change_set` / `resulting_composition`, state.rs caps).

// ── Caps and bounds, mirrored from the vault's `get_config().limits` ──────────
// The signing paths never use these: they validate against the chain's own limits, read once
// per page load (vault-limits.ts). The mirror is for what runs before any vault is read — the
// New Portfolio Draft (anonymous included) and the mock contract — so a draft the app accepts
// is one the vault accepts. Checked against `intentfolio-vault.near` on 2026-10-04 (D-366).
export const TARGET_SUM_BPS = 10_000;
export const TOLERANCE_MIN_BPS = 200;
export const TOLERANCE_MAX_BPS = 3_000;
export const MAX_TOKENS_PER_PORTFOLIO = 32;
export const MAX_COMPOSITION_CHANGES_PER_COMMIT = 64;
export const MAX_UNALLOC_LEGS_PER_COMMIT = 32;
export const MAX_TOKEN_ID_LEN = 128;
export const MAX_PORTFOLIOS_PER_ACCOUNT = 16;
export const MAX_PORTFOLIO_NAME_LEN = 128;
export const MAX_WALLET_ADDRESS_LEN = 128;

/**
 * Not a mirror: the app's own cap on portfolios per account (D-476), under the vault's 16 until
 * the final contract lowers its own (008.plan, final-contract change #12). The relay refuses
 * to pay for a Setup past it (relay-gate.ts, D-371). Read it through `appPortfolioCap`.
 */
export const APP_MAX_PORTFOLIOS_PER_ACCOUNT = 7;

/**
 * Not a mirror: the app's own cap on a portfolio's composition (D-528), under the vault's 32.
 * The Setup's Storage Cost pays for what the portfolio stores at creation; tokens joining later
 * are not charged, so this bounds that growth. It only stops a composition from GROWING past it:
 * a portfolio already above it can still retarget, remove and swap one for one. The relay
 * refuses to pay for a Setup or a commit that grows past it (relay-gate.ts). Legs are not
 * capped by it: a Setup's funds-only tokens are charged too.
 */
export const APP_MAX_TOKENS_PER_PORTFOLIO = 10;

/** Whether a composition going from `before` to `after` tokens grows past the app's cap. */
export function growsPastAppTokenCap(before: number, after: number): boolean {
  return after > APP_MAX_TOKENS_PER_PORTFOLIO && after > before;
}

/** The rules the vault enforces: the chain's (`get_config`) on a signing path, the mirror above otherwise. */
export type PreflightLimits = {
  targetSumBps: number;
  toleranceMinBps: number;
  toleranceMaxBps: number;
  maxTokensPerPortfolio: number;
  maxCompositionChangesPerCommit: number;
  maxUnallocLegsPerCommit: number;
  maxTokenIdLen: number;
  /** Checked by `apply_setup` — inside `on_auth`, so the 17th is an orphan (D-361). */
  maxPortfoliosPerAccount: number;
  /** UTF-8 bytes. */
  maxPortfolioNameLen: number;
  /** UTF-8 bytes. */
  maxWalletAddressLen: number;
};

export const MIRRORED_LIMITS: PreflightLimits = {
  targetSumBps: TARGET_SUM_BPS,
  toleranceMinBps: TOLERANCE_MIN_BPS,
  toleranceMaxBps: TOLERANCE_MAX_BPS,
  maxTokensPerPortfolio: MAX_TOKENS_PER_PORTFOLIO,
  maxCompositionChangesPerCommit: MAX_COMPOSITION_CHANGES_PER_COMMIT,
  maxUnallocLegsPerCommit: MAX_UNALLOC_LEGS_PER_COMMIT,
  maxTokenIdLen: MAX_TOKEN_ID_LEN,
  maxPortfoliosPerAccount: MAX_PORTFOLIOS_PER_ACCOUNT,
  maxPortfolioNameLen: MAX_PORTFOLIO_NAME_LEN,
  maxWalletAddressLen: MAX_WALLET_ADDRESS_LEN,
};

/** One composition row exactly as the contract stores it: basis points, never percent. */
export type CompositionRowBps = {
  tokenId: string;
  targetBps: number;
  toleranceBps: number;
};

export type ChangeSetBps = {
  targetChanges: CompositionRowBps[];
  tokenAdditions: CompositionRowBps[];
  tokenRemovals: string[];
  /** Base units as decimal strings — the same shape the envelope carries. */
  unallocations: Array<{ tokenId: string; amount: string }>;
};

/**
 * Why the vault would refuse. One code per distinct failure, because the contract collapses
 * all of them into the single ABI string `E_INVALID_COMPOSITION` — the specificity only
 * exists on this side, and it is the whole reason to check here.
 */
export type PreflightReason =
  | "addition-present-token"
  | "retarget-absent-token"
  | "removal-absent-token"
  | "duplicate-token"
  | "duplicate-unallocation"
  | "zero-unallocation"
  | "tolerance-out-of-band"
  | "target-above-max"
  | "targets-not-100"
  | "empty-composition"
  | "token-id-too-long"
  | "too-many-tokens"
  | "too-many-changes"
  | "too-many-legs"
  | "too-many-portfolios"
  | "name-too-long"
  | "address-too-long"
  /** Not the vault's: the app's own cap on a growing composition (D-528). */
  | "app-too-many-tokens";

export class ChangeSetPreflightError extends Error {
  constructor(
    readonly reason: PreflightReason,
    /** Free-form context for logs and the wet-test trail; never user-facing copy. */
    readonly detail: string
  ) {
    super(`Vault would reject this change set: ${reason} (${detail})`);
    this.name = "ChangeSetPreflightError";
  }
}

function fail(reason: PreflightReason, detail: string): never {
  throw new ChangeSetPreflightError(reason, detail);
}

// Rust's `String::len()` is BYTES, so a multi-byte token id must be measured the same way.
const utf8 = new TextEncoder();

const utf8Length = (text: string) => utf8.encode(text).length;

function checkTokenId(tokenId: string, limits: PreflightLimits): void {
  if (utf8Length(tokenId) > limits.maxTokenIdLen) {
    fail("token-id-too-long", tokenId.slice(0, 40));
  }
}

// The tolerance floor applies to a 0% target too, although the contract would take `0` there:
// with the band `[0, 0]` unsellable dust stays out of band for good (D-334), so the floor is ours.
function checkTolerance(row: CompositionRowBps, limits: PreflightLimits): void {
  if (
    !Number.isInteger(row.toleranceBps) ||
    row.toleranceBps < limits.toleranceMinBps ||
    row.toleranceBps > limits.toleranceMaxBps
  ) {
    fail("tolerance-out-of-band", `${row.tokenId}=${row.toleranceBps}bps`);
  }
}

function checkTarget(row: CompositionRowBps, limits: PreflightLimits): void {
  if (!Number.isInteger(row.targetBps) || row.targetBps < 0 || row.targetBps > limits.targetSumBps) {
    fail("target-above-max", `${row.tokenId}=${row.targetBps}bps`);
  }
}

/**
 * Validate a FULL resulting composition — `composition.rs::validate_composition`.
 *
 * Used directly by the Setup Allocate (which signs a whole composition, not deltas) and as
 * the last step of the change-set fold.
 */
export function assertValidComposition(
  composition: CompositionRowBps[],
  limits: PreflightLimits = MIRRORED_LIMITS
): void {
  if (composition.length === 0) fail("empty-composition", "no rows");
  if (composition.length > limits.maxTokensPerPortfolio) {
    fail("too-many-tokens", `${composition.length} > ${limits.maxTokensPerPortfolio}`);
  }

  const seen = new Set<string>();
  let sum = 0;
  for (const row of composition) {
    checkTokenId(row.tokenId, limits);
    checkTarget(row, limits);
    checkTolerance(row, limits);
    if (seen.has(row.tokenId)) fail("duplicate-token", row.tokenId);
    seen.add(row.tokenId);
    sum += row.targetBps;
  }

  // Exact, not approximate — see the module header. This is the check the editor's
  // percent-space gate structurally cannot make.
  if (sum !== limits.targetSumBps) fail("targets-not-100", `Σ=${sum}bps, need ${limits.targetSumBps}`);
}

/**
 * Validate the SHAPE of a change set — `composition.rs::validate_change_set`.
 *
 * Independent of the current composition: the presence rules are the fold's job below.
 */
export function assertValidChangeSetShape(
  cs: ChangeSetBps,
  limits: PreflightLimits = MIRRORED_LIMITS
): void {
  const changeCount =
    cs.targetChanges.length + cs.tokenAdditions.length + cs.tokenRemovals.length;
  if (changeCount > limits.maxCompositionChangesPerCommit) {
    fail("too-many-changes", `${changeCount} > ${limits.maxCompositionChangesPerCommit}`);
  }
  if (cs.unallocations.length > limits.maxUnallocLegsPerCommit) {
    fail("too-many-legs", `${cs.unallocations.length} > ${limits.maxUnallocLegsPerCommit}`);
  }

  // An addition carries its target like a retarget does (Appendix D.2).
  for (const row of [...cs.tokenAdditions, ...cs.targetChanges]) {
    checkTarget(row, limits);
    checkTolerance(row, limits);
  }

  // A token may appear in AT MOST ONE of the three composition lists (across and within).
  const seen = new Set<string>();
  for (const tokenId of [
    ...cs.targetChanges.map((r) => r.tokenId),
    ...cs.tokenAdditions.map((r) => r.tokenId),
    ...cs.tokenRemovals,
  ]) {
    checkTokenId(tokenId, limits);
    if (seen.has(tokenId)) fail("duplicate-token", tokenId);
    seen.add(tokenId);
  }

  // Unallocations are NOT checked against those lists: removing a token and withdrawing
  // its balance in the same commit is the intended coupling (§4.4.1).
  const seenLegs = new Set<string>();
  for (const leg of cs.unallocations) {
    checkTokenId(leg.tokenId, limits);
    // A zero leg would seal the nonce and open a pending that moves nothing (SB-04).
    if (!/^\d+$/.test(leg.amount) || leg.amount === "0") {
      fail("zero-unallocation", `${leg.tokenId}=${leg.amount}`);
    }
    if (seenLegs.has(leg.tokenId)) fail("duplicate-unallocation", leg.tokenId);
    seenLegs.add(leg.tokenId);
  }
}

/**
 * Fold the change set onto `current` and return the resulting composition —
 * `composition.rs::resulting_composition`, including its ordering (removals first) and its
 * presence rules. Validates the shape first, then the result.
 *
 * `current` must be the composition as the CHAIN holds it. Folding onto the editor's copy
 * would validate our belief about the portfolio rather than the portfolio.
 */
export function resultingComposition(
  current: CompositionRowBps[],
  cs: ChangeSetBps,
  limits: PreflightLimits = MIRRORED_LIMITS
): CompositionRowBps[] {
  assertValidChangeSetShape(cs, limits);

  let out = current.map((row) => ({ ...row }));

  // Removals first, so a later addition of the same id cannot resurrect a removed row.
  for (const tokenId of cs.tokenRemovals) {
    const before = out.length;
    out = out.filter((row) => row.tokenId !== tokenId);
    if (out.length === before) fail("removal-absent-token", tokenId);
  }
  for (const change of cs.targetChanges) {
    const row = out.find((r) => r.tokenId === change.tokenId);
    if (!row) fail("retarget-absent-token", change.tokenId);
    row.targetBps = change.targetBps;
    row.toleranceBps = change.toleranceBps;
  }
  for (const addition of cs.tokenAdditions) {
    if (out.some((r) => r.tokenId === addition.tokenId)) {
      fail("addition-present-token", addition.tokenId);
    }
    out.push({ ...addition });
  }

  assertValidComposition(out, limits);
  assertWithinAppTokenCap(current.length, out.length);
  return out;
}

/**
 * The app's own cap (D-528), on every path that signs a composition: a Setup (`before` = 0), an
 * AllocateInto or a commit (through `resultingComposition`). The relay refuses the same.
 */
export function assertWithinAppTokenCap(before: number, after: number): void {
  if (growsPastAppTokenCap(before, after)) {
    fail("app-too-many-tokens", `${before} → ${after} > ${APP_MAX_TOKENS_PER_PORTFOLIO}`);
  }
}

/**
 * The two caps an `AllocateInto` can break that no change set carries (D-321):
 * `apply_allocate_into` refuses more than MAX_TOKENS_PER_PORTFOLIO legs, and
 * `credit_portfolio` pushes a token onto `held_tokens` on its first credit and refuses once
 * the list is full. Both are `E_INVALID_COMPOSITION` raised inside `on_auth` — after the
 * Transfer settled — so on this path they are an orphan, not a rejection.
 *
 * `heldTokens` must be the list as the CHAIN holds it (`get_portfolio`), for the same reason
 * as `resultingComposition`'s `current`.
 */
export function assertAllocateIntoFits(
  heldTokens: readonly string[],
  legTokenIds: readonly string[],
  limits: PreflightLimits = MIRRORED_LIMITS
): void {
  const max = limits.maxTokensPerPortfolio;
  if (legTokenIds.length > max) {
    fail("too-many-tokens", `${legTokenIds.length} legs > ${max}`);
  }
  const held = new Set(heldTokens);
  const newlyHeld = new Set(legTokenIds.filter((tokenId) => !held.has(tokenId))).size;
  if (held.size + newlyHeld > max) {
    fail("too-many-tokens", `${held.size} held + ${newlyHeld} new > ${max}`);
  }
}

/**
 * The ids of an Allocate's legs, as the contract receives them (`nep141:…`). A long id in a
 * DEPOSIT leg is `E_CAP_EXCEEDED` from `check_allocation_legs`, inside `on_auth` — an orphan
 * (D-302 k). Inert with today's registry, whose ids are short; it is here so a new token
 * cannot make it live without anyone noticing.
 */
export function assertAllocationLegIds(
  intentsTokenIds: readonly string[],
  limits: PreflightLimits = MIRRORED_LIMITS
): void {
  for (const tokenId of intentsTokenIds) checkTokenId(tokenId, limits);
}

/**
 * `apply_setup` refuses more legs than MAX_TOKENS_PER_PORTFOLIO, inside
 * `on_auth` — an orphan. The composition cap does not cover it on its own: nothing forces the
 * legs to be a subset of the composition. AllocateInto has the same check in
 * `assertAllocateIntoFits`.
 */
export function assertSetupLegCount(legCount: number, limits: PreflightLimits = MIRRORED_LIMITS): void {
  if (legCount > limits.maxTokensPerPortfolio) {
    fail("too-many-tokens", `${legCount} legs > ${limits.maxTokensPerPortfolio}`);
  }
}

/**
 * How many portfolios the app lets one account hold: its own cap or the vault's, whichever is
 * lower (D-476). The Setup pre-flight, "+ New portfolio" and the copy that names the number all
 * read it here.
 */
export function appPortfolioCap(limits: PreflightLimits = MIRRORED_LIMITS): number {
  return Math.min(limits.maxPortfoliosPerAccount, APP_MAX_PORTFOLIOS_PER_ACCOUNT);
}

/**
 * What `apply_setup` checks besides the composition, all inside `on_auth` (so a failure is an
 * orphan): the account's portfolio count against its cap (D-361; the app's, D-476) and the name and the login
 * wallet address in UTF-8 bytes (D-302 e).
 *
 * `portfolioCount` must be the CHAIN's count (`list_portfolios_for`, which the contract keeps in
 * step with deletions), not the dashboard's: a portfolio the UI has not loaded still counts.
 */
export function assertSetupFits(
  p: { portfolioCount: number; portfolioName: string; loginWalletAddress: string },
  limits: PreflightLimits = MIRRORED_LIMITS
): void {
  const cap = appPortfolioCap(limits);
  if (p.portfolioCount >= cap) {
    fail("too-many-portfolios", `${p.portfolioCount} >= ${cap}`);
  }
  if (utf8Length(p.portfolioName) > limits.maxPortfolioNameLen) {
    fail("name-too-long", `${utf8Length(p.portfolioName)} bytes > ${limits.maxPortfolioNameLen}`);
  }
  if (utf8Length(p.loginWalletAddress) > limits.maxWalletAddressLen) {
    fail("address-too-long", `${utf8Length(p.loginWalletAddress)} bytes > ${limits.maxWalletAddressLen}`);
  }
}

/**
 * A rename (017-9c): the contract caps the name in UTF-8 bytes and answers `E_CAP_EXCEEDED`
 * past it. A commit reverts cleanly, so this only saves a wasted signature — unlike the Setup
 * check above, where the same overflow orphans funds.
 */
export function assertRenameFits(name: string, limits: PreflightLimits = MIRRORED_LIMITS): void {
  if (utf8Length(name) > limits.maxPortfolioNameLen) {
    fail("name-too-long", `${utf8Length(name)} bytes > ${limits.maxPortfolioNameLen}`);
  }
}

/** Percent (the editor's unit) → basis points (the contract's). Integral by construction. */
export function pctToBps(pct: number): number {
  return Math.round(pct * 100);
}
