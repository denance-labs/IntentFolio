# Attributions

Code, data and patterns in this project that are derived from external sources. Files that derive
from an entry carry an inline `Attribution: see ATTRIBUTIONS.md #N` comment.

| # | What | Our files | Source | License |
|---|---|---|---|---|
| 1 | Token registry | `src/features/market/lib/token-registry.ts` | 1Click token catalog, <https://1click.chaindefuser.com/v0/tokens> | Public API data |
| 2 | Chain registry | `src/features/bridge/lib/chain-registry.ts` | PoA bridge `supported_tokens`, <https://bridge.chaindefuser.com/rpc> | Public API data |
| 3 | Signature schemes (`nep413`, `erc191`, `raw_ed25519`, `ton_connect`, `sep53`, `tip191`, `webauthn`) | `src/features/intents-account/mock-contract/types.ts`, `src/features/login-wallet/adapters/*/*-sign.ts` | NEAR Intents Verifier multi-payload spec (`near/intents`), `@defuse-protocol/intents-sdk` | Protocol spec / SDK API |
| 4 | PoA bridge client | `src/features/bridge/lib/bridge-client.ts`, `src/features/bridge/lib/withdrawal-fee.ts` | `@defuse-protocol/internal-utils` 0.34.0 (`poaBridge`) | Package dependency |
| 5 | Receive deposit UI (network picker, passive deposit) | `src/features/bridge/components/receive-modal.tsx` | `defuse-protocol/defuse-frontend`, `src/components/DefuseSDK/` | MIT (© 2024 Defuse) |
| 6 | Withdrawal registry | `src/features/bridge/lib/withdrawal-registry.ts` | PoA bridge `supported_tokens`, <https://bridge.chaindefuser.com/rpc> | Public API data |
| 7 | Wallet and network icons | `public/wallet-icons/`, `src/features/market/lib/token-icons.tsx` | Tonkeeper (TonConnect wallets list), Freighter (`stellar/freighter`), TronLink (`TronLink/tronlink-extension`); other marks from `@web3icons/react` 4.1.17 | Trademarks used nominatively; `@web3icons/react` MIT |
| 8 | Vault payloads and NEP-413 envelope | `src/features/vault/lib/vault-payloads.ts`, `vault-envelope.ts`, `vault-signer.ts`, `vault-events.ts`, `unallocate-submit.ts` | IntentFolio vault contract (first-party); nonce layout from `near/intents` `defuse-core`; `@defuse-protocol/contract-types` 0.6.4; `@defuse-protocol/internal-utils` 0.34.0 | First-party; upstream package licenses |
| 9 | Withdrawal intents | `src/features/bridge/lib/withdraw-envelope.ts` | `@defuse-protocol/intents-sdk` 0.76.0 bridge utilities (read, not a dependency) | Upstream package license |
| 10 | Withdrawal publish, settlement and delivery | `src/features/bridge/lib/withdraw-submit.ts`, `withdraw-poll.ts`, `withdraw-errors.ts`, `src/features/vault/lib/near-view.ts` | `@defuse-protocol/internal-utils` 0.34.0 (`solverRelay`, `poaBridge`); `@defuse-protocol/intents-sdk` 0.76.0 (`direct-bridge`) | Upstream package licenses |
| 11 | HOT Omni withdrawal fee and `mt_withdraw` builder | `src/features/bridge/lib/hot-fee.ts`, `hot-envelope.ts`, `hot-delivery.ts` | `@defuse-protocol/intents-sdk` 0.78.0; `@hot-labs/omni-sdk` 2.25.5 | Upstream package licenses |
| 12 | Tron, Bitcoin and Litecoin address checks | `src/features/bridge/lib/address-validation.ts` | `@defuse-protocol/intents-sdk` 0.78.0 `validateAddress` | Upstream package license |
| 13 | Gas purchase and converting withdrawals | `src/features/bridge/lib/gas-purchase.ts`, `oneclick-conversion-quote.ts`, `conversion-routes.ts`, `conversion-envelope.ts` | 1Click API v0 | Public HTTP API; no code copied |
| 14 | NEAR wallet picker filter and wallet manifest | `src/features/wallet/adapter/near-wallet-provider.test.ts` | `@hot-labs/near-connect` (`availableWallets`); `hot-dao/near-selector` manifest | Upstream package license; public catalog |
| 15 | NEAR account key registration on `intents.near` | `src/features/login-wallet/lib/near-key-registration.ts`, `near-key-verification.ts`, `near-key-register.ts` | `intents.near` mainnet contract; near.com's verification flow (observed, no code copied) | Public contract |
| 16 | Relayer FunctionCall access keys | `src/features/vault/lib/relay-sender.ts`, `relay-rpc-provider.ts`, `relay-service.ts` | `near-api-js` 7.2.0, `@near-js/transactions` | MIT and Apache-2.0; ISC |
| 17 | Operations record schema | `src/features/vault/lib/ops-records-types.ts`, `ops-records-service.ts`, `allocate-rescue-store.ts`, `allocate-poll.ts` | IntentFolio operations backend (first-party) | First-party |
| 18 | Stored envelope shape | `src/features/vault/lib/allocate-submit.ts`, `ops-records-types.ts`, `allocate-rescue-store.ts` | IntentFolio operations backend (first-party) | First-party |
| 19 | Health endpoint and alert contract | `src/app/api/ops/health/route.ts`, `src/features/vault/lib/ops-health.ts`, `ops-alerts.ts`, `src/features/history-recorder/lib/history-health.ts` | IntentFolio operations backend (first-party) | First-party |
| 20 | Vault storage-key layout | `src/features/vault/lib/allocate-seal.ts`, `relay-gate.ts` | IntentFolio vault contract (first-party) | First-party |
| 21 | Portfolio history transport | `src/features/vault/lib/vault-history-client.ts`, `vault-history.ts`, `src/features/dashboard-shell/lib/account-activity.ts` | FastNEAR transaction API, `tx.main.fastnear.com` | Public HTTP API; no code copied |
| 22 | Deposit from a NEAR wallet | `src/features/bridge/lib/near-wallet-deposit.ts` | `defuse-protocol/defuse-frontend` deposit services; NEP-141, NEP-145, `wrap.near` | MIT (© 2024 Defuse); re-implemented, no file copied |
| 23 | Deposit from a connected EVM wallet | `src/features/bridge/lib/evm-wallet-deposit.ts`, `src/features/login-wallet/adapters/evm/evm-bridge.tsx` | `defuse-protocol/defuse-frontend` EVM deposit and fee estimate | MIT (© 2024 Defuse); re-implemented, no file copied |
