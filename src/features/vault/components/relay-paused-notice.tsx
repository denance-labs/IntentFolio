"use client";

// The operator paused the relayer (017-2, D-365): shown in a confirmation modal instead of a
// signature request. Amber, not rose — nothing failed and nothing moved. Copy comes from the
// modal's own translations, so each surface keeps its wording.

// `id`: the disabled primary button points at it (aria-describedby), so the reason it cannot be
// pressed is read with it — a status inserted already filled is not reliably announced.
export function RelayPausedNotice({ id, title, body }: { id: string; title: string; body: string }) {
  return (
    <div id={id} role="status" className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/5 px-3 py-2">
      <p className="text-[12px] font-semibold leading-tight text-amber-200">{title}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-amber-200/80">{body}</p>
    </div>
  );
}
