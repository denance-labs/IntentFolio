// Ops alerting for the rescue-record write path (ADR-0017 §7, first of the three failures).
//
// ADR-0017 §7 splits the alerting three ways and gives each one to a different process:
//
//   1. The frontend's write path is broken   → THIS module, from the ingest route.
//   2. The seam is unreachable               → the solver's watchdog, which pings
//                                              `/api/ops/health` from outside this platform.
//   3. A record looks like a stranded orphan → the solver's watchdog, from the worklist.
//
// Only the first one belongs here, and the split is not bureaucratic: a watchdog hosted by the
// thing it watches goes down with it. That also settles what this module is allowed to be —
// the FAST signal, not the RELIABLE one. It runs inside a public unauthenticated route, so a
// caller who can provoke a failure can also keep this channel in "already alerted" state; the
// watchdog, which nobody but the operator can reach, is the one that cannot be suppressed.
// Losing an alert here is acceptable BECAUSE that second layer exists.
//
// SERVER ONLY. The bot token is a credential and must never reach the bundle.
//
// Fail-open throughout, and in the strong sense: `send` never throws and never rejects. It sits
// on the failure path of an Allocate that is already aborting, and an alerter that can throw
// would turn a bad write into a 500 with no body — replacing a diagnosable failure with a
// mystery. Attribution: see ATTRIBUTIONS.md #19.

export type OpsAlertSeverity = "warn" | "critical";

export type OpsAlert = {
  /** Stable identifier for the CONDITION, not the occurrence: it is the throttle key. */
  id: string;
  severity: OpsAlertSeverity;
  message: string;
};

export interface OpsAlertSink {
  send(alert: OpsAlert): Promise<void>;
}

export type OpsAlertConfig = {
  /** Null when the channel is not configured — the log is then the only sink. */
  telegram: { botToken: string; chatId: string } | null;
  /** Minimum spacing between repeats of the SAME alert id. */
  reAlertMs: number;
  /** Deadline on the Telegram POST. */
  requestTimeoutMs: number;
  /** Anything that looked half-configured, reported once at creation. */
  issues: string[];
};

/** Mirrors the solver watchdog's `INTENTFOLIO_OPS_WATCHDOG_REALERT_MS` default (30 min). */
export const DEFAULT_ALERT_REALERT_MS = 1_800_000;

/**
 * Deliberately short. This POST is awaited inside a request that has ALREADY failed, so it
 * costs the caller nothing it is still waiting for — the browser gave up at
 * `OPS_WRITE_BUDGET_MS` (1200ms) long before. It is awaited rather than fired and forgotten
 * because a serverless invocation can be frozen the moment the response is returned, which
 * would drop the alert exactly when the platform is on fire.
 */
export const DEFAULT_ALERT_TIMEOUT_MS = 2_500;

/** Ceiling on the throttle table. Alert ids are a closed set in code; this is belt-and-braces. */
const MAX_THROTTLE_KEYS = 64;

/** Alert text is a chat message, not a log: past this it is noise. */
const MAX_ALERT_DETAIL = 300;

export function readOpsAlertConfig(
  env: Record<string, string | undefined> = process.env
): OpsAlertConfig {
  const botToken = env.INTENTFOLIO_OPS_ALERT_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.INTENTFOLIO_OPS_ALERT_TELEGRAM_CHAT_ID?.trim();
  const issues: string[] = [];

  // Half-configured is a real deployment mistake and silently degrades to log-only, so it is
  // named. It is NOT an error: the log sink is a legitimate configuration.
  if (botToken && !chatId) issues.push("INTENTFOLIO_OPS_ALERT_TELEGRAM_CHAT_ID is missing");
  if (!botToken && chatId) issues.push("INTENTFOLIO_OPS_ALERT_TELEGRAM_BOT_TOKEN is missing");

  return {
    telegram: botToken && chatId ? { botToken, chatId } : null,
    reAlertMs: boundedInt(
      env.INTENTFOLIO_OPS_ALERT_REALERT_MS,
      DEFAULT_ALERT_REALERT_MS,
      0,
      86_400_000
    ),
    requestTimeoutMs: boundedInt(
      env.INTENTFOLIO_OPS_ALERT_TIMEOUT_MS,
      DEFAULT_ALERT_TIMEOUT_MS,
      250,
      10_000
    ),
    issues,
  };
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * Makes an arbitrary string safe to put in a chat message.
 *
 * Three separate jobs, and each one has already bitten this codebase or the solver's:
 *
 *   - **Credentials.** A `pg` connection failure is the most likely input here, and its
 *     message can carry the connection URL. `postgres://user:pass@host` becomes
 *     `postgres://***@host`. The bot token gets the same treatment at delivery, where the
 *     value is known.
 *   - **Control characters.** The destination renders the text; a newline-stuffed error can
 *     forge what looks like a second alert.
 *   - **Volume.** An alert is a nudge to go look, so it is truncated, not paginated.
 *
 * What it does NOT do is decide what is safe to SAY — that is the caller's job, and the rule
 * from ADR-0017 §8 is that `signer_id`, the portfolio name, tokens and amounts never enter
 * this channel. The record id may: it identifies the row without identifying the user.
 */
export function sanitiseForAlert(raw: unknown, max: number = MAX_ALERT_DETAIL): string {
  const text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw);
  const scrubbed = text
    // `//user:password@host` in any URL scheme.
    .replace(/\/\/[^\s/@]+:[^\s/@]*@/g, "//***@")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed;
}

export type OpsAlerterOptions = {
  config?: OpsAlertConfig;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
};

/**
 * Builds an alerter.
 *
 * The throttle is per-instance and in-memory, with the same caveat as the ingest route's rate
 * limiter: on a serverless platform there are N instances, so N alerts per window is the real
 * worst case, and a cold start forgets everything. It is a brake against a loop — the write is
 * fail-closed, so a database outage produces one failed write per Allocate ATTEMPT — not a
 * guarantee of exactly-once delivery. Nothing downstream depends on the count.
 */
export function createOpsAlerter(options: OpsAlerterOptions = {}): OpsAlertSink {
  const config = options.config ?? readOpsAlertConfig();
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m: string) => console.log(m));

  for (const issue of config.issues) {
    log(`[ops-alert] channel half-configured, falling back to log only: ${issue}`);
  }

  const lastSentAt = new Map<string, number>();

  function throttled(id: string): boolean {
    const previous = lastSentAt.get(id);
    const t = now();
    if (previous !== undefined && t - previous < config.reAlertMs) return true;
    // Prune before inserting so a long-lived instance cannot grow without bound.
    if (lastSentAt.size >= MAX_THROTTLE_KEYS) {
      for (const [key, at] of lastSentAt) {
        if (t - at >= config.reAlertMs) lastSentAt.delete(key);
      }
    }
    lastSentAt.set(id, t);
    return false;
  }

  async function deliverToTelegram(text: string): Promise<void> {
    const telegram = config.telegram;
    if (!telegram) return;
    // Defensively scrubs the bot token from anything logged: some undici error paths put the
    // request URL — and therefore the token — into the message or the `cause` chain.
    const mask = (s: string) => s.split(telegram.botToken).join("***");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetchFn(
        `https://api.telegram.org/bot${telegram.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: telegram.chatId, text }),
          signal: controller.signal,
        }
      );
      // Drained, not inspected: an unread body holds the socket out of undici's pool.
      await response.text().catch(() => undefined);
      if (!response.ok) {
        log(mask(`[ops-alert] Telegram refused the message: HTTP ${response.status}`));
      }
    } catch (e) {
      log(mask(`[ops-alert] delivery failed: ${sanitiseForAlert(e)}`));
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async send(alert: OpsAlert): Promise<void> {
      try {
        const line = `[OPS][${alert.severity.toUpperCase()}] ${alert.id} | ${alert.message}`;
        // The log is written on EVERY call, throttled or not. Throttling exists to keep a
        // chat readable; a suppressed alert that left no trace anywhere would turn an outage
        // into a silence with no evidence of how long it lasted.
        if (throttled(alert.id)) {
          log(`${line} (throttled, not delivered)`);
          return;
        }
        log(line);
        await deliverToTelegram(line);
      } catch (e) {
        // Belt-and-braces: everything above already handles its own failures. This exists so
        // that `send` CANNOT reject, which is what lets callers await it on a failure path
        // without a try/catch of their own.
        try {
          log(`[ops-alert] alerter failed: ${sanitiseForAlert(e)}`);
        } catch {
          /* a broken logger is not worth a second failure */
        }
      }
    },
  };
}

let sharedAlerter: OpsAlertSink | null = null;

/**
 * The process-wide alerter, so the throttle survives between invocations on a warm instance.
 * Same lifecycle as `getOpsDbPool`; `resetOpsAlerter` exists for tests only.
 */
export function getOpsAlerter(): OpsAlertSink {
  if (!sharedAlerter) sharedAlerter = createOpsAlerter();
  return sharedAlerter;
}

export function resetOpsAlerter(): void {
  sharedAlerter = null;
}
