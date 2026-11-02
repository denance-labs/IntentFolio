// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ReturnView } from "../lib/vault-read-client";

// D-302 h2, the wiring: the configured-vault gate, and the real reads handed to `findScheduledReturns`.

// Before any import: `vault-flag.ts` reads it at module evaluation.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VAULT_ROUNDTRIP = "true";
});

const deps = vi.hoisted(() => ({
  vaultId: "intentfolio-vault.near",
  getConfig: vi.fn(),
  getReturn: vi.fn(),
}));

vi.mock("@/features/wallet/config/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/wallet/config/network")>()),
  get VAULT_CONTRACT_ID() {
    return deps.vaultId;
  },
}));
vi.mock("../lib/vault-read-client", () => ({
  getConfig: deps.getConfig,
  getReturn: deps.getReturn,
}));

import { useScheduledReturns } from "./use-scheduled-returns";

const ME = "alice.near";

const MINE: ReturnView = {
  id: 0,
  token: "near",
  amount: "1000000000000000000000000",
  to: ME,
  reason: "credit_to_deleted_portfolio",
  eta: 1_000,
  executing: false,
};

function setup(accountId: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useScheduledReturns(accountId), { wrapper });
}

afterEach(() => {
  cleanup();
  deps.vaultId = "intentfolio-vault.near";
  deps.getConfig.mockReset();
  deps.getReturn.mockReset();
});

describe("useScheduledReturns", () => {
  it("reads the counter and every Return below it, keeps this account's", async () => {
    deps.getConfig.mockResolvedValue({ return_counter: 2 });
    deps.getReturn.mockImplementation(async (id: number) =>
      id === 0 ? MINE : { ...MINE, id, to: "bob.near" }
    );
    const { result } = setup(ME);
    await waitFor(() => expect(result.current.returns).toEqual([MINE]));
    expect(deps.getReturn).toHaveBeenCalledTimes(2);
  });

  it("no vault configured (local and mock builds): no reads, nothing to show", async () => {
    deps.vaultId = "";
    const { result } = setup(ME);
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.returns).toBeUndefined();
    expect(deps.getConfig).not.toHaveBeenCalled();
    expect(deps.getReturn).not.toHaveBeenCalled();
  });

  it("no account: no reads", async () => {
    const { result } = setup(null);
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.returns).toBeUndefined();
    expect(deps.getConfig).not.toHaveBeenCalled();
  });
});
