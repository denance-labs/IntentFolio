/**
 * Whether a click pins a token. A mouse already follows tokens by hover, so its click
 * would only leave one lit after the pointer leaves; touch, pen and keyboard clicks pin.
 * A browser whose click carries no pointerType keeps pinning.
 */
export function clickPins(e: { nativeEvent: Event }): boolean {
  const native = e.nativeEvent as Event & { pointerType?: string };
  return native.pointerType !== "mouse";
}

/** Whether a document click landed off every token (`data-showcase-token`), which lets the pinned one go. */
export function isOutsideTap(target: EventTarget | null): boolean {
  return !(target instanceof Element && target.closest("[data-showcase-token]"));
}
