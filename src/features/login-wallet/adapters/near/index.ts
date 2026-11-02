// FamilyModule shape consumed by LoginWalletContext's lazy-mount (D-130).
// FamilyAdapterBridge is headless.
import type { ReactNode } from "react";

export { NearAdapterBridge as FamilyAdapterBridge } from "./near-bridge";

/**
 * A pass-through, not a second HOT Connect `NearProvider` (D-497). The root layout already
 * mounts `NearWalletProvider` for every family (`RealAllocateProvider` reads `useNearWallet()`
 * whichever wallet signed in), so the bridge reads that one. Wrapping it again here gave NEAR a
 * second connector, built inside the lazy mount's `<Suspense>`: every retry while the page
 * hydrated ran the provider's `useMemo` again, so a signed-in load built ~200 connectors, each
 * fetching the wallet manifest and adding its own window `message` listener.
 */
export function FamilyProvider({ children }: { children: ReactNode }) {
  return children;
}
