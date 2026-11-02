// ADR-0015 (monorepo docs/adr): all six login chain families are exposed at public
// launch; a per-family `validated` flag gates a soft warning + explicit acknowledgment
// at the deposit step, not visibility. There is no automatic "validated" signal —
// flipping a family is always a manual, operator-run act after an empirical Avenue C
// deposit round-trip (H8.1b). Order families light up: Solana -> TON -> Tron -> Stellar.

export type ChainFamily = "near" | "evm" | "solana" | "ton" | "stellar" | "tron";

export const CHAIN_FAMILIES: ChainFamily[] = ["near", "evm", "solana", "ton", "stellar", "tron"];

// Maps a bridge chainId (e.g. "eth:1", "sol:mainnet") to its login chain family.
// Chains outside the six login families (btc, aptos, sui, ...) are deposit-only
// rails with no login-derivation risk — they return null and are never gated.
export function familyForChainId(chainId: string): ChainFamily | null {
  const prefix = chainId.split(":")[0];
  switch (prefix) {
    case "eth":
      return "evm";
    case "near":
      return "near";
    case "sol":
      return "solana";
    case "ton":
      return "ton";
    case "tron":
      return "tron";
    case "stellar":
      return "stellar";
    default:
      return null;
  }
}

// Server-only: reads process.env (not NEXT_PUBLIC_) so an operator can flip a family
// via env var + process restart, without a full rebuild. Falls back to the current
// empirical state (H8.1b: NEAR + EVM validated, §11/§7.1 of 006.h8.1) when unset.
//
// The DEFAULT map below is the durable record of what has actually been round-tripped with
// real funds; the env vars only override it. Flipping a family here is therefore a claim
// about evidence, not a convenience — see the per-family note on each `true`.
const VALIDATED_ENV_VAR: Record<ChainFamily, string> = {
  near: "BRIDGE_FAMILY_VALIDATED_NEAR",
  evm: "BRIDGE_FAMILY_VALIDATED_EVM",
  solana: "BRIDGE_FAMILY_VALIDATED_SOLANA",
  ton: "BRIDGE_FAMILY_VALIDATED_TON",
  stellar: "BRIDGE_FAMILY_VALIDATED_STELLAR",
  tron: "BRIDGE_FAMILY_VALIDATED_TRON",
};

const DEFAULT_VALIDATED: Record<ChainFamily, boolean> = {
  near: true,
  evm: true,
  // Validated 2026-08-06 (008.plan F4.2) with real funds on mainnet, via Backpack: deposit
  // of native SOL and of an SPL token (USDT), Allocate + Unallocate asserted to the base
  // unit on BOTH ledgers for a single-token and a two-token portfolio, then a real
  // withdrawal back to the origin wallet — delivered in
  // 3Xd6qTZaZGsnNN5mGtAunvrCRapDjy2kdMNjg4eswW4jYtP6dWcwpPgswsjc6bWALnECnB3bmxy5rdAwfC6gHs6B
  // (SOL) and 46XbWSYoJnVrTR6naEvpMs44qGPgrE5CXukuC9yVou5BSqZYwRhhWAEUrxPsPvd2DCazyLNbNThvavVhNTeKbERn
  // (USDT). Phantom was NOT exercised; the family is validated, one wallet in it is.
  solana: true,
  ton: false,
  // Validated 2026-08-08 (008.plan F4.5) with real funds on mainnet, via Freighter, from
  // identity 97175abcd939141df6a15cb2d8d2d55338db9e55dcf0c1e62ab09bc17cfbfd19: seven XLM
  // deposits with a MEMO_TEXT memo totalling 7.800 (the memo path is Stellar-only, D-233),
  // then Allocate of 3.902 into p_00000000000a and Unallocate back, both asserted to the
  // stroop on BOTH ledgers — the first time the Stellar→vault AuthCall ran on chain, since
  // 4.2 validated Solana and Tron under a different signing scheme — and finally a real
  // withdrawal of 7.804 delivered as 7.704 XLM to
  // GCLROWV43E4RIHPWUFOLFWGS2VJTRW46KXOPBQPGFKYJXQL47P6RTQDA in ~70s. Every amount was read
  // by view call, never off the UI, and the run reconciles: 0.1 XLM of bridge fee is the only
  // difference between what went in and what came back.
  // ⚠️ The withdrawal was UNREACHABLE until D-240 was fixed in this same block: the modal
  // demanded a memo (a deposit-side property) that the HOT envelope rejects on withdrawal.
  // ⚠️ 0.004 XLM of the balance was address-poisoning dust from a third party, not the
  // operator's (D-234) — the family is validated, the ledger was never clean.
  stellar: true,
  // Validated 2026-08-07 (008.plan F4.2) with real funds on mainnet, via TronLink: deposit of
  // 3 USDT (TRC-20) in d8dc1a29216e776b160aeea50ea6e51eee7a0b7c6a9d51fc49bf5d34bd7a65cc,
  // Allocate + Unallocate asserted to the base unit on BOTH ledgers, then a real withdrawal
  // back to the origin wallet delivered in
  // 26baa5d6f7863cb5589ecaab35c7130835a54e057d93b57400713b04253c966b. Every amount was read
  // by view call, never off the UI, and the whole run reconciles: 0.851075 USDT of bridge fee
  // is the only difference between what went in and what came back.
  // ⚠️ This only became reachable after the TIP-6963 migration (D-219): on the legacy globals
  // the login and the SIGNER were both being answered by another installed wallet.
  tron: true,
};

export function isFamilyValidated(family: ChainFamily): boolean {
  const raw = process.env[VALIDATED_ENV_VAR[family]];
  if (raw === "true") return true;
  if (raw === "false") return false;
  return DEFAULT_VALIDATED[family];
}

export function getFamilyValidationMap(): Record<ChainFamily, boolean> {
  return Object.fromEntries(
    CHAIN_FAMILIES.map((family) => [family, isFamilyValidated(family)])
  ) as Record<ChainFamily, boolean>;
}
