"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Info, TriangleAlert } from "lucide-react";
import { TokenIcon, hasTokenIcon, ChainIcon, hasChainIcon } from "@/features/market/lib/token-icons";
import { colorForSymbol } from "@/features/portfolio-editor/lib/format";
import type { Language } from "@/features/portfolio-editor/types";
import { useDialogFocus } from "@/features/portfolio-editor/hooks/use-dialog-focus";
import { useLoginWallet } from "@/features/login-wallet";
import { useSendTransactionAs } from "@/features/vault/context/real-allocate-context";
import { getDepositAddress } from "../lib/bridge-client";
import { chainRegistry } from "../lib/chain-registry";
import {
  depositGroupKeyFor,
  depositGroups,
  depositTokenIdFor,
  orderDepositGroups,
  type DepositGroup,
} from "../lib/deposit-registry";
import { bridgeTranslations } from "../lib/translations";
import { familyForChainId, type ChainFamily } from "../lib/family-validation";
import type { WalletDepositCredit } from "../lib/near-wallet-deposit";
import { WALLET_DEPOSIT_ENABLED, isEvmWalletDepositRoute, isWalletDepositRoute } from "../lib/wallet-deposit-flag";
import { useEvmWalletHoldings, useWalletHoldings } from "../hooks/use-wallet-deposit-balance";
import { WalletDepositPanel } from "./wallet-deposit-panel";
import { EvmWalletDepositPanel } from "./evm-wallet-deposit-panel";
import {
  WalletHoldingsSection,
  type WalletHoldingEntry,
  type WalletHoldingsFamily,
} from "./wallet-holdings-section";
import { AssetSearch, matchAssetGroups } from "./asset-search";
import { clearFinishedWalletDeposits } from "../hooks/use-wallet-deposit-phase";

const LS_LAST_USED_TOKEN = "last-used-receive-token";
const LS_LAST_USED_CHAIN = "last-used-receive-chain";

/** The network every "From your connected wallet" row of a NEAR login deposits on (D-445). */
const NEAR_CHAIN_ID = "near:mainnet";

/** The wallet step 1 lists the holdings of (D-445): its family and its account or address. */
type WalletList = { family: WalletHoldingsFamily; address: string };

type ChainOption = {
  id: string;
  displayName: string;
  memoRequired: boolean;
  /** False for a pair deferred to the next MVP: listed, labelled, not selectable. */
  available: boolean;
};

type Step = 1 | 2 | 3;

/** Step 3's two ways in, when the wallet one is offered (016 §5.3). */
type DepositTab = "wallet" | "address";

type Props = {
  open: boolean;
  lang: Language;
  onClose: () => void;
  /**
   * Credits a deposit sent from the NEAR wallet. Without it the wallet tab is not offered: a
   * deposit the app could not record would land with no toast and no history row.
   */
  onWalletDepositCredited?: (credit: WalletDepositCredit) => void;
  /**
   * Set when the deposit is for the account's New Portfolio Draft (016 block 2.3): the header
   * names it, and its assets lead the list. Only the draft's own
   * entry points pass it; the plain "Deposit" does not, and needs not — the draft turns ready
   * from the balance, however the funds came in.
   */
  draftContext?: { name: string; tokenIds: string[] };
  /**
   * B1 (016 block 2.4): after a wallet deposit that credited the account, confirm the draft.
   * Offered only with `draftContext` — a deposit made for the draft continues into it.
   */
  onConfirmDraft?: (credit: WalletDepositCredit) => void;
};

export function ReceiveModal({ open, lang, onClose, onWalletDepositCredited, draftContext, onConfirmDraft }: Props) {
  const t = bridgeTranslations[lang];
  const { intentsAccountId, connection, liveConnection, sendEvmTransaction } = useLoginWallet();
  // Null below `RealAllocateDisabled` (/mock-dashboard): the wallet tab can never appear there.
  const sendTransactionAs = useSendTransactionAs();
  const [step, setStep] = useState<Step>(1);
  const [depositTab, setDepositTab] = useState<DepositTab>("wallet");
  // D-445: the network of the "From your connected wallet" row that opened step 2, marked there
  // for the user to confirm (operator, 2026-10-25). Null when the asset came from the list.
  const [walletChain, setWalletChain] = useState<string | null>(null);
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [selectedChain, setSelectedChain] = useState<string | null>(null);
  const [lastUsedToken, setLastUsedToken] = useState<string | null>(null);
  const [lastUsedChain, setLastUsedChain] = useState<string | null>(null);
  const [minDeposit, setMinDeposit] = useState<Record<string, Record<string, string>>>({});
  // D-445 part 2B: whether the catalog answered. The EVM wallet tab needs the minimum and must not
  // read "still loading" as "could not read it".
  const [catalogPending, setCatalogPending] = useState(true);
  const [familyValidation, setFamilyValidation] = useState<Partial<Record<ChainFamily, boolean>>>({});
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setLastUsedToken(localStorage.getItem(LS_LAST_USED_TOKEN));
      setLastUsedChain(localStorage.getItem(LS_LAST_USED_CHAIN));
      setStep(1);
      setSelectedToken(null);
      setSelectedChain(null);
      setDepositTab("wallet");
      setWalletChain(null);
      clearFinishedWalletDeposits();
    }
  }, [open]);

  // The chain list itself comes from the registry (see deposit-registry.ts), so this
  // fetch is only for the two things the live catalog still owns: minimum deposit
  // amounts and chain-family validation (ADR-0015). Both degrade gracefully when it
  // fails — the minimum line is omitted and the family gate fails open — so the
  // picker is never blocked on it.
  useEffect(() => {
    if (!open) return;
    setCatalogPending(true);
    fetch("/api/bridge/supported-tokens")
      .then((r) => r.json())
      .then(
        (data: {
          minDeposit: Record<string, Record<string, string>>;
          familyValidation?: Partial<Record<ChainFamily, boolean>>;
        }) => {
          setMinDeposit(data.minDeposit ?? {});
          setFamilyValidation(data.familyValidation ?? {});
        }
      )
      .catch(() => {
        setMinDeposit({});
        setFamilyValidation({});
      })
      .finally(() => setCatalogPending(false));
  }, [open]);

  useDialogFocus(dialogRef, { active: open, onEscape: onClose, initialFocusRef: dialogRef });

  // D-445: the wallet step 1 lists the holdings of. For NEAR, the same conditions as step 3's
  // wallet tab (see `walletDeposit` below) minus the token, which each row checks on its own
  // (`WalletTokenPicker`).
  //
  // For EVM (part 2) the same switch and the same real-context checks — `sendTransactionAs` is
  // null below `RealAllocateDisabled`, which keeps `/mock-dashboard` out — and one more: the
  // wallet plugged in must be the session's own. An EVM address IS the account (unlike a NEAR
  // wallet, which may sign for several), so a different one means another wallet's balances would
  // sit above the session's deposit address.
  const sameEvmWallet =
    liveConnection?.chainKind === "evm" &&
    connection?.chainKind === "evm" &&
    !!connection.address &&
    liveConnection.address.toLowerCase() === connection.address.toLowerCase();
  const walletList: WalletList | null =
    WALLET_DEPOSIT_ENABLED && sendTransactionAs && onWalletDepositCredited && connection?.address
      ? liveConnection?.chainKind === "near" && connection.chainKind === "near"
        ? { family: "near", address: connection.address }
        : sameEvmWallet
          ? { family: "evm", address: connection.address }
          : null
      : null;

  // D-487: on a phone the sheet is as tall as its content, so filtering step 1's list shrank it
  // and the search box jumped down with each letter. Step 1 opens with the full list (the search
  // starts empty): its height is kept as a floor until the step changes. `min(…, 85dvh)` keeps a
  // floor from outgrowing a viewport that shrank since (rotation, keyboard).
  const [sheetFloor, setSheetFloor] = useState<number | null>(null);
  useLayoutEffect(() => {
    setSheetFloor(open && step === 1 ? dialogRef.current?.offsetHeight ?? null : null);
  }, [open, step]);

  if (!open) return null;

  // Same rule as the network step: a fully deferred asset keeps its place in the curated
  // order relative to its peers, but sinks below everything selectable.
  const groups = orderDepositGroups(depositGroups, {
    lastUsed: lastUsedToken,
    preferred: (draftContext?.tokenIds ?? [])
      .map(depositGroupKeyFor)
      .filter((key): key is string => key !== null),
  });

  const selectedGroup = selectedToken
    ? (depositGroups.find((g) => g.assetName === selectedToken) ?? null)
    : null;

  const chainsForToken: ChainOption[] = (selectedGroup?.chainIds ?? [])
    .map((id) => {
      const meta = chainRegistry[id];
      if (!meta) return null;
      return {
        id,
        displayName: meta.displayName,
        memoRequired: meta.memoRequired,
        available: (selectedGroup?.availableChainIds ?? []).includes(id),
      };
    })
    .filter((c): c is ChainOption => c !== null);

  // Whether step 3 offers depositing straight from the wallet. The account signing is the
  // CONNECTION's — the same wallet the gate checked the family of — never a re-derived id.
  //
  // `liveConnection` is checked for PRESENCE only: a session restored from storage with no NEAR
  // wallet plugged in would otherwise offer a button that can only fail. Its address is
  // deliberately NOT compared with the session's (operator s181): a wallet may sign for several
  // accounts, and the one near-connect reports is not necessarily the one it signs with — the
  // verdict's `signer_id` check (`wrong-signer`) is what catches a mismatch.
  const selectedTokenId =
    selectedToken && selectedChain ? depositTokenIdFor(selectedToken, selectedChain) : null;
  const walletDeposit =
    selectedTokenId &&
    sendTransactionAs &&
    onWalletDepositCredited &&
    liveConnection?.chainKind === "near" &&
    isWalletDepositRoute({
      hasSender: true,
      loginChain: connection?.chainKind,
      accountId: connection?.address,
      tokenId: selectedTokenId,
    })
      ? {
          tokenId: selectedTokenId,
          accountId: connection!.address,
          send: sendTransactionAs,
          onCredited: onWalletDepositCredited,
        }
      : null;
  // D-445 part 2B: the same tab for an EVM login, on the EVM tokens it serves. Who sends is the
  // live wallet — the session's own address (`sameEvmWallet`) — and the deposit address is the
  // session account's, the same one the QR tab shows.
  const evmWalletDeposit =
    selectedTokenId &&
    sendTransactionAs &&
    onWalletDepositCredited &&
    sendEvmTransaction &&
    liveConnection?.chainKind === "evm" &&
    isEvmWalletDepositRoute({
      hasSender: true,
      sameWallet: sameEvmWallet,
      canSend: true,
      tokenId: selectedTokenId,
    })
      ? { tokenId: selectedTokenId, owner: liveConnection.address, send: sendEvmTransaction }
      : null;
  const hasWalletTab = walletDeposit !== null || evmWalletDeposit !== null;
  const walletTabActive = step === 3 && hasWalletTab && depositTab === "wallet";

  // D-445 (operator, 2026-10-25): a row opens the network step with its network marked, for every
  // wallet — NEAR included, which used to skip it. The network is where a mistake loses money
  // (D-488), so the user sees it here too and confirms it with Continue.
  function handleSelectHolding({ group, chainId }: WalletHoldingEntry) {
    localStorage.setItem(LS_LAST_USED_TOKEN, group.assetName);
    setSelectedToken(group.assetName);
    setSelectedChain(null);
    setWalletChain(chainId);
    setDepositTab("wallet");
    setStep(2);
  }

  function handleSelectToken(group: DepositGroup) {
    localStorage.setItem(LS_LAST_USED_TOKEN, group.assetName);
    setSelectedToken(group.assetName);
    setDepositTab("wallet");
    setWalletChain(null);
    // Picking an asset invalidates any chain held for the previous one, so a stale value
    // never survives into an asset that has not chosen its chain yet.
    setSelectedChain(null);
    // Step 2 is shown even for an asset curated on a single chain (D-488, reverting D-182's
    // skip): the network is where a mistake loses money, so the user always sees it.
    setStep(2);
  }

  function handleSelectChain(chainId: string) {
    // Confirming the only network is not a choice among several, nor is confirming the one a wallet
    // row marked: "last used" ordering in step 2 should only reflect explicit choices.
    if (chainsForToken.length > 1 && chainId !== walletChain) localStorage.setItem(LS_LAST_USED_CHAIN, chainId);
    setSelectedChain(chainId);
    setDepositTab("wallet");
    setStep(3);
  }

  function handleBack() {
    if (step === 2) setStep(1);
    else if (step === 3) setStep(2);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="presentation"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="receive-modal-title"
        aria-describedby="receive-modal-subtitle"
        tabIndex={-1}
        className="relative z-10 flex w-full flex-col rounded-t-2xl glass bg-slate-900 outline-none sm:max-w-md sm:rounded-2xl"
        style={{ maxHeight: "85dvh", minHeight: sheetFloor ? `min(${sheetFloor}px, 85dvh)` : undefined }}
      >
        {/* Header */}
        <div className="shrink-0 border-b border-slate-800 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {step > 1 && (
              <button
                type="button"
                onClick={handleBack}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                aria-label={t.back}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 5-7 7 7 7"/></svg>
              </button>
            )}
            <div>
              <h2 id="receive-modal-title" className="text-base font-semibold text-slate-100">
                {t.receiveModalTitle}
              </h2>
              <p id="receive-modal-subtitle" className="text-xs text-slate-400">
                {draftContext
                  ? t.receiveModalSubtitleDraft.replace("{name}", draftContext.name)
                  : t.receiveModalSubtitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            aria-label={t.close}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
        <StepIndicator step={step} t={t} lastLabel={walletTabActive ? t.receiveStepAmount : t.receiveStepAddress} />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {step === 1 &&
            (walletList ? (
              <WalletTokenPicker
                wallet={walletList}
                groups={groups}
                lastUsed={lastUsedToken}
                t={t}
                onSelect={handleSelectToken}
                onSelectHolding={handleSelectHolding}
              />
            ) : (
              <TokenPicker
                groups={groups}
                lastUsed={lastUsedToken}
                t={t}
                onSelect={handleSelectToken}
                walletSection={null}
              />
            ))}
          {step === 2 && (
            <ChainPicker
              chains={chainsForToken}
              preselectedChainId={walletChain}
              lastUsedChain={lastUsedChain}
              t={t}
              onSelect={handleSelectChain}
            />
          )}
          {step === 3 && selectedToken && hasWalletTab && (
            <DepositTabs tab={depositTab} onChange={setDepositTab} t={t} />
          )}
          {walletTabActive && walletDeposit && (
            <div role="tabpanel" id="deposit-tabpanel-wallet" aria-labelledby="deposit-tab-wallet">
              <WalletDepositPanel
                // A new token is a new form: nothing typed for one asset carries to another.
                key={walletDeposit.tokenId}
                tokenId={walletDeposit.tokenId}
                accountId={walletDeposit.accountId}
                send={walletDeposit.send}
                t={t}
                onCredited={walletDeposit.onCredited}
                onUseAddress={() => setDepositTab("address")}
                // "Make another deposit" means any asset, not this one again: back to step 1.
                onAgain={() => {
                  setSelectedToken(null);
                  setSelectedChain(null);
                  setWalletChain(null);
                  setStep(1);
                }}
                onContinue={draftContext ? onConfirmDraft : undefined}
                onDone={onClose}
              />
            </div>
          )}
          {walletTabActive && evmWalletDeposit && selectedToken && selectedChain && (
            <div role="tabpanel" id="deposit-tabpanel-wallet" aria-labelledby="deposit-tab-wallet">
              {catalogPending ? (
                <p role="status" className="px-5 py-6 text-sm text-slate-400">
                  {t.walletDepositReading}
                </p>
              ) : (
                <EvmWalletDepositPanel
                  key={evmWalletDeposit.tokenId}
                  tokenId={evmWalletDeposit.tokenId}
                  owner={evmWalletDeposit.owner}
                  intentsAccountId={intentsAccountId}
                  send={evmWalletDeposit.send}
                  minDepositText={minDeposit[selectedToken]?.[selectedChain] ?? null}
                  t={t}
                  onUseAddress={() => setDepositTab("address")}
                  onAgain={() => {
                    setSelectedToken(null);
                    setSelectedChain(null);
                    setWalletChain(null);
                    setStep(1);
                  }}
                  onContinue={draftContext ? onConfirmDraft : undefined}
                  onDone={onClose}
                />
              )}
            </div>
          )}
          {step === 3 && selectedToken && !walletTabActive && (
            <div
              {...(hasWalletTab
                ? { role: "tabpanel", id: "deposit-tabpanel-address", "aria-labelledby": "deposit-tab-address" }
                : {})}
            >
            <DepositStep
              assetName={selectedToken}
              chainId={selectedChain}
              intentsAccountId={intentsAccountId}
              memoRequired={selectedChain ? (chainRegistry[selectedChain]?.memoRequired ?? false) : false}
              minDepositAmount={selectedChain ? (minDeposit[selectedToken]?.[selectedChain] ?? null) : null}
              // Fail-open: an unmapped chain (no login family, e.g. BTC/Aptos) or a
              // family we haven't heard back from the catalog for yet never gates.
              needsValidationWarning={
                selectedChain
                  ? (() => {
                      const family = familyForChainId(selectedChain);
                      return family !== null && familyValidation[family] === false;
                    })()
                  : false
              }
              onDone={onClose}
              t={t}
            />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Where the user is in the three steps.
function StepIndicator({
  step,
  t,
  lastLabel,
}: {
  step: Step;
  t: (typeof bridgeTranslations)["en"];
  /** "Address" for the QR, "Amount" when depositing from the wallet (016 §5.3). */
  lastLabel: string;
}) {
  const labels = [t.receiveStepAsset, t.receiveStepNetwork, lastLabel];
  return (
    <ol aria-label={t.receiveProgressLabel} className="mt-3 flex items-center gap-2">
      {labels.map((label, i) => {
        const n = (i + 1) as Step;
        const done = n < step;
        const current = n === step;
        return (
          <li
            key={label}
            aria-current={current ? "step" : undefined}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                done
                  ? "bg-accent text-accent-ink"
                  : current
                    ? "border border-accent text-accent"
                    : "border border-slate-700 text-slate-400"
              }`}
              aria-hidden="true"
            >
              {done ? <Check size={12} strokeWidth={3} /> : n}
            </span>
            <span
              className={`truncate text-xs ${current ? "font-medium text-slate-100" : "text-slate-400"}`}
            >
              {label}
            </span>
            {i < labels.length - 1 && (
              <span
                className={`h-px min-w-3 flex-1 ${done ? "bg-accent" : "bg-slate-700"}`}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// `[From your wallet | With an address (QR)]` (016 §5.3). WAI-ARIA tabs: arrow keys move
// between them and only the selected one is in the tab order.
function DepositTabs({
  tab,
  onChange,
  t,
}: {
  tab: DepositTab;
  onChange: (tab: DepositTab) => void;
  t: (typeof bridgeTranslations)["en"];
}) {
  const tabs: Array<{ id: DepositTab; label: string }> = [
    { id: "wallet", label: t.walletDepositTabWallet },
    { id: "address", label: t.walletDepositTabAddress },
  ];
  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    const next: DepositTab | null =
      e.key === "ArrowLeft" || e.key === "ArrowRight"
        ? tab === "wallet" ? "address" : "wallet"
        : e.key === "Home"
          ? "wallet"
          : e.key === "End"
            ? "address"
            : null;
    if (!next) return;
    e.preventDefault();
    onChange(next);
    document.getElementById(`deposit-tab-${next}`)?.focus();
  }
  return (
    <div role="tablist" aria-label={t.walletDepositTabsLabel} className="flex gap-1 px-5 pt-4">
      {tabs.map(({ id, label }) => {
        const selected = tab === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`deposit-tab-${id}`}
            aria-selected={selected}
            // Only the selected tab's panel is rendered; pointing at a missing id is an a11y error.
            aria-controls={selected ? `deposit-tabpanel-${id}` : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={handleKeyDown}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              selected ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// D-445: step 1 with a NEAR wallet that can deposit directly. Its own component so the read only
// exists behind the gate — the plain picker needs no query client.
function WalletTokenPicker({
  wallet,
  onSelectHolding,
  ...picker
}: {
  wallet: WalletList;
  groups: DepositGroup[];
  lastUsed: string | null;
  t: (typeof bridgeTranslations)["en"];
  onSelect: (group: DepositGroup) => void;
  onSelectHolding: (entry: WalletHoldingEntry) => void;
}) {
  const { family, address } = wallet;
  const nearQuery = useWalletHoldings({ accountId: address, enabled: family === "near" });
  const evmQuery = useEvmWalletHoldings({ address, enabled: family === "evm" });
  // A disabled query still reads as pending, so only the family's own one counts.
  const query = family === "near" ? nearQuery : evmQuery;
  const holdings = family === "near"
    ? (nearQuery.data ?? []).map((holding) => ({ ...holding, chainId: NEAR_CHAIN_ID }))
    : (evmQuery.data ?? []);
  // A row needs the asset group step 1 would have picked, and that group's network must hold this
  // very token — otherwise the network step would lead to a different token than the row named.
  // A NEAR row also needs the wallet route, which is what it was listed for.
  const entries: WalletHoldingEntry[] = holdings.flatMap(({ chainId, ...holding }) => {
    const key = depositGroupKeyFor(holding.tokenId);
    const group = key ? depositGroups.find((g) => g.assetName === key) : undefined;
    if (!group || depositTokenIdFor(group.assetName, chainId) !== holding.tokenId) return [];
    if (!group.availableChainIds.includes(chainId)) return [];
    if (
      family === "near" &&
      !isWalletDepositRoute({ hasSender: true, loginChain: "near", accountId: address, tokenId: holding.tokenId })
    ) {
      return [];
    }
    return [{ holding, group, chainId }];
  });
  return (
    <TokenPicker
      {...picker}
      walletSection={
        query.isPending || entries.length > 0 ? (
          <WalletHoldingsSection
            accountId={address}
            family={family}
            pending={query.isPending}
            entries={entries}
            t={picker.t}
            onSelect={onSelectHolding}
          />
        ) : null
      }
    />
  );
}

function TokenPicker({
  groups,
  lastUsed,
  t,
  onSelect,
  walletSection,
}: {
  groups: DepositGroup[];
  lastUsed: string | null;
  t: (typeof bridgeTranslations)["en"];
  onSelect: (group: DepositGroup) => void;
  /** D-445: "From your connected wallet", above the list; null when there is nothing to show. */
  walletSection: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const visible = matchAssetGroups(groups, search);
  return (
    <div className="px-2 py-2">
      {walletSection}
      <p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {walletSection ? t.walletHoldingsOtherTitle : t.receiveStep1Title}
      </p>
      <AssetSearch value={search} onChange={setSearch} placeholder={t.searchAsset} />
      {visible.length === 0 && <p className="px-3 py-8 text-center text-sm text-slate-400">{t.noAssetsFound}</p>}
      <ul role="list">
        {visible.map((group) => {
          const color = colorForSymbol(group.ticker);
          // Both the badge and step 2 read the same derived list, so they cannot
          // disagree — and being static, the count needs no loading state.
          const chainCount = group.chainIds.length;
          // Every curated chain for this asset is deferred, so there is nothing to pick
          // behind it. Assets with only SOME chains deferred stay selectable and say so in
          // step 2 instead.
          const notAvailable = group.availableChainIds.length === 0;
          // Like the ordering: an asset the catalog dropped since (D-396) is not "Last used".
          const isLastUsed = group.assetName === lastUsed && !notAvailable;

          return (
            <li key={group.assetName}>
              <button
                type="button"
                onClick={() => onSelect(group)}
                disabled={notAvailable}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 active:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:active:bg-transparent"
              >
                {/* Avatar: real token icon when available, initials fallback otherwise */}
                {hasTokenIcon(group.ticker) ? (
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-800"
                    aria-hidden="true"
                  >
                    <TokenIcon symbol={group.ticker} size={36} />
                  </div>
                ) : (
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-slate-950 ${color.bg}`}
                    aria-hidden="true"
                  >
                    {group.ticker.slice(0, 2)}
                  </div>
                )}

                {/* Name + chain count */}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-100">{group.ticker}</p>
                  <p className="truncate text-xs text-slate-400">{group.assetName}</p>
                </div>

                {/* Right side: badge + chain label */}
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {isLastUsed && (
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                      {t.lastUsed}
                    </span>
                  )}
                  <span className={`text-xs ${notAvailable ? "text-amber-400" : "text-slate-400"}`}>
                    {notAvailable
                      ? t.notAvailableYet
                      : chainCount === 1
                        ? t.chainCountOne
                        : t.chainCount.replace("{count}", String(chainCount))}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// The chain list is derived from the registry at module load, so this picker has no
// loading or error state to render: it is only reached for the 4 groups curated on more
// than one chain.
function ChainPicker({
  chains,
  preselectedChainId,
  lastUsedChain,
  t,
  onSelect,
}: {
  chains: ChainOption[];
  /** D-445: the network of the wallet row that opened this step, marked for the user to confirm. */
  preselectedChainId: string | null;
  lastUsedChain: string | null;
  t: (typeof bridgeTranslations)["en"];
  onSelect: (chainId: string) => void;
}) {
  // Deferred chains sink below the selectable ones, alphabetical within each block. Purely
  // alphabetical put a disabled row at the top of the longest list (Aptos, for USDC), so the
  // first thing the eye landed on was the one thing it could not click. `lastUsedChain` still
  // wins overall, and it can only ever be a chain the user actually picked once.
  // D-488: a single selectable network is shown preselected; the user confirms it with Continue.
  // D-445: so is the network of the wallet row that opened this step. It leads the list, and
  // Continue sticks to the bottom of the sheet: with USDC's twelve networks it would otherwise sit
  // below the fold on a phone.
  const preselected =
    chains.find((c) => c.id === preselectedChainId && c.available) ??
    (chains.length === 1 && chains[0].available ? chains[0] : null);
  const byName = (a: ChainOption, b: ChainOption) => a.displayName.localeCompare(b.displayName);
  const rank = (c: ChainOption) =>
    c === preselected ? -1 : c.id === lastUsedChain && c.available ? 0 : c.available ? 1 : 2;
  const sorted = [...chains].sort((a, b) => rank(a) - rank(b) || byName(a, b));

  return (
    <div className="px-2 py-2">
      <p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {t.receiveStep2Title}
      </p>
      <ul role="list">
        {sorted.map((chain) => {
          const isLastUsed = chain.id === lastUsedChain;
          return (
            <li key={chain.id}>
              <button
                type="button"
                onClick={() => onSelect(chain.id)}
                disabled={!chain.available}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 active:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:active:bg-transparent ${chain === preselected ? "bg-slate-800 ring-1 ring-inset ring-accent/60" : ""}`}
              >
                {/* Chain icon / initial avatar */}
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-slate-300"
                  aria-hidden="true"
                >
                  {hasChainIcon(chain.id)
                    ? <ChainIcon chainId={chain.id} size={28} />
                    : chain.displayName.slice(0, 2)}
                </div>

                {/* Chain name */}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-100">{chain.displayName}</p>
                  {/* A deferred pair says so instead of warning about a memo it will never
                      ask for — one line, so the two never stack. */}
                  {!chain.available ? (
                    <p className="text-xs text-amber-400">{t.notAvailableYet}</p>
                  ) : chain.memoRequired ? (
                    <p className="text-xs text-amber-400">{t.memoRequired}</p>
                  ) : null}
                </div>

                {/* Last used badge — never on a pair the user can no longer pick */}
                {isLastUsed && chain.available && (
                  <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                    {t.lastUsed}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {preselected && (
        <div className="sticky bottom-0 bg-slate-900 px-3 pb-2 pt-3">
          <button
            type="button"
            onClick={() => onSelect(preselected.id)}
            className="flex w-full items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 active:bg-accent/90"
          >
            {t.continueButton}
          </button>
        </div>
      )}
    </div>
  );
}

function DepositStep({
  assetName,
  chainId,
  intentsAccountId,
  memoRequired,
  minDepositAmount,
  needsValidationWarning,
  onDone,
  t,
}: {
  assetName: string;
  chainId: string | null;
  intentsAccountId: string;
  memoRequired: boolean;
  minDepositAmount: string | null;
  needsValidationWarning: boolean;
  onDone: () => void;
  t: (typeof bridgeTranslations)["en"];
}) {
  const [address, setAddress] = useState<string | null>(null);
  const [memo, setMemo] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    // A new chain is a new thing to acknowledge; never carry a tick across networks.
    setAcknowledged(false);
    if (!chainId || !intentsAccountId) return;
    setLoading(true);
    setError(false);
    getDepositAddress(intentsAccountId, chainId, memoRequired ? "MEMO" : undefined)
      .then((result) => {
        setAddress(result.address);
        setMemo(result.memo);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, intentsAccountId, memoRequired]);

  function handleCopy() {
    if (!address) return;
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleRetry() {
    if (!chainId || !intentsAccountId) return;
    setError(false);
    setLoading(true);
    getDepositAddress(intentsAccountId, chainId, memoRequired ? "MEMO" : undefined)
      .then((result) => {
        setAddress(result.address);
        setMemo(result.memo);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }

  const chainName = chainId ? (chainRegistry[chainId]?.displayName ?? chainId) : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center px-5 py-16">
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          {t.fetchingAddress}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
        <p className="text-sm text-slate-400">{t.errorFetchingAddress}</p>
        <button
          type="button"
          onClick={handleRetry}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {t.retry}
        </button>
      </div>
    );
  }

  if (!address) return null;

  return (
    <div className="flex flex-col gap-5 px-5 py-6">
      {/* Step label. The network is a chip, not a dim suffix: sending on the wrong
          network is the one mistake here that cannot be undone — this is where the user
          reads it before copying. */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t.receiveStep3Title}</p>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-sm font-medium text-slate-100">{assetName}</span>
          {chainName && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-100">
              {chainId && hasChainIcon(chainId) && <ChainIcon chainId={chainId} size={14} />}
              {chainName}
            </span>
          )}
        </div>
        {/* 029 B-21: once the gate is passed, the same warning again — no checkbox — right
            where the user copies or scans. Not the gate's first sentence diluted below the
            address (the old gray note, see the end of this step): the amber reminder sits
            above the QR. The unvalidated-family warning (ADR-0015) is a one-time consent
            and is not repeated. */}
        {acknowledged && (
          <div className="mt-3 flex gap-2.5 rounded-lg border border-amber-500/40 px-4 py-3">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
            <p className="text-xs text-amber-200">
              {t.warningConfirmNetwork.replace("{asset}", assetName).replace("{network}", chainName ?? "")}
            </p>
          </div>
        )}
        {/* Identity is not origin (016 T5): the login wallet names the account, it does not
            have to be where the funds are sent from. */}
        <p className="mt-2 flex gap-1.5 text-xs text-slate-400">
          <Info size={14} className="mt-px shrink-0 text-slate-500" aria-hidden="true" />
          {t.receiveIdentityNote}
        </p>
      </div>

      {/* One gate before the address. Two separate risks share it, and they must never
          stack into two checkboxes: an unvalidated chain family (ADR-0015) adds its own
          warning above and keeps its own acknowledgment wording, so its explicit consent
          is not weakened; everyone else acknowledges the network. */}
      {!acknowledged && (
        <div className="flex flex-col gap-3">
          {needsValidationWarning && (
            <div className="flex gap-2.5 rounded-lg border border-amber-500/40 px-4 py-3">
              <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
              <p className="text-xs text-amber-200">{t.familyNotValidatedWarning}</p>
            </div>
          )}
          {/* Border and icon, no fill (016 T5): lighter to read, but still a warning — sending
              on the wrong network loses the funds. */}
          <div className="rounded-lg border border-amber-500/40 px-4 py-3">
            <div className="flex gap-2.5">
              <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
              <p className="text-xs text-amber-200">
                {t.warningConfirmNetwork
                  .replace("{asset}", assetName)
                  .replace("{network}", chainName ?? "")}
              </p>
            </div>
            <label className="mt-3 flex items-start gap-2 text-xs text-slate-200">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-amber-500/60 bg-transparent text-amber-500 focus:ring-amber-400"
              />
              {(needsValidationWarning ? t.familyNotValidatedAck : t.confirmNetworkAck)
                .replace("{asset}", assetName)
                .replace("{network}", chainName ?? "")}
            </label>
          </div>
        </div>
      )}

      {acknowledged && (
        <>
      {/* QR code */}
      <div className="flex justify-center">
        <div className="rounded-xl bg-white p-3">
          <QRCodeSVG value={address} size={160} aria-label={t.receiveStep3Title} />
        </div>
      </div>

      {/* Address + copy */}
      <div className="flex flex-col gap-2">
        <p className="break-all rounded-lg bg-slate-800 px-4 py-3 font-mono text-xs text-slate-100 select-all">
          {address}
        </p>
        <button
          type="button"
          onClick={handleCopy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 active:bg-accent/90"
        >
          {copied ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
              {t.addressCopied}
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              {t.copyAddress}
            </>
          )}
        </button>
      </div>

      {/* Memo (Stellar) */}
      {memo && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-400">{t.memoLabel}</p>
          <p className="break-all font-mono text-sm text-amber-200 select-all">{memo}</p>
        </div>
      )}

      {/* Min deposit */}
      {minDepositAmount && (
        <p className="text-center text-xs text-slate-400">
          {t.minDepositLabel}: <span className="text-slate-300">{minDepositAmount} {assetName}</span>
        </p>
      )}

      {/* D-443: after copying there was no way out but the × up top. Outlined, so the copy
          above stays the one primary. */}
      <button
        type="button"
        onClick={onDone}
        className="w-full rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-medium text-slate-100 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        {t.receiveDone}
      </button>

      {/* The safety warning used to sit here, below the address, in slate-400. It now
          runs above it as part of the acknowledgment gate — before the user can copy
          anything — and, once acknowledged, again in amber above the QR (029 B-21). A
          third copy down here would only dilute it. */}
        </>
      )}
    </div>
  );
}
