import type { RealAllocateStage } from "./run-real-allocate";
import type { RealUnallocateStage } from "./run-real-unallocate";

// D-308: while an attempt is in flight the primary button says whose turn it is — the
// wallet's, then the chain's — instead of "Signing…" through a credit poll that can take
// minutes. The stage line above the buttons names the leg; this only follows it.
//
// No stage (the mock path, or the instant before the live path reports one) and `preparing`
// both read as the wallet's turn: the popup is what comes next.
export function inFlightButtonLabel(
  stage: RealAllocateStage | RealUnallocateStage | null | undefined,
  t: { inFlightAwaitingSignature: string; inFlightProcessing: string }
): string {
  return !stage || stage === "preparing" || stage === "signing" ? t.inFlightAwaitingSignature : t.inFlightProcessing;
}
