// Use when no price is available — precision based on value magnitude.
export function formatCrypto(value: number) {
  const numeric = Number(value) || 0;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: numeric >= 1000 ? 2 : numeric >= 100 ? 3 : 6
  }).format(numeric);
}

// Use when price is known — precision based on token price, not quantity magnitude.
export function formatTokenAmount(value: number, price: number) {
  const numeric = Number(value) || 0;
  const p = Number(price) || 0;
  const decimals = p >= 1000 ? 5 : p >= 100 ? 4 : p >= 1 ? 3 : 2;

  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals
  }).format(numeric);

  // Dust: value is positive but rounds to all-zeros at this precision.
  if (numeric > 0 && !formatted.replace(/[,0.]/g, "")) {
    const unit = (1 / Math.pow(10, decimals)).toFixed(decimals);
    return "<" + unit;
  }

  return formatted;
}

export function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value) || 0);
}

// 11 Tailwind colors in a fixed order, picked and ordered with the dataviz palette
// validator (OKLab ΔE×100 on the card surface): the first 6 slots stay pairwise
// apart (normal vision ≥ 15.8, protan/deutan ≥ 8.3), and consecutive slots — which
// sit next to each other in the donut — stay ≥ 17 apart (≥ 10 protan/deutan) all
// the way round, last-to-first included. Steps
// are mixed (400/500/600) on purpose: lightness is a second channel beside hue.
// Red is left out so a slice never reads as an error state (D-509).
const colorRing = [
  { hex: "#d97706", bg: "bg-amber-600" },    // amber
  { hex: "#818cf8", bg: "bg-indigo-400" },   // indigo
  { hex: "#14b8a6", bg: "bg-teal-500" },     // teal
  { hex: "#db2777", bg: "bg-pink-600" },     // pink
  { hex: "#84cc16", bg: "bg-lime-500" },     // lime
  { hex: "#c026d3", bg: "bg-fuchsia-600" },  // fuchsia
  { hex: "#fb7185", bg: "bg-rose-400" },     // rose
  { hex: "#38bdf8", bg: "bg-sky-400" },      // sky
  { hex: "#16a34a", bg: "bg-green-600" },    // green
  { hex: "#0891b2", bg: "bg-cyan-600" },     // cyan
  { hex: "#8b5cf6", bg: "bg-violet-500" }    // violet
];

export function colorForSymbol(symbol: string) {
  if (!symbol) return colorRing[0];
  let hash = 0;
  for (let index = 0; index < symbol.length; index += 1) {
    hash = (hash * 31 + symbol.charCodeAt(index)) >>> 0;
  }
  return colorRing[hash % colorRing.length];
}

export type RingColor = (typeof colorRing)[number];

/**
 * Assigns a distinct ring color to each token by position in the given set,
 * instead of hashing. Keyed by token id, not symbol: two tokens can share a
 * symbol (ETH on Ethereum and ETH on NEAR) and must still get two colors.
 * With ≤ colorRing.length tokens every token gets a unique color. Pass a
 * stable, de-duplicated order so the donut arcs, legend and table chips agree.
 */
export function buildTokenColorMap(tokenIds: string[]): Map<string, RingColor> {
  const map = new Map<string, RingColor>();
  let next = 0;
  for (const tokenId of tokenIds) {
    if (!tokenId || map.has(tokenId)) continue;
    map.set(tokenId, colorRing[next % colorRing.length]);
    next += 1;
  }
  return map;
}

export function formatTime(value: string | null) {
  if (!value) return "Pending";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}
