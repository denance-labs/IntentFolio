import type { ChainKind, Signature } from "@/features/intents-account/mock-contract/types";
import type { NearKeyVerification } from "./lib/near-key-verification";

export type { ChainKind } from "@/features/intents-account/mock-contract/types";

export type LoginWalletStatus = "idle" | "connecting" | "connected" | "error";

export type LoginWalletConnection = {
  chainKind: ChainKind;
  /** accountId (NEAR) / 0x address (EVM) / base58 pubkey (Solana) / G… address (Stellar) / T… address (Tron) / hex pubkey 64-chars (TON — not the EQ user address) */
  address: string;
};

export type LoginWalletState =
  | { status: "idle";       connection: null;                  error: null }
  | { status: "connecting"; connection: null;                  error: null }
  | { status: "connected";  connection: LoginWalletConnection; error: null }
  | { status: "error";      connection: null;                  error: string };

/**
 * D-445 part 2: a transaction for the EVM wallet to send — a deposit, built by
 * `evm-wallet-deposit.ts`. `chainId` is the EVM chain id (1, 42161, 8453), not the bridge's
 * `eth:1` form.
 */
export type EvmTransactionRequest = {
  chainId: number;
  to: `0x${string}`;
  value: bigint;
  data?: `0x${string}`;
  /** The gas limit, when the sender knows it; absent, the wallet estimates (and pads) its own. */
  gas?: bigint;
};

export type LoginWalletAdapter = {
  chainKind: ChainKind;
  state: LoginWalletState;
  /** Opens the wallet modal / prompt. */
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Signs a human-readable message (D-051) and returns the native-scheme Signature.
   * If identity is restored but the wallet is not `connected` (D-131), implementations
   * must call connect() first, then sign.
   */
  signMessage: (message: string) => Promise<Signature>;
  clearError: () => void;
  /**
   * D-545 — true once the wallet's silent restore on mount has run to an answer. An adapter that
   * is settled and still `idle` is saying "no live session is coming", so a restored identity can
   * stop waiting for one (it connects on demand at sign time, D-131). Optional: a family that
   * cannot tell leaves it undefined and the session waits out `RESTORE_TIMEOUT_MS` as before.
   */
  restoreSettled?: boolean;
  /**
   * D-280 B2 — whether the key this wallet signs with is authorised on `intents.near`.
   *
   * Optional because only the NEAR family can ever answer anything but `not-required`: the
   * other five derive their intents id from the address itself, so the contract
   * authenticates them alone. A family that leaves this undefined is saying "this gate does
   * not apply to me", which is why consumers must read `undefined` as `not-required` and
   * never as "not verified yet".
   */
  keyVerification?: NearKeyVerification;
  /**
   * Runs that gate: one NEP-413 prompt, then one chain read. NEAR only.
   *
   * 🔴 RETURNS the outcome as well as publishing it (B4). A caller that only reacted to the
   * state update could not act on the answer in the same click — React has not re-rendered
   * yet — and the money door needs exactly that: verify, then continue if it came back
   * clean. Families that do not implement it are `not-required`, so the default must be that.
   */
  verifyKey?: () => Promise<NearKeyVerification>;
  /**
   * D-280 B3 — sends `add_public_key` for the key the gate SAW SIGN, then re-reads the chain.
   *
   * Takes no arguments on purpose: the (account, key) pair is read off the adapter's own
   * verification state, so no caller can hand it a key that was never observed signing.
   * A no-op from any state that has no such pair.
   */
  registerKey?: () => Promise<void>;
  /** Stops WAITING on a registration. Cannot recall a transaction already sent. */
  cancelRegistration?: () => void;
  /**
   * D-445 part 2 — EVM only: asks the wallet to switch to `tx.chainId` if it is on another
   * network, then to send `tx`. Resolves with the hash once the wallet broadcast it; rejects when
   * the user declines, the switch fails, or the wallet errs. Families that cannot send leave it
   * undefined, and the deposit tab is not offered to them.
   */
  sendEvmTransaction?: (tx: EvmTransactionRequest) => Promise<`0x${string}`>;
};
