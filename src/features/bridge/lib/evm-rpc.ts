// Where the EVM chains Receive takes deposits on are read (D-445 part 2): the connected wallet's
// balances on Ethereum, Arbitrum and Base.
//
// A table of its own, NOT `EVM_RPC_URLS` in `hot-fee.ts`: that module reads "the chain is in my
// table" as one of the conditions of a HOT withdrawal (`hotFeeSupported`), so adding these three
// chains there would change a money-path gate for nothing. Same rules, though: public endpoints,
// the env key first with the defaults behind it, no retries per endpoint, a budget split between
// them so one that hangs cannot eat the next one's turn.
//
// Chosen by measurement (2026-10-25, `Origin: https://intentfolio.app`): each one answers CORS for
// our origin and serves `eth_call` and `eth_getBalance` without a key. Left out: `cloudflare-eth.com`
// ("Internal error" on every state read), `api.zan.top` (no `eth_call` for unregistered accounts —
// the Polygon backup in `hot-fee.ts` only needs `eth_gasPrice`), `1rpc.io/eth` (rate-limited on
// the first call) and `eth.llamarpc.com` (HTTP 525).
//
// ⚠️ Known gap: the DNS that blocked publicnode and drpc for a tester (s200, see `hot-fee.ts`)
// would block both Ethereum endpoints. Reads here fail closed — the wallet's tokens on that chain
// just do not show.

import { createPublicClient, fallback, http, type PublicClient } from "viem";

/** Same as `hot-fee.ts`: an env key present but empty falls back instead of becoming the URL. */
function rpcList(envUrl: string | undefined, ...defaults: string[]): readonly string[] {
  return envUrl ? [envUrl, ...defaults.filter((u) => u !== envUrl)] : defaults;
}

// Named one by one: Next.js only inlines `process.env.NEXT_PUBLIC_*` when the reference is literal.
export const EVM_DEPOSIT_RPC_URLS: Record<string, readonly string[]> = {
  "eth:1": rpcList(
    process.env.NEXT_PUBLIC_EVM_RPC_ETHEREUM,
    "https://ethereum-rpc.publicnode.com",
    "https://eth.drpc.org"
  ),
  "eth:42161": rpcList(
    process.env.NEXT_PUBLIC_EVM_RPC_ARBITRUM,
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum-one-rpc.publicnode.com"
  ),
  "eth:8453": rpcList(
    process.env.NEXT_PUBLIC_EVM_RPC_BASE,
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com"
  ),
};

/** The whole read's budget, shared by the endpoints of one chain (`hot-fee.ts` uses the same 10 s). */
const READ_BUDGET_MS = 10_000;

const clients = new Map<string, PublicClient>();

/** A read-only client for `chainId`, one per chain for the page's life. Throws for a chain not listed. */
export function evmDepositClient(chainId: string): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;
  const urls = EVM_DEPOSIT_RPC_URLS[chainId];
  if (!urls?.length) throw new Error(`No EVM RPC configured for ${chainId}`);
  const perEndpointMs = Math.floor(READ_BUDGET_MS / urls.length);
  const transports = urls.map((url) => http(url, { retryCount: 0, timeout: perEndpointMs }));
  const client = createPublicClient({
    transport: transports.length === 1 ? transports[0] : fallback(transports, { retryCount: 0 }),
  });
  clients.set(chainId, client);
  return client;
}
