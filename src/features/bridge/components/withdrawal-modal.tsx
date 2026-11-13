"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getTokenById } from "@/features/market/lib/token-registry";
import { ChainIcon, hasChainIcon } from "@/features/market/lib/token-icons";
import { TokenAvatar } from "@/features/market/lib/token-avatar";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { colorForSymbol, formatUsd, formatTokenAmount, formatCrypto } from "@/features/portfolio-editor/lib/format";
import type { Language } from "@/features/portfolio-editor/types";
import { useDialogFocus } from "@/features/portfolio-editor/hooks/use-dialog-focus";
import { useAvailableGeneralBalance } from "@/features/dashboard-shell/hooks/use-available-general-balance";
import {
  getWithdrawalEntry,
  NEAR_DESTINATION_CHAIN_ID,
  unreceivableNearDestination,
  withdrawalDestinations,
} from "../lib/withdrawal-registry";
import { isStockToken } from "@/features/market/lib/stock-tokens";
import { isTokenAvailable } from "../lib/token-availability";
import {
  fetchWithdrawalFee,
  minimumWithdrawalRaw,
  staticWithdrawalFee,
  supportsLiveWithdrawalFee,
  type WithdrawalFeeQuote,
} from "../lib/withdrawal-fee";
import {
  nativeGasBalanceRaw,
  type HotFeeDetail,
  type HotGasRequirement,
} from "../lib/hot-fee";
import { gasPurchaseTargetRaw } from "../lib/gas-purchase";
import type { OmniFeeDetail } from "../lib/omni-bridge";
import type {
  BuyGasSeam,
  GasPurchaseQuote,
  GasQuoteSeam,
} from "../lib/gas-purchase";
import { WithdrawError } from "../lib/withdraw-errors";
import { isWalletRefusal } from "../lib/wallet-refusal";
import {
  assertNearDestinationUsable,
  defaultNearDestinationProbe,
  nearDestinationIsContract,
} from "../lib/withdraw-submit";
import {
  assertSolanaDestinationUsable,
  defaultSolanaDestinationProbe,
  SolanaDestinationUnusableError,
  type SolanaDestinationProblem,
} from "../lib/solana-destination";
import {
  WithdrawDestinationUnusableError,
  type WithdrawDestinationProblem,
} from "../lib/withdraw-errors";
import { getChainMeta } from "../lib/chain-registry";
import { bridgeTranslations } from "../lib/translations";
import { AssetSearch, matchAssetGroups } from "./asset-search";
import { validateAddress, detectWrongChain, normalizeAddress } from "../lib/address-validation";
import { ownWalletDestination } from "../lib/own-wallet-destination";
import { useLoginWallet } from "@/features/login-wallet";
import type { TokenPriceMap } from "@/features/market/types";
import { formatDecimalForInput } from "@/features/portfolio-editor/lib/decimal-input";
import { AmountExceedsBalanceError, fromBaseUnits, toBaseUnits } from "@/features/vault/lib/base-units";
import {
  useSendTransactionAs,
  type SendTransactionAs,
} from "@/features/vault/context/real-allocate-context";
import { HeldReadFailedError, HeldReadTimeoutError } from "../lib/run-real-withdraw";
import {
  readRegistrationCost,
  registerNearDestination,
  type StorageRegistrationResult,
} from "../lib/near-storage-registration";
import { formatBaseUnits } from "../lib/near-wallet-deposit";
import {
  deliveryDestinations,
  withdrawalPlan,
  type WithdrawalPlan,
} from "../lib/conversion-routes";
import {
  conversionCostBps,
  type ConversionQuote,
  type ConversionQuoteResult,
} from "../lib/oneclick-conversion-quote";
import { ConversionNotSignableError, wantsRequote } from "../lib/conversion-envelope";

// D-387 (c): chains whose addresses another chain's pass for, checksum included: a Bitcoin
// Cash legacy address (1… / 3…) is a valid Bitcoin one, a DigiByte D… a valid Dogecoin one, and
// a Zclassic t1… / t3… (a Zcash fork that kept the same version prefixes) a valid Zcash one (D-579).
const LOOKALIKE_ADDRESS_CHAIN: Record<string, string> = {
  "btc:mainnet": "Bitcoin Cash",
  "doge:mainnet": "DigiByte",
  "zec:mainnet": "Zclassic",
};

const LS_LAST_USED_WITHDRAWAL_TOKEN = "last-used-withdrawal-token";

// Step 3's two actions trade weights after the `not-registered` refusal (D-374). Vertical
// padding is left to the caller.
const PRIMARY_BUTTON =
  "w-full rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";
const SECONDARY_BUTTON =
  "w-full rounded-xl border border-accent/60 px-4 py-2.5 text-sm font-semibold text-accent transition hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

/** Why the destination cannot receive, in the user's language. Keys mirror the error's own. */
const DESTINATION_PROBLEM_KEY: Record<
  WithdrawDestinationProblem,
  "destinationMissing" | "destinationNotRegistered" | "destinationUnverified"
> = {
  "missing-account": "destinationMissing",
  "not-registered": "destinationNotRegistered",
  unverified: "destinationUnverified",
};

/**
 * The refusals raised before anything is signed that the user can act on, in their language
 * (D-304 a). Their own messages are English and speak in base units. Anything else keeps its
 * sentence: the key gate's is already localized, and the rest are rare enough to stay raw.
 */
function withdrawErrorText(e: unknown, t: (typeof bridgeTranslations)["en"]): string {
  if (isWalletRefusal(e)) return t.withdrawErrorWalletRefused;
  if (e instanceof AmountExceedsBalanceError) return t.withdrawErrorExceedsBalance;
  if (e instanceof HeldReadTimeoutError) return t.withdrawErrorBalanceSlow;
  if (e instanceof HeldReadFailedError) return t.withdrawErrorBalanceRead;
  if (e instanceof ConversionNotSignableError) {
    return e.reason === "signer-mismatch"
      ? t.conversionSignerMismatch
      : e.reason === "quote-invalid"
        ? t.conversionQuoteInvalid
        : t.conversionRequoted;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * The Solana equivalent. Note what is NOT here: `new-account`. On Solana an absent destination
 * is a warning the user can walk past (D-213), so it never travels as an error and has no
 * entry in this map.
 */
const SOLANA_DESTINATION_PROBLEM_KEY: Record<
  SolanaDestinationProblem,
  "destinationTokenAccount" | "destinationProgramAccount" | "destinationUnverified"
> = {
  "token-account": "destinationTokenAccount",
  "program-account": "destinationProgramAccount",
  unverified: "destinationUnverified",
};

// A withdrawable balance the user holds for one specific symbol on one specific network.
type WithdrawVariant = {
  tokenId: string;
  chainId: string;
  displayName: string;
  memoRequired: boolean;
  qty: number;
  usd: number;
  price: number;
  /**
   * False for a row deferred to the next MVP (008.plan §Alcance). Unlike Receive, this
   * picker is driven by the balance, so a deferred row only appears at all for a user who
   * already holds one — acquired outside IntentFolio, since Receive no longer offers it.
   * It is listed rather than dropped so the balance still adds up on screen.
   */
  available: boolean;
};

// All variants the user holds for the same symbol, aggregated for the step-1 picker.
// D-153 option B: symbols are grouped, but each variant keeps its own network/tokenId.
type WithdrawGroup = {
  assetName: string;
  ticker: string;
  totalQty: number;
  totalUsd: number;
  variants: WithdrawVariant[];
};

/** A group is selectable while at least one of its networks is. */
function groupAvailable(group: WithdrawGroup): boolean {
  return group.variants.some((v) => v.available);
}

type Step = 1 | 2 | 3 | 4;

/**
 * An object rather than positional arguments, for the same reason `isRealWithdrawalRoute`
 * takes a required `tokenId`: the last field is a safety flag, and a safety flag in the sixth
 * positional slot is one a caller silently forgets.
 */
export type WithdrawConfirmParams = {
  tokenId: string;
  qty: number;
  chainId: string;
  address: string;
  /**
   * Not cosmetic: on chains that route on a tag, the envelope is built WITH it and
   * `submitWithdraw` throws if the caller did not pass the same value, so dropping it here is
   * a loud failure rather than misrouted funds.
   */
  memo?: string;
  /**
   * The `near-native` destination pre-flight already ran and passed, on the Continue of step 3
   * — outside the click that opens the wallet prompt. False for every other route, and for a
   * mock withdrawal, in which case the money path runs the check itself.
   */
  destinationVerified: boolean;
  /**
   * The live HOT quote step 4 showed and re-confirmed, exactly as `run-real-withdraw.ts`
   * needs it — undefined for every other route. See `hotFee` in `RunRealWithdrawParams`.
   */
  hotFee?: HotFeeDetail;
  /**
   * The live Omni Bridge quote step 4 showed (`omni` route, D-580) — undefined for every other
   * route. Signed like `hotFee`: see `omniFee` in `RunRealWithdrawParams`.
   */
  omniFee?: OmniFeeDetail;
  /**
   * D-392: the quote step 4 showed, for a Converting Withdrawal — signed exactly as is
   * (`runConversionWithdraw`). Undefined for a direct one, and its presence is what tells the
   * caller which path this is: the caller must never send it down the mock.
   */
  conversionQuote?: ConversionQuote;
};

/** What step 4 asks the caller to price. Human units: the caller owns base units and the account. */
export type ConversionQuoteRequest = {
  originTokenId: string;
  chainId: string;
  qty: number;
  recipient: string;
  signal?: AbortSignal;
};

/**
 * D-392's two seams, both or nothing (plan 020 §5.3). Absent, this screen is exactly today's.
 *
 * `isRoute` is `isConversionRoute`, injected for the reason `isRealRoute` is: one definition of
 * the gate. `quote` lives with the caller because the quote's refund account is the signer's
 * intents account, and because it caps the amount against the EXACT balance (C1 never shrinks
 * an amount at the click, so the quote has to be for an amount the balance covers).
 */
export type WithdrawConversions = {
  isRoute: (heldTokenId: string, chainId: string) => boolean;
  quote: (p: ConversionQuoteRequest) => Promise<ConversionQuoteResult>;
};

type Props = {
  open: boolean;
  lang: Language;
  onClose: () => void;
  /**
   * May return a promise. The real path resolves it once the withdrawal is on its way — and
   * rejects if it never went out, which is what lets this modal keep the user's inputs and
   * show the error instead of closing over a wallet rejection.
   */
  onConfirmed?: (params: WithdrawConfirmParams) => void | Promise<void>;
  /**
   * Whether THIS token would take the live money path. Injected rather than derived here so
   * the modal stays wallet-free and the gate keeps a single definition
   * (`isRealWithdrawalRoute`). Also decides whether to ask the bridge for a live fee: with
   * the flag off nothing about this screen may change, network calls included.
   */
  isRealRoute?: (tokenId: string) => boolean;
  /**
   * Whether THIS token is in the day-1 scope (008.plan §Alcance). Defaults to the real
   * allowlist, so production is gated whether or not a caller remembers this prop — the
   * opposite default from `isRealRoute`, because here the safe answer is "closed".
   *
   * A seam rather than a bare import so the D-257 gas-purchase suite can still drive the
   * machinery it covers: that code serves the 10 non-native `hot-omni` rows, which the MVP
   * defers but does not delete. Overriding it in a test asserts the purchase logic; it says
   * nothing about what the shipped picker offers, which `token-availability.test.ts` fixes.
   */
  isAvailable?: (tokenId: string) => boolean;
  /**
   * D-251's way out of a blocked confirm screen, in two seams for one reason: the modal may
   * price the purchase (a fetch) but may never make it (a signature). Both must be supplied
   * or the offer does not appear at all — a price with no way to act on it is worse than the
   * plain "we couldn't get the fee" the screen already shows.
   *
   * Injected exactly like `isRealRoute`, and for a stronger version of the same reason: the
   * quote needs the signer's account as refund address and recipient, and this component
   * deliberately cannot name it.
   */
  onQuoteGas?: GasQuoteSeam;
  onBuyGas?: BuyGasSeam;
  /** D-392, behind `NEXT_PUBLIC_UNIVERSAL_WITHDRAWAL`. See `WithdrawConversions`. */
  conversions?: WithdrawConversions;
};

export function WithdrawalModal({
  open,
  lang,
  onClose,
  onConfirmed,
  isRealRoute,
  isAvailable = isTokenAvailable,
  onQuoteGas,
  onBuyGas,
  conversions,
}: Props) {
  const t = bridgeTranslations[lang];
  const [step, setStep] = useState<Step>(1);
  const [selectedAssetName, setSelectedAssetName] = useState<string | null>(null);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const [lastUsedToken, setLastUsedToken] = useState<string | null>(null);
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [withdrawQty, setWithdrawQty] = useState(0);
  const [withdrawMemo, setWithdrawMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Step 3's registration signature (D-316). Same reason as `submitting`: closing or going back
  // while a wallet prompt is up throws away the answer the user is about to give.
  const [registeringAccount, setRegisteringAccount] = useState(false);
  // Step 3's destination pre-flight. Leaving mid-check let its late answer land on whatever
  // the user picked next — a NEAR account cleared for a withdrawal now routed to the bridge.
  const [checkingDestination, setCheckingDestination] = useState(false);
  const busy = submitting || registeringAccount || checkingDestination;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [destinationVerified, setDestinationVerified] = useState(false);
  // Bumped when the click refused a conversion quote that a fresh one fixes (C1/C2).
  const [requoteTick, setRequoteTick] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The re-entrancy guard, and it has to be a ref rather than the `submitting` state: the
  // confirm click can await a fee re-check before it ever reaches `handleConfirm`, so a second
  // click starts its own handler whose closure captured `submitting === false`. A ref is read
  // at call time, which is the only moment that can see the first click.
  const submittingRef = useRef(false);

  const generalBalance = useAvailableGeneralBalance();
  const { prices } = useTokenPrices();
  const { connection } = useLoginWallet();
  // Registering the destination with a token (D-316) is signed by the user's NEAR wallet, so it
  // is offered only to a NEAR login. Null under `RealAllocateDisabled`, like every live path.
  const sendTransactionAs = useSendTransactionAs();
  const registerSend = connection?.chainKind === "near" ? sendTransactionAs : null;

  useEffect(() => {
    if (open) {
      setLastUsedToken(localStorage.getItem(LS_LAST_USED_WITHDRAWAL_TOKEN));
      setStep(1);
      setSelectedAssetName(null);
      setSelectedTokenId(null);
      setSelectedChainId(null);
      setWithdrawAddress("");
      setWithdrawQty(0);
      setWithdrawMemo("");
      setSubmitting(false);
      setRegisteringAccount(false);
      setCheckingDestination(false);
      setSubmitError(null);
      setDestinationVerified(false);
      submittingRef.current = false;
    }
  }, [open]);

  // Closing while a signature is pending would strand the user: the wallet prompt is still
  // up, and the screen that explains what they are approving is gone.
  const closeIfIdle = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  useDialogFocus(dialogRef, { active: open, onEscape: closeIfIdle, initialFocusRef: dialogRef });

  // D-487: on a phone the sheet is as tall as its content, so filtering step 1's list shrank it
  // and the search box jumped down with each letter. Step 1 opens with the full list (the search
  // starts empty; re-measured when the balances behind it arrive): its height is kept as a floor
  // until the step changes. `min(…, 85dvh)` keeps a floor from outgrowing a viewport that shrank
  // since (rotation, keyboard).
  const [sheetFloor, setSheetFloor] = useState<number | null>(null);
  useLayoutEffect(() => {
    setSheetFloor(open && step === 1 ? dialogRef.current?.offsetHeight ?? null : null);
  }, [open, step, generalBalance]);

  if (!open) return null;

  /**
   * Where a held token can go. Without conversions, today's list. With them (plan 020 §5.2–5.3),
   * the family's delivery chains: a direct one while its route is available, a converting one
   * while `isConversionRoute` opens it.
   */
  const destinationsFor = (tokenId: string): string[] => {
    if (!conversions) return withdrawalDestinations(tokenId);
    return deliveryDestinations(tokenId).filter((c) => {
      const plan = withdrawalPlan(tokenId, c);
      if (plan.kind === "conversion") return conversions.isRoute(tokenId, c);
      return plan.kind === "direct" && isAvailable(tokenId);
    });
  };

  // Group withdrawable balances by symbol (assetName). Each group keeps its per-network
  // variants so step 2 can debit the specific tokenId the user picks (D-153 option B).
  const groupMap = new Map<string, WithdrawGroup>();
  for (const [tokenId, qty] of generalBalance) {
    if (qty <= 0) continue;
    const entry = getWithdrawalEntry(tokenId);
    if (!entry) continue;
    const token = getTokenById(tokenId);
    const meta = getChainMeta(entry.chainId);
    const price = prices[tokenId]?.usdPrice ?? token?.fallbackUsdPrice ?? 0;
    const usd = qty * price;
    const symbol = token?.symbol ?? tokenId;
    const key = token?.assetName ?? symbol;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        assetName: key,
        ticker: symbol.split("(")[0].trim(),
        totalQty: 0,
        totalUsd: 0,
        variants: [],
      });
    }
    const group = groupMap.get(key)!;
    group.totalQty += qty;
    group.totalUsd += usd;
    group.variants.push({
      tokenId,
      chainId: entry.chainId,
      displayName: meta?.displayName ?? entry.chainId,
      memoRequired: meta?.memoRequired ?? false,
      qty,
      usd,
      price,
      // With conversions a row with no direct route can still leave by converting (USDT on
      // Polygon, plan 020 §4) — and one with neither stays listed and disabled, as today.
      available: conversions ? destinationsFor(tokenId).length > 0 : isAvailable(tokenId),
    });
  }

  const groups = [...groupMap.values()];
  // Deferred rows sink below the selectable ones in both lists, then the existing
  // balance-first order applies within each block — a row the user cannot act on should not
  // outrank one they can just because it holds more money.
  for (const group of groups) {
    group.variants.sort(
      (a, b) =>
        Number(b.available) - Number(a.available) ||
        b.usd - a.usd ||
        a.displayName.localeCompare(b.displayName)
    );
  }
  groups.sort(
    (a, b) =>
      Number(groupAvailable(b)) - Number(groupAvailable(a)) ||
      b.totalUsd - a.totalUsd ||
      a.ticker.localeCompare(b.ticker)
  );

  const variantsForGroup: WithdrawVariant[] = selectedAssetName
    ? groupMap.get(selectedAssetName)?.variants ?? []
    : [];

  const sortedGroups = lastUsedToken
    ? [
        ...groups.filter((g) => g.assetName === lastUsedToken),
        ...groups.filter((g) => g.assetName !== lastUsedToken),
      ]
    : groups;

  // The token's own chain today. With conversions, the first of its destinations — for a row
  // that only converts (USDT on Polygon) its own chain is not one.
  function firstDestination(variant: WithdrawVariant): string {
    return conversions ? destinationsFor(variant.tokenId)[0] ?? variant.chainId : variant.chainId;
  }

  function handleSelectGroup(group: WithdrawGroup) {
    localStorage.setItem(LS_LAST_USED_WITHDRAWAL_TOKEN, group.assetName);
    setSelectedAssetName(group.assetName);
    // Step 2 is shown even for a single network (D-488, reverting D-153 option B's skip): the
    // network is where a mistake loses money, so the user always sees which one is debited.
    setSelectedTokenId(null);
    setSelectedChainId(null);
    setStep(2);
  }

  function handleSelectVariant(variant: WithdrawVariant) {
    if (!variant.available) return;
    setSelectedTokenId(variant.tokenId);
    setSelectedChainId(firstDestination(variant));
    setStep(3);
  }

  function handleBack() {
    setSubmitError(null);
    if (step === 2) setStep(1);
    else if (step === 3) setStep(2);
    else if (step === 4) setStep(3);
  }

  // Awaits `onConfirmed` so the mock path (which returns void) still closes synchronously
  // through its own `setWithdrawOpen(false)`, exactly as before, while the real path can
  // hold the screen until the withdrawal is published — or surface why it never was.
  async function handleConfirm(
    tokenId: string,
    chainId: string,
    hotFee: HotFeeDetail | undefined,
    conversionQuote?: ConversionQuote,
    omniFee?: OmniFeeDetail
  ) {
    // Two clicks can both reach here: the confirm handler awaits a fee re-check first, and
    // nothing has disabled the button yet at that point. Without this, each would build its
    // own envelope with its own nonce and raise its own wallet prompt — two real withdrawals.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await onConfirmed?.({
        tokenId,
        qty: withdrawQty,
        chainId,
        address: withdrawAddress,
        memo: withdrawMemo || undefined,
        destinationVerified,
        hotFee,
        omniFee,
        conversionQuote,
      });
    } catch (e) {
      // Only reaches here when the funds are intact — the caller resolves rather than
      // rejects for anything it cannot rule out (`published-unconfirmed`), so this copy is
      // allowed to say the balance is unchanged.
      console.warn("[withdraw] not published:", e);
      // A stale quote is not an error to the user: nothing was signed, and step 4 re-prices and
      // shows the new figures against the old ones (operator, s227).
      if (wantsRequote(e)) setRequoteTick((n) => n + 1);
      else setSubmitError(withdrawErrorText(e, t));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }

  // The live plan for what is selected, when it converts. `null` keeps steps 3 and 4 direct.
  const selectedPlan: WithdrawalPlan | null =
    conversions && selectedTokenId && selectedChainId
      ? withdrawalPlan(selectedTokenId, selectedChainId)
      : null;
  const conversionPlan =
    selectedPlan?.kind === "conversion" &&
    conversions?.isRoute(selectedTokenId!, selectedPlan.chainId)
      ? selectedPlan
      : null;
  const step2Title = conversions ? t.withdrawStep2TitleConversions : t.withdrawStep2Title;

  const stepTitle =
    step === 2 ? step2Title :
    step === 3 ? t.withdrawStep3Title :
    step === 4 ? t.withdrawStep4Title :
    t.withdrawModalTitle;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={closeIfIdle}
        aria-hidden="true"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="withdrawal-modal-title"
        tabIndex={-1}
        className="relative z-10 flex w-full flex-col rounded-t-2xl glass bg-slate-900 outline-none sm:max-w-md sm:rounded-2xl"
        style={{ maxHeight: "85dvh", minHeight: sheetFloor ? `min(${sheetFloor}px, 85dvh)` : undefined }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-5 py-4">
          <div className="flex items-center gap-3">
            {step > 1 && (
              <button
                type="button"
                onClick={handleBack}
                disabled={busy}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                aria-label={t.back}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 5-7 7 7 7"/></svg>
              </button>
            )}
            <h2 id="withdrawal-modal-title" className="text-base font-semibold text-slate-100">
              {stepTitle}
            </h2>
          </div>
          <button
            type="button"
            onClick={closeIfIdle}
            disabled={busy}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            aria-label={t.close}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {step === 1 && (
            <WithdrawTokenPicker
              groups={sortedGroups}
              holdsStock={[...generalBalance].some(([id, qty]) => qty > 0 && isStockToken(id))}
              lastUsedToken={lastUsedToken}
              t={t}
              onSelect={handleSelectGroup}
            />
          )}
          {step === 2 && (
            <WithdrawChainPicker
              variants={variantsForGroup}
              title={step2Title}
              t={t}
              onSelect={handleSelectVariant}
            />
          )}
          {step === 3 && selectedTokenId && selectedChainId && (
            <WithdrawStep3
              tokenId={selectedTokenId}
              chainId={selectedChainId}
              generalBalance={generalBalance}
              prices={prices}
              t={t}
              initialAddress={withdrawAddress}
              initialQty={withdrawQty}
              initialMemo={withdrawMemo}
              ownWalletAddress={ownWalletDestination(connection, selectedChainId)}
              destinations={destinationsFor(selectedTokenId)}
              onChangeDestination={setSelectedChainId}
              isRealRoute={isRealRoute?.(selectedTokenId) ?? false}
              conversion={conversionPlan}
              registerSend={registerSend}
              onRegisteringChange={setRegisteringAccount}
              onCheckingChange={setCheckingDestination}
              onContinue={(address, qty, memo, verified) => {
                setWithdrawAddress(address);
                setWithdrawQty(qty);
                setWithdrawMemo(memo);
                setDestinationVerified(verified);
                setStep(4);
              }}
              onBackToStart={() => setStep(1)}
            />
          )}
          {step === 4 && selectedTokenId && selectedChainId && conversionPlan && conversions && (
            <WithdrawConversionStep4
              tokenId={selectedTokenId}
              plan={conversionPlan}
              qty={withdrawQty}
              address={withdrawAddress}
              prices={prices}
              t={t}
              quoteConversion={conversions.quote}
              requoteTick={requoteTick}
              submitting={submitting}
              errorText={submitError}
              onConfirm={(quote) => handleConfirm(selectedTokenId, selectedChainId, undefined, quote)}
              onCancel={handleBack}
            />
          )}
          {step === 4 && selectedTokenId && selectedChainId && !conversionPlan && (
            <WithdrawStep4
              tokenId={selectedTokenId}
              chainId={selectedChainId}
              qty={withdrawQty}
              address={withdrawAddress}
              memo={withdrawMemo}
              prices={prices}
              t={t}
              liveFee={isRealRoute?.(selectedTokenId) ?? false}
              nativeBalanceRaw={nativeGasBalanceRaw(selectedChainId, generalBalance)}
              onQuoteGas={onQuoteGas}
              onBuyGas={onBuyGas}
              submitting={submitting}
              errorText={submitError}
              onConfirm={(hotFee, omniFee) =>
                handleConfirm(selectedTokenId, selectedChainId, hotFee, undefined, omniFee)
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** USDT(NEAR) → USDT; nBTC stays nBTC. The network is always named next to it. */
function tickerOf(tokenId: string): string {
  return (getTokenById(tokenId)?.symbol ?? tokenId).split("(")[0].trim();
}

function truncateAddress(addr: string): string {
  if (addr.length <= 20) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function getAddressPlaceholder(chainId: string): string {
  if (chainId.startsWith("eth:")) return "0x…";
  if (chainId === "near:mainnet") return "youraddress.near";
  if (chainId === "sol:mainnet") return "Solana address…";
  if (chainId === "tron:mainnet") return "T…";
  if (chainId === "btc:mainnet") return "bc1… / 1… / 3…";
  if (chainId === "ltc:mainnet") return "ltc1… / L… / M…";
  if (chainId === "doge:mainnet") return "D…";
  if (chainId === "zec:mainnet") return "t1… / t3…";
  return "";
}

/**
 * How long the confirm click may spend re-checking the fee before it gives up and submits.
 *
 * A withdrawal ends in a wallet prompt, and browsers only open one inside the user-activation
 * window that the click opened (~5s in Blink). A slow await here does not just feel slow —
 * it silently eats the popup, which is how a NEAR view call already broke the signing flow
 * once. The fee is a DISPLAY concern (the envelope signs the gross amount; the bridge
 * deducts on the far side), so when the bridge is slow the right trade is to show the fee we
 * have and keep the prompt.
 */
const FEE_RECHECK_BUDGET_MS = 1_200;

/**
 * `hot-omni` does NOT use the budget above, because it cannot fit in it. Block 4.3.6's wet
 * test measured the route's confirm-click re-check against mainnet: the gas price is fast
 * (177–390 ms) but the solver quote it must be chained to is not (1.9–2.9 s), for a total of
 * 2.1–3.3 s — over the budget in 5 runs out of 5, which left every non-native `hot-omni`
 * token permanently unconfirmable. Raising the budget instead is the wrong fix twice over: it
 * would put ~3 s of network inside the browser's 5 s user-activation window and eat the
 * wallet popup, which is a bug this repo has already shipped once.
 *
 * So the quote is kept young OUTSIDE that window — the same trade `needsDestinationPreflight`
 * makes — and the click only checks its age.
 */
const FEE_REFRESH_INTERVAL_MS = 15_000;

/**
 * A quote older than this is refused at click time rather than signed. One missed tick of
 * margin over the refresh interval, because a backgrounded tab throttles `setInterval` and a
 * tick genuinely can be skipped.
 *
 * Refusing matters more here than on any other route: `block_number` travels INSIDE the
 * signed intent, so a stale HOT quote is not a worse price, it is an envelope the bridge can
 * refuse after the funds have already left `intents.near`.
 */
const QUOTE_FRESH_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * How old a gas-purchase quote may be when the buy is clicked.
 *
 * Well inside 1Click's own 20-minute deadline, and short for a different reason: `amountIn` is
 * the price, and the price is what gets signed. Past this the click does NOT buy — it re-asks
 * and shows the new number, so the second click is against what is on screen. That ordering
 * also keeps the wallet prompt: the network call happens on a click that opens no popup, and
 * the popup opens on a click that makes no network call.
 */
const GAS_QUOTE_FRESH_MS = 5 * 60_000;

/**
 * How many times the gas's own market value this purchase may cost before the screen refuses
 * to offer it.
 *
 * Measured against the real 1Click API on 2026-08-10: 0.053907 USDT bought 0.04 GRAM, whose
 * market value at $1.34 was ~0.0536 — a spread under 1%. Three times that is generous enough
 * that a normal quote never trips it and tight enough that a quote off by an order of
 * magnitude never gets signed. It is a sanity bound, not a price negotiation.
 */
const GAS_PRICE_CEILING_MULTIPLIER = 3;

/** What the screen needs to state and then buy: the requirement, priced, with its age. */
type GasOffer = {
  nativeAssetId: string;
  /** Base units of gas needed — `HotGasRequirement.relayerFeeRaw`. */
  neededRaw: string;
  quote: GasPurchaseQuote;
  quotedAt: number;
};

/**
 * The most this purchase may cost, in base units of the token being sold.
 *
 * `null` when either side has no price, and that refusal is the point: a ceiling that cannot
 * be computed is not a ceiling, and the purchase it would have guarded moves money to a third
 * party. Failing closed here costs a blocked screen; failing open costs whatever the quote
 * asked for. (In practice both prices always exist — every HOT native carries a
 * `fallbackUsdPrice` in the registry — so this is a guard against a future gap, not a
 * routine branch.)
 */
function gasPriceCeilingRaw(p: {
  neededRaw: string;
  nativeAssetId: string;
  tokenDecimals: number;
  tokenUsdPrice: number;
  nativeUsdPrice: number;
  nativeDecimals: number;
}): string | null {
  if (!(p.tokenUsdPrice > 0) || !(p.nativeUsdPrice > 0)) return null;
  const gasUsd = (Number(p.neededRaw) / Math.pow(10, p.nativeDecimals)) * p.nativeUsdPrice;
  if (!Number.isFinite(gasUsd) || gasUsd <= 0) return null;
  const ceilingInToken = (gasUsd * GAS_PRICE_CEILING_MULTIPLIER) / p.tokenUsdPrice;
  const raw = Math.floor(ceilingInToken * Math.pow(10, p.tokenDecimals));
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return BigInt(raw).toString();
}

function WithdrawStep4({
  tokenId,
  chainId,
  qty,
  address,
  memo,
  prices,
  t,
  liveFee,
  nativeBalanceRaw,
  onQuoteGas,
  onBuyGas,
  submitting,
  errorText,
  onConfirm,
}: {
  tokenId: string;
  chainId: string;
  qty: number;
  address: string;
  memo: string;
  prices: TokenPriceMap;
  t: (typeof bridgeTranslations)["en"];
  /** Ask the bridge for the current fee instead of trusting the registry's snapshot. */
  liveFee: boolean;
  /** `hot-omni` gas the signer already holds, in base units — see `nativeGasBalanceRaw`. */
  nativeBalanceRaw?: string;
  /** Both or neither — see `onQuoteGas` on the modal's own props. */
  onQuoteGas?: GasQuoteSeam;
  onBuyGas?: BuyGasSeam;
  submitting: boolean;
  errorText: string | null;
  onConfirm: (hotFee?: HotFeeDetail, omniFee?: OmniFeeDetail) => void;
}) {
  const token = getTokenById(tokenId);
  const entry = getWithdrawalEntry(tokenId, chainId);
  const isHotOmni = entry?.bridgeRoute === "hot-omni";
  // D-580: the other route whose fee is SIGNED (the Zcash gas ceiling rides in the intent's
  // `msg`). It shares every rule `hot-omni` has for that — no registry fallback, a quote kept
  // young off the click, an age check on it — and none of HOT's gas purchase.
  const isOmni = entry?.bridgeRoute === "omni";
  const signsFee = isHotOmni || isOmni;
  // The token's own chain, and whether this withdrawal leaves for NEAR instead (D-384).
  const ownChainId = withdrawalDestinations(tokenId)[0] ?? chainId;
  const arrivesAsNearToken = chainId === NEAR_DESTINATION_CHAIN_ID && ownChainId !== chainId;
  const chainMeta = getChainMeta(chainId);
  const symbol = token?.symbol ?? tokenId;
  // Base ticker (USDT) without the network qualifier (USDT(ETH)) — the network is
  // already named explicitly in the chip / details, so the suffix would be redundant.
  const ticker = symbol.split("(")[0].trim();
  const decimals = token?.decimals ?? 6;
  const price = prices[tokenId]?.usdPrice ?? token?.fallbackUsdPrice ?? 0;
  const color = colorForSymbol(ticker);

  // The registry snapshot is the starting point and, ON EVERY ROUTE BUT `hot-omni`, the
  // permanent fallback: there a fee lookup that fails or times out must never block a
  // withdrawal, so there is always a number. `hot-omni` inverts it (hot-fee.ts's header) —
  // the fee is signed, so a stale snapshot is not a worse number, it is an invalid envelope.
  // `quote` still holds the snapshot there, which is why every read of it below is gated on
  // `hotFeeBlocked`: block 4.3.6's wet test caught the screen stating a registry fee for a
  // quote nobody had made.
  const [quote, setQuote] = useState<WithdrawalFeeQuote | null>(() =>
    staticWithdrawalFee(tokenId, chainId)
  );
  const wantsLive = liveFee && supportsLiveWithdrawalFee(tokenId, chainId);
  const [loadingFee, setLoadingFee] = useState(wantsLive);
  // P2, decided by the operator: a fee that went UP between the quote and the click blocks
  // the withdrawal and asks again against the new number, rather than quietly delivering
  // less than the screen promised. Holds the higher quote until the user acknowledges it.
  const [feeIncreased, setFeeIncreased] = useState(false);
  // Set for the duration of the confirm click's fee re-check. Without it the button spends up
  // to FEE_RECHECK_BUDGET_MS looking untouched, which is an invitation to click again — and a
  // second click is a second envelope, a second nonce and a second wallet prompt.
  const [rechecking, setRechecking] = useState(false);
  // `hot-omni` only (4.3.5): a failed live quote has no registry number to fall back to
  // (hot-fee.ts's header) — `omft` keeps showing the registry's snapshot through `quote`
  // itself, so it never needs this.
  // Also `omni`'s "no live quote" (D-580): the same block, for the same reason.
  const [hotFeeBlocked, setHotFeeBlocked] = useState(false);
  // `omni` only: the bridge answered and cannot pay this amount out (`insufficient_utxo`).
  // Blocks like `hotFeeBlocked`, with its own sentence — waiting a moment is not the fix.
  const [omniNoPayout, setOmniNoPayout] = useState(false);
  // The gross the `omni` quote is asked for: the fee ceiling grows with the amount
  // (omni-bridge.ts). Undefined on every other route, so it never re-runs their fee effect.
  // Guarded because `toBaseUnits` throws on a non-finite or negative qty, and this runs in render.
  const omniAmountRaw =
    isOmni && Number.isFinite(qty) && qty > 0 ? toBaseUnits(qty, decimals) : undefined;
  const confirmRef = useRef<HTMLButtonElement>(null);
  // D-309: the attempt disabled the confirm button, which had the focus. Nothing was sent, so
  // the focus goes back to it for the retry.
  useEffect(() => {
    if (!submitting && errorText) confirmRef.current?.focus();
  }, [submitting, errorText]);
  // When `quote` was obtained. Only the signed-fee routes (`hot-omni`, `omni`) read it — see
  // QUOTE_FRESH_MS.
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  // D-251. One state and not three booleans: "we are pricing it", "there is no price" and
  // "here is the price" are mutually exclusive, and a screen that can render two of them at
  // once is a screen that will.
  const [gasState, setGasState] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "unavailable" } | { kind: "ready"; offer: GasOffer }
  >({ kind: "idle" });
  const [buyingGas, setBuyingGas] = useState(false);
  const [gasError, setGasError] = useState<string | null>(null);
  /**
   * 🔴 A purchase was signed and may have moved money, so this quote is SPENT — no button, at
   * any price, until a fresh one replaces it.
   *
   * Without it the 120-second arrival budget in the shell was a double-purchase generator: the
   * budget expiring throws, `finally` clears `buyingGas`, and the button comes back holding
   * the SAME quote with the SAME `quotedAt` — young enough to skip the staleness re-quote —
   * directly under a message saying the token was already paid for. The obvious next click
   * signs a second transfer to the same deposit address, with a fresh random nonce, and the
   * relay has no reason to refuse it.
   *
   * Only an outcome that certainly moved nothing clears it: a wallet the user dismissed, or a
   * guard that fired before signing. Everything else keeps the offer spent — the balance is
   * what says whether more gas is needed, and the fee effect is already watching it.
   */
  const [gasSpent, setGasSpent] = useState(false);
  // The quote aged out on the click, so it was re-asked instead of signed (GAS_QUOTE_FRESH_MS).
  const [gasPriceMoved, setGasPriceMoved] = useState(false);

  // Held in a ref, and deliberately NOT in the effect's dependencies: a parent that rebuilds
  // these callbacks on every render would otherwise re-price the purchase on every render —
  // a 1Click request per keystroke elsewhere on the screen. `canBuyGas` is the only thing
  // about them that can actually change what this component does.
  const gasSeams = useRef<{ onQuoteGas?: GasQuoteSeam; onBuyGas?: BuyGasSeam }>({});
  /**
   * The gas requirement the fee effect resolved this cycle, and the destination it belongs to
   * (D-274). A ref and NOT state, for the reason `gasSeams` is one: as a dependency of
   * `loadGasOffer` it would change that callback's identity on every fee tick, re-run the gas
   * effect and price a fresh 1Click quote every 15 seconds (FEE_REFRESH_INTERVAL_MS) for a
   * purchase nobody asked for again.
   */
  const hotRequirementRef = useRef<{
    tokenId: string;
    address: string;
    requirement: HotGasRequirement | null;
  } | null>(null);
  /** Which gas-offer request is the current one — see `loadGasOffer`. */
  const gasLoadSeq = useRef(0);
  useEffect(() => {
    gasSeams.current = { onQuoteGas, onBuyGas };
  });
  const canBuyGas = Boolean(onQuoteGas && onBuyGas);

  useEffect(() => {
    if (!wantsLive) {
      setQuote(staticWithdrawalFee(tokenId, chainId));
      setLoadingFee(false);
      setHotFeeBlocked(false);
      setOmniNoPayout(false);
      setQuotedAt(null);
      return;
    }
    const controller = new AbortController();
    setLoadingFee(true);
    setHotFeeBlocked(false);
    setOmniNoPayout(false);

    const ask = (isFirst: boolean) =>
      fetchWithdrawalFee({
        tokenId,
        chainId,
        destinationAddress: address,
        nativeBalanceRaw,
        amountRaw: omniAmountRaw,
        signal: controller.signal,
      })
        .then(({ quote: fresh, hotRequirement, omniInsufficientUtxo }) => {
          if (controller.signal.aborted) return;
          // 🔴 D-274. The gas requirement this cycle computed, stamped with the destination it
          // was computed FOR. `loadGasOffer` reads it instead of asking again, so the purchase
          // is sized against the very figure the sufficiency check above used. On Stellar the
          // two used to be independent Horizon lookups that could disagree by 11x.
          //
          // Written BEFORE `finally` lowers `loadingFee`, which is what lets the gas effect
          // run — so by the time anything can read this, it is this cycle's answer and not the
          // previous one. The key is carried rather than assumed: a requirement resolved for
          // another destination must never size a purchase.
          hotRequirementRef.current = { tokenId, address, requirement: hotRequirement ?? null };
          if (fresh) {
            setQuote(fresh);
            setQuotedAt(Date.now());
            setHotFeeBlocked(false);
            setOmniNoPayout(false);
          } else if (omniInsufficientUtxo) {
            // A definite "no" from the bridge, on any tick: the quote in hand must not be
            // signed, since this amount can no longer be paid out.
            setOmniNoPayout(true);
            setHotFeeBlocked(true);
          } else if (isFirst && signsFee) {
            // Only the FIRST failure means there is nothing to show. A refresh that fails
            // leaves the quote in hand to age out on its own, and the click refuses it then —
            // blocking on a single flaky tick would be noise, not safety.
            setHotFeeBlocked(true);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted && isFirst) setLoadingFee(false);
        });

    ask(true);
    if (!signsFee) return () => controller.abort();

    // `hot-omni` and `omni`: keep the quote young here, outside the user-activation window, so the
    // confirm click never has to go to the network. See FEE_REFRESH_INTERVAL_MS.
    const timer = setInterval(() => void ask(false), FEE_REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
    // `nativeBalanceRaw` belongs here and is not noise: it is what re-asks the fee once gas
    // arrives in the balance. That makes the balance itself the completion signal for a gas
    // purchase — no polling loop, no status endpoint, no second source of truth about whether
    // the swap landed. The quote flips to `native-balance` and the button unblocks by itself.
  }, [wantsLive, tokenId, chainId, address, isHotOmni, signsFee, nativeBalanceRaw, omniAmountRaw]);

  /**
   * Prices the way out of a blocked screen: what it costs to buy the gas the relayer needs,
   * with the token being withdrawn.
   *
   * 🔴 IT DOES NOT ASK HOW MUCH GAS IS NEEDED — it reads what the fee effect already resolved
   * (D-274). `fetchWithdrawalFee` returned `quote: null` by the time this runs, and that null
   * used to take the figure with it, so this re-fetched it: a SECOND, INDEPENDENT resolution
   * of the same question. On Stellar that question is answered by Horizon per destination
   * account, and an unstable Horizon made the two answers differ by 11x — the purchase sized
   * against "account exists" (0.1 XLM) while sufficiency was judged against "account does not"
   * (1.1 XLM), leaving the screen blocked over gas it had just bought and offering to buy
   * again. One resolution, read twice, cannot disagree with itself.
   *
   * A requirement of `null` means the cost itself is unknown (the chain is unreachable), which
   * is not a state a purchase can fix — so nothing is offered.
   */
  const loadGasOffer = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const seams = gasSeams.current;
      if (!seams.onQuoteGas || !seams.onBuyGas) return;
      // Only the NEWEST request may write. The staleness path re-quotes without a signal (it
      // runs from a click, not an effect), so two loads can be in flight and the slower one
      // would otherwise land last and stamp an old price with a fresh `quotedAt` — a stale
      // quote wearing a young one's timestamp, on the object that gets signed.
      const seq = (gasLoadSeq.current += 1);
      const superseded = () => gasLoadSeq.current !== seq || signal?.aborted === true;
      setGasState({ kind: "loading" });

      // The key check is a guard on an unreachable state, kept because of what it guards: the
      // gas effect only runs after the fee effect settled for THIS token and address, so a
      // mismatch cannot happen today. If it ever does, sizing a purchase against a requirement
      // resolved for a different destination is the one outcome worth failing closed over.
      const held = hotRequirementRef.current;
      const need =
        held && held.tokenId === tokenId && held.address === address ? held.requirement : null;
      if (superseded()) return;
      if (!need) {
        setGasState({ kind: "unavailable" });
        return;
      }

      // A native this app does not carry in its token registry cannot be stated: no decimals
      // means the amount renders as raw base units, and no symbol means the button names an
      // asset id. Optimism is in exactly that state today — `HOT_NATIVE_ASSET_ID` lists it and
      // the registry does not — and two withdrawable tokens route through it. The purchase
      // already fails closed there (no price, so no ceiling, so no button), but it failed
      // closed while SAYING the price was too high. This says the true thing instead.
      if (!getTokenById(need.nativeAssetId)) {
        setGasState({ kind: "unavailable" });
        return;
      }

      // How much to buy is a per-chain question — see `gasPurchaseTargetRaw`. On a chain whose
      // fee drifts, buying it exactly is what makes the screen offer a second purchase minutes
      // later; on a chain whose fee is a constant, a margin buys nothing and is charged anyway.
      //
      // The chain is derived from `tokenId` and NOT taken from the `chainId` prop, so it comes
      // from the same place `fetchHotGasRequirement` got the requirement it is scaling. Two
      // derivations of "which chain" agree today only because the pickers set the token and the
      // chain in one batched update; one derivation cannot disagree with itself.
      const marginChainId = entry?.chainId;
      if (!marginChainId) {
        setGasState({ kind: "unavailable" });
        return;
      }
      const target = gasPurchaseTargetRaw(need.relayerFeeRaw, marginChainId);
      if (!target) {
        setGasState({ kind: "unavailable" });
        return;
      }

      const priced = await seams.onQuoteGas({
        tokenId,
        nativeAssetId: need.nativeAssetId,
        feeRaw: target,
        signal,
      });
      if (superseded()) return;
      if (!priced) {
        setGasState({ kind: "unavailable" });
        return;
      }

      // A genuinely new quote, so the spent flag lifts with it. Reachable only from the effect
      // (token or destination changed) and from the staleness re-quote, which signs nothing —
      // never from underneath a purchase in flight.
      setGasSpent(false);
      setGasState({
        kind: "ready",
        offer: {
          nativeAssetId: need.nativeAssetId,
          // What is BOUGHT, not what is owed: it is the number on the button and the number
          // the ceiling is computed against, and those have to be the same trade.
          neededRaw: target,
          quote: priced,
          quotedAt: Date.now(),
        },
      });
    },
    // `entry` is derived from `tokenId` and carries the chain the margin is keyed on
    // (`gasPurchaseTargetRaw`), so it moves with `tokenId` and needs no dependency of its own.
    [tokenId, address, entry]
  );

  useEffect(() => {
    // Only a BLOCKED `hot-omni` screen asks. An unblocked one either pays in kind, pays from
    // a balance the signer already has, or has a solver quote — in all three there is nothing
    // to buy, and asking anyway would price a purchase nobody needs.
    if (!isHotOmni || !hotFeeBlocked || loadingFee || !canBuyGas) {
      setGasState({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    void loadGasOffer(controller.signal);
    return () => controller.abort();
    // No polling and no interval: when the gas lands, `nativeBalanceRaw` changes, the fee
    // effect above re-quotes, `hotFeeBlocked` clears and this tears itself down. The balance
    // is the completion signal (gas-purchase.ts) — there is no second source of truth here.
  }, [isHotOmni, hotFeeBlocked, loadingFee, canBuyGas, loadGasOffer]);

  const feeRaw = quote?.feeRaw ?? "0";
  const feeInToken = Number(feeRaw) / Math.pow(10, decimals);
  const feeInUsd = feeInToken * price;
  const qtyUsd = qty * price;
  const netQty = Math.max(0, qty - feeInToken);
  const netUsd = netQty * price;

  // D-251: the fee is paid in the destination chain's gas token, out of a balance the signer
  // already holds. `feeRaw` is legitimately "0" there — nothing comes out of the withdrawn
  // token — so the plain `feeInToken === 0` test would render this as FREE. It is not free:
  // it costs `relayerFeeRaw` of another token, and saying "Free" would be the one wrong
  // statement this screen must never make about money.
  const gasFee =
    quote?.hot?.payment === "native-balance"
      ? (() => {
          const nativeId = quote.hot!.nativeAssetId;
          const nativeToken = getTokenById(nativeId);
          const nativeDecimals = nativeToken?.decimals ?? 0;
          const amount = Number(quote.hot!.relayerFeeRaw) / Math.pow(10, nativeDecimals);
          return {
            amount,
            ticker: (nativeToken?.symbol ?? nativeId).split("(")[0].trim(),
            usd: amount * (prices[nativeId]?.usdPrice ?? nativeToken?.fallbackUsdPrice ?? 0),
          };
        })()
      : null;
  /**
   * 🔴 D-263: whether this screen HAS a fee, as opposed to lacking one. `feeRaw` above is
   * `quote?.feeRaw ?? "0"`, and four of the six `hot-omni` chains carry a registry snapshot
   * that is literally `"0"` (Avalanche, Optimism, TON, Stellar) — so "nobody quoted this" and
   * "it costs nothing" arrive at the render as the same zero. `Free` is not a hedge, it is a
   * claim that nothing is charged, made on the surface where the user decides to sign.
   *
   * The trigger measured in session 121 is the most ordinary interaction there is. `liveFee`
   * is `isRealWithdrawalRoute(...)`, which answers false the moment the signer goes away, and
   * dismissing a wallet prompt is enough to do it. The fee effect's `!wantsLive` branch then
   * swaps the live quote for the registry snapshot AND clears `hotFeeBlocked`, so a correct
   * "—" with a dead button becomes "Free · You'll receive 5.00" with a live one.
   *
   * `hotFeeBlocked` cannot express this and widening it would be wrong: it is set when a
   * live quote was pursued and could not be used, and this is the state where none is being
   * pursued at all. On `omft` and `near-native` there is nothing to express — the registry
   * snapshot is the documented permanent fallback there (withdrawal-fee.ts), so `feeUnknown`
   * stays false and their screens are untouched.
   *
   * ⚠️ ONE DISAGREEMENT WITH THE CLICK SURVIVES THIS, deliberately. `handleConfirmClick`
   * also refuses a quote that has aged past `QUOTE_FRESH_MS`, and age is NOT read here: a
   * figure that merely got old is still a figure we have, and expressing it would need the
   * screen to re-render on the passage of time, which nothing makes it do today. So a quote
   * can sit on screen, look confirmable, and be refused on click. Pre-existing, no money
   * moves, and tracked rather than fixed inside this block — see D-267.
   */
  const hotFeeUnquoted =
    (isHotOmni && (quote?.source !== "live" || !quote.hot)) ||
    (isOmni && (quote?.source !== "live" || !quote.omni));
  const feeUnknown = hotFeeBlocked || hotFeeUnquoted;
  // Known AND zero. `Free` is reserved for a fee we actually have and that is nothing.
  const isFree = !feeUnknown && feeInToken === 0 && gasFee === null;

  // The fee is deducted on the far side, so an amount that does not clear it settles perfectly
  // and delivers NOTHING. `buildWithdrawSignRequest` refuses it, but reaching a wallet prompt
  // to be told is the wrong place to find out — and until 5.4 the screen said "you will
  // receive 0" with the button still live. Mirrors the envelope's floor against the quote
  // actually on screen, which for `omft` is the live one.
  // `omni` also has the bridge's own live floor on the GROSS (`min_amount`), which the envelope
  // enforces; the screen takes whichever is higher so it refuses what the envelope would.
  const feeFloorRaw = minimumWithdrawalRaw(tokenId, quote?.feeRaw, chainId);
  const omniFloorRaw = quote?.omni?.minAmountRaw;
  const minRaw =
    feeFloorRaw && omniFloorRaw && BigInt(omniFloorRaw) > BigInt(feeFloorRaw) ? omniFloorRaw : feeFloorRaw;
  const minQty = minRaw ? Number(minRaw) / Math.pow(10, decimals) : 0;
  const belowFloor = !loadingFee && minQty > 0 && qty < minQty;

  const gasOffer = gasState.kind === "ready" ? gasState.offer : null;
  const gasNativeToken = gasOffer ? getTokenById(gasOffer.nativeAssetId) : null;
  const gasTicker = gasOffer
    ? (gasNativeToken?.symbol ?? gasOffer.nativeAssetId).split("(")[0].trim()
    : "";
  const gasNeeded = gasOffer
    ? Number(gasOffer.neededRaw) / Math.pow(10, gasNativeToken?.decimals ?? 0)
    : 0;
  const gasCost = gasOffer
    ? Number(gasOffer.quote.amountInRaw) / Math.pow(10, decimals)
    : 0;
  // `buildGasPurchaseSignRequest` throws on exactly this, and being told at the wallet prompt
  // is the wrong place to find out. Same floor-downwards float handling as
  // `nativeGasBalanceRaw`, and for the same reason: err towards refusing, never towards
  // offering a purchase that would eat the withdrawal.
  const gasTooLarge = gasOffer
    ? BigInt(gasOffer.quote.amountInRaw) >= BigInt(Math.floor(qty * Math.pow(10, decimals)))
    : false;
  // The ceiling is computed here, where the USD rates already are, and then travels with the
  // quote so the purchase path can enforce the same number rather than a second opinion.
  const gasCeilingRaw = gasOffer
    ? gasPriceCeilingRaw({
        neededRaw: gasOffer.neededRaw,
        nativeAssetId: gasOffer.nativeAssetId,
        tokenDecimals: decimals,
        tokenUsdPrice: price,
        nativeUsdPrice:
          prices[gasOffer.nativeAssetId]?.usdPrice ?? gasNativeToken?.fallbackUsdPrice ?? 0,
        nativeDecimals: gasNativeToken?.decimals ?? 0,
      })
    : null;
  // No computable ceiling, or a quote above it: refused on screen, before the click. The
  // purchase path refuses it again — this one exists so the user is told which of the two
  // problems they have, and what to do about it.
  const gasTooExpensive = Boolean(
    gasOffer && (gasCeilingRaw === null || BigInt(gasOffer.quote.amountInRaw) > BigInt(gasCeilingRaw))
  );

  async function handleBuyGasClick() {
    if (buyingGas || gasSpent || !gasOffer || gasTooLarge || gasTooExpensive) return;
    if (gasCeilingRaw === null) return;
    const buy = gasSeams.current.onBuyGas;
    if (!buy) return;
    // Aged out: re-price and show it. This click signs nothing, so it opens no wallet prompt
    // and loses nothing to the activation window — see GAS_QUOTE_FRESH_MS.
    if (Date.now() - gasOffer.quotedAt > GAS_QUOTE_FRESH_MS) {
      setGasPriceMoved(true);
      void loadGasOffer();
      return;
    }
    setGasPriceMoved(false);
    setGasError(null);
    setBuyingGas(true);
    // Set BEFORE the await, not after: between them sits a wallet prompt and up to two minutes
    // of network, and the whole point is that no path through those re-offers this quote.
    setGasSpent(true);
    try {
      // The quote the screen displayed, not a fresher one: `amountIn` is the price the user
      // just agreed to, and `depositAddress` is where it goes.
      await buy({
        quote: gasOffer.quote,
        maxAmountInRaw: gasCeilingRaw,
        withdrawalAmountRaw: BigInt(Math.floor(qty * Math.pow(10, decimals))).toString(),
      });
    } catch (e) {
      setGasError(e instanceof Error ? e.message : String(e));
      // The only outcomes that give the offer back. `WithdrawError.fundsState` is the field
      // block 5.2 fixed for exactly this question and it is CONSUMED here, never re-derived
      // from the message: `untouched` is the relay or a guard saying the intent never
      // executed. An error with no `fundsState` at all never reached the published path —
      // `runGasPurchase` re-throws wallet errors untouched — so a dismissed prompt is a retry.
      const movedNothing = e instanceof WithdrawError ? e.fundsState === "untouched" : true;
      if (movedNothing) setGasSpent(false);
    } finally {
      setBuyingGas(false);
    }
  }

  async function handleConfirmClick() {
    // `feeUnknown` and not `hotFeeBlocked` (D-263): the button is already disabled on it, and
    // a handler that disagreed with its own button would be the next version of this bug.
    if (submitting || rechecking || belowFloor || feeUnknown) return;
    // Second click on the same, now-visible higher fee: this IS the re-confirmation.
    if (feeIncreased) {
      setFeeIncreased(false);
      onConfirm(quote?.hot, quote?.omni);
      return;
    }
    if (signsFee) {
      // No network call inside the click. The refresh timer owns freshness; all this does is
      // refuse to sign something the timer has not managed to keep current.
      //
      // This REPLACES P2 on this route rather than dropping it. P2 exists so a fee cannot rise
      // between what the screen promised and what gets signed; here the very object rendered
      // is the object signed (`quote`, not a re-fetch), which closes that gap outright instead
      // of catching it after the fact. `omft` keeps P2 as built and wet-tested in phase 5.
      const age = quotedAt === null ? Number.POSITIVE_INFINITY : Date.now() - quotedAt;
      const signed = isOmni ? quote?.omni : quote?.hot;
      if (quote?.source !== "live" || !signed || age > QUOTE_FRESH_MS) {
        setHotFeeBlocked(true);
        return;
      }
      onConfirm(quote.hot, quote.omni);
      return;
    }
    if (wantsLive) {
      setRechecking(true);
      // `omft` only — `hot-omni` and `omni` returned above — so there is no `hotRequirement` to keep here:
      // this route has no gas purchase and nothing that would read one. `withTimeout` resolves
      // `null` when the budget runs out, which is why the unwrap is optional.
      const rechecked = await withTimeout(
        fetchWithdrawalFee({ tokenId, chainId, destinationAddress: address }),
        FEE_RECHECK_BUDGET_MS
      );
      const fresh = rechecked?.quote ?? null;
      setRechecking(false);
      // Only an INCREASE blocks. A fee that dropped means the user receives more than the
      // screen promised, which needs no permission — the new number is simply shown.
      if (fresh && fresh.source === "live" && BigInt(fresh.feeRaw) > BigInt(feeRaw)) {
        setQuote(fresh);
        setFeeIncreased(true);
        return;
      }
      if (fresh && fresh.source === "live") {
        setQuote(fresh);
        onConfirm(fresh.hot, fresh.omni);
        return;
      }
    }
    onConfirm(quote?.hot, quote?.omni);
  }

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      {/* Context chip: token → chain */}
      <div className="flex items-center gap-2 rounded-xl bg-card px-3 py-2">
        <TokenAvatar
          symbol={ticker}
          size={28}
          className="rounded-full"
          style={{ backgroundColor: `${color.hex}22` }}
          fallbackClassName="text-xs font-bold text-slate-950"
        />
        <p className="text-sm text-slate-300">
          {t.withdrawToChain
            .replace("{ticker}", ticker)
            .replace("{chain}", chainMeta?.displayName ?? chainId)}
        </p>
      </div>

      {/* Withdrawal details */}
      <section aria-labelledby="step4-details-heading">
        <p id="step4-details-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {t.withdrawalDetailsSection}
        </p>
        <dl className="flex flex-col gap-2 rounded-xl bg-card px-4 py-3">
          <DetailRow label={ticker} value={`${formatCrypto(qty)} ${ticker}`} sub={formatUsd(qtyUsd)} />
          <DetailRow label={t.withdrawNetworkLabel} value={chainMeta?.displayName ?? chainId} />
          <DetailRow label={t.addressLabel} value={truncateAddress(address)} mono />
          {memo && <DetailRow label={t.memoLabel} value={memo} />}
        </dl>
        {/* D-384: the last screen before the signature says it too — what lands is the NEAR token. */}
        {arrivesAsNearToken && entry && (
          <p className="mt-1.5 text-[11px] text-slate-400">
            {t.withdrawArrivesAsNearToken
              .replace("{contract}", entry.nearTokenId)
              .replaceAll("{ticker}", ticker)
              .replace("{chain}", getChainMeta(ownChainId)?.displayName ?? ownChainId)}
          </p>
        )}
      </section>

      {/* Costs */}
      <section aria-labelledby="step4-costs-heading">
        <p id="step4-costs-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {t.costsSection}
        </p>
        <dl className="flex flex-col gap-2 rounded-xl bg-card px-4 py-3">
          {/* An em dash, not a number: with no live quote there is no fee to state and no
              net to derive from it. The `feeUnavailable` alert below says why. */}
          <DetailRow
            label={t.networkFeeLabel}
            value={
              loadingFee
                ? t.feeLoading
                : feeUnknown
                ? "—"
                : gasFee
                ? // Stated in ITS OWN token, because that is the token that gets debited. The
                  // withdrawn amount below is deliberately NOT reduced by it.
                  `${formatCrypto(gasFee.amount)} ${gasFee.ticker}`
                : isFree
                ? t.freeLabel
                : isOmni
                ? // A ceiling, not a price: the real Zcash fee is chosen after signing (D-580).
                  t.feeUpTo.replace("{amount}", `${formatCrypto(feeInToken)} ${ticker}`)
                : `${formatCrypto(feeInToken)} ${ticker}`
            }
            sub={
              loadingFee || feeUnknown
                ? undefined
                : gasFee
                ? formatUsd(gasFee.usd)
                : isFree
                ? undefined
                : formatUsd(feeInUsd)
            }
            dimValue={isFree || loadingFee || feeUnknown}
          />
          {/* Without this the row above reads as a second deduction from the withdrawal. It
              is not: it leaves a different balance, and "you will receive" stays whole. */}
          {gasFee && !loadingFee && !feeUnknown && (
            <p className="text-[11px] text-slate-400">
              {t.feeFromGasBalance.replace("{symbol}", gasFee.ticker)}
            </p>
          )}
          <div className="border-t border-slate-700" role="separator" />
          <DetailRow
            label={isOmni ? t.youWillReceiveAtLeastLabel : t.youWillReceiveLabel}
            value={feeUnknown ? "—" : `${formatCrypto(netQty)} ${ticker}`}
            sub={feeUnknown ? undefined : formatUsd(netUsd)}
            highlight
          />
        </dl>
        {/* Says the number is an estimate only when it actually is one — a registry
            snapshot presented as "estimated" would be the opposite of informative, and on a
            blocked `hot-omni` quote there is no number on screen to qualify at all. */}
        {!loadingFee && !isFree && !feeUnknown && quote?.source === "registry" && (
          <p className="mt-1.5 text-[11px] text-slate-400">{t.feeEstimated}</p>
        )}
      </section>

      {/* P2: fee went up between the quote and the click. Blocks, explains, asks again. */}
      {feeIncreased && (
        <p role="alert" className="rounded-xl bg-amber-900/25 px-3 py-2.5 text-xs text-amber-300">
          {t.feeIncreasedNotice}
        </p>
      )}

      {/* The fee would swallow the whole withdrawal: nothing would arrive. */}
      {belowFloor && (
        <p role="alert" className="rounded-xl bg-red-950/40 px-3 py-2.5 text-xs text-red-300">
          {t.amountBelowFee
            .replace("{min}", minQty.toFixed(Math.min(decimals, 8)))
            .replace("{symbol}", ticker)}
        </p>
      )}

      {/* HOT has no registry fee to fall back to (hot-fee.ts): a failed live quote blocks
          rather than showing a stale number the contract would refuse to sign.

          `feeUnavailable` says "try again in a moment", which is TRUE of a flaky quote and
          false of D-251 — there the market does not exist and no amount of waiting fixes it.
          So when the purchase path can name the real obstacle, it says that instead. */}
      {hotFeeBlocked && !loadingFee && gasState.kind !== "ready" && (
        <p role="alert" className="rounded-xl bg-red-950/40 px-3 py-2.5 text-xs text-red-300">
          {omniNoPayout
            ? t.feeNoPayout.replace("{chain}", chainMeta?.displayName ?? chainId)
            : gasState.kind === "loading"
            ? t.feeLoading
            : t.feeUnavailable}
        </p>
      )}

      {/* D-263: the fee is missing because nothing is quoting it — the route is not live —
          rather than because a quote failed. Different sentence, because "try again in a
          moment" is false here, and without one the em dash and the dead button have no
          explanation at all. Mutually exclusive with the alert above by construction. */}
      {hotFeeUnquoted && !hotFeeBlocked && !loadingFee && (
        <p role="alert" className="rounded-xl bg-red-950/40 px-3 py-2.5 text-xs text-red-300">
          {t.feeUnquoted}
        </p>
      )}

      {/* D-251: the withdrawal is blocked for a reason the user can act on. States what the
          network wants, what buying it costs, and asks — nothing is signed until the click. */}
      {hotFeeBlocked && !loadingFee && gasOffer && (
        <section
          aria-labelledby="gas-purchase-heading"
          className="flex flex-col gap-2.5 rounded-xl bg-card px-4 py-3"
        >
          <p id="gas-purchase-heading" className="text-xs text-slate-300">
            {t.gasPurchaseNeeded.replace("{symbol}", gasTicker)}
          </p>
          <dl className="flex flex-col gap-2">
            {/* The cost carries its USD figure like every other money row on this screen.
                Without it the only absolute number in view was denominated in the token being
                sold, which is the one unit that says nothing about whether five cents or five
                dollars is about to leave. */}
            <DetailRow
              label={t.networkFeeLabel}
              value={`${formatCrypto(gasNeeded)} ${gasTicker}`}
              sub={`${formatCrypto(gasCost)} ${ticker} · ${formatUsd(gasCost * price)}`}
            />
          </dl>
          {gasPriceMoved && (
            <p role="status" className="text-[11px] text-amber-300">
              {t.gasPurchaseStale}
            </p>
          )}
          {gasTooLarge || gasTooExpensive ? (
            <p role="alert" className="text-[11px] text-red-300">
              {gasTooLarge ? t.gasPurchaseTooLarge : t.gasPurchaseTooExpensive}
            </p>
          ) : gasSpent && !buyingGas ? null : ( // signed already — the error below says where it stands
            <button
              type="button"
              onClick={handleBuyGasClick}
              disabled={buyingGas || submitting}
              aria-busy={buyingGas}
              className="w-full rounded-xl border border-accent/40 px-4 py-2.5 text-sm font-semibold text-accent transition hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {buyingGas
                ? t.gasPurchaseBuying.replace("{symbol}", gasTicker)
                : t.gasPurchaseOffer
                    .replace("{amount}", formatCrypto(gasNeeded))
                    .replace("{symbol}", gasTicker)}
            </button>
          )}
          {/* The error's OWN words, with no headline of ours above them. A purchase can fail
              before anything moves, after the transfer settled, or with the token still on
              its way — and only the layer that threw knows which. "We couldn't buy it" would
              be a claim this component is not in a position to make. Same rule
              `run-real-withdraw.ts` follows when it reuses 5.2's messages verbatim. */}
          {gasError && (
            <p role="alert" className="break-words text-[11px] text-red-300">
              {gasError}
            </p>
          )}
        </section>
      )}

      {/* Irreversibility banner */}
      <div className="flex items-start gap-2.5 rounded-xl bg-amber-900/25 px-3 py-2.5" role="note">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mt-0.5 shrink-0 text-amber-400"
          aria-hidden="true"
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <p className="text-xs text-amber-300">{t.irreversibleBanner}</p>
      </div>

      {/* Only reachable when the balance is intact — see `handleConfirm` in the modal. The
          reassurance comes first; the raw reason follows for whoever needs it. */}
      {errorText && (
        <div role="alert" className="rounded-xl bg-red-950/40 px-3 py-2.5">
          <p className="text-xs font-medium text-red-300">{t.withdrawNotSent}</p>
          <p className="mt-1 break-words text-[11px] text-red-300/80">{errorText}</p>
        </div>
      )}

      {/* Confirm button */}
      <button
        ref={confirmRef}
        type="button"
        onClick={handleConfirmClick}
        disabled={submitting || rechecking || belowFloor || feeUnknown}
        aria-busy={submitting || rechecking}
        className="w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        {submitting
          ? t.withdrawSigningButton
          : rechecking
          ? t.feeLoading
          : feeIncreased
          ? t.confirmWithdrawalAgainButton
          : t.confirmWithdrawalButton}
      </button>
    </div>
  );
}

/**
 * How often step 4 re-prices a conversion while the user reads it (plan 020 §5.3). The quote's
 * own deadline is 10 minutes and the click refuses one with under 2 left (C2), so this keeps
 * what is on screen young without a network call inside the click.
 */
const CONVERSION_REFRESH_MS = 30_000;

/** How long Accept ignores clicks after a worse quote swaps it in (cross-review 020-4). */
const ACCEPT_ARM_MS = 500;

/** Base units for display: exact up to 8 decimals, floored past them (ETH's last 10 digits). */
function formatRaw(raw: string, decimals: number): string {
  const exact = formatBaseUnits(BigInt(raw), decimals);
  const [whole, frac] = exact.split(".");
  if (!frac || frac.length <= 8) return exact;
  const cut = frac.slice(0, 8).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole;
}

function formatDuration(secs: number): string {
  return secs < 90 ? `~${Math.max(1, Math.round(secs))} s` : `~${Math.round(secs / 60)} min`;
}

/** "~0.02%"; under a hundredth of a percent the figure is noise, and saying 0 would be a claim. */
function formatCostBps(bps: number): string {
  if (!Number.isFinite(bps)) return "—";
  const pct = bps / 100;
  return pct < 0.01 ? "< 0.01%" : `~${pct.toFixed(2)}%`;
}

/** Whether `next` gives the user less than `than` on what arrives or on what is guaranteed. */
function givesLess(next: ConversionQuote, than: ConversionQuote): boolean {
  return (
    BigInt(next.amountOutRaw) < BigInt(than.amountOutRaw) ||
    BigInt(next.minAmountOutRaw) < BigInt(than.minAmountOutRaw)
  );
}

type ConversionQuoteState =
  | { kind: "loading" }
  | { kind: "ready"; quote: ConversionQuote }
  | { kind: "below-minimum"; minAmountRaw: string }
  | { kind: "token-account-below-minimum"; minAmountRaw: string; feeRaw: string }
  | { kind: "unavailable"; text?: string };

/**
 * Step 4 of a Converting Withdrawal (D-392, plan 020 §5.3). Its own component rather than a
 * branch of `WithdrawStep4`: that one prices a bridge fee and can buy gas, this one shows a
 * 1Click quote, and the two share nothing but the layout.
 *
 * 🔴 The button signs EXACTLY the quote on screen — the object rendered is the object handed
 * to `onConfirm`, never a re-fetch (the gas purchase's pattern). The quote is renewed every
 * 30 s outside the click; the click itself makes no network call before the wallet prompt
 * except the balance read `runConversionWithdraw` already budgets (D-R16).
 */
function WithdrawConversionStep4({
  tokenId,
  plan,
  qty,
  address,
  prices,
  t,
  quoteConversion,
  requoteTick,
  submitting,
  errorText,
  onConfirm,
  onCancel,
}: {
  tokenId: string;
  plan: Extract<WithdrawalPlan, { kind: "conversion" }>;
  qty: number;
  address: string;
  prices: TokenPriceMap;
  t: (typeof bridgeTranslations)["en"];
  quoteConversion: WithdrawConversions["quote"];
  /** Bumped by the modal when the click refused the quote for a reason a fresh one fixes. */
  requoteTick: number;
  submitting: boolean;
  errorText: string | null;
  onConfirm: (quote: ConversionQuote) => void;
  /** Declining a worse price goes back to step 3, with the form as it was. */
  onCancel: () => void;
}) {
  const { chainId, deliveryTokenId } = plan;
  const token = getTokenById(tokenId);
  const deliveryToken = getTokenById(deliveryTokenId);
  const ticker = tickerOf(tokenId);
  const deliveryTicker = tickerOf(deliveryTokenId);
  const decimals = token?.decimals ?? 6;
  const deliveryDecimals = deliveryToken?.decimals ?? decimals;
  const price = prices[tokenId]?.usdPrice ?? token?.fallbackUsdPrice ?? 0;
  const deliveryPrice = prices[deliveryTokenId]?.usdPrice ?? deliveryToken?.fallbackUsdPrice ?? price;
  const chainName = getChainMeta(chainId)?.displayName ?? chainId;
  const fromChainId = getWithdrawalEntry(tokenId)?.chainId;
  const fromChainName = fromChainId ? getChainMeta(fromChainId)?.displayName ?? fromChainId : "";
  const color = colorForSymbol(ticker);

  const [state, setState] = useState<ConversionQuoteState>({ kind: "loading" });
  /**
   * The quote the user is looking at — what a re-quote is measured against (operator, s227,
   * after near.com's swap review): a better one replaces it silently; a worse one is shown with
   * "price updated: old → new" and Cancel / Accept, and nothing is signable until accepted. Against
   * what is on SCREEN, not what was first accepted: a figure must never drop under the user's
   * eyes without a word, even if it is still above where it started.
   */
  const [baseline, setBaseline] = useState<ConversionQuote | null>(null);
  // The click found the quote stale and step 4 re-priced it (C1/C2). Said in amber, not as an error.
  const [requoted, setRequoted] = useState(false);
  // D-441 (b): "Try again" asks at once instead of waiting for the next 30 s tick.
  const [retryTick, setRetryTick] = useState(0);
  // The button that was clicked leaves with the message; the focus goes to Confirm once it is back.
  const retried = useRef(false);
  const inputKey = useRef<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  // Read inside the timer: a refresh landing while the wallet prompt is up would change the
  // numbers under a signature already in progress.
  const submittingRef = useRef(submitting);
  submittingRef.current = submitting;
  // The seam can be rebuilt on every parent render; re-pricing on each would be a 1Click call
  // per render. Same reason `gasSeams` is a ref in `WithdrawStep4`.
  const seamRef = useRef(quoteConversion);
  seamRef.current = quoteConversion;
  const seq = useRef(0);

  useEffect(() => {
    if (!submitting && errorText) confirmRef.current?.focus();
  }, [submitting, errorText]);

  useEffect(() => {
    if (state.kind === "loading" || !retried.current) return;
    retried.current = false;
    confirmRef.current?.focus();
  }, [state.kind]);

  // The tick the last run of the pricing effect answered: a new one means a click was refused.
  const answeredTick = useRef(requoteTick);

  // The confirm button the focus was on is replaced by the pair; Accept takes it over. A click
  // aimed at Confirm can land on Accept as the layout swaps, so Accept ignores clicks for a moment
  // after it appears (cross-review 020-4): agreeing to less has to be read first, not raced.
  const asking = state.kind === "ready" && baseline !== null && givesLess(state.quote, baseline);
  const askingSince = useRef(0);
  useEffect(() => {
    if (!asking) return;
    askingSince.current = Date.now();
    acceptRef.current?.focus();
  }, [asking]);

  useEffect(() => {
    const controller = new AbortController();
    // A new amount or destination starts over; a re-quote of the same one keeps what was agreed.
    const key = `${tokenId}|${chainId}|${qty}|${address}`;
    const fresh = inputKey.current !== key;
    inputKey.current = key;
    // A click refused as stale (C1/C2). The quote on screen can no longer be signed, so it leaves
    // the screen, and "re-priced" is said only once a new one has actually landed — never over
    // the old figures, which is how a refusal that keeps failing looked like a price update.
    const requote = !fresh && answeredTick.current !== requoteTick;
    answeredTick.current = requoteTick;
    const ask = async (announce = false) => {
      if (submittingRef.current) return;
      // Only the newest answer may land: a slow one must not replace a younger quote.
      const mine = (seq.current += 1);
      let next: ConversionQuoteState;
      try {
        const result = await seamRef.current({
          originTokenId: tokenId,
          chainId,
          qty,
          recipient: address,
          signal: controller.signal,
        });
        next = result.ok
          ? { kind: "ready", quote: result.quote }
          : result.reason === "below-minimum"
            ? { kind: "below-minimum", minAmountRaw: result.minAmountRaw }
            : result.reason === "token-account-below-minimum"
              ? { kind: "token-account-below-minimum", minAmountRaw: result.minAmountRaw, feeRaw: result.feeRaw }
              : { kind: "unavailable" };
        if (!result.ok && result.reason === "unavailable") {
          console.warn("[conversion] quote refused:", result.detail);
        }
      } catch (e) {
        // The caller's own refusals before asking 1Click (the balance moved, it could not be read).
        next = { kind: "unavailable", text: withdrawErrorText(e, t) };
        // The balance no longer covers the amount: the quote on screen would only be refused at
        // the click (C1), so it gives way to the reason. A failed READ is a flaky tick like below.
        if (e instanceof AmountExceedsBalanceError) {
          if (controller.signal.aborted || mine !== seq.current || submittingRef.current) return;
          setState(next);
          return;
        }
      }
      if (controller.signal.aborted || mine !== seq.current || submittingRef.current) return;
      // A failed refresh keeps a quote that is still on screen: it stays signable until C2 says
      // otherwise at the click, and blocking on one flaky tick would be noise, not safety.
      setState((prev) => (prev.kind === "ready" && next.kind === "unavailable" ? prev : next));
      if (next.kind === "ready") {
        const landed = next.quote;
        setBaseline((b) => (b === null || !givesLess(landed, b) ? landed : b));
        if (announce) setRequoted(true);
      }
    };
    if (fresh) {
      setState({ kind: "loading" });
      setBaseline(null);
      setRequoted(false);
    } else if (requote) {
      // `baseline` stays: the new figures are still measured against what the user agreed to.
      setState({ kind: "loading" });
      setRequoted(false);
    }
    void ask(requote);
    const timer = setInterval(() => void ask(), CONVERSION_REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [tokenId, chainId, qty, address, requoteTick, retryTick, t]);

  const quote = state.kind === "ready" ? state.quote : null;
  const agreed = quote ? baseline : null;
  const worse = quote !== null && agreed !== null && givesLess(quote, agreed);
  // The banner names the figure that dropped: what arrives, or — if only that held — the guarantee.
  const changedField: "amountOutRaw" | "minAmountOutRaw" =
    worse && quote!.amountOutRaw === agreed!.amountOutRaw ? "minAmountOutRaw" : "amountOutRaw";
  const sentQty = quote ? fromBaseUnits(BigInt(quote.amountInRaw), decimals) : qty;
  const arrivesQty = quote ? fromBaseUnits(BigInt(quote.amountOutRaw), deliveryDecimals) : 0;
  const feeIsZero = quote ? BigInt(quote.withdrawFeeRaw) === BigInt(0) : false;
  const feeQty = quote ? fromBaseUnits(BigInt(quote.withdrawFeeRaw), deliveryDecimals) : 0;
  const pending = state.kind === "loading";
  const dash = pending ? t.conversionQuoteLoading : "—";

  function handleRetryClick() {
    retried.current = true;
    setState({ kind: "loading" });
    setRetryTick((n) => n + 1);
  }

  function handleConfirmClick() {
    // A worse quote is answered with its own pair of buttons; this one is not on screen then.
    if (submitting || !quote || worse) return;
    setRequoted(false);
    onConfirm(quote);
  }

  // Accept IS the confirmation, as on near.com: the user just read the new figures, so this click
  // signs exactly them — and, being the click, it keeps the wallet popup's activation window.
  function handleAcceptClick() {
    if (submitting || !quote) return;
    if (Date.now() - askingSince.current < ACCEPT_ARM_MS) return;
    setBaseline(quote);
    setRequoted(false);
    onConfirm(quote);
  }

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex items-center gap-2 rounded-xl bg-card px-3 py-2">
        <TokenAvatar
          symbol={ticker}
          size={28}
          className="rounded-full"
          style={{ backgroundColor: `${color.hex}22` }}
          fallbackClassName="text-xs font-bold text-slate-950"
        />
        <p className="text-sm text-slate-300">
          {t.withdrawToChain.replace("{ticker}", ticker).replace("{chain}", chainName)}
        </p>
      </div>

      <section aria-labelledby="conversion-details-heading">
        <p id="conversion-details-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {t.withdrawalDetailsSection}
        </p>
        <dl className="flex flex-col gap-2 rounded-xl bg-card px-4 py-3">
          <DetailRow
            label={t.conversionSendLabel}
            // One format with or without a quote: "2.00" before it landed and "2" after read as a change.
            value={`${formatRaw(quote ? quote.amountInRaw : toBaseUnits(qty, decimals), decimals)} ${ticker}`}
            sub={fromChainName ? `${fromChainName} · ${formatUsd(sentQty * price)}` : formatUsd(sentQty * price)}
          />
          <DetailRow label={t.withdrawNetworkLabel} value={chainName} />
          <DetailRow label={t.addressLabel} value={truncateAddress(address)} mono />
        </dl>
        <p className="mt-1.5 text-[11px] text-slate-400">
          {t.conversionNote
            .replace("{ticker}", ticker)
            .replace("{deliveryTicker}", deliveryTicker)
            .replace("{from}", fromChainName)
            .replace("{to}", chainName)}
          {quote && BigInt(quote.refundFeeRaw) > BigInt(0) && (
            <>
              {" "}
              {t.conversionRefundCost
                .replace("{amount}", formatRaw(quote.refundFeeRaw, decimals))
                .replace("{ticker}", ticker)}
            </>
          )}
        </p>
      </section>

      <section aria-labelledby="conversion-costs-heading" aria-busy={pending}>
        <p id="conversion-costs-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {t.costsSection}
        </p>
        <dl className="flex flex-col gap-2 rounded-xl bg-card px-4 py-3">
          {/* Two rows with their own names (plan 020 §5.3): what the destination network charges
              to deliver, and what converting costs. Both are already inside "Arrives". */}
          <DetailRow
            label={t.networkFeeLabel}
            value={
              !quote
                ? dash
                : feeIsZero
                  ? t.freeLabel
                  : `${formatRaw(quote.withdrawFeeRaw, deliveryDecimals)} ${deliveryTicker}`
            }
            sub={quote && !feeIsZero ? formatUsd(feeQty * deliveryPrice) : undefined}
            dimValue={!quote || feeIsZero}
          />
          <DetailRow
            label={t.conversionCostLabel}
            value={quote ? formatCostBps(conversionCostBps(quote)) : dash}
            dimValue={!quote}
          />
          <div className="border-t border-slate-700" role="separator" />
          <DetailRow
            label={t.conversionArrivesLabel}
            value={quote ? `~${formatRaw(quote.amountOutRaw, deliveryDecimals)} ${deliveryTicker}` : dash}
            sub={quote ? `${chainName} · ${formatUsd(arrivesQty * deliveryPrice)}` : undefined}
            highlight={quote !== null}
            dimValue={!quote}
          />
          <DetailRow
            label={t.conversionMinimumLabel}
            value={quote ? `${formatRaw(quote.minAmountOutRaw, deliveryDecimals)} ${deliveryTicker}` : dash}
            dimValue={!quote}
          />
          {quote?.timeEstimateSecs != null && (
            <DetailRow label={t.conversionTimeLabel} value={formatDuration(quote.timeEstimateSecs)} />
          )}
        </dl>
        {/* D-441: a Network Fee far above the usual one, said as the network's charge where it is read. */}
        {quote?.createsTokenAccount && (
          <p className="mt-1.5 rounded-lg bg-amber-900/25 px-2.5 py-1.5 text-[11px] text-amber-300">
            {t.conversionTokenAccountNote
              .replaceAll("{deliveryTicker}", deliveryTicker)
              .replaceAll("{chain}", chainName)}
          </p>
        )}
      </section>

      {worse ? (
        <div role="alert" className="flex items-start gap-2.5 rounded-xl bg-amber-900/25 px-3 py-2.5">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mt-0.5 shrink-0 text-amber-400"
            aria-hidden="true"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <p className="text-xs text-amber-300">
            {t.conversionPriceUpdated}{" "}
            <span className="sr-only">{t.conversionWas} </span>
            <s className="text-amber-300/70">
              {formatRaw(agreed![changedField], deliveryDecimals)} {deliveryTicker}
            </s>
            <span aria-hidden="true"> → </span>
            <span className="sr-only"> {t.conversionNow} </span>
            <span className="font-semibold">
              {formatRaw(quote![changedField], deliveryDecimals)} {deliveryTicker}
            </span>
          </p>
        </div>
      ) : (
        requoted &&
        quote && (
          <p role="status" className="rounded-xl bg-amber-900/25 px-3 py-2.5 text-xs text-amber-300">
            {t.conversionRequoted}
          </p>
        )
      )}

      {state.kind === "below-minimum" && (
        <p role="alert" className="rounded-xl bg-red-950/40 px-3 py-2.5 text-xs text-red-300">
          {t.conversionBelowMinimum
            .replace("{chain}", chainName)
            .replace("{min}", formatRaw(state.minAmountRaw, decimals))
            .replace("{symbol}", ticker)}
        </p>
      )}
      {state.kind === "token-account-below-minimum" && (
        <p role="alert" className="rounded-xl bg-red-950/40 px-3 py-2.5 text-xs text-red-300">
          {t.conversionTokenAccountBelowMinimum
            .replaceAll("{deliveryTicker}", deliveryTicker)
            .replaceAll("{chain}", chainName)
            .replace("{fee}", formatRaw(state.feeRaw, deliveryDecimals))
            .replace("{min}", formatRaw(state.minAmountRaw, decimals))
            .replace("{symbol}", ticker)}
        </p>
      )}
      {state.kind === "unavailable" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-950/40 px-3 py-2.5">
          <p className="min-w-0 flex-1 text-xs text-red-300">{state.text ?? t.conversionUnavailable}</p>
          <button
            type="button"
            onClick={handleRetryClick}
            className="shrink-0 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-100 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t.conversionRetryButton}
          </button>
        </div>
      )}

      <div className="flex items-start gap-2.5 rounded-xl bg-amber-900/25 px-3 py-2.5" role="note">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mt-0.5 shrink-0 text-amber-400"
          aria-hidden="true"
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <p className="text-xs text-amber-300">{t.irreversibleBanner}</p>
      </div>

      {errorText && (
        <div role="alert" className="rounded-xl bg-red-950/40 px-3 py-2.5">
          <p className="text-xs font-medium text-red-300">{t.withdrawNotSent}</p>
          <p className="mt-1 break-words text-[11px] text-red-300/80">{errorText}</p>
        </div>
      )}

      {worse ? (
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className={`${SECONDARY_BUTTON} py-3`}>
            {t.conversionCancelButton}
          </button>
          <button
            ref={acceptRef}
            type="button"
            onClick={handleAcceptClick}
            disabled={submitting}
            className={`${PRIMARY_BUTTON} py-3`}
          >
            {t.conversionAcceptButton}
          </button>
        </div>
      ) : (
        <button
          ref={confirmRef}
          type="button"
          onClick={handleConfirmClick}
          disabled={submitting || !quote}
          aria-busy={submitting || pending}
          className="w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {submitting ? t.withdrawSigningButton : pending ? t.conversionQuoteLoading : t.confirmWithdrawalButton}
        </button>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  sub,
  mono,
  highlight,
  dimValue,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  highlight?: boolean;
  dimValue?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="flex flex-col items-end gap-0.5 text-right">
        <span
          className={
            highlight
              ? "text-sm font-semibold text-slate-100"
              : dimValue
              ? "text-sm text-slate-400"
              : mono
              ? "font-mono text-sm text-slate-100"
              : "text-sm text-slate-200"
          }
        >
          {value}
        </span>
        {sub && <span className="text-xs text-slate-400">{sub}</span>}
      </dd>
    </div>
  );
}

function WithdrawStep3({
  tokenId,
  chainId,
  generalBalance,
  prices,
  t,
  initialAddress,
  initialQty,
  initialMemo,
  ownWalletAddress,
  destinations,
  onChangeDestination,
  isRealRoute,
  conversion,
  registerSend,
  onRegisteringChange,
  onCheckingChange,
  onContinue,
  onBackToStart,
}: {
  tokenId: string;
  chainId: string;
  generalBalance: Map<string, number>;
  prices: TokenPriceMap;
  t: (typeof bridgeTranslations)["en"];
  initialAddress: string;
  initialQty: number;
  initialMemo: string;
  /** The login wallet's own address when it can receive on this chain, else null (no button). */
  ownWalletAddress: string | null;
  /**
   * The chains this token can be withdrawn to, its own first (`withdrawalDestinations`). More
   * than one only on an `omft` row, which can also go to NEAR (D-384) — and only then is the
   * choice shown.
   */
  destinations: string[];
  onChangeDestination: (chainId: string) => void;
  /** Whether this token would take the live money path — gates the destination pre-flight. */
  isRealRoute: boolean;
  /**
   * D-392: set when the chosen network converts (plan 020 §5.3). Then every check of the
   * address is against the Delivery Token — that is what lands — and there is no memo, no
   * registry minimum (1Click names one at step 4) and no Register: 1Click registers.
   */
  conversion: Extract<WithdrawalPlan, { kind: "conversion" }> | null;
  /** Sends the registration from the NEAR login's wallet (D-316); null for any other login. */
  registerSend: SendTransactionAs | null;
  /** Tells the modal a registration signature is pending, so it can refuse to close. */
  onRegisteringChange: (registering: boolean) => void;
  /** Same, for the destination pre-flight: its answer is only good for the values it checked. */
  onCheckingChange: (checking: boolean) => void;
  onContinue: (address: string, qty: number, memo: string, destinationVerified: boolean) => void;
  onBackToStart: () => void;
}) {
  const [typedAddress, setAddress] = useState(initialAddress);
  // D-387 (b): the one form of the address this step validates, shows in the field, quotes and
  // hands on to be signed. Derived on every render, not stored, so switching the destination
  // network re-normalizes against the chain now selected.
  const address = normalizeAddress(typedAddress, chainId);
  const [qty, setQty] = useState(initialQty > 0 ? String(initialQty) : "");
  const [memo, setMemo] = useState(initialMemo);
  const [checkingDestination, setCheckingDestination] = useState(false);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  // Advisory, and scoped to the exact address it was raised for — see `handleContinue`.
  const [destinationWarning, setDestinationWarning] = useState<string | null>(null);
  // D-316: an unregistered own account can be registered from here. The cost is tied to the
  // address it was read for, so a late answer can never price a different one.
  const [notRegistered, setNotRegistered] = useState(false);
  const [registration, setRegistration] = useState<{ address: string; cost: bigint | "failed" } | null>(null);
  const [registering, setRegistering] = useState(false);
  const continueRef = useRef<HTMLButtonElement>(null);
  const registerRef = useRef<HTMLButtonElement>(null);
  // Read at call time, like `submittingRef`: two clicks in one render both see
  // `registering === false`, and each would open its own wallet prompt.
  const registeringRef = useRef(false);
  // Tied to the address it speaks about, like the cost: an edit mid-registration hides it.
  const [registrationNotice, setRegistrationNotice] = useState<{
    address: string;
    kind: StorageRegistrationResult["kind"];
  } | null>(null);

  const token = getTokenById(tokenId);
  // A conversion lands as the Delivery Token, so that is the entry every destination check reads.
  const entry = conversion
    ? getWithdrawalEntry(conversion.deliveryTokenId, chainId)
    : getWithdrawalEntry(tokenId, chainId);
  const chainMeta = getChainMeta(chainId);
  // The token's own chain, as in WithdrawStep4. Not `destinations[0]`: with conversions on, the
  // list can start with NEAR, and a token that already lives on NEAR has no "arrives as" note.
  const ownChainId = withdrawalDestinations(tokenId)[0] ?? chainId;
  const balance = generalBalance.get(tokenId) ?? 0;
  const decimals = token?.decimals ?? 6;
  const symbol = token?.symbol ?? tokenId;
  // Base ticker (USDT) without the network qualifier (USDT(ETH)) — see WithdrawStep4.
  const ticker = symbol.split("(")[0].trim();
  const price = prices[tokenId]?.usdPrice ?? token?.fallbackUsdPrice ?? 0;
  const color = colorForSymbol(ticker);
  // The floor the ENVELOPE enforces, not just the bridge's own: an amount that does not clear
  // the fee delivers nothing at all, so the fee belongs in the minimum the user is shown.
  // Uses the registry snapshot here; step 4 re-checks against the live quote.
  const minRaw = conversion ? null : minimumWithdrawalRaw(tokenId, undefined, chainId);
  const minWithdrawal = minRaw ? Number(minRaw) / Math.pow(10, decimals) : 0;

  const addressResult = address ? validateAddress(address, chainId) : { valid: false };
  const wrongChain = address ? detectWrongChain(address, chainId) : null;
  // An address that belongs to the OTHER destination this token offers: the way out is to
  // switch to it, not to start over.
  const switchTarget = wrongChain
    ? destinations.find(
        (c) => c !== chainId && validateAddress(address, c).valid && !detectWrongChain(address, c)
      ) ?? null
    : null;
  // A contract that would take the funds and credit nobody; the envelope refuses it too
  // (`unreceivableNearDestination`). Said here, before anything is checked.
  const unreceivable = entry && address ? unreceivableNearDestination(entry, address) : null;
  const showAddressError =
    address.length > 0 && !!addressResult.errorKey && !wrongChain && !unreceivable;
  const showAddressWarning = address.length > 0 && !!addressResult.warningKey;

  const qtyNum = parseFloat(qty);
  const qtyHasValue = qty !== "" && !isNaN(qtyNum) && qtyNum > 0;
  const qtyExceedsBalance = qtyHasValue && qtyNum > balance;
  const qtyBelowMin = qtyHasValue && minWithdrawal > 0 && qtyNum < minWithdrawal;
  const qtyValid = qtyHasValue && !qtyExceedsBalance && !qtyBelowMin;

  // D-240: the chain registry's `memoRequired` describes the DEPOSIT direction — entering the
  // bridge's SHARED address is what needs a memo to attribute the funds (D-233). A withdrawal
  // lands in the user's OWN account and needs none. Worse, HOT actively REJECTS a destination
  // memo on withdrawal (withdraw-envelope.ts), so reading the deposit flag here deadlocked
  // Stellar — the only chain with the flag on: an empty memo failed `memoValid`, a non-empty one
  // threw in the envelope builder, and no input could complete the form. The requirement
  // therefore follows the withdrawal ROUTE, never the deposit chain.
  // A conversion never carries one: no delivery chain routes on memos (conversion-routes.test.ts).
  const chainRoutesOnMemo = !conversion && (chainMeta?.memoRequired ?? false);
  const routeCarriesMemo = entry?.bridgeRoute !== "hot-omni";
  const memoRequired = chainRoutesOnMemo && routeCarriesMemo;
  // The chain routes on memos but this rail cannot carry one. Said out loud, because the silent
  // version lets someone withdraw to an exchange deposit address — which needs a memo to credit
  // the right customer — and arrive with nothing to attribute the funds by.
  const memoUnsupported = chainRoutesOnMemo && !routeCarriesMemo;
  const memoValid = !memoRequired || memo.trim().length > 0;
  // Never hand a memo to a rail that rejects it: `initialMemo` can arrive non-empty from an
  // earlier step even when the field is no longer rendered.
  const outgoingMemo = routeCarriesMemo ? memo : "";

  const canContinue =
    addressResult.valid && !wrongChain && !unreceivable && qtyValid && memoValid;

  const minDisplay = minWithdrawal > 0
    ? minWithdrawal.toFixed(Math.min(decimals, 8))
    : null;

  /**
   * The `near-native` destination pre-flight, run HERE and not at the confirm click.
   *
   * It is two NEAR view calls, and the confirm click has to reach a wallet popup inside the
   * browser's user-activation window (~5s in Blink). Running them there is what broke the
   * signing popup once already (D-R16). Here they can take as long as they need, and the user
   * finds out the destination is unusable before the confirmation screen rather than after it.
   */
  // A conversion is always live (no mock offers one), so it always gets the checks.
  const liveChecks = isRealRoute || conversion !== null;
  const needsNearPreflight =
    liveChecks &&
    (entry?.bridgeRoute === "near-native" || entry?.bridgeRoute === "near-unwrap");
  /**
   * Solana's, added in 4.2. Keyed on the CHAIN and not the route: the danger — a pasted SPL
   * token account, which `validateAddress` cannot distinguish from a wallet — is a property of
   * where the funds land, not of how they get there.
   */
  const needsSolanaPreflight =
    liveChecks && entry?.bridgeRoute === "omft" && entry.chainId === "sol:mainnet";
  const needsDestinationPreflight = needsNearPreflight || needsSolanaPreflight;

  // Only for the login's own NEAR account and a NEP-141 token: registering someone else's
  // account, or asking for it on `near-unwrap` (native NEAR needs none), is not ours to offer.
  const canRegister =
    conversion === null &&
    registerSend !== null &&
    entry?.bridgeRoute === "near-native" &&
    ownWalletAddress !== null &&
    address === ownWalletAddress;
  const registrationCost = registration?.address === address ? registration.cost : null;
  const registrationOutcome = registrationNotice?.address === address ? registrationNotice.kind : null;
  // The form is frozen while a check or a registration is in flight: both answer for the values
  // of the click, and an edit in between would get a verdict meant for something else.
  const locked = checkingDestination || registering;

  // The Register button leaves with the refusal, taking focus with it. Continue is where the flow
  // goes on — after the render that re-enables it, since a disabled button cannot take focus.
  useEffect(() => {
    if (registrationOutcome === "registered" && !registering) continueRef.current?.focus();
  }, [registrationOutcome, registering]);

  // D-374: after the `not-registered` refusal, registering is the way forward and Continue
  // would only be refused again — so Register leads, in weight and in focus (once its cost is
  // known and it can be pressed; again after a registration that did not land).
  const registerLeads = !!destinationError && notRegistered && canRegister && registrationCost !== "failed";
  const registerReady = registerLeads && typeof registrationCost === "bigint";
  useEffect(() => {
    if (registerReady && !registering && registrationOutcome !== "registered") registerRef.current?.focus();
  }, [registerReady, registering, registrationOutcome]);

  function changeAddress(next: string) {
    setAddress(next);
    // Both verdicts belong to the address that was checked. Carrying either across an edit
    // would let a NEW address inherit an OLD address's clearance.
    setDestinationError(null);
    setDestinationWarning(null);
    setNotRegistered(false);
  }

  // The address is kept — it may be the very reason for switching — but every verdict about
  // it goes: each was reached for the other chain's route.
  function changeDestination(next: string) {
    if (next === chainId || locked) return;
    changeAddress(address);
    setRegistrationNotice(null);
    onChangeDestination(next);
  }

  async function handleRegister() {
    if (!registerSend || !entry || typeof registrationCost !== "bigint" || registeringRef.current) return;
    registeringRef.current = true;
    const registered = address;
    setRegistering(true);
    onRegisteringChange(true);
    setRegistrationNotice(null);
    try {
      const result = await registerNearDestination({
        send: registerSend,
        tokenAccountId: entry.nearTokenId,
        accountId: registered,
        cost: registrationCost,
      });
      setRegistrationNotice({ address: registered, kind: result.kind });
      // The withdrawal goes on through Continue, which re-runs the pre-flight on whatever the
      // form holds by then. Advancing from here would carry the values of the click, and the
      // user may have edited the amount while the wallet was open.
      if (result.kind === "registered") {
        setDestinationError(null);
        setNotRegistered(false);
      }
    } catch (e) {
      // `registerNearDestination` reports rather than throws; this is the belt to that braces.
      console.warn("[register] unexpected failure:", e);
      setRegistrationNotice({ address: registered, kind: "not-confirmed" });
    } finally {
      registeringRef.current = false;
      setRegistering(false);
      onRegisteringChange(false);
    }
  }

  async function handleContinue() {
    if (!canContinue || checkingDestination) return;
    if (!needsDestinationPreflight || !entry) {
      onContinue(address, qtyNum, outgoingMemo, false);
      return;
    }
    // Second click with the warning on screen: the check already ran and passed for THIS
    // address, and the user has now read what it flagged. `destinationWarning` is cleared on
    // every address edit, so this can never wave through an address that was not checked.
    if (destinationWarning) {
      onContinue(address, qtyNum, outgoingMemo, true);
      return;
    }
    setCheckingDestination(true);
    onCheckingChange(true);
    setDestinationError(null);
    setNotRegistered(false);
    try {
      if (needsNearPreflight) {
        // D-386 (d): the contract read runs alongside, never fails, and only ever warns.
        const [, isContract] = await Promise.all([
          assertNearDestinationUsable({
            tokenAccountId: entry.nearTokenId,
            destinationAddress: address,
            probe: defaultNearDestinationProbe,
            // Same rule as the money path's own check (withdraw-submit.ts): native NEAR needs no
            // storage on wrap.near, so asking for it refused good accounts (D-372).
            // A conversion only needs the account to exist: 1Click registers it when it delivers
            // (plan 020 §5.3), and charges that within the Network Fee step 4 shows.
            requireStorageRegistration: conversion === null && entry.bridgeRoute === "near-native",
          }),
          nearDestinationIsContract(address),
        ]);
        // Same as Solana's warning below: it stops this click only.
        if (isContract) setDestinationWarning(t.destinationContract.replace("{address}", address));
        else onContinue(address, qtyNum, outgoingMemo, true);
      } else {
        const { warning } = await assertSolanaDestinationUsable({
          destinationAddress: address,
          probe: defaultSolanaDestinationProbe,
        });
        // A warning stops this click and only this click. Advancing straight through would
        // put the notice on a screen the user has already decided on.
        if (warning) setDestinationWarning(t.destinationNewAccount.replace("{address}", address));
        else onContinue(address, qtyNum, outgoingMemo, true);
      }
    } catch (e) {
      if (e instanceof WithdrawDestinationUnusableError && e.problem === "not-registered") {
        setNotRegistered(true);
        // Priced here, off the click that will open the wallet (D-R16).
        if (canRegister && (registration?.address !== address || registration.cost === "failed")) {
          setRegistration(null);
          const checked = address;
          readRegistrationCost(entry.nearTokenId).then(
            (cost) => setRegistration({ address: checked, cost }),
            (err: unknown) => {
              console.warn("[register] could not read the registration cost:", err);
              setRegistration({ address: checked, cost: "failed" });
            }
          );
        }
      }
      // Every problem here is `fundsState: "untouched"` — nothing was signed. `unverified`
      // fails closed on purpose, so an RPC flake reads as "try again", not as a lost account.
      setDestinationError(
        e instanceof WithdrawDestinationUnusableError
          ? t[DESTINATION_PROBLEM_KEY[e.problem]].replace("{address}", address)
          : e instanceof SolanaDestinationUnusableError
          ? t[SOLANA_DESTINATION_PROBLEM_KEY[e.problem]].replace("{address}", address)
          : e instanceof Error
          ? e.message
          : String(e)
      );
    } finally {
      setCheckingDestination(false);
      onCheckingChange(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      {/* Context chip: token → chain */}
      <div className="flex items-center gap-2 rounded-xl bg-card px-3 py-2">
        <TokenAvatar
          symbol={ticker}
          size={28}
          className="rounded-full"
          style={{ backgroundColor: `${color.hex}22` }}
          fallbackClassName="text-xs font-bold text-slate-950"
        />
        <p className="text-sm text-slate-300">
          {t.withdrawToChain
            .replace("{ticker}", ticker)
            .replace("{chain}", chainMeta?.displayName ?? chainId)}
        </p>
      </div>

      {/* D-384: destination network, only where there is a choice. */}
      {destinations.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <p id="withdraw-destination-label" className="text-xs font-medium text-slate-400">
            {t.withdrawDestinationLabel}
          </p>
          {/* Two fit in a row (D-384); a family's conversions offer up to five (plan 020 §5.2). Three
              columns only from `sm`: at 390/360 px they cut "Ethereum" and "Arbitrum" (020-3 QA). */}
          <div
            role="group"
            aria-labelledby="withdraw-destination-label"
            className={
              destinations.length === 4
                ? "grid grid-cols-2 gap-2"
                : destinations.length > 2
                  ? "grid grid-cols-2 gap-2 sm:grid-cols-3"
                  : "flex gap-2"
            }
          >
            {destinations.map((c) => {
              const selected = c === chainId;
              const name = getChainMeta(c)?.displayName ?? c;
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => changeDestination(c)}
                  disabled={locked}
                  className={`flex min-w-0 flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed ${
                    selected
                      ? "bg-accent/10 text-accent ring-1 ring-accent/60"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  {hasChainIcon(c) && <ChainIcon chainId={c} size={18} />}
                  <span className="truncate">{name}</span>
                </button>
              );
            })}
          </div>
          {conversion ? (
            <p className="text-[11px] text-slate-400">
              {t.withdrawArrivesAs
                .replace("{ticker}", tickerOf(conversion.deliveryTokenId))
                .replace("{chain}", chainMeta?.displayName ?? chainId)}
              {(generalBalance.get(conversion.deliveryTokenId) ?? 0) > 0 && (
                // D-426: the Delivery Token itself is in the balance, so it leaves without 1Click.
                <span className="mt-1 block text-accent">
                  {t.withdrawHoldsDeliveryToken
                    .replace("{ticker}", tickerOf(conversion.deliveryTokenId))
                    .replace("{chain}", chainMeta?.displayName ?? chainId)}
                </span>
              )}
            </p>
          ) : chainId === NEAR_DESTINATION_CHAIN_ID && ownChainId !== chainId && entry && (
            <p className="text-[11px] text-slate-400">
              {t.withdrawArrivesAsNearToken
                .replace("{contract}", entry.nearTokenId)
                .replaceAll("{ticker}", ticker)
                .replace("{chain}", getChainMeta(ownChainId)?.displayName ?? ownChainId)}
            </p>
          )}
        </div>
      )}

      {/* Address input */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label htmlFor="withdraw-address" className="text-xs font-medium text-slate-400">
            {t.addressLabel}
          </label>
          {ownWalletAddress && (
            <button
              type="button"
              // Only fills the input: everything below runs on it as if it had been typed.
              onClick={() => changeAddress(ownWalletAddress)}
              disabled={locked}
              className="rounded text-xs font-semibold text-accent underline decoration-accent/40 underline-offset-4 transition hover:decoration-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {t.useMyWallet}
            </button>
          )}
        </div>
        <input
          id="withdraw-address"
          type="text"
          value={address}
          onChange={(e) => changeAddress(e.target.value.trim())}
          readOnly={locked}
          placeholder={getAddressPlaceholder(chainId)}
          className="w-full rounded-xl bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-accent/60"
          autoComplete="off"
          spellCheck={false}
        />
        {showAddressError && addressResult.errorKey && (
          <p role="alert" className="text-xs text-red-400">
            {t[addressResult.errorKey]}
          </p>
        )}
        {showAddressWarning && addressResult.warningKey && (
          <p role="alert" className="text-xs text-amber-400">
            {t[addressResult.warningKey]}
          </p>
        )}
        {wrongChain && (
          <p role="alert" className="text-xs text-amber-400">
            {t.addressWrongChain.replace("{chain}", wrongChain)}{" "}
            {switchTarget ? (
              <button
                type="button"
                className="underline text-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                onClick={() => changeDestination(switchTarget)}
              >
                {t.sendToChainInstead.replace(
                  "{chain}",
                  getChainMeta(switchTarget)?.displayName ?? switchTarget
                )}
              </button>
            ) : (
              <button
                type="button"
                className="underline text-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                onClick={onBackToStart}
              >
                {t.backToStart}
              </button>
            )}
          </p>
        )}
        {unreceivable && (
          <p role="alert" className="text-xs text-red-400">
            {unreceivable === "token-contract" ? t.addressIsTokenContract : t.addressNotReceivable}
          </p>
        )}
      </div>

      {/* Amount input */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label htmlFor="withdraw-qty" className="text-xs font-medium text-slate-400">
            {t.amountLabel}
          </label>
          <span className="text-xs text-slate-400">
            {t.availableBalance
              .replace("{qty}", formatTokenAmount(balance, price))
              .replace("{symbol}", ticker)}
          </span>
        </div>
        <div className="flex gap-2">
          <input
            id="withdraw-qty"
            type="number"
            min="0"
            step="any"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            readOnly={locked}
            placeholder="0.00"
            className="min-w-0 flex-1 rounded-xl bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-accent/60"
          />
          <button
            type="button"
            // The full float, not a rounded one (D-315): it parses back to exactly `balance`,
            // so the field never reads as above it, and the envelope's `capToHeld` (D-303)
            // turns it into the exact raw balance — on either side of the float's noise.
            onClick={() => setQty(formatDecimalForInput(balance))}
            disabled={locked}
            className="shrink-0 rounded-xl bg-slate-800 px-3 py-2.5 text-xs font-semibold text-accent transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t.maxButton}
          </button>
        </div>
        <span className="mt-1 text-right text-[11px] tabular-nums text-slate-400">
          ≈ {formatUsd(parseFloat(qty || "0") * price)}
        </span>
        {qtyHasValue && qtyExceedsBalance && (
          <p role="alert" className="text-xs text-red-400">{t.amountExceedsBalance}</p>
        )}
        {qtyHasValue && qtyBelowMin && !qtyExceedsBalance && minDisplay && (
          <p role="alert" className="text-xs text-red-400">
            {t.amountBelowMin.replace("{min}", minDisplay).replace("{symbol}", ticker)}
          </p>
        )}
      </div>

      {/* This chain routes on memos but this rail drops them (D-240). Stated, not silent: an
          exchange deposit address needs the memo to credit the right customer, and funds that
          arrive without one are not a failed transfer that can be retried. */}
      {memoUnsupported && (
        <p className="rounded-xl bg-amber-950/30 px-3 py-2.5 text-xs text-amber-300">
          {t.memoNotCarried.replace("{chain}", chainMeta?.displayName ?? chainId)}
        </p>
      )}

      {/* D-387 (c): another chain's addresses share this one's format and no check separates them. */}
      {LOOKALIKE_ADDRESS_CHAIN[chainId] && (
        <p className="rounded-xl bg-amber-950/30 px-3 py-2.5 text-xs text-amber-300">
          {t.addressLookalikeChain
            .replace("{other}", LOOKALIKE_ADDRESS_CHAIN[chainId])
            .replaceAll("{chain}", chainMeta?.displayName ?? chainId)}
        </p>
      )}

      {/* Memo input (conditional) */}
      {memoRequired && (
        <div className="flex flex-col gap-1">
          <label htmlFor="withdraw-memo" className="text-xs font-medium text-slate-400">
            {t.memoLabel}
          </label>
          <input
            id="withdraw-memo"
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            readOnly={locked}
            placeholder={t.memoRequired}
            className="w-full rounded-xl bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-accent/60"
          />
        </div>
      )}

      {/* Destination pre-flight failure — nothing has been signed at this point. */}
      {destinationError && (
        <p role="alert" className="break-words rounded-xl bg-red-950/40 px-3 py-2.5 text-xs text-red-300">
          {destinationError}
        </p>
      )}

      {/* D-316: the way out of `not-registered`. A failed cost read falls back to the text. */}
      {destinationError && notRegistered && (
        registerLeads ? (
          <div className="flex flex-col gap-2 rounded-xl bg-card px-3 py-2.5">
            <p className="text-xs text-slate-300" aria-live="polite">
              {typeof registrationCost === "bigint"
                ? t.registerAccountHint.replace("{cost}", formatBaseUnits(registrationCost, 24))
                : t.registerAccountCostLoading}
            </p>
            <button
              ref={registerRef}
              type="button"
              disabled={typeof registrationCost !== "bigint" || registering}
              aria-busy={registering}
              onClick={handleRegister}
              className={`${PRIMARY_BUTTON} py-2.5`}
            >
              {registering ? t.registeringAccount : t.registerAccountButton}
            </button>
            {registrationOutcome && registrationOutcome !== "registered" && (
              <p role="alert" className="text-xs text-amber-300">
                {registrationOutcome === "declined"
                  ? t.registerAccountDeclined
                  : registrationOutcome === "wallet-not-connected"
                    ? t.registerAccountWalletNotConnected
                    : t.registerAccountNotConfirmed}
              </p>
            )}
          </div>
        ) : (
          <p className="break-words text-xs text-slate-400">
            {t.registerAccountElsewhere.replace("{address}", address)}
          </p>
        )
      )}

      {registrationOutcome === "registered" && !destinationError && (
        <p role="status" className="rounded-xl bg-emerald-950/40 px-3 py-2.5 text-xs text-emerald-300">
          {t.registerAccountDone}
        </p>
      )}

      {/* Amber, never red: the destination is unusual, not refused (D-213). */}
      {destinationWarning && !destinationError && (
        <p role="alert" className="rounded-xl bg-amber-950/40 px-3 py-2.5 text-xs text-amber-300">
          {destinationWarning}
        </p>
      )}

      {/* Continue button */}
      <button
        ref={continueRef}
        type="button"
        disabled={!canContinue || checkingDestination || registering}
        aria-busy={checkingDestination}
        onClick={handleContinue}
        className={registerLeads ? SECONDARY_BUTTON : `${PRIMARY_BUTTON} py-3`}
      >
        {checkingDestination
          ? t.checkingDestination
          : destinationWarning
          ? t.continueAnyway
          : t.continueButton}
      </button>
    </div>
  );
}

function WithdrawChainPicker({
  variants,
  title,
  t,
  onSelect,
}: {
  variants: WithdrawVariant[];
  title: string;
  t: (typeof bridgeTranslations)["en"];
  onSelect: (variant: WithdrawVariant) => void;
}) {
  // D-488: a single selectable network is shown preselected; the user confirms it with Continue.
  const preselected = variants.length === 1 && variants[0].available ? variants[0] : null;
  return (
    <div className="px-2 py-2">
      {/* The modal header already says `title`; repeating it as a section label read twice (020-3 QA). */}
      <ul role="list" aria-label={title}>
        {variants.map((variant) => {
          const symbol = getTokenById(variant.tokenId)?.symbol ?? variant.tokenId;
          const ticker = symbol.split("(")[0].trim();
          return (
            <li key={variant.tokenId}>
              <button
                type="button"
                onClick={() => onSelect(variant)}
                disabled={!variant.available}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 active:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:active:bg-transparent ${variant === preselected ? "bg-slate-800 ring-1 ring-inset ring-accent/60" : ""}`}
              >
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-slate-300"
                  aria-hidden="true"
                >
                  {hasChainIcon(variant.chainId)
                    ? <ChainIcon chainId={variant.chainId} size={28} />
                    : variant.displayName.slice(0, 2)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-100">{variant.displayName}</p>
                  {!variant.available ? (
                    <p className="text-xs text-amber-400">{t.notAvailableYet}</p>
                  ) : variant.memoRequired ? (
                    <p className="text-xs text-amber-400">{t.memoRequired}</p>
                  ) : null}
                </div>
                {/* Per-network balance — mitigates the aggregated-total expectation (D-153) */}
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <p className="text-sm font-medium text-slate-100">{formatUsd(variant.usd)}</p>
                  <p className="text-xs text-slate-400">
                    {formatTokenAmount(variant.qty, variant.price)} {ticker}
                  </p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {preselected && (
        <div className="px-3 pb-2 pt-3">
          <button type="button" onClick={() => onSelect(preselected)} className={`${PRIMARY_BUTTON} py-3`}>
            {t.continueButton}
          </button>
        </div>
      )}
    </div>
  );
}

// D-483: Withdraw lists only what the account holds, often two or three assets; past this many
// a search earns its row.
const WITHDRAW_SEARCH_FROM = 7;

function WithdrawTokenPicker({
  groups,
  lastUsedToken,
  t,
  onSelect,
  holdsStock,
}: {
  groups: WithdrawGroup[];
  holdsStock: boolean;
  lastUsedToken: string | null;
  t: (typeof bridgeTranslations)["en"];
  onSelect: (group: WithdrawGroup) => void;
}) {
  const [search, setSearch] = useState("");
  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-5 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-800" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500"><path d="M12 5v14"/><path d="m19 12-7-7-7 7"/><path d="M5 3h14"/></svg>
        </div>
        <p className="text-sm font-medium text-slate-300">{t.withdrawNoAssets}</p>
        <p className="text-xs text-slate-400">{holdsStock ? t.withdrawNoAssetsStockBody : t.withdrawNoAssetsBody}</p>
      </div>
    );
  }

  const visible = groups.length >= WITHDRAW_SEARCH_FROM ? matchAssetGroups(groups, search) : groups;

  return (
    <div className="px-2 py-2">
      <p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {t.withdrawStep1Title}
      </p>
      {groups.length >= WITHDRAW_SEARCH_FROM && (
        <AssetSearch value={search} onChange={setSearch} placeholder={t.searchAsset} />
      )}
      {visible.length === 0 && <p className="px-3 py-8 text-center text-sm text-slate-400">{t.noAssetsFound}</p>}
      <ul role="list">
        {visible.map((group) => {
          const isLastUsed = group.assetName === lastUsedToken;
          const color = colorForSymbol(group.ticker);
          const variantCount = group.variants.length;
          const available = groupAvailable(group);
          // Subtitle surfaces where the balance lives: the network for a single variant,
          // or a network count when the symbol spans several (mirrors the receive picker).
          // A fully deferred symbol says so instead — its networks are all it would name.
          const subtitle = !available
            ? t.notAvailableYet
            : variantCount === 1
              ? group.variants[0].displayName
              : t.chainCount.replace("{count}", String(variantCount));
          return (
            <li key={group.assetName}>
              <button
                type="button"
                onClick={() => onSelect(group)}
                disabled={!available}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 active:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:active:bg-transparent"
              >
                <TokenAvatar
                  symbol={group.ticker}
                  size={36}
                  className="rounded-full"
                  style={{ backgroundColor: `${color.hex}22` }}
                  fallbackClassName="text-xs font-bold text-slate-950"
                />

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-100">{group.ticker}</p>
                  <p className={`truncate text-xs ${available ? "text-slate-400" : "text-amber-400"}`}>
                    {subtitle}
                  </p>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1">
                  {isLastUsed && (
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                      {t.lastUsed}
                    </span>
                  )}
                  <p className="text-sm font-medium text-slate-100">{formatUsd(group.totalUsd)}</p>
                  <p className="text-xs text-slate-400">
                    {formatTokenAmount(group.totalQty, group.variants[0].price)} {group.ticker}
                  </p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
