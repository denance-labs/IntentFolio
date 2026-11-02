// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/react";

// Controllable mock of the HOT Connect lib behind the NEAR adapter.
const mocks = vi.hoisted(() => ({
  lib: null as unknown,
  signOut: vi.fn(),
}));

vi.mock("near-connect-hooks", () => ({
  useNearWallet: () => mocks.lib,
}));

import { NearAdapterBridge } from "./near-bridge";
import { LoginWalletProvider, useLoginWalletContext } from "../../context/login-wallet-context";

function baseLib(overrides: Record<string, unknown> = {}) {
  const signedAccountId = (overrides.signedAccountId as string | undefined) ?? "alice.testnet";
  return {
    loading: false,
    signedAccountId,
    network: "testnet",
    signIn: vi.fn(),
    signOut: mocks.signOut,
    connector: {
      whenManifestLoaded: Promise.resolve(),
      connect: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      getConnectedWallet: vi.fn(async () => ({
        wallet: { manifest: { id: "meteor-wallet", name: "Meteor Wallet" } },
        accounts: [{ accountId: signedAccountId, publicKey: null }],
      })),
    },
    signNEP413Message: vi.fn(),
    ...overrides,
  };
}

function renderBridge() {
  return render(
    <LoginWalletProvider>
      <NearAdapterBridge />
    </LoginWalletProvider>,
  );
}

describe("NearAdapterBridge reject-at-door (D-120)", () => {
  beforeEach(() => {
    mocks.signOut.mockClear();
    localStorage.clear();
  });

  it("signs out when the connected NEAR wallet is not on mainnet", async () => {
    mocks.lib = baseLib({ network: "testnet" });
    renderBridge();
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(1));
  });

  it("does not sign out when the wallet is on mainnet", async () => {
    mocks.lib = baseLib({ network: "mainnet" });
    renderBridge();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("does not sign out before an account is connected", async () => {
    mocks.lib = baseLib({ signedAccountId: "", network: "testnet" });
    renderBridge();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D-280 B2 — the key-registration gate
// ---------------------------------------------------------------------------
//
// What these defend is WHEN the prompt is spent. The gate needs a signature to learn the
// key (B0: two of four wallets report `publicKey: null` up front), and a signature is a
// wallet popup, so the difference between "on connect" and "on every render/reload" is the
// difference between one expected prompt and a product that nags.

const ACCOUNT = "pablofork.near";
const SIGNING_KEY = "ed25519:2EVgyHyRbaLZjSDPzR8bnLTiPWtTYQ9GLNvtDoHZ4qGB";

/** Renders the gate state and exposes connect(), so the test drives the real context. */
function Probe() {
  const ctx = useLoginWalletContext();
  return (
    <>
      <span data-testid="kind">{ctx.keyVerification.kind}</span>
      <button type="button" onClick={() => void ctx.connect()}>
        connect
      </button>
      <button type="button" onClick={() => void ctx.verifyKey()}>
        verify
      </button>
      <button type="button" onClick={() => void ctx.registerKey()}>
        register
      </button>
    </>
  );
}

function renderWithProbe() {
  return render(
    <LoginWalletProvider>
      <NearAdapterBridge />
      <Probe />
    </LoginWalletProvider>,
  );
}

function mockHasPublicKey(value: unknown): Response {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
  return new Response(
    JSON.stringify({ result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function connectorSnapshot(walletId: string, reportedPublicKey: string | null) {
  return {
    whenManifestLoaded: Promise.resolve(),
    connect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getConnectedWallet: vi.fn(async () => ({
      wallet: { manifest: { id: walletId, name: walletId } },
      accounts: [{ accountId: ACCOUNT, publicKey: reportedPublicKey }],
    })),
  };
}

describe("NearAdapterBridge key-registration gate (D-280 B2)", () => {
  let signNEP413Message: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    signNEP413Message = vi.fn(async () => ({
      accountId: ACCOUNT,
      publicKey: SIGNING_KEY,
      signature: "sig",
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockHasPublicKey(true)));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does NOT prompt for a signature when a session is restored on load", async () => {
    // Without a previously signed tuple there is no exact key to re-read. Restoration must
    // not invent one or open a wallet popup for somebody who only wanted to read a balance.
    mocks.lib = baseLib({ network: "mainnet", signedAccountId: ACCOUNT, signNEP413Message });
    const { getByTestId } = renderWithProbe();
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("unchecked"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signNEP413Message).not.toHaveBeenCalled();
  });

  it("silently rechecks the exact persisted account, wallet and signing key on reload", async () => {
    localStorage.setItem(
      "intentfolio.near-key-proof.v1",
      JSON.stringify({ accountId: ACCOUNT, walletId: "meteor-wallet", publicKey: SIGNING_KEY }),
    );
    mocks.lib = baseLib({ network: "mainnet", signedAccountId: ACCOUNT, signNEP413Message });

    const { getByTestId } = renderWithProbe();

    await waitFor(() => expect(getByTestId("kind").textContent).toBe("registered"));
    expect(signNEP413Message).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not carry a proof into a different wallet on the same account", async () => {
    localStorage.setItem(
      "intentfolio.near-key-proof.v1",
      JSON.stringify({ accountId: ACCOUNT, walletId: "meteor-wallet", publicKey: SIGNING_KEY }),
    );
    mocks.lib = baseLib({
      network: "mainnet",
      signedAccountId: ACCOUNT,
      signNEP413Message,
      connector: connectorSnapshot("hot-wallet", SIGNING_KEY),
    });

    const { getByTestId } = renderWithProbe();

    await waitFor(() => expect(getByTestId("kind").textContent).toBe("unchecked"));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(signNEP413Message).not.toHaveBeenCalled();
  });

  it("does not reuse a proof when the same wallet reports a different current key", async () => {
    localStorage.setItem(
      "intentfolio.near-key-proof.v1",
      JSON.stringify({ accountId: ACCOUNT, walletId: "meteor-wallet", publicKey: SIGNING_KEY }),
    );
    mocks.lib = baseLib({
      network: "mainnet",
      signedAccountId: ACCOUNT,
      signNEP413Message,
      connector: connectorSnapshot("meteor-wallet", "ed25519:different"),
    });

    const { getByTestId } = renderWithProbe();

    await waitFor(() => expect(getByTestId("kind").textContent).toBe("unchecked"));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("silently closes the gate when the persisted pair was revoked on-chain", async () => {
    localStorage.setItem(
      "intentfolio.near-key-proof.v1",
      JSON.stringify({ accountId: ACCOUNT, walletId: "meteor-wallet", publicKey: SIGNING_KEY }),
    );
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockHasPublicKey(false));
    mocks.lib = baseLib({ network: "mainnet", signedAccountId: ACCOUNT, signNEP413Message });

    const { getByTestId } = renderWithProbe();

    await waitFor(() => expect(getByTestId("kind").textContent).toBe("not-registered"));
    expect(signNEP413Message).not.toHaveBeenCalled();
  });

  it("signs in and verifies in one supported wallet interaction", async () => {
    let onCombined:
      | ((payload: { accounts: Array<{ accountId: string; signedMessage: unknown }> }) => void)
      | undefined;
    const connector = {
      whenManifestLoaded: Promise.resolve(),
      on: vi.fn((event: string, callback: typeof onCombined) => {
        if (event === "wallet:signInAndSignMessage") onCombined = callback;
      }),
      off: vi.fn(),
      getConnectedWallet: vi.fn(async () => ({
        wallet: { manifest: { id: "meteor-wallet", name: "Meteor Wallet" } },
        accounts: [{ accountId: ACCOUNT, publicKey: null }],
      })),
      connect: vi.fn(async (input: { signMessageParams?: unknown }) => {
        expect(input.signMessageParams).toMatchObject({
          recipient: "intentfolio.app",
          message: expect.stringMatching(/Sign in to IntentFolio/),
          nonce: expect.any(Uint8Array),
        });
        onCombined?.({
          accounts: [
            {
              accountId: ACCOUNT,
              signedMessage: {
                accountId: ACCOUNT,
                publicKey: SIGNING_KEY,
                signature: "sig",
              },
            },
          ],
        });
      }),
    };
    const lib = baseLib({ network: "mainnet", signedAccountId: "", signNEP413Message, connector });
    mocks.lib = lib;
    const { getByTestId, getByText } = renderWithProbe();
    fireEvent.click(getByText("connect"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("registered"));
    expect(connector.connect).toHaveBeenCalledTimes(1);
    // The standalone call is the broken two-interaction path measured twice with Meteor.
    expect(signNEP413Message).not.toHaveBeenCalled();
    // D-225: the combined signature proves ownership and must persist the session before any
    // portfolio operation is attempted.
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("intentfolio.identity") ?? "null")).toEqual({
        chainKind: "near",
        address: ACCOUNT,
        intentsAccountId: ACCOUNT,
      }),
    );
    expect(JSON.parse(localStorage.getItem("intentfolio.near-key-proof.v1") ?? "null")).toEqual({
      accountId: ACCOUNT,
      walletId: "meteor-wallet",
      publicKey: SIGNING_KEY,
    });
    // The account checked on-chain is the one returned alongside the combined signature.
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(JSON.parse(atob(body.params.args_base64)).account_id).toBe(ACCOUNT);
    expect(connector.off).toHaveBeenCalledWith(
      "wallet:signInAndSignMessage",
      expect.any(Function),
    );
  });

  it("verifies on demand, which is how a restored session gets out of `unchecked`", async () => {
    mocks.lib = baseLib({ network: "mainnet", signedAccountId: ACCOUNT, signNEP413Message });
    const { getByTestId, getByText } = renderWithProbe();
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("unchecked"));
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("registered"));
  });

  it("reports `not-registered` without inventing it from a failed read", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockHasPublicKey(false));
    mocks.lib = baseLib({ network: "mainnet", signedAccountId: ACCOUNT, signNEP413Message });
    const { getByTestId, getByText } = renderWithProbe();
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("not-registered"));
    // Registration gates money, not login persistence: the signer/account pair was already
    // proven before the chain answered "not registered".
    expect(JSON.parse(localStorage.getItem("intentfolio.identity") ?? "null")).toEqual({
      chainKind: "near",
      address: ACCOUNT,
      intentsAccountId: ACCOUNT,
    });
  });

  it("reports `unknown`, not `not-registered`, when the chain read fails", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.lib = baseLib({ network: "mainnet", signedAccountId: ACCOUNT, signNEP413Message });
    const { getByTestId, getByText } = renderWithProbe();
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("unknown"));
  });

  it("starts an implicit account at `not-required` and never prompts it", async () => {
    const implicit = "8b58bb68e6ba82b2ba0f9dc4e5f9f4e0f2c4de5c0a0a1c2b3d4e5f60718293a4";
    mocks.lib = baseLib({ network: "mainnet", signedAccountId: implicit, signNEP413Message });
    const { getByTestId } = renderWithProbe();
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("not-required"));
    expect(signNEP413Message).not.toHaveBeenCalled();
  });

  it("throws the in-memory answer away when the account changes", async () => {
    // Two wallets can drive the same account with different keys, and registration is per
    // key, so a previous `registered` is not evidence about whoever is connected now.
    const lib = baseLib({ network: "mainnet", signedAccountId: ACCOUNT, signNEP413Message });
    mocks.lib = lib;
    const { getByTestId, getByText, rerender } = renderWithProbe();
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("registered"));

    lib.signedAccountId = "other.near";
    rerender(
      <LoginWalletProvider>
        <NearAdapterBridge />
        <Probe />
      </LoginWalletProvider>,
    );
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("unchecked"));
  });

  it("stops at `signer-mismatch` and reads nothing when the wallet signs as another account", async () => {
    signNEP413Message.mockResolvedValue({
      accountId: "intentfolio-admin.near",
      publicKey: SIGNING_KEY,
      signature: "sig",
    });
    mocks.lib = baseLib({ network: "mainnet", signedAccountId: ACCOUNT, signNEP413Message });
    const { getByTestId, getByText } = renderWithProbe();
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("signer-mismatch"));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not spend a prompt on a wallet that is about to be bounced off testnet", async () => {
    const lib = baseLib({
      network: "testnet",
      signedAccountId: "",
      signNEP413Message,
      signIn: vi.fn(async () => {
        lib.signedAccountId = ACCOUNT;
      }),
    });
    mocks.lib = lib;
    const { getByText } = renderWithProbe();
    fireEvent.click(getByText("connect"));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalled());
    expect(signNEP413Message).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D-280 B3 — the registration transaction
// ---------------------------------------------------------------------------
//
// What these defend is the WIRING, not the transaction logic (near-key-register.test.ts owns
// that): which state the pair comes from, and which states are refused outright. Every
// refusal below is a transaction that would otherwise be signed and paid for.

describe("NearAdapterBridge key registration (D-280 B3)", () => {
  let signNEP413Message: ReturnType<typeof vi.fn>;
  let signAndSendTransaction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    signNEP413Message = vi.fn(async () => ({
      accountId: ACCOUNT,
      publicKey: SIGNING_KEY,
      signature: "sig",
    }));
    signAndSendTransaction = vi.fn(async () => ({ status: { SuccessValue: "" } }));
    // Not registered on the first read, registered once the transaction has landed. Anything
    // that concluded `registered` without that second read would pass with only the first.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(mockHasPublicKey(false))
        .mockResolvedValue(mockHasPublicKey(true)),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderGated(overrides: Record<string, unknown> = {}) {
    mocks.lib = baseLib({
      network: "mainnet",
      signedAccountId: ACCOUNT,
      signNEP413Message,
      signAndSendTransaction,
      ...overrides,
    });
    return renderWithProbe();
  }

  it("sends add_public_key for the key it saw sign, and only then reads `registered`", async () => {
    const { getByTestId, getByText } = renderGated();
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("not-registered"));

    fireEvent.click(getByText("register"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("registered"));

    // 🔴 The key in the transaction is the one the wallet SIGNED with, taken off the state —
    // never `getConnectedWallet().accounts[0].publicKey`, which is `null` on two of the four
    // wallets B0 measured, and never one off `getAccessKeyList`, which cannot say which of an
    // account's three FullAccess keys does the signing.
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
    expect(signAndSendTransaction).toHaveBeenCalledWith({
      receiverId: "intents.near",
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "add_public_key",
            args: { public_key: SIGNING_KEY },
            gas: "5000000000000",
            deposit: "1",
          },
        },
      ],
    });
  });

  it("re-reads the chain about the same pair after the transaction", async () => {
    const { getByTestId, getByText } = renderGated();
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("not-registered"));
    fireEvent.click(getByText("register"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("registered"));

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const args = JSON.parse(atob(JSON.parse(calls[calls.length - 1][1].body).params.args_base64));
    expect(args).toEqual({ account_id: ACCOUNT, public_key: SIGNING_KEY });
  });

  it.each([
    [
      "signer-mismatch",
      // 🔴 The measured mainnet contamination: registering this pair authorises one
      // account's key under another's, which is the exact failure already sitting on chain.
      { accountId: "intentfolio-admin.near", publicKey: SIGNING_KEY, signature: "sig" },
    ],
    [
      "unknown",
      // A wallet that signed but reported no key. B1 answers `unknown` for that without
      // touching the RPC, and there is simply nothing to put in `add_public_key`.
      { accountId: ACCOUNT, publicKey: "", signature: "sig" },
    ],
  ] as const)("sends NOTHING from %s", async (expected, signed) => {
    signNEP413Message.mockResolvedValue(signed);
    const { getByTestId, getByText } = renderGated();
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe(expected));

    fireEvent.click(getByText("register"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signAndSendTransaction).not.toHaveBeenCalled();
    // And the state is left exactly as it was: a silent no-op that also cleared the banner
    // would hide the very thing the user has to act on.
    expect(getByTestId("kind").textContent).toBe(expected);
  });

  it("sends nothing from `unchecked` — there is no verified key in hand", async () => {
    const { getByTestId, getByText } = renderGated();
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("unchecked"));
    fireEvent.click(getByText("register"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("refuses when the wallet moved to another account between the banner and the click", async () => {
    // The user can switch the active account in the extension while the banner is on screen.
    // Registering `pablofork.near`'s key while the wallet is on `other.near` is how the pair
    // gets crossed — refuse rather than adapt.
    const lib = baseLib({
      network: "mainnet",
      signedAccountId: ACCOUNT,
      signNEP413Message,
      signAndSendTransaction,
    });
    mocks.lib = lib;
    const { getByTestId, getByText } = renderWithProbe();
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("not-registered"));

    lib.signedAccountId = "other.near";
    fireEvent.click(getByText("register"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("reports `register-failed` when the wallet cannot send, leaving the offer up", async () => {
    signAndSendTransaction.mockRejectedValue(new Error("Not enough balance for gas"));
    const { getByTestId, getByText } = renderGated();
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("not-registered"));
    fireEvent.click(getByText("register"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("register-failed"));
  });

  it("reports `register-declined` when the user rejects it in the wallet", async () => {
    signAndSendTransaction.mockRejectedValue(new Error("User rejected the request"));
    const { getByTestId, getByText } = renderGated();
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("not-registered"));
    fireEvent.click(getByText("register"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("register-declined"));
    // A choice, not a fault — and the retry sends the SAME key, which is what makes
    // `register-declined` safe to offer a button from.
    fireEvent.click(getByText("register"));
    await waitFor(() => expect(signAndSendTransaction).toHaveBeenCalledTimes(2));
    expect(signAndSendTransaction.mock.calls[1][0].actions[0].params.args).toEqual({
      public_key: SIGNING_KEY,
    });
  });
});

// ---------------------------------------------------------------------------
// D-280 B4 — `verifyKey` has to RETURN what it concluded
// ---------------------------------------------------------------------------
//
// B2 and B3 only ever needed it to publish state for the banner to render. The money door
// awaits it inside a single click and acts on the answer, and React has not re-rendered by
// then — so a `verifyKey` that resolved with nothing would leave the door reading the
// PRE-verification state. Every early exit has to answer with a state that denies.

/** Renders the gate and records what `verifyKey()` resolved with. */
function ReturnProbe({ sink }: { sink: { last: unknown } }) {
  const ctx = useLoginWalletContext();
  return (
    <>
      <span data-testid="kind">{ctx.keyVerification.kind}</span>
      <button
        type="button"
        onClick={() => {
          void ctx.verifyKey().then((outcome) => {
            sink.last = outcome;
          });
        }}
      >
        verify
      </button>
    </>
  );
}

describe("NearAdapterBridge verifyKey return value (D-280 B4)", () => {
  let sink: { last: unknown };

  beforeEach(() => {
    localStorage.clear();
    sink = { last: undefined };
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderReturning(overrides: Record<string, unknown> = {}) {
    mocks.lib = baseLib({
      network: "mainnet",
      signedAccountId: ACCOUNT,
      signNEP413Message: vi.fn(async () => ({
        accountId: ACCOUNT,
        publicKey: SIGNING_KEY,
        signature: "sig",
      })),
      ...overrides,
    });
    return render(
      <LoginWalletProvider>
        <NearAdapterBridge />
        <ReturnProbe sink={sink} />
      </LoginWalletProvider>,
    );
  }

  it("resolves with the same outcome it publishes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockHasPublicKey(true)));
    const { getByText, getByTestId } = renderReturning();
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("registered"));
    await waitFor(() => expect(sink.last).toMatchObject({ kind: "registered", accountId: ACCOUNT }));
  });

  it("resolves with a DENYING state when the chain says the key is not registered", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockHasPublicKey(false)));
    const { getByText, getByTestId } = renderReturning();
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(getByTestId("kind").textContent).toBe("not-registered"));
    expect(sink.last).toMatchObject({ kind: "not-registered" });
  });

  it("resolves `unchecked` — never a pass — when there is no connected account", async () => {
    // 🔴 The early exit. Returning `undefined` here would be read by the door as "verify
    // resolved", and returning anything the allowlist admits would open the money path for a
    // session that has no account at all.
    vi.stubGlobal("fetch", vi.fn());
    const { getByText } = renderReturning({ signedAccountId: "" });
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(sink.last).toEqual({ kind: "unchecked" }));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("resolves `unchecked` when the wallet switched accounts while the prompt was open", async () => {
    // The answer is about the account the user has LEFT. B2 already refuses to publish it;
    // B4 must not hand it to the money door either, which is a second place to get this
    // wrong now that the value escapes the component.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockHasPublicKey(true)));
    const lib = baseLib({
      network: "mainnet",
      signedAccountId: ACCOUNT,
      signNEP413Message: vi.fn(async () => {
        // The extension changes account mid-prompt; the bridge reads the live value through
        // a ref, so mutating the lib object is what the real switch looks like from here.
        lib.signedAccountId = "someone-else.near";
        return { accountId: ACCOUNT, publicKey: SIGNING_KEY, signature: "sig" };
      }),
    });
    mocks.lib = lib;
    const { getByText } = render(
      <LoginWalletProvider>
        <NearAdapterBridge />
        <ReturnProbe sink={sink} />
      </LoginWalletProvider>,
    );
    fireEvent.click(getByText("verify"));
    await waitFor(() => expect(sink.last).toEqual({ kind: "unchecked" }));
  });
});

describe("NearAdapterBridge restore settled (D-545)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function SettledProbe() {
    const ctx = useLoginWalletContext();
    return <span data-testid="settled">{String(ctx.restoreSettled)}</span>;
  }

  function renderSettled() {
    return render(
      <LoginWalletProvider>
        <NearAdapterBridge />
        <SettledProbe />
      </LoginWalletProvider>,
    );
  }

  it("reaches the context once HOT Connect has answered, even with no live account", async () => {
    mocks.lib = baseLib({ loading: true, signedAccountId: "", network: "mainnet" });
    const { getByTestId, rerender } = renderSettled();
    await waitFor(() => expect(getByTestId("settled").textContent).toBe("false"));
    // `getConnectedWallet()` answered "no wallet selected": the state stays `idle`, so only the
    // settled flag changes — it must still reach the context.
    mocks.lib = baseLib({ loading: false, signedAccountId: "", network: "mainnet" });
    rerender(
      <LoginWalletProvider>
        <NearAdapterBridge />
        <SettledProbe />
      </LoginWalletProvider>,
    );
    await waitFor(() => expect(getByTestId("settled").textContent).toBe("true"));
  });
});
