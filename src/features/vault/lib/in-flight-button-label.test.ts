import { describe, expect, it } from "vitest";
import { inFlightButtonLabel } from "./in-flight-button-label";

const t = { inFlightAwaitingSignature: "wallet", inFlightProcessing: "chain" };

// D-308: the wallet's turn until the signature is in, the chain's after.
describe("inFlightButtonLabel", () => {
  it.each([null, undefined, "preparing", "signing"] as const)("%s → waiting for the signature", (stage) => {
    expect(inFlightButtonLabel(stage, t)).toBe("wallet");
  });
  it.each(["submitting", "awaiting-credit", "credited", "pending-unconfirmed", "awaiting-settlement", "settled", "deferred"] as const)(
    "%s → processing",
    (stage) => {
      expect(inFlightButtonLabel(stage, t)).toBe("chain");
    }
  );
});
