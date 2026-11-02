// Destination pre-flight for `omft` withdrawals landing on Solana (008.plan §Fase 4, 4.2).
//
// WHY THIS EXISTS AT ALL, GIVEN UPSTREAM DOES NOT DO IT
// `intents-sdk@0.78.0` `poa-bridge.js:70-97` (`validateWithdrawal`) checks address SHAPE, the
// supported-token list, and the minimum amount — and the only chain whose destination it
// actually reads on-chain is XRPL. Solana gets nothing. So this is not catching up with the
// reference implementation; it is going past it, for one specific footgun measured below.
//
// WHAT IT IS NOT FOR: rent-exemption on native SOL.
// The plan's premise was that a native SOL withdrawal could land under the rent-exempt
// threshold and fail. Measured against mainnet on 2026-08-06, it cannot: the bridge's own
// `min_withdrawal_amount` for `sol.omft.near` is 1_250_000 lamports and its fee is 14_000, so
// the least that can ever arrive is 1_236_000 against a rent-exempt minimum of 890_880
// (`getMinimumBalanceForRentExemption(0)`) — a 1.39x margin, enforced before this code runs
// by the modal's own `qtyBelowMin`. `assertNativeSolClearsRent` below pins that arithmetic so
// a registry drift cannot quietly erase the margin; there is no RPC call in it.
//
// WHAT IT IS FOR: the user pasting an SPL token account instead of their wallet.
// Wallets and explorers both display token-account addresses, and they are the same 32-byte
// base58 shape as a wallet — `validateAddress` cannot tell them apart. The bridge derives the
// associated token account FROM whatever it is given, so a token account as destination
// produces an ATA owned by a token account: nobody can sign for it and the funds are gone.
// Verified on mainnet: a wallet reads back `owner = 11111111111111111111111111111111` with
// `space 0`; an SPL token account reads back `owner = Tokenkeg…` with `space 165`.
//
// OPEN, DELIBERATELY NOT GUESSED (D-213): whether the bridge creates a missing ATA at the
// destination. The docs do not say, upstream does not check, and `withdrawal_estimate` is
// destination-independent (it returns the flat per-token fee — measured, not assumed). So a
// destination account that does not exist is reported as a WARNING and does not block:
// blocking a legitimate withdrawal to a fresh wallet would be a certain harm traded against
// an unmeasured one, and native SOL is provably safe either way.

/** Solana's System Program — the owner of an ordinary wallet account. */
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** SPL Token and SPL Token-2022. An account owned by either is a token account, not a wallet. */
const TOKEN_PROGRAM_IDS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

/**
 * The endpoints this probe will try, in order, until one gives a usable answer.
 *
 * ⚠️ THIS LIST IS THE MITIGATION, not a nicety. The probe fails CLOSED, so a dead endpoint does
 * not mis-classify a destination — it blocks every Solana withdrawal outright. That is exactly
 * what D-207 recorded happening on Polygon, where `polygon-rpc.com` started answering
 * `401 "tenant disabled"` and took the route out of service. There is no paid endpoint here to
 * fall back to, so the second free one is the whole contingency.
 *
 * Measured 2026-08-06, 12 real `getAccountInfo` calls each plus a 40-call burst on the winner.
 * Only two free endpoints answer at all: PublicNode (12/12 and 40/40, avg 0.30s) and Solana's
 * own (12/12, avg 1.09s, throttles heavier methods but not this one). Their answers are
 * IDENTICAL on all four shapes this module discriminates — wallet, SPL token account, absent
 * account, executable program — which is what makes falling through to the slower one safe:
 * the choice is latency, not trust. Not usable: `solana.drpc.org` (400),
 * `endpoints.omniatech.io` (521), `rpc.ankr.com/solana` and `free.rpcpool.com` (403,
 * key-gated), `api.metaplex.solana.com` and `solana.public-rpc.com` (no DNS).
 *
 * `||` and not `??`: an env key present-but-empty must fall back, not become the URL — the
 * same reasoning as `RPC_ENDPOINTS` (wallet/config/network.ts) and `EVM_RPC_URLS` (hot-fee.ts).
 * An env override REPLACES the list rather than extending it: someone pointing this at their
 * own node means it, and silently falling through to a public endpoint they did not choose is
 * not a favour.
 *
 * Scope note: D-207 asks for this across the four EVM chains too. Solana gets it now and they
 * do not, deliberately — the alternates for those four have not been measured, and shipping an
 * unmeasured fallback is how you get a list that fails over into something worse.
 */
const SOLANA_RPC_URLS: readonly string[] = process.env.NEXT_PUBLIC_SOLANA_RPC_URL
  ? [process.env.NEXT_PUBLIC_SOLANA_RPC_URL]
  : ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

/**
 * Per-ENDPOINT budget, sized so that trying the whole list still fits the ~10s a user will
 * watch a spinner for. This runs OUTSIDE the click that opens the wallet prompt (D-R16), so it
 * has room the confirm click does not — but not unlimited room. Both measured endpoints answer
 * in well under a second, so 5s is already several times the observed worst case.
 */
const PROBE_TIMEOUT_MS = 5_000;

/** What the destination account looks like on chain. `null` when it does not exist. */
export type SolanaAccountInfo = {
  /** Base58 program id that owns the account. */
  owner: string;
  executable: boolean;
  lamports: number;
};

/** The one read this pre-flight needs. Injected so the money path is testable with no network. */
export type SolanaDestinationProbe = {
  /** `getAccountInfo`. `null` for a definitely-absent account; throws when unsure. */
  getAccountInfo: (address: string) => Promise<SolanaAccountInfo | null>;
};

/**
 * Reads `getAccountInfo` and refuses to interpret anything it does not recognise.
 *
 * Fails CLOSED at every ambiguity (D-212): the shape check is `"result" in body`, not
 * `body.result?.value ?? null`, because a 401 or an error envelope parsed with `??` reads as
 * "the account does not exist" — which is the answer that lets a withdrawal proceed. That is
 * the exact bug 4.3.6 shipped and had to correct, on this same class of code.
 */
async function fetchAccountInfoFrom(
  rpcUrl: string,
  address: string
): Promise<SolanaAccountInfo | null> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64" }],
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Solana RPC ${rpcUrl} answered ${res.status} ${res.statusText}`);
  }
  const body: unknown = await res.json();
  const rpc = body as { result?: { value?: unknown }; error?: { message?: string } };
  if (rpc.error) {
    throw new Error(`Solana RPC error: ${rpc.error.message ?? JSON.stringify(rpc.error)}`);
  }
  // Absence of `result` is NOT absence of the account. Only an explicit `value: null` is.
  if (!("result" in rpc) || rpc.result == null || !("value" in rpc.result)) {
    throw new Error(`Unrecognised Solana RPC response: ${JSON.stringify(body).slice(0, 200)}`);
  }
  const value = rpc.result.value;
  if (value === null) return null;
  const account = value as { owner?: unknown; executable?: unknown; lamports?: unknown };
  if (
    typeof account.owner !== "string" ||
    typeof account.executable !== "boolean" ||
    typeof account.lamports !== "number"
  ) {
    throw new Error(`Unrecognised Solana account shape: ${JSON.stringify(value).slice(0, 200)}`);
  }
  return {
    owner: account.owner,
    executable: account.executable,
    lamports: account.lamports,
  };
}

export const defaultSolanaDestinationProbe: SolanaDestinationProbe = {
  getAccountInfo: async (address) => {
    // What does and does not advance to the next endpoint is the whole safety property here.
    // A THROW is an endpoint failing to answer, so the next one gets a turn. A clean `null` is
    // an ANSWER — the account does not exist — and it is returned, never retried elsewhere:
    // asking a second endpoint until one says something different is how a fallback list turns
    // into a way to shop for the verdict you want.
    const failures: string[] = [];
    for (const rpcUrl of SOLANA_RPC_URLS) {
      try {
        return await fetchAccountInfoFrom(rpcUrl, address);
      } catch (e) {
        failures.push(`${rpcUrl}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Every endpoint failed ⇒ we know nothing, and the caller must fail closed. The message
    // carries all of them: "the RPC is down" is a very different page to a reader than "both
    // of the two free Solana endpoints are down", and the second one is what happened.
    throw new Error(`No Solana RPC could answer for ${address} — ${failures.join(" | ")}`);
  },
};

/** Why a Solana destination is refused, or the one reason it is merely flagged. */
export type SolanaDestinationProblem =
  /** An SPL token account. The bridge would derive an ATA of it; nobody could sign for that. */
  | "token-account"
  /** An executable program. It cannot hold a withdrawal for a person. */
  | "program-account"
  /** The read did not come back cleanly. Fails closed — see the class comment. */
  | "unverified";

export class SolanaDestinationUnusableError extends Error {
  constructor(
    readonly problem: SolanaDestinationProblem,
    readonly destinationAddress: string,
    readonly cause?: unknown
  ) {
    super(describeSolanaDestinationProblem(problem, destinationAddress));
    this.name = "SolanaDestinationUnusableError";
  }
}

function describeSolanaDestinationProblem(
  problem: SolanaDestinationProblem,
  address: string
): string {
  switch (problem) {
    case "token-account":
      return `"${address}" is an SPL token account, not a wallet; a withdrawal to it would be unrecoverable`;
    case "program-account":
      return `"${address}" is an executable program account, not a wallet`;
    case "unverified":
      return `Could not verify that "${address}" is a usable Solana wallet; not signing`;
  }
}

export type SolanaDestinationCheck = {
  /**
   * Set when the destination account does not exist yet. Advisory, NOT a refusal — see the
   * module comment and D-213. The caller shows it and lets the user through.
   */
  warning: "new-account" | null;
};

/**
 * Can this Solana address actually hold a withdrawal?
 *
 * Throws for the two shapes that are unrecoverable, and for a read it could not complete.
 * Returns a warning — never a throw — for an account that simply does not exist yet.
 */
export async function assertSolanaDestinationUsable(p: {
  destinationAddress: string;
  probe: SolanaDestinationProbe;
}): Promise<SolanaDestinationCheck> {
  let account: SolanaAccountInfo | null;
  try {
    account = await p.probe.getAccountInfo(p.destinationAddress);
  } catch (e) {
    throw new SolanaDestinationUnusableError("unverified", p.destinationAddress, e);
  }

  if (account === null) return { warning: "new-account" };

  if (account.executable) {
    throw new SolanaDestinationUnusableError("program-account", p.destinationAddress);
  }
  if (TOKEN_PROGRAM_IDS.includes(account.owner)) {
    throw new SolanaDestinationUnusableError("token-account", p.destinationAddress);
  }
  // Anything else owned by a program that is not the System Program is a data account of some
  // protocol. It is not obviously fatal — a smart-wallet account is a legitimate destination —
  // so it is flagged the same way a brand-new account is, rather than refused.
  if (account.owner !== SYSTEM_PROGRAM_ID) return { warning: "new-account" };

  return { warning: null };
}

/**
 * The rent-exemption invariant, checked as ARITHMETIC and not over the network.
 *
 * Returns false when the registry's own minimum stops guaranteeing that the smallest possible
 * native-SOL withdrawal lands a rent-exempt account. Nothing in the money path calls this —
 * it exists so the test suite fails the day a registry refresh erases the margin, instead of
 * the failure surfacing as a bounced mainnet withdrawal.
 */
export const SOL_RENT_EXEMPT_MINIMUM_LAMPORTS = 890_880;

export function nativeSolClearsRent(minWithdrawalRaw: string, withdrawalFeeRaw: string): boolean {
  const delivered = BigInt(minWithdrawalRaw) - BigInt(withdrawalFeeRaw);
  return delivered >= BigInt(SOL_RENT_EXEMPT_MINIMUM_LAMPORTS);
}
