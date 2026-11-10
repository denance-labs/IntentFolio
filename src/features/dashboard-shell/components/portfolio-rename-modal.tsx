"use client";

import { useEffect, useRef, useState } from "react";
import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import { loadPreflightLimits } from "@/features/vault/lib/vault-limits";
import { Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import {
  PORTFOLIO_NAME_MAX_LENGTH,
  validatePortfolioName,
  type ValidationResult,
} from "../lib/portfolio-validation";
import { useLanguage } from "../context/language-context";
import { usePortfolio } from "../context/portfolio-context";
import { shellTranslations } from "../lib/translations";
import { portfolioMetaErrorText } from "../lib/portfolio-meta-error";

type PortfolioRenameModalProps = {
  currentName: string;
  existingNames: string[];
  onClose: () => void;
} & (
  | { portfolioId: string }
  // 022-G (D-458): the New Portfolio Draft's name — saved in this browser, nothing signed.
  | { onSave: (name: string) => ValidationResult }
);

export function PortfolioRenameModal(props: PortfolioRenameModalProps) {
  const { currentName, existingNames, onClose } = props;
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { renamePortfolio } = usePortfolio();
  const isDraft = "onSave" in props;

  const [name, setName] = useState(currentName);
  // A rename is signed (017-9c): the modal stays open, locked, until the chain shows the new
  // name or the attempt fails, and then says why.
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // A ref, not the state: two submits in the same tick both see `saving === false`.
  const inFlight = useRef(false);

  // The real rename checks the name against the vault's limits before signing. Read here, on
  // open, so the click itself reaches the wallet popup inside the browser's ~5 s window
  // (`loadPreflightLimits` caches; a failure here is retried by the click). No vault, no read.
  // The draft signs nothing, so it reads nothing either.
  useEffect(() => {
    if (!isDraft && VAULT_CONTRACT_ID !== "") void loadPreflightLimits().catch(() => {});
  }, [isDraft]);

  // A portfolio's own name is among `existingNames`, so it is no duplicate of itself. The
  // draft's is not (they are the portfolios' names), and it is checked as the editor checks it
  // (`validateNewPortfolioDraft`): a name a portfolio took since reads as a duplicate.
  const validation = validatePortfolioName(name, existingNames, isDraft ? undefined : currentName);
  const isValid = validation.ok;
  const showError = name !== "" && !isValid;

  function nameErrorText(error: string) {
    if (error === "nameEmpty") return t.portfolioNameEmpty;
    if (error === "nameTooLong") return t.portfolioNameTooLong.replace("{max}", String(PORTFOLIO_NAME_MAX_LENGTH));
    if (error === "nameDuplicate") return t.portfolioNameDuplicate;
    return null;
  }

  function getErrorMessage() {
    return validation.ok ? null : nameErrorText(validation.error);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || !isValid || name.trim() === "") return;
    // Same name: nothing to sign or save.
    if (name.trim() === currentName) {
      onClose();
      return;
    }
    if ("onSave" in props) {
      const result = props.onSave(name.trim());
      if (result.ok) onClose();
      else setSubmitError(nameErrorText(result.error) ?? t.portfolioMetaError);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setSubmitError(null);
    try {
      await renamePortfolio(props.portfolioId, name.trim());
      onClose();
    } catch (err) {
      setSubmitError(portfolioMetaErrorText(err, t));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <Modal titleId="rename-portfolio-title" onClose={saving ? () => {} : onClose}>
      <form onSubmit={handleSubmit} noValidate>
        <h2
          id="rename-portfolio-title"
          className="mb-4 text-base font-semibold text-slate-100"
        >
          {t.portfolioRename}
        </h2>

        <label
          htmlFor="rename-portfolio-name"
          className="mb-1.5 block text-sm font-medium text-slate-300"
        >
          {t.portfolioNameLabel}
        </label>
        <input
          id="rename-portfolio-name"
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSubmitError(null);
          }}
          disabled={saving}
          maxLength={PORTFOLIO_NAME_MAX_LENGTH}
          placeholder={t.portfolioNamePlaceholder}
          aria-describedby={showError ? "rename-portfolio-error" : undefined}
          className={`w-full rounded-xl border px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
            showError ? "border-rose-500" : "border-slate-700 focus:border-slate-500"
          }`}
        />

        <div className="mt-1 flex items-start justify-between gap-2">
          <span
            id="rename-portfolio-error"
            role="alert"
            aria-live="polite"
            className={`text-xs text-rose-400 ${showError ? "visible" : "invisible"}`}
          >
            {getErrorMessage() ?? " "}
          </span>
          <span className="shrink-0 text-xs text-slate-400">
            {t.portfolioNameCounter
              .replace("{count}", String(name.length))
              .replace("{max}", String(PORTFOLIO_NAME_MAX_LENGTH))}
          </span>
        </div>

        {submitError ? (
          <p role="alert" className="mt-3 text-sm text-rose-300">
            {submitError}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t.cancel}
          </button>
          <button
            type="submit"
            disabled={saving || !isValid || name.trim() === ""}
            className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? t.portfolioRenameSaving : t.portfolioRenameAction}
          </button>
        </div>
      </form>
    </Modal>
  );
}
