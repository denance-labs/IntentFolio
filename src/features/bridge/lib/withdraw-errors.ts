// Typed outcomes of the real withdrawal path (005.plan §8, Phase 5, block 5.2).
//
// A withdrawal is the only flow that moves money OUT of the system, and its failures are
// NOT interchangeable. Some leave the General Balance completely intact, one leaves it
// genuinely ambiguous, and one happens AFTER the funds have already left NEAR. The UI copy
// cannot re-derive which is which from a message string, and getting it backwards is the
// exact harm this path exists to avoid: telling someone their money is safe while it is in
// flight, or claiming a loss that never happened.
//
// So every error carries `fundsState`, and callers are expected to branch on THAT rather
// than on the class name. The class says what went wrong; `fundsState` says what the user's
// money is doing, which is the only part the copy must get right.
//
// They travel as exceptions, like the vault errors (vault-errors.ts), because every caller
// on this path treats "did not throw" as "the withdrawal is still progressing".

/** What the user's money is doing when the withdrawal did not complete. */
export type WithdrawFundsState =
  /** Nothing was accepted. The General Balance is intact and a retry is safe. */
  | "untouched"
  /** May or may not have been accepted. Never claim either way — re-check before retrying. */
  | "unknown"
  /** Settled on NEAR: the funds are already out of the General Balance. Not a loss. */
  | "left-balance";

export class WithdrawError extends Error {
  constructor(
    message: string,
    readonly fundsState: WithdrawFundsState,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "WithdrawError";
  }
}

// ⚠️ `WithdrawRouteUnsupportedError` USED TO LIVE HERE, and its removal is the headline of
// block 4.3.4. It was the "this route has no code" signal, and by 4.3.3 the only place left
// throwing it was the delivery wait, for `hot-omni`. Now that HOT has a delivery path all
// three `BridgeRoute` values are executable end to end, so the class had no throw site — and
// a taxonomy entry that says "some routes are not implemented" while every route is
// implemented is worse than no entry at all. If a fourth route ever appears, it needs its own
// error with its own `fundsState`, decided from where in the flow it stops, not this one
// brought back: this one claimed `untouched`, which stopped being true the moment the route
// it guarded could reach the wait only AFTER settlement.
//
// As of block 4.5 nothing on this path is unimplemented at all: `encodeHotReceiver`
// (hot-envelope.ts) covers every `hot-omni` chain the registry carries. What it still refuses,
// BEFORE anything is signed, is an address it cannot vouch for — a bad checksum, or a testnet
// address on a mainnet route.

/**
 * Why a NEAR destination cannot receive this token. Checked BEFORE signing, because the
 * `near-native` route deliberately leaves `storage_deposit` unset: covering an unregistered
 * receiver would spend the user's wNEAR **with no refund if the transfer still fails**
 * (contract-types: "the wNEAR will not be refunded in case of fail").
 *
 * `unverified` fails CLOSED on purpose. Blocking a legitimate withdrawal on an RPC flake is
 * an annoyance the user can retry away; signing one we could not verify is unrecoverable.
 */
export type WithdrawDestinationProblem = "missing-account" | "not-registered" | "unverified";

export class WithdrawDestinationUnusableError extends WithdrawError {
  constructor(
    readonly problem: WithdrawDestinationProblem,
    readonly destinationAddress: string,
    readonly tokenAccountId: string,
    cause?: unknown
  ) {
    super(describeDestinationProblem(problem, destinationAddress, tokenAccountId), "untouched", cause);
    this.name = "WithdrawDestinationUnusableError";
  }
}

function describeDestinationProblem(
  problem: WithdrawDestinationProblem,
  address: string,
  tokenAccountId: string
): string {
  switch (problem) {
    case "missing-account":
      return `The NEAR account "${address}" does not exist`;
    case "not-registered":
      return `The NEAR account "${address}" is not registered with ${tokenAccountId}, so the transfer would fail without a refund`;
    case "unverified":
      return `Could not verify that "${address}" can receive ${tokenAccountId}; not signing`;
  }
}

/**
 * The relay's own rejection codes, mirrored from `parseFailedPublishError.ts`
 * (@defuse-protocol/internal-utils 0.34.0). We publish through the low-level
 * `httpClient.publishIntent`, so this classification is ours to do — see `withdraw-submit.ts`.
 *
 * Attribution: see ATTRIBUTIONS.md #10.
 */
export type WithdrawPublishErrorCode =
  | "SIGNATURE_EXPIRED"
  | "INTERNAL_ERROR"
  | "SIGNATURE_INVALID"
  | "NONCE_USED"
  | "INSUFFICIENT_BALANCE"
  | "PUBLIC_KEY_NOT_EXIST"
  | "UNKNOWN_ERROR"
  | "INVALID_SALT";

/**
 * The relay refused the intent. Definitive and safe: a rejected intent never executes, so
 * the General Balance is untouched and the same amount can be re-signed.
 */
export class WithdrawRelayRejectedError extends WithdrawError {
  constructor(
    readonly code: WithdrawPublishErrorCode,
    readonly reason: string
  ) {
    super(`The relay rejected the withdrawal: ${reason} (${code})`, "untouched");
    this.name = "WithdrawRelayRejectedError";
  }
}

/**
 * The publish call did not produce a usable answer — it threw, or came back in a shape this
 * code refuses to interpret.
 *
 * `unknown` is the honest state, and the reason this class exists separately from a
 * rejection: the relay may well have accepted the intent before the connection died. The
 * mirror of upstream's `RelayPublishResultUnknownError`.
 */
export class WithdrawPublishUnknownError extends WithdrawError {
  constructor(reason: string, cause?: unknown) {
    super(`Could not confirm whether the withdrawal was published: ${reason}`, "unknown", cause);
    this.name = "WithdrawPublishUnknownError";
  }
}

/**
 * The relay reported the intent as invalid or failed. Like a rejection, this is a state the
 * Verifier reached WITHOUT executing, so the balance is intact.
 */
export class WithdrawSettlementFailedError extends WithdrawError {
  constructor(
    readonly intentHash: string,
    cause?: unknown
  ) {
    super(`The withdrawal intent ${intentHash} did not settle`, "untouched", cause);
    this.name = "WithdrawSettlementFailedError";
  }
}

/**
 * Published, but no settlement observed inside the budget (or the wait was interrupted).
 *
 * NOT a failure and must never be presented as one — the intent is with the relay and can
 * still settle. `intentHash` is the handle for re-checking, which is why it is carried
 * rather than folded into the message.
 */
export class WithdrawSettlementUnconfirmedError extends WithdrawError {
  constructor(
    readonly intentHash: string,
    reason: string,
    cause?: unknown
  ) {
    super(`Withdrawal ${intentHash} was published but not confirmed settled: ${reason}`, "unknown", cause);
    this.name = "WithdrawSettlementUnconfirmedError";
  }
}

/**
 * Settled on NEAR, but the bridge was not observed completing the delivery.
 *
 * The most dangerous one to word: the funds have LEFT the General Balance, so the copy can
 * neither promise arrival nor report a loss. This is the withdrawal twin of the Allocate
 * `pending-unconfirmed` state. `txHash` is what the operator follows on the explorer.
 */
export class WithdrawDeliveryUnconfirmedError extends WithdrawError {
  constructor(
    readonly txHash: string,
    readonly assetId: string,
    reason: string,
    cause?: unknown
  ) {
    super(
      `Withdrawal settled in ${txHash} but delivery was not confirmed: ${reason}. ` +
        `The funds have left the balance and may still arrive.`,
      "left-balance",
      cause
    );
    this.name = "WithdrawDeliveryUnconfirmedError";
  }
}

/**
 * The HOT bridge says it CANCELLED the delivery (008.plan block 4.3.4). The one
 * post-settlement outcome that is definite rather than merely unobserved.
 *
 * Still `left-balance`, and the distinction from `WithdrawDeliveryUnconfirmedError` is the
 * class name only — deliberately. `fundsState` answers "where is the money", and the answer
 * is the same: it left the General Balance, and what the bridge does with a cancelled
 * withdrawal is the bridge's business, not something this code observed. So the copy must
 * stay in the same amber register; what changes is that there is nothing left to wait for,
 * which is why this stops the poll instead of letting it run out its deadline.
 */
export class WithdrawDeliveryCancelledError extends WithdrawError {
  constructor(
    readonly txHash: string,
    readonly nonce: string
  ) {
    super(
      `The HOT bridge cancelled withdrawal ${nonce} from ${txHash}. The funds have left the ` +
        `balance and were not delivered — check the destination and the balance before retrying.`,
      "left-balance"
    );
    this.name = "WithdrawDeliveryCancelledError";
  }
}
