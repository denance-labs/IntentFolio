// Sanitizer for the free-text amount fields (008.plan Phase 2).
//
// Why these fields are NOT `<input type="number">`: a controlled number input hands back
// `""` for anything the BROWSER considers invalid mid-typing, and what counts as invalid
// depends on the user's locale. Under es-AR a decimal POINT is invalid, so typing "1.75"
// produced `value === ""` → the state fell to 0 → the controlled input erased what had
// been typed. Losing the amount on a keystroke, in a withdrawal dialog, is not a
// cosmetic problem — and it is not fixable while the browser owns the parsing.
//
// So the field carries text, this owns the grammar, and both separators are accepted:
// people type the one their keyboard and their habits give them.

/** Everything the field is allowed to contain, canonicalised to a `.` separator. */
export function sanitizeDecimalInput(raw: string): string {
  // Comma → point first: both are decimal separators to a user, only one parses.
  let out = raw.replace(/,/g, ".").replace(/[^\d.]/g, "");

  // Keep the FIRST separator, drop the rest — "1.7.5" is a typo, not a number.
  const firstDot = out.indexOf(".");
  if (firstDot !== -1) {
    out = out.slice(0, firstDot + 1) + out.slice(firstDot + 1).replace(/\./g, "");
  }

  // Strip leading zeros ("007" → "7") but never the meaningful one in "0" or "0.5".
  out = out.replace(/^0+(?=\d)/, "");

  return out;
}

/**
 * Number for the model, clamped to `[0, max]`.
 *
 * An incomplete-but-legal entry — "", ".", "1." while the user is still typing — is worth
 * 0 to the model while the FIELD keeps the text. That split is the whole point: the model
 * never sees NaN, and the user never sees their typing rewritten.
 */
export function parseDecimalInput(sanitized: string, max: number): number {
  const value = Number.parseFloat(sanitized);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, value));
}

/**
 * Number → field text, WITHOUT exponential notation.
 *
 * `String(1e-9)` is `"1e-9"`, and the sanitizer above would strip the `e-` and leave
 * `"19"` — turning a dust balance into nineteen tokens. Tokens carry up to 18 decimals,
 * so values below the 1e-7 threshold where JS switches to exponent form are ordinary here,
 * not exotic. Every number that reaches the field goes through this.
 */
export function formatDecimalForInput(value: number): string {
  if (!Number.isFinite(value)) return "";

  // `String` first: it yields the SHORTEST representation that round-trips, which is the
  // one the user recognises. `toFixed` cannot be used as the general path — it exposes the
  // float's true expansion, rendering 0.00013 as "0.00012999999999999999" in the field.
  const s = String(value);
  if (!/e/i.test(s)) return s;

  // Exponential: expand by hand. Only the negative exponent needs it — a positive one means
  // ≥1e21, where `String` is already non-exponential for the integers we could see.
  const [mantissa, expPart] = s.split(/e/i);
  const exp = Number(expPart);
  if (exp >= 0) return value.toFixed(0);

  const [intPart, fracPart = ""] = mantissa.split(".");
  const digits = intPart + fracPart;
  return "0." + "0".repeat(-exp - intPart.length) + digits;
}

// The field never shows more than this, whatever the token carries (24 for NEAR).
const PERCENT_CHIP_MAX_DECIMALS = 8;

/**
 * Field text for a percent chip (25/50/75 %): that share of `available`, cut DOWN to what the
 * token can hold (D-485). Half of 0.351649 USDC (6 decimals) is "0.175824", not "0.1758245" —
 * the 7th decimal cannot be signed, so showing it showed an amount that is not the one moved.
 * Cut down, never rounded up: the chip must not offer more than that share. Max is not this
 * (D-315): it is the whole balance, formatted as is.
 */
export function percentChipAmount(available: number, pct: number, tokenDecimals: number): string {
  const places = Math.max(0, Math.min(tokenDecimals, PERCENT_CHIP_MAX_DECIMALS));
  const scale = 10 ** places;
  // The 9-place `toFixed` first absorbs float noise (0.3 × 100 = 29.999999999999996) so
  // the floor does not drop a unit that is really there.
  const units = Math.floor(Number(((available * pct) / 100 * scale).toFixed(9)) + 1e-9);
  return formatDecimalForInput(units / scale);
}
