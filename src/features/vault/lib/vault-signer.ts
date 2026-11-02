// WHO signs a vault envelope, and in which scheme (008.plan, Phase 0b).
//
// The money paths already separated "sign" from "send" (envelope-submitter.ts). This is the
// other half of that split: they now also separate "sign" from "which signature scheme",
// which is what lets a non-NEAR login drive the same round-trip.
//
// NEP-413 and the rest are NOT interchangeable serialisations of one string — see the
// ERC-191 section of vault-envelope.ts. Each signer therefore takes BOTH forms of the
// envelope and picks the one its wallet can produce, then assembles the canonical
// MultiPayload through the SDK. Assembly stays inside the signer so no caller can pair a
// signature with the wrong payload.
//
// ── Why there are 6 signers but only 2 envelope forms (block 4.1) ─────────────
// Measured against contract-types, NONE of the five non-NEAR MultiPayloads
// (erc191, tip191, raw_ed25519, sep53, ton_connect) carries `nonce` / `verifying_contract`
// as sibling fields — only MultiPayloadNep413 does. So all five need those fields INSIDE
// the signed string, which is exactly the flattened DefusePayload that
// `buildErc191Payload` already emits. ⇒ the five families sign the SAME string; what
// differs is only how the signature is wrapped for the wire. `VaultSignRequest.erc191Message`
// is therefore misnamed (it is "the flattened form every non-NEAR family signs"), which is
// registered as naming debt (D-203) rather than renamed here.
//
// What DOES differ per family, and is where the money-critical mistakes live:
//   1. Signature encoding at the door: Solana hands us base58, Stellar and TON base64,
//      Tron hex. The SDK wants raw bytes for the ed25519 pair and passes the others through.
//   2. `userAddress` is NOT the intents account id for every family. The SDK derives the
//      on-chain `public_key` from it (`ed25519:${userAddress}` for Solana,
//      `stellarAddressToBytes` for Stellar, `hex.decode` for TON), so these signers take
//      the RAW WALLET ADDRESS separately from `signerId`. Passing the intents account id —
//      which is hex for Solana and Stellar — would ship a public key that is not the
//      signer's, and the contract would reject a signature the user already approved.
//   3. TON is the only family whose signed string reaches the wire FROM THE WALLET
//      (`payload.text`), so it is the only one that must be checked against what we asked
//      to be signed.
//
// Injected, never imported from a hook — same rule as NearSigner, so the whole money path
// stays unit-testable without a wallet or a network.

// Attribution: see ATTRIBUTIONS.md #8 (canonical MultiPayload assembly per family).
import bs58 from "bs58";
import { prepareBroadcastRequest } from "@defuse-protocol/internal-utils";
import type { Signature } from "@/features/intents-account/mock-contract/types";
import type { Nep413SignRequest } from "./vault-envelope";

/** The canonical wire form: what goes to `execute_intents` / `commit_portfolio_changes`. */
export type MultiPayload = ReturnType<typeof prepareBroadcastRequest.prepareSwapSignedData>;

/** Both serialisations of ONE envelope, produced together by the builders. */
export type VaultSignRequest = {
  nep413: Nep413SignRequest;
  erc191Message: string;
};

export type SignedMessageResult = {
  accountId: string;
  publicKey: string;
  signature: string;
};

/** The subset of a NEAR wallet the NEP-413 path needs. */
export type NearSigner = {
  signNEP413Message: (params: {
    message: string;
    recipient: string;
    nonce: Uint8Array;
  }) => Promise<SignedMessageResult>;
  signAndSendTransaction: (params: {
    receiverId: string;
    actions: unknown[];
  }) => Promise<unknown>;
};

/**
 * Signs an envelope and returns the submit-ready MultiPayload.
 *
 * One method, deliberately: everything that differs between families (which string is
 * signed, which SDK branch assembles it, what `userChainType` means) is settled inside the
 * implementation, so `submitAllocate`/`submitUnallocate` contain no per-family branching.
 */
export type VaultSigner = {
  /** For logs and error messages only — never a substitute for checking the signature. */
  readonly scheme: Signature["scheme"];
  signEnvelope: (req: VaultSignRequest) => Promise<MultiPayload>;
};

/** The shared entry point every non-NEAR adapter exposes. */
export type SignMessage = (message: string, expectedAccountId?: string) => Promise<Signature>;

/**
 * Narrows an adapter signature to the scheme this signer is allowed to ship.
 *
 * `signMessage` is one entry point for all six families, so nothing but this check stops a
 * mis-wired adapter from handing us an ed25519 signature that we would label `tip191` and
 * send to the Verifier. Type-level narrowing is the point: every caller below reads
 * scheme-specific fields off the result.
 */
function expectScheme<S extends Signature["scheme"]>(
  sig: Signature,
  scheme: S
): Extract<Signature, { scheme: S }> {
  if (sig.scheme !== scheme) {
    throw new Error(
      `Expected a "${scheme}" signature for this login family, got "${sig.scheme}"`
    );
  }
  return sig as Extract<Signature, { scheme: S }>;
}

/** base64 -> bytes, without pulling in a dependency for four lines. */
function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * NEAR family. `signerId` is both the signing account and the intents account id.
 */
export function nep413VaultSigner(wallet: NearSigner, signerId: string): VaultSigner {
  return {
    scheme: "nep413",
    async signEnvelope(req) {
      const signed = await wallet.signNEP413Message({
        message: req.nep413.message,
        recipient: req.nep413.recipient,
        nonce: req.nep413.nonce,
      });
      return prepareBroadcastRequest.prepareSwapSignedData(
        {
          type: "NEP413",
          signatureData: signed,
          signedData: {
            message: req.nep413.message,
            recipient: req.nep413.recipient,
            nonce: req.nep413.nonce,
          },
        },
        { userAddress: signerId, userChainType: "near" }
      );
    },
  };
}

/**
 * EVM family, via the login wallet's generic `signMessage` (personal_sign under the hood).
 *
 * `signerId` is the derived INTENTS account id (lowercase `0x…`), not the checksummed
 * address the wallet reports. It only labels the payload here — the contract recovers the
 * real signer from the signature — but passing the checksummed form would make the logs
 * disagree with what the contract computes, which is exactly the confusion
 * `walletMatchesAccount` exists to prevent upstream.
 *
 * The scheme is asserted rather than assumed: `signMessage` is the shared entry point for
 * all six families, so a mis-wired adapter would otherwise hand us an ed25519 signature
 * that we would happily label `erc191` and ship to the Verifier.
 */
export function erc191VaultSigner(signMessage: SignMessage, signerId: string): VaultSigner {
  return {
    scheme: "erc191",
    async signEnvelope(req) {
      const sig = expectScheme(await signMessage(req.erc191Message, signerId), "erc191");
      return prepareBroadcastRequest.prepareSwapSignedData(
        {
          type: "ERC191",
          signatureData: sig.signature,
          // MUST be the exact string that was signed: the SDK passes it through verbatim
          // as the payload, and the contract recovers the pubkey from (payload, signature).
          signedData: { message: req.erc191Message },
        },
        { userAddress: signerId, userChainType: "evm" }
      );
    },
  };
}

/**
 * Tron family. TIP-191 is Tron's ERC-191: the SDK's `TRON` branch produces the same
 * `{standard, payload, signature}` shape and reuses `transformERC191Signature` verbatim,
 * so the ONLY difference from the EVM signer above is the `standard` on the wire.
 *
 * `userAddress` is unused by the SDK for this branch (the public key is recovered from the
 * signature, like EVM), so passing the intents account id here is correct rather than
 * incidental — it keeps the logs agreeing with what the contract computes.
 */
export function tip191VaultSigner(signMessage: SignMessage, signerId: string): VaultSigner {
  return {
    scheme: "tip191",
    async signEnvelope(req) {
      const sig = expectScheme(await signMessage(req.erc191Message, signerId), "tip191");
      return prepareBroadcastRequest.prepareSwapSignedData(
        {
          type: "TRON",
          signatureData: sig.signature,
          signedData: { message: req.erc191Message },
        },
        { userAddress: signerId, userChainType: "tron" }
      );
    },
  };
}

/**
 * Solana and Stellar — the two ed25519 families (D-183).
 *
 * Shared because the wire form is identical (`payload` string + `public_key` + `signature`)
 * and so is the failure mode. They are NOT identical inside, and the three differences are
 * all encoding, which is why they are named here instead of hidden:
 *   - Solana signs BYTES (`signedData.message` is a Uint8Array the SDK decodes back to the
 *     string) and returns base58; Stellar signs the string and returns base64.
 *   - `walletAddress` is the base58 public key for Solana and the G… address for Stellar;
 *     the SDK turns each into the on-chain `public_key` by a different route.
 *
 * `walletAddress` is separate from `signerId` on purpose: for BOTH families the intents
 * account id is a hex encoding of the key, and feeding that back to the SDK would derive a
 * public key that is not the signer's.
 */
export function ed25519VaultSigner(params: {
  signMessage: SignMessage;
  family: "solana" | "stellar";
  /** Intents account id — what the envelope's `signer_id` says and what the guard checks. */
  signerId: string;
  /** Raw wallet address: base58 public key (Solana) or G… address (Stellar). */
  walletAddress: string;
}): VaultSigner {
  const { signMessage, family, signerId, walletAddress } = params;
  return {
    scheme: family === "solana" ? "raw_ed25519" : "sep53",
    async signEnvelope(req) {
      if (family === "solana") {
        const sig = expectScheme(await signMessage(req.erc191Message, signerId), "raw_ed25519");
        return prepareBroadcastRequest.prepareSwapSignedData(
          {
            type: "SOLANA",
            signatureData: bs58.decode(sig.signature),
            signedData: { message: new TextEncoder().encode(req.erc191Message) },
          },
          { userAddress: walletAddress, userChainType: "solana" }
        );
      }
      const sig = expectScheme(await signMessage(req.erc191Message, signerId), "sep53");
      return prepareBroadcastRequest.prepareSwapSignedData(
        {
          type: "STELLAR_SEP53",
          signatureData: bytesFromBase64(sig.signature),
          signedData: { message: req.erc191Message },
        },
        { userAddress: walletAddress, userChainType: "stellar" }
      );
    },
  };
}

/**
 * TON family — the only envelope whose wire payload comes back FROM the wallet.
 *
 * TonConnect's `signData` returns the address, domain and timestamp it actually signed
 * over, and the contract re-derives the signed hash from all four fields; so unlike every
 * other family we cannot substitute our own copy of the string. That is also why the text
 * is checked: if a wallet returned anything but what we asked to be signed, shipping it
 * would authorise a payload the user never saw.
 *
 * `walletPublicKeyHex` is the hex-encoded ed25519 public key (what the TON adapter reports
 * as its address, and what `authHandleToIntentsUserId` derives the account from) — NOT the
 * EQ/UQ user-facing address, which the SDK cannot hex-decode.
 */
export function tonConnectVaultSigner(
  signMessage: SignMessage,
  signerId: string,
  walletPublicKeyHex: string
): VaultSigner {
  return {
    scheme: "ton_connect",
    async signEnvelope(req) {
      const sig = expectScheme(await signMessage(req.erc191Message, signerId), "ton_connect");
      if (sig.text !== req.erc191Message) {
        throw new Error(
          "TON wallet signed a different text than the envelope; refusing to submit it"
        );
      }
      return prepareBroadcastRequest.prepareSwapSignedData(
        {
          type: "TON_CONNECT",
          signatureData: {
            signature: sig.signature,
            address: sig.address,
            // The adapter stringifies it (Signature is a wire-ish union); the SDK and the
            // contract both want the numeric UNIX seconds back.
            timestamp: Number(sig.timestamp),
            domain: sig.domain,
            payload: { type: "text", text: sig.text },
          },
          signedData: { message: { type: "text", text: sig.text } },
        },
        { userAddress: walletPublicKeyHex, userChainType: "ton" }
      );
    },
  };
}
