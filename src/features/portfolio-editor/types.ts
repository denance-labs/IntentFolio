import type { TokenWithPrice } from "../market/types";

export type Language = "en" | "es";

export type TargetAllocation = {
  id: string;      // row UUID — not the token id
  tokenId: string; // primary key — references TokenDefinition.id
  targetPct: number | "";
  tolerancePct: number | "";
  locked: boolean;
};

export type ComputedTargetAllocation = TargetAllocation & {
  symbol: string;  // display — derived from token.symbol ?? tokenId
  token: TokenWithPrice | null;
  hasToken: boolean;
  targetPct: number;
  tolerancePct: number;
  minPct: number;
  maxPct: number;
  targetUsd: number;
  currentUsd: number;
  // Held quantity, independent of price: a token priced at 0 still has a balance (D-322),
  // so "is there anything to withdraw" must not be read off currentUsd.
  currentQty: number;
  currentPct: number;
  bandState: BandState;
  differenceUsd: number;
  cryptoAmount: number;
  // D-143(1): set on rows that are held in the portfolio but have no target
  // (current > 0, target 0%). They render in the table as 0% target rows (D-513) so the
  // table matches the donut superset; giving one a % promotes it to a real target.
  heldNoTarget?: boolean;
};

// Both the donut/legend and the targets table now consume the same superset of rows
// (target rows + held-no-target rows), so a held token can never appear in one but
// not the other (D-143(1)). Held-no-target rows are full ComputedTargetAllocation
// objects flagged with heldNoTarget.
export type ChartRow = ComputedTargetAllocation;

export type BandState = "below" | "above" | "inside" | "empty";

// Keys are TokenDefinition.id (asset id), not symbol.
export type CurrentPortfolioQty = Record<string, number>;

export type WithdrawDialogState = {
  id: string;      // target row UUID
  tokenId: string; // asset id — used as key in WithdrawnQty
  symbol: string;  // display only
  maxAmount: number;
  maxUsd: number;
  price: number;
  amount: number;
  /**
   * What the FIELD shows. Held separately from `amount` because a half-typed number
   * ("1.", "0.") has no numeric value yet must survive the keystroke — see
   * `lib/decimal-input.ts` for why the browser cannot be trusted to do this.
   */
  raw: string;
} | null;

// Keys are TokenDefinition.id (asset id), not symbol.
export type WithdrawnQty = Record<string, number>;

export type ToastState = {
  kind: "warn" | "neutral";
  text: string;
  /** How long it stays up. Defaults to a short confirmation; an outcome with amounts the user
   *  has to read (D-314) asks for longer. */
  durationMs?: number;
} | null;
