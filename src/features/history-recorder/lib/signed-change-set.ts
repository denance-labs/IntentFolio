// What a composition edit said, read back from the vault call that carried it (plan 028-7,
// D-489): each token's new target, the tokens added, the tokens removed. Pure. The call comes
// from `vault_call` (008 decision 9): `portfolio_composition_changed` carries only ids, the
// change set travels in the signed call.
//
// Two calls carry one:
//   - `commit_portfolio_changes`: the change set IS the signed message (`args.payload`, a
//     MultiPayload, whatever the signature scheme);
//   - the vault's `on_auth` from `intents.near`: `op.allocate_into` of the AuthCallMsg, an
//     Allocate into an existing portfolio with edits in the same signature.
// `target_changes` is the ABSOLUTE new target (028-4 (d): replayed from each creation, 34 of 34
// edits sum to 10,000 bps that way; read as deltas, 28 fail).
//
// Promoted from `scripts/measure/account-history.measure.ts`, where it read 123 of 123 signed
// calls of both vaults across the six schemes seen (`nep413`, `erc191`, `tip191`,
// `raw_ed25519`, `sep53`, `ton_connect`).
//
// Attribution: see ATTRIBUTIONS.md #8 (IntentFolio vault contract serde — PortfolioChangeSet / AuthCallMsg).

export type SignedMessage = { standard: string; message: Record<string, unknown> | null; error: string | null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The signed message of a MultiPayload, whatever the scheme, as an object. */
export function readSignedMessage(multi: Record<string, unknown>): SignedMessage {
  const standard = String(multi.standard ?? "?");
  const payload = multi.payload;
  try {
    if (standard === "nep413") {
      const msg = (payload as { message?: unknown }).message;
      return { standard, message: JSON.parse(String(msg)) as Record<string, unknown>, error: null };
    }
    if (typeof payload === "string") {
      // erc191, tip191, raw_ed25519, … sign the JSON text itself.
      return { standard, message: JSON.parse(payload) as Record<string, unknown>, error: null };
    }
    if (payload && typeof payload === "object") {
      // webauthn / ton_connect / sep53 nest it one level deeper.
      const inner = (payload as Record<string, unknown>).payload ?? (payload as Record<string, unknown>).text;
      if (typeof inner === "string") return { standard, message: JSON.parse(inner) as Record<string, unknown>, error: null };
    }
    return { standard, message: null, error: "unknown payload shape" };
  } catch (e) {
    return { standard, message: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One token's target as signed: `bps` and `toleranceBps` out of 10,000. */
export type SignedTarget = { token: string; bps: number; toleranceBps: number };

/** One edit, in the vault's token ids. */
export type CompositionEdit = {
  /** Tokens already in the portfolio, each with its new target. */
  targets: SignedTarget[];
  /** Tokens added, each with its target. */
  added: SignedTarget[];
  removed: string[];
};

/** The op of the vault's `on_auth(signer_id, msg)`: the AuthCallMsg is a JSON string. */
function authOpOf(args: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const op = (JSON.parse(String(args.msg)) as { op?: unknown }).op;
    return isRecord(op) ? op : null;
  } catch {
    return null;
  }
}

/** The change set inside one kept call's arguments, or null when there is none to read. */
function changeSetOf(method: string, args: unknown): Record<string, unknown> | null {
  if (!isRecord(args)) return null;
  if (method === "commit_portfolio_changes") {
    return isRecord(args.payload) ? readSignedMessage(args.payload).message : null;
  }
  if (method === "on_auth") {
    const op = authOpOf(args);
    return op && isRecord(op.allocate_into) ? op.allocate_into : null;
  }
  return null;
}

const isBps = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000;

function targetsOf(list: unknown): SignedTarget[] | null {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  const out: SignedTarget[] = [];
  for (const t of list) {
    if (!Array.isArray(t) || typeof t[0] !== "string" || !isBps(t[1]) || !isBps(t[2])) return null;
    out.push({ token: t[0], bps: t[1], toleranceBps: t[2] });
  }
  return out;
}

/**
 * What the call signed for `portfolioId`, or null when it signed nothing for it, or something
 * this code cannot read whole — a half-read edit would show a composition that never was.
 */
export function compositionEditOf(method: string, args: unknown, portfolioId: string): CompositionEdit | null {
  const cs = changeSetOf(method, args);
  if (!cs || cs.portfolio_id !== portfolioId) return null;
  const targets = targetsOf(cs.target_changes);
  const added = targetsOf(cs.token_additions);
  const removals = cs.token_removals ?? [];
  if (!targets || !added || !Array.isArray(removals) || !removals.every((r) => typeof r === "string")) return null;
  if (targets.length + added.length + removals.length === 0) return null;
  return { targets, added, removed: removals as string[] };
}

/**
 * The whole composition a Setup signed (`on_auth`, `op.setup.composition`), or null when the
 * call is not a Setup or cannot be read whole.
 */
export function setupCompositionOf(method: string, args: unknown): SignedTarget[] | null {
  if (method !== "on_auth" || !isRecord(args)) return null;
  const setup = authOpOf(args)?.setup;
  if (!isRecord(setup) || !Array.isArray(setup.composition)) return null;
  const out: SignedTarget[] = [];
  for (const c of setup.composition) {
    if (!isRecord(c) || typeof c.token_id !== "string" || !isBps(c.target_bps) || !isBps(c.tolerance_bps)) return null;
    out.push({ token: c.token_id, bps: c.target_bps, toleranceBps: c.tolerance_bps });
  }
  return out;
}

/** The composition after `edit`: each target replaced (absolute, 028-4 (d)), additions appended, removals dropped. */
export function applyCompositionEdit(composition: SignedTarget[], edit: CompositionEdit): SignedTarget[] {
  const retarget = new Map(edit.targets.map((t) => [t.token, t]));
  const removed = new Set(edit.removed);
  return [
    ...composition.filter((t) => !removed.has(t.token)).map((t) => retarget.get(t.token) ?? t),
    ...edit.added,
  ];
}
