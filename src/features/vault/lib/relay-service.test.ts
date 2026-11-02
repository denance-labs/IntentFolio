import { describe, expect, it, vi } from "vitest";
import { INTENTS_CONTRACT_ID, VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import { RELAY_GAS } from "./relay-types";
import {
  createRelayLedger,
  createRelaySentRegistry,
  describeEnvelopeSigner,
  formatNear,
  handleRelayRequest,
  readRelayConfig,
  readRelayPaused,
  RELAY_SENT_TTL_MS,
  RelayOutcomeUnknownError,
  sumTokensBurnt,
  type RelayConfig,
  type RelaySender,
} from "./relay-service";
import type { RelayGate } from "./relay-gate";

/**
 * The envelope checks are relay-gate.ts's business; here they pass unless a test says otherwise.
 * A fresh replay key per call, so the process-wide sent registry never sees a repeat by accident.
 */
let replayCounter = 0;
const passGate: RelayGate = vi.fn(async () => ({
  ok: true as const,
  signerId: "denance02.near",
  replayKey: `denance02.near:${++replayCounter}`,
}));

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    accountId: "relayer.near",
    privateKeys: {
      verifier: ["ed25519:verifier"],
      vault: ["ed25519:vault"],
    },
    paused: false,
    maxRequests: 10,
    maxSpendNear: 0.5,
    ...overrides,
  };
}

/** A NEP-413 MultiPayload signed for the Verifier — the ② Allocate shape. */
function nep413Payload(recipient: string, signerId = "denance02.near") {
  return {
    standard: "nep413",
    payload: {
      message: JSON.stringify({ signer_id: signerId, deadline: "2026-07-28T00:00:00.000Z" }),
      nonce: "base64nonce",
      recipient,
    },
    public_key: "ed25519:abc",
    signature: "ed25519:sig",
  };
}

/** An ERC-191 MultiPayload: the payload is a JSON STRING, not an object. */
function erc191Payload(verifyingContract: string) {
  return {
    standard: "erc191",
    payload: JSON.stringify({
      signer_id: "0xabc0000000000000000000000000000000000000",
      verifying_contract: verifyingContract,
      deadline: "2026-07-28T00:00:00.000Z",
    }),
    signature: "0xdeadbeef",
  };
}

function okOutcome(hash = "TxHash111") {
  return {
    transaction_outcome: { id: hash, outcome: { tokens_burnt: "1000000000000000000000" } },
    receipts_outcome: [{ outcome: { tokens_burnt: "40000000000000000000" } }],
    status: { SuccessValue: "" },
  };
}

function senderReturning(outcome: unknown): RelaySender {
  return vi.fn().mockResolvedValue(outcome);
}

const silent = () => {};

describe("readRelayConfig", () => {
  it("reports exactly which variables are missing", () => {
    expect(readRelayConfig({})).toEqual({
      ok: false,
      issues: [
        "missing RELAYER_ACCOUNT_ID",
        "missing RELAYER_VERIFIER_PRIVATE_KEY",
        "missing RELAYER_VAULT_PRIVATE_KEY",
      ],
    });
  });

  it("keeps one required private key per relay target and ignores the old FullAccess variable", () => {
    expect(
      readRelayConfig({
        RELAYER_ACCOUNT_ID: "relayer.near",
        RELAYER_PRIVATE_KEY: "ed25519:full-access-must-not-be-used",
      })
    ).toEqual({
      ok: false,
      issues: [
        "missing RELAYER_VERIFIER_PRIVATE_KEY",
        "missing RELAYER_VAULT_PRIVATE_KEY",
      ],
    });

    const result = readRelayConfig({
      RELAYER_ACCOUNT_ID: "relayer.near",
      RELAYER_PRIVATE_KEY: "ed25519:full-access-must-not-be-used",
      RELAYER_VERIFIER_PRIVATE_KEY: "ed25519:verifier",
      RELAYER_VAULT_PRIVATE_KEY: "ed25519:vault",
    });
    expect(result).toMatchObject({
      ok: true,
      config: {
        privateKeys: {
          verifier: ["ed25519:verifier"],
          vault: ["ed25519:vault"],
        },
      },
    });
  });

  it("reads each target's key pool from a comma-separated list (D-367)", () => {
    const result = readRelayConfig({
      RELAYER_ACCOUNT_ID: "relayer.near",
      RELAYER_VERIFIER_PRIVATE_KEY: " ed25519:v1, ed25519:v2 ,,ed25519:v3,",
      RELAYER_VAULT_PRIVATE_KEY: "ed25519:w1,ed25519:w2",
    });
    expect(result).toMatchObject({
      ok: true,
      config: {
        privateKeys: {
          verifier: ["ed25519:v1", "ed25519:v2", "ed25519:v3"],
          vault: ["ed25519:w1", "ed25519:w2"],
        },
      },
    });
    // Only commas: no key at all, not a pool of blanks.
    expect(
      readRelayConfig({
        RELAYER_ACCOUNT_ID: "relayer.near",
        RELAYER_VERIFIER_PRIVATE_KEY: " , ,",
        RELAYER_VAULT_PRIVATE_KEY: "ed25519:w1",
      })
    ).toEqual({ ok: false, issues: ["missing RELAYER_VERIFIER_PRIVATE_KEY"] });
  });

  it("rejects a key listed twice in one pool, or in both pools", () => {
    expect(
      readRelayConfig({
        RELAYER_ACCOUNT_ID: "relayer.near",
        RELAYER_VERIFIER_PRIVATE_KEY: "ed25519:v1,ed25519:v1",
        RELAYER_VAULT_PRIVATE_KEY: "ed25519:w1",
      })
    ).toEqual({ ok: false, issues: ["RELAYER_VERIFIER_PRIVATE_KEY lists the same key twice"] });
    expect(
      readRelayConfig({
        RELAYER_ACCOUNT_ID: "relayer.near",
        RELAYER_VERIFIER_PRIVATE_KEY: "ed25519:v1,ed25519:shared",
        RELAYER_VAULT_PRIVATE_KEY: "ed25519:shared,ed25519:w1",
      })
    ).toEqual({ ok: false, issues: ["the verifier and vault private keys must be different"] });
  });

  it("rejects one key copied into both target variables", () => {
    expect(
      readRelayConfig({
        RELAYER_ACCOUNT_ID: "relayer.near",
        RELAYER_VERIFIER_PRIVATE_KEY: "ed25519:same-key",
        RELAYER_VAULT_PRIVATE_KEY: "ed25519:same-key",
      })
    ).toEqual({
      ok: false,
      issues: ["the verifier and vault private keys must be different"],
    });
  });

  it("ignores a leftover RELAYER_ACCESS_TOKEN: there is no token gate any more (D-365)", () => {
    const result = readRelayConfig({
      RELAYER_ACCOUNT_ID: "relayer.near",
      RELAYER_VERIFIER_PRIVATE_KEY: "ed25519:verifier",
      RELAYER_VAULT_PRIVATE_KEY: "ed25519:vault",
      RELAYER_ACCESS_TOKEN: "old-secret",
    });
    expect(result).toMatchObject({ ok: true, config: { paused: false } });
    expect(result.ok && "accessToken" in result.config).toBe(false);
  });

  it("pauses only on the literal RELAY_PAUSED=true", () => {
    expect(readRelayPaused({ RELAY_PAUSED: "true" })).toBe(true);
    expect(readRelayPaused({ RELAY_PAUSED: " TRUE " })).toBe(true);
    expect(readRelayPaused({ RELAY_PAUSED: "1" })).toBe(false);
    expect(readRelayPaused({ RELAY_PAUSED: "yes" })).toBe(false);
    expect(readRelayPaused({})).toBe(false);
  });

  it("falls back to safe caps when the env values are junk", () => {
    const result = readRelayConfig({
      RELAYER_ACCOUNT_ID: "relayer.near",
      RELAYER_VERIFIER_PRIVATE_KEY: "ed25519:verifier",
      RELAYER_VAULT_PRIVATE_KEY: "ed25519:vault",
      RELAYER_MAX_REQUESTS: "not-a-number",
      RELAYER_MAX_NEAR_SPEND: "-5",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.maxRequests).toBe(300);
    expect(result.config.maxSpendNear).toBe(0.5);
  });
});

describe("handleRelayRequest — pause", () => {
  it("answers paused before anything else: no gate, no send, no ledger", async () => {
    const sender = senderReturning(okOutcome());
    const gate = vi.fn(passGate);
    const ledger = createRelayLedger();
    const result = await handleRelayRequest({
      body: { target: "verifier", payload: nep413Payload(INTENTS_CONTRACT_ID) },
      config: config({ paused: true }),
      sender,
      gate,
      ledger,
      log: silent,
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, code: "paused" });
    expect(gate).not.toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
    expect(ledger.requests).toBe(0);
  });
});

describe("handleRelayRequest — envelope gate (017-2)", () => {
  it("refuses what the gate says would fail, with 422, without sending or counting", async () => {
    const sender = senderReturning(okOutcome());
    const ledger = createRelayLedger();
    const lines: string[] = [];
    const result = await handleRelayRequest({
      body: { target: "vault", payload: nep413Payload(VAULT_CONTRACT_ID) },
      config: config(),
      sender,
      gate: async () => ({ ok: false, code: "would-fail", reason: "denance02.near does not own portfolio 3" }),
      ledger,
      log: (l) => lines.push(l),
    });
    expect(result.status).toBe(422);
    expect(result.body).toEqual({ ok: false, code: "would-fail", error: "denance02.near does not own portfolio 3" });
    expect(sender).not.toHaveBeenCalled();
    expect(ledger.requests).toBe(0);
    expect(lines.join("\n")).toMatch(/REFUSED vault .*would-fail/);
  });

  it("answers check-failed with 503 when the checks had no answer", async () => {
    const sender = senderReturning(okOutcome());
    const result = await handleRelayRequest({
      body: { target: "verifier", payload: nep413Payload(INTENTS_CONTRACT_ID) },
      config: config(),
      sender,
      gate: async () => ({ ok: false, code: "check-failed", reason: "simulate_intents: fetch failed" }),
      ledger: createRelayLedger(),
      log: silent,
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: "check-failed" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("hands the gate the target and the payload exactly as received", async () => {
    const gate = vi.fn(passGate);
    const payload = nep413Payload(INTENTS_CONTRACT_ID);
    await handleRelayRequest({
      body: { target: "verifier", payload },
      config: config(),
      sender: senderReturning(okOutcome()),
      gate,
      ledger: createRelayLedger(),
      log: silent,
    });
    expect(gate).toHaveBeenCalledWith({ target: "verifier", payload });
  });

  it("a gate with no answer within the budget is check-failed, and nothing is sent", async () => {
    const sender = senderReturning(okOutcome());
    const result = await handleRelayRequest({
      body: { target: "verifier", payload: nep413Payload(INTENTS_CONTRACT_ID) },
      config: config(),
      sender,
      gate: () => new Promise(() => {}),
      checkBudgetMs: 10,
      ledger: createRelayLedger(),
      log: silent,
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: "check-failed" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("a gate that throws is check-failed, not a 500 the client would read as maybe-sent", async () => {
    const sender = senderReturning(okOutcome());
    const result = await handleRelayRequest({
      body: { target: "vault", payload: nep413Payload(VAULT_CONTRACT_ID) },
      config: config(),
      sender,
      gate: async () => {
        throw new Error("boom");
      },
      ledger: createRelayLedger(),
      log: silent,
    });
    expect(result.body).toEqual({ ok: false, code: "check-failed", error: "boom" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("a hung allowance read does not hold the answer past its budget", async () => {
    const result = await handleRelayRequest({
      body: { target: "verifier", payload: nep413Payload(INTENTS_CONTRACT_ID) },
      config: config(),
      sender: senderReturning(okOutcome()),
      gate: passGate,
      watchAllowance: () => new Promise(() => {}),
      watchBudgetMs: 10,
      ledger: createRelayLedger(),
      log: silent,
    });
    expect(result.status).toBe(200);
  });

  it("sends each signed operation once: a repeat is refused before the send (cross-review s194)", async () => {
    const sender = senderReturning(okOutcome());
    const sent = createRelaySentRegistry();
    const gate: RelayGate = async () => ({ ok: true, signerId: "a.near", replayKey: "a.near:00ff" });
    const run = () =>
      handleRelayRequest({
        body: { target: "vault", payload: nep413Payload(VAULT_CONTRACT_ID) },
        config: config(),
        sender,
        gate,
        sent,
        ledger: createRelayLedger(),
        log: silent,
      });

    // Concurrent copies: exactly one goes out.
    const results = await Promise.all([run(), run(), run()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422, 422]);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(results.find((r) => r.status === 422)?.body).toMatchObject({ code: "would-fail" });
  });

  it("keys the once-only rule by target: the same key at the other destination is another operation", async () => {
    const sender = senderReturning(okOutcome());
    const sent = createRelaySentRegistry();
    const gate: RelayGate = async () => ({ ok: true, signerId: "a.near", replayKey: "a.near:00ff" });
    const common = { config: config(), sender, gate, sent, ledger: createRelayLedger(), log: silent };
    await handleRelayRequest({ ...common, body: { target: "vault", payload: nep413Payload(VAULT_CONTRACT_ID) } });
    await handleRelayRequest({ ...common, body: { target: "verifier", payload: nep413Payload(INTENTS_CONTRACT_ID) } });
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("forgets a sent operation after its TTL", async () => {
    const sender = senderReturning(okOutcome());
    const sent = createRelaySentRegistry();
    let now = 1_000_000;
    const gate: RelayGate = async () => ({ ok: true, signerId: "a.near", replayKey: "a.near:00ff" });
    const run = () =>
      handleRelayRequest({
        body: { target: "vault", payload: nep413Payload(VAULT_CONTRACT_ID) },
        config: config(),
        sender,
        gate,
        sent,
        now: () => now,
        ledger: createRelayLedger(),
        log: silent,
      });
    await run();
    now += RELAY_SENT_TTL_MS + 1;
    await run();
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("logs a refusal's reason JSON-encoded, so a newline in an envelope field cannot forge a log line", async () => {
    const lines: string[] = [];
    await handleRelayRequest({
      body: { target: "vault", payload: nep413Payload(VAULT_CONTRACT_ID) },
      config: config(),
      sender: senderReturning(okOutcome()),
      gate: async () => ({ ok: false, code: "would-fail", reason: "signed for x\n[relay] vault tx=FAKE" }),
      ledger: createRelayLedger(),
      log: (l) => lines.push(l),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
  });

  it("a watcher that rejects anyway does not turn the answer into a throw", async () => {
    const result = await handleRelayRequest({
      body: { target: "verifier", payload: nep413Payload(INTENTS_CONTRACT_ID) },
      config: config(),
      sender: senderReturning(okOutcome()),
      gate: passGate,
      watchAllowance: async () => {
        throw new Error("broken watcher");
      },
      ledger: createRelayLedger(),
      log: silent,
    });
    expect(result.status).toBe(200);
  });

  it("watches the target key's allowance on every checked request, refused ones included", async () => {
    const watchAllowance = vi.fn(async () => {});
    await handleRelayRequest({
      body: { target: "vault", payload: nep413Payload(VAULT_CONTRACT_ID) },
      config: config(),
      sender: senderReturning(okOutcome()),
      gate: async () => ({ ok: false, code: "would-fail", reason: "x" }),
      watchAllowance,
      ledger: createRelayLedger(),
      log: silent,
    });
    expect(watchAllowance).toHaveBeenCalledWith("vault");
  });
});

describe("handleRelayRequest — destinations", () => {
  it("submits an Allocate envelope to the Verifier as execute_intents", async () => {
    const sender = senderReturning(okOutcome());
    const payload = nep413Payload(INTENTS_CONTRACT_ID);
    const result = await handleRelayRequest({
      body: { target: "verifier", payload },
      gate: passGate,
      config: config(),
      sender,
      ledger: createRelayLedger(),
      log: silent,
    });

    expect(result.status).toBe(200);
    expect(sender).toHaveBeenCalledWith({
      target: "verifier",
      receiverId: INTENTS_CONTRACT_ID,
      methodName: "execute_intents",
      args: { signed: [payload] },
      gas: RELAY_GAS,
    });
  });

  it("submits a commit envelope to the vault, wrapped as { payload }", async () => {
    const sender = senderReturning(okOutcome());
    const payload = nep413Payload(VAULT_CONTRACT_ID);
    await handleRelayRequest({
      body: { target: "vault", payload },
      gate: passGate,
      config: config(),
      sender,
      ledger: createRelayLedger(),
      log: silent,
    });

    expect(sender).toHaveBeenCalledWith({
      target: "vault",
      receiverId: VAULT_CONTRACT_ID,
      methodName: "commit_portfolio_changes",
      args: { payload },
      gas: RELAY_GAS,
    });
  });

  it("rejects an unknown target instead of guessing one", async () => {
    const sender = senderReturning(okOutcome());
    const result = await handleRelayRequest({
      body: { target: "some.contract.near", payload: nep413Payload(INTENTS_CONTRACT_ID) },
      gate: passGate,
      config: config(),
      sender,
      ledger: createRelayLedger(),
      log: silent,
    });
    expect(result.status).toBe(400);
    expect(sender).not.toHaveBeenCalled();
  });
});

describe("handleRelayRequest — destination guard", () => {
  it("refuses to send a commit envelope to the Verifier (and burns no gas)", async () => {
    const sender = senderReturning(okOutcome());
    const result = await handleRelayRequest({
      // Signed for the vault, routed at the Verifier: the chain would reject the signature
      // anyway, but only after the relayer paid for it.
      body: { target: "verifier", payload: nep413Payload(VAULT_CONTRACT_ID) },
      gate: passGate,
      config: config(),
      sender,
      ledger: createRelayLedger(),
      log: silent,
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ ok: false, code: "destination-mismatch" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("reads verifying_contract out of a string payload (ERC-191)", async () => {
    const sender = senderReturning(okOutcome());
    const result = await handleRelayRequest({
      body: { target: "vault", payload: erc191Payload(INTENTS_CONTRACT_ID) },
      gate: passGate,
      config: config(),
      sender,
      ledger: createRelayLedger(),
      log: silent,
    });
    expect(result.body).toMatchObject({ code: "destination-mismatch" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("leaves an envelope whose recipient it cannot read to the gate, rather than blocking it here", async () => {
    const gate = vi.fn(passGate);
    const result = await handleRelayRequest({
      body: { target: "vault", payload: { standard: "ton_connect", payload: { cell: "b64" } } },
      gate,
      config: config(),
      sender: senderReturning(okOutcome()),
      ledger: createRelayLedger(),
      log: silent,
    });
    // This guard is a cheap early exit for a mis-routed envelope; the gate is the real judge.
    expect(result.status).toBe(200);
    expect(gate).toHaveBeenCalled();
  });
});

describe("handleRelayRequest — spend cap", () => {
  it("stops once the request cap is reached", async () => {
    const ledger = createRelayLedger();
    ledger.requests = 2;
    const sender = senderReturning(okOutcome());
    const result = await handleRelayRequest({
      body: { target: "verifier", payload: nep413Payload(INTENTS_CONTRACT_ID) },
      gate: passGate,
      config: config({ maxRequests: 2 }),
      sender,
      ledger,
      log: silent,
    });
    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({ code: "cap-exceeded" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("stops once the NEAR spend cap is reached", async () => {
    const ledger = createRelayLedger();
    ledger.yoctoBurnt = BigInt("600000000000000000000000"); // 0.6 NEAR
    const result = await handleRelayRequest({
      body: { target: "verifier", payload: nep413Payload(INTENTS_CONTRACT_ID) },
      gate: passGate,
      config: config({ maxSpendNear: 0.5 }),
      sender: senderReturning(okOutcome()),
      ledger,
      log: silent,
    });
    expect(result.status).toBe(429);
  });

  it("accumulates the gas of every receipt, not just the transaction's own", async () => {
    const ledger = createRelayLedger();
    await handleRelayRequest({
      body: { target: "verifier", payload: nep413Payload(INTENTS_CONTRACT_ID) },
      gate: passGate,
      config: config(),
      sender: senderReturning(okOutcome()),
      ledger,
      log: silent,
    });
    expect(ledger.requests).toBe(1);
    expect(ledger.yoctoBurnt).toBe(BigInt("1040000000000000000000"));
  });

  it("counts a failed send too, so a broken loop cannot retry for free", async () => {
    const ledger = createRelayLedger();
    const result = await handleRelayRequest({
      body: { target: "verifier", payload: nep413Payload(INTENTS_CONTRACT_ID) },
      gate: passGate,
      config: config(),
      sender: vi.fn().mockRejectedValue(new Error("every upstream down")),
      ledger,
      log: silent,
    });
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ code: "send-failed", error: "every upstream down" });
    expect(ledger.requests).toBe(1);
  });

  it("answers an unanswered send as unknown-outcome with its hash, never as send-failed (D-329, D-330)", async () => {
    const ledger = createRelayLedger();
    const lines: string[] = [];
    const result = await handleRelayRequest({
      body: { target: "verifier", payload: nep413Payload(INTENTS_CONTRACT_ID) },
      gate: passGate,
      config: config(),
      sender: vi.fn().mockRejectedValue(new RelayOutcomeUnknownError("no answer within 30000ms", "HASH1")),
      ledger,
      log: (l) => lines.push(l),
    });
    expect(result.status).toBe(504);
    expect(result.body).toEqual({
      ok: false,
      code: "unknown-outcome",
      error: "no answer within 30000ms",
      txHash: "HASH1",
    });
    expect(ledger.requests).toBe(1);
    expect(lines.join("\n")).toMatch(/UNKNOWN OUTCOME verifier .*tx=HASH1/);
  });
});

describe("handleRelayRequest — outcome passthrough", () => {
  it("returns a REVERTED transaction as 200 with its outcome intact", async () => {
    // The callers read the revert (and an immature commit's defer) out of the outcome. An HTTP
    // error would throw away the tx hash and the vault's events.
    const reverted = {
      transaction_outcome: { id: "RevertedTx", outcome: { tokens_burnt: "1" } },
      status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "E_NONCE" } } } } },
    };
    const result = await handleRelayRequest({
      body: { target: "vault", payload: nep413Payload(VAULT_CONTRACT_ID) },
      gate: passGate,
      config: config(),
      sender: senderReturning(reverted),
      ledger: createRelayLedger(),
      log: silent,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, txHash: "RevertedTx", outcome: reverted });
  });
});

describe("logging helpers", () => {
  it("attributes a NEP-413 envelope to its signer", () => {
    expect(describeEnvelopeSigner(nep413Payload(INTENTS_CONTRACT_ID, "denance02.near"))).toEqual({
      standard: "nep413",
      signerId: "denance02.near",
    });
  });

  it("attributes an ERC-191 envelope from its string payload", () => {
    expect(describeEnvelopeSigner(erc191Payload(VAULT_CONTRACT_ID))).toEqual({
      standard: "erc191",
      signerId: "0xabc0000000000000000000000000000000000000",
    });
  });

  it("degrades to unknown rather than throwing on a shape it cannot parse", () => {
    expect(describeEnvelopeSigner({ standard: 7, payload: "not json" })).toEqual({
      standard: "unknown",
      signerId: "unknown",
    });
  });

  it("formats yocto as readable NEAR", () => {
    expect(formatNear(BigInt("1040000000000000000000"))).toBe("0.001040");
    expect(formatNear(BigInt(0))).toBe("0.000000");
    expect(formatNear(BigInt("3000000000000000000000000"))).toBe("3.000000");
  });

  it("ignores non-numeric tokens_burnt instead of producing NaN", () => {
    expect(sumTokensBurnt({ transaction_outcome: { outcome: { tokens_burnt: null } } })).toBe(
      BigInt(0)
    );
    expect(sumTokensBurnt(undefined)).toBe(BigInt(0));
  });
});
