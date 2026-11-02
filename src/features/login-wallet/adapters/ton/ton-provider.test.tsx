// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

/**
 * The mock reproduces the ONE behaviour of the real SDK that matters here: it refuses an
 * absent `manifestUrl` by throwing during render, exactly as `TonConnectUI` does
 * (`TON_CONNECT_SDK_ERROR: You have to specify a 'manifestUrl' or a 'connector'`).
 *
 * A mock that merely recorded the prop would pass against the broken code too — the bug was
 * never "the value is wrong", it was "the value is undefined and the SDK explodes". This is
 * the assertion that crosses the seam between our provider and the vendor's constructor.
 */
const seen: Array<string | undefined> = [];

vi.mock("@tonconnect/ui-react", () => ({
  TonConnectUIProvider: ({
    manifestUrl,
    children,
  }: {
    manifestUrl?: string;
    children: React.ReactNode;
  }) => {
    seen.push(manifestUrl);
    if (manifestUrl === undefined) {
      throw new Error(
        "[TON_CONNECT_SDK_ERROR] You have to specify a `manifestUrl` or a `connector` in the options.",
      );
    }
    return <>{children}</>;
  },
}));

import { TonWalletProvider, resolveTonManifestUrl } from "./ton-provider";

const ENV_KEY = "NEXT_PUBLIC_TONCONNECT_MANIFEST_URL";

describe("resolveTonManifestUrl", () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("falls back to the manifest the app serves from its own origin", () => {
    expect(resolveTonManifestUrl("http://localhost:3100")).toBe(
      "http://localhost:3100/tonconnect-manifest.json",
    );
  });

  it("lets the env var override it, for a deploy whose manifest is hosted elsewhere", () => {
    process.env[ENV_KEY] = "https://intentfolio.app/tonconnect-manifest.json";
    expect(resolveTonManifestUrl("http://localhost:3100")).toBe(
      "https://intentfolio.app/tonconnect-manifest.json",
    );
  });

  it("treats a present-but-empty env var as unset rather than as the URL", () => {
    process.env[ENV_KEY] = "";
    expect(resolveTonManifestUrl("http://localhost:3100")).toBe(
      "http://localhost:3100/tonconnect-manifest.json",
    );
  });
});

describe("TonWalletProvider", () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    seen.length = 0;
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    cleanup();
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  // The regression itself: with the env var unset — the default in every environment,
  // production included — mounting the TON family used to throw and unmount the whole app.
  it("mounts and renders its children with no env var configured", () => {
    const { getByText } = render(
      <TonWalletProvider>
        <span>ton subtree</span>
      </TonWalletProvider>,
    );

    expect(getByText("ton subtree")).toBeTruthy();
  });

  it("hands the SDK a defined manifest url built from the live origin", () => {
    render(
      <TonWalletProvider>
        <span>ton subtree</span>
      </TonWalletProvider>,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`${window.location.origin}/tonconnect-manifest.json`);
  });
});
