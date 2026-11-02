# IntentFolio — frontend

IntentFolio lets a user hold a multi-token, multi-chain crypto portfolio from one account on NEAR.
The user signs in with a wallet from any of six chain families, receives tokens from many chains
into one NEAR Intents account, and splits them into portfolios with a target percentage and a
tolerance band per token. Each portfolio's holdings are recorded by a vault contract on NEAR
mainnet. An off-chain solver then moves every portfolio toward its targets with NEAR Intents swaps.

This repository is the web app: a Next.js 15 / React 19 / TypeScript frontend, plus the small
server routes it needs (an RPC proxy, a gas relayer, and history reads).

Hosted app: **https://intentfolio.app** (NEAR mainnet, real funds).

## The problem

Keeping a target allocation across assets that live on different chains means juggling several
wallets, bridges and exchanges, and rebalancing by hand every time prices move. IntentFolio puts
the assets in one NEAR Intents account, lets the user describe the portfolio they want once, and
leaves the convergence toward it to the solver. A gas relayer submits what the user signs, so a
user who signs in from another chain does not need NEAR to pay for gas.

## How NEAR fits in

- **NEAR Intents account (`intents.near`).** Every user, whatever chain their wallet is on, gets an
  account in the NEAR Intents Verifier. Tokens received but not yet assigned to a portfolio (the
  *Funding Account*) live there.
- **Signing from six wallet families.** NEAR (HOT Connect), EVM (Reown AppKit / WalletConnect),
  Solana, TON, Stellar and Tron. Each family signs intents with the scheme the Verifier accepts for
  it (NEP-413, ERC-191, raw ed25519, TON Connect, SEP-53, TIP-191), and the Verifier checks the
  signature on NEAR. See `src/features/login-wallet/`.
- **Vault contract (`intentfolio-vault.near`).** Creating, funding, editing and withdrawing from a
  portfolio are envelopes the user signs once and the vault executes. The app builds them in
  `src/features/vault/lib/`.
- **Gas relayer.** `src/app/api/relay/route.ts` submits the signed envelopes and pays the gas from
  a relayer account, through FunctionCall access keys limited to one receiver and one method.
  Before it pays, it checks that the envelope is signed by the account it names and would pass
  on-chain.
- **Receiving and withdrawing across chains.** It uses the NEAR Intents PoA bridge and the 1Click
  API, with withdrawal intents built with `@defuse-protocol/intents-sdk` patterns. See
  `src/features/bridge/`.
- **Reads.** Balances, portfolios and history come from NEAR RPC through a same-origin proxy
  (`src/app/api/near-rpc/`, with a FastNEAR fallback) and the FastNEAR transaction API.

## Try it

### Hosted

1. Open https://intentfolio.app → the landing page (EN / ES toggle in the header).
2. Click **Open app** → the dashboard. Click **Build my first portfolio** → pick a preset mix or
   start from scratch, without connecting a wallet.
3. Connect a wallet (NEAR, EVM, Solana, TON, Stellar or Tron) → **My Account**, with your Funding
   Account and portfolios. Creating a real portfolio needs real funds on mainnet.

### Local (clean clone)

Requirements: Node.js 20.19 or newer, npm, and about 4 GB of free memory for the build.

```bash
git clone https://github.com/denance-labs/IntentFolio.git
cd IntentFolio
cp .env.example .env.local      # the only required value is already filled in
npm ci
npm run build
npm start                       # http://localhost:3000
```

Then:

| Do | See |
|---|---|
| Open `http://localhost:3000` | The landing page. |
| Open `http://localhost:3000/learn` | The Guide: how a portfolio, its targets and bands work. |
| Open `http://localhost:3000/dashboard`, click **Build my first portfolio** | "Choose a starting point": preset mixes (Conservative, Balanced, Aggressive) or your own, with no wallet connected. |
| Run `npm test` | 5,270 tests pass; the integration tests that need a database are skipped. |

A local run reads mainnet but does not move funds: the real-funds paths stay off unless you set
the flags in `.env.local` (see the comments there). The Performance and Evolution charts read a
history database that a local run does not have; the hosted app has it.

### Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run build` raises Node's heap limit to 4 GB: a build from a clean clone does not fit in the
default limit. It prints `Module not found` warnings for optional dependencies of the wallet SDKs
(`@metamask/connect-evm`, `pino-pretty`); they are expected and do not fail the build.

## Project structure

```text
src/
  app/                  Next.js routes: landing, /learn, /dashboard, API routes
  content/              Editable product content (presets, links)
  features/
    login-wallet/       Sign-in for the six wallet families and identity derivation
    intents-account/    The user's NEAR Intents account and Funding Account
    vault/              Vault envelopes, relay client, operations records
    bridge/             Receive (deposits) and withdrawals across chains
    portfolio-editor/   Building and editing a portfolio's composition
    dashboard-shell/    Dashboard tabs: Overview, Composition, Evolution, Performance, Activity
    history-recorder/   Value-history recording and reads
    market/             Token registry and prices
    landing/, learn/    Public pages
```

## License

MIT. See `LICENSE`. Third-party code and its licenses are listed in `ATTRIBUTIONS.md`.
