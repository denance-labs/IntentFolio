"use client";

/**
 * FamilyProvider for the Stellar family.
 * Freighter is a browser extension — no React context is required.
 * This is a passthrough so the FamilyModule shape is satisfied.
 */
export function StellarWalletProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
