// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// B1 (016 block 2.4): "Confirm my portfolio" continues a deposit made FOR the New Portfolio
// Draft. The plain "Deposit" does not offer it — the draft's ready card and strip cover that
// case, from the balance. The panel itself is stubbed: what is under test is what the modal
// hands it.

vi.mock("@/features/login-wallet", () => ({
  useLoginWallet: () => ({
    intentsAccountId: "near:alice.near",
    connection: { chainKind: "near", address: "alice.near" },
    liveConnection: { chainKind: "near", address: "alice.near" },
  }),
}));
vi.mock("@/features/vault/context/real-allocate-context", () => ({ useSendTransactionAs: () => vi.fn() }));
// The step-1 wallet list (D-445) stays off: it is covered in wallet-deposit.test.tsx.
vi.mock("../lib/wallet-deposit-flag", () => ({ WALLET_DEPOSIT_ENABLED: false, isWalletDepositRoute: () => true }));
vi.mock("../lib/bridge-client", () => ({ getDepositAddress: vi.fn(() => new Promise(() => {})) }));
vi.mock("./wallet-deposit-panel", () => ({
  WalletDepositPanel: ({ onContinue }: { onContinue?: (credit: unknown) => void }) => (
    <div>
      wallet-panel
      {onContinue && (
        <button type="button" onClick={() => onContinue({ tokenId: "near", amount: BigInt(1), txHash: null })}>
          continue
        </button>
      )}
    </div>
  ),
}));

import { ReceiveModal } from "./receive-modal";

/** The asset row whose leading label is exactly `label`. */
function row(label: string): HTMLButtonElement {
  for (const li of screen.getAllByRole("listitem")) {
    if (li.querySelector("p")?.textContent === label) return li.querySelector("button") as HTMLButtonElement;
  }
  throw new Error(`no row labelled "${label}"`);
}

function openNearWalletTab(draftContext?: { name: string; tokenIds: string[] }) {
  const onConfirmDraft = vi.fn();
  render(
    <ReceiveModal
      open={true}
      lang="en"
      onClose={vi.fn()}
      onWalletDepositCredited={vi.fn()}
      onConfirmDraft={onConfirmDraft}
      draftContext={draftContext}
    />
  );
  // NEAR is single-network: step 2 shows it preselected (D-488), then step 3, wallet tab first.
  fireEvent.click(row("NEAR"));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByText("wallet-panel")).toBeTruthy();
  return { onConfirmDraft };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ minDeposit: {}, familyValidation: {} }) }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ReceiveModal — B1 only for the draft's own deposit", () => {
  it("opened for the draft: the panel can continue into its confirmation", () => {
    const { onConfirmDraft } = openNearWalletTab({ name: "My mix", tokenIds: ["near"] });
    fireEvent.click(screen.getByRole("button", { name: "continue" }));
    expect(onConfirmDraft).toHaveBeenCalledWith({ tokenId: "near", amount: BigInt(1), txHash: null });
  });

  it("the plain Deposit: no continuation", () => {
    openNearWalletTab();
    expect(screen.queryByRole("button", { name: "continue" })).toBeNull();
  });
});
