// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";

// `sendTransactionAs` exists for ONE reason: the hook's `signAndSendTransaction` drops `signerId`
// (near-connect-hooks `useNearWallet.js:110-114`). Everything downstream mocks this context, so
// only this file can notice if it starts dropping it too.

const wallet = vi.hoisted(() => ({
  signAndSendTransaction: vi.fn(async (params: unknown) => ({ echoed: params })),
  connect: vi.fn(),
}));
const hookSend = vi.hoisted(() => vi.fn());

vi.mock("near-connect-hooks", () => ({
  useNearWallet: () => ({
    signNEP413Message: vi.fn(),
    signAndSendTransaction: hookSend,
    connector: { wallet: wallet.connect },
  }),
}));

import {
  RealAllocateDisabled,
  RealAllocateProvider,
  useSendTransactionAs,
  type SendTransactionAs,
} from "./real-allocate-context";

function capture(tree: (probe: ReactElement) => ReactElement): SendTransactionAs | null {
  let got: SendTransactionAs | null = null;
  function Probe() {
    got = useSendTransactionAs();
    return null;
  }
  render(tree(<Probe />));
  return got;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const PARAMS = {
  signerId: "pablofork.near",
  receiverId: "wrap.near",
  actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer_call", args: {}, gas: "1", deposit: "1" } }],
};

describe("useSendTransactionAs", () => {
  it("reaches near-connect's wallet with signerId intact — not the hook, which drops it", async () => {
    wallet.connect.mockResolvedValue({ signAndSendTransaction: wallet.signAndSendTransaction });
    const send = capture((probe) => <RealAllocateProvider>{probe}</RealAllocateProvider>);
    await send!(PARAMS);
    expect(wallet.signAndSendTransaction).toHaveBeenCalledWith(PARAMS);
    expect(hookSend).not.toHaveBeenCalled();
  });

  it("no connected wallet throws WalletNotConnectedError, before anything is sent", async () => {
    wallet.connect.mockRejectedValue(new Error("No accounts found"));
    const send = capture((probe) => <RealAllocateProvider>{probe}</RealAllocateProvider>);
    await expect(send!(PARAMS)).rejects.toMatchObject({ name: "WalletNotConnectedError", message: "No accounts found" });
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("is null below RealAllocateDisabled (/mock-dashboard), even inside a provider", () => {
    const send = capture((probe) => (
      <RealAllocateProvider>
        <RealAllocateDisabled>{probe}</RealAllocateDisabled>
      </RealAllocateProvider>
    ));
    expect(send).toBeNull();
  });

  it("is null with no provider at all", () => {
    expect(capture((probe) => probe)).toBeNull();
  });
});
