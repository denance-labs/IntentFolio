"use client";

import { useState } from "react";
import { AlertTriangle, KeyRound, Loader2, ShieldAlert } from "lucide-react";
import { useLoginWallet } from "../hooks/use-login-wallet";
import type { NearKeyVerification } from "../lib/near-key-verification";

/**
 * Where B5 sends the wallet that cannot self-register here: a `FunctionCall` key can never
 * attach the 1-yocto deposit `add_public_key` requires (protocol-level, not this app's
 * choice — see `near-key-register.ts`). near.com runs its own verification flow that does
 * not hit this wall (ATTRIBUTIONS.md #15), so it is the fallback rather than a dead end.
 */
const NEAR_COM_URL = "https://near.com";

// D-280 — the one place the key-registration gate is visible. B2 made it detect and explain;
// B3 gives it the one button that sends a transaction. It still blocks nothing (that is B4).
//
// 🔴 The states are rendered as TWELVE distinct sentences, not three, because the whole
// finding behind D-280 is that a tester who cannot operate gets no explanation. Three pairs
// in particular must never collapse:
//   · `unknown` (we asked the chain and got no answer) vs `not-registered` (the chain said
//     no). Same banner for both would tell a user to fix their account when the real
//     problem is an RPC that is down.
//   · `unchecked` (we have no matching signed tuple) vs everything else. A restored session
//     reaches it only when its account/wallet/key proof is absent or no longer matches; a
//     matching tuple is silently re-read on-chain instead of spending another signature.
//   · `register-unconfirmed` (we stopped waiting; the transaction may be in flight) vs
//     `register-not-applied` (it succeeded and the chain still says no). The first must send
//     the user to LOOK AGAIN; a second transaction is wasted gas. The second must never
//     offer to resend at all — it would land in the same wrong account.
//
// A healthy account renders NOTHING. `registered` and `not-required` are not news, and a
// permanent green strip would train testers to ignore the strip that matters.

const copy = {
  en: {
    unchecked: {
      title: "Verify this wallet",
      body: "Sign a message to confirm this wallet controls {account}. It moves no funds and costs nothing.",
      action: "Verify",
    },
    checking: { title: "Waiting for your wallet…", body: "Approve the signature request to continue.", action: null },
    declined: {
      title: "Verification cancelled",
      body: "You can keep looking around, but this wallet has to be verified before it can operate.",
      action: "Try again",
    },
    signFailed: {
      title: "Your wallet could not sign",
      body: "Unlock it or reconnect, then try again.",
      action: "Try again",
    },
    mismatch: {
      title: "Your wallet signed with a different account",
      body: "This session is {session}, but the wallet signed as {signer}. Switch the active account in your wallet to {session} and try again.",
      action: "Try again",
    },
    notRegistered: {
      title: "{account} is not enabled yet",
      body: "This account needs a one-time transaction before it can operate. It costs only network gas.",
      action: "Enable",
    },
    unknown: {
      title: "We could not check this account",
      body: "The network did not answer, so we do not know whether {account} is enabled. This is not a problem with your account.",
      action: "Try again",
    },
    registering: {
      title: "Enabling {account}…",
      body: "Approve the transaction in your wallet. It costs only network gas.",
      action: "Cancel",
    },
    registerDeclined: {
      title: "Transaction cancelled",
      body: "{account} is still not enabled. You can send it again whenever you want.",
      action: "Try again",
    },
    registerFailed: {
      title: "The transaction could not be sent",
      body: "{account} is still not enabled. Check that your wallet is unlocked and has NEAR for gas, then try again.",
      action: "Try again",
    },
    registerFailedNoFullAccess: {
      title: "This wallet can't enable {account} here",
      body: "The connected key can't sign this one-time transaction. Register {account} at near.com instead, then come back and check again.",
      action: "Go to near.com",
    },
    registerUnconfirmed: {
      title: "We stopped waiting for your wallet",
      body: "If you approved the transaction it may still be going through. Do not send another one — check {account} again in a moment.",
      action: "Check again",
    },
    registerNotApplied: {
      title: "The transaction went through, but {account} is still not enabled",
      body: "Your wallet may have signed with a different account. Check which account is active in your wallet, then check again.",
      action: "Check again",
    },
  },
  es: {
    unchecked: {
      title: "Verifica esta wallet",
      body: "Firma un mensaje para confirmar que esta wallet controla {account}. No mueve fondos ni tiene costo.",
      action: "Verificar",
    },
    checking: { title: "Esperando tu wallet…", body: "Aprueba la firma para continuar.", action: null },
    declined: {
      title: "Verificación cancelada",
      body: "Puedes seguir mirando, pero esta wallet tiene que verificarse antes de poder operar.",
      action: "Reintentar",
    },
    signFailed: {
      title: "Tu wallet no pudo firmar",
      body: "Desbloquéala o reconecta, y reintenta.",
      action: "Reintentar",
    },
    mismatch: {
      title: "Tu wallet firmó con otra cuenta",
      body: "Esta sesión es {session}, pero la wallet firmó como {signer}. Cambia la cuenta activa en tu wallet a {session} y reintenta.",
      action: "Reintentar",
    },
    notRegistered: {
      title: "{account} todavía no está habilitada",
      body: "Esta cuenta necesita una transacción de un solo paso antes de poder operar. Cuesta sólo el gas de red.",
      action: "Habilitar",
    },
    unknown: {
      title: "No pudimos verificar esta cuenta",
      body: "La red no respondió, así que no sabemos si {account} está habilitada. No es un problema de tu cuenta.",
      action: "Reintentar",
    },
    registering: {
      title: "Habilitando {account}…",
      body: "Aprueba la transacción en tu wallet. Cuesta sólo el gas de red.",
      action: "Cancelar",
    },
    registerDeclined: {
      title: "Transacción cancelada",
      body: "{account} sigue sin estar habilitada. Puedes enviarla de nuevo cuando quieras.",
      action: "Reintentar",
    },
    registerFailed: {
      title: "No se pudo enviar la transacción",
      body: "{account} sigue sin estar habilitada. Revisa que tu wallet esté desbloqueada y tenga NEAR para el gas, y reintenta.",
      action: "Reintentar",
    },
    registerFailedNoFullAccess: {
      title: "Esta wallet no puede habilitar {account} desde aquí",
      body: "La clave conectada no puede firmar esta transacción de un solo paso. Registra {account} en near.com y después vuelve a comprobar.",
      action: "Ir a near.com",
    },
    registerUnconfirmed: {
      title: "Dejamos de esperar a tu wallet",
      body: "Si aprobaste la transacción, puede que siga en camino. No envíes otra: vuelve a comprobar {account} en un momento.",
      action: "Volver a comprobar",
    },
    registerNotApplied: {
      title: "La transacción pasó, pero {account} sigue sin estar habilitada",
      body: "Puede que tu wallet haya firmado con otra cuenta. Revisa qué cuenta está activa en tu wallet y vuelve a comprobar.",
      action: "Volver a comprobar",
    },
  },
} as const;

type Tone = "neutral" | "warning" | "danger";

const TONE_CLASSES: Record<Tone, { wrap: string; title: string; body: string; button: string }> = {
  neutral: {
    wrap: "border-slate-700 bg-slate-800/40",
    title: "text-slate-100",
    body: "text-slate-300",
    button: "border-slate-600 bg-slate-700/40 text-slate-100 hover:bg-slate-700/70 focus-visible:ring-slate-400/60",
  },
  warning: {
    wrap: "border-amber-400/30 bg-amber-400/5",
    title: "text-amber-100",
    body: "text-amber-100/80",
    button: "border-amber-300/40 bg-amber-300/10 text-amber-100 hover:bg-amber-300/20 focus-visible:ring-amber-300/60",
  },
  danger: {
    wrap: "border-red-500/30 bg-red-500/10",
    title: "text-red-200",
    body: "text-red-200/80",
    button: "border-red-400/40 bg-red-400/10 text-red-100 hover:bg-red-400/20 focus-visible:ring-red-400/60",
  },
};

/**
 * Which of the three things the button does.
 *
 * 🔴 The label alone is not enough, and conflating `register` with `verify` is the expensive
 * mistake: "Try again" after a declined transaction means SEND IT AGAIN, while "Try again"
 * after a failed check means ASK THE CHAIN AGAIN. One costs gas and the other does not, and
 * only `verify` can ever conclude `registered`.
 *
 * `near-com` (B5) is not a wallet action at all — it navigates away, so it renders as a link
 * rather than a button and never reaches `handleClick`.
 */
type ActionKind = "verify" | "register" | "cancel" | "near-com";

type Notice = {
  tone: Tone;
  icon: "key" | "shield" | "warning" | "spinner";
  title: string;
  body: string;
  action: { label: string; run: ActionKind } | null;
  /** `alert` for things the user must act on; `status` for the transient wait. */
  live: "alert" | "status";
};

/**
 * The whole rendering decision, as a pure function so the seven-way split is testable
 * without a wallet, a browser, or a chain.
 *
 * Returns null for the two states that are not news. Exported for the tests that pin each
 * branch to its own sentence — the regression this guards is two states quietly rendering
 * the same text after an edit.
 */
/** Pairs a copy label with what pressing it actually does. */
function act(label: string | null, run: ActionKind): { label: string; run: ActionKind } | null {
  return label === null ? null : { label, run };
}

export function deriveNotice(
  verification: NearKeyVerification,
  lang: "en" | "es",
): Notice | null {
  const t = copy[lang];
  switch (verification.kind) {
    case "not-required":
    case "registered":
      return null;
    case "unchecked":
      return { tone: "neutral", icon: "key", live: "status", ...t.unchecked, action: act(t.unchecked.action, "verify") };
    case "checking":
      return { tone: "neutral", icon: "spinner", live: "status", ...t.checking, action: null };
    case "declined":
      return { tone: "warning", icon: "key", live: "alert", ...t.declined, action: act(t.declined.action, "verify") };
    case "sign-failed":
      return { tone: "warning", icon: "warning", live: "alert", ...t.signFailed, action: act(t.signFailed.action, "verify") };
    case "signer-mismatch":
      // The only danger-toned one, and the only one that names two accounts. Measured in
      // mainnet on 2026-08-13: a wallet offered one account's key for another account's
      // payload with no warning, and the cross-authorisation went through. Naming both is
      // the whole message — "something is wrong" would leave the user nothing to do.
      return {
        tone: "danger",
        icon: "shield",
        live: "alert",
        title: t.mismatch.title,
        body: t.mismatch.body
          .replaceAll("{session}", verification.sessionAccountId)
          .replace("{signer}", verification.signerAccountId),
        // 🔴 `verify`, never `register`. Registering from here writes the authorisation for
        // the pair already known to be crossed — the contamination measured in mainnet.
        action: act(t.mismatch.action, "verify"),
      };
    case "not-registered":
      // The only state the registration transaction may START from, together with the two
      // retryable registration endings below. All three carry the key B2 saw sign.
      return fill(t.notRegistered, "warning", "key", verification.accountId, "register");
    case "unknown":
      // Deliberately a different TITLE and a different BODY from `not-registered`, not just
      // a different colour: the two have opposite fixes, and the sentence is the only thing
      // that tells a tester which one they are looking at. `verify` and not `register`: the
      // key may be the empty string that produced this state in the first place.
      return fill(t.unknown, "warning", "warning", verification.accountId, "verify");

    // ── B3: what a registration attempt left behind ───────────────────────────────────
    case "registering":
      // The only action while a transaction is out is to stop WAITING. A second button that
      // reopened the wallet would be a second transaction for the same key.
      return fill(t.registering, "neutral", "spinner", verification.accountId, "cancel", "status");
    case "register-declined":
      return fill(t.registerDeclined, "warning", "key", verification.accountId, "register");
    case "register-failed":
      // 🔴 B5: a `requires-full-access` cause means resending is guaranteed to fail the same
      // way again — offering `register` here would be the "Try again" wall D-280 exists to
      // remove. near.com is the escape hatch instead.
      return verification.cause === "requires-full-access"
        ? fill(t.registerFailedNoFullAccess, "warning", "warning", verification.accountId, "near-com")
        : fill(t.registerFailed, "warning", "warning", verification.accountId, "register");
    case "register-unconfirmed":
      // 🔴 `verify`, not `register`. The transaction may be landing right now; a resend here
      // is gas spent to reach the state the first one is already reaching.
      return fill(t.registerUnconfirmed, "warning", "warning", verification.accountId, "verify");
    case "register-not-applied":
      // 🔴 Danger, and 🔴 `verify`. A receipt said success and the chain disagrees, which is
      // what a wallet signing as a different account looks like from here. Re-verifying is
      // what surfaces that as `signer-mismatch`; resending would repeat it.
      return fill(t.registerNotApplied, "danger", "shield", verification.accountId, "verify");
  }
}

/** The common case: one `{account}` in either half of the copy, one action. */
function fill(
  t: { title: string; body: string; action: string | null },
  tone: Tone,
  icon: Notice["icon"],
  accountId: string,
  run: ActionKind,
  live: Notice["live"] = "alert",
): Notice {
  return {
    tone,
    icon,
    live,
    title: t.title.replace("{account}", accountId),
    body: t.body.replace("{account}", accountId),
    action: act(t.action, run),
  };
}

function NoticeIcon({ icon }: { icon: Notice["icon"] }) {
  const className = "mt-0.5 h-4 w-4 shrink-0";
  if (icon === "spinner") return <Loader2 className={`${className} animate-spin`} aria-hidden="true" />;
  if (icon === "shield") return <ShieldAlert className={className} aria-hidden="true" />;
  if (icon === "warning") return <AlertTriangle className={className} aria-hidden="true" />;
  return <KeyRound className={className} aria-hidden="true" />;
}

export function NearKeyVerificationNotice({ lang = "en" }: { lang?: "en" | "es" }) {
  const { keyVerification, connection, verifyKey, registerKey, cancelRegistration } =
    useLoginWallet();
  const [busy, setBusy] = useState(false);

  const notice = deriveNotice(keyVerification, lang);
  if (!notice) return null;

  // `{account}` in the un-run states has no account on the state itself — it is the session
  // the user is looking at. Falls back to an empty string rather than a placeholder: a
  // sentence with a gap reads as a typo, a sentence with "undefined" reads as a bug.
  const title = notice.title.replace("{account}", connection?.address ?? "");
  const body = notice.body.replace("{account}", connection?.address ?? "");
  const tone = TONE_CLASSES[notice.tone];

  const handleClick = async () => {
    // Cancel is synchronous and must stay enabled: it is the escape hatch from the very
    // state that would otherwise disable it, so it never goes through `busy`.
    if (notice.action?.run === "cancel") {
      cancelRegistration();
      return;
    }
    setBusy(true);
    try {
      await (notice.action?.run === "register" ? registerKey() : verifyKey());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
      <div
        role={notice.live}
        className={`flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border px-4 py-2.5 ${tone.wrap} ${tone.title}`}
      >
        <NoticeIcon icon={notice.icon} />
        <div className="min-w-0 flex-1">
          {/* `break-words` on the TITLE too, not only the body: four of the twelve titles
              interpolate an account id, and a NEAR name has no spaces to wrap at. Measured
              at 375px with a 45-character account — without it the row pushes the page to
              404px and the whole dashboard scrolls sideways. */}
          <p className={`break-words text-sm font-medium ${tone.title}`}>{title}</p>
          <p className={`mt-0.5 break-words text-sm ${tone.body}`}>{body}</p>
        </div>
        {notice.action?.run === "near-com" ? (
          <a
            href={NEAR_COM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 ${tone.button}`}
          >
            {notice.action.label}
          </a>
        ) : (
          notice.action && (
            <button
              type="button"
              onClick={handleClick}
              disabled={busy && notice.action.run !== "cancel"}
              className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 ${tone.button}`}
            >
              {notice.action.label}
            </button>
          )
        )}
      </div>
    </div>
  );
}
