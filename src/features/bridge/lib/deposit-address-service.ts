// Attribution: see ATTRIBUTIONS.md #13 (1Click API v0 — reusable deposit addresses).
//
// Receive's deposit address after PoA's Bridge API closed (D-584, plan 046). SERVER ONLY: it holds
// the 1Click partner key, which is also the solver relay's (operator decision), so a leak or a ban
// takes both down.
//
// One reusable 1Click address set per account (`ANY_INPUT`, `1cs_v1:any` → `1cs_v1:original`,
// deadline 2038): fixed addresses the user can save, crediting the account in `intents.near`
// whatever is sent. Created without a user session, so 1Click neither deduplicates nor lets us
// find it again by recipient (measured 2026-11-15): migration 013's `account_deposit_address`
// remembers it, and 014's `create_response` keeps 1Click's signed answer for disputes. Several rows
// per account can exist (two first visits at once); the OLDEST is shown.
//
// Fails CLOSED everywhere: an address we did not get from 1Click for this very account, or did not
// manage to store, is never shown — a stored set is what the history will recognise deposits by.
//
// Every create spends the shared key and leaves a permanent set at 1Click, stored or not. So a
// create is braked three ways: per caller, per instance (attempts, which also count the creates
// that never became a row), and across instances (rows of the last hour).

import { chainRegistry } from "./chain-registry";
import { ONE_CLICK_BASE_URL } from "./oneclick-base-url";
import { isFollowableAccountId } from "@/features/history-recorder/lib/account-recorder";
import { createOpsRateLimiter, type OpsRateLimiter, type Queryable } from "@/features/vault/lib/ops-records-service";

/** Our chain id → 1Click's `blockchain`. Every chain of `chain-registry.ts` (measured in the set, 0a). */
export const RDA_BLOCKCHAIN: Readonly<Record<string, string>> = {
  "eth:1": "eth",
  "eth:8453": "base",
  "eth:56": "bsc",
  "eth:100": "gnosis",
  "eth:42161": "arb",
  "eth:10": "op",
  "eth:137": "pol",
  "eth:43114": "avax",
  "eth:143": "monad",
  "eth:196": "xlayer",
  "eth:534352": "scroll",
  "eth:80094": "bera",
  "eth:9745": "plasma",
  "eth:36900": "adi",
  "near:mainnet": "near",
  "sol:mainnet": "sol",
  "ton:mainnet": "ton",
  "tron:mainnet": "tron",
  "stellar:mainnet": "stellar",
  "aleo:mainnet": "aleo",
  "aptos:mainnet": "aptos",
  "sui:mainnet": "sui",
  "starknet:mainnet": "starknet",
  "cardano:mainnet": "cardano",
  "xrp:mainnet": "xrp",
  "btc:mainnet": "btc",
  "bch:mainnet": "bch",
  "ltc:mainnet": "ltc",
  "doge:mainnet": "doge",
  "dash:mainnet": "dash",
  "zec:mainnet": "zec",
};

const SERVED_BLOCKCHAINS: ReadonlySet<string> = new Set(Object.values(RDA_BLOCKCHAIN));

/** New sets per hour, all accounts together: a flood of creates must not get the shared key banned. */
export const NEW_SETS_PER_HOUR = 120;
/** Creates per caller per hour: one person opens Receive for one account; a few retries on top. */
export const CREATES_PER_CALLER_PER_HOUR = 5;
/** We ask for 2038-01-01; a set that goes inactive before this is not a fixed address. */
const MIN_INACTIVE_AT_MS = Date.parse("2037-01-01T00:00:00.000Z");
const CREATE_TIMEOUT_MS = 10_000;
const HOUR_MS = 3_600_000;

export type ChainAddress = { blockchain: string; address: string; memo?: string };

export type DepositAddressBody =
  | { ok: true; address: string; memo?: string }
  | {
      ok: false;
      code: "bad-request" | "too-many-requests" | "not-configured" | "busy" | "upstream" | "unavailable";
      error: string;
    };

export type DepositAddressOutput = { status: number; body: DepositAddressBody };

const SELECT_OLDEST = `SELECT internal_account, chain_addresses FROM account_deposit_address
 WHERE account_id = $1 ORDER BY created_at, internal_account LIMIT 1`;
const COUNT_LAST_HOUR = "SELECT count(*) AS n FROM account_deposit_address WHERE created_at > now() - interval '1 hour'";
const INSERT_SET = `INSERT INTO account_deposit_address
 (account_id, internal_account, chain_addresses, correlation_id, create_response)
 VALUES ($1, $2, $3::jsonb, $4, $5::jsonb) ON CONFLICT (internal_account) DO NOTHING`;

// Receive opens a few chains a visit; 30 a minute per caller is far above that.
const readLimiter: OpsRateLimiter = createOpsRateLimiter({ maxPerWindow: 30 });
const createLimiter: OpsRateLimiter = createOpsRateLimiter({ maxPerWindow: CREATES_PER_CALLER_PER_HOUR, windowMs: HOUR_MS });
// One key, this instance's attempts: unlike the row count, it also sees the creates that failed after 1Click made the set.
const attemptLimiter: OpsRateLimiter = createOpsRateLimiter({ maxPerWindow: NEW_SETS_PER_HOUR, windowMs: HOUR_MS, maxKeys: 1 });

const fail = (status: number, code: Extract<DepositAddressBody, { ok: false }>["code"], error: string): DepositAddressOutput => ({
  status,
  body: { ok: false, code, error },
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The entries of a set for the networks Receive serves, or null if one of THOSE is malformed or
 * there is none. Entries of other networks are dropped unread: an odd entry for a chain we do not
 * offer must not take Receive down for every new account. An empty or null memo is no memo; a
 * network that needs one still fails closed where it is shown (`memoRequired`).
 */
export function parseChainAddresses(value: unknown): ChainAddress[] | null {
  if (!Array.isArray(value) || value.length > 256) return null;
  const out: ChainAddress[] = [];
  for (const e of value) {
    if (!isRecord(e) || typeof e.blockchain !== "string" || !SERVED_BLOCKCHAINS.has(e.blockchain)) continue;
    const { blockchain, address, memo } = e;
    if (typeof address !== "string" || address.length === 0 || address.length > 256) return null;
    if (memo === undefined || memo === null || memo === "") {
      out.push({ blockchain, address });
      continue;
    }
    if (typeof memo !== "string" || memo.length > 128) return null;
    out.push({ blockchain, address, memo });
  }
  return out.length > 0 ? out : null;
}

type CreatedSet = {
  internalAccount: string;
  chainAddresses: ChainAddress[];
  correlationId: string | null;
  /** 1Click's answer as it came, for disputes (014). */
  raw: Record<string, unknown>;
};

/**
 * 1Click's create answer, accepted only if it is a fixed set crediting `accountId`'s ordinary
 * balance: the echo names the account as recipient AND refund, every type is `INTENTS` (not a
 * confidential balance IntentFolio cannot read), and it stays active into 2037. Measured
 * 2026-11-15: the echo repeats a named, a `0x…` and a 64-hex account byte for byte.
 */
export function parseCreateResponse(accountId: string, json: unknown): { ok: true; set: CreatedSet } | { ok: false; reason: string } {
  if (!isRecord(json) || !isRecord(json.quote) || !isRecord(json.quoteRequest)) return { ok: false, reason: "shape" };
  const q = json.quote;
  const req = json.quoteRequest;
  if (req.recipient !== accountId || req.refundTo !== accountId) return { ok: false, reason: "recipient" };
  if (req.recipientType !== "INTENTS" || req.refundType !== "INTENTS" || req.depositType !== "INTENTS") return { ok: false, reason: "types" };
  if (req.swapType !== "ANY_INPUT" || req.originAsset !== "1cs_v1:any" || req.destinationAsset !== "1cs_v1:original") return { ok: false, reason: "assets" };
  for (const field of ["deadline", "timeWhenInactive"] as const) {
    const at = q[field];
    // `deadline` is required; `timeWhenInactive` is checked when present.
    if (at === undefined && field === "timeWhenInactive") continue;
    if (typeof at !== "string" || !(Date.parse(at) >= MIN_INACTIVE_AT_MS)) return { ok: false, reason: field };
  }
  const internal = q.depositAddress;
  if (typeof internal !== "string" || internal.length < 2 || internal.length > 128) return { ok: false, reason: "depositAddress" };
  const chainAddresses = parseChainAddresses(q.chainDepositAddresses);
  if (!chainAddresses) return { ok: false, reason: "chainDepositAddresses" };
  const cid = json.correlationId;
  const correlationId = typeof cid === "string" && cid.length > 0 && cid.length <= 128 ? cid : null;
  return { ok: true, set: { internalAccount: internal, chainAddresses, correlationId, raw: json } };
}

async function createSet(accountId: string, partnerKey: string, fetchImpl: typeof fetch): Promise<CreatedSet | null> {
  const res = await fetchImpl(`${ONE_CLICK_BASE_URL}/v0/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": partnerKey },
    body: JSON.stringify({
      dry: false,
      swapType: "ANY_INPUT",
      originAsset: "1cs_v1:any",
      depositType: "INTENTS",
      destinationAsset: "1cs_v1:original",
      amount: "0",
      slippageTolerance: 50,
      recipient: accountId,
      recipientType: "INTENTS",
      refundTo: accountId,
      refundType: "INTENTS",
      // Exactly this: a deadline taken from the current time expires the address (1Click docs).
      deadline: "2038-01-01T00:00:00.000Z",
    }),
    // Node's fetch would carry `X-API-Key` across a redirect to another host.
    redirect: "error",
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Never the body: it may echo the request headers.
    console.warn(`[deposit-address] 1Click create answered ${res.status}`);
    return null;
  }
  const parsed = parseCreateResponse(accountId, await res.json());
  if (!parsed.ok) {
    console.warn(`[deposit-address] 1Click create refused (${parsed.reason})`);
    return null;
  }
  return parsed.set;
}

export type HandleDepositAddressInput = {
  query: URLSearchParams;
  callerKey: string;
  db: Queryable;
  partnerKey: string | undefined;
  fetchImpl?: typeof fetch;
  /** Tests only: the three brakes. */
  limiter?: OpsRateLimiter;
  createLimiter?: OpsRateLimiter;
  attemptLimiter?: OpsRateLimiter;
  perHour?: number;
};

export async function handleDepositAddress(input: HandleDepositAddressInput): Promise<DepositAddressOutput> {
  const accountId = input.query.get("account");
  if (accountId === null || !isFollowableAccountId(accountId)) return fail(400, "bad-request", "account must be an account id intents.near knows");
  const chainId = input.query.get("chain");
  if (chainId === null || !Object.hasOwn(RDA_BLOCKCHAIN, chainId) || !Object.hasOwn(chainRegistry, chainId)) {
    return fail(400, "bad-request", "chain must be a network Receive offers");
  }
  const blockchain = RDA_BLOCKCHAIN[chainId];
  const meta = chainRegistry[chainId];
  if (!(input.limiter ?? readLimiter).check(input.callerKey)) return fail(429, "too-many-requests", "Too many requests from this caller");

  let row = (await input.db.query<{ chain_addresses: unknown }>(SELECT_OLDEST, [accountId])).rows[0];
  if (!row) {
    if (!input.partnerKey) return fail(503, "not-configured", "Deposit addresses are not configured on this deployment");
    if (!(input.createLimiter ?? createLimiter).check(input.callerKey)) {
      return fail(429, "too-many-requests", "Too many new deposit addresses from this caller");
    }
    const recent = await input.db.query<{ n: string }>(COUNT_LAST_HOUR);
    if (Number(recent.rows[0]?.n ?? 0) >= (input.perHour ?? NEW_SETS_PER_HOUR) || !(input.attemptLimiter ?? attemptLimiter).check("all")) {
      return fail(503, "busy", "Too many new deposit addresses this hour; try again later");
    }
    let created: CreatedSet | null;
    try {
      created = await createSet(accountId, input.partnerKey, input.fetchImpl ?? fetch);
    } catch (e) {
      console.warn(`[deposit-address] 1Click create failed: ${e instanceof Error ? e.name : "error"}`);
      created = null;
    }
    if (!created) return fail(502, "upstream", "Could not create a deposit address");
    await input.db.query(INSERT_SET, [
      accountId,
      created.internalAccount,
      JSON.stringify(created.chainAddresses),
      created.correlationId,
      JSON.stringify(created.raw),
    ]);
    // The oldest again, not ours: a concurrent first visit may have stored its set before us.
    row = (await input.db.query<{ chain_addresses: unknown }>(SELECT_OLDEST, [accountId])).rows[0];
    if (!row) return fail(503, "unavailable", "The deposit address was not stored");
  }

  const entry = parseChainAddresses(row.chain_addresses)?.find((e) => e.blockchain === blockchain);
  if (!entry) return fail(502, "upstream", `No deposit address for ${meta.displayName}`);
  // A network that needs a memo and has none would lose the deposit: show nothing.
  if (meta.memoRequired && !entry.memo) return fail(502, "upstream", `No memo for ${meta.displayName}`);
  return { status: 200, body: entry.memo ? { ok: true, address: entry.address, memo: entry.memo } : { ok: true, address: entry.address } };
}
