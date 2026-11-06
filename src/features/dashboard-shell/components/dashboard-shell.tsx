"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { TokenId, ChainKind } from "@/features/intents-account/mock-contract/types";
import type { WithdrawalInFlightRecord, PendingUnallocationRecord } from "@/features/intents-account/mock-contract/types";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";
import { usePortfolio } from "../context/portfolio-context";
import { DepositActionProvider } from "../context/deposit-action-context";
import { ensureCanOperate, useLoginWallet } from "@/features/login-wallet";
import { NearKeyVerificationNotice } from "@/features/login-wallet";
import { ReceiveModal, WithdrawalModal, dismissWithdrawal, useRecentDeposits, usePendingWithdrawals, type DepositStatusEntry } from "@/features/bridge";
import type {
  ConversionQuoteRequest,
  WithdrawConfirmParams,
  WithdrawConversions,
} from "@/features/bridge/components/withdrawal-modal";
import {
  isConversionRoute,
  isRealWithdrawalRoute,
  REAL_WITHDRAWAL_ENABLED,
  UNIVERSAL_WITHDRAWAL_ENABLED,
} from "@/features/bridge/lib/withdraw-flag";
import {
  HeldReadFailedError,
  HeldReadTimeoutError,
  readHeldOnVerifier,
  runRealWithdraw,
} from "@/features/bridge/lib/run-real-withdraw";
import { runConversionWithdraw } from "@/features/bridge/lib/run-conversion-withdraw";
import { wantsRequote } from "@/features/bridge/lib/conversion-envelope";
import {
  quoteConversion,
  type ConversionQuote,
  type ConversionQuoteResult,
} from "@/features/bridge/lib/oneclick-conversion-quote";
import { quoteGasPurchase, type GasQuoteRequest } from "@/features/bridge/lib/gas-purchase";
import { waitForGasArrival } from "@/features/bridge/lib/gas-arrival";
import { intentsBalancesQueryKey } from "@/features/wallet/hooks/use-intents-balances";
import { runGasPurchase, GasPurchaseError } from "@/features/bridge/lib/gas-purchase-run";
import type { GasPurchaseQuote } from "@/features/bridge/lib/gas-purchase";
import type { HotFeeDetail } from "@/features/bridge/lib/hot-fee";
import { WithdrawError } from "@/features/bridge/lib/withdraw-errors";
import { useLiveSigner } from "@/features/vault/hooks/use-live-signer";
import { announceOperation } from "@/features/vault/hooks/use-real-portfolio-history";
import { mockContract } from "@/features/intents-account/mock-contract";
import { tokenRegistry, assetIdForNearTokenId, getTokenById, getTokenByNearTokenId } from "@/features/market/lib/token-registry";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import type { WalletDepositCredit } from "@/features/bridge/lib/near-wallet-deposit";
import { markDepositNotified } from "@/features/bridge/lib/credited-deposits-store";
import {
  AmountExceedsBalanceError,
  capToHeld,
  fromBaseUnits,
  toBaseUnits,
} from "@/features/vault/lib/base-units";
import { getChainMeta } from "@/features/bridge/lib/chain-registry";
import { nearTokenArrival } from "@/features/bridge/lib/withdrawal-registry";
import { formatCrypto, formatUsd } from "@/features/portfolio-editor/lib/format";
import { DashboardHeader } from "./dashboard-header";
import { ConnectWalletModal } from "./connect-wallet-modal";
import { PortfolioTabs } from "./portfolio-tabs";
import { CreatePortfolioFlow } from "./create-portfolio-flow";
import { useNewPortfolioDraft } from "../hooks/use-new-portfolio-draft";
import { moveAnonymousDraftToAccount } from "../lib/new-portfolio-draft";
import { NewPortfolioDraftView } from "./new-portfolio-draft-view";
import { useFundableGeneralBalance } from "../hooks/use-fundable-general-balance";
import { useAvailableGeneralBalance } from "../hooks/use-available-general-balance";
import { useGeneralBalanceRead } from "../hooks/use-general-balance-read";
import { computeTabValues } from "../lib/account-totals";
import { IntentsAccountView } from "./intents-account-view";
import { StockSellModal } from "./stock-sell-modal";
import { WelcomeModal } from "./welcome-modal";
import { AssignFundsPrompt } from "./assign-funds-prompt";
import { useAssignFundsPrompt } from "../hooks/use-assign-funds-prompt";
import { usePendingAllocates } from "@/features/vault/hooks/use-pending-allocates";
import { DRAFT_SUBJECT } from "../lib/assign-funds-prompt";
import { usePendingUnallocations } from "../hooks/use-pending-unallocations";
import { countWithdrawalsInFlight } from "../lib/withdrawals-in-flight";
import {
  clearSignedOutSection,
  getDashboardSection,
  getSignedOutSection,
  setDashboardSection as persistDashboardSection,
  setSignedOutSection as persistSignedOutSection,
  type DashboardSection,
  type SignedOutSection,
} from "../lib/portfolio-ui-prefs";
import { SubNav } from "./sub-nav";
import { UnsavedChangesModal } from "./unsaved-changes-modal";

function chainIdToChainKind(chainId: string): ChainKind {
  if (chainId.startsWith("eth:")) return "evm";
  if (chainId === "near:mainnet") return "near";
  if (chainId === "sol:mainnet") return "solana";
  if (chainId === "ton:mainnet") return "ton";
  if (chainId === "stellar:mainnet") return "stellar";
  if (chainId === "tron:mainnet") return "tron";
  return "near";
}

// `group` marks the toasts that can be folded into one summary (D-466).
type Toast = { text: string; group?: "withdrawal-resolved" } | null;

/**
 * 019-4 — the section on screen. The stored one, unless what it points at is not there any
 * more (a draft discarded or signed in another tab, the last portfolio gone).
 *
 * 022-B (D-453) — signed out it is My Account or the draft's tab, stored apart from every
 * account's. With none stored it is derived: the draft's tab if there is a draft. Derived and
 * not fixed on mount, because the draft only shows after hydration.
 */
function sectionOnScreen(
  stored: DashboardSection | null,
  { signedIn, hasPortfolios, hasDraft }: { signedIn: boolean; hasPortfolios: boolean; hasDraft: boolean }
): DashboardSection {
  if (!signedIn) return stored !== "account" && hasDraft ? "draft" : "account";
  if (stored === "account") return "account";
  if (stored === "draft" && hasDraft) return "draft";
  if (hasPortfolios) return "portfolio";
  return hasDraft ? "draft" : "account";
}

/**
 * How the gas purchase is observed completing (D-251): by re-reading the signer's own
 * balance until the token shows up.
 *
 * There is a status endpoint at 1Click and it is deliberately not used. The balance is what
 * every other part of this screen already reads, and what the withdrawal itself needs to be
 * true before it can proceed — a second source of truth about the same fact could only ever
 * disagree with it. The budget is generous because being wrong in the impatient direction
 * means telling someone their purchase failed while it is landing.
 */
/**
 * Prefix of the ledger key a wallet deposit gets when its verdict carried no transaction hash —
 * e.g. one the wallet reported as cancelled and the chain showed had landed (D-348). Such a key
 * is no transaction; it only lets `creditReceive` de-duplicate.
 */
const SYNTHETIC_WALLET_DEPOSIT_TX_PREFIX = "wallet-deposit:";

const GAS_ARRIVAL_POLL_MS = 3_000;
const GAS_ARRIVAL_BUDGET_MS = 120_000;
// The welcome's key without a wallet (022-J). `#` is in no NEAR account nor EVM address.
const WELCOME_SIGNED_OUT = "#signed-out";
// The entry's mark that the index's redirect adds (022-C, D-544). Kept in step with `next.config.mjs`.
const ENTRY_PARAM = "entry";

/**
 * The withdrawal toasts' "{chain}", plus the NEAR token it lands as when an `omft` row is sent
 * to NEAR (D-386 a): "NEAR as sol.omft.near", as steps 3 and 4 of the withdrawal say it.
 */
function withArrival(chainDisplay: string, tokenId: string, chainId: string, arrivesAs: string): string {
  const contract = nearTokenArrival(tokenId, chainId);
  return contract ? `${chainDisplay} ${arrivesAs.replace("{symbol}", contract)}` : chainDisplay;
}

export function DashboardShell({ children, basePath }: { children: ReactNode; basePath?: string }) {
  const {
    portfolios,
    portfoliosLoading,
    portfoliosError,
    portfoliosRefreshFailed,
    refetchPortfolios,
    draftState,
    activePortfolioId,
    setActivePortfolioId,
    setDraftState,
  } = usePortfolio();
  const router = useRouter();
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { status: loginStatus, intentsAccountId, keyVerification, verifyKey } = useLoginWallet();
  // null on /mock-dashboard and wherever no wallet can sign — the withdrawal then has no
  // live route at all and every token falls through to the mock, unchanged.
  const liveSigner = useLiveSigner();

  const queryClient = useQueryClient();

  // "draft": opened for the New Portfolio Draft (016 block 2.3), which frames the modal around
  // it. Only the draft's own buttons open it that way; My Account's plain "Deposit" does not.
  const [receive, setReceive] = useState<"plain" | "draft" | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  // Plan 039: hosted here and not in My Account, because a sale can empty the balance that view
  // branches on, and that would unmount the dialog with the outcome in it.
  const [sellingTokenId, setSellingTokenId] = useState<string | null>(null);
  // 019-1: the header's Connect Wallet dialog.
  const [connectOpen, setConnectOpen] = useState(false);
  const closeConnect = useCallback(() => setConnectOpen(false), []);
  // "after-deposit": B1 — a wallet deposit for the draft just landed; confirm it once the
  // General Balance shows it (016 block 2.4).
  const [createFlow, setCreateFlow] = useState<
    | { kind: "new"; startNew?: boolean }
    | { kind: "after-deposit"; tokenId: string; qty: number }
    | null
  >(null);
  const {
    draft: newPortfolioDraft,
    save: saveNewPortfolioDraft,
    discard: discardNewPortfolioDraft,
    saveSimulationUsd: saveDraftSimulationUsd,
  } = useNewPortfolioDraft();
  const fundable = useFundableGeneralBalance();
  // 016 block 2.4: the draft's funds are here — it waits only for its signature.
  const draftReady = newPortfolioDraft !== null && fundable.status === "known" && fundable.fundable;
  const fundableUsdNow = fundable.status === "known" ? fundable.usd : 0;
  const [dashboardSection, setDashboardSection] = useState<{
    accountId: string;
    value: DashboardSection;
  } | null>(null);
  // 022-B: read once, on the client. Nothing renders it while the session restores, and every
  // first render restores, so the server's `null` never reaches the screen.
  const [signedOutSection, setSignedOutSection] = useState<SignedOutSection | null>(getSignedOutSection);
  const [miCuentaBadge, setMiCuentaBadge] = useState(false);
  // The badge is about one account's news: a sign-out and a sign-in as someone else must not
  // carry it over. Signing in used to remount the whole app and reset it by accident (D-498).
  const [miCuentaBadgeAccount, setMiCuentaBadgeAccount] = useState(intentsAccountId);
  if (miCuentaBadgeAccount !== intentsAccountId) {
    setMiCuentaBadgeAccount(intentsAccountId);
    setMiCuentaBadge(false);
  }
  const [toast, setToast] = useState<Toast>(null);
  const [unsavedModalPendingAction, setUnsavedModalPendingAction] = useState<(() => void) | null>(null);
  // 027 A-10: the draft's tab holds target edits not saved yet (its table is in edit mode).
  const [draftTabUnsaved, setDraftTabUnsaved] = useState(false);
  // Whether the pending "unsaved changes" question is about the draft's tab, not a portfolio.
  const [unsavedIsDraftTab, setUnsavedIsDraftTab] = useState(false);
  // 016 block 2.5 — the account the welcome is open for. Keyed by account so a sign-out and
  // a sign-in as someone else never carries it over. Only "Getting started" (header and wallet
  // menu) opens it: it no longer opens on its own (022-I, D-459) — a new account lands on My
  // Account, which shows the same steps and button. Signed out it is keyed by `WELCOME_SIGNED_OUT`
  // (022-J), so connecting closes it too.
  const [welcomeFor, setWelcomeFor] = useState<string | null>(null);

  const loginConnected = loginStatus === "connected";
  const loginRestoring = loginStatus === "restoring" || loginStatus === "connecting";
  const hasPortfolios = portfolios.length > 0;
  // 019-4: the draft is a tab of its own, so a draft alone brings the tab strip.
  const hasTabs = hasPortfolios || newPortfolioDraft !== null;
  const dashboardSectionReady =
    !intentsAccountId || dashboardSection?.accountId === intentsAccountId;

  // 022-C (D-453) — "Open app" lands on My Account; a reload lands where the user was. Every
  // way in is the index (`basePath` itself: the landing's buttons, a typed URL, a bookmark).
  // The server redirects the index to Overview before anything mounts (`next.config.mjs`,
  // D-527), so the redirect carries the entry's mark: `?entry=1` (D-544). The bare index still
  // counts, for any way in that skips the redirect. The mark is read once and dropped at once,
  // so a reload no longer counts as entering.
  //
  // Declared before the other effects on purpose: they read `enteredRef` in the same commit.
  const enteredRef = useRef(false);
  useEffect(() => {
    const base = basePath ?? "/dashboard";
    const { pathname, search, hash } = window.location;
    const params = new URLSearchParams(search);
    const atIndex = pathname.replace(/\/$/, "") === base;
    const redirected = params.get(ENTRY_PARAM) === "1" && pathname.startsWith(`${base}/`);
    if (!atIndex && !redirected) return;
    enteredRef.current = true;
    params.delete(ENTRY_PARAM);
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${atIndex ? `${base}/overview` : pathname}${query ? `?${query}` : ""}${hash}`
    );
    // Signed out, entering derives the section: the draft's tab if there is a draft.
    setSignedOutSection(null);
    clearSignedOutSection();
  }, [basePath]);

  // Whether this load has been signed out at some point (022-A): see the effect below.
  const sawSignedOutRef = useRef(false);
  useEffect(() => {
    if (loginStatus !== "idle") return;
    sawSignedOutRef.current = true;
    // 022-C: entering signed out was the derived section. Connecting later keeps what is on
    // screen (022-B, S1), not My Account.
    enteredRef.current = false;
  }, [loginStatus]);
  // 022-B: the section last on screen signed out — the one connecting keeps (S1). Written in
  // the render below, like the other refs the effects read.
  const signedOutOnScreenRef = useRef<SignedOutSection | null>(null);

  // D-359 — a draft built before connecting goes to the account now.
  //
  // 019-4: whoever connects from the draft's tab stays on it — only its button changes. Set
  // here and not left to the stored section, which may be from an earlier session.
  //
  // 022-A (D-453): likewise, whoever connects from My Account without a wallet stays on My
  // Account. Connecting is told from restoring a saved session by having been signed out
  // ("idle") during this load: a restore goes "restoring" → "connected" and keeps the stored
  // section, so a reload still lands where the user was.
  //
  // 022-B (S1): with a draft built signed out, the section on screen decides — My Account
  // stays My Account, and only the draft's tab lands on the moved draft.
  useEffect(() => {
    if (!loginConnected || !intentsAccountId) return;
    const connectedNow = sawSignedOutRef.current;
    sawSignedOutRef.current = false;
    const moved = moveAnonymousDraftToAccount(intentsAccountId);
    const keep: DashboardSection | null =
      moved === "none"
        ? connectedNow
          ? "account"
          : null
        : connectedNow && signedOutOnScreenRef.current === "account"
          ? "account"
          : "draft";
    if (keep === null) return;
    setDashboardSection({ accountId: intentsAccountId, value: keep });
    persistDashboardSection(intentsAccountId, keep);
  }, [loginConnected, intentsAccountId]);

  // Whose welcome "Getting started" opens: none while the session restores.
  const welcomeKey = loginConnected
    ? intentsAccountId || null
    : loginRestoring
      ? null
      : WELCOME_SIGNED_OUT;
  const welcomeOpen = welcomeKey !== null && welcomeFor === welcomeKey;
  const closeWelcome = useCallback(() => setWelcomeFor(null), []);
  const section = sectionOnScreen(
    !loginConnected
      ? signedOutSection
      : dashboardSection?.accountId === intentsAccountId
        ? dashboardSection.value
        : null,
    { signedIn: loginConnected, hasPortfolios, hasDraft: newPortfolioDraft !== null }
  );
  const showMiCuenta = section === "account";
  if (loginStatus === "idle") signedOutOnScreenRef.current = section === "draft" ? "draft" : "account";

  // 029 B-23 — the draft on screen with funds to assign offers them in a window of its own, once
  // (`useAssignFundsPrompt`).
  // Not with an Allocate still unconfirmed, as D-307 for My Account's banner: part of what it would
  // offer may be in transit, and it opens unasked. A portfolio created beside a saved draft
  // leaves that draft here, so this can be the very next screen (D-397).
  const { pending: pendingAllocates } = usePendingAllocates(intentsAccountId);
  const draftPrompt = useAssignFundsPrompt(
    intentsAccountId,
    newPortfolioDraft ? DRAFT_SUBJECT : null,
    loginConnected &&
      !portfoliosError &&
      !portfoliosLoading &&
      dashboardSectionReady &&
      section === "draft" &&
      draftReady &&
      (pendingAllocates?.length ?? 0) === 0
  );
  const { markSeen: markDraftPromptSeen } = draftPrompt;
  // The deposit window opened from the draft already offers to assign what lands (B-12): coming
  // back from it counts as the answer, or the prompt would ask the same thing again at once.
  const closeReceive = useCallback(() => {
    if (receive === "draft" || section === "draft") markDraftPromptSeen();
    setReceive(null);
  }, [receive, section, markDraftPromptSeen]);
  // D-529: a portfolio's "Add funds" offers a Deposit when the funding account has nothing to assign.
  const openDeposit = useCallback(() => setReceive("plain"), []);

  useEffect(() => {
    if (!intentsAccountId) {
      setDashboardSection(null);
      return;
    }
    // 022-C: entering with a session opens on My Account, whatever was last seen, and stores
    // it so a reload stays there. Once: a later account in this load gets its own section.
    if (enteredRef.current) {
      enteredRef.current = false;
      setDashboardSection({ accountId: intentsAccountId, value: "account" });
      persistDashboardSection(intentsAccountId, "account");
      return;
    }
    setDashboardSection({
      accountId: intentsAccountId,
      value: getDashboardSection(intentsAccountId),
    });
  }, [intentsAccountId]);

  // Refs for stable access inside polling callback
  const showMiCuentaRef = useRef(false);
  showMiCuentaRef.current = showMiCuenta;
  const hasTabsRef = useRef(false);
  hasTabsRef.current = hasTabs;
  // Survives the withdrawal modal being closed and reopened mid-purchase — see `handleBuyGas`.
  const buyingGasRef = useRef(false);

  // D-466: how many withdrawal resolutions the toast on screen stands for.
  const withdrawalsResolvedShownRef = useRef(0);
  useEffect(() => {
    // The summary count lives as long as its toast does (D-466).
    if (toast?.group !== "withdrawal-resolved") withdrawalsResolvedShownRef.current = 0;
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // D-466: a reload can close several withdrawals in one pass (one delivered, one never run),
  // and with a single toast the second one hid the first. While a resolution toast is on
  // screen, the next one turns it into a count that points to My Account, where each row says
  // what happened to it.
  const announceWithdrawalResolved = useCallback(
    (text: string) => {
      const count = (withdrawalsResolvedShownRef.current += 1);
      setToast({
        text: count === 1 ? text : t.withdrawalsResolvedToast.replace("{count}", String(count)),
        group: "withdrawal-resolved",
      });
    },
    [t]
  );

  // The one crediting path for both ways into the General Balance — a bridge deposit (the QR)
  // and a deposit from the NEAR wallet (016 §5.3, block 2a) — so the ledger entry, the balance
  // refresh, the toast and the badge cannot drift between them.
  const creditDeposit = useCallback(
    (p: { assetId: string; qty: number; chain: string; txHash: string; assetLabel: string; source?: "wallet" }) => {
      // A repeat (the same transaction reported twice) changes nothing and announces nothing.
      if (!mockContract.creditReceive(intentsAccountId, p.assetId, p.qty, p.chain, p.txHash, p.source)) return;
      void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });
      // 028-7 (d): the finished row is the history's, from the moment it records the deposit;
      // until then a credited bridge deposit shows nowhere. Only a wallet deposit has a NEAR
      // hash: the bridge's is the origin chain's, and a synthetic key is no hash at all.
      const nearTx = p.source === "wallet" && !p.txHash.startsWith(SYNTHETIC_WALLET_DEPOSIT_TX_PREFIX) ? p.txHash : null;
      void announceOperation(queryClient, intentsAccountId, nearTx);

      setToast({
        text: shellTranslations[lang].depositCredited
          .replace("{asset}", p.assetLabel)
          .replace("{amount}", formatCrypto(p.qty)),
      });

      if (hasTabsRef.current && !showMiCuentaRef.current) {
        setMiCuentaBadge(true);
      }
    },
    [intentsAccountId, lang, queryClient]
  );

  const handleCredited = useCallback(
    (deposit: DepositStatusEntry) => {
      const token = getTokenByNearTokenId(deposit.near_token_id);
      creditDeposit({
        assetId: token?.id ?? assetIdForNearTokenId(deposit.near_token_id),
        qty: deposit.amount / Math.pow(10, deposit.decimals),
        chain: deposit.chain,
        txHash: deposit.tx_hash,
        assetLabel: token?.assetName ?? token?.symbol ?? deposit.near_token_id,
      });
    },
    [creditDeposit]
  );

  const handleWalletDepositCredited = useCallback(
    (credit: WalletDepositCredit) => {
      const token = getTokenById(credit.tokenId);
      if (!token) return;
      // `creditReceive` de-duplicates by this key. A verdict without a hash is still a deposit
      // that landed, so it gets a key of its own rather than none. (`Date.now`, not
      // `crypto.randomUUID`: the latter does not exist on plain-http origins such as a LAN QA box.)
      const txHash = credit.txHash ?? `${SYNTHETIC_WALLET_DEPOSIT_TX_PREFIX}${Date.now()}`;
      // If the bridge's poller also lists this transaction (unmeasured, 016 §5.3 P4 iii), it must
      // not announce it again after a reload. Same key shape the poller writes.
      if (credit.txHash) markDepositNotified(intentsAccountId, `${credit.txHash}:near:mainnet`);
      creditDeposit({
        assetId: credit.tokenId,
        // Float for the mock ledger and the toast only; what was signed stayed in base units.
        qty: fromBaseUnits(credit.amount, token.decimals),
        chain: "near:mainnet",
        txHash,
        assetLabel: token.assetName ?? token.symbol,
        source: "wallet",
      });
      // The wallet balances and the delayed General Balance re-reads are the panel's job
      // (`refreshBalancesAfterWalletDeposit`): it runs them for every verdict, not only credits.
    },
    [creditDeposit, intentsAccountId]
  );

  // B1 (016 block 2.4): "Confirm my portfolio" right after a wallet deposit for the draft.
  const handleConfirmDraftAfterDeposit = useCallback((credit: WalletDepositCredit) => {
    const token = getTokenById(credit.tokenId);
    closeReceive();
    setCreateFlow({
      kind: "after-deposit",
      tokenId: credit.tokenId,
      // An unknown token cannot be waited for: 0 is seen at once and the confirmation opens.
      qty: token ? fromBaseUnits(credit.amount, token.decimals) : 0,
    });
  }, [closeReceive]);

  // 022-B: signed out it is stored too (apart from the accounts'), so a reload stays there.
  const goToSection = useCallback(
    (value: DashboardSection) => {
      if (!loginConnected) {
        // Signed out there are no portfolios to go to.
        if (value === "portfolio") return;
        setSignedOutSection(value);
        persistSignedOutSection(value);
        return;
      }
      if (!intentsAccountId) return;
      setDashboardSection({ accountId: intentsAccountId, value });
      persistDashboardSection(intentsAccountId, value);
    },
    [loginConnected, intentsAccountId]
  );

  // A new portfolio was signed: show it, wherever creation started. The provider already made
  // it the active one; from My Account the view would otherwise stay there.
  const landOnPortfolio = useCallback(() => goToSection("portfolio"), [goToSection]);
  // 019-4: a saved draft is shown on its tab, wherever the editor was opened from.
  const landOnDraft = useCallback(() => goToSection("draft"), [goToSection]);
  // The tabs' "+": another portfolio, even with a draft saved (D-397).
  const openNewPortfolio = useCallback(() => setCreateFlow({ kind: "new", startNew: true }), []);

  // 019-4: discarding happens on the draft's tab, and leaves for My Account. The view hands
  // the focus to the landing there.
  const handleDiscardDraft = useCallback(() => {
    discardNewPortfolioDraft();
    goToSection("account");
  }, [discardNewPortfolioDraft, goToSection]);

  // Whether THIS token would leave through the live path. Also handed to the modal, which
  // uses it to decide whether to ask the bridge for a live fee — one definition of the
  // gate, so the screen and the money can never disagree about which path is running.
  const isRealWithdrawal = useCallback(
    (tokenId: string) =>
      isRealWithdrawalRoute({
        hasSigner: liveSigner !== null,
        loginChain: liveSigner?.chain,
        tokenId,
      }),
    [liveSigner]
  );

  /**
   * The live withdrawal (005.plan §8, block 5.4). Returns a promise that settles when the
   * withdrawal is PUBLISHED — not when it is delivered — because that is the last moment
   * the modal can still be useful. Everything after it happens in the background and shows
   * up in the activity feed.
   *
   * The rule the whole handler is built around: only `fundsState === "untouched"` may be
   * reported as a plain failure. Anything else is published-and-unconfirmed, which is NOT
   * a failure — our timeouts bound what we report, never what the relay and the bridge do.
   */
  const runLiveWithdraw = useCallback(
    async (
      tokenId: string,
      qty: number,
      chainId: string,
      address: string,
      memo: string | undefined,
      signer: NonNullable<typeof liveSigner>,
      /** The modal already ran the `near-native` pre-flight on step 3, off the click path. */
      destinationVerified: boolean,
      /** The live HOT quote the confirm screen showed, exactly as `run-real-withdraw.ts` needs it. */
      hotFee: HotFeeDetail | undefined
    ): Promise<void> => {
      const token = tokenRegistry.find((tk) => tk.id === tokenId) ?? null;
      const symbol = token?.symbol ?? tokenId;
      const chainDisplay = withArrival(getChainMeta(chainId)?.displayName ?? chainId, tokenId, chainId, t.withdrawalArrivesAs);
      const invalidateBalances = () =>
        void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });

      // Keyed on the rescue-store id so a reload mid-flight re-hydrates the SAME row
      // instead of a second one (see `onRecordId`). Null until the signature is in hand:
      // a prompt the user cancels must not leave a row behind.
      let rowId: string | null = null;
      const setStatus = (
        status: WithdrawalInFlightRecord["status"],
        opts?: { txHash?: string; destinationTxHash?: string }
      ) => {
        if (rowId) mockContract.setWithdrawalStatus(rowId, status, opts);
      };

      // Resolves the moment the intent is out; the caller's modal closes on it.
      let markPublished: () => void = () => {};
      let markNeverPublished: (reason: unknown) => void = () => {};
      const published = new Promise<void>((resolve, reject) => {
        markPublished = resolve;
        markNeverPublished = reject;
      });

      const run = runRealWithdraw({
        accountId: intentsAccountId,
        tokenId,
        chainId,
        qty,
        destinationAddress: address,
        destinationMemo: memo,
        destinationAlreadyVerified: destinationVerified,
        hotFee,
        signer: signer.signer,
        onRecordId: (recordId) => {
          rowId = recordId;
          mockContract.trackWithdrawal(recordId, {
            accountId: intentsAccountId,
            tokenId: tokenId as TokenId,
            qty,
            chainId,
            destinationAddress: address,
            ts: Date.now(),
            isReal: true,
          });
        },
        onSettled: (txHash) => setStatus("SETTLED", { txHash }),
        onStage: (stage) => {
          if (stage === "publishing") {
            setToast({
              text: t.withdrawSentToast
                .replace("{qty}", formatCrypto(qty))
                .replace("{symbol}", symbol)
                .replace("{chain}", chainDisplay),
            });
            setWithdrawOpen(false);
            markPublished();
          } else if (stage === "awaiting-settlement") {
            setStatus("TX_BROADCASTED");
          } else if (stage === "awaiting-delivery") {
            // Reaching this stage means the settlement landed: the funds are out of the
            // General Balance, so the balance the user sees is now stale.
            setStatus("SETTLED");
            invalidateBalances();
          }
        },
      });

      run.then(
        (result) => {
          setStatus("DELIVERED", {
            txHash: result.txHash,
            // `hot-omni` (4.3.4) can confirm the delivery without naming a transaction, so
            // the explorer link is optional on that route in a way it never is on `omft`.
            destinationTxHash:
              result.delivery.kind === "near-settlement"
                ? undefined
                : result.delivery.destinationTxHash ?? undefined,
          });
          invalidateBalances();
          setToast({
            text: t.withdrawalDeliveredToast
              .replace("{qty}", formatCrypto(qty))
              .replace("{symbol}", symbol)
              .replace("{chain}", chainDisplay),
          });
          if (!showMiCuentaRef.current) setMiCuentaBadge(true);
        },
        (e: unknown) => {
          // `fundsState` — not the class name — decides what the user is told. It is fixed
          // by block 5.2's error matrix; an error without one never came from the published
          // path, so the balance is intact.
          const fundsState = e instanceof WithdrawError ? e.fundsState : "untouched";

          if (fundsState === "untouched") {
            setStatus("FAILED");
            // A stale balance on screen is what most of these refusals come from (the amount
            // above what the chain holds, D-304 a); a fresh read is what lets a retry succeed.
            invalidateBalances();
            // Rejecting only matters while the modal is still waiting; once it has closed
            // this is a no-op and the toast carries the news.
            markNeverPublished(e);
            setToast({
              text: t.withdrawalNotCompletedToast
                .replace("{qty}", formatCrypto(qty))
                .replace("{symbol}", symbol),
            });
            return;
          }

          // Published, and possibly already settled — we simply stopped watching. Never
          // "failed", and never a claim that the money came back.
          const txHash = e instanceof Error && "txHash" in e ? (e.txHash as string | null) : null;
          setStatus("UNCONFIRMED", { txHash: txHash ?? undefined });
          markPublished();
          invalidateBalances();
          setToast({
            text: t.withdrawalUnconfirmedToast
              .replace("{qty}", formatCrypto(qty))
              .replace("{symbol}", symbol)
              .replace("{chain}", chainDisplay),
          });
          if (!showMiCuentaRef.current) setMiCuentaBadge(true);
        }
      );

      return published;
    },
    [intentsAccountId, queryClient, t]
  );

  // D-392 — the Converting Withdrawal gate, one definition for the screen and the money, like
  // `isRealWithdrawal` above.
  const isConversion = useCallback(
    (heldTokenId: string, chainId: string) =>
      isConversionRoute({
        hasSigner: liveSigner !== null,
        loginChain: liveSigner?.chain,
        heldTokenId,
        chainId,
      }),
    [liveSigner]
  );

  /**
   * Prices a conversion for step 4 (plan 020 §5.3). Here and not in the modal because the quote
   * commits the refund account — the signer's intents account — and because the amount has to
   * be one the EXACT balance covers: the click never shrinks it (C1), so a float "Max" is turned
   * into the raw balance now, the way `capToHeld` does it for a direct withdrawal (D-303).
   */
  // D-441: the ceiling for opening a Solana token account follows the live SOL price. A ref, so a
  // price refresh does not rebuild the seam (the modal re-prices on its own 30 s tick anyway).
  const { prices: livePrices } = useTokenPrices();
  const livePricesRef = useRef(livePrices);
  livePricesRef.current = livePrices;
  // 021 R5: the value under each tab's name, and My Account's funding account (029 B-16).
  const availableGeneralBalance = useAvailableGeneralBalance();
  // D-541: before the first on-chain read an empty balance is the mock fallback — "—", not $0.
  const balanceUnread = useGeneralBalanceRead().status !== "read" && availableGeneralBalance.size === 0;
  const tabValues = useMemo(() => {
    const values = computeTabValues(availableGeneralBalance, portfolios, livePrices);
    return balanceUnread ? { ...values, fundingUsd: null } : values;
  }, [availableGeneralBalance, portfolios, livePrices, balanceUnread]);

  const handleQuoteConversion = useCallback(
    async (p: ConversionQuoteRequest): Promise<ConversionQuoteResult> => {
      const token = getTokenById(p.originTokenId);
      if (!token) return { ok: false, reason: "unavailable", detail: "unknown token" };
      let held: bigint;
      try {
        held = await readHeldOnVerifier(intentsAccountId, p.originTokenId);
      } catch (e) {
        if (e instanceof HeldReadTimeoutError) throw e;
        throw new HeldReadFailedError(e);
      }
      let amount: bigint;
      try {
        amount = capToHeld(BigInt(toBaseUnits(p.qty, token.decimals)), held);
      } catch (e) {
        // The balance on screen is stale; a fresh read is what lets the next try succeed.
        if (e instanceof AmountExceedsBalanceError) {
          void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });
        }
        throw e;
      }
      return quoteConversion({
        originTokenId: p.originTokenId,
        chainId: p.chainId,
        amountRaw: amount.toString(),
        recipient: p.recipient,
        refundTo: intentsAccountId,
        // Only a real quote: the registry's `fallbackUsdPrice` is a guess, not a price.
        liveUsdPrice: (tokenId) => {
          const price = livePricesRef.current[tokenId];
          return price && price.source !== "fallback" ? price.usdPrice : null;
        },
        signal: p.signal,
      });
    },
    [intentsAccountId, queryClient]
  );

  // Both flags and a signer, or nothing: absent, the modal is today's screen (plan 020 §5.5).
  const withdrawConversions = useMemo<WithdrawConversions | undefined>(
    () =>
      REAL_WITHDRAWAL_ENABLED && UNIVERSAL_WITHDRAWAL_ENABLED && liveSigner
        ? { isRoute: isConversion, quote: handleQuoteConversion }
        : undefined,
    [liveSigner, isConversion, handleQuoteConversion]
  );

  /**
   * The live Converting Withdrawal (D-392, plan 020 §5.4). Same contract as `runLiveWithdraw`:
   * resolves when the transfer is PUBLISHED, and only `fundsState === "untouched"` is a plain
   * failure. What differs is the end: 1Click delivers (DELIVERED) or sends it back (REFUNDED,
   * resolved, never "failed"); anything else stays UNCONFIRMED with its record open.
   */
  const runLiveConversion = useCallback(
    async (quote: ConversionQuote, qty: number, signer: NonNullable<typeof liveSigner>): Promise<void> => {
      const heldSymbol = getTokenById(quote.originTokenId)?.symbol ?? quote.originTokenId;
      const delivery = getTokenById(quote.deliveryTokenId);
      const deliverySymbol = delivery?.symbol ?? quote.deliveryTokenId;
      const chainDisplay = getChainMeta(quote.chainId)?.displayName ?? quote.chainId;
      const invalidateBalances = () =>
        void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });

      let rowId: string | null = null;
      const setStatus = (
        status: WithdrawalInFlightRecord["status"],
        opts?: { txHash?: string; destinationTxHash?: string; deliveredAmountRaw?: string }
      ) => {
        if (rowId) mockContract.setWithdrawalStatus(rowId, status, opts);
      };

      let markPublished: () => void = () => {};
      let markNeverPublished: (reason: unknown) => void = () => {};
      const published = new Promise<void>((resolve, reject) => {
        markPublished = resolve;
        markNeverPublished = reject;
      });

      const run = runConversionWithdraw({
        accountId: intentsAccountId,
        quote,
        qty,
        signer: signer.signer,
        onRecordId: (recordId) => {
          rowId = recordId;
          mockContract.trackWithdrawal(recordId, {
            accountId: intentsAccountId,
            tokenId: quote.originTokenId as TokenId,
            qty,
            chainId: quote.chainId,
            destinationAddress: quote.recipient,
            ts: Date.now(),
            isReal: true,
            deliveryTokenId: quote.deliveryTokenId as TokenId,
            depositAddress: quote.depositAddress,
          });
        },
        onStage: (stage) => {
          if (stage === "publishing") {
            setToast({
              text: t.withdrawalConvertingToast
                .replace("{qty}", formatCrypto(qty))
                .replace("{symbol}", heldSymbol)
                .replace("{chain}", chainDisplay),
            });
            setWithdrawOpen(false);
            markPublished();
          } else if (stage === "awaiting-settlement") {
            setStatus("TX_BROADCASTED");
          } else if (stage === "converting") {
            // Settled: the transfer left the General Balance; 1Click has it now.
            setStatus("SETTLED");
            invalidateBalances();
          }
        },
      });

      run.then(
        (result) => {
          invalidateBalances();
          if (!showMiCuentaRef.current) setMiCuentaBadge(true);
          if (result.outcome.kind === "refunded") {
            setStatus("REFUNDED", { txHash: result.txHash });
            // `qty` and not `refundedAmountRaw`: the latter's units are confirmed in 020-4.
            setToast({
              text: t.withdrawalRefundedToast
                .replace("{qty}", formatCrypto(qty))
                .replace("{symbol}", heldSymbol),
            });
            return;
          }
          const { destinationTxHash, amountOutRaw } = result.outcome;
          setStatus("DELIVERED", {
            txHash: result.txHash,
            destinationTxHash: destinationTxHash ?? undefined,
            deliveredAmountRaw: amountOutRaw ?? undefined,
          });
          setToast({
            text: t.withdrawalDeliveredToast
              .replace(
                "{qty}",
                formatCrypto(
                  amountOutRaw !== null && delivery
                    ? fromBaseUnits(BigInt(amountOutRaw), delivery.decimals)
                    : qty
                )
              )
              .replace("{symbol}", deliverySymbol)
              .replace("{chain}", chainDisplay),
          });
        },
        (e: unknown) => {
          const fundsState = e instanceof WithdrawError ? e.fundsState : "untouched";
          if (fundsState === "untouched") {
            setStatus("FAILED");
            invalidateBalances();
            markNeverPublished(e);
            // Step 4 is re-pricing in front of the user: a "not completed" toast would say the
            // opposite of what the modal shows (cross-review 020-4).
            if (wantsRequote(e)) return;
            setToast({
              text: t.withdrawalNotCompletedToast
                .replace("{qty}", formatCrypto(qty))
                .replace("{symbol}", heldSymbol),
            });
            return;
          }
          // Published, possibly settled and with 1Click — never "failed", never "it came back".
          const txHash = e instanceof Error && "txHash" in e ? (e.txHash as string | null) : null;
          setStatus("UNCONFIRMED", { txHash: txHash ?? undefined });
          markPublished();
          invalidateBalances();
          setToast({
            text: t.withdrawalUnconfirmedToast
              .replace("{qty}", formatCrypto(qty))
              .replace("{symbol}", heldSymbol)
              .replace("{chain}", chainDisplay),
          });
          if (!showMiCuentaRef.current) setMiCuentaBadge(true);
        }
      );

      return published;
    },
    [intentsAccountId, queryClient, t]
  );

  const handleWithdrawConfirmed = useCallback(
    async ({
      tokenId,
      qty,
      chainId,
      address,
      memo,
      destinationVerified,
      hotFee,
      conversionQuote,
    }: WithdrawConfirmParams) => {
      if (conversionQuote) {
        // 🔴 A conversion has no mock to fall back to: a quote that reaches here off the live
        // route is refused, never sent down `mockContract.withdraw` below to report a
        // withdrawal that did not happen. Nothing is signed by either refusal.
        if (!liveSigner || !isConversion(tokenId, chainId)) {
          throw new Error("Conversions are not available right now. Nothing was signed.");
        }
        if (
          conversionQuote.originTokenId !== tokenId ||
          conversionQuote.chainId !== chainId ||
          conversionQuote.recipient !== address
        ) {
          throw new Error("The quote does not match this withdrawal. Nothing was signed.");
        }
        // D-280 B4: the same money door as every other way out of the General Balance.
        await ensureCanOperate(keyVerification, verifyKey, lang);
        return runLiveConversion(conversionQuote, qty, liveSigner);
      }
      // 🔴 The other half of the door: a pair that only leaves by conversion, arriving WITHOUT a
      // quote, has no other way out — the direct builder refuses its route and the mock would
      // report a withdrawal that never happened. Unreachable while the modal and this shell share
      // `isConversion`; it is here so the two cannot drift into it (cross-review 020-4).
      if (isConversion(tokenId, chainId)) {
        throw new Error("This withdrawal needs a conversion quote. Nothing was signed.");
      }
      if (liveSigner && isRealWithdrawal(tokenId)) {
        // D-280 B4 — the money door. Inside the live branch and not above it: the mock path
        // moves nothing, so gating it would only deny a demo. 🔴 And NOT expressed as
        // `isRealWithdrawal` answering false, which is the trap this block exists to avoid —
        // that falls through to `mockContract.withdraw` below and reports a withdrawal that
        // never happened. Refuses before the envelope, so nothing is signed; the modal
        // catches it and shows the sentence.
        await ensureCanOperate(keyVerification, verifyKey, lang);
        return runLiveWithdraw(
          tokenId,
          qty,
          chainId,
          address,
          memo,
          liveSigner,
          destinationVerified,
          hotFee
        );
      }

      const token = tokenRegistry.find((tk) => tk.id === tokenId) ?? null;
      const symbol = token?.symbol ?? tokenId;
      const chainDisplay = withArrival(getChainMeta(chainId)?.displayName ?? chainId, tokenId, chainId, t.withdrawalArrivesAs);
      void mockContract.withdraw(
        intentsAccountId,
        tokenId as TokenId,
        qty,
        chainIdToChainKind(chainId),
        address,
        { scheme: "nep413", payload: "", signature: "", publicKey: "" }
      ).then(({ intentId }) => {
        mockContract.trackWithdrawal(intentId, {
          accountId: intentsAccountId,
          tokenId: tokenId as TokenId,
          qty,
          chainId,
          destinationAddress: address,
          ts: Date.now(),
        });
        void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });
      });
      setToast({
        text: t.withdrawSentToast
          .replace("{qty}", formatCrypto(qty))
          .replace("{symbol}", symbol)
          .replace("{chain}", chainDisplay),
      });
      setWithdrawOpen(false);
    },
    [
      intentsAccountId,
      queryClient,
      t,
      lang,
      keyVerification,
      verifyKey,
      liveSigner,
      isRealWithdrawal,
      runLiveWithdraw,
      isConversion,
      runLiveConversion,
    ]
  );

  /**
   * D-251, the two seams the withdrawal modal needs to buy the destination chain's gas.
   *
   * They live here and not in the modal for one reason each: the quote needs the signer's
   * intents account (it is the refund address AND the recipient), and the purchase needs the
   * signer itself. The modal states the trade; this decides who is making it.
   */
  const handleQuoteGas = useCallback(
    (p: GasQuoteRequest) => quoteGasPurchase({ ...p, accountId: intentsAccountId }),
    [intentsAccountId]
  );

  /**
   * Re-reads the balance until the bought token lands, or the budget runs out.
   *
   * Compares against the balance BEFORE the purchase rather than against the amount expected:
   * an increase is unambiguous, while "did it reach 0.04" would also be satisfied by gas that
   * was already there and would be defeated by a rounding difference on the way through a
   * human-unit double (D-206).
   */
  const waitForGasToLand = useCallback(
    (nativeAssetId: string) => {
      // The key comes from the hook that owns it, never spelled out here: a key that drifted
      // would make every read `undefined` and this would report a purchase that landed
      // perfectly as never having arrived. `null` for a missing MAP (nothing cached yet) and
      // `0` for a missing ENTRY, because the balance query drops zero balances — an asset the
      // signer holds none of is a real, readable zero, not a blind spot.
      const key = intentsBalancesQueryKey(intentsAccountId);
      return waitForGasArrival({
        pollMs: GAS_ARRIVAL_POLL_MS,
        budgetMs: GAS_ARRIVAL_BUDGET_MS,
        deps: {
          read: () => {
            const balances = queryClient.getQueryData(key) as Map<string, number> | undefined;
            return balances ? balances.get(nativeAssetId) ?? 0 : null;
          },
          refresh: () => queryClient.invalidateQueries({ queryKey: key }),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
      });
    },
    [intentsAccountId, queryClient]
  );

  const handleBuyGas = useCallback(
    async ({
      quote,
      maxAmountInRaw,
      withdrawalAmountRaw,
    }: {
      quote: GasPurchaseQuote;
      maxAmountInRaw: string;
      withdrawalAmountRaw: string;
    }): Promise<void> => {
      if (!liveSigner) {
        throw new Error("No wallet is connected to sign the purchase");
      }
      // 🔴 Re-entrancy, and a ref rather than state for the same reason `submittingRef` is one
      // on the withdrawal: the modal that hosts the button can be closed and reopened — or
      // torn down entirely — while this is still awaiting a wallet. A remounted screen brings
      // back a live button with no memory of the purchase already in flight, and this is the
      // only thing left standing between that and a second transfer.
      if (buyingGasRef.current) {
        throw new Error("A gas purchase is already in progress");
      }
      buyingGasRef.current = true;
      try {
        // D-280 B4 — the second money door on this screen, and easy to miss because it is not
        // "the withdrawal": buying destination gas (D-251) spends the General Balance through
        // its own signed intent, so an unregistered key fails here exactly as it would there.
        //
        // 🔴 INSIDE the re-entrancy guard, not before it. From `unchecked` this awaits a
        // verification prompt, and the guard above exists precisely because the screen holding
        // the button can be torn down and remounted while a wallet is open — a remounted
        // screen finding the flag unset would start a second purchase. `finally` clears it on
        // a refusal just as it does on a failure.
        await ensureCanOperate(keyVerification, verifyKey, lang);
        await runGasPurchase({
          signerId: intentsAccountId,
          quote,
          withdrawalAmountRaw,
          maxAmountInRaw,
          signer: liveSigner.signer,
        });

        // This await is what keeps the button disabled until the token is actually there.
        // Resolving at the settlement instead would re-enable it while 1Click was still
        // delivering, and the obvious thing to do with a live "Buy gas" button is click it.
        const outcome = await waitForGasToLand(quote.nativeAssetId);
        if (outcome.kind === "arrived") return;

        const symbol = (
          tokenRegistry.find((tk) => tk.id === quote.nativeAssetId)?.symbol ?? quote.nativeAssetId
        )
          .split("(")[0]
          .trim();
        // Neither outcome is a failure and neither may be worded as one: the transfer settled,
        // so the input is with 1Click and the token is theirs to send. `unobservable` says
        // less on purpose — it means this app never saw the balance, so it has no business
        // saying anything about whether the gas is there.
        // 🔴 `left-balance`, and the type matters as much as the words: the screen reads
        // `fundsState` to decide whether to offer the purchase again, and a plain `Error`
        // reads as "nothing moved" — which would put a live Buy button directly under a
        // message saying the token was already paid for. The transfer settled, so the input
        // has left the balance; that is what this says, in both branches.
        throw new GasPurchaseError(
          outcome.kind === "timeout"
            ? `The ${symbol} was paid for but hasn't arrived yet. It should land shortly — ` +
              `this screen unblocks on its own when it does.`
            : `The ${symbol} was paid for. We couldn't read your balance to confirm it ` +
              `arrived — reopen this screen in a moment to check.`,
          "left-balance"
        );
      } finally {
        buyingGasRef.current = false;
      }
    },
    [intentsAccountId, liveSigner, keyVerification, verifyKey, lang, waitForGasToLand]
  );

  const handleWithdrawalDelivered = useCallback(
    (record: WithdrawalInFlightRecord) => {
      // A conversion arrives as its Delivery Token (D-392); a direct withdrawal as itself.
      const arrivedId = record.deliveryTokenId ?? record.tokenId;
      const token = tokenRegistry.find((tk) => tk.id === arrivedId) ?? null;
      const symbol = token?.symbol ?? arrivedId;
      const chainDisplay = withArrival(
        getChainMeta(record.chainId)?.displayName ?? record.chainId,
        arrivedId,
        record.chainId,
        t.withdrawalArrivesAs
      );
      // A conversion resumed after a reload says what ARRIVED, like the live path; `qty` is what
      // was sent, before the network cost on the way out.
      const arrivedQty =
        record.deliveredAmountRaw !== undefined && /^\d+$/.test(record.deliveredAmountRaw) && token
          ? fromBaseUnits(BigInt(record.deliveredAmountRaw), token.decimals)
          : record.qty;
      announceWithdrawalResolved(
        t.withdrawalDeliveredToast
          .replace("{qty}", formatCrypto(arrivedQty))
          .replace("{symbol}", symbol)
          .replace("{chain}", chainDisplay)
      );
      // 017-7: the delivered row's lasting copy is the history's; the tracked one leaves the
      // feed once the history has its settlement (028-7 (d)).
      void announceOperation(queryClient, intentsAccountId, record.txHash ?? null);
      if (!showMiCuentaRef.current) {
        setMiCuentaBadge(true);
      }
    },
    [t, announceWithdrawalResolved, queryClient, intentsAccountId]
  );

  const handleWithdrawalFailed = useCallback(
    (record: WithdrawalInFlightRecord) => {
      const token = tokenRegistry.find((tk) => tk.id === record.tokenId) ?? null;
      const symbol = token?.symbol ?? record.tokenId;
      announceWithdrawalResolved(
        t.withdrawalFailedToast
          .replace("{qty}", formatCrypto(record.qty))
          .replace("{symbol}", symbol)
      );
      void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });
      if (!showMiCuentaRef.current) {
        setMiCuentaBadge(true);
      }
    },
    [t, announceWithdrawalResolved, queryClient, intentsAccountId]
  );

  // A conversion resumed after a reload that 1Click sent back (plan 020 §5.4).
  const handleWithdrawalRefunded = useCallback(
    (record: WithdrawalInFlightRecord) => {
      const symbol = getTokenById(record.tokenId)?.symbol ?? record.tokenId;
      announceWithdrawalResolved(
        t.withdrawalRefundedToast
          .replace("{qty}", formatCrypto(record.qty))
          .replace("{symbol}", symbol)
      );
      void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });
      if (!showMiCuentaRef.current) {
        setMiCuentaBadge(true);
      }
    },
    [t, announceWithdrawalResolved, queryClient, intentsAccountId]
  );

  // D-463: a publish proven on reload never to have run. Its funds never left, so it says so in
  // the words the live path uses for the same fact — not "failed · returned".
  const handleWithdrawalNeverExecuted = useCallback(
    (record: WithdrawalInFlightRecord) => {
      const symbol = tokenRegistry.find((tk) => tk.id === record.tokenId)?.symbol ?? record.tokenId;
      announceWithdrawalResolved(
        t.withdrawalNotCompletedToast
          .replace("{qty}", formatCrypto(record.qty))
          .replace("{symbol}", symbol)
      );
      if (!showMiCuentaRef.current) {
        setMiCuentaBadge(true);
      }
    },
    [t, announceWithdrawalResolved]
  );

  const pendingWithdrawals = usePendingWithdrawals({
    intentsAccountId: loginConnected ? intentsAccountId : "",
    onDelivered: handleWithdrawalDelivered,
    onFailed: handleWithdrawalFailed,
    onRefunded: handleWithdrawalRefunded,
    onNeverExecuted: handleWithdrawalNeverExecuted,
  });

  // ── D-264: a real withdrawal in flight has to be findable from wherever the user lands.
  //
  // The row itself only exists inside My Account, and after a reload the user arrives on a
  // portfolio tab — so the one recovery mechanism a withdrawal has (there is no Solver-side
  // backstop, D-160) sat behind a click nobody had a reason to make. The badge below and the
  // strip in the render make it reachable; neither one MOVES the user, because a withdrawal
  // that stays unresolved for days would otherwise hijack every single load.
  //
  const withdrawalsInFlight = countWithdrawalsInFlight(pendingWithdrawals);

  useEffect(() => {
    if (withdrawalsInFlight === 0) return;
    if (showMiCuentaRef.current) return;
    setMiCuentaBadge(true);
  }, [withdrawalsInFlight]);

  // C1: a settled/failed unallocation changes the General Balance picture — badge My Account
  // when the user is elsewhere so they notice. Available balance recomputes on the mock version
  // bump (the portfolio's reserved qty drops), so no query invalidation is needed here.
  const handleUnallocationResolved = useCallback((_record: PendingUnallocationRecord) => {
    if (!showMiCuentaRef.current) {
      setMiCuentaBadge(true);
    }
  }, []);

  // Drives the async settlement timers for every dashboard view (the editor reads the same
  // pending list without scheduling, since it renders inside this shell).
  const pendingUnallocations = usePendingUnallocations({
    intentsAccountId: loginConnected ? intentsAccountId : "",
    onSettled: handleUnallocationResolved,
    onFailed: handleUnallocationResolved,
  });

  const { deposits } = useRecentDeposits({
    intentsAccountId: loginConnected ? intentsAccountId : "",
    onCredited: handleCredited,
  });

  // `leavesDraftTab`: false for the draft's own tab, whose unsaved edits stay where they are.
  function guardUnsaved(action: () => void, leavesDraftTab = true) {
    const portfolioUnsaved = draftState !== null && draftState.id === activePortfolioId;
    if (portfolioUnsaved || (leavesDraftTab && draftTabUnsaved)) {
      setUnsavedIsDraftTab(!portfolioUnsaved);
      setUnsavedModalPendingAction(() => action);
    } else {
      action();
    }
  }

  function handleMiCuentaClick() {
    guardUnsaved(() => {
      goToSection("account");
      setMiCuentaBadge(false);
    });
  }

  function handlePortfolioTabSelect(portfolioId: string) {
    // D-527: another portfolio opens on Overview, not on the tab the last one was left on.
    // Clicking the portfolio already on screen keeps its tab.
    const switching = section !== "portfolio" || portfolioId !== activePortfolioId;
    guardUnsaved(() => {
      setActivePortfolioId(portfolioId);
      goToSection("portfolio");
      if (switching) router.push(`${basePath ?? "/dashboard"}/overview${window.location.search}` as Route);
    });
  }

  function handleDraftTabSelect() {
    guardUnsaved(() => goToSection("draft"), false);
  }

  // 019-3/019-4: the draft on its tab. Its main action follows the wallet and the General
  // Balance: connect, deposit for it, or confirm it.
  const draftView = newPortfolioDraft && (
    <NewPortfolioDraftView
      draft={newPortfolioDraft}
      {...(!loginConnected
        ? { variant: "signed-out" as const, onConnect: () => setConnectOpen(true) }
        : draftReady
          ? { variant: "ready" as const, amountUsd: fundableUsdNow, onConfirm: () => setCreateFlow({ kind: "new" }) }
          : fundable.status === "loading" || fundable.status === "error"
            ? { variant: "loading" as const }
            : { variant: "waiting" as const, onDeposit: () => setReceive("draft") })}
      // 027 A-10: the rows edited in the tab's table, saved as the rename saves the name.
      onSaveRows={(rows) =>
        saveNewPortfolioDraft(
          { ...newPortfolioDraft, rows },
          loginConnected ? portfolios.map((p) => p.name) : []
        )
      }
      onUnsavedChange={setDraftTabUnsaved}
      onDiscard={handleDiscardDraft}
      onSimulationUsdChange={saveDraftSimulationUsd}
    />
  );
  const draftTab = newPortfolioDraft
    ? {
        name: newPortfolioDraft.name,
        active: section === "draft",
        onSelect: handleDraftTabSelect,
        // 022-G (D-458): the whole draft with its new name, so the simulation's amount stays.
        // A save, so `updatedAt` moves, as on saving in the editor.
        rename: (name: string, existingNames: string[]) => {
          const result = saveNewPortfolioDraft({ ...newPortfolioDraft, name }, existingNames);
          if (result.ok) return { ok: true as const };
          return { ok: false as const, error: result.nameError ?? "" };
        },
        // D-560: from its menu it may be off screen, and then whatever is on screen stays.
        discard: section === "draft" ? handleDiscardDraft : discardNewPortfolioDraft,
      }
    : undefined;
  // With the draft's tab on screen, whatever the route: History and Performance of a portfolio
  // that holds nothing yet would be empty (019-4, plan §5).
  const draftSection = (
    <>
      <SubNav basePath={basePath} draft />
      <main id="main-content" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        {draftView}
      </main>
    </>
  );
  // D-327 — a re-read failed over a list already shown. The list stays (and with it any open
  // editor and modal); this says it may be out of date. Amber, as the full-page read error.
  const refreshFailedStrip = portfoliosRefreshFailed ? (
    <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-2.5"
      >
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-amber-300" />
        <p className="min-w-0 flex-1 text-sm text-amber-100">{t.portfoliosRefreshError}</p>
        <button
          type="button"
          onClick={refetchPortfolios}
          className="shrink-0 rounded-lg border border-amber-300/40 bg-amber-300/10 px-3 py-1.5 text-xs font-medium text-amber-100 transition hover:bg-amber-300/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
        >
          {t.portfoliosReadErrorRetry}
        </button>
      </div>
    </div>
  ) : null;

  const accountView = (
    <main
      id="main-content"
      className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-6 sm:px-6"
    >
      <IntentsAccountView
        onAddFunds={() => setReceive("plain")}
        onWithdraw={() => setWithdrawOpen(true)}
        // A sale sends the General Balance out to 1Click: it answers to the same switch as a withdrawal.
        onSellStock={REAL_WITHDRAWAL_ENABLED ? setSellingTokenId : undefined}
        // Only while the account has no portfolio yet: it is what the view reads as "new".
        onCreatePortfolio={hasPortfolios ? undefined : () => setCreateFlow({ kind: "new" })}
        onDepositForDraft={() => setReceive("draft")}
        onViewDraft={handleDraftTabSelect}
        onConfirmDraft={() => setCreateFlow({ kind: "new" })}
        onOpenPortfolio={handlePortfolioTabSelect}
        signedOut={!loginConnected}
        onConnect={() => setConnectOpen(true)}
        deposits={deposits}
        pendingWithdrawals={pendingWithdrawals}
        pendingUnallocations={pendingUnallocations}
        onDismissWithdrawal={dismissWithdrawal}
      />
    </main>
  );

  return (
    <div data-app-theme="" className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <a
        href="#main-content"
        className="fixed left-4 top-4 z-[100] -translate-y-20 rounded-xl bg-cyan-300 px-4 py-2 text-sm font-semibold text-black opacity-0 transition-[transform,opacity] duration-150 focus:translate-y-0 focus:opacity-100 focus:outline-none"
      >
        {t.skipToMain}
      </a>
      <DashboardHeader
        onGettingStarted={welcomeKey !== null ? () => setWelcomeFor(welcomeKey) : undefined}
        onConnect={() => setConnectOpen(true)}
        // 027 A-3: a created portfolio, not the draft, and not its balance: emptying one keeps them
        // out. Still loading counts as having one (no show-then-hide); a failed read does not.
        inWalletMenuOnly={!portfoliosError && (portfoliosLoading || hasPortfolios)}
      />
      {/* D-280 B2. Above every dashboard sub-state on purpose: the gate is about whether
          this wallet can operate AT ALL, so it must not be reachable only from the tab the
          user happens to be on. It renders nothing for a healthy account and for the five
          families the gate does not apply to. */}
      {loginConnected && <NearKeyVerificationNotice lang={lang} />}
      {loginConnected ? (
        // Order matters, and it is the point of 008.plan Phase 1. The read-model went from
        // synchronous (localStorage) to an RPC, so "still asking" must be ruled out BEFORE
        // "you have none" — otherwise every load flashes the create-your-first-portfolio
        // screen at someone whose funds are already on chain. And a failed read must never
        // fall through to that screen at all: it says so.
        portfoliosError ? (
          <main
            id="main-content"
            className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-6 sm:px-6"
          >
            <div
              role="alert"
              className="mx-auto mt-10 max-w-md rounded-2xl border border-amber-400/30 bg-amber-400/5 px-5 py-4 text-center"
            >
              <p className="text-sm font-medium text-amber-100">{t.portfoliosReadErrorTitle}</p>
              <p className="mt-2 text-sm text-amber-100/80">{t.portfoliosReadErrorBody}</p>
              <button
                type="button"
                onClick={refetchPortfolios}
                className="mt-4 rounded-xl border border-amber-300/40 bg-amber-300/10 px-4 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-300/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
              >
                {t.portfoliosReadErrorRetry}
              </button>
            </div>
          </main>
        ) : portfoliosLoading || !dashboardSectionReady ? (
          <main
            id="main-content"
            className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-6 sm:px-6"
            aria-busy="true"
          >
            <p className="mx-auto mt-10 text-sm text-slate-400">{t.portfoliosLoading}</p>
          </main>
        ) : hasTabs ? (
          <>
            <PortfolioTabs
              miCuentaActive={showMiCuenta}
              miCuentaBadge={miCuentaBadge}
              onMiCuentaClick={handleMiCuentaClick}
              onPortfolioTabSelect={handlePortfolioTabSelect}
              draftTab={draftTab}
              onNewPortfolio={openNewPortfolio}
              values={tabValues}
            />
            {refreshFailedStrip}
            {/* 016 block 2.4 put a "ready" strip for the draft on every portfolio tab; D-517 took
                it out: on another portfolio it read as being about that one. My Account's card, the
                draft's own tab and the one-time AssignFundsPrompt still say it. */}
            {/* D-264 — the only place a withdrawal in flight is visible from a portfolio tab.
                Amber and not red: nothing here has failed. It goes through `handleMiCuentaClick`
                rather than setting the view directly so an unsaved draft still gets its
                warning, exactly as the tab does. */}
            {!showMiCuenta && withdrawalsInFlight > 0 && (
              <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
                <div
                  role="status"
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-2.5"
                >
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full bg-amber-300"
                  />
                  <p className="min-w-0 flex-1 text-sm text-amber-100">
                    {withdrawalsInFlight === 1
                      ? t.withdrawalInFlightOne
                      : t.withdrawalInFlightMany.replace("{count}", String(withdrawalsInFlight))}
                  </p>
                  <button
                    type="button"
                    onClick={handleMiCuentaClick}
                    className="shrink-0 rounded-lg border border-amber-300/40 bg-amber-300/10 px-3 py-1.5 text-xs font-medium text-amber-100 transition hover:bg-amber-300/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
                  >
                    {t.withdrawalInFlightView}
                  </button>
                </div>
              </div>
            )}
            {showMiCuenta ? (
              accountView
            ) : section === "draft" ? (
              draftSection
            ) : (
              <>
                <SubNav basePath={basePath} />
                <main
                  id="main-content"
                  className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6"
                >
                  <DepositActionProvider value={openDeposit}>{children}</DepositActionProvider>
                </main>
              </>
            )}
          </>
        ) : (
          // D-419: no portfolio and no draft — the strip stays ("My Account" + "New portfolio"),
          // My Account is what is on screen, and the guided start follows below.
          <>
            <PortfolioTabs
              miCuentaActive
              onMiCuentaClick={() => {}}
              onNewPortfolio={openNewPortfolio}
              values={tabValues}
            />
            {refreshFailedStrip}
            {accountView}
          </>
        )
      ) : loginRestoring ? (
        <main
          id="main-content"
          className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6"
          aria-busy="true"
        />
      ) : (
        // Signed out (022-A/B, D-453; was 019-2's start screen): My Account in the shape of a
        // new account, at $0 and marked as having no wallet. Building leads; connecting is the
        // only money action. The strip is D-419's, with no figure on My Account. A draft built
        // signed out brings its tab, the same tab and view as with a wallet (019-4).
        <>
          <PortfolioTabs
            miCuentaActive={showMiCuenta}
            onMiCuentaClick={handleMiCuentaClick}
            draftTab={draftTab}
            onNewPortfolio={openNewPortfolio}
            signedOut
          />
          {showMiCuenta ? accountView : draftSection}
        </>
      )}
      {connectOpen && <ConnectWalletModal onClose={closeConnect} />}
      <ReceiveModal
        open={receive !== null}
        lang={lang}
        onClose={closeReceive}
        onWalletDepositCredited={handleWalletDepositCredited}
        onConfirmDraft={handleConfirmDraftAfterDeposit}
        draftContext={
          receive === "draft" && newPortfolioDraft
            ? { name: newPortfolioDraft.name, tokenIds: newPortfolioDraft.rows.map((r) => r.tokenId) }
            : undefined
        }
      />
      {sellingTokenId ? <StockSellModal tokenId={sellingTokenId} onClose={() => setSellingTokenId(null)} /> : null}
      <WithdrawalModal
        open={withdrawOpen}
        lang={lang}
        onClose={() => setWithdrawOpen(false)}
        onConfirmed={handleWithdrawConfirmed}
        isRealRoute={isRealWithdrawal}
        // Both or neither: with no signer there is nothing to sign the purchase with, and an
        // offer that cannot be acted on is worse than the plain blocked screen.
        onQuoteGas={liveSigner ? handleQuoteGas : undefined}
        onBuyGas={liveSigner ? handleBuyGas : undefined}
        conversions={withdrawConversions}
      />
      {createFlow && (
        <CreatePortfolioFlow
          onClose={() => setCreateFlow(null)}
          onDraftSaved={landOnDraft}
          afterDeposit={
            createFlow.kind === "after-deposit"
              ? { tokenId: createFlow.tokenId, qty: createFlow.qty }
              : undefined
          }
          onCreated={landOnPortfolio}
          signedOut={!loginConnected}
          startNew={createFlow.kind === "new" && createFlow.startNew}
        />
      )}
      {welcomeOpen && (
        <WelcomeModal
          hasPortfolios={hasPortfolios}
          hasDraft={newPortfolioDraft !== null}
          onClose={closeWelcome}
          // 022-D (D-455): with a draft saved, the CTA leads to its tab, the way its tab does.
          // Without one the creation flow opens the chooser, and the editor's actions follow the funds.
          onStart={newPortfolioDraft ? handleDraftTabSelect : () => setCreateFlow({ kind: "new" })}
          // 029 B-19: the deposit step, as My Account's: signed out there is nothing to deposit
          // into yet, so it connects first.
          onDeposit={loginConnected ? () => setReceive("plain") : () => setConnectOpen(true)}
        />
      )}
      {draftPrompt.open && newPortfolioDraft && (
        <AssignFundsPrompt
          lang={lang}
          message={t.draftReadyTitle
            .replace("{amount}", formatUsd(fundableUsdNow))
            .replace("{name}", newPortfolioDraft.name)}
          onAssign={() => {
            markDraftPromptSeen();
            setCreateFlow({ kind: "new" });
          }}
          onNotNow={markDraftPromptSeen}
        />
      )}
      {unsavedModalPendingAction && (
        <UnsavedChangesModal
          draft={unsavedIsDraftTab}
          onDiscard={() => { setDraftState(null); unsavedModalPendingAction(); }}
          onClose={() => setUnsavedModalPendingAction(null)}
        />
      )}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
        >
          <div
            className="rounded-xl border border-slate-700 bg-slate-900/95 px-4 py-2.5 text-sm text-slate-100 shadow-2xl backdrop-blur"
            style={{ animation: "toastIn 220ms cubic-bezier(.2,.8,.2,1)" }}
          >
            {toast.text}
          </div>
        </div>
      )}
    </div>
  );
}
