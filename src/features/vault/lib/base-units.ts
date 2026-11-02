// Human-unit -> base-unit conversion for the real vault path (007.plan, Phase 1).
//
// The mock ledger carries `qty` as a JS number in human units (1.5 USDC); the contract
// carries U128 base units as a decimal STRING ("1500000"). This is the boundary between
// the two, and it is money-critical, so it does NOT go through floating-point
// multiplication: `1.1 * 1e6` is 1100000.0000000002, and `0.29 * 1e2` is 28.999...
// Instead we work on the decimal representation and move the point by hand.
//
// Which decimal representation matters just as much (D-303). `toFixed(decimals + 1)` exposes
// the double's true binary expansion, so at 24 decimals 0.3 became 0.2999999999999999888977698
// and signed 299999999999999988897769 yocto instead of 3 × 10^23. The SHORTEST string that
// round-trips (`String(qty)`) is the number the user typed or saw, so that is what we read.
//
// Excess precision is TRUNCATED, never rounded up. That alone does NOT keep a transfer within
// the balance: a balance held as a float ("Max", the create flow's default) can sit a few units
// above OR below the exact on-chain figure. `capToHeld` settles both, against a fresh read.

export function toBaseUnits(qty: number, decimals: number): string {
  if (!Number.isFinite(qty)) throw new Error(`toBaseUnits: non-finite qty ${qty}`);
  if (qty < 0) throw new Error(`toBaseUnits: negative qty ${qty}`);
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`toBaseUnits: invalid decimals ${decimals}`);
  }

  const [whole, frac = ""] = shortestPlainDecimal(qty).split(".");

  // Truncate (not round) the fraction to `decimals`, then right-pad.
  const truncated = frac.slice(0, decimals).padEnd(decimals, "0");
  const digits = `${whole}${truncated}`.replace(/^0+(?=\d)/, "");
  return digits === "" ? "0" : digits;
}

// `String(qty)` without exponential notation: "1e-7" → "0.0000001", "1e+21" → "1000…0".
// The string path in `toBaseUnits` cannot read an exponent, and 18-decimal tokens make values
// below 1e-7 ordinary. Same digits as `String`, only the point is moved by hand.
function shortestPlainDecimal(qty: number): string {
  const s = String(qty);
  const match = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!match) return s;
  const [, intPart, fracPart = "", expPart] = match;
  const digits = intPart + fracPart;
  const point = intPart.length + Number(expPart); // position of the point within `digits`
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** The requested amount is more than the account holds, by more than float noise (D-303). */
export class AmountExceedsBalanceError extends Error {
  constructor(
    readonly requested: bigint,
    readonly held: bigint
  ) {
    super(
      `The amount to move (${requested} base units) is more than the balance ` +
        `(${held} base units). Refresh your balance and try again; nothing was signed.`
    );
    this.name = "AmountExceedsBalanceError";
  }
}

// Float noise: an amount derived from a float balance lands within a few parts in 10^16 of
// the exact figure. 10^-12 is far above that and far below any real difference in balance.
const NOISE_DENOMINATOR = BigInt(10) ** BigInt(12);

/**
 * The amount to sign, never above `held` — the balance read from the chain just before
 * signing (D-303). An amount within float noise of `held`, on EITHER side, is the user asking
 * for everything (Max, the create flow's default), and gets exactly `held`: above, so the
 * Verifier does not refuse it; below, so it leaves no dust behind. Further below is a partial
 * amount and passes as is. Further above means the screen and the chain disagree (a stale
 * balance), and signing a different amount than the one shown is not ours to decide: throw.
 */
export function capToHeld(requested: bigint, held: bigint): bigint {
  const gap = requested > held ? requested - held : held - requested;
  if (gap * NOISE_DENOMINATOR <= requested) return held;
  if (requested < held) return requested;
  throw new AmountExceedsBalanceError(requested, held);
}

export function fromBaseUnits(amount: bigint, decimals: number): number {
  if (decimals === 0) return Number(amount);
  const s = amount.toString().padStart(decimals + 1, "0");
  return Number(`${s.slice(0, -decimals)}.${s.slice(-decimals)}`);
}
