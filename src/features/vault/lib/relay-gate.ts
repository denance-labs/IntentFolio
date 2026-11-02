// What the relayer checks before it pays the gas (017-2, D-365). SERVER ONLY.
//
// The relay used to be gated by a shared secret the tester pasted into the console. A secret
// every browser holds is a public one, so the gate moved to the envelope itself: the relay only
// pays for what is signed by the account it names AND would pass on-chain. Nothing here decides
// whether funds move — the contracts do — it decides whether the relayer's gas is spent on it.
//
// Two destinations, two ways to know "would pass":
//   - the Verifier has a free dry run, `simulate_intents`: signature, key registry, nonce, salt,
//     deadline and balances in one view. What it cannot judge is WHAT is being paid for — an
//     envelope with no intents passes (measured s194), and it ignores gas, so an `auth_call`
//     asking for more gas than the call carries simulates fine and reverts on-chain every time
//     (cross-review s194). So the relay only pays for the exact Allocate the app builds
//     (`buildAllocateSignRequest`): `[transfer → vault, auth_call → vault]`, no other field, and
//     an `auth_call` msg whose allocations are exactly the transferred tokens;
//   - the vault has no dry run, so the commit is checked here, step by step, in the vault's own
//     order: signature (multi-payload-verify.ts), `verifying_contract`, V1 nonce deadline, the
//     key belongs to the signer, the signer owns the portfolio, and the nonce is not burnt yet
//     (a landed commit is public, and anyone could replay it at the relay's expense).
//
// The key check is STRICTER than the vault for named accounts on purpose. The vault binds only
// implicit accounts and accepts any key for a named one (a griefing residual it tolerates,
// H8-KICKOFF §11.4); the relay also asks the Verifier's key registry (`has_public_key`), the
// same thing the NEAR login already requires (D-280). The relay will not pay for that residual.
//
// "Would pass" is still more than the relay pays for (D-371). A Setup pays for the storage it
// takes (D-528: its Storage Cost, a third transfer), but what joins a portfolio later is still
// paid by the vault's reserve, and the vault's own caps (32 tokens, 128-byte ids and names)
// leave room for far more than the app builds. So the relay pays only for what the app itself
// would send: tokens the app knows, a name it allows, the signer's own login wallet, the
// deadline it signs, a Setup carrying its Storage Cost, no composition growing past the app's
// 10 tokens, no Setup past the app's cap of portfolios per account. Only tokens coming IN are
// checked — an old portfolio keeps retargeting, removing and withdrawing whatever it holds.
// None of this stops the same envelope sent straight to `intents.near`; only the contract can.
//
// Two ways to refuse, and the client reads them differently (both mean nothing was sent):
//   - `would-fail`: the chain would reject it, or it is not the app's shape (D-371). Signing
//     again does not help;
//   - `check-failed`: no node answered the check. Signing again may.
//
// Attribution: see ATTRIBUTIONS.md #8 (the vault's commit check order and signer bind).

import { PORTFOLIO_NAME_MAX_LENGTH } from "@/features/dashboard-shell/lib/portfolio-validation";
import { walletMatchesAccount } from "@/features/login-wallet/lib/identity";
import { toIntentsTokenId } from "@/features/market/lib/intents-token-id";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import { INTENTS_CONTRACT_ID, VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import {
  APP_MAX_PORTFOLIOS_PER_ACCOUNT,
  APP_MAX_TOKENS_PER_PORTFOLIO,
  growsPastAppTokenCap,
  MAX_COMPOSITION_CHANGES_PER_COMMIT,
  MAX_TOKEN_ID_LEN,
  TARGET_SUM_BPS,
  TOLERANCE_MAX_BPS,
  TOLERANCE_MIN_BPS,
} from "./change-set-preflight";
import {
  extractDefuseEnvelope,
  formatSignerKey,
  implicitAccountId,
  isImplicitAccountId,
  verifyMultiPayload,
} from "./multi-payload-verify";
import type { RelayViewResult } from "./relay-rpc-provider";
import type { RelayTarget } from "./relay-types";
import { STORAGE_COST_MEMO, STORAGE_COST_RECEIVER } from "./storage-cost";
import { AUTH_CALL_TTL_SECS, decodeV1Nonce } from "./vault-envelope";
import type { VaultChainKind } from "./vault-payloads";

export type RelayGateVerdict =
  | {
      ok: true;
      signerId: string;
      /** `signer:nonce`: one signed operation. The relay sends each at most once (relay-service.ts). */
      replayKey: string;
    }
  | { ok: false; code: "would-fail" | "check-failed"; reason: string };

export type RelayGate = (input: { target: RelayTarget; payload: unknown }) => Promise<RelayGateVerdict>;

export type RelayView = (
  contractId: string,
  methodName: string,
  args: Record<string, unknown>
) => Promise<RelayViewResult>;

/** A commit whose nonce expires sooner than this is not worth the gas: it may land expired. */
export const COMMIT_DEADLINE_MARGIN_SECS = 30;
/** The vault refuses a nonce deadline further ahead (`MAX_COMMIT_DEADLINE_SECS`). */
export const COMMIT_DEADLINE_CAP_SECS = 24 * 3600;

const wouldFail = (reason: string): RelayGateVerdict => ({ ok: false, code: "would-fail", reason });
const checkFailed = (reason: string): RelayGateVerdict => ({ ok: false, code: "check-failed", reason });
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

/**
 * Whether `text` is exactly what `JSON.stringify` makes of its own parse (D-538). The relay reads
 * signed JSON with `JSON.parse`, which keeps the LAST of two equal keys; the contracts read it
 * with serde, which refuses the duplicate. Text the gate and the chain would read differently is
 * not something the app builds: its builders emit `JSON.stringify` output, which always
 * round-trips. Whitespace other than the builders' is refused with it — nothing the app signs.
 * A lone surrogate ("\ud83d") round-trips too, but serde refuses it in a `String`: refused here.
 */
function isCanonicalJson(text: string, indent?: number): boolean {
  try {
    let wellFormed = true;
    const parsed: unknown = JSON.parse(text, (key, value: unknown) => {
      if (!key.isWellFormed() || (typeof value === "string" && !value.isWellFormed())) wellFormed = false;
      return value;
    });
    return wellFormed && JSON.stringify(parsed, null, indent) === text;
  } catch {
    return false;
  }
}

/**
 * Why an envelope's signed JSON is not in the form the app signs it, or null: compact for
 * NEP-413 (`JSON.stringify(inner)`, vault-envelope.ts), two spaces for every other family
 * (`buildErc191Payload`; TON signs that same text as `payload.text`, checked in vault-signer.ts).
 */
function canonicalEnvelopeProblem(mp: unknown): string | null {
  if (!isObject(mp)) return "unreadable envelope";
  const inner = mp.payload;
  const [text, indent] =
    mp.standard === "nep413"
      ? [isObject(inner) ? inner.message : undefined, undefined]
      : mp.standard === "ton_connect"
        ? [isObject(inner) ? inner.text : undefined, 2]
        : [inner, 2];
  return typeof text === "string" && isCanonicalJson(text, indent)
    ? null
    : "the signed envelope is not the JSON the app builds (a duplicate key, a broken character, or reformatted)";
}

/**
 * The most `min_gas` the relay pays for: the Verifier reserves it out of the gas the relay
 * attaches (RELAY_GAS = 300 TGas), and asking for more than is left after `execute_intents`'
 * own work makes the call revert every time — a revert the simulation does not see, since it
 * ignores gas. 100 TGas covers the app's 65 (AUTH_CALL_MIN_GAS) with room and stays far below
 * that point.
 */
export const RELAY_MAX_AUTH_CALL_MIN_GAS = BigInt(100) * BigInt(10) ** BigInt(12);

/**
 * `min_gas` as the app sends it (017-9a, D-302 m): absent — a tab still running the bundle from
 * before it, which passes today on the leftover gas — or a decimal string of gas units in
 * `(0, RELAY_MAX_AUTH_CALL_MIN_GAS]`. `NearGas` also parses a JSON number; the app never sends
 * one, so the relay does not pay for one.
 */
function isAcceptableMinGas(authCall: Record<string, unknown>): boolean {
  if (!("min_gas" in authCall)) return true;
  const value = authCall.min_gas;
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) return false;
  return BigInt(value) <= RELAY_MAX_AUTH_CALL_MIN_GAS;
}

/**
 * Exactly the Allocate the app builds (`buildAllocateSignRequest`): one transfer, one auth call,
 * both to the vault, with no field the app does not set — `attached_deposit`, `memo`, or the
 * transfer's flattened notification (`msg`, `min_gas`, `state_init`) would each let an envelope
 * pass the simulation and still revert or cost more on-chain, and so would a `min_gas` above
 * the cap (`isAcceptableMinGas`). The `msg` must be a Setup or AllocateInto whose allocations
 * are exactly the transferred tokens (the app builds both from one list, `allocate-submit.ts`);
 * a garbage msg is an orphan the relay would be paying to create.
 *
 * A Setup also carries its Storage Cost, last (D-528): without it the relay does not pay. Its
 * PRESENCE is checked, not its amount (operator, 2026-10-26: a modified client can pay one base
 * unit — cents per portfolio, bounded by the caps). An AllocateInto never carries one.
 */
export function isAllocateIntoVault(message: Record<string, unknown>, vaultId: string): boolean {
  const intents = message.intents;
  if (!Array.isArray(intents) || (intents.length !== 2 && intents.length !== 3)) return false;
  const [transfer, authCall, storage] = intents;
  if (!isObject(transfer) || !hasExactKeys(transfer, ["intent", "receiver_id", "tokens"])) return false;
  if (transfer.intent !== "transfer" || transfer.receiver_id !== vaultId || !isObject(transfer.tokens)) return false;
  if (!isObject(authCall)) return false;
  const authCallKeys = "min_gas" in authCall ? ["intent", "contract_id", "msg", "min_gas"] : ["intent", "contract_id", "msg"];
  if (!hasExactKeys(authCall, authCallKeys) || !isAcceptableMinGas(authCall)) return false;
  if (authCall.intent !== "auth_call" || authCall.contract_id !== vaultId) return false;
  const op = allocateOpMatchingTransfer(authCall.msg, transfer.tokens);
  if (op === "setup") return intents.length === 3 && isStorageCostTransfer(storage, transfer.tokens);
  return op === "allocate_into" && intents.length === 2;
}

/** The msg's op when its allocations are exactly the transferred tokens, else null. */
function allocateOpMatchingTransfer(msg: unknown, tokens: Record<string, unknown>): "setup" | "allocate_into" | null {
  if (typeof msg !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(msg);
  } catch {
    return null;
  }
  if (!isObject(parsed) || !isObject(parsed.op)) return null;
  const ops = Object.keys(parsed.op);
  if (ops.length !== 1 || (ops[0] !== "setup" && ops[0] !== "allocate_into")) return null;
  const body = parsed.op[ops[0]];
  if (!isObject(body) || !Array.isArray(body.allocations)) return null;

  const legs = body.allocations;
  const seen = new Set<string>();
  for (const leg of legs) {
    if (!Array.isArray(leg) || leg.length !== 2) return null;
    const [tokenId, amount] = leg;
    if (typeof tokenId !== "string" || typeof amount !== "string" || !/^[1-9]\d*$/.test(amount)) return null;
    if (seen.has(tokenId) || tokens[tokenId] !== amount) return null;
    seen.add(tokenId);
  }
  return seen.size > 0 && seen.size === Object.keys(tokens).length ? ops[0] : null;
}

/**
 * The Setup's Storage Cost as the app builds it (D-528): a plain transfer to the ops account
 * with the fixed memo, in ONE token the Setup also funds, a positive amount. No `msg`: it would
 * call `mt_on_transfer` on an account without a contract, fail, refund — the cost unpaid and
 * the receipts on the relay.
 */
function isStorageCostTransfer(intent: unknown, vaultTokens: Record<string, unknown>): boolean {
  if (!isObject(intent) || !hasExactKeys(intent, ["intent", "receiver_id", "tokens", "memo"])) return false;
  if (intent.intent !== "transfer" || intent.receiver_id !== STORAGE_COST_RECEIVER || intent.memo !== STORAGE_COST_MEMO) {
    return false;
  }
  if (!isObject(intent.tokens)) return false;
  const entries = Object.entries(intent.tokens);
  if (entries.length !== 1) return false;
  const [tokenId, amount] = entries[0];
  return (
    Object.prototype.hasOwnProperty.call(vaultTokens, tokenId) && typeof amount === "string" && /^[1-9]\d*$/.test(amount)
  );
}

/**
 * The tokens the app knows: every registry row, in the ids the contracts read (NEAR is
 * `nep141:wrap.near` on the wire, `toIntentsTokenId`). Not the composer's narrower list: the
 * General Balance is read over the whole registry (`use-intents-balances.ts`), the creation
 * modal funds a Setup with any of it worth $1, inside the composition or not
 * (`preset-review-modal.tsx`), and the editor can promote a held token to a target (cross-review
 * s266). What this stops is a token the app has never heard of.
 */
const APP_TOKEN_IDS: ReadonlySet<string> = new Set(tokenRegistry.map((t) => toIntentsTokenId(t.id)));

/** The ids of a token list as the app sends it, or null if it is not one. */
function tokenIdsOf(rows: unknown, idOf: (row: unknown) => unknown): string[] | null {
  if (!Array.isArray(rows)) return null;
  const ids = rows.map(idOf);
  return ids.every((id): id is string => typeof id === "string") ? ids : null;
}
/** A Setup's composition holds objects; a change set and every leg list, tuples. */
const objectTokenId = (row: unknown) => (isObject(row) ? row.token_id : undefined);
const tupleTokenId = (row: unknown) => (Array.isArray(row) ? row[0] : undefined);

/** Why a list of tokens coming IN is not one the app sends, or null (D-371). */
function offerProblem(ids: string[] | null): string | null {
  if (!ids) return "a token list the app does not build";
  const foreign = ids.find((id) => !APP_TOKEN_IDS.has(id));
  return foreign === undefined ? null : `${foreign} is not a token the app knows`;
}

/** Why a Setup's composition is past the app's cap (D-528), or null. Malformed is the vault's to refuse. */
function compositionCapProblem(composition: unknown): string | null {
  return Array.isArray(composition) && growsPastAppTokenCap(0, composition.length)
    ? `a composition of ${composition.length} tokens (the app's cap is ${APP_MAX_TOKENS_PER_PORTFOLIO})`
    : null;
}

/** Why a portfolio name is not one the app signs (trimmed, at most 25 UTF-16 units), or null. */
function nameProblem(name: unknown): string | null {
  return typeof name === "string" && name.length <= PORTFOLIO_NAME_MAX_LENGTH
    ? null
    : `not a portfolio name the app allows (at most ${PORTFOLIO_NAME_MAX_LENGTH} characters)`;
}

/** The `auth_call` msg of an Allocate that `isAllocateIntoVault` accepted: as signed, its deadline, nonce, op and body. */
function allocateMsg(message: Record<string, unknown>) {
  const authCall = (message.intents as Record<string, unknown>[])[1];
  const raw = authCall.msg as string;
  const msg = JSON.parse(raw) as { deadline: unknown; nonce: unknown; op: Record<string, Record<string, unknown>> };
  const [op, body] = Object.entries(msg.op)[0];
  return { raw, deadline: msg.deadline, nonce: msg.nonce, op, body };
}

const isUint = (value: unknown, max: number) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
const U8_MAX = 0xff;
const U16_MAX = 0xffff;
/** `Vec<(TokenId, u16, u16)>`: a change set's `target_changes` and `token_additions`. */
const isChangeRows = (rows: unknown) =>
  Array.isArray(rows) &&
  rows.every((r) => Array.isArray(r) && r.length === 3 && typeof r[0] === "string" && isUint(r[1], U16_MAX) && isUint(r[2], U16_MAX));

/**
 * Why the msg would not deserialize as the vault's `AuthCallMsg` (types.rs), or null (D-542):
 * the fields no other check here reads as their type — the `nonce` (`[u8; 32]`), a Setup's
 * `target_bps`/`tolerance_bps` (`u16`), and an AllocateInto's `portfolio_id` and change lists.
 * Only the types, not the composition rules the vault checks after. Unknown keys pass: the
 * vault's serde ignores them (no `deny_unknown_fields`).
 */
function msgTypeProblem(nonce: unknown, op: string, body: Record<string, unknown>): string | null {
  const ok =
    Array.isArray(nonce) &&
    nonce.length === 32 &&
    nonce.every((b) => isUint(b, U8_MAX)) &&
    (op === "setup"
      ? Array.isArray(body.composition) &&
        body.composition.every((c) => isObject(c) && isUint(c.target_bps, U16_MAX) && isUint(c.tolerance_bps, U16_MAX))
      : typeof body.portfolio_id === "string" &&
        isChangeRows(body.target_changes) &&
        isChangeRows(body.token_additions) &&
        Array.isArray(body.token_removals) &&
        body.token_removals.every((t) => typeof t === "string"));
  return ok ? null : "the auth_call msg does not have the types the vault reads";
}

/**
 * Why a msg whose types passed has a composition `on_auth` refuses (composition.rs), or null
 * (D-542). A Setup gets all of `validate_composition`: per row `target_bps ≤ 10000` and the
 * `check_tolerance` band ([200, 3000], or 0 only on a zero target), no repeated token, Σ = 10000.
 * An AllocateInto gets what `validate_change_set` checks without the stored composition: the
 * same per-row rules, and no token in two lists or twice in one; and `apply_allocate_into`'s
 * cap of 64 changes across the three lists. Every id fits `check_token_id`'s 128 UTF-8 bytes
 * (Rust's `str::len`, not characters). The folded result
 * (`resulting_composition`: presence, Σ) needs that composition, a view the gate does not make.
 */
function compositionRulesProblem(op: string, body: Record<string, unknown>): string | null {
  type Row = [string, number, number];
  const rows: Row[] =
    op === "setup"
      ? (body.composition as { token_id: string; target_bps: number; tolerance_bps: number }[]).map((c) => [
          c.token_id,
          c.target_bps,
          c.tolerance_bps,
        ])
      : [...(body.target_changes as Row[]), ...(body.token_additions as Row[])];
  const ids = [...rows.map(([id]) => id), ...(op === "setup" ? [] : (body.token_removals as string[]))];
  const ok =
    rows.every(
      ([, target, tolerance]) =>
        target <= TARGET_SUM_BPS &&
        (tolerance === 0 ? target === 0 : tolerance >= TOLERANCE_MIN_BPS && tolerance <= TOLERANCE_MAX_BPS)
    ) &&
    new Set(ids).size === ids.length &&
    ids.every((id) => Buffer.byteLength(id, "utf8") <= MAX_TOKEN_ID_LEN) &&
    (op === "setup"
      ? rows.reduce((sum, [, target]) => sum + target, 0) === TARGET_SUM_BPS
      : ids.length <= MAX_COMPOSITION_CHANGES_PER_COMMIT);
  return ok ? null : "a composition the vault refuses";
}

const LOGIN_CHAINS: readonly VaultChainKind[] = ["near", "evm", "solana", "ton", "stellar", "tron"];

/**
 * Why a Setup's `login_wallet` is not the signer's own wallet, or null. The vault binds it only
 * for NEAR and EVM: for the other four it cannot derive the account, accepts any wallet and
 * leaves the check to the frontend (`allocate.rs`, step 1.9). A Setup linking someone else's
 * wallet makes that person's first deposit an orphan (`E_WALLET_ALREADY_LINKED`), so the relay
 * runs the check the app runs before signing (`walletMatchesAccount`). An object with exactly
 * these two keys: serde would also take an array.
 */
function loginWalletProblem(loginWallet: unknown, signerId: string): string | null {
  if (!isObject(loginWallet) || !hasExactKeys(loginWallet, ["chain", "address"])) return "not the app's login wallet";
  const { chain, address } = loginWallet;
  if (typeof address !== "string" || !LOGIN_CHAINS.includes(chain as VaultChainKind)) return "not the app's login wallet";
  return walletMatchesAccount(address, chain as VaultChainKind, signerId)
    ? null
    : `the login wallet is not ${signerId}'s own`;
}

/** Room for a client clock that runs ahead of ours; the deadline only has to end, not be exact. */
export const ALLOCATE_DEADLINE_SLACK_SECS = 24 * 3600;

/**
 * Why the msg's deadline is not one the app signs (now + AUTH_CALL_TTL_SECS), or null. The vault
 * sets no upper bound, and the Allocate's idempotency seal can only be purged once it passes:
 * a far deadline is vault storage nobody can ever reclaim. One about to pass lands expired, an
 * orphan.
 */
function deadlineProblem(deadline: unknown, nowSecs: number): string | null {
  if (typeof deadline !== "number" || !Number.isSafeInteger(deadline)) return "not a deadline the app signs";
  if (deadline < nowSecs + COMMIT_DEADLINE_MARGIN_SECS) return "the allocation deadline expired";
  if (deadline > nowSecs + AUTH_CALL_TTL_SECS + ALLOCATE_DEADLINE_SLACK_SECS) return "the allocation deadline is too far ahead";
  return null;
}

/**
 * How many portfolios the account holds (`list_portfolios_for`; the vault drops deleted ones).
 * `null` when the view gives no list: as with the commit nonce, "cannot tell" lets the owner
 * through (operator, s266) — the vault's own cap still holds. A read, not a lock: Setups sent
 * together all see the same count, so past the app's cap it is the vault's cap and the
 * firewall's per-IP rule that bound them.
 */
async function viewPortfolioCount(view: RelayView, vaultId: string, accountId: string): Promise<number | null> {
  try {
    const result = await view(vaultId, "list_portfolios_for", { account_id: accountId });
    return result.kind === "value" && Array.isArray(result.value) ? result.value.length : null;
  } catch {
    return null;
  }
}

/**
 * Whether the vault already consumed this commit nonce (`is_commit_nonce_used`, 017-9a). `null`
 * on anything but a boolean: the check exists to stop replays of landed commits, so "cannot
 * tell" lets the request through rather than refusing the owner — the vault still rejects a
 * replay, at the relay's cost.
 */
export async function viewCommitNonceUsed(
  view: RelayView,
  vaultId: string,
  signerId: string,
  nonce: Uint8Array
): Promise<boolean | null> {
  try {
    const result = await view(vaultId, "is_commit_nonce_used", {
      account_id: signerId,
      nonce: Buffer.from(nonce).toString("base64"),
    });
    return result.kind === "value" && typeof result.value === "boolean" ? result.value : null;
  } catch {
    return null;
  }
}

export function createRelayGate({
  view,
  vaultId = VAULT_CONTRACT_ID,
  intentsId = INTENTS_CONTRACT_ID,
  now = () => Date.now(),
  log = (line) => console.warn(line),
}: {
  view: RelayView;
  vaultId?: string;
  intentsId?: string;
  now?: () => number;
  log?: (line: string) => void;
}): RelayGate {
  async function checkAllocate(payload: unknown): Promise<RelayGateVerdict> {
    const envelope = extractDefuseEnvelope(payload);
    if (!envelope) return wouldFail("unreadable envelope");
    if (envelope.verifyingContract !== intentsId) {
      return wouldFail(`signed for ${envelope.verifyingContract}, not ${intentsId}`);
    }
    const envelopeProblem = canonicalEnvelopeProblem(payload);
    if (envelopeProblem) return wouldFail(envelopeProblem);
    if (!hasExactKeys(envelope.message, ["intents"]) || !isAllocateIntoVault(envelope.message, vaultId)) {
      return wouldFail(`not the app's Allocate into ${vaultId}`);
    }
    const signerId = envelope.signerId;
    const { raw, deadline, nonce, op, body } = allocateMsg(envelope.message);
    // The msg is not read by the simulation: a duplicate key there passes it, settles the
    // transfer and fails only in the vault's `on_auth` — an orphan the rescue cannot repair (D-538).
    if (!isCanonicalJson(raw)) {
      return wouldFail("the auth_call msg is not the JSON the app builds (a duplicate key, a broken character, or reformatted)");
    }
    const opProblem =
      op === "setup"
        ? (nameProblem(body.portfolio_name) ??
          loginWalletProblem(body.login_wallet, signerId) ??
          offerProblem(tokenIdsOf(body.composition, objectTokenId)) ??
          compositionCapProblem(body.composition))
        : offerProblem(tokenIdsOf(body.token_additions, tupleTokenId));
    const problem =
      msgTypeProblem(nonce, op, body) ??
      compositionRulesProblem(op, body) ??
      deadlineProblem(deadline, Math.floor(now() / 1000)) ??
      opProblem ??
      offerProblem(tokenIdsOf(body.allocations, tupleTokenId));
    if (problem) return wouldFail(problem);

    let simulation: RelayViewResult;
    let portfolioCount: number | null;
    try {
      [simulation, portfolioCount] = await Promise.all([
        view(intentsId, "simulate_intents", { signed: [payload] }),
        op === "setup" ? viewPortfolioCount(view, vaultId, signerId) : Promise.resolve(null),
      ]);
    } catch (e) {
      return checkFailed(`simulate_intents: ${describe(e)}`);
    }
    if (simulation.kind === "panic") return wouldFail(simulation.message);
    // An invariant violation is reported, not panicked, by the simulation; execution panics on it.
    const violated = isObject(simulation.value) ? simulation.value.invariant_violated : undefined;
    if (violated !== undefined && violated !== null) {
      return wouldFail(`invariant violated: ${JSON.stringify(violated)}`);
    }
    if (op === "setup") {
      if (portfolioCount === null) {
        log(`[relay] could not read the portfolios of ${signerId}; sending the Setup anyway`);
      } else if (portfolioCount >= APP_MAX_PORTFOLIOS_PER_ACCOUNT) {
        return wouldFail(`${signerId} already has ${portfolioCount} portfolios (the app's cap is ${APP_MAX_PORTFOLIOS_PER_ACCOUNT})`);
      }
    }
    return { ok: true, signerId, replayKey: `${signerId}:${hex(envelope.nonce)}` };
  }

  async function checkCommit(payload: unknown): Promise<RelayGateVerdict> {
    const key = await verifyMultiPayload(payload);
    if (!key) return wouldFail("the signature does not verify");
    const envelope = extractDefuseEnvelope(payload);
    if (!envelope) return wouldFail("unreadable envelope");
    if (envelope.verifyingContract !== vaultId) {
      return wouldFail(`signed for ${envelope.verifyingContract}, not ${vaultId}`);
    }
    const envelopeProblem = canonicalEnvelopeProblem(payload);
    if (envelopeProblem) return wouldFail(envelopeProblem);
    const nonce = decodeV1Nonce(Buffer.from(envelope.nonce).toString("base64"));
    if (!nonce) return wouldFail("not a versioned V1 nonce");
    const nowSecs = Math.floor(now() / 1000);
    // The vault's comparisons (`deadline < now` expired, `> now + cap` refused), against our clock
    // instead of the block's, with a margin so a signature about to expire is not sent to expire.
    if (nonce.deadlineSecs < nowSecs + COMMIT_DEADLINE_MARGIN_SECS) return wouldFail("the signature expired");
    if (nonce.deadlineSecs > nowSecs + COMMIT_DEADLINE_CAP_SECS) return wouldFail("the signature deadline is too far ahead");
    const portfolioId = envelope.message.portfolio_id;
    if (typeof portfolioId !== "string") return wouldFail("no portfolio_id in the change set");
    const changeSet = envelope.message;
    const problem =
      ("name" in changeSet ? nameProblem(changeSet.name) : null) ??
      offerProblem(tokenIdsOf(changeSet.token_additions, tupleTokenId));
    if (problem) return wouldFail(problem);

    const signerId = envelope.signerId;
    const implicit = isImplicitAccountId(signerId);
    if (implicit && implicitAccountId(key) !== signerId) {
      return wouldFail(`the signing key does not control ${signerId}`);
    }

    let registered: RelayViewResult | null;
    let portfolio: RelayViewResult;
    let nonceUsed: boolean | null;
    try {
      [registered, portfolio, nonceUsed] = await Promise.all([
        implicit
          ? Promise.resolve(null)
          : view(intentsId, "has_public_key", { account_id: signerId, public_key: formatSignerKey(key) }),
        view(vaultId, "get_portfolio", { portfolio_id: portfolioId }),
        viewCommitNonceUsed(view, vaultId, signerId, envelope.nonce),
      ]);
    } catch (e) {
      return checkFailed(describe(e));
    }

    if (registered && !(registered.kind === "value" && registered.value === true)) {
      return wouldFail(`${formatSignerKey(key)} is not a registered key of ${signerId}`);
    }
    if (portfolio.kind === "panic") return wouldFail(portfolio.message);
    const record = portfolio.value;
    if (!isObject(record)) return wouldFail(`unknown portfolio ${portfolioId}`);
    if (record.owner !== signerId) return wouldFail(`${signerId} does not own portfolio ${portfolioId}`);
    if (record.deleted === true) return wouldFail(`portfolio ${portfolioId} is deleted`);
    // A commit that grows the composition past the app's cap (D-528). Removals in the same change
    // set count, so a portfolio above the cap can still swap one token for another.
    const additions = Array.isArray(changeSet.token_additions) ? changeSet.token_additions.length : 0;
    if (additions > 0 && Array.isArray(record.composition)) {
      const removals = Array.isArray(changeSet.token_removals) ? changeSet.token_removals.length : 0;
      const before = record.composition.length;
      const after = before + additions - removals;
      if (growsPastAppTokenCap(before, after)) {
        return wouldFail(`a composition of ${after} tokens (the app's cap is ${APP_MAX_TOKENS_PER_PORTFOLIO})`);
      }
    }
    // The vault deletes only an empty portfolio (`E_PORTFOLIO_NOT_EMPTY`, D-403).
    if (changeSet.delete === true && Array.isArray(record.held_tokens) && record.held_tokens.length > 0) {
      return wouldFail(`portfolio ${portfolioId} still holds tokens`);
    }
    if (nonceUsed === true) return wouldFail("this signed change was already applied");
    if (nonceUsed === null) log(`[relay] could not read the commit nonce of ${signerId}; sending anyway`);
    return { ok: true, signerId, replayKey: `${signerId}:${hex(envelope.nonce)}` };
  }

  return ({ target, payload }) => (target === "verifier" ? checkAllocate(payload) : checkCommit(payload));
}
