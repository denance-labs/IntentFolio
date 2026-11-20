// Receive's deposit address comes from our server since PoA's Bridge API closed (D-584).
export { getDepositAddress, type DepositAddress } from "./lib/deposit-address-client";

export {
  chainRegistry,
  getChainMeta,
  type ChainMeta,
} from "./lib/chain-registry";

export { ReceiveModal } from "./components/receive-modal";
export { WithdrawalModal } from "./components/withdrawal-modal";
export { bridgeTranslations } from "./lib/translations";
export { dismissWithdrawal, usePendingWithdrawals } from "./hooks/use-pending-withdrawals";
export { dismissedWithdrawTxHashes } from "./lib/withdraw-rescue-store";
