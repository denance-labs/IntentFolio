// The withdrawal fee for USDT on Tron, the one `omft` fee that depends on the destination (D-584).
//
// The PoA bridge's own estimate (`withdrawal_estimate`) closed with its API on 2026-11-11. Every
// other `omft` fee is a flat figure (re-checked 2026-11-19 against 1Click: identical to the
// registry). This one is not: a TRC-20 transfer to an address that holds no USDT writes a fresh
// storage slot and burns about twice the energy, and the bridge charges the difference.
//
// Measured on-chain 2026-11-19 (046 §3): six third-party `ft_withdraw`s matched with what landed
// on Tron. Destination already holding USDT ⇒ 807927 / 807927 / 808161; destination empty ⇒
// 1527035 / 1527035 / 1527477. 6/6 split exactly on the balance. The figures drift with the TRX
// price by well under 0.001 USDT, so each is rounded UP to the cent: the screen may say a little
// more than is taken, never less.
//
// Why `balanceOf` and not TronGrid's account endpoint: an address that received USDT but was
// never activated answers `data: []` there, while the contract still holds its balance — and it
// is the contract's storage slot that sets the energy.
//
// Attribution: see ATTRIBUTIONS.md #27.

import bs58 from "bs58";
import { requestSignal } from "./omni-bridge";

/** USDT on Tron, as a withdrawal-registry key. */
export const TRON_USDT_TOKEN_ID = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";

/** The USDT TRC-20 contract on Tron mainnet. */
const TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const TRONGRID_CONSTANT_CALL = "https://api.trongrid.io/wallet/triggerconstantcontract";

/**
 * A read that has not answered by then is a failed read (1.53). Without it a hung TronGrid left
 * the fee loading for as long as the screen stayed open.
 */
export const TRON_READ_TIMEOUT_MS = 5_000;

/** Destination already holds USDT: measured 807927–808161. */
export const TRON_USDT_FEE_HOLDER_RAW = "810000";
/** Destination holds none: measured 1527035–1527477. Also the figure when the balance is unknown. */
export const TRON_USDT_FEE_EMPTY_RAW = "1530000";

/** The fee for a destination with this USDT balance; `null` (unread) takes the higher one. */
export function tronUsdtFeeRaw(balance: bigint | null): string {
  return balance !== null && balance > BigInt(0) ? TRON_USDT_FEE_HOLDER_RAW : TRON_USDT_FEE_EMPTY_RAW;
}

/** The 20 address bytes of a base58 Tron address, hex, left-padded to one ABI word. */
function abiAddressWord(address: string): string | null {
  try {
    const bytes = bs58.decode(address);
    if (bytes.length !== 25 || bytes[0] !== 0x41) return null;
    return Array.from(bytes.slice(1, 21), (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .padStart(64, "0");
  } catch {
    return null;
  }
}

/**
 * The destination's USDT balance, read from the contract. `null` for anything that is not a
 * clean answer — a failed read must never pass for an empty address, nor for a funded one.
 */
export async function readTronUsdtBalance(
  address: string,
  deps: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<bigint | null> {
  const word = abiAddressWord(address);
  if (!word) return null;
  const { signal, done } = requestSignal(deps.signal, deps.timeoutMs ?? TRON_READ_TIMEOUT_MS);
  try {
    const res = await (deps.fetchImpl ?? fetch)(TRONGRID_CONSTANT_CALL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner_address: address,
        contract_address: TRON_USDT_CONTRACT,
        function_selector: "balanceOf(address)",
        parameter: word,
        visible: true,
      }),
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { result?: boolean }; constant_result?: unknown };
    const out = Array.isArray(body.constant_result) ? body.constant_result[0] : undefined;
    if (body.result?.result !== true || typeof out !== "string" || !/^[0-9a-f]{64}$/i.test(out)) return null;
    return BigInt(`0x${out}`);
  } catch {
    return null;
  } finally {
    done();
  }
}
