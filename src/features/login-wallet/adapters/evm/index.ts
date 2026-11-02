// FamilyModule shape consumed by LoginWalletContext's lazy-mount (D-130).
// FamilyProvider sets up WagmiProvider; FamilyAdapterBridge is headless.
export { EvmWalletProvider as FamilyProvider } from "./evm-provider";
export { EvmAdapterBridge as FamilyAdapterBridge } from "./evm-bridge";
