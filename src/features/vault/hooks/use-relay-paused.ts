"use client";

// Whether the relayer is paused, asked once when a confirmation modal opens (017-2, D-365).
//
// The operator's switch (`RELAY_PAUSED`) stops the relay for everyone. Asking before the
// signature is what spares the user a wallet prompt for something that cannot be sent — and it
// has to happen on open, not in the click: the wallet popup must open inside the click's
// activation window, with no network read in front of it.
//
// A courtesy, like the maturity gate: it starts open, errs open when the answer is unreadable,
// and the relay refuses a paused POST on its own (`paused`, relay-service.ts) if the switch
// flips between the modal opening and the click.

import { useEffect, useState } from "react";
import { fetchRelayPaused } from "../lib/relay-client";

/** `active`: this confirmation would be sent through the relayer. Otherwise nothing is asked. */
export function useRelayPaused(active: boolean): boolean {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fetchRelayPaused().then((answer) => {
      if (!cancelled) setPaused(answer);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return active && paused;
}
