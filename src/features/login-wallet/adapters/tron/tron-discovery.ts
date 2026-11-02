// TIP-6963 provider discovery for Tron (D-219).
//
// Named `tron-discovery`, not `tron-provider`: `tron-provider.tsx` next door is the React
// FamilyProvider passthrough, and two files resolving to the same specifier is how the
// existing import silently started pointing at the wrong module.
//
// Why this exists, measured rather than assumed. Block 4.2's real-funds run found the legacy
// surface BROKEN in an ordinary browser: with Backpack installed alongside TronLink,
// `window.tronLink` and `window.tronWeb` are claimed by Backpack, and TronLink's injected
// script cannot even write to them — the console shows
// `TypeError: 'set' on proxy: trap returned falsish for property 'defaultAddress'`.
// Observed in the operator's browser 2026-08-07:
//
//   window.tronLink.isTronLink   → undefined   (a real TronLink sets it to true)
//   window.tronWeb.isTronWeb     → undefined
//   window.tronWeb.fullNode.host → undefined   (not even a functional TronWeb)
//   window.tron.isTronLink       → true        (the modern name is still TronLink's)
//
// The globals are single slots any extension can take; TIP-6963 is the discovery protocol
// built for exactly that, the same way EIP-6963 settled the `window.ethereum` fight on EVM.
//
// ⚠️ The two casings are both real, both observed in the same browser on the same day:
// TronLink announces on `TIP6963:announceProvider`, Backpack on `tip6963:announceProvider`.
// Listening for only one sees half the wallets.
//
// Signing rides on this too, which is the part that made it urgent: `signMessageV2` used to
// come off the global `window.tronWeb`, so a hijacked global meant a hijacked SIGNER, not
// just a broken login. The provider carries its own `tronWeb`, bound to the account that
// authorised the origin.

/** The subset of a TronWeb instance this app touches. */
export type ProviderTronWeb = {
  ready: boolean;
  defaultAddress: { base58: string; hex: string } | false;
  trx: { signMessageV2: (message: string) => Promise<string> };
};

/** A TIP-6963 Tron provider, as announced or found on `window.tron`. */
export type TronProvider = {
  isTronLink?: boolean;
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  /** `false` until the origin is authorised — that is the extension's own convention. */
  tronWeb?: ProviderTronWeb | false;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type TronProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

export type AnnouncedTronProvider = {
  info: TronProviderInfo;
  provider: TronProvider;
};

/** TronLink's own reverse-DNS id, read off its announcement in a live browser. */
export const TRONLINK_RDNS = "org.tronlink.www";

const ANNOUNCE_EVENTS = ["TIP6963:announceProvider", "tip6963:announceProvider"] as const;
const REQUEST_EVENTS = ["TIP6963:requestProvider", "tip6963:requestProvider"] as const;

/** Announcements land within a frame or two; this is slack, not a real wait. */
export const DISCOVERY_TIMEOUT_MS = 500;

function isUsableProvider(value: unknown): value is TronProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { request?: unknown }).request === "function"
  );
}

/**
 * Collects every Tron wallet that announces itself, de-duplicated by `rdns`.
 *
 * De-duplication matters: a wallet may answer more than one of the request events (and
 * Backpack announces on both the EIP and TIP channels), so without it the same wallet shows
 * up repeatedly and a "pick the first" rule silently depends on event ordering.
 */
export function discoverTronProviders(
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<AnnouncedTronProvider[]> {
  if (typeof window === "undefined") return Promise.resolve([]);

  return new Promise((resolve) => {
    const byRdns = new Map<string, AnnouncedTronProvider>();

    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent).detail as Partial<AnnouncedTronProvider> | undefined;
      const info = detail?.info;
      const provider = detail?.provider;
      if (!info || typeof info.rdns !== "string" || !isUsableProvider(provider)) return;
      if (!byRdns.has(info.rdns)) byRdns.set(info.rdns, { info, provider });
    };

    for (const name of ANNOUNCE_EVENTS) window.addEventListener(name, onAnnounce);
    for (const name of REQUEST_EVENTS) window.dispatchEvent(new Event(name));

    setTimeout(() => {
      for (const name of ANNOUNCE_EVENTS) window.removeEventListener(name, onAnnounce);
      resolve([...byRdns.values()]);
    }, timeoutMs);
  });
}

/**
 * The provider to talk to, in order of how much the choice can be trusted.
 *
 * 1. TronLink by `rdns` — the wallet this family was validated against.
 * 2. Any other announced Tron wallet. Announcing is a deliberate act, so a wallet here is
 *    claiming it can serve Tron; letting it through is what keeps a Backpack-only user from
 *    being told to uninstall things. Which one a user PREFERS is a picker question, not a
 *    discovery one — see D-222.
 * 3. `window.tron`, but only if it identifies itself as TronLink. This is the documented
 *    fallback for builds that predate the announcement, and the identity check is the whole
 *    point: an unchecked global is how we got here.
 *
 * Deliberately NOT a step: falling back to `window.tronLink` / `window.tronWeb`. Those are
 * the slots that were found hijacked; reaching for them after the others fail would restore
 * the exact bug this module exists to remove.
 */
export function selectTronProvider(
  announced: AnnouncedTronProvider[],
): { provider: TronProvider; info: TronProviderInfo | null } | null {
  const tronLink = announced.find((entry) => entry.info.rdns === TRONLINK_RDNS);
  if (tronLink) return { provider: tronLink.provider, info: tronLink.info };

  if (announced.length > 0) return { provider: announced[0].provider, info: announced[0].info };

  if (typeof window !== "undefined") {
    const legacyModern = (window as { tron?: unknown }).tron;
    if (isUsableProvider(legacyModern) && legacyModern.isTronLink === true) {
      return { provider: legacyModern, info: null };
    }
  }
  return null;
}

/** Discovery and selection in one call — what the bridge actually wants. */
export async function resolveTronProvider(timeoutMs?: number) {
  return selectTronProvider(await discoverTronProviders(timeoutMs));
}

// ── Network ────────────────────────────────────────────────────────────────────
// Chain ids from TronLink's integration docs, cross-checked against D-219's own note.

export const TRON_MAINNET_CHAIN_ID = "0x2b6653dc";
export const TRON_TESTNET_CHAIN_IDS: Record<string, string> = {
  "0x94a9059e": "Shasta",
  "0xcd8690dc": "Nile",
};

/**
 * Reads the chain the extension is pointed at, or `null` when it cannot be read.
 *
 * `null` is a real answer here, not a failure to paper over: the caller WARNS on a testnet
 * and stays quiet on an unreadable chain, because the app cannot fail closed on a signal it
 * cannot obtain. It is also honest about our actual leverage — the deposit transfer is sent
 * from inside the wallet, not through this app, so a wrong network is something IntentFolio
 * can flag but never prevent.
 */
export async function readTronChainId(provider: TronProvider): Promise<string | null> {
  try {
    const chainId = await provider.request({ method: "eth_chainId" });
    return typeof chainId === "string" ? chainId.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** `null` chain id ⇒ `null` verdict: unknown is not the same as wrong. */
export function tronNetworkWarning(chainId: string | null): string | null {
  if (chainId === null) return null;
  if (chainId === TRON_MAINNET_CHAIN_ID) return null;
  const name = TRON_TESTNET_CHAIN_IDS[chainId];
  return name
    ? `Your Tron wallet is on ${name}, not mainnet. Switch it before sending funds.`
    : `Your Tron wallet is on an unrecognised network (${chainId}), not mainnet.`;
}
