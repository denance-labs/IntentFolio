// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// solana-wallet-adapter's state, driven by hand: what is under test is how the bridge reads the
// mount auto-connect, not the adapter's own timing.
const mocks = vi.hoisted(() => ({
  wallet: null as { adapter: { name: string } } | null,
  connecting: false,
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    wallet: mocks.wallet,
    connected: false,
    connecting: mocks.connecting,
    publicKey: null,
    disconnect: vi.fn(),
    signMessage: vi.fn(),
  }),
}));

vi.mock("@solana/wallet-adapter-react-ui", () => ({
  useWalletModal: () => ({ setVisible: vi.fn() }),
}));

import { SolanaAdapterBridge } from "./solana-bridge";
import { LoginWalletProvider, useLoginWalletContext } from "../../context/login-wallet-context";

function SettledProbe() {
  const ctx = useLoginWalletContext();
  return <span data-testid="settled">{String(ctx.restoreSettled)}</span>;
}

function tree() {
  return (
    <LoginWalletProvider>
      <SolanaAdapterBridge />
      <SettledProbe />
    </LoginWalletProvider>
  );
}

afterEach(() => {
  cleanup();
  mocks.wallet = null;
  mocks.connecting = false;
});

describe("SolanaAdapterBridge restore settled (D-545)", () => {
  it("is settled from the start when no wallet is saved: nothing will auto-connect", () => {
    const { getByTestId } = render(tree());
    expect(getByTestId("settled").textContent).toBe("true");
  });

  it("settles a saved wallet only after its auto-connect pass", () => {
    mocks.wallet = { adapter: { name: "Backpack" } };
    const { getByTestId, rerender } = render(tree());
    // The auto-connect effect has not started yet.
    expect(getByTestId("settled").textContent).toBe("false");

    mocks.connecting = true;
    rerender(tree());
    expect(getByTestId("settled").textContent).toBe("false");

    // The wallet answered without a session.
    mocks.connecting = false;
    rerender(tree());
    expect(getByTestId("settled").textContent).toBe("true");
  });
});
