import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { arbitrum, base, mainnet, type AppKitNetwork } from "@reown/appkit/networks";
import { createAppKit } from "@reown/appkit/react";
import { OptionsController } from "@reown/appkit-controllers";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

// D-445 part 2: Arbitrum and Base too, the other two chains Receive takes from an EVM wallet. Login
// signs a message on whatever chain the wallet is on; a deposit asks the wallet to switch, and a
// WalletConnect session can only switch to the chains it was opened with (a session from before
// this change needs a reconnect for them). Mainnet stays first: it is the default network.
const networks: [AppKitNetwork, ...AppKitNetwork[]] = [mainnet, arbitrum, base];

// ssr:true defers wagmi's reconnect (onMount) to a post-mount useEffect instead of
// running it during the Hydrate component's render. Without it, the reconnect updates
// the wagmi store while Hydrate is rendering, forcing EvmAdapterBridge (a useAccount
// subscriber) to update mid-render — the "Cannot update a component while rendering a
// different one" warning — which drives an infinite re-render loop (repeated price
// fetches / adapter re-registration).
export const wagmiAdapter = new WagmiAdapter({ networks, projectId, ssr: true });
export const wagmiConfig = wagmiAdapter.wagmiConfig;

// The Base Account connector auto-instantiates a provider that polls eth_accounts and
// POSTs Coinbase analytics events (cca-lite.coinbase.com/amp) on every response;
// subscribed components re-render and re-trigger the poll, producing an accelerating
// render/telemetry loop. This app connects via injected wallets + WalletConnect only.
// AppKit 1.8.20 wires `enableCoinbase` (below) but NOT `enableBaseAccount` — createAppKit
// silently ignores it (no setEnableBaseAccount call in initControllers) — so we set the
// OptionsController flag directly before createAppKit. initControllers never overwrites it,
// and the wagmi adapter's addThirdPartyConnectors reads it, skipping the base-account SDK.
OptionsController.setEnableBaseAccount(false);

// Singleton modal — called once when this module is first imported (client-side only
// via dynamic import from register-adapters.ts). Subsequent imports are no-ops.
createAppKit({
  adapters: [wagmiAdapter],
  networks,
  projectId,
  features: { analytics: false, swaps: false, onramp: false },
  enableCoinbase: false,
});
