import type { NearNetwork } from "../config/network";

export type WalletAdapterStatus =
  | "initializing"
  | "signed-out"
  | "signing-in"
  | "signed-in"
  | "error";

export type WalletAdapterState =
  | { status: "initializing"; signedAccountId: null; walletNetwork: null; error: null }
  | { status: "signed-out"; signedAccountId: null; walletNetwork: null; error: null }
  | { status: "signing-in"; signedAccountId: null; walletNetwork: null; error: null }
  | { status: "signed-in"; signedAccountId: string; walletNetwork: NearNetwork; error: null }
  | { status: "error"; signedAccountId: null; walletNetwork: null; error: string };

export type WalletAdapter = {
  state: WalletAdapterState;
  dappNetwork: NearNetwork;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
};
