"use client";

// Side-effect module: registers each implemented family's lazy loader with
// the neutral LoginWalletContext (D-130). Import this module once at app startup
// (currently: re-exported from the login-wallet barrel so it runs whenever the
// LoginWalletProvider is imported).
import { registerFamilyLoader } from "../context/login-wallet-context";

registerFamilyLoader("near", () => import("./near/index"));
registerFamilyLoader("evm", () => import("./evm/index"));
registerFamilyLoader("solana", () => import("./solana/index"));
registerFamilyLoader("ton", () => import("./ton/index"));
registerFamilyLoader("stellar", () => import("./stellar/index"));
registerFamilyLoader("tron", () => import("./tron/index"));
