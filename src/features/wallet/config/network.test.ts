import { afterEach, describe, expect, it, vi } from "vitest";

async function vaultIdWith(value: string | undefined): Promise<string> {
  vi.resetModules();
  if (value === undefined) vi.stubEnv("NEXT_PUBLIC_VAULT_CONTRACT_ID", undefined as unknown as string);
  else vi.stubEnv("NEXT_PUBLIC_VAULT_CONTRACT_ID", value);
  return (await import("./network")).VAULT_CONTRACT_ID;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// 2026-09-30: intentfolio-staging.near is being deleted. Anything sent to it after that is lost.
describe("VAULT_CONTRACT_ID", () => {
  it("has no default: an unset variable means no vault, not staging", async () => {
    expect(await vaultIdWith(undefined)).toBe("");
  });

  it("never resolves to a retired vault, even when the env still names it", async () => {
    expect(await vaultIdWith("intentfolio-staging.near")).toBe("");
    expect(await vaultIdWith(" intentfolio-staging.near ")).toBe("");
  });

  it("uses the configured vault otherwise", async () => {
    expect(await vaultIdWith("intentfolio-vault.near")).toBe("intentfolio-vault.near");
  });
});
