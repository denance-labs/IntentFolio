// Who actually sends the signed envelope (008.plan, Phase 0).
//
// Splitting "sign" from "send" is what made the relayer a small change instead of a rewrite:
// `allocate-submit.ts` and `unallocate-submit.ts` already kept the two apart, so rerouting the
// send touches neither the envelope construction nor the signature.
//
// Two implementations, and the difference is NOT cosmetic:
//   - `walletSubmitter` — the user's own NEAR wallet pays the gas. Only possible for the NEAR
//     family, and kept because it is the CONTROL the relayer path is compared against.
//   - `relaySubmitter` (relay-client.ts) — a service account pays. The only option for the five
//     non-NEAR families, whose identity is a ledger row with no keys and no native balance.

import { RELAY_DESTINATIONS, RELAY_GAS, type EnvelopeSubmitter } from "./relay-types";
import { VAULT_RELAY_ENABLED } from "./vault-flag";
import { relaySubmitter } from "./relay-client";

/** The slice of the wallet a self-submit needs. */
export type WalletSubmitCapability = {
  signAndSendTransaction: (params: { receiverId: string; actions: unknown[] }) => Promise<unknown>;
};

export function walletSubmitter(wallet: WalletSubmitCapability): EnvelopeSubmitter {
  return ({ target, payload }) => {
    const destination = RELAY_DESTINATIONS[target];
    return wallet.signAndSendTransaction({
      receiverId: destination.receiverId,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: destination.methodName,
            args: destination.buildArgs(payload),
            gas: RELAY_GAS,
            deposit: "0",
          },
        },
      ],
    });
  };
}

/**
 * Whether this login family sends through the relayer.
 *
 * Non-NEAR: always. Not a policy choice — there is nothing else to send from.
 * NEAR: only behind `NEXT_PUBLIC_VAULT_RELAY`, so the self-submit path stays the default
 * control. It also removes the ~0.30 NEAR gas hold from the NEAR user when enabled, which is
 * why the flag exists at all rather than the answer being a flat "NEAR self-submits".
 */
export function usesRelay(loginChain: string | null | undefined): boolean {
  if (loginChain !== "near") return true;
  return VAULT_RELAY_ENABLED;
}

/**
 * The submitter for a login family. `wallet` may be null for non-NEAR families, which have no
 * NEAR wallet to fall back to — hence the throw rather than a silent self-submit attempt.
 */
export function resolveEnvelopeSubmitter(params: {
  loginChain: string | null | undefined;
  wallet: WalletSubmitCapability | null;
}): EnvelopeSubmitter {
  if (usesRelay(params.loginChain)) return relaySubmitter();
  if (!params.wallet) {
    throw new Error(`No way to submit: ${params.loginChain ?? "unknown"} has no NEAR wallet and the relayer is off`);
  }
  return walletSubmitter(params.wallet);
}
