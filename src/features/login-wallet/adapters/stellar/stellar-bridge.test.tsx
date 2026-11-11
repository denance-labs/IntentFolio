// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, act, cleanup } from "@testing-library/react";

import { StellarAdapterBridge } from "./stellar-bridge";
import { LoginWalletProvider } from "../../context/login-wallet-context";
import { useLoginWallet } from "../../hooks/use-login-wallet";

// Real StrKey public keys (valid checksums), so nothing downstream trips on the shape.
const A1 = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const A2 = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const SETTLE = { timeout: 3000 };

// ── Fake Freighter ─────────────────────────────────────────────────────────────
// The extension is mocked at the module boundary, and the watcher is driven by hand: what is
// under test is how the bridge REACTS to Freighter's poll, not the poll's own timing.

type Tick = { address: string; network: string; error?: unknown };

const freighter = {
  installed: true,
  /** Number of isConnected() calls, so the retry after a timed-out gate is observable. */
  isConnectedCalls: 0,
  /** What the silent mount read returns. */
  restoreAddress: null as string | null,
  requestAddress: A1,
  /** When set, signMessage answers the way Freighter reports a refusal. */
  signError: null as string | null,
  ticks: [] as Array<(t: Tick) => void>,
  watcherStopped: 0,
};

vi.mock("@stellar/varial-sdk", () => ({
  isConnected: async () => {
    freighter.isConnectedCalls += 1;
    return { isConnected: freighter.installed };
  },
  getAddress: async () =>
    freighter.restoreAddress
      ? { address: freighter.restoreAddress }
      : { address: "", error: { message: "not allowed" } },
  requestAccess: async () => ({ address: freighter.requestAddress }),
  signMessage: async () =>
    freighter.signError
      ? { signedMessage: null, signerAddress: "", error: { message: freighter.signError } }
      : { signedMessage: "c2ln", signerAddress: A1 },
  WatchWalletChanges: class {
    watch(cb: (t: Tick) => void) {
      freighter.ticks.push(cb);
      return {};
    }
    stop() {
      freighter.watcherStopped += 1;
    }
  },
}));

/** Mimics one poll tick of the extension. */
function tick(t: Tick) {
  act(() => {
    for (const cb of freighter.ticks) cb(t);
  });
}

// ── Probe ──────────────────────────────────────────────────────────────────────
// Asserts on `liveConnection` — the exact value `assertWalletMatchesAccount` consumes
// (portfolio-context.tsx, D-218) — rather than on the bridge's private state.

let seen: { live: string | null; status: string } = { live: null, status: "" };
const captured: {
  connect: (() => Promise<void>) | null;
  disconnect: (() => Promise<void>) | null;
  sign: ((m: string) => Promise<unknown>) | null;
} = { connect: null, disconnect: null, sign: null };

function Probe() {
  const { liveConnection, status, connect, disconnect, signMessage } = useLoginWallet();
  seen = { live: liveConnection?.address ?? null, status };
  captured.connect = connect;
  captured.disconnect = disconnect;
  captured.sign = signMessage;
  return null;
}

function renderBridge() {
  return render(
    <LoginWalletProvider>
      <StellarAdapterBridge />
      <Probe />
    </LoginWalletProvider>,
  );
}

beforeEach(() => {
  freighter.installed = true;
  freighter.restoreAddress = null;
  freighter.requestAddress = A1;
  freighter.ticks = [];
  freighter.watcherStopped = 0;
  freighter.isConnectedCalls = 0;
  freighter.signError = null;
  seen = { live: null, status: "" };
  captured.connect = null;
  captured.disconnect = null;
  captured.sign = null;
});

afterEach(() => {
  // Explicit: this project runs vitest without `globals: true` and without a setup file, so
  // testing-library's automatic cleanup never registers and a DOM query would otherwise see
  // the previous test's banner.
  cleanup();
});

describe("StellarAdapterBridge account tracking (D-220)", () => {
  async function connected() {
    freighter.restoreAddress = A1;
    renderBridge();
    await waitFor(() => expect(seen.live).toBe(A1), SETTLE);
  }

  it("follows an account switch inside the extension so liveConnection stops being stale", async () => {
    // The whole point of D-220: fed a stale address, `assertWalletMatchesAccount` compares the
    // session against itself and can never fail.
    await connected();

    tick({ address: A2, network: "PUBLIC" });

    await waitFor(() => expect(seen.live).toBe(A2), SETTLE);
  });

  it("keeps the last known address when a tick comes back empty", async () => {
    // The transport resolves REQUEST_PUBLIC_KEY with "" and no error after 2 s. A locked or
    // busy extension must not read as "switched to no account" — that would drop the live
    // connection mid-withdrawal.
    await connected();

    tick({ address: "", network: "PUBLIC" });

    await new Promise((r) => setTimeout(r, 50));
    expect(seen.live).toBe(A1);
  });

  it("ignores the error tick that repeats while access is not granted", async () => {
    await connected();

    tick({ address: "", network: "", error: { message: "User declined access" } });

    await new Promise((r) => setTimeout(r, 50));
    expect(seen.live).toBe(A1);
  });

  it("restores a session the mount read lost the race for", async () => {
    // `getAddress()` gives up after 2 s, which a cold extension can exceed. The poll is then
    // the only thing that can still establish the session — allowed here, unlike Tron,
    // because Freighter only answers for an origin the user already authorised (D-131).
    freighter.restoreAddress = null;
    renderBridge();
    await waitFor(() => expect(captured.connect).not.toBeNull(), SETTLE);
    expect(seen.live).toBeNull();

    tick({ address: A1, network: "PUBLIC" });

    await waitFor(() => expect(seen.live).toBe(A1), SETTLE);
  });

  it("does not resurrect a session the user just disconnected", async () => {
    // Freighter has no disconnect of its own, so it keeps answering for an origin it still
    // considers allowed. Without the dismissal flag the session would come back within 3 s.
    await connected();

    await act(async () => {
      await captured.disconnect!();
    });
    await waitFor(() => expect(seen.live).toBeNull(), SETTLE);

    tick({ address: A1, network: "PUBLIC" });

    await new Promise((r) => setTimeout(r, 50));
    expect(seen.live).toBeNull();
  });

  it("connects again after a disconnect", async () => {
    // The dismissal must not be permanent — clearing it is `connect`'s job.
    await connected();
    await act(async () => {
      await captured.disconnect!();
    });

    await act(async () => {
      await captured.connect!();
    });

    await waitFor(() => expect(seen.live).toBe(A1), SETTLE);
  });

  it("stops the watcher on unmount", async () => {
    await connected();

    cleanup();

    await waitFor(() => expect(freighter.watcherStopped).toBeGreaterThan(0), SETTLE);
  });

  it("starts tracking after a connect, even when the mount gate answered false", async () => {
    // The gate calls isConnected(), which answers over the message channel — the
    // `window.freighter` fast path is legacy and today's extension does not set it. That
    // channel RESOLVES FALSE after its own 2 s timeout when nothing answered in time, so a
    // cold extension can fail the gate once. With an empty dependency array that left account
    // tracking off for the whole session and silently restored the D-220 staleness.
    freighter.installed = false; // the timed-out gate
    freighter.restoreAddress = null;
    renderBridge();
    await waitFor(() => expect(captured.connect).not.toBeNull(), SETTLE);
    await waitFor(() => expect(freighter.isConnectedCalls).toBeGreaterThan(0), SETTLE);
    expect(freighter.ticks).toHaveLength(0);

    // The extension wakes up and the user connects successfully.
    freighter.installed = true;
    await act(async () => {
      await captured.connect!();
    });
    await waitFor(() => expect(seen.live).toBe(A1), SETTLE);

    // The session appearing re-runs the gate, and this time the watcher starts.
    await waitFor(() => expect(freighter.ticks.length).toBeGreaterThan(0), SETTLE);
    tick({ address: A2, network: "PUBLIC" });
    await waitFor(() => expect(seen.live).toBe(A2), SETTLE);
  });

  it("does not rebuild the watcher when the account merely changes", async () => {
    // Only the appearance or loss of a session should tear it down; an account switch is the
    // event it exists to observe.
    freighter.restoreAddress = A1;
    renderBridge();
    await waitFor(() => expect(seen.live).toBe(A1), SETTLE);
    await waitFor(() => expect(freighter.ticks.length).toBeGreaterThan(0), SETTLE);
    const stoppedBefore = freighter.watcherStopped;

    tick({ address: A2, network: "PUBLIC" });
    await waitFor(() => expect(seen.live).toBe(A2), SETTLE);

    expect(freighter.watcherStopped).toBe(stoppedBefore);
  });

  it("never starts a watcher when Freighter is not installed", async () => {
    // Freighter's transport gives REQUEST_NETWORK_DETAILS no timeout, so a poll started
    // without the extension leaves a dangling `message` listener and never ticks again.
    freighter.installed = false;
    renderBridge();
    await waitFor(() => expect(captured.connect).not.toBeNull(), SETTLE);

    await new Promise((r) => setTimeout(r, 50));
    expect(freighter.ticks).toHaveLength(0);
  });
});

describe("StellarAdapterBridge network warning", () => {
  it("warns when the extension is on a test network", async () => {
    // Stellar sharpens this trap: the keypair is identical on every network, so a wallet on
    // Testnet shows the SAME G... address it would show on mainnet.
    freighter.restoreAddress = A1;
    const { findByRole } = renderBridge();
    await waitFor(() => expect(seen.live).toBe(A1), SETTLE);

    tick({ address: A1, network: "TESTNET" });

    expect((await findByRole("status")).textContent).toContain("Testnet");
  });

  it("stays quiet on mainnet", async () => {
    freighter.restoreAddress = A1;
    const { queryByRole } = renderBridge();
    await waitFor(() => expect(seen.live).toBe(A1), SETTLE);

    tick({ address: A1, network: "PUBLIC" });

    expect(queryByRole("status")).toBeNull();
  });

  it("says nothing while no wallet is connected", async () => {
    freighter.installed = false;
    const { queryByRole } = renderBridge();
    await waitFor(() => expect(captured.connect).not.toBeNull(), SETTLE);

    expect(queryByRole("status")).toBeNull();
  });
});

describe("StellarAdapterBridge connect errors", () => {
  it("names Varial, and stays classifiable as recoverable", async () => {
    freighter.installed = false;
    renderBridge();
    await waitFor(() => expect(captured.connect).not.toBeNull(), SETTLE);

    await expect(
      act(async () => {
        await captured.connect!();
      }),
      // "not found" is the substring `normalizeWalletError` matches on.
    ).rejects.toThrow(/Varial wallet not found\. Install Varial and reload the page\./);
  });
});

describe("StellarAdapterBridge signing", () => {
  it("a refused signature rejects to the caller and keeps the session connected (D-433)", async () => {
    freighter.restoreAddress = A1;
    freighter.signError = "User declined access";
    renderBridge();
    await waitFor(() => expect(seen.status).toBe("connected"), SETTLE);

    await act(async () => {
      await expect(captured.sign!("hello")).rejects.toThrow("User declined access");
    });

    expect(seen.status).toBe("connected");
    expect(seen.live).toBe(A1);
  });
});

describe("StellarAdapterBridge restore settled (D-545)", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("ends a restored session's wait as soon as the mount read answers, not after the clock", async () => {
    localStorage.setItem("intentfolio.lastUsedWalletFamily", "stellar");
    localStorage.setItem(
      "intentfolio.identity",
      JSON.stringify({ chainKind: "stellar", address: A1, intentsAccountId: A1.toLowerCase() }),
    );
    // Freighter answers "not allowed": no live session is coming back on its own.
    renderBridge();
    // Well under RESTORE_TIMEOUT_MS (1500): only the settled read can end it this soon.
    await waitFor(() => expect(seen.status).toBe("connected"), { timeout: 500 });
    expect(seen.live).toBeNull();
  });
});
