export type NearNetwork = "mainnet" | "testnet";

export const NETWORK: NearNetwork = "mainnet";

// NEAR RPC for the APP'S OWN READS (D-173, 014.plan): a same-origin route, not an RPC host.
//
// Latency here is a functional requirement, not a preference. Two view calls run sequentially
// INSIDE the click handler before the wallet is asked to sign — snapshotPortfolios
// (allocate-poll.ts) then getCurrentSalt (allocate-submit.ts) — and Blink only keeps the
// click's transient activation for 5s. On 2026-07-28 `rpc.mainnet.near.org` answered each in
// ~3.4s, ~6.8s passed before near-connect's `window.open`, the browser blocked the popup and
// the signing modal never appeared. The same slowness starves the credit poll (3s interval,
// 120s timeout), pushing the flow toward `pending-unconfirmed` more often than designed.
//
// The route (app/api/near-rpc, near-rpc-proxy.ts) calls Meta Pool's own RPC with an API key
// the browser must never see, and falls back to FastNEAR's free endpoint. Mainnet only, like
// NETWORK: the proxy has no testnet upstream.
export const BROWSER_RPC_URL = "/api/near-rpc";

// PUBLIC NEAR RPC, env-overridable, for near-connect (near-wallet-provider.tsx) only. It
// serializes this list into every wallet's sandboxed iframe (origin `null`) and the wallets SEND
// transactions through it: a relative URL does not resolve there, and the proxy refuses send
// methods by design. (The relayer has its own keyed provider: vault/lib/relay-rpc-provider.ts.)
// Whatever URL this holds is inlined into the bundle: never a URL with a key in it.
// Testnet stays on the official endpoint — unused while NETWORK is mainnet.
export const RPC_ENDPOINTS: Record<NearNetwork, string> = {
  // `||`, not `??`: .env.example ships the key with an empty value, and an empty string
  // must fall back to the default rather than become the request URL.
  mainnet: process.env.NEXT_PUBLIC_NEAR_RPC_URL || "https://free.rpc.fastnear.com",
  testnet: "https://rpc.testnet.near.org",
};

// Separate constant — not a registry entry. Used in balance fetcher (Stage 2.6)
// to sum native NEAR + wNEAR as a single "NEAR" balance (NEAR unified, see CONTEXT.md).
export const WNEAR_CONTRACT_ID = "wrap.near";

// NEAR Intents multi-token contract. Used by useIntentsBalances (Stage 5.0.5).
export const INTENTS_CONTRACT_ID = "intents.near";

/**
 * Vault accounts that no longer exist, or are about to be deleted. Anything sent to one is
 * lost: a deposit would land in intents.near under a name anyone can register again. So an id
 * here is never used as the vault, even if a deployment's env still names it.
 * `intentfolio-staging.near` ran the v1 test contract until 2026-09-30.
 */
export const RETIRED_VAULT_CONTRACT_IDS: ReadonlySet<string> = new Set(["intentfolio-staging.near"]);

// IntentFolio vault (accounting/authz layer over the Verifier). Env-configurable so
// each deployment names its own account. No default: a missing or retired id is "" — no
// vault — and never falls back silently to some account.
const CONFIGURED_VAULT_CONTRACT_ID = process.env.NEXT_PUBLIC_VAULT_CONTRACT_ID?.trim() ?? "";
export const VAULT_CONTRACT_ID = RETIRED_VAULT_CONTRACT_IDS.has(CONFIGURED_VAULT_CONTRACT_ID)
  ? ""
  : CONFIGURED_VAULT_CONTRACT_ID;

// Stub until Stage 2.1 closes the token registry with real contract IDs.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getContractIdForSymbol(_symbol: string): string | null {
  return null;
}
