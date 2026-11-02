import { describe, it, expect, vi } from "vitest";
import {
  startFreighterWatch,
  stellarNetworkWarning,
  type FreighterWatcher,
} from "./stellar-watch";

const A1 = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

type Tick = { address: string; network: string; error?: unknown };

/**
 * Stands in for `WatchWalletChanges` so each of its measured quirks can be reproduced on
 * demand. Everything asserted below was read off @stellar/freighter-api 6.0.1's bundle — the
 * behaviour is undocumented, so these tests are what pins it.
 */
function fakeWatcher() {
  let cb: ((params: Tick) => void) | null = null;
  const watcher: FreighterWatcher & { stopped: boolean } = {
    stopped: false,
    watch(next) {
      cb = next as (params: Tick) => void;
      return {};
    },
    stop() {
      this.stopped = true;
    },
  };
  return {
    watcher,
    emit: (tick: Tick) => cb?.(tick),
    isWatching: () => cb !== null,
  };
}

function start(onChange: (c: { address: string; network: string }) => void) {
  const fake = fakeWatcher();
  const stop = startFreighterWatch(onChange, { createWatcher: () => fake.watcher });
  return { ...fake, stop };
}

describe("startFreighterWatch (D-220)", () => {
  it("reports an account switch, which is the change the D-218 guard depends on", () => {
    const onChange = vi.fn();
    const w = start(onChange);

    w.emit({ address: A1, network: "PUBLIC" });

    expect(onChange).toHaveBeenCalledWith({ address: A1, network: "PUBLIC" });
  });

  it("ignores the empty address the 2 s transport timeout resolves with", () => {
    // A busy or slow extension resolves REQUEST_PUBLIC_KEY with `{ publicKey: "" }` and NO
    // error. Acting on it would drop `liveConnection` mid-session — during a withdrawal, the
    // guard would silently fall back to comparing the session against itself.
    const onChange = vi.fn();
    const w = start(onChange);

    w.emit({ address: "", network: "PUBLIC" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores the error tick that repeats forever while access is not granted", () => {
    const onChange = vi.fn();
    const w = start(onChange);

    w.emit({ address: "", network: "", error: { message: "User declined access" } });
    w.emit({ address: "", network: "", error: { message: "User declined access" } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("drops an errored tick even when it carries an address", () => {
    const onChange = vi.fn();
    const w = start(onChange);

    w.emit({ address: A1, network: "PUBLIC", error: { message: "boom" } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops the watcher and ignores a tick already in flight when it does", () => {
    // `stop()` only clears an `isRunning` flag; a tick awaiting its two round-trips still
    // invokes the callback afterwards, so the returned stop function must guard as well.
    const onChange = vi.fn();
    const w = start(onChange);

    w.stop();
    expect(w.watcher.stopped).toBe(true);

    w.emit({ address: A1, network: "PUBLIC" });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("stellarNetworkWarning", () => {
  it("stays quiet on mainnet", () => {
    expect(stellarNetworkWarning("PUBLIC")).toBeNull();
  });

  it("names the test network it found", () => {
    expect(stellarNetworkWarning("TESTNET")).toContain("Testnet");
    expect(stellarNetworkWarning("FUTURENET")).toContain("Futurenet");
  });

  it("still warns on a network it does not recognise", () => {
    expect(stellarNetworkWarning("MY_STANDALONE")).toContain("unrecognised");
  });

  it("treats an unreadable network as unknown, not as wrong", () => {
    expect(stellarNetworkWarning(null)).toBeNull();
    expect(stellarNetworkWarning("")).toBeNull();
  });
});
