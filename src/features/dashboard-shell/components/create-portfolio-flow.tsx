"use client";

import { useEffect, useState } from "react";
import type { PresetId } from "@/content/portfolio-presets";
import { Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import { useLanguage } from "../context/language-context";
import { usePortfolio } from "../context/portfolio-context";
import { useAvailableGeneralBalance } from "../hooks/use-available-general-balance";
import { useFundableGeneralBalance } from "../hooks/use-fundable-general-balance";
import { useNewPortfolioDraft } from "../hooks/use-new-portfolio-draft";
import type { NewPortfolioDraft } from "../lib/new-portfolio-draft";
import { shellTranslations } from "../lib/translations";
import { NewPortfolioDraftEditor } from "./new-portfolio-draft-editor";
import { PresetReviewModal } from "./preset-review-modal";
import { PresetSelectionModal } from "./preset-selection-modal";

// How long a confirmation opened right after a wallet deposit (B1) waits for the General
// Balance to show it. The deposit panel re-reads at 0/3/10 s; past the last one plus an RPC
// round trip nothing new is coming, so the confirmation opens with what there is.
export const AFTER_DEPOSIT_WAIT_MS = 15_000;

type Step =
  | { kind: "select" }
  | { kind: "draft"; presetId: PresetId | null }
  // The account's saved New Portfolio Draft, in the editor.
  | { kind: "resume" }
  // The same draft, funded: confirm and sign it. A snapshot, so what is signed is what is shown.
  | { kind: "confirm"; draft: NewPortfolioDraft };

// Single entry point for new-portfolio creation (5.6). Each create surface (the account CTA,
// the tabs "+") renders this and only handles open/close.
//
// 019-5 (D-393 Q4): every card opens the editor (preset preloaded, or empty), with funds or
// without, and it opens at once: nothing there waits on the balance read.
//
// D-397 (plan 041): the editor's own actions follow the funds. With them it creates the
// portfolio, through the funds screen, and saving a draft is a separate action; without them it
// saves a draft. A portfolio is not built as a draft first any more.
//
// 016 block 2.3: one draft per account. While one is saved these entries resume it, the editor
// with the draft when there are no funds for it. Deciding that needs the balance too, so the
// entry waits on it the same way. D-397: `startNew`, from the tabs' "+", opens the chooser instead,
// and the draft stays as it is.
//
// 016 block 2.4: a saved draft with funds opens its confirmation, the same funds screen fed the
// draft's mix. Right after a wallet deposit for it (B1) the confirmation first waits for the
// General Balance to show that deposit, or AFTER_DEPOSIT_WAIT_MS, then opens anyway.
//
// D-359: signed out there is no balance to sign with and nowhere to deposit, so every way in
// is the editor — whatever a balance read without an account says.
//
// 019-4: saving a draft closes the flow and hands over to `onDraftSaved` (the shell lands on
// the draft's tab), signed in or not. The deposit is no longer opened on its own: it is the
// tab's button.
export function CreatePortfolioFlow({
  onClose,
  onDraftSaved,
  afterDeposit,
  onCreated,
  signedOut = false,
  startNew = false,
  startPresetId,
}: {
  onClose: () => void;
  /** After a New Portfolio Draft was saved in the editor. */
  onDraftSaved?: () => void;
  /** A wallet deposit that just landed for the draft (B1): the token and the quantity credited. */
  afterDeposit?: { tokenId: string; qty: number };
  /** After a portfolio was signed into existence (the shell lands on it). */
  onCreated?: () => void;
  /** No wallet connected (D-359): the anonymous draft, in the editor only. */
  signedOut?: boolean;
  /** D-397: build another portfolio, even with a draft saved. Only read on open. */
  startNew?: boolean;
  /** D-561: skip the chooser and open the editor on this preset. Only read on open. */
  startPresetId?: PresetId;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { portfolios } = usePortfolio();
  const available = useAvailableGeneralBalance();
  const fundable = useFundableGeneralBalance();
  const { draft } = useNewPortfolioDraft();
  const existingNames = signedOut ? [] : portfolios.map((p) => p.name);
  const canFund = signedOut ? false : fundable.status === "known" ? fundable.fundable : null;

  // B1: the deposit counts as seen once the balance holds at least what was credited (a
  // tolerance for float noise only). A balance that already held more of that token passes at
  // once, possibly on the old read — the confirmation's rows and "available" follow the live
  // balance, so the re-read corrects them in place.
  const depositSeen = afterDeposit
    ? (available.get(afterDeposit.tokenId) ?? 0) >= afterDeposit.qty * (1 - 1e-9)
    : false;
  const [waitedOut, setWaitedOut] = useState(false);
  const waitsForDeposit = afterDeposit !== undefined;
  useEffect(() => {
    if (!waitsForDeposit) return;
    const timer = window.setTimeout(() => setWaitedOut(true), AFTER_DEPOSIT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [waitsForDeposit]);

  // null while a saved draft waits on the balance to pick its way. Decided once and kept:
  // funds arriving while the draft is being edited do not swap the editor away.
  const [step, setStep] = useState<Step | null>(() => {
    if (startPresetId) return { kind: "draft", presetId: startPresetId };
    if (!draft || startNew) return { kind: "select" };
    if (afterDeposit) return depositSeen ? { kind: "confirm", draft } : null;
    if (canFund === null) return null;
    return canFund ? { kind: "confirm", draft } : { kind: "resume" };
  });

  useEffect(() => {
    if (step !== null) return;
    // Discarded meanwhile (another tab): nothing to resume.
    if (!draft) setStep({ kind: "select" });
    // Asked to confirm: it opens even without funds, and says what is missing.
    else if (waitsForDeposit) {
      if (depositSeen || waitedOut) setStep({ kind: "confirm", draft });
    } else if (canFund !== null) setStep(canFund ? { kind: "confirm", draft } : { kind: "resume" });
  }, [step, draft, canFund, waitsForDeposit, depositSeen, waitedOut]);

  const handleDraftSaved = () => {
    onClose();
    onDraftSaved?.();
  };

  if (step === null) {
    return (
      <Modal titleId="create-flow-checking" onClose={onClose}>
        <h2 id="create-flow-checking" role="status" className="text-sm text-slate-300">
          {waitsForDeposit ? t.draftUpdatingBalance : t.draftCheckingBalance}
        </h2>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
          >
            {t.cancel}
          </button>
        </div>
      </Modal>
    );
  }

  // No "Back" here: the chooser was never shown, so the secondary button cancels. The editor
  // reads `draft` once, on mount, so a discard from another tab while it is open does not
  // yank the form away — saving just writes it again.
  if (step.kind === "resume") {
    return (
      <NewPortfolioDraftEditor
        presetId={draft?.presetId ?? null}
        draft={draft}
        existingNames={existingNames}
        onClose={onClose}
        onSaved={handleDraftSaved}
        funded={canFund}
        signedOut={signedOut}
      />
    );
  }

  if (step.kind === "draft") {
    return (
      <NewPortfolioDraftEditor
        presetId={step.presetId}
        existingNames={existingNames}
        onBack={() => setStep({ kind: "select" })}
        onClose={onClose}
        onSaved={handleDraftSaved}
        funded={canFund}
        balanceUnreadable={fundable.status === "error"}
        signedOut={signedOut}
        savedDraftName={signedOut ? null : (draft?.name ?? null)}
        onCreated={onCreated}
      />
    );
  }

  // No "Back": the chooser was never shown. The name is checked against the portfolios
  // there are now — one created since the draft was saved (another device) shows up here.
  if (step.kind === "confirm") {
    return (
      <PresetReviewModal
        source={{ kind: "draft", draft: step.draft }}
        existingNames={existingNames}
        onClose={onClose}
        onCreated={onCreated}
      />
    );
  }

  return (
    <PresetSelectionModal
      onClose={onClose}
      onSelectPreset={(presetId) => setStep({ kind: "draft", presetId })}
      onSelectScratch={() => setStep({ kind: "draft", presetId: null })}
    />
  );
}
