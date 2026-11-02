// FamilyModule shape consumed by LoginWalletContext's lazy-mount (D-130).
// FamilyProvider sets up ConnectionProvider + WalletProvider + WalletModalProvider; FamilyAdapterBridge is headless.
export { SolanaWalletProvider as FamilyProvider } from "./solana-provider";
export { SolanaAdapterBridge as FamilyAdapterBridge } from "./solana-bridge";
