// Deposit from the user's own NEAR wallet straight into their General Balance (016 §5.3, block
// 2a, D-338). The QR path hands the user a bridge address and waits for the bridge; this one is
// ONE transaction, signed in the wallet, to the token contract, which forwards the tokens to
// `intents.near` through `ft_transfer_call`. Same result as the QR: a deposit in the General
// Balance of the account that signed.
//
// Everything that decides how much money moves and where is a pure function of its inputs —
// the scope, the amount, the most the user may send, the transaction and the verdict on its
// outcome — so all of it is testable without a wallet or a network. The one async function
// (`readWalletDepositBalance`) takes its reads injected.
//
// The shape is near.com's, not ours (defuse-frontend `depositService.ts`
// `createBatchDepositNearNep141Transaction` / `createBatchDepositNearNativeTransaction`, and
// `RESERVED_NEAR_BALANCE`). Where this file departs from it, it says so at the spot.
//
// Attribution: see ATTRIBUTIONS.md #22.

import { getTokenById, tokenRegistry } from "@/features/market/lib/token-registry";
import { toIntentsTokenId } from "@/features/market/lib/intents-token-id";
import {
  BROWSER_RPC_URL,
  INTENTS_CONTRACT_ID,
  WNEAR_CONTRACT_ID,
} from "@/features/wallet/config/network";
import { fetchNearAccountState, type NearAccountState } from "@/features/wallet/lib/balance-fetcher";
import { normalizeWalletError } from "@/features/wallet/adapter/normalize-error";
import { AmountExceedsBalanceError } from "@/features/vault/lib/base-units";
import { extractTxHash } from "@/features/vault/lib/allocate-submit";
import { findExecutionFailure } from "@/features/vault/lib/vault-events";
import { fetchTxOutcome, viewCall } from "@/features/vault/lib/near-view";
import { getIntentsBalances } from "@/features/vault/lib/intents-read-client";
import { getWithdrawalEntry } from "./withdrawal-registry";
import { NOT_RECEIVED_TOKEN_IDS, isTokenAvailable } from "./token-availability";

// `BigInt(…)` and not `…n`: tsconfig targets ES2017, where the literal form does not compile.
const ZERO = BigInt(0);

/** near.com's `FT_DEPOSIT_GAS`: 30 Tgas for `near_deposit`. */
export const NEAR_DEPOSIT_GAS = "30000000000000";

/** near.com's `FT_TRANSFER_GAS`: 50 Tgas for `ft_transfer_call` and the callbacks it pays for. */
export const FT_TRANSFER_CALL_GAS = "50000000000000";

/**
 * 1 yoctoNEAR on `ft_transfer_call`. NEP-141 demands exactly one: it is what forces the call to
 * come from a full-access key, since a FunctionCall key cannot attach a deposit at all.
 */
export const FT_TRANSFER_CALL_DEPOSIT = "1";

/**
 * 0.1 NEAR left in the wallet for gas — near.com's `RESERVED_NEAR_BALANCE` and the figure its
 * tooltip quotes ("to cover network fees, we reserve 0.1 NEAR"). The two actions attach 80
 * Tgas between them; unused gas is refunded, but the wallet must hold the prepayment to sign.
 */
export const NEAR_GAS_RESERVE_YOCTO = BigInt("100000000000000000000000");

/**
 * 0.1 NEAR the wallet must hold free (beyond its storage) before a TOKEN deposit is offered
 * (D-349) — the same figure the NEAR path leaves behind. The token path pays its gas in NEAR,
 * never in the token: 50 Tgas prepaid for `ft_transfer_call`, plus 1 yocto.
 *
 * 🔴 The prepayment is bought at the PURCHASE price, not the block's gas price. Read on mainnet
 * 2026-09-30 (protocol 86): block `gas_price` 10^8, but `runtime_config.min_gas_purchase_price`
 * 10^9; cross-review measured real `ft_transfer_call`s charged ≈ 10^9 yocto per prepaid gas at
 * inclusion (the unused part comes back later). So 50 Tgas holds ≈ 0.05 NEAR at signing; below
 * that the network refuses the transaction (`NotEnoughBalance`) before running anything. 0.1
 * leaves twice that for fees and a rising price.
 */
export const FT_GAS_RESERVE_YOCTO = BigInt("100000000000000000000000");

/** NEAR protocol `storage_amount_per_byte`: 10^19 yocto, i.e. 100 kB per NEAR. */
export const STORAGE_YOCTO_PER_BYTE = BigInt("10000000000000000000");

const NEP141_PREFIX = "nep141:";

// ── Scope ────────────────────────────────────────────────────────────────────

export type WalletDepositTarget = {
  /** Registry id — what the picker, the balances and `creditReceive` all key on. */
  tokenId: string;
  /** `native` wraps NEAR on the way in; `ft` sends a NEP-141 token as it is. */
  kind: "native" | "ft";
  /** The contract the transaction goes to. */
  contractId: string;
  decimals: number;
};

/**
 * What a wallet deposit of `tokenId` would call, or null when this path does not serve it.
 *
 * Served: the day-1 tokens whose chain is NEAR itself — NEAR (`near-unwrap`) and the 12
 * `near-native` rows. Everything else is null, including an `omft`/`hot-omni` token the user
 * happens to hold in their NEAR wallet: its network in the picker is not NEAR, and depositing it
 * from here is a different flow (out of scope for 2a).
 *
 * 🔴 WHY THE CONTRACT IS DERIVED FROM THE INTENTS ID AND NOT READ OFF THE REGISTRY. With an empty
 * `msg`, `intents.near` credits `nep141:<the contract that called ft_on_transfer>` to the sender.
 * The General Balance is read by intents id (`use-intents-balances`). So the contract we call and
 * the asset the app looks for must be the same account by construction — deriving one from the
 * other makes a deposit that lands under an id nobody reads impossible, instead of hoping two
 * tables agree. For NEAR that id is `nep141:wrap.near`, which is why NEAR goes through `wrap.near`.
 */
export function walletDepositTarget(tokenId: string): WalletDepositTarget | null {
  // The allowlist, not the route, is what turns a row into live money (token-availability.ts).
  // A token Receive cuts (D-491) is not offered from the wallet either.
  if (!isTokenAvailable(tokenId) || NOT_RECEIVED_TOKEN_IDS.has(tokenId)) return null;
  const entry = getWithdrawalEntry(tokenId);
  if (!entry || entry.chainId !== "near:mainnet") return null;
  if (entry.bridgeRoute !== "near-native" && entry.bridgeRoute !== "near-unwrap") return null;
  const token = getTokenById(tokenId);
  if (!token) return null;

  const intentsId = toIntentsTokenId(tokenId);
  if (!intentsId.startsWith(NEP141_PREFIX)) return null;
  const contractId = intentsId.slice(NEP141_PREFIX.length);

  if (entry.bridgeRoute === "near-unwrap") {
    // Only native NEAR takes the wrap path, and only through the one wrapper we read balances of.
    if (contractId !== WNEAR_CONTRACT_ID) return null;
    return { tokenId, kind: "native", contractId, decimals: token.decimals };
  }
  return { tokenId, kind: "ft", contractId, decimals: token.decimals };
}

export function isWalletDepositToken(tokenId: string): boolean {
  return walletDepositTarget(tokenId) !== null;
}

// ── Amount ───────────────────────────────────────────────────────────────────

/**
 * Decimal text → base units, with string arithmetic only.
 *
 * Never through `Number`: NEAR has 24 decimals and a double carries about 16 significant digits,
 * so a float path signs a different yocto figure than the one on screen (D-303 measured 0.3 NEAR
 * becoming 299999999999999988897769). Excess fractional digits are truncated, never rounded up.
 *
 * Expects the field's canonical form (`sanitizeDecimalInput`: digits and one `.`). Returns null
 * for anything that is not a positive amount — empty, malformed, or zero — so a caller cannot
 * build a zero-value transaction by forgetting a check.
 */
export function parseAmountToBaseUnits(text: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!match) return null;
  const whole = match[1];
  const frac = match[2] ?? "";
  if (whole === "" && frac === "") return null;
  const digits = whole + frac.slice(0, decimals).padEnd(decimals, "0");
  const value = BigInt(digits === "" ? "0" : digits);
  return value > ZERO ? value : null;
}

/**
 * Base units → exact decimal text, `.` separator, no trailing zeros. The inverse of
 * `parseAmountToBaseUnits`, which is what makes "Max" fill the field with exactly the balance.
 */
export function formatBaseUnits(raw: bigint, decimals: number): string {
  if (raw < ZERO) throw new Error(`formatBaseUnits: negative amount ${raw}`);
  if (decimals === 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ── Available ────────────────────────────────────────────────────────────────

/**
 * What a wallet deposit may send, read before the click. Both kinds also carry the login's General
 * Balance of the token at that moment (`generalBalance`): the baseline that tells a deposit the
 * wallet reported as cancelled from one that actually landed (D-348, `recheckDeclinedDeposit`).
 */
export type WalletDepositBalance = (
  | {
      kind: "ft";
      /** The whole token balance: gas is paid in NEAR, never in the token. */
      available: bigint;
      /** The account's NEAR not pinned by its storage: what pays this deposit's gas (D-349). */
      nearFree: bigint;
    }
  | {
      kind: "native";
      /** The most this deposit may send: spendable native NEAR plus the wNEAR already held. */
      available: bigint;
      /** wNEAR already on `wrap.near`. Sent first; only the rest gets wrapped. */
      wrapped: bigint;
      /**
       * What `near_deposit` must carry on top of the NEAR it wraps to register the account on
       * `wrap.near` (the contract takes it out of the deposit). Zero when already registered.
       */
      registrationCost: bigint;
    }
) & {
  /** The login's General Balance of this token, in base units, when the balance was read. */
  generalBalance: bigint;
};

/** Liquid NEAR minus what the account's storage pins (floor 0). Staked NEAR is not counted. */
function freeNear(account: NearAccountState): bigint {
  const pinned = account.storageUsage * STORAGE_YOCTO_PER_BYTE;
  return account.amount > pinned ? account.amount - pinned : ZERO;
}

/**
 * Whether the wallet can pay the network for this deposit (D-349). A token needs
 * `FT_GAS_RESERVE_YOCTO` of free NEAR. The NEAR path answers yes: its `available` leaves
 * `NEAR_GAS_RESERVE_YOCTO` in the wallet whenever it wraps (80 Tgas ≈ 0.08 NEAR at the purchase
 * price). Known gap: a NEAR deposit paid entirely from wNEAR already held, from a wallet with less
 * than that free, is still offered — and the network refuses it before running, so nothing moves.
 */
export function hasGasForDeposit(balance: WalletDepositBalance): boolean {
  return balance.kind === "native" || balance.nearFree >= FT_GAS_RESERVE_YOCTO;
}

/**
 * The NEAR figure: `amount − storage − 0.1 reserve − registration` (floor 0), plus wNEAR.
 *
 * Departs from near.com, which subtracts only the reserve. An account's storage is staked out of
 * its liquid balance, so an account with a contract on it (or just many keys) can show more than
 * it can spend — near.com's "Max" would then sign a transfer the network refuses. Staked
 * (`locked`) NEAR is not counted toward the storage here, which can only under-report.
 *
 * The registration cost only ever applies alongside a wrap: an account not registered on
 * `wrap.near` holds no wNEAR, so every NEAR it deposits has to be wrapped first.
 */
export function nativeDepositBalance(input: {
  account: NearAccountState;
  wrapped: bigint;
  registrationCost: bigint;
  generalBalance: bigint;
}): Extract<WalletDepositBalance, { kind: "native" }> {
  const setAside =
    input.account.storageUsage * STORAGE_YOCTO_PER_BYTE + NEAR_GAS_RESERVE_YOCTO + input.registrationCost;
  const spendable = input.account.amount > setAside ? input.account.amount - setAside : ZERO;
  return {
    kind: "native",
    available: spendable + input.wrapped,
    wrapped: input.wrapped,
    registrationCost: input.registrationCost,
    generalBalance: input.generalBalance,
  };
}

/** The chain reads the available figure needs. Injected, so the math is testable offline. */
export type WalletDepositReads = {
  ftBalance: (contractId: string, accountId: string) => Promise<bigint>;
  nearAccount: (accountId: string) => Promise<NearAccountState>;
  /** NEP-145 `storage_balance_of`; null when the account is not registered. */
  storageBalanceOf: (contractId: string, accountId: string) => Promise<{ total: string } | null>;
  /** NEP-145 `storage_balance_bounds`. */
  storageBalanceBounds: (contractId: string) => Promise<{ min: string }>;
  /** The account's General Balance of one token on `intents.near`, by intents id. */
  generalBalance: (intentsTokenId: string, accountId: string) => Promise<bigint>;
};

export const defaultWalletDepositReads: WalletDepositReads = {
  // `viewCall`, not `fetchFtBalance`: that one reads a contract panic as a zero balance, which
  // here would become "You don't have X" instead of "could not read" — the made-up zero this
  // module refuses. The 12 in-scope tokens answer "0" for an account they never saw (measured).
  ftBalance: async (contractId, accountId) =>
    parseU128(
      await viewCall<unknown>(contractId, "ft_balance_of", { account_id: accountId }),
      `${contractId} ft_balance_of`,
    ),
  nearAccount: (accountId) => fetchNearAccountState(accountId, BROWSER_RPC_URL),
  storageBalanceOf: (contractId, accountId) =>
    viewCall<{ total: string } | null>(contractId, "storage_balance_of", { account_id: accountId }),
  storageBalanceBounds: (contractId) =>
    viewCall<{ min: string }>(contractId, "storage_balance_bounds"),
  // Fails closed on a malformed answer (`getIntentsBalances`): a made-up zero here would make a
  // deposit that landed look like one that never did.
  generalBalance: async (intentsTokenId, accountId) => (await getIntentsBalances(accountId, [intentsTokenId]))[0],
};

/** A U128 the chain sent as a decimal string. `BigInt("")` is 0, so the shape is checked first. */
function parseU128(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${label}: not a U128 string`);
  }
  return BigInt(value);
}

/**
 * Reads what `accountId` may deposit of `target`. Meant to run BEFORE the click — when the tab
 * opens — never inside it (Blink's 5 s activation window, memory `project-rpc-latency-popup-block`).
 *
 * 🔴 Fails CLOSED: any read that fails rejects the whole promise. The caller shows "could not
 * read your balance" and no button — never a zero, never a "Max" made up from a partial answer.
 */
export async function readWalletDepositBalance(
  target: WalletDepositTarget,
  accountId: string,
  reads: WalletDepositReads = defaultWalletDepositReads,
): Promise<WalletDepositBalance> {
  // The contract IS the intents id minus its prefix (`walletDepositTarget`), so this is the id the
  // deposit lands under.
  const intentsTokenId = `${NEP141_PREFIX}${target.contractId}`;
  if (target.kind === "ft") {
    const [available, account, generalBalance] = await Promise.all([
      reads.ftBalance(target.contractId, accountId),
      reads.nearAccount(accountId),
      reads.generalBalance(intentsTokenId, accountId),
    ]);
    return { kind: "ft", available, nearFree: freeNear(account), generalBalance };
  }

  const [account, wrapped, storage, generalBalance] = await Promise.all([
    reads.nearAccount(accountId),
    reads.ftBalance(target.contractId, accountId),
    reads.storageBalanceOf(target.contractId, accountId),
    reads.generalBalance(intentsTokenId, accountId),
  ]);
  const registrationCost =
    storage !== null
      ? ZERO
      : parseU128((await reads.storageBalanceBounds(target.contractId)).min, "storage_balance_bounds.min");

  return nativeDepositBalance({ account, wrapped, registrationCost, generalBalance });
}

// ── Holdings (D-445) ─────────────────────────────────────────────────────────

/** Every token this path serves, in registry order. */
const WALLET_DEPOSIT_TARGETS: WalletDepositTarget[] = tokenRegistry
  .map((token) => walletDepositTarget(token.id))
  .filter((target): target is WalletDepositTarget => target !== null);

/** One token the wallet could deposit, for the Receive step's "From your connected wallet" list. */
export type WalletHolding = { tokenId: string; available: bigint; decimals: number };

/**
 * What the wallet holds of every token this path serves, for the list on Receive's first step
 * (D-445). Display only: picking a row opens the amount step, which re-reads that one token with
 * `readWalletDepositBalance` — the figure the deposit is built on.
 *
 * NEAR is `nativeDepositBalance` with no registration cost (one read less per open): it can show up
 * to `storage_balance_bounds.min` more than the amount step offers, and only for an account not
 * yet registered on `wrap.near`.
 *
 * Fails closed per token: a token whose read fails is left out — offered in the list below with
 * the QR, never shown as a zero. Without the account read nothing is listed (NEAR needs it).
 */
export async function readWalletHoldings(
  accountId: string,
  reads: WalletDepositReads = defaultWalletDepositReads,
): Promise<WalletHolding[]> {
  const account = await reads.nearAccount(accountId);
  const settled = await Promise.allSettled(
    WALLET_DEPOSIT_TARGETS.map(async (target): Promise<WalletHolding> => {
      const balance = await reads.ftBalance(target.contractId, accountId);
      const available =
        target.kind === "native"
          ? nativeDepositBalance({ account, wrapped: balance, registrationCost: ZERO, generalBalance: ZERO }).available
          : balance;
      return { tokenId: target.tokenId, available, decimals: target.decimals };
    }),
  );
  return settled.flatMap((r) => (r.status === "fulfilled" && r.value.available > ZERO ? [r.value] : []));
}

// ── Transaction ──────────────────────────────────────────────────────────────

export type FunctionCallAction = {
  type: "FunctionCall";
  params: {
    methodName: string;
    args: Record<string, unknown>;
    gas: string;
    deposit: string;
  };
};

export type WalletDepositTransaction = {
  receiverId: string;
  actions: FunctionCallAction[];
};

/**
 * The one transaction a wallet deposit signs.
 *
 * NEP-141: `ft_transfer_call` on the token contract. NEAR: to `wrap.near`, a `near_deposit` that
 * wraps only what the wNEAR already held does not cover (plus the registration, when owed), then
 * the same `ft_transfer_call`. Both actions go in ONE receipt, so a failed `ft_transfer_call`
 * reverts the wrap with it. A refusal LATER, in `intents.near`'s `ft_on_transfer`, does not: the
 * wrap already committed, and the refund comes back as wNEAR — which the wallet balances count as
 * NEAR (CONTEXT.md, NEAR unified), so a retry can send it.
 *
 * `msg: ""` credits the signer, and nothing else may be put there: a `receiver_id` in the message
 * would send the deposit to another account's General Balance.
 *
 * Refuses, rather than builds, a transaction for zero, for more than the balance read, or with a
 * balance of the other kind — every one of those is a transaction the user would pay gas to have
 * reverted, or worse, one that signs a figure the screen never showed.
 */
export function buildWalletDepositTransaction(
  target: WalletDepositTarget,
  balance: WalletDepositBalance,
  amount: bigint,
): WalletDepositTransaction {
  if (amount <= ZERO) throw new Error("buildWalletDepositTransaction: amount must be positive");
  if (balance.kind !== target.kind) {
    throw new Error(`buildWalletDepositTransaction: a ${balance.kind} balance for a ${target.kind} token`);
  }
  if (amount > balance.available) throw new AmountExceedsBalanceError(amount, balance.available);

  const transfer: FunctionCallAction = {
    type: "FunctionCall",
    params: {
      methodName: "ft_transfer_call",
      args: { receiver_id: INTENTS_CONTRACT_ID, amount: amount.toString(), msg: "" },
      gas: FT_TRANSFER_CALL_GAS,
      deposit: FT_TRANSFER_CALL_DEPOSIT,
    },
  };

  if (balance.kind === "ft") return { receiverId: target.contractId, actions: [transfer] };

  const toWrap = amount > balance.wrapped ? amount - balance.wrapped : ZERO;
  const wrapDeposit = toWrap + balance.registrationCost;
  const actions: FunctionCallAction[] = [];
  if (wrapDeposit > ZERO) {
    actions.push({
      type: "FunctionCall",
      params: {
        methodName: "near_deposit",
        args: {},
        gas: NEAR_DEPOSIT_GAS,
        deposit: wrapDeposit.toString(),
      },
    });
  }
  actions.push(transfer);
  return { receiverId: target.contractId, actions };
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export type WalletDepositResult =
  /** The signer is the login and `intents.near` kept all of it. The only success. */
  | { kind: "credited"; amount: bigint; txHash: string | null }
  /** `intents.near` kept part; the rest went back to the wallet. */
  | { kind: "partial"; credited: bigint; txHash: string | null }
  /** `intents.near` refused it and the token contract sent it back. Nothing entered. */
  | { kind: "refunded"; txHash: string | null }
  /**
   * It landed, but in the General Balance of `signerId`, not the login's.
   *
   * 🔴 This is the branch a mismatch actually takes with the two wallets measured: Meteor and
   * MyNearWallet IGNORE `signerId` and sign as the account connected to IntentFolio in their own
   * storage (Meteor: `meteor-account-data`, read in its near-connect executor, s181). Nothing
   * before the send can tell which account that is — near-connect's own account list may name a
   * different one — so this verdict, read off `transaction.signer_id`, is the only protection.
   */
  | { kind: "wrong-signer"; signerId: string; credited: bigint; txHash: string | null }
  /**
   * The wallet signed as the login with a key of another account, and the network refused the
   * transaction before running it. Nothing moved and no gas was spent. Only a wallet that honours
   * `signerId` can produce it (Meteor and MyNearWallet do not — see `wrong-signer`).
   */
  | { kind: "other-account"; message: string }
  /**
   * The wallet could not send it, the network refused it, or its first receipt reverted — each
   * of which proves nothing moved. `cause`, when known, has its own next step.
   */
  | { kind: "failed"; message: string; cause?: WalletDepositFailureCause; txHash: string | null }
  /** The user rejected it in the wallet. Nothing was sent. */
  | { kind: "declined" }
  /**
   * The outcome does not say what happened (no final status, a value we cannot parse, no
   * signer). NOT a failure and NOT a success: `runWalletDeposit` re-reads the transaction by
   * hash, and never returns this kind.
   */
  | { kind: "unreadable"; txHash: string | null }
  /**
   * We do not know whether it landed: we stopped waiting for the wallet, the wallet threw
   * without saying the transaction never left, or the re-read found nothing. 🔴 NOT a failure —
   * the deposit may be in flight or already in the General Balance. Anything that presents this
   * as "it did not work" invites a second deposit (the D-311 rule, applied here).
   */
  | { kind: "unconfirmed"; message?: string };

export type WalletDepositFailureCause =
  /** The signing key cannot attach the 1 yocto: no retry fixes it, a full-access key does. */
  | "requires-full-access"
  /** The account cannot pay the gas (`NotEnoughBalance`): refused before running anything. */
  | "not-enough-balance"
  /** No wallet to ask: thrown before anything was sent (`WalletNotConnectedError`). */
  | "wallet-not-connected";

/**
 * Name of the error `sendTransactionAs` throws when there is no connected wallet to ask
 * (real-allocate-context.tsx). Matched by name, not `instanceof`, so this module does not import
 * the vault's context — the same convention `normalizeWalletError` uses for its chain errors.
 */
export const WALLET_NOT_CONNECTED_ERROR = "WalletNotConnectedError";

/**
 * Whether a failure message says the network refused the transaction because the key does not
 * belong to the signer — the wallet signed as the login with another account's key.
 *
 * 🔴 Unmeasured against a live wallet. The patterns cover nearcore's
 * `InvalidAccessKeyError::AccessKeyNotFound` as it serialises (`{"InvalidTxError":
 * {"InvalidAccessKeyError":{"AccessKeyNotFound":…}}}`) and as nearcore words it ("doesn't have
 * access key"), the old near-api-js template, and near-api-js 7.2.0's renderings ("Access key … does
 * not exist on account …" / "… at block height …" / "… while viewing"). A miss becomes
 * `unconfirmed`: a worse message, never a wrong on-chain action.
 */
function isOtherAccountFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("accesskeynotfound") ||
    m.includes("access key not found") ||
    m.includes("does not have access key") ||
    m.includes("doesn't have access key") ||
    (m.includes("access key") && m.includes("does not exist"))
  );
}

/**
 * The signing key is a FunctionCall key, which the protocol never lets attach a deposit — and
 * `ft_transfer_call` needs 1 yocto. nearcore checks in order (`verifier.rs`): more than one action
 * or a non-FunctionCall action ⇒ `RequiresFullAccess`; a deposit ⇒ `DepositWithFunctionCall`. So
 * the one-action transactions (every NEP-141 deposit, and NEAR fully covered by wNEAR) are refused
 * as `DepositWithFunctionCall`, and only the two-action NEAR one as `RequiresFullAccess`. Patterns
 * for both, in nearcore's and near-api-js 7's wording; unmeasured against a live wallet.
 */
function isRequiresFullAccessFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("requiresfullaccess") ||
    m.includes("requires full access") ||
    m.includes("requires a full access key") ||
    m.includes("full-access keys are required") ||
    m.includes("depositwithfunctioncall") ||
    m.includes("deposit is not allowed with function call") ||
    m.includes("not allowed with a function call access key") ||
    m.includes("deposit with a function call action is not allowed")
  );
}

/**
 * nearcore's `InvalidTxError::NotEnoughBalance` (the signer cannot cover gas + deposits) and
 * `LackBalanceForState`. Both are raised before the transaction runs. Unmeasured wording, like the
 * two above; a miss falls through to a plain `failed`.
 */
function isNotEnoughBalanceFailure(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("notenoughbalance") || m.includes("not enough balance") || m.includes("lackbalanceforstate");
}

function failureResult(message: string, txHash: string | null): WalletDepositResult {
  if (isRequiresFullAccessFailure(message)) {
    return { kind: "failed", message, cause: "requires-full-access", txHash };
  }
  if (isOtherAccountFailure(message)) return { kind: "other-account", message };
  if (isNotEnoughBalanceFailure(message)) {
    return { kind: "failed", message, cause: "not-enough-balance", txHash };
  }
  return { kind: "failed", message, txHash };
}

/** Whether any of those three texts is in the message: each one proves the network refused it. */
function isRefusedBeforeRunning(message: string): boolean {
  return isRequiresFullAccessFailure(message) || isOtherAccountFailure(message) || isNotEnoughBalanceFailure(message);
}

/**
 * Whether a top-level `Failure` proves nothing moved.
 *
 * Two shapes do: an `InvalidTxError` (the network refused the transaction; nothing ran), and a
 * failure in the FIRST receipt — the one the transaction became, whose actions (`near_deposit`,
 * `ft_transfer_call`) revert together. A failure further down the chain does not: the only later
 * receipt that can fail the whole transaction is `ft_resolve_transfer`, which runs AFTER
 * `intents.near` kept the tokens, so "it failed" there may be a deposit that landed.
 */
function failureIsBeforeTransfer(outcome: unknown): boolean {
  const o = (outcome ?? {}) as {
    status?: { Failure?: unknown };
    transaction_outcome?: { outcome?: { receipt_ids?: unknown } };
    receipts_outcome?: Array<{ id?: unknown; outcome?: { status?: unknown } }>;
  };
  const failure = o.status?.Failure;
  if (failure && typeof failure === "object" && "InvalidTxError" in failure) return true;
  const receiptIds = o.transaction_outcome?.outcome?.receipt_ids;
  const firstId = Array.isArray(receiptIds) ? receiptIds[0] : undefined;
  if (typeof firstId !== "string") return false;
  const first = o.receipts_outcome?.find((r) => r?.id === firstId)?.outcome?.status;
  return !!first && typeof first === "object" && "Failure" in first;
}

/** Decodes a `SuccessValue` holding a JSON U128 string. Null when it is anything else. */
function decodeU128SuccessValue(successValue: string): bigint | null {
  try {
    const parsed: unknown = JSON.parse(atob(successValue));
    return typeof parsed === "string" && /^\d+$/.test(parsed) ? BigInt(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * What a wallet deposit's final outcome says happened.
 *
 * The top-level `SuccessValue` of an `ft_transfer_call` transaction is what `ft_resolve_transfer`
 * returned: the amount the receiver KEPT (near.com's `checkNearTransactionValidity` compares it to
 * the amount sent). So "the transaction succeeded" is not the question — a refund also succeeds.
 * For the NEAR path the transaction has two actions; the value is the last one's, which is the
 * transfer (to be confirmed in P4's first real deposit).
 *
 * 🔴 Read the TOP-LEVEL status first, never `findExecutionFailure` first: when `intents.near`
 * refuses in `ft_on_transfer`, that sub-receipt fails while the transaction succeeds with a value
 * of 0. Reading the sub-receipt would call a clean refund a failure.
 *
 * Anything this cannot account for is `unreadable`, which means "read it again", not "done".
 */
export function classifyWalletDepositOutcome(input: {
  outcome: unknown;
  amount: bigint;
  loginAccountId: string;
}): WalletDepositResult {
  const txHash = extractTxHash(input.outcome);
  const o = (input.outcome ?? {}) as {
    status?: unknown;
    transaction?: { signer_id?: unknown };
  };
  const status = o.status;

  if (status && typeof status === "object" && "Failure" in status) {
    const message = findExecutionFailure(input.outcome) ?? "Transaction failed";
    if (isRefusedBeforeRunning(message) || failureIsBeforeTransfer(input.outcome)) {
      return failureResult(message, txHash);
    }
    return { kind: "unconfirmed", message };
  }

  const successValue =
    status && typeof status === "object" && "SuccessValue" in status
      ? (status as { SuccessValue?: unknown }).SuccessValue
      : undefined;
  if (typeof successValue !== "string") return { kind: "unreadable", txHash };

  const kept = decodeU128SuccessValue(successValue);
  // More than was sent cannot come out of `ft_resolve_transfer`: this is not the outcome we think.
  if (kept === null || kept > input.amount) return { kind: "unreadable", txHash };
  if (kept === ZERO) return { kind: "refunded", txHash };

  // Who got it. Without the signer we cannot say it was the login, so we do not say it.
  const signerId = o.transaction?.signer_id;
  if (typeof signerId !== "string" || signerId === "") return { kind: "unreadable", txHash };
  if (signerId !== input.loginAccountId) {
    return { kind: "wrong-signer", signerId, credited: kept, txHash };
  }

  return kept === input.amount
    ? { kind: "credited", amount: kept, txHash }
    : { kind: "partial", credited: kept, txHash };
}

/**
 * What a THROWN send says happened.
 *
 * Only some throws prove nothing moved: no wallet to ask (`WalletNotConnectedError`, thrown before
 * sending), the user declining, and the network's refusals before running anything (another
 * account's key, a FunctionCall key, not enough balance for gas). Every other throw is
 * `unconfirmed`, not `failed`: a wallet can broadcast the transaction and then throw while waiting
 * for its result (a timeout, an RPC hiccup), and "it failed" over a deposit that landed invites a
 * second one.
 *
 * The refusals are matched before the cancel keywords on purpose: `normalizeWalletError` reads
 * "reject" as the user declining, and a network refusal can be worded "Transaction rejected: …".
 */
export function classifyWalletDepositError(error: unknown): WalletDepositResult {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === WALLET_NOT_CONNECTED_ERROR) {
    return { kind: "failed", message, cause: "wallet-not-connected", txHash: null };
  }
  if (isRefusedBeforeRunning(message)) return failureResult(message, null);
  const n = normalizeWalletError(error);
  if (n.kind === "cancel") return { kind: "declined" };
  return { kind: "unconfirmed", message: n.message };
}

/** What the app credits to the login's General Balance when a wallet deposit lands. */
export type WalletDepositCredit = { tokenId: string; amount: bigint; txHash: string | null };

/**
 * The credit a verdict earns, or null. Only what `intents.near` KEPT for the LOGIN: the full
 * amount, or the part a `partial` kept. A `wrong-signer` deposit is real money in someone else's
 * General Balance — crediting it here would show the login a balance it does not have.
 */
export function walletDepositCredit(result: WalletDepositResult, tokenId: string): WalletDepositCredit | null {
  if (result.kind === "credited") return { tokenId, amount: result.amount, txHash: result.txHash };
  if (result.kind === "partial") return { tokenId, amount: result.credited, txHash: result.txHash };
  return null;
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Sends a transaction AS `signerId`.
 *
 * Must be near-connect's own `wallet.signAndSendTransaction`, NOT `useNearWallet()`'s: the hook
 * forwards only `{receiverId, actions}` (`near-connect-hooks` `useNearWallet.js:110-114`) and
 * drops `signerId` without an error. near-connect passes it through to the wallet.
 *
 * 🔴 Passing it is necessary, not sufficient: whether the WALLET honours it is the wallet's call.
 * Meteor and MyNearWallet ignore it and sign as the account connected to IntentFolio (their
 * near-connect executors, read s181). The verdict's `signer_id` check (`wrong-signer`) is what
 * catches a mismatch; this parameter only helps the wallets that do honour it.
 */
export type WalletDepositSender = (params: {
  signerId: string;
  receiverId: string;
  actions: FunctionCallAction[];
}) => Promise<unknown>;

/**
 * How long to wait on the wallet before giving up on the WAIT (never on the transaction). Same
 * figure and same reasoning as `REGISTER_SEND_TIMEOUT_MS`: the user is reading an approval
 * screen, and a wallet popup that was closed without an answer never settles at all.
 */
export const WALLET_DEPOSIT_SEND_TIMEOUT_MS = 120_000;

/**
 * Re-reads of a transaction whose outcome did not say what happened. `fetchTxOutcome` waits for
 * `EXECUTED_OPTIMISTIC`, so one read usually answers; the rest cover an RPC that lags the wallet.
 */
export const WALLET_DEPOSIT_REREAD_ATTEMPTS = 4;
export const WALLET_DEPOSIT_REREAD_INTERVAL_MS = 2_500;

/**
 * Re-reads of the wallet and the General Balance after the wallet reported a cancel (D-348):
 * 5 reads 2.5 s apart, ~10 s. Measured s191 with Meteor: approve and close the popup at once, and
 * the wallet says "cancelled" whether or not the transaction left. Once a transaction is on chain
 * its effect shows well inside the window (~0.55 s blocks, `final` ~3 blocks behind; cross-review
 * s197); a wallet that BROADCASTS after the window reads as `declined` until the background watch
 * below sees it land (D-378).
 */
export const DECLINE_RECHECK_ATTEMPTS = 5;
export const DECLINE_RECHECK_INTERVAL_MS = 2_500;

/**
 * D-378 / D-381 — the background watch after that recheck said `declined` or `unconfirmed`: 30
 * reads 10 s apart, ~5 min. A wallet can broadcast after the ~10 s window (D-378), and the network
 * can run the `wrap.near` → `intents.near` receipts minutes after the transaction is in: measured
 * s199 with Meteor, credited at +2 min 31 s, last refund at +4 min 5 s (D-381).
 */
export const LATE_DEPOSIT_WATCH_ATTEMPTS = 30;
export const LATE_DEPOSIT_WATCH_INTERVAL_MS = 10_000;

export type RunWalletDepositInput = {
  target: WalletDepositTarget;
  /** Read BEFORE the click (`readWalletDepositBalance`). Never re-read in here. */
  balance: WalletDepositBalance;
  amount: bigint;
  /** The login's NEAR account. Signs, and is who `intents.near` must credit. */
  loginAccountId: string;
  send: WalletDepositSender;
  /** Lets the user stop WAITING. A transaction the wallet already sent cannot be recalled. */
  signal?: AbortSignal;
  /** The wallet answered within the wait and the chain is being read: the UI's "Confirming…". */
  onWalletAnswered?: () => void;
  /**
   * Receives the verdict of a send that settles AFTER this function returned `unconfirmed`, so a
   * deposit approved at minute three is still credited and announced rather than lost to the UI.
   */
  onLateResult?: (result: WalletDepositResult) => void;
  /**
   * Whether this is still the latest deposit. The background watch (D-378 / D-381) stops when it
   * is not: a newer deposit's movement would read as this one's. Absent means always current.
   */
  isCurrent?: () => boolean;
  /** Injected for tests; default re-reads the transaction from the chain. */
  readTx?: (txHash: string, senderAccountId: string) => Promise<unknown>;
  /** Injected for tests; defaults to `readWalletDepositBalance` for the login (D-348 recheck). */
  readBalance?: () => Promise<WalletDepositBalance>;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  sendTimeoutMs?: number;
  rereadAttempts?: number;
  rereadIntervalMs?: number;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves when the signal aborts. Never rejects — the caller races it as a normal branch. */
function whenAborted(signal: AbortSignal | undefined): Promise<"stopped"> {
  if (!signal) return new Promise<"stopped">(() => {});
  if (signal.aborted) return Promise.resolve("stopped");
  return new Promise<"stopped">((resolve) => {
    signal.addEventListener("abort", () => resolve("stopped"), { once: true });
  });
}

type SendSettlement = { ok: true; outcome: unknown } | { ok: false; error: unknown };

/**
 * The whole deposit: build, send as the login, classify, re-read when the outcome is not enough.
 *
 * 🔴 NO NETWORK BEFORE THE SEND. Blink keeps a click's activation for 5 s, and a wallet popup
 * opened after it is blocked (memory `project-rpc-latency-popup-block`: 6.8 s of reads in the
 * handler killed the signing modal on 2026-07-28). Everything this needs — the balance, the
 * registration, the reserve — arrives already read in `balance`, and the transaction is built
 * synchronously, so the first `await` here is the wallet itself.
 *
 * Never throws and never returns `unreadable`.
 */
export async function runWalletDeposit(input: RunWalletDepositInput): Promise<WalletDepositResult> {
  const { loginAccountId, amount } = input;
  if (!loginAccountId) {
    return { kind: "failed", message: "No NEAR account to deposit from", txHash: null };
  }

  let tx: WalletDepositTransaction;
  try {
    tx = buildWalletDepositTransaction(input.target, input.balance, amount);
  } catch (e) {
    // Refused before the wallet was asked: nothing was signed.
    const message = e instanceof Error ? e.message : String(e);
    return { kind: "failed", message, txHash: null };
  }

  let sent: Promise<SendSettlement>;
  try {
    sent = input.send({ signerId: loginAccountId, receiverId: tx.receiverId, actions: tx.actions }).then(
      (outcome): SendSettlement => ({ ok: true, outcome }),
      (error): SendSettlement => ({ ok: false, error }),
    );
  } catch (error) {
    // A sender that throws synchronously never reached the wallet: nothing was sent.
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", message, txHash: null };
  }

  // A cancel after we stopped waiting changes nothing: the screen already says "unconfirmed",
  // and a cancel is no proof (D-348). No re-read either — its baseline is minutes old, and the
  // user may be on a newer deposit whose effect it would claim (cross-review s197).
  const finishLate = async (settlement: SendSettlement): Promise<WalletDepositResult | null> => {
    if (settlement.ok) return resolveOutcome(settlement.outcome, input);
    const verdict = classifyWalletDepositError(settlement.error);
    return verdict.kind === "declined" ? null : verdict;
  };

  const finish = async (settlement: SendSettlement): Promise<WalletDepositResult> => {
    if (!settlement.ok) {
      const verdict = classifyWalletDepositError(settlement.error);
      if (verdict.kind !== "declined" && verdict.kind !== "unconfirmed") return verdict;
      // A throw carries no hash, and neither a cancel (D-348) nor any other wallet error proves
      // what happened: Meteor's intermediate popup closed before signing rejects with "Wallet
      // closed", no cancel keyword (D-382). Read the chain before saying anything.
      input.onWalletAnswered?.();
      const rechecked = await recheckDeclinedDeposit(input);
      // D-378 / D-381: neither verdict is final if the deposit lands after the window.
      const late = input.onLateResult;
      if (late && (rechecked.kind === "declined" || rechecked.kind === "unconfirmed")) {
        void watchLateDeposit(input).then((r) => r && late(r), () => undefined);
      }
      return rechecked;
    }
    return resolveOutcome(settlement.outcome, input);
  };

  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    sent,
    whenAborted(input.signal),
    new Promise<"stopped">((resolve) => {
      sendTimer = setTimeout(() => resolve("stopped"), input.sendTimeoutMs ?? WALLET_DEPOSIT_SEND_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(sendTimer);

  if (first === "stopped") {
    const late = input.onLateResult;
    if (late) void sent.then(finishLate).then((r) => r && late(r), () => undefined);
    return { kind: "unconfirmed" };
  }
  if (first.ok) input.onWalletAnswered?.();
  return finish(first);
}

/** Classifies a wallet outcome, re-reading the transaction when the outcome alone cannot say. */
async function resolveOutcome(outcome: unknown, input: RunWalletDepositInput): Promise<WalletDepositResult> {
  const classify = (o: unknown) =>
    classifyWalletDepositOutcome({ outcome: o, amount: input.amount, loginAccountId: input.loginAccountId });

  const verdict = classify(outcome);
  logDepositTxHash(verdict);
  if (verdict.kind !== "unreadable") return verdict;
  const txHash = verdict.txHash;
  if (!txHash) return { kind: "unconfirmed", message: "The wallet returned no transaction hash" };

  const readTx = input.readTx ?? fetchTxOutcome;
  const sleep = input.sleep ?? realSleep;
  const attempts = input.rereadAttempts ?? WALLET_DEPOSIT_REREAD_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(input.rereadIntervalMs ?? WALLET_DEPOSIT_REREAD_INTERVAL_MS);
    try {
      const reread = classify(await readTx(txHash, input.loginAccountId));
      if (reread.kind !== "unreadable") return reread;
    } catch {
      // A read that fails is no answer; the next attempt asks again.
    }
  }
  return { kind: "unconfirmed", message: `Could not read transaction ${txHash}` };
}

/**
 * What a deposit the wallet reported as CANCELLED — or failed with no hash (D-382) — actually did
 * (D-348).
 *
 * Measured s191 with Meteor: approving and closing the popup at once makes the wallet throw a
 * cancel, and the transaction may have left or not — the same message both times. No hash comes
 * back, so the transaction cannot be read; what can be read is its effect, against the balance
 * read before the click:
 *
 *   - the wallet dropped by at least `amount` AND the General Balance rose by at least `amount` ⇒
 *     `credited`. Both, because each alone has another cause: a refund in flight lowers the wallet
 *     for a few blocks, and a bridge deposit arriving at the same time raises the General Balance.
 *     Only the login can move tokens out of the login's wallet, and `msg: ""` credits the sender,
 *     so both together are this deposit.
 *   - the last read shows neither — no wallet drop and no General Balance rise of `amount` ⇒
 *     `declined`. Both, because the baseline may be minutes old (read when the tab opened): money
 *     that reached the wallet since can hide the drop, and then the rise is what gives it away.
 *   - anything else — one side moved, or the last read failed ⇒ `unconfirmed`. Never `declined`
 *     without a read that shows nothing moved.
 *
 * Why the wallet drop is at least `amount` in both kinds: a token leaves exactly `amount`; for NEAR
 * `available` falls by `amount` plus gas, or to zero from a figure that was at least `amount`.
 *
 * What this cannot see (cross-review s197): a wallet that signs as ANOTHER account (Meteor ignores
 * `signerId`, see `wrong-signer`) moves that account's funds, so the login reads `declined`; and a
 * deposit of the same token the user sends elsewhere (another tab, another app) inside the window
 * reads as this one `credited`. Both need the user acting twice at once.
 */
export async function recheckDeclinedDeposit(input: RunWalletDepositInput): Promise<WalletDepositResult> {
  const { amount, balance: before } = input;
  const read = input.readBalance ?? (() => readWalletDepositBalance(input.target, input.loginAccountId));
  const sleep = input.sleep ?? realSleep;
  // What the LAST read showed: null when it failed.
  let moved: boolean | null = null;
  for (let i = 0; i < DECLINE_RECHECK_ATTEMPTS; i++) {
    if (i > 0) await sleep(DECLINE_RECHECK_INTERVAL_MS);
    try {
      const { dropped, rose } = depositEffect(before, await read(), amount);
      if (dropped && rose) {
        console.warn("[wallet-deposit] the wallet reported a cancel, but the deposit landed (D-348)");
        return { kind: "credited", amount, txHash: null };
      }
      moved = dropped || rose;
    } catch (e) {
      console.warn("[wallet-deposit] could not re-read after a cancel:", e);
      moved = null;
    }
  }
  if (moved === false) return { kind: "declined" };
  return {
    kind: "unconfirmed",
    message: moved ? "The wallet reported no transaction, but the balances moved" : "Could not re-read after the wallet error",
  };
}

/** The wallet drop and General Balance rise `recheckDeclinedDeposit` reads, against the click's baseline. */
function depositEffect(before: WalletDepositBalance, now: WalletDepositBalance, amount: bigint) {
  return {
    dropped: before.available - now.available >= amount,
    rose: now.generalBalance - before.generalBalance >= amount,
  };
}

/**
 * D-378 / D-381 — keeps reading after `recheckDeclinedDeposit` gave up, and returns `credited`
 * the first time both sides moved, or null when the watch ends without it. Same rule and same
 * baseline as the recheck; what it cannot see is listed there.
 *
 * It only ever upgrades: a verdict on screen turns into `credited`, never into `declined` — a
 * read showing nothing proves nothing about the next one. Waits before every read, the first
 * included, so the caller has shown the recheck's verdict before this can replace it.
 */
async function watchLateDeposit(input: RunWalletDepositInput): Promise<WalletDepositResult | null> {
  const { amount, balance: before } = input;
  const read = input.readBalance ?? (() => readWalletDepositBalance(input.target, input.loginAccountId));
  const sleep = input.sleep ?? realSleep;
  for (let i = 0; i < LATE_DEPOSIT_WATCH_ATTEMPTS; i++) {
    await sleep(LATE_DEPOSIT_WATCH_INTERVAL_MS);
    if (input.isCurrent && !input.isCurrent()) return null;
    try {
      const { dropped, rose } = depositEffect(before, await read(), amount);
      // Checked again after the read: a deposit started while it was in flight owns what it saw.
      if (input.isCurrent && !input.isCurrent()) return null;
      if (dropped && rose) {
        console.warn("[wallet-deposit] the deposit landed after the recheck window (D-378 / D-381)");
        return { kind: "credited", amount, txHash: null };
      }
    } catch {
      // A read that fails is no answer; the next one asks again.
    }
  }
  return null;
}

/** Logs the hash with its explorer link (D-R17): it is what P4 and a support ticket start from. */
function logDepositTxHash(result: WalletDepositResult): void {
  const txHash = "txHash" in result ? result.txHash : null;
  if (!txHash) return;
  console.log(`[wallet-deposit] tx ${txHash} — https://nearblocks.io/txns/${txHash}`);
}
