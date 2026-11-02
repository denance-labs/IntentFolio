// Registers all implemented family loaders with the neutral context (D-130).
import "./adapters/register-adapters";

export type {
  ChainKind,
  LoginWalletStatus,
  LoginWalletConnection,
  LoginWalletState,
  LoginWalletAdapter,
} from "./types";

export {
  LoginWalletProvider,
  useLoginWalletContext,
  useRegisterLoginWalletAdapter,
  registerFamilyLoader,
} from "./context/login-wallet-context";

export { useLoginWallet } from "./hooks/use-login-wallet";
export type { UseLoginWalletResult, LoginWalletHookStatus } from "./hooks/use-login-wallet";

export { WalletPicker } from "./components/wallet-picker";
export { NearKeyVerificationNotice } from "./components/near-key-verification-notice";

// D-280. The gate is NEAR-only, but the type is exported neutrally: B4 reads it from the
// money path, which does not know which family is active.
export type {
  NearKeyVerification,
  NearKeyVerificationOutcome,
} from "./lib/near-key-verification";

// D-280 B4 — the enforcement surface. `ensureCanOperate` is what the four money doors run;
// `canOperate` is the same answer for a screen that wants to explain itself without throwing.
export {
  canOperate,
  ensureCanOperate,
  NearKeyNotVerifiedError,
  NearKeyJustVerifiedError,
} from "./lib/near-key-verification";

export type { PersistedIdentity } from "./lib/persistence";
export {
  readIdentity,
  writeIdentity,
  clearIdentity,
  readLastUsedFamily,
  writeLastUsedFamily,
} from "./lib/persistence";

export { deriveIntentsAccountId } from "./lib/identity";
