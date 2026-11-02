// "This Allocate's envelope never executed and never will" — the one proof that lets the app
// stop reporting an unsealed record as money in transit (D-312), and, since D-295, record that
// verdict for good.
//
// Shared by the My Account notice (`pending-allocates.ts`, read-only: it hides the row) and the
// hygiene sweep (`allocate-record-hygiene.ts`, which writes `failed`). The write is what makes
// the verdict outlive the proof: past the nonce's own deadline the Verifier may sweep it, an
// unused nonce stops being evidence, and a record that was only hidden would come back as
// "Still confirming" for the rest of the browser's life.

import type { AllocateRescueRecord } from "./allocate-rescue-store";
import { decodeV1Nonce } from "./vault-envelope";

/** `intents-read-client.ts` `readNonceWitness`; may throw — a throw is "cannot tell". */
export type ReadNonceWitness = (
  signerId: string,
  nonceBase64: string,
  saltHex: string
) => Promise<{ nonceUsed: boolean; saltValid: boolean }>;

/**
 * Slack past the envelope deadline before an unused nonce counts: the reads are at FINAL, a
 * couple of blocks behind a tx that was included just before its deadline.
 */
const FINALITY_MARGIN_SECS = 60;

export type EnvelopeWitness = { nonceBase64: string; envelopeDeadlineSecs: number };

/**
 * The envelope's V1 nonce and its deadline. From the record's own fields when it has them
 * (written since D-312), else from the signed envelope itself — records from before D-312 carry
 * both there, and those are exactly the ones stuck at `submitted` (D-295).
 *
 * The envelope is read by wire shape, not by trusting any field: NEP-413 keeps the nonce beside
 * the signed message and the deadline inside it; every other family signs one canonical JSON
 * string (`payload`, or `payload.text` for TON) holding both. Anything else — a shape this does
 * not know, JSON that does not parse, a deadline that is not a date — is `null`: no witness, so
 * no proof, so the record keeps being shown. Never throws.
 */
export function envelopeWitness(record: AllocateRescueRecord): EnvelopeWitness | null {
  if (record.verifierNonce !== undefined && record.envelopeDeadlineSecs !== undefined) {
    return { nonceBase64: record.verifierNonce, envelopeDeadlineSecs: record.envelopeDeadlineSecs };
  }
  try {
    const envelope = record.signedEnvelope as
      | { standard?: unknown; payload?: { nonce?: unknown; message?: unknown; text?: unknown } | string }
      | undefined;
    if (!envelope || envelope.payload === undefined) return null;
    const payload = envelope.payload;

    let nonce: unknown;
    let deadline: unknown;
    if (envelope.standard === "nep413" && typeof payload === "object") {
      nonce = payload.nonce;
      deadline = (JSON.parse(String(payload.message)) as { deadline?: unknown }).deadline;
    } else {
      const text = typeof payload === "string" ? payload : payload.text;
      if (typeof text !== "string") return null;
      ({ nonce, deadline } = JSON.parse(text) as { nonce?: unknown; deadline?: unknown });
    }

    if (typeof nonce !== "string" || typeof deadline !== "string") return null;
    const deadlineMs = Date.parse(deadline);
    if (!Number.isFinite(deadlineMs)) return null;
    return { nonceBase64: nonce, envelopeDeadlineSecs: Math.floor(deadlineMs / 1000) };
  } catch {
    return null;
  }
}

/**
 * Proof that the envelope NEVER executed and never will (D-312) — a relayer that refused, a
 * send that never landed, a tab closed between the signature and the submit. All four must
 * hold; anything missing or unreadable is not proof:
 *   - the envelope's nonce and deadline are known (`envelopeWitness`);
 *   - the envelope deadline has passed (+ margin): the Verifier would refuse it from now on;
 *   - the nonce's OWN deadline has not: past it, the Verifier may sweep a used nonce and
 *     `is_nonce_used` answers `false` for an envelope that did run (solver `921` §3 #3);
 *   - the salt is still valid (an invalidated salt's nonces may be swept too) and the nonce is
 *     unused.
 * The same criterion as the solver's reconciler (`reconciliation/main.ts`). Never throws.
 */
export async function provesNeverExecuted(
  record: AllocateRescueRecord,
  readNonceWitness: ReadNonceWitness,
  now: number
): Promise<boolean> {
  const witness = envelopeWitness(record);
  if (!witness) return false;
  const nonce = decodeV1Nonce(witness.nonceBase64);
  if (!nonce) return false;
  if (now <= (witness.envelopeDeadlineSecs + FINALITY_MARGIN_SECS) * 1000) return false;
  if (now >= nonce.deadlineSecs * 1000) return false;
  try {
    const read = await readNonceWitness(record.signerId, witness.nonceBase64, nonce.saltHex);
    return read.saltValid === true && read.nonceUsed === false;
  } catch {
    return false;
  }
}
