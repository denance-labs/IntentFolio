// FamilyModule shape consumed by LoginWalletContext's lazy-mount (D-130).
// FamilyProvider is a passthrough (Varial needs no React context); FamilyAdapterBridge is headless.
export { StellarWalletProvider as FamilyProvider } from "./stellar-provider";
export { StellarAdapterBridge as FamilyAdapterBridge } from "./stellar-bridge";
