// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import {
  createOpsAlerter,
  readOpsAlertConfig,
  sanitiseForAlert,
  DEFAULT_ALERT_REALERT_MS,
  DEFAULT_ALERT_TIMEOUT_MS,
  type OpsAlertConfig,
} from "./ops-alerts";

const TOKEN = "123456:AAH-fake-bot-token";

function config(over: Partial<OpsAlertConfig> = {}): OpsAlertConfig {
  return {
    telegram: { botToken: TOKEN, chatId: "-100777" },
    reAlertMs: 1_000,
    requestTimeoutMs: 2_000,
    issues: [],
    ...over,
  };
}

/** A `fetch` double that records calls and answers 200 unless told otherwise. */
function fakeFetch(impl?: () => Promise<unknown>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    if (impl) return impl();
    return { ok: true, status: 200, text: async () => "{}" };
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("readOpsAlertConfig", () => {
  it("enables Telegram only when both the token and the chat id are present", () => {
    const both = readOpsAlertConfig({
      INTENTFOLIO_OPS_ALERT_TELEGRAM_BOT_TOKEN: TOKEN,
      INTENTFOLIO_OPS_ALERT_TELEGRAM_CHAT_ID: "-100777",
    });
    expect(both.telegram).toEqual({ botToken: TOKEN, chatId: "-100777" });
    expect(both.issues).toEqual([]);
  });

  it("degrades to log-only and NAMES the missing half when half-configured", () => {
    const tokenOnly = readOpsAlertConfig({ INTENTFOLIO_OPS_ALERT_TELEGRAM_BOT_TOKEN: TOKEN });
    expect(tokenOnly.telegram).toBeNull();
    expect(tokenOnly.issues).toEqual(["INTENTFOLIO_OPS_ALERT_TELEGRAM_CHAT_ID is missing"]);

    const chatOnly = readOpsAlertConfig({ INTENTFOLIO_OPS_ALERT_TELEGRAM_CHAT_ID: "-1" });
    expect(chatOnly.telegram).toBeNull();
    expect(chatOnly.issues).toEqual(["INTENTFOLIO_OPS_ALERT_TELEGRAM_BOT_TOKEN is missing"]);
  });

  it("falls back to the defaults for absent, non-integer and out-of-range tuning", () => {
    for (const raw of [undefined, "", "abc", "1.5", "-1", "999999999"]) {
      const c = readOpsAlertConfig({ INTENTFOLIO_OPS_ALERT_TIMEOUT_MS: raw });
      expect(c.requestTimeoutMs, `timeout for ${String(raw)}`).toBe(DEFAULT_ALERT_TIMEOUT_MS);
    }
    expect(readOpsAlertConfig({}).reAlertMs).toBe(DEFAULT_ALERT_REALERT_MS);
    expect(readOpsAlertConfig({ INTENTFOLIO_OPS_ALERT_REALERT_MS: "60000" }).reAlertMs).toBe(60_000);
    // 0 is IN range: it is how an operator disables the throttle deliberately.
    expect(readOpsAlertConfig({ INTENTFOLIO_OPS_ALERT_REALERT_MS: "0" }).reAlertMs).toBe(0);
  });
});

describe("sanitiseForAlert", () => {
  it("masks credentials in a connection URL", () => {
    const out = sanitiseForAlert(
      'password authentication failed: postgres://intentfolio_ops_writer:s3cr3t@db.example.com:6432/intentfolio'
    );
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("intentfolio_ops_writer");
    expect(out).toContain("//***@db.example.com:6432/intentfolio");
  });

  it("collapses newlines and control characters so a message cannot forge a second alert", () => {
    const out = sanitiseForAlert("boom\n\n[OPS][CRITICAL] ops_fake | everything is fine");
    expect(out).toBe("boom [OPS][CRITICAL] ops_fake | everything is fine");
    expect(out).not.toContain("\n");
  });

  it("truncates past the ceiling and marks it", () => {
    const out = sanitiseForAlert("x".repeat(500));
    expect(out).toHaveLength(301);
    expect(out.endsWith("…")).toBe(true);
  });

  it("accepts an Error, and anything else, without throwing", () => {
    expect(sanitiseForAlert(new Error("nope"))).toBe("nope");
    expect(sanitiseForAlert(undefined)).toBe("undefined");
    expect(sanitiseForAlert({ a: 1 })).toBe("[object Object]");
  });
});

describe("createOpsAlerter", () => {
  it("posts the alert to Telegram's sendMessage with the configured chat", async () => {
    const fetchFn = fakeFetch();
    const alerter = createOpsAlerter({ config: config(), fetchFn: fetchFn.fn, log: () => {} });

    await alerter.send({ id: "ops_write_failed", severity: "critical", message: "the write failed" });

    expect(fetchFn.calls).toHaveLength(1);
    expect(fetchFn.calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(String(fetchFn.calls[0].init.body));
    expect(body.chat_id).toBe("-100777");
    expect(body.text).toBe("[OPS][CRITICAL] ops_write_failed | the write failed");
    expect(fetchFn.calls[0].init.signal).toBeDefined();
  });

  it("throttles a repeat of the SAME id, and lets a different id through", async () => {
    const fetchFn = fakeFetch();
    let clock = 0;
    const alerter = createOpsAlerter({
      config: config({ reAlertMs: 1_000 }),
      fetchFn: fetchFn.fn,
      now: () => clock,
      log: () => {},
    });

    await alerter.send({ id: "a", severity: "critical", message: "1" });
    clock = 999;
    await alerter.send({ id: "a", severity: "critical", message: "2" });
    expect(fetchFn.calls).toHaveLength(1);

    // A different condition is never suppressed by another one's window.
    await alerter.send({ id: "b", severity: "warn", message: "3" });
    expect(fetchFn.calls).toHaveLength(2);

    // ...and the first one repeats once its window has passed.
    clock = 1_000;
    await alerter.send({ id: "a", severity: "critical", message: "4" });
    expect(fetchFn.calls).toHaveLength(3);
  });

  it("still LOGS a throttled alert — a silent suppression leaves no trace of the outage", async () => {
    const fetchFn = fakeFetch();
    const lines: string[] = [];
    const alerter = createOpsAlerter({
      config: config({ reAlertMs: 60_000 }),
      fetchFn: fetchFn.fn,
      now: () => 0,
      log: (m) => lines.push(m),
    });

    await alerter.send({ id: "a", severity: "critical", message: "first" });
    await alerter.send({ id: "a", severity: "critical", message: "second" });

    expect(fetchFn.calls).toHaveLength(1);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("second");
    expect(lines[1]).toContain("(throttled, not delivered)");
  });

  it("logs and does not deliver when no channel is configured", async () => {
    const fetchFn = fakeFetch();
    const lines: string[] = [];
    const alerter = createOpsAlerter({
      config: config({ telegram: null }),
      fetchFn: fetchFn.fn,
      log: (m) => lines.push(m),
    });

    await alerter.send({ id: "a", severity: "warn", message: "hello" });

    expect(fetchFn.calls).toHaveLength(0);
    expect(lines).toEqual(["[OPS][WARN] a | hello"]);
  });

  it("reports a half-configured channel once, at creation", () => {
    const lines: string[] = [];
    createOpsAlerter({
      config: config({ telegram: null, issues: ["INTENTFOLIO_OPS_ALERT_TELEGRAM_CHAT_ID is missing"] }),
      fetchFn: fakeFetch().fn,
      log: (m) => lines.push(m),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("falling back to log only");
    expect(lines[0]).toContain("CHAT_ID");
  });

  describe("fail-open", () => {
    it("does not reject when the delivery throws", async () => {
      const fetchFn = fakeFetch(() => Promise.reject(new Error("socket hang up")));
      const lines: string[] = [];
      const alerter = createOpsAlerter({
        config: config(),
        fetchFn: fetchFn.fn,
        log: (m) => lines.push(m),
      });

      await expect(
        alerter.send({ id: "a", severity: "critical", message: "boom" })
      ).resolves.toBeUndefined();
      expect(lines.some((l) => l.includes("delivery failed") && l.includes("socket hang up"))).toBe(true);
    });

    it("does not reject when Telegram answers non-2xx", async () => {
      const fetchFn = fakeFetch(async () => ({ ok: false, status: 429, text: async () => "slow down" }));
      const lines: string[] = [];
      const alerter = createOpsAlerter({
        config: config(),
        fetchFn: fetchFn.fn,
        log: (m) => lines.push(m),
      });

      await expect(
        alerter.send({ id: "a", severity: "critical", message: "boom" })
      ).resolves.toBeUndefined();
      expect(lines.some((l) => l.includes("Telegram refused the message: HTTP 429"))).toBe(true);
    });

    it("does not reject when the LOGGER itself throws", async () => {
      const alerter = createOpsAlerter({
        config: config({ telegram: null }),
        fetchFn: fakeFetch().fn,
        log: () => {
          throw new Error("logger is gone");
        },
      });
      await expect(
        alerter.send({ id: "a", severity: "warn", message: "x" })
      ).resolves.toBeUndefined();
    });
  });

  it("never lets the bot token reach the log, even when the error quotes the URL", async () => {
    // undici puts the request URL — and therefore the token — into some error messages.
    const fetchFn = fakeFetch(() =>
      Promise.reject(new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`))
    );
    const lines: string[] = [];
    const alerter = createOpsAlerter({
      config: config(),
      fetchFn: fetchFn.fn,
      log: (m) => lines.push(m),
    });

    await alerter.send({ id: "a", severity: "critical", message: "boom" });

    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.some((l) => l.includes("***"))).toBe(true);
  });
});
