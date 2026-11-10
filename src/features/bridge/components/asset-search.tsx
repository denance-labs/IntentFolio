"use client";

// D-483: the search over the Receive and Withdraw asset lists — symbol or name, like the
// draft's token picker (draft-token-picker.tsx). Not focused on open: on a phone that would
// raise the keyboard over a list most people pick from by sight.

import { tokenRegistry } from "@/features/market/lib/token-registry";

// A group carries only its key and ticker; the full names ("Bitcoin", "NEAR Protocol") live on
// the registry rows it groups (keyed the same way: `assetName ?? symbol`).
const namesByGroup = new Map<string, string>();
for (const tk of tokenRegistry) {
  const key = tk.assetName ?? tk.symbol;
  namesByGroup.set(key, `${namesByGroup.get(key) ?? ""} ${tk.name.toLowerCase()}`);
}

export function matchAssetGroups<G extends { ticker: string; assetName: string }>(groups: G[], query: string): G[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups.filter(
    (g) =>
      g.ticker.toLowerCase().includes(q) ||
      g.assetName.toLowerCase().includes(q) ||
      (namesByGroup.get(g.assetName) ?? "").includes(q)
  );
}

export function AssetSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="px-3 pb-2">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-400 focus:border-accent"
      />
    </div>
  );
}
