"use client";

/**
 * FamilyProvider for the Tron family.
 * TronLink is an injected browser extension — no React context is required.
 * This is a passthrough so the FamilyModule shape is satisfied.
 */
export function TronWalletProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
