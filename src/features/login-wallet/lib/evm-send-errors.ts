// D-445 part 2: why an EVM deposit stopped before the wallet sent anything, when the reason is the
// network switch. Thrown by the EVM adapter (`evm-bridge.tsx`), read by `evm-wallet-deposit.ts`.
// Both mean NOTHING was sent: the send is only asked for once the wallet is on the right chain.

/** The wallet did not answer the switch in time (WalletConnect hangs when it cannot switch). */
export class EvmChainSwitchTimeoutError extends Error {
  readonly chainId: number;
  constructor(chainId: number) {
    super(`The wallet did not switch to chain ${chainId} in time`);
    this.name = "EvmChainSwitchTimeoutError";
    this.chainId = chainId;
  }
}

/** The wallet refused or failed the switch for a reason other than the user declining it. */
export class EvmChainSwitchError extends Error {
  readonly chainId: number;
  constructor(chainId: number, cause: unknown) {
    super(`The wallet could not switch to chain ${chainId}`, { cause });
    this.name = "EvmChainSwitchError";
    this.chainId = chainId;
  }
}
