// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createContext, useContext, useMemo, type ReactNode } from "react";

// D-497 regression guard: the NEAR family module must not mount its own HOT Connect
// provider. Each `NearProvider` builds a connector in its `useMemo`; a second one inside the
// lazy mount's Suspense was rebuilt on every retry (~200 connectors per signed-in load).
const mounts = vi.hoisted(() => ({ count: 0 }));

vi.mock("near-connect-hooks", () => {
  const Ctx = createContext<{ connector: object } | null>(null);
  return {
    NearProvider: ({ children }: { children: ReactNode }) => {
      const value = useMemo(() => {
        mounts.count += 1;
        return { connector: {} };
      }, []);
      return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
    },
    useNearWallet: () => useContext(Ctx),
  };
});

vi.mock("./near-bridge", () => ({ NearAdapterBridge: () => null }));

import { useNearWallet } from "near-connect-hooks";
import { NearWalletProvider } from "@/features/wallet/adapter/near-wallet-provider";
import { FamilyProvider } from "./index";

describe("NEAR FamilyProvider (D-497)", () => {
  it("reuses the root provider's connector instead of building a second one", () => {
    let root: unknown;
    let family: unknown;
    function RootProbe() {
      root = useNearWallet().connector;
      return null;
    }
    function FamilyProbe() {
      family = useNearWallet().connector;
      return null;
    }

    render(
      <NearWalletProvider>
        <RootProbe />
        <FamilyProvider>
          <FamilyProbe />
        </FamilyProvider>
      </NearWalletProvider>,
    );

    expect(mounts.count).toBe(1);
    expect(family).toBe(root);
  });
});
