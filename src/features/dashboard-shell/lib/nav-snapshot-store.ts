// NAV snapshot store (D-149). Client-side localStorage, one snapshot per portfolio per day.
// Populated by takeSnapshot (production) and seedNavSnapshots (mock demo only — never a
// real portfolio, D-336).
// The indexer will replace this in E8.

// v2 (D-336): v1 mixed the demo seed into real portfolios — 60 invented days that the
// store cannot tell apart from real snapshots — so v1 is dropped whole instead of cleaned.
// The mock demo re-seeds on its next render; a real portfolio restarts from today.
const STORAGE_KEY = "nav-snapshots:v2";
const LEGACY_STORAGE_KEYS = ["nav-snapshots:v1"];

// portfolioId → date (YYYY-MM-DD) → navUsd
type NavSnapshotData = Record<string, Record<string, number>>;

export type NavPoint = { date: string; navUsd: number };

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function cutoffStr(rangeDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() - rangeDays + 1);
  return d.toISOString().slice(0, 10);
}

function load(): NavSnapshotData {
  if (typeof window === "undefined") return {};
  try {
    for (const key of LEGACY_STORAGE_KEYS) window.localStorage.removeItem(key);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as NavSnapshotData) : {};
  } catch {
    return {};
  }
}

function persist(data: NavSnapshotData): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function getNavSeries(portfolioId: string, rangeDays: number): NavPoint[] {
  const data = load();
  const entries = data[portfolioId] ?? {};
  const cutoff = cutoffStr(rangeDays);
  return Object.entries(entries)
    .filter(([date]) => date >= cutoff)
    .map(([date, navUsd]) => ({ date, navUsd }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Idempotent: overwrites today's value if already present.
export function takeSnapshot(portfolioId: string, navUsd: number): void {
  if (navUsd <= 0) return;
  const data = load();
  const entries = data[portfolioId] ?? {};
  entries[todayStr()] = navUsd;
  data[portfolioId] = entries;
  persist(data);
}

export function seedNavSnapshots(portfolioId: string, points: NavPoint[]): void {
  const data = load();
  const entries = data[portfolioId] ?? {};
  for (const { date, navUsd } of points) {
    entries[date] = navUsd;
  }
  data[portfolioId] = entries;
  persist(data);
}

export function hasNavData(portfolioId: string): boolean {
  const data = load();
  return Object.keys(data[portfolioId] ?? {}).length > 0;
}
