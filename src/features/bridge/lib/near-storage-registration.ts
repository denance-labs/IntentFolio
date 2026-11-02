// Registering the user's own NEAR account with a token before withdrawing it there (D-316).
//
// A `near-native` withdrawal to an account the token contract has never seen fails without a
// refund, which is why the destination pre-flight refuses it (withdraw-submit.ts) and why the
// intent leaves `storage_deposit` unset (withdraw-envelope.ts). The way out is the one every
// NEAR wallet takes: a NEP-145 `storage_deposit` on the token contract, signed and paid from the
// user's own NEAR wallet, BEFORE the withdrawal. One transaction, nothing from the General
// Balance.
//
// The wallet's answer is not the verdict. Meteor and MyNearWallet ignore `signerId`
// (near-wallet-deposit.ts, `wrong-signer`), and a wallet can throw after the transaction left.
// What decides it is the same read the pre-flight makes: whether the token now has a storage
// balance for the account. `account_id` travels in the arguments, so whichever account ends up
// signing, the registration lands on the destination.

import { viewCall } from "@/features/vault/lib/near-view";
import { normalizeWalletError } from "@/features/wallet/adapter/normalize-error";
import { WALLET_NOT_CONNECTED_ERROR, type FunctionCallAction } from "./near-wallet-deposit";

/** 30 Tgas: a `storage_deposit` writes one account entry. Unused gas is refunded. */
export const STORAGE_DEPOSIT_GAS = "30000000000000";

/**
 * The most a registration may cost before we refuse to ask for it: 0.01 NEAR. The standard
 * NEP-145 minimum is 0.00125 NEAR (Meta Pool's stNEAR among them). A token asking for more
 * than eight times that is not one we should be paying into on the user's behalf unseen.
 */
export const MAX_REGISTRATION_COST_YOCTO = BigInt("10000000000000000000000");

export type StorageRegistrationReads = {
  /** NEP-145 `storage_balance_bounds`. */
  storageBalanceBounds: (contractId: string) => Promise<{ min: string }>;
  /** NEP-145 `storage_balance_of`; null when the account is not registered. */
  storageBalanceOf: (contractId: string, accountId: string) => Promise<{ total: string } | null>;
};

export const defaultStorageRegistrationReads: StorageRegistrationReads = {
  storageBalanceBounds: (contractId) => viewCall<{ min: string }>(contractId, "storage_balance_bounds"),
  storageBalanceOf: (contractId, accountId) =>
    viewCall<{ total: string } | null>(contractId, "storage_balance_of", { account_id: accountId }),
};

/**
 * What registering costs on this token, in yoctoNEAR. Read BEFORE the click that opens the
 * wallet — never inside it (Blink's 5 s activation window, D-R16).
 *
 * Throws on anything it cannot vouch for: a malformed answer, or a cost above
 * `MAX_REGISTRATION_COST_YOCTO`. The caller then shows no button.
 */
export async function readRegistrationCost(
  tokenAccountId: string,
  reads: StorageRegistrationReads = defaultStorageRegistrationReads
): Promise<bigint> {
  const { min } = await reads.storageBalanceBounds(tokenAccountId);
  if (typeof min !== "string" || !/^\d+$/.test(min)) {
    throw new Error(`${tokenAccountId} storage_balance_bounds.min: not a U128 string`);
  }
  const cost = BigInt(min);
  // Zero is not "free": the build refuses it, so a button offered on it could never sign.
  if (cost === BigInt(0)) throw new Error(`${tokenAccountId} storage_balance_bounds.min is 0`);
  if (cost > MAX_REGISTRATION_COST_YOCTO) {
    throw new Error(`${tokenAccountId} asks ${cost} yocto to register; refusing above the cap`);
  }
  return cost;
}

/**
 * The one transaction a registration signs. `registration_only: true` makes the contract refund
 * anything above its minimum, and refund all of it when the account is already registered — so
 * a stale cost or a double click can overpay nothing.
 */
export function buildStorageDepositTransaction(
  tokenAccountId: string,
  accountId: string,
  cost: bigint
): { receiverId: string; actions: FunctionCallAction[] } {
  if (cost <= BigInt(0)) throw new Error("buildStorageDepositTransaction: cost must be positive");
  return {
    receiverId: tokenAccountId,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "storage_deposit",
          args: { account_id: accountId, registration_only: true },
          gas: STORAGE_DEPOSIT_GAS,
          deposit: cost.toString(),
        },
      },
    ],
  };
}

export type StorageRegistrationResult =
  /** The token now holds a storage balance for the account. The withdrawal can go ahead. */
  | { kind: "registered" }
  /** The user rejected it in the wallet, and the account is still not registered. */
  | { kind: "declined" }
  /** No wallet to ask (D-374): refused before anything was sent, so nothing to read either. */
  | { kind: "wallet-not-connected" }
  /**
   * Not registered as far as we can see. The transaction may have failed, or may land a moment
   * later — never presented as a certain failure, since the deposit may already be spent.
   */
  | { kind: "not-confirmed" };

/** How many times, and how far apart, the registration is re-read after the wallet answers. */
export const REGISTRATION_CHECK_ATTEMPTS = 4;
export const REGISTRATION_CHECK_INTERVAL_MS = 1_500;

/**
 * Asks the wallet to register `accountId` with the token, then reads whether it did.
 *
 * The read runs whatever the wallet said, including when it threw: a cancel is only reported as
 * one if the account is still unregistered afterwards. The reads are `final`, a couple of blocks
 * behind what the wallet waited for, hence the retries.
 */
export async function registerNearDestination(p: {
  send: (tx: { signerId: string; receiverId: string; actions: unknown[] }) => Promise<unknown>;
  tokenAccountId: string;
  accountId: string;
  cost: bigint;
  reads?: StorageRegistrationReads;
  wait?: (ms: number) => Promise<void>;
}): Promise<StorageRegistrationResult> {
  const reads = p.reads ?? defaultStorageRegistrationReads;
  const wait = p.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let declined = false;
  try {
    await p.send({
      signerId: p.accountId,
      ...buildStorageDepositTransaction(p.tokenAccountId, p.accountId, p.cost),
    });
  } catch (e) {
    if (e instanceof Error && e.name === WALLET_NOT_CONNECTED_ERROR) return { kind: "wallet-not-connected" };
    console.warn("[register] the wallet did not confirm the storage deposit:", e);
    declined = normalizeWalletError(e).kind === "cancel";
  }

  // Every attempt, a cancel included: Meteor reports one when the popup is closed after
  // approving, and the transaction still lands (D-348). One read, `final` and a couple of blocks
  // behind, would call that registration declined.
  for (let i = 0; i < REGISTRATION_CHECK_ATTEMPTS; i++) {
    if (i > 0) await wait(REGISTRATION_CHECK_INTERVAL_MS);
    try {
      if ((await reads.storageBalanceOf(p.tokenAccountId, p.accountId)) != null) {
        return { kind: "registered" };
      }
    } catch (e) {
      console.warn("[register] could not read the registration:", e);
    }
  }
  return declined ? { kind: "declined" } : { kind: "not-confirmed" };
}
