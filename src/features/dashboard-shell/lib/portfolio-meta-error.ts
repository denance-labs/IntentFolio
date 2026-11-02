// What to tell the user when a signed rename or delete does not go through (017-9c).
//
// Classified by origin before any keyword, like the editor's commit path: a chain revert or a
// relayer answer is never "you cancelled", whatever its text says (normalize-error.ts).

import { normalizeWalletError } from "@/features/wallet/adapter/normalize-error";
import { classifyCommitFailure } from "@/features/vault/lib/vault-error-code";
import { RealChangeSetInvalidError, VaultCommitRevertedError } from "@/features/vault/lib/vault-errors";
import { RealPortfolioMetaUnconfirmedError } from "@/features/vault/lib/run-real-portfolio-meta";
import type { shellTranslations } from "./translations";

type T = (typeof shellTranslations)["en"];

export function portfolioMetaErrorText(e: unknown, t: T): string {
  if (e instanceof RealPortfolioMetaUnconfirmedError) return t.portfolioMetaUnconfirmed;
  if (e instanceof RealChangeSetInvalidError) {
    return e.reason === "name-too-long" ? t.portfolioMetaNameTooLong : t.portfolioMetaError;
  }
  if (e instanceof VaultCommitRevertedError) {
    const verdict = classifyCommitFailure(e.reason);
    // Any code without its own copy means the app and the contract disagree: ops needs it.
    if (verdict === null) console.warn("[vault] rename/delete reverted with an unmapped reason:", e.reason);
    if (verdict === "portfolio-not-empty") return t.portfolioDeleteNotEmpty;
    // Already turned into a state check upstream; reaching here means it stayed unproven.
    if (verdict === "unconfirmed") return t.portfolioMetaUnconfirmed;
    return t.portfolioMetaError;
  }
  const { kind } = normalizeWalletError(e);
  switch (kind) {
    case "cancel":
      return t.portfolioMetaCancelled;
    case "unavailable":
      return t.portfolioMetaWalletUnavailable;
    // The relayer refused before sending: nothing moved, and saying so is accurate.
    case "relay-paused":
    case "relay-busy":
    case "relay-would-fail":
    case "relay-check-failed":
      return t.portfolioMetaNotSent;
    default:
      return t.portfolioMetaError;
  }
}
