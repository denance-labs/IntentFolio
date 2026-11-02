// The account recorder's gate that needs no database: which ids it will ever read. Everything
// that touches SQL is proven in account-recorder-db.integration.test.ts.

import { describe, expect, it } from "vitest";
import { isFollowableAccountId } from "./account-recorder";

describe("isFollowableAccountId — the ids intents.near knows, checked before FastNEAR or the database", () => {
  it("NEAR named, 64 hex, 0x + 40 hex", () => {
    for (const id of [
      "pablofork.near",
      "intentfolio-vault.near",
      "a_b-c.d.near",
      "aa",
      "aa2a80ecd2b9857d07dae2ca23a60d3f72cf8b6432e207c55827e118ca84dceb",
      "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36",
    ]) {
      expect(isFollowableAccountId(id), id).toBe(true);
    }
  });

  it("nothing else: case, length, separators, injection", () => {
    for (const id of [
      "",
      "a",
      // Uppercase: neither an EVM id intents.near uses (it lowercases) nor a NEAR name.
      "0xC8B1E10D011ACEED84F4CDBA66CA175BD6552A36",
      "Pablofork.near",
      "a..b",
      ".near",
      "near.",
      "a--b.near",
      `${"a".repeat(65)}`,
      "Robert'); DROP TABLE account_tx;--",
      "a b.near",
    ]) {
      expect(isFollowableAccountId(id), id).toBe(false);
    }
  });
});
