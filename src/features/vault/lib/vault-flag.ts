// Feature flag for the live vault round-trip (007.plan, Phase 1).
//
// Default OFF. When off, every portfolio path stays on `mockContract` exactly as before —
// this flag is the only thing that can put real funds in motion from the FE.
//
// NEXT_PUBLIC_ (unlike bridge family-validation's server-only vars) because the signing
// flow runs in the browser. Next.js inlines these at build time, so the env var must be
// referenced as a static literal — never `process.env[someVar]`.

export const VAULT_ROUNDTRIP_ENABLED = process.env.NEXT_PUBLIC_VAULT_ROUNDTRIP === "true";

/**
 * Routes the NEAR family's SEND through the relayer instead of its own wallet (008.plan, Phase 0).
 *
 * Only the NEAR family has a choice here — the other five have no account to send from, so they
 * use the relayer regardless of this flag (see `usesRelay`). Default off keeps the self-submit
 * path as the control the relayer is verified against.
 *
 * This is a PUBLIC flag and nothing more. The relayer's key and access token are server-side;
 * a `NEXT_PUBLIC_` variable is inlined into the browser bundle, so a secret must never be
 * named with that prefix.
 */
export const VAULT_RELAY_ENABLED = process.env.NEXT_PUBLIC_VAULT_RELAY === "true";

/**
 * Whether the Allocate rescue record is also persisted off-client (ADR-0017, P-OPS v1).
 *
 * ON in production since 2026-08-31 (Neon via the Vercel Marketplace). The default is still
 * off, and that default is load-bearing rather than cautious: when this is on the
 * pre-signature write is FAIL-CLOSED — no record, no signature — so turning it on against a
 * deployment that has no `INTENTFOLIO_OPS_DB_URL` would stop every Allocate. Vercel previews
 * run with it off — and, since 2026-09-19, with the round-trip and real-withdrawal flags off
 * too, so a preview cannot produce an Allocate for this table to miss (D-297).
 *
 * Off, the rescue record behaves exactly as it did: localStorage plus a console.log, the two
 * channels that live inside the user's browser. That is the gap ADR-0017 exists to close, so
 * this flag is meant to be turned on, not left off.
 *
 * PUBLIC because the writer is the browser. The database credential is server-side and must
 * never be named with this prefix — Next inlines `NEXT_PUBLIC_` values into the bundle.
 */
export const OPS_RECORDS_ENABLED = process.env.NEXT_PUBLIC_OPS_RECORDS === "true";

/**
 * Whether a commit on this portfolio goes to the live vault instead of the mock.
 *
 * Single source of that predicate: the router (portfolio-context) and the UI that gates
 * on it (the maturity countdown) must agree exactly, or the editor blocks a withdrawal
 * the mock would have applied instantly — or worse, lets one through ungated.
 *
 * NEAR was the only family in Phase 1/2 (D-R1) because it is the one whose wallet can both
 * sign and submit. Phase 0b opens the other five: they sign ERC-191 instead of NEP-413
 * (see vault-envelope.ts) and the relayer submits for them.
 *
 * Note what the non-NEAR branch checks and why it is NOT `usesRelay`. That predicate
 * answers "who would send this?" and returns true for every non-NEAR family
 * unconditionally — they have no alternative — so it would add nothing here. The question
 * this gate has to answer is different: "is the relayer actually turned on?" A non-NEAR
 * login with the relayer off would sign an envelope and only then discover there is
 * nothing to submit it with: a burnt signature, after the wallet prompt, reported as an
 * opaque failure. So the relay flag gates the ROUTE for them, not just the routing.
 */
export function isLiveVaultRoute(params: {
  hasSigner: boolean;
  loginChain: string | null | undefined;
  isRealPortfolio: boolean | undefined;
}): boolean {
  if (!VAULT_ROUNDTRIP_ENABLED) return false;
  if (!params.hasSigner) return false;
  if (params.isRealPortfolio !== true) return false;
  if (params.loginChain === "near") return true;
  // The five non-NEAR families. `Boolean(...)` first: a null/undefined family is "not
  // signed in yet", never a live money route.
  return Boolean(params.loginChain) && VAULT_RELAY_ENABLED;
}
