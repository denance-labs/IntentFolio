"use client";

// A trade is settling in this portfolio (D-471): shown in the confirm modal while Confirm waits
// for it. Same amber as the relay pause — nothing failed and nothing moved.
//
// The countdown is visual only (`aria-hidden`): this is a `role="status"` region, and a number
// re-announced every second would drown everything else. The disabled Confirm points here
// through `aria-describedby`, so the reason is read with the button.
export function TradeInFlightNotice({
  id,
  title,
  body,
  seconds,
}: {
  id: string;
  title: string;
  body: string;
  seconds: number;
}) {
  return (
    <div id={id} role="status" className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/5 px-3 py-2">
      <p className="text-[12px] font-semibold leading-tight text-amber-200">{title}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-amber-200/80">
        {body}{" "}
        <span aria-hidden="true" className="tabular-nums">
          ({seconds} s)
        </span>
      </p>
    </div>
  );
}
