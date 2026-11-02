// The one place where OUR token id and INTENTS' token id are allowed to disagree.
//
// For 55 of the 56 curated tokens the two are the same string: the registry id IS the
// Defuse asset id (`nep141:…` / `nep245:…`), which is why every write path could hand a
// registry id straight to `intents.near` and to the vault and be right by accident.
//
// NEAR native is the exception, and it is not cosmetic. There is NO native NEAR inside
// `intents.near`: the bridge wraps every deposit, so what the General Balance actually
// holds is `nep141:wrap.near`. The registry calls that token `"near"` (a label of ours —
// D-011 unifies native + wNEAR under one row for the wallet reader), and the contract has
// never heard of it. Measured 2026-08-20 against mainnet:
//
//   mt_batch_balance_of(pablow.near, ["near", "nep141:wrap.near"])
//     → ["0", "71906156571586238948914"]
//
// `"near"` is not rejected — it is simply a key nobody holds. So an Allocate that named it
// asked to move a token with a zero balance: the Transfer fails AFTER the user signed, and
// the failure reads as a wallet problem rather than as the id mismatch it is.
//
// Reading was already correct (`use-intents-balances` mapped wNEAR back to "near"); only
// the write half was missing, which is why nothing caught it — the balance showed up fine.
//
// Both directions are IDEMPOTENT and total: passing an id that is already in the target
// space returns it unchanged, so a double conversion cannot corrupt anything.

/** The registry's id for native NEAR — a label of ours, not a Defuse asset id. */
export const NEAR_REGISTRY_TOKEN_ID = "near";

/** What `intents.near` (and therefore the vault) actually holds for NEAR. */
export const WNEAR_INTENTS_TOKEN_ID = "nep141:wrap.near";

/**
 * Registry id → the id to put in anything the contracts read: the `transfer` intent's
 * token map, the AuthCallMsg composition, the PortfolioChangeSet.
 */
export function toIntentsTokenId(registryTokenId: string): string {
  return registryTokenId === NEAR_REGISTRY_TOKEN_ID
    ? WNEAR_INTENTS_TOKEN_ID
    : registryTokenId;
}

/**
 * The inverse, for everything read back off-chain: vault balances, the stored composition,
 * event payloads. Applied at the read client so the rest of the app never sees a contract
 * id — `getTokenById` would answer `undefined` for `nep141:wrap.near` and the balance would
 * be silently dropped from the projection.
 */
export function toRegistryTokenId(intentsTokenId: string): string {
  return intentsTokenId === WNEAR_INTENTS_TOKEN_ID
    ? NEAR_REGISTRY_TOKEN_ID
    : intentsTokenId;
}
