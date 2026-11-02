"use client";

// The vault would refuse this gesture (017-9b, D-302 a): shown instead of a signature request,
// in the same amber as the relay pause — nothing failed and nothing moved. Copy comes from the
// modal's own translations; `{token}` is replaced with the frozen token's symbol.

import { symbolForTokenId } from "@/features/market/lib/token-registry";
import type { PrecheckBlock } from "../lib/vault-precheck";
import { RelayPausedNotice } from "./relay-paused-notice";

export type VaultPrecheckCopy = {
  precheckUnavailableTitle: string;
  precheckUnavailableBody: string;
  precheckFrozenTitle: string;
  precheckFrozenBody: string;
};

export function VaultPrecheckNotice({ id, block, t }: { id: string; block: PrecheckBlock; t: VaultPrecheckCopy }) {
  if (block.reason === "token-frozen") {
    const title = t.precheckFrozenTitle.replace("{token}", symbolForTokenId(block.tokenId));
    return <RelayPausedNotice id={id} title={title} body={t.precheckFrozenBody} />;
  }
  return <RelayPausedNotice id={id} title={t.precheckUnavailableTitle} body={t.precheckUnavailableBody} />;
}
