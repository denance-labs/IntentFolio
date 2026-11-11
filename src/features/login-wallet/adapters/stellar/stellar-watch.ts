// Varial (formerly Freighter) account/network tracking (D-220).
//
// Why this file exists. Of the six login families, five get account switches for free from a
// reactive SDK hook (wagmi, near-connect-hooks, @solana/wallet-adapter-react,
// @tonconnect/ui-react) and their `liveConnection` stays fresh on its own. Tron had no library
// under it and was given a listener in block 4.2. Stellar is the last one: `@stellar/varial-sdk`
// is request/response, so `liveConnection` could only ever hold whatever the mount read — and
// `assertWalletMatchesAccount` (portfolio-context.tsx, D-218) compares exactly that value, so a
// stale one makes the guard compare the session against itself and it can never fail.
//
// `WatchWalletChanges` is Freighter's answer to this, but it is NOT an event emitter and the
// difference matters at every call site below. Measured against @stellar/freighter-api 6.0.1 (same API in @stellar/varial-sdk 7.0.0)
// (build/index.min.js), because none of it is documented:
//
//   1. It is a POLL — a recursive setTimeout, 3 s by default — over `REQUEST_PUBLIC_KEY` and
//      `REQUEST_NETWORK_DETAILS`. `REQUEST_PUBLIC_KEY` is the silent read that backs
//      `getAddress()`, NOT `REQUEST_ACCESS`, so polling never raises a prompt. That was worth
//      confirming before shipping something that runs every 3 s for the whole session.
//   2. Its transport resolves `REQUEST_PUBLIC_KEY` with `{ publicKey: "" }` — and NO error —
//      after a 2 s timeout. A slow or busy extension therefore looks exactly like "the user
//      switched to no account". Mapped straight to state that would log the operator out
//      mid-flow, which on this path means during a withdrawal.
//   3. The error branch has no early return, so while the origin is not authorised the callback
//      fires with an error EVERY tick, forever.
//   4. `stop()` only clears the `isRunning` flag. A tick already awaiting its two round-trips
//      still invokes the callback afterwards, so unmount needs its own guard.
//
// This module absorbs all four so the bridge sees one thing: a real, non-empty address.

import { WatchWalletChanges } from "@stellar/varial-sdk";

/** What the bridge receives — already filtered, always a usable address. */
export type FreighterWalletChange = {
  address: string;
  /** "PUBLIC" | "TESTNET" | "FUTURENET", or a custom network's own name. */
  network: string;
};

/** The slice of `WatchWalletChanges` used here, so tests can supply their own. */
export type FreighterWatcher = {
  watch(cb: (params: { address: string; network: string; error?: unknown }) => void): unknown;
  stop(): void;
};

/** Freighter's own default. Left as-is: a money path does not need sub-second reaction. */
export const WATCH_POLL_INTERVAL_MS = 3000;

/**
 * Starts watching Freighter and returns the stop function.
 *
 * `onChange` is called only for changes worth acting on: ticks carrying an error or an empty
 * address are dropped (quirks 2 and 3 above). Dropping an empty address means a locked or slow
 * extension leaves the last known address in place instead of clearing it — deliberate, and the
 * same shape as `readTronChainId` returning `null`: unknown is not the same as changed. The
 * direction that must never be missed is a switch to a DIFFERENT account, and that always
 * arrives as a non-empty address.
 */
export function startFreighterWatch(
  onChange: (change: FreighterWalletChange) => void,
  options: { createWatcher?: () => FreighterWatcher } = {},
): () => void {
  const watcher = options.createWatcher
    ? options.createWatcher()
    : (new WatchWalletChanges(WATCH_POLL_INTERVAL_MS) as FreighterWatcher);

  let cancelled = false;

  watcher.watch((params) => {
    if (cancelled) return; // quirk 4: stop() does not cancel a tick already in flight
    if (params.error) return; // quirk 3: fires every tick while access is not granted
    if (!params.address) return; // quirk 2: the 2 s transport timeout resolves with ""
    onChange({ address: params.address, network: params.network });
  });

  return () => {
    cancelled = true;
    watcher.stop();
  };
}

// ── Network ────────────────────────────────────────────────────────────────────

/** Freighter's identifier for Stellar mainnet (`NETWORKS.PUBLIC`). */
export const STELLAR_MAINNET_NETWORK = "PUBLIC";

const KNOWN_TEST_NETWORKS: Record<string, string> = {
  TESTNET: "Testnet",
  FUTURENET: "Futurenet",
};

/**
 * Warns when the extension is pointed somewhere other than mainnet.
 *
 * Stellar makes this trap sharper than the other families: the keypair is the same on every
 * network, so a wallet sitting on Testnet shows the operator the SAME `G...` address it would
 * show on mainnet. Nothing in the address, and nothing in the deposit form, distinguishes the
 * two — the funds simply never arrive.
 *
 * `null` in, `null` out: an unreadable network is not a wrong one, and the app cannot fail
 * closed on a signal it cannot obtain — the deposit transfer leaves from inside the wallet,
 * not through IntentFolio, so this can be flagged but never prevented.
 */
export function stellarNetworkWarning(network: string | null): string | null {
  if (network === null || network === "") return null;
  if (network === STELLAR_MAINNET_NETWORK) return null;
  const name = KNOWN_TEST_NETWORKS[network];
  return name
    ? `Your Stellar wallet is on ${name}, not mainnet. Switch it before sending funds.`
    : `Your Stellar wallet is on an unrecognised network (${network}), not mainnet.`;
}
