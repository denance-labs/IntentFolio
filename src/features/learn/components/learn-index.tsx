"use client";

type LearnIndexProps = {
  label: string;
  items: ReadonlyArray<{ id: string; label: string }>;
};

// Desktop-only sticky table of contents. Hidden below lg so it never competes with
// content on narrow screens; the sections still carry their own ids for the in-page
// anchors. The nav is 56px tall (h-14), so top-20 keeps the list clear of it.
export function LearnIndex({ label, items }: LearnIndexProps) {
  return (
    <nav aria-label={label} className="hidden lg:block">
      <div className="sticky top-20">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {label}
        </p>
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                className="block rounded text-sm text-slate-400 transition hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
