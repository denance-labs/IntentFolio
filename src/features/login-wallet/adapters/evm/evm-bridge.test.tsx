// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// wagmi's account status, driven by hand: what is under test is how the bridge reads the mount
// reconnect, not wagmi's own timing.
const mocks = vi.hoisted(() => ({
  status: "disconnected" as "connected" | "connecting" | "reconnecting" | "disconnected",
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ status: mocks.status, address: undefined, connector: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn() }),
}));

vi.mock("@reown/appkit/react", () => ({
  useAppKit: () => ({ open: vi.fn() }),
}));

import { EvmAdapterBridge } from "./evm-bridge";
import { LoginWalletProvider, useLoginWalletContext } from "../../context/login-wallet-context";

function SettledProbe() {
  const ctx = useLoginWalletContext();
  return <span data-testid="settled">{String(ctx.restoreSettled)}</span>;
}

function tree() {
  return (
    <LoginWalletProvider>
      <EvmAdapterBridge />
      <SettledProbe />
    </LoginWalletProvider>
  );
}

afterEach(() => {
  cleanup();
  mocks.status = "disconnected";
});

describe("EvmAdapterBridge restore settled (D-545)", () => {
  it("settles only once the mount reconnect has run, not on wagmi's initial `disconnected`", () => {
    const { getByTestId, rerender } = render(tree());
    // `ssr: true` starts wagmi at `disconnected` before `reconnect()` has even begun.
    expect(getByTestId("settled").textContent).toBe("false");

    mocks.status = "reconnecting";
    rerender(tree());
    expect(getByTestId("settled").textContent).toBe("false");

    // Every connector answered and none was authorised: no live session is coming.
    mocks.status = "disconnected";
    rerender(tree());
    expect(getByTestId("settled").textContent).toBe("true");
  });

  it("counts a reconnect with no current connection, which wagmi reports as `connecting`", () => {
    const { getByTestId, rerender } = render(tree());
    mocks.status = "connecting";
    rerender(tree());
    expect(getByTestId("settled").textContent).toBe("false");
    mocks.status = "disconnected";
    rerender(tree());
    expect(getByTestId("settled").textContent).toBe("true");
  });
});
