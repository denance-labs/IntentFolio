// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, act, cleanup } from "@testing-library/react";

import { TronAdapterBridge } from "./tron-bridge";
import { LoginWalletProvider } from "../../context/login-wallet-context";
import { useLoginWallet } from "../../hooks/use-login-wallet";
import { TRONLINK_RDNS, type ProviderTronWeb, type TronProvider } from "./tron-discovery";

const W1 = "TXjxDCLkHMcxErA2Wf7t3vB9F5C4bY3q7q";
const W2 = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";

// Discovery is asynchronous, so every assertion here has to outlast it.
const SETTLE = { timeout: 3000 };

type Listeners = Record<string, Array<(...args: unknown[]) => void>>;

/**
 * A fake TronLink that announces over TIP-6963 and carries its OWN tronWeb — which is the
 * whole point of the migration: the address and the signer come off the provider, never off
 * a global another extension can claim.
 */
function installTronLink(opts: { address?: string | null; chainId?: string } = {}) {
  const listeners: Listeners = {};
  const signMessageV2 = vi.fn().mockResolvedValue("0xsig");

  const makeTronWeb = (address: string | null): ProviderTronWeb | false =>
    address === null
      ? false
      : { ready: true, defaultAddress: { base58: address, hex: "41..." }, trx: { signMessageV2 } };

  const provider: TronProvider & { tronWeb: ProviderTronWeb | false } = {
    isTronLink: true,
    tronWeb: makeTronWeb(opts.address ?? null),
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return opts.chainId ?? "0x2b6653dc";
      if (method === "eth_requestAccounts") return [];
      return null;
    }),
    on: (event, listener) => {
      (listeners[event] ??= []).push(listener);
    },
    removeListener: (event, listener) => {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
    },
  };

  const onRequest = () => {
    window.dispatchEvent(
      new CustomEvent("TIP6963:announceProvider", {
        detail: {
          info: { uuid: "uuid-tronlink", name: "TronLink", icon: "", rdns: TRONLINK_RDNS },
          provider,
        },
      }),
    );
  };
  window.addEventListener("TIP6963:requestProvider", onRequest);

  return {
    provider,
    signMessageV2,
    /** Mimics the extension: swap the active account, then emit, as a real wallet does. */
    setAccount(address: string | null) {
      provider.tronWeb = makeTronWeb(address);
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners[event] ?? []) l(...args);
    },
    hasListeners: (event: string) => (listeners[event] ?? []).length > 0,
    cleanup: () => window.removeEventListener("TIP6963:requestProvider", onRequest),
  };
}

let wallet: ReturnType<typeof installTronLink> | null = null;
afterEach(() => {
  // Explicit, because this project runs vitest without `globals: true` and without a setup
  // file — so testing-library's automatic cleanup never registers and every previous render
  // stays in `document.body`. Without this, a DOM query sees the PREVIOUS test's banner.
  cleanup();
  wallet?.cleanup();
  wallet = null;
  delete (window as { tron?: unknown }).tron;
  delete (window as { tronLink?: unknown }).tronLink;
  delete (window as { tronWeb?: unknown }).tronWeb;
});

// Surfaces what the rest of the app actually reads, so these tests assert on the seam the
// D-218 guard consumes rather than on the bridge's private state.
let seen: { live: string | null; status: string } = { live: null, status: "" };
const captured: { connect: (() => Promise<void>) | null; sign: ((m: string) => Promise<unknown>) | null } = {
  connect: null,
  sign: null,
};

function Probe() {
  const { liveConnection, status, connect, signMessage } = useLoginWallet();
  seen = { live: liveConnection?.address ?? null, status };
  captured.connect = connect;
  captured.sign = signMessage;
  return null;
}

function renderBridge() {
  return render(
    <LoginWalletProvider>
      <TronAdapterBridge />
      <Probe />
    </LoginWalletProvider>,
  );
}

beforeEach(() => {
  seen = { live: null, status: "" };
  captured.connect = null;
  captured.sign = null;
});

describe("TronAdapterBridge provider discovery (D-219)", () => {
  it("connects through the announced provider, not through a global", async () => {
    wallet = installTronLink();
    renderBridge();
    await waitFor(() => expect(captured.connect).not.toBeNull(), SETTLE);

    // The wallet only exposes an account once the prompt is answered, as a real one does.
    (wallet.provider.request as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") {
          wallet!.setAccount(W1);
          return [];
        }
        return "0x2b6653dc";
      },
    );

    await act(async () => {
      await captured.connect!();
    });

    expect(wallet.provider.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    await waitFor(() => expect(seen.live).toBe(W1), SETTLE);
  });

  it("reports a helpful error when no Tron wallet announced at all", async () => {
    renderBridge();
    await waitFor(() => expect(captured.connect).not.toBeNull(), SETTLE);

    await expect(
      act(async () => {
        await captured.connect!();
      }),
    ).rejects.toThrow(/No Tron wallet found/);
  });

  it("restores silently from a provider that already trusts this origin (D-131)", async () => {
    wallet = installTronLink({ address: W1 });
    renderBridge();
    await waitFor(() => expect(seen.live).toBe(W1), SETTLE);
  });
});

describe("TronAdapterBridge account tracking (D-218 on Tron)", () => {
  async function connected() {
    wallet = installTronLink({ address: W1 });
    renderBridge();
    await waitFor(() => expect(seen.live).toBe(W1), SETTLE);
    return wallet;
  }

  it("subscribes through provider.on, not through window message broadcasts", async () => {
    const w = await connected();
    expect(w.hasListeners("accountsChanged")).toBe(true);
    expect(w.hasListeners("disconnect")).toBe(true);
  });

  it("follows an account switch inside the extension so liveConnection stops being stale", async () => {
    const w = await connected();
    act(() => {
      w.setAccount(W2);
      w.emit("accountsChanged", [W2]);
    });
    await waitFor(() => expect(seen.live).toBe(W2), SETTLE);
  });

  it("clears the live connection on a disconnect event", async () => {
    const w = await connected();
    act(() => {
      w.setAccount(null);
      w.emit("disconnect");
    });
    await waitFor(() => expect(seen.live).toBeNull(), SETTLE);
  });

  it("does not adopt an address from an event when no session is connected", async () => {
    // An event must never be able to create a login, only update one.
    wallet = installTronLink();
    renderBridge();
    await waitFor(() => expect(captured.connect).not.toBeNull(), SETTLE);

    act(() => {
      wallet!.setAccount(W1);
      wallet!.emit("accountsChanged", [W1]);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.live).toBeNull();
  });
});

describe("TronAdapterBridge signing", () => {
  it("signs with the PROVIDER's tronWeb, never with window.tronWeb", async () => {
    // The hijack broke signing too, not just login: a stolen `window.tronWeb` means the
    // message goes to another extension's signer.
    const hijackedSign = vi.fn().mockResolvedValue("0xattacker");
    (window as { tronWeb?: unknown }).tronWeb = {
      ready: true,
      defaultAddress: { base58: W2, hex: "41" },
      trx: { signMessageV2: hijackedSign },
    };

    wallet = installTronLink({ address: W1 });
    renderBridge();
    await waitFor(() => expect(seen.live).toBe(W1), SETTLE);

    await act(async () => {
      await captured.sign!("hello");
    });

    expect(wallet.signMessageV2).toHaveBeenCalledWith("hello");
    expect(hijackedSign).not.toHaveBeenCalled();
  });

  it("a refused signature rejects to the caller and keeps the session connected (D-433)", async () => {
    wallet = installTronLink({ address: W1 });
    wallet.signMessageV2.mockRejectedValue(new Error("Confirmation declined by user"));
    renderBridge();
    await waitFor(() => expect(seen.status).toBe("connected"), SETTLE);

    await act(async () => {
      await expect(captured.sign!("hello")).rejects.toThrow("Confirmation declined by user");
    });

    expect(seen.status).toBe("connected");
    expect(seen.live).toBe(W1);
  });
});

describe("TronAdapterBridge network warning (D-219)", () => {
  it("warns when the extension is on a testnet", async () => {
    wallet = installTronLink({ chainId: "0x94a9059e" });
    const { findByRole } = renderBridge();
    await waitFor(() => expect(captured.connect).not.toBeNull(), SETTLE);

    (wallet.provider.request as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") {
          wallet!.setAccount(W1);
          return [];
        }
        return "0x94a9059e";
      },
    );
    await act(async () => {
      await captured.connect!();
    });

    expect((await findByRole("status")).textContent).toContain("Shasta");
  });

  it("stays quiet on mainnet", async () => {
    wallet = installTronLink({ address: W1, chainId: "0x2b6653dc" });
    const { queryByRole } = renderBridge();
    await waitFor(() => expect(seen.live).toBe(W1), SETTLE);
    expect(queryByRole("status")).toBeNull();
  });
});
