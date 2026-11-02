"use client";

// UI-only preferences side-table (5.3.0). The mock-contract owns committed portfolio
// state (composition + balances); these fields are NOT contract state, so they live
// here instead of widening PortfolioRecord:
//   - activePortfolioId:   which portfolio tab is selected, per intents account.
//   - dashboardSection:    whether My Account, a portfolio or the New Portfolio Draft
//                          (019-4) is visible, per account — and signed out, under a slot
//                          of its own (022-B), as the anonymous draft is kept.
// Keyed separately so they survive across the contract-shaped read-model.
// A per-portfolio default band used to live here too; it went with the Settings tab
// (016 Q4). Old `tolerance` entries in storage are ignored and dropped on the next write.

const KEY = "portfolio.ui-prefs.v1";

export const DEFAULT_TOLERANCE_PCT = 10;

type UiPrefs = {
  active: Record<string, string>; // intentsAccountId -> portfolioId
  section: Record<string, DashboardSection>; // intentsAccountId -> top-level dashboard view
};

export type DashboardSection = "account" | "portfolio" | "draft";

/** Signed out there are no portfolios: My Account or the anonymous draft's tab (022-B). */
export type SignedOutSection = Exclude<DashboardSection, "portfolio">;

// Not an account id: those never start with "*" (the anonymous draft's slot follows the same rule).
const SIGNED_OUT_SLOT = "*anonymous";

function read(): UiPrefs {
  if (typeof window === "undefined") return { active: {}, section: {} };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiPrefs>;
      return {
        active: parsed.active ?? {},
        section: parsed.section ?? {},
      };
    }
  } catch {
    /* corrupt storage — start fresh */
  }
  return { active: {}, section: {} };
}

function write(prefs: UiPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore quota / serialization errors */
  }
}

export function getActivePortfolioId(accountId: string): string | null {
  return read().active[accountId] ?? null;
}

export function setActivePortfolioId(accountId: string, portfolioId: string): void {
  const prefs = read();
  prefs.active[accountId] = portfolioId;
  write(prefs);
}

export function getDashboardSection(accountId: string): DashboardSection {
  const section = read().section[accountId];
  return section === "account" || section === "draft" ? section : "portfolio";
}

export function setDashboardSection(accountId: string, section: DashboardSection): void {
  const prefs = read();
  prefs.section[accountId] = section;
  write(prefs);
}

/** The section signed out, or `null` when none was chosen: the shell then derives it. */
export function getSignedOutSection(): SignedOutSection | null {
  const section = read().section[SIGNED_OUT_SLOT];
  return section === "account" || section === "draft" ? section : null;
}

export function setSignedOutSection(section: SignedOutSection): void {
  setDashboardSection(SIGNED_OUT_SLOT, section);
}

/** Back to none chosen, so the shell derives it again (022-C: entering the app). */
export function clearSignedOutSection(): void {
  const prefs = read();
  delete prefs.section[SIGNED_OUT_SLOT];
  write(prefs);
}
