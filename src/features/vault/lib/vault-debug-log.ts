// D-472: a signed vault envelope is submittable by ANY account until its deadline (600 s) — the
// signature is the authorization, not the caller. Logged to the console by default, it reached
// any extension or screenshot of devtools, and a user who signed and then cancelled in the wallet
// could still see the change applied by whoever held the text. So the logs that carry one are
// opt-in, per browser:
//   localStorage.setItem("vault.debug-envelopes", "1")
// That keeps the operator-as-relayer escape hatch (D-R1) for whoever turns it on deliberately.

export const VAULT_DEBUG_ENVELOPES_KEY = "vault.debug-envelopes";

/** Whether this browser opted into logging signed envelopes. Off when storage is unavailable. */
export function vaultEnvelopeLogEnabled(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(VAULT_DEBUG_ENVELOPES_KEY) === "1";
  } catch {
    return false;
  }
}

/** `console.log` for a line that carries a signed envelope: silent unless opted in. */
export function logSignedEnvelope(message: string, value: unknown): void {
  if (vaultEnvelopeLogEnabled()) console.log(message, value);
}
