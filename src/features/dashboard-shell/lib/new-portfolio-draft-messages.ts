// Why a New Portfolio Draft cannot be saved, in words. Shared by the draft editor (its
// sticky footer) and the draft's tab (027 A-10, "Resolve these before saving").

import { getTokenById } from "@/features/market/lib/token-registry";
import { RULE_MESSAGE_KEYS } from "@/features/portfolio-editor/lib/validation";
import { APP_MAX_TOKENS_PER_PORTFOLIO } from "@/features/vault/lib/change-set-preflight";
import type { NewPortfolioDraftRow, NewPortfolioDraftValidation } from "./new-portfolio-draft";
import { draftToleranceViolations } from "./new-portfolio-draft-editing";
import { PORTFOLIO_NAME_MAX_LENGTH } from "./portfolio-validation";
import type { ShellTranslations } from "./translations";

export type DraftValidationFailure = Exclude<NewPortfolioDraftValidation, { ok: true }>;

export function draftValidationMessage(
  v: DraftValidationFailure,
  rows: NewPortfolioDraftRow[],
  t: ShellTranslations,
  te: Record<string, string>
): string {
  switch (v.reason) {
    case "invalid-name":
      if (v.nameError === "nameTooLong") {
        return t.portfolioNameTooLong.replace("{max}", String(PORTFOLIO_NAME_MAX_LENGTH));
      }
      return v.nameError === "nameDuplicate" ? t.portfolioNameDuplicate : t.portfolioNameEmpty;
    case "no-rows":
      return te.ruleEmptyComposition;
    case "too-many-rows":
      return te.appTooManyTokens.replace("{max}", String(APP_MAX_TOKENS_PER_PORTFOLIO));
    case "target-not-positive":
      return t.draftTargetNotPositive;
    case "tolerance-out-of-range": {
      const violation = v.tokenId ? draftToleranceViolations(rows)[v.tokenId] : undefined;
      return violation ? te[RULE_MESSAGE_KEYS[violation.code]] : te.realChangeSetTolerance;
    }
    case "tolerance-precision":
      return te.realChangeSetTolerance;
    case "target-precision":
    case "targets-not-100":
      return te.realChangeSetTargetsNot100;
    default:
      return te.realChangeSetInvalid;
  }
}

/** The message prefixed with the token at fault, when there is one ("BTC: …"). */
export function draftBlockerText(
  v: DraftValidationFailure,
  rows: NewPortfolioDraftRow[],
  t: ShellTranslations,
  te: Record<string, string>
): string {
  const symbol = v.tokenId ? (getTokenById(v.tokenId)?.symbol ?? v.tokenId) : null;
  return `${symbol ? `${symbol}: ` : ""}${draftValidationMessage(v, rows, t, te)}`;
}
