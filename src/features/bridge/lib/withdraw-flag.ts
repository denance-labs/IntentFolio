// Feature flag for the real withdrawal path (005.plan §8, Phase 5, block 5.3).
//
// Default OFF. When off, the withdrawal modal stays on `mockContract.withdraw` exactly as
// today — this flag is the only thing that can send a user's General Balance out of the
// system from the FE.
//
// ⚠️ Next.js INLINES `NEXT_PUBLIC_` variables into the bundle at BUILD time. Changing
// `NEXT_PUBLIC_REAL_WITHDRAWAL` in `.env.local` does nothing to a build that already exists:
// rebuild (`npm run build`) and hard-reload. Referencing it as a static literal is also
// required — `process.env[name]` is not inlined and would silently read `undefined`.
//
// NEXT_PUBLIC_ (unlike bridge family-validation's server-only vars) because the signing
// flow runs in the browser.

import { getWithdrawalEntry } from "./withdrawal-registry";
import { hotReceiverEncodable } from "./hot-envelope";
import { hotFeeSupported } from "./hot-fee";
import { withdrawalPlan } from "./conversion-routes";

export const REAL_WITHDRAWAL_ENABLED = process.env.NEXT_PUBLIC_REAL_WITHDRAWAL === "true";

/**
 * Whether THIS withdrawal goes to the live path instead of the mock.
 *
 * Note what is deliberately NOT checked here, and why it differs from `isLiveVaultRoute`:
 *
 *   - No relayer flag. A withdrawal is signed against `intents.near` and published over
 *     HTTP to the Solver Relay (ADR-0005, Path D). Nobody sends a NEAR transaction, nobody
 *     pays gas, and the vault is not in the loop — so the five non-NEAR families need
 *     nothing beyond a signer, unlike the vault round-trip where they depend on the relayer.
 *   - No portfolio. This moves the General Balance, which exists before any portfolio does.
 *
 * `tokenId` is REQUIRED rather than optional on purpose: the route decides whether the path
 * can execute at all, and an optional safety argument is one a caller forgets. The gate
 * closes on an unknown token for the same reason.
 *
 * `hot-omni` is in as of block 4.3.6, and only for the chains the path can actually serve.
 * The two conditions are asked of the modules that own them rather than restated here:
 *
 *   - `hotReceiverEncodable` — a chain the builder cannot serialise an address for would
 *     produce a well-formed base58 string addressed to nobody. Every `hot-omni` chain in the
 *     registry is covered as of block 4.5 (TON was the last), so this condition holds for all
 *     of them today.
 *   - `hotFeeSupported` — no live quote means no signable envelope on this route (there is no
 *     registry fallback, see `hot-fee.ts`), so a chain we cannot quote is a chain we cannot
 *     withdraw from.
 *
 * They are asked anyway because the registry is where a new chain gets added, and a new chain
 * must not become live money by appearing in a table.
 */
export function isRealWithdrawalRoute(params: {
  hasSigner: boolean;
  loginChain: string | null | undefined;
  /** Full defuse asset id — the withdrawal-registry key. */
  tokenId: string;
}): boolean {
  if (!REAL_WITHDRAWAL_ENABLED) return false;
  if (!params.hasSigner) return false;
  // A null/undefined/empty family is "not signed in yet", never a live money route.
  if (!params.loginChain) return false;
  const entry = getWithdrawalEntry(params.tokenId);
  if (!entry) return false;
  switch (entry.bridgeRoute) {
    case "omft":
    case "near-native":
    // `near-unwrap` lands in a NEAR account like `near-native` does, so it clears the same
    // bar: no external address format to get wrong, no bridge floor, and `validateAddress`
    // has a real NEAR validator.
    case "near-unwrap":
      return true;
    case "hot-omni":
      return hotReceiverEncodable(entry.chainId) && hotFeeSupported(params.tokenId);
    // D-580: one token (ZEC), an address validator that refuses what the bridge cannot pay
    // (`validateZcash`), a live fee the screen blocks without, and the submit-time check reading
    // the recipient back out of the signed `msg`.
    case "omni":
      return true;
    default:
      return false;
  }
}

/**
 * Converting Withdrawals (D-392, plan 020 §5.5). Default OFF, and on its own it opens nothing:
 * a conversion is live money like any withdrawal, so `isConversionRoute` also asks for
 * `NEXT_PUBLIC_REAL_WITHDRAWAL`. Same build-time inlining caveat as that flag.
 */
export const UNIVERSAL_WITHDRAWAL_ENABLED = process.env.NEXT_PUBLIC_UNIVERSAL_WITHDRAWAL === "true";

/**
 * Whether sending `heldTokenId` to `chainId` goes out as a Converting Withdrawal (CONTEXT.md).
 *
 * Both flags, a signer and a login, and a pair the delivery table names as a conversion
 * (`withdrawalPlan`). There is no mock fallback on purpose: the mock cannot simulate a 1Click
 * delivery honestly, so with any of these missing the pair is simply not offered and the screen
 * is today's (plan 020 §5.5).
 */
export function isConversionRoute(params: {
  hasSigner: boolean;
  loginChain: string | null | undefined;
  /** Full defuse asset id of the token the user holds. */
  heldTokenId: string;
  chainId: string;
}): boolean {
  if (!REAL_WITHDRAWAL_ENABLED || !UNIVERSAL_WITHDRAWAL_ENABLED) return false;
  if (!params.hasSigner || !params.loginChain) return false;
  return withdrawalPlan(params.heldTokenId, params.chainId).kind === "conversion";
}
