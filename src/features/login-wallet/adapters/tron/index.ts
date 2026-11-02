// FamilyModule shape consumed by LoginWalletContext's lazy-mount (D-130).
// FamilyProvider is a passthrough (TronLink needs no React context); FamilyAdapterBridge is headless.
export { TronWalletProvider as FamilyProvider } from "./tron-provider";
export { TronAdapterBridge as FamilyAdapterBridge } from "./tron-bridge";
