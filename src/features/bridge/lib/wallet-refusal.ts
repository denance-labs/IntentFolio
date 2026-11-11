// Tells a signature the user refused in their wallet apart from every other failure, so the
// withdrawal screen can say «you cancelled» instead of the wallet library's raw text (D-433).

import { WithdrawRelayRejectedError } from "./withdraw-errors";

// How each family words a refusal:
//   EVM (viem / EIP-1193)  code 4001, `UserRejectedRequestError`, "User rejected the request."
//   Solana (Phantom…)      code 4001, "User rejected the request."
//   TON Connect            `UserRejectsError` — but the SDK never sets `name` and a minified build
//                          mangles the class, so only "User rejects the action in the wallet." survives
//   TronLink               often rejects with a bare string: "Confirmation declined by user"
//   Varial (ex-Freighter)  "User declined access"
const REFUSAL_TEXT =
  /user (rejected|rejects|declined|denied|cancel)|declined by (the )?user|rejected by (the )?user/i;

/**
 * The user said no in their wallet. Reads the cause chain, and bare strings, for any family's
 * wording. Narrow on purpose: a refusal by the RELAY is never the user's, even when the reason it
 * quotes happens to contain one of these words — it keeps its detail for support.
 */
export function isWalletRefusal(e: unknown): boolean {
  for (let cur = e, depth = 0; cur && depth < 5; depth += 1) {
    if (typeof cur === "string") return REFUSAL_TEXT.test(cur);
    if (cur instanceof WithdrawRelayRejectedError) return false;
    const err = cur as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (err.code === 4001) return true;
    if (typeof err.name === "string" && /UserRejected|UserRejects/.test(err.name)) return true;
    if (typeof err.message === "string" && REFUSAL_TEXT.test(err.message)) return true;
    cur = err.cause;
  }
  return false;
}
