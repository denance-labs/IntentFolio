"use client";

// The one place a portfolio can be deleted (027 A-9a, operator s268): "Delete portfolio" in
// its tab menu. The final contract only deletes a portfolio that holds nothing (ADR-0023), so
// this dialog says what stands in the way — funds still in it, a credit on its way, or a read
// still loading — and only offers the signature when it can succeed. Two steps before the
// wallet's own prompt, because a delete is final.

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import { mockContract } from "@/features/intents-account/mock-contract";
import { useLoginWallet } from "@/features/login-wallet";
import { usePendingAllocates } from "@/features/vault/hooks/use-pending-allocates";
import { usePortfolio } from "../context/portfolio-context";
import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";
import { portfolioMetaErrorText } from "../lib/portfolio-meta-error";
import { portfolioDeleteStatus } from "../lib/portfolio-delete-offer";

export function PortfolioDeleteModal({ portfolioId, onClose }: { portfolioId: string; onClose: () => void }) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { portfolios, deletePortfolio, setDraftState } = usePortfolio();
  const { intentsAccountId } = useLoginWallet();
  const { pending: pendingAllocates } = usePendingAllocates(intentsAccountId);
  const mockVersion = useSyncExternalStore(mockContract.subscribe, mockContract.getVersion, mockContract.getVersion);
  const mockPendingUnallocations = useMemo(() => {
    void mockVersion;
    if (!intentsAccountId) return 0;
    return mockContract.getPendingUnallocations(intentsAccountId).filter((u) => u.portfolioId === portfolioId)
      .length;
  }, [intentsAccountId, mockVersion, portfolioId]);

  const portfolio = portfolios.find((p) => p.id === portfolioId);
  // Kept from the open, so a re-read mid-attempt cannot blank the title.
  const [name] = useState(portfolio?.name ?? "");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the user asked to delete, the confirmation stays until Cancel, whatever the status
  // reads meanwhile: every attempt re-reads the portfolio list, and the inputs blink while they
  // refetch — dropping the confirmation there would also drop the error that says how it ended.
  const [engaged, setEngaged] = useState(false);
  // A ref, not the state: a double click lands twice before the re-render disables the button.
  const inFlight = useRef(false);

  const status = engaged
    ? "empty"
    : portfolio
      ? portfolioDeleteStatus({ portfolio, pendingAllocates, mockPendingUnallocations })
      : "checking";

  async function confirmDelete() {
    if (inFlight.current) return;
    inFlight.current = true;
    setEngaged(true);
    setDeleting(true);
    setError(null);
    try {
      await deletePortfolio(portfolioId);
      // A draft open on it has nothing left to save into.
      setDraftState((draft) => (draft?.id === portfolioId ? null : draft));
      onClose();
    } catch (e) {
      setError(portfolioMetaErrorText(e, t));
    } finally {
      inFlight.current = false;
      setDeleting(false);
    }
  }

  const body =
    status === "funded"
      ? t.portfolioDeleteFunded
      : status === "incoming"
        ? t.portfolioDeleteIncoming
        : status === "checking"
          ? t.portfolioDeleteChecking
          : t.portfolioDeleteImmediate;

  return (
    <Modal titleId="delete-portfolio-title" onClose={deleting ? () => {} : onClose}>
      <h2 id="delete-portfolio-title" className="mb-3 text-base font-semibold text-white">
        {t.portfolioDeleteTitle.replace("{name}", name)}
      </h2>
      <p role={status === "checking" ? "status" : undefined} className="text-sm text-slate-300">
        {body}
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-rose-300">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {status === "empty" ? (
          <>
            <button
              type="button"
              onClick={onClose}
              disabled={deleting}
              className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t.cancel}
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              disabled={deleting}
              className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deleting ? t.portfolioDeleting : t.portfolioDeleteConfirmAction}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
          >
            {status === "checking" ? t.cancel : t.portfolioDeleteClose}
          </button>
        )}
      </div>
    </Modal>
  );
}
