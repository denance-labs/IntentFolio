"use client";

// Live countdown to a real position's withdrawal window (007.plan, Phase 2; 017-9a).
//
// The deadline is the chain's (`get_portfolio_positions`, position-maturity.ts), counted down
// once a second while the window is still closed. The status it returns gates the Confirm
// button of a withdrawal from a real portfolio. Read when the watched set changes and again
// when the countdown runs out, since a reconcile may have restarted the clock meanwhile.
//
// Starts as "matured, unknown" and a failed read errs open: the gate is a courtesy, and the
// chain defers a premature commit anyway.

import { useEffect, useState } from "react";
import { maturityFromPositions, type MaturityStatus } from "../lib/position-maturity";
import { getPortfolioPositions, type PortfolioPosition } from "../lib/vault-read-client";

type ChainOptions = {
  readPositions?: (portfolioId: string) => Promise<PortfolioPosition[] | null>;
};

const OPEN: MaturityStatus = { matured: true, remainingSecs: 0, known: false };

export function useMaturityCountdown(
  portfolioId: string | null,
  tokenIds: string[],
  enabled = true,
  { readPositions = getPortfolioPositions }: ChainOptions = {}
): MaturityStatus {
  // Stable dependency: the caller rebuilds the array on every render.
  const tokenKey = tokenIds.join("|");
  const [status, setStatus] = useState<MaturityStatus>(OPEN);

  useEffect(() => {
    if (!enabled || !portfolioId || tokenKey === "") {
      setStatus(OPEN);
      return;
    }
    const tokens = tokenKey.split("|");
    const nowSecs = () => Math.floor(Date.now() / 1000);

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = async () => {
      let positions: PortfolioPosition[] | null;
      try {
        positions = await readPositions(portfolioId);
      } catch {
        if (!cancelled) setStatus(OPEN);
        return;
      }
      if (cancelled) return;
      const held = positions ?? [];
      const current = maturityFromPositions(held, tokens, nowSecs());
      setStatus(current);
      if (current.matured) return;
      timer = setInterval(() => {
        const next = maturityFromPositions(held, tokens, nowSecs());
        if (!next.matured) {
          setStatus(next);
          return;
        }
        // Ran out by our clock: ask the chain before opening the gate.
        clearInterval(timer);
        void load();
      }, 1000);
    };
    void load();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [portfolioId, tokenKey, enabled, readPositions]);

  return status;
}

/** `4:37` — the countdown as shown in the copy. Minutes are not zero-padded. */
export function formatCountdown(totalSecs: number): string {
  const safe = Math.max(0, Math.ceil(totalSecs));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
