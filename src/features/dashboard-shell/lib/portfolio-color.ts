export type PortfolioColor = {
  /** The portfolio's name in its tab. */
  text: string;
  /** A dot of the same hue (the mobile select, which cannot color an option). */
  dot: string;
};

// 021 R5: one hue per portfolio, from a fixed list. Written out in full so Tailwind sees each
// class. The 300 shades all read over 7:1 on the app's base, surface and card levels. None is
// near the bone accent, which marks what is selected (e.g. My Account). Cyan stays out (it was
// the accent before D-571), and so do red and amber (the app's error and warning colors). Ordered so neighbours sit far apart on the wheel:
// consecutive vault ids get clearly different colors.
const PALETTE: readonly PortfolioColor[] = [
  { text: "text-sky-300", dot: "bg-sky-300" },
  { text: "text-orange-300", dot: "bg-orange-300" },
  { text: "text-emerald-300", dot: "bg-emerald-300" },
  { text: "text-pink-300", dot: "bg-pink-300" },
  { text: "text-yellow-300", dot: "bg-yellow-300" },
  { text: "text-violet-300", dot: "bg-violet-300" },
  { text: "text-lime-300", dot: "bg-lime-300" },
  { text: "text-fuchsia-300", dot: "bg-fuchsia-300" },
];

/**
 * The portfolio's color, derived from its id alone: the same on every device and after a
 * reload, with nothing to store, and a portfolio built from scratch gets one like any other.
 *
 * A vault id (`p_` + hex index) maps by its index, so portfolios the vault issued one after
 * another differ (the counter is global, so a user's own are often but not always neighbours). Anything else (mock ids) by a string hash. Two portfolios can still share a
 * color — the list is short on purpose; the name is what tells them apart.
 */
export function portfolioColor(portfolioId: string): PortfolioColor {
  // `p_` + 12 hex digits, as `portfolioIndexOf` (vault lib) reads it — not imported, so this
  // module does not pull the vault client in with it.
  const vaultIndex = /^p_([0-9a-f]{12})$/.exec(portfolioId);
  const index = vaultIndex ? Number.parseInt(vaultIndex[1], 16) : hashString(portfolioId);
  return PALETTE[index % PALETTE.length];
}

// FNV-1a, 32 bits: deterministic and spreads short ids like `mock-1`, `mock-2` well.
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
