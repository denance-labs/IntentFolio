// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ContractEvent } from "@/features/intents-account/mock-contract/types";

// Triage 016, block 1b (D-339): a REAL portfolio's History reads `useRealPortfolioHistory` —
// since 028-7 the history route, a page at a time; a mock one keeps reading the mock ledger.

const state = vi.hoisted(() => ({
  portfolio: null as unknown,
  history: null as unknown,
  historyCalls: [] as Array<[string | null, string | null, boolean]>,
}));

vi.mock("../context/portfolio-context", () => ({
  usePortfolio: () => ({ activePortfolio: state.portfolio }),
}));
vi.mock("../context/language-context", () => ({
  useLanguage: () => ({ lang: "es" }),
}));
vi.mock("@/features/login-wallet", () => ({
  useLoginWallet: () => ({ intentsAccountId: "pablofork.near" }),
}));
vi.mock("@/features/market/hooks/use-token-prices", () => ({
  useTokenPrices: () => ({ prices: {}, isLoading: false }),
}));
vi.mock("@/features/vault/hooks/use-real-portfolio-history", () => ({
  useRealPortfolioHistory: (account: string | null, portfolioId: string | null, enabled: boolean) => {
    state.historyCalls.push([account, portfolioId, enabled]);
    return state.history;
  },
}));

import { HistoryView } from "./history-view";

const REAL = { id: "p_17", name: "canary", isReal: true };
const base = { commit_id: "TX1", account_id: "pablofork.near", portfolio_id: "p_17", ts: Date.UTC(2026, 8, 24) };
const EVENTS: ContractEvent[] = [
  { kind: "portfolio_created", event_id: "a", ...base, name: "canary" },
  { kind: "allocate", event_id: "b", ...base, token: "near", qty: 1 },
  { kind: "unallocate", event_id: "c", ...base, commit_id: "TX2", ts: base.ts + 1000, token: "near", qty: 0.5 },
  // Another portfolio's event: never shown here.
  { kind: "allocate", event_id: "d", ...base, commit_id: "TX3", portfolio_id: "p_99", token: "near", qty: 9 },
];

/** The hook's answer; `data` given as events is one settled page's worth. */
const query = (over: Record<string, unknown>) => ({
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  isFetchingNextPage: false,
  outOfDate: false,
  ...over,
  data: Array.isArray(over.data) ? { events: over.data, loading: false, upToDate: true } : over.data,
});

describe("HistoryView — real portfolio", () => {
  beforeEach(() => {
    state.portfolio = REAL;
    state.historyCalls = [];
  });
  afterEach(cleanup);

  it("asks the history route only for a real portfolio, by its id", () => {
    state.history = query({ data: [] });
    render(<HistoryView />);
    expect(state.historyCalls.at(-1)).toEqual(["pablofork.near", "p_17", true]);
  });

  it("shows a skeleton while the chain is being read", () => {
    state.history = query({ isLoading: true });
    const { container } = render(<HistoryView />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("a failed read is an error with a retry, never an empty history", () => {
    const refetch = vi.fn();
    state.history = query({ isError: true, refetch });
    render(<HistoryView />);
    expect(screen.getByRole("alert").textContent).toContain("No pudimos cargar la actividad");
    expect(screen.queryByText(/Acá van a aparecer/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("names each row by what the user did, only for this portfolio, with no limits note", () => {
    state.history = query({ data: EVENTS });
    render(<HistoryView />);
    // Badge and filter chip share the label, hence getAll.
    expect(screen.getAllByText("Portfolio creado").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pasado a la cuenta de fondos").length).toBeGreaterThan(0);
    expect(screen.getByText(/2 eventos/)).toBeTruthy();
    expect(screen.queryByText(/Portfolio Commit/)).toBeNull();
    // No limits note (operator, s283): composition edits from any device come from the chain (D-422).
    expect(screen.queryByText(/Todavía no aparecen/)).toBeNull();
  });

  it("an empty real history says where movements will appear, with no limits note", () => {
    state.history = query({ data: [] });
    render(<HistoryView />);
    expect(screen.getByText(/Aquí van a aparecer los movimientos/)).toBeTruthy();
    expect(screen.queryByText(/Todavía no aparecen/)).toBeNull();
  });

  it("with a single row type, shows no filter chips", () => {
    state.history = query({ data: EVENTS.slice(0, 2) });
    render(<HistoryView />);
    expect(screen.queryByRole("button", { name: "Todos" })).toBeNull();
  });
});

describe("HistoryView — a filter that matches nothing (D-341)", () => {
  beforeEach(() => {
    state.portfolio = REAL;
  });
  afterEach(cleanup);

  it("says so instead of a bare '0 eventos'", () => {
    const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    state.history = query({
      data: [EVENTS[0], EVENTS[1], { ...EVENTS[2], token: USDC }],
    });
    render(<HistoryView />);
    expect(screen.queryByText("Ningún evento coincide con estos filtros.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pasado a la cuenta de fondos" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "NEAR" } });
    expect(screen.getByText(/0 eventos/)).toBeTruthy();
    expect(screen.getByText("Ningún evento coincide con estos filtros.")).toBeTruthy();
  });
});

// D-422: the final vault reports a composition edit with only its ids — one generic row.
describe("HistoryView — a composition edit read from the chain", () => {
  const EDIT: ContractEvent = { kind: "composition_changed", event_id: "e", ...base, commit_id: "TX4", ts: base.ts + 2000 };
  beforeEach(() => {
    state.portfolio = REAL;
  });
  afterEach(cleanup);

  it("is one generic row, with no token detail", () => {
    state.history = query({ data: [EDIT] });
    render(<HistoryView />);
    expect(screen.getByText("Composición editada")).toBeTruthy();
    expect(screen.getByText("Editaste la composición.")).toBeTruthy();
    // One row reads «1 evento», not «1 eventos» (s283 QA).
    expect(screen.getByText(/1 evento$/)).toBeTruthy();
    // Its detail would only repeat the reason (s283 QA): no «Ver detalle».
    expect(screen.queryByRole("button", { name: "Ver detalle" })).toBeNull();
  });

  it("an edit that also added funds is one row, its detail naming both", () => {
    const allocate: ContractEvent = { kind: "allocate", event_id: "f", ...base, commit_id: "TX4", ts: EDIT.ts, token: "near", qty: 2 };
    state.history = query({ data: [allocate, EDIT] });
    render(<HistoryView />);
    expect(screen.getByText("Asignado al portfolio")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle" }));
    expect(screen.getByText(/y editaste su composición\.$/)).toBeTruthy();
    expect(screen.getByText("Composición editada")).toBeTruthy();
  });

  it("falls under the composition-edit filter", () => {
    state.history = query({ data: [EVENTS[2], EDIT] });
    render(<HistoryView />);
    fireEvent.click(screen.getByRole("button", { name: "Composición editada" }));
    expect(screen.getByText(/1 evento$/)).toBeTruthy();
    expect(screen.getByText("Editaste la composición.")).toBeTruthy();
    // The move's label is left only on its chip; its row is filtered out.
    expect(screen.getAllByText("Pasado a la cuenta de fondos")).toHaveLength(1);
  });
});

describe("HistoryView — mock portfolio", () => {
  afterEach(cleanup);

  it("does not enable the chain read and shows no limits note", () => {
    state.portfolio = { id: "m1", name: "demo", isReal: false };
    state.history = query({});
    state.historyCalls = [];
    render(<HistoryView />);
    expect(state.historyCalls.at(-1)).toEqual(["pablofork.near", "m1", false]);
    expect(screen.queryByText(/Todavía no aparecen/)).toBeNull();
  });
});

describe("HistoryView — 'Ver más' (D-364 5)", () => {
  beforeEach(() => {
    state.portfolio = REAL;
  });
  afterEach(cleanup);

  it("shows 20 rows at a time; the read itself does not change", () => {
    const many: ContractEvent[] = Array.from({ length: 23 }, (_, i) => ({
      kind: "allocate",
      event_id: `e${i}`,
      ...base,
      commit_id: `TX-${i}`,
      ts: base.ts + i * 60_000,
      token: "near",
      qty: 1,
    }));
    state.history = query({ data: many });
    const { container } = render(<HistoryView />);
    const cards = () => container.querySelectorAll("article").length;
    expect(cards()).toBe(20);
    fireEvent.click(screen.getByRole("button", { name: "Ver más" }));
    expect(cards()).toBe(23);
    expect(screen.queryByRole("button", { name: "Ver más" })).toBeNull();
  });
});

// 028-7 (D-489): what the user signed, from the history route — new targets, tokens added and
// removed — with no "before" (s299).
describe("HistoryView — a composition edit with its signed detail", () => {
  const USDT = "nep141:usdt.tether-token.near";
  const at = { ...base, commit_id: "TX5", ts: base.ts + 3000 };
  const DETAIL: ContractEvent[] = [
    { kind: "target_set", event_id: "g:0", ...at, token: USDT, target_pct: 39.5, tolerance_pct: 20 },
    { kind: "token_added", event_id: "g:1", ...at, token: "near", initial_target_pct: 37, initial_tolerance_pct: 10 },
    { kind: "token_removed", event_id: "g:2", ...at, token: "nep141:eth.bridge.near" },
  ];
  beforeEach(() => {
    state.portfolio = REAL;
  });
  afterEach(cleanup);

  it("says what changed, and its detail lists each line", () => {
    state.history = query({ data: DETAIL });
    render(<HistoryView />);
    expect(screen.getByText("Editaste la composición: agregaste 1 token, quitaste 1 token, cambiaste 1 objetivo.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle" }));
    expect(screen.getByText("USDT(NEAR) · nuevo objetivo 39,5%")).toBeTruthy();
    expect(screen.getByText("NEAR agregado · objetivo 37%")).toBeTruthy();
    expect(screen.getByText("ETH quitado")).toBeTruthy();
    expect(screen.queryByText("Composición editada", { selector: "li span" })).toBeNull();
  });
});

// D-530: with the before, each line says what moved — the target, the tolerance, or both.
describe("HistoryView — a composition edit with its before", () => {
  const at = { ...base, commit_id: "TX6", ts: base.ts + 3000 };
  const change = (event_id: string, token: string, target: [number, number], tolerance: [number, number]): ContractEvent => ({
    kind: "target_change",
    event_id,
    ...at,
    token,
    old_target_pct: target[0],
    new_target_pct: target[1],
    old_tolerance_pct: tolerance[0],
    new_tolerance_pct: tolerance[1],
  });
  beforeEach(() => {
    state.portfolio = REAL;
  });
  afterEach(cleanup);

  it("a tolerance-only edit says so, and its detail shows the tolerance before → after", () => {
    state.history = query({
      data: [change("t:0", "near", [5, 5], [12, 30]), change("t:1", "nep141:usdt.tether-token.near", [95, 95], [12, 30])],
    });
    render(<HistoryView />);
    expect(screen.getByText("Editaste la composición: cambiaste la tolerancia de 2 tokens.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle" }));
    expect(screen.getByText("NEAR · tolerancia 12% → 30%")).toBeTruthy();
    expect(screen.getByText("USDT(NEAR) · tolerancia 12% → 30%")).toBeTruthy();
  });

  it("targets and tolerances count apart; a token with both says both", () => {
    state.history = query({
      data: [change("t:0", "near", [5, 10], [12, 12]), change("t:1", "nep141:usdt.tether-token.near", [95, 90], [12, 20])],
    });
    render(<HistoryView />);
    expect(screen.getByText("Editaste la composición: cambiaste 2 objetivos, cambiaste la tolerancia de 1 token.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle" }));
    expect(screen.getByText("NEAR · objetivo 5% → 10%")).toBeTruthy();
    expect(screen.getByText("USDT(NEAR) · objetivo 95% → 90%, tolerancia 12% → 20%")).toBeTruthy();
  });
});

// D-539: what the Setup paid for storage, in the creation's detail; the summary keeps what reached the portfolio.
describe("HistoryView — a creation's Storage Cost", () => {
  beforeEach(() => {
    state.portfolio = REAL;
  });
  afterEach(cleanup);

  it("is its own line of the detail, never in the summary or the reason", () => {
    state.history = query({
      data: [
        { kind: "portfolio_created", event_id: "a", ...base, name: "canary" },
        { kind: "storage_cost", event_id: "s", ...base, token: "nep141:eth.omft.near", qty: 0.000030957572709894 },
        { kind: "allocate", event_id: "b", ...base, token: "nep141:eth.omft.near", qty: 0.00154 },
      ],
    });
    const { container } = render(<HistoryView />);
    const card = () => container.querySelector("article")?.textContent ?? "";
    expect(card()).toContain("+0.00154 ETH");
    expect(card()).not.toContain("0.00003");
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle" }));
    expect(screen.getByText("Creaste el portfolio y le asignaste 1 token.")).toBeTruthy();
    expect(screen.getByText("Costo de almacenamiento · 0.00003 ETH")).toBeTruthy();
  });
});

describe("HistoryView — the account's history still loading, or behind (028-7)", () => {
  beforeEach(() => {
    state.portfolio = REAL;
  });
  afterEach(cleanup);

  it("while the account loads, says so — over the rows, or instead of the empty text", () => {
    state.history = query({ data: { events: EVENTS, loading: true, upToDate: true } });
    render(<HistoryView />);
    expect(screen.getByRole("status").textContent).toBe("Cargando actividad…");
    cleanup();
    state.history = query({ data: { events: [], loading: true, upToDate: false } });
    render(<HistoryView />);
    expect(screen.getByRole("status").textContent).toBe("Cargando actividad…");
    expect(screen.queryByText(/Acá van a aparecer/)).toBeNull();
  });

  it("still behind after its re-reads: the latest may be missing", () => {
    state.history = query({ data: { events: EVENTS, loading: false, upToDate: false }, outOfDate: true });
    render(<HistoryView />);
    expect(screen.getByRole("status").textContent).toBe("Puede faltar lo más reciente");
  });

  it("up to date: no note", () => {
    state.history = query({ data: EVENTS });
    render(<HistoryView />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("HistoryView — 'Ver más' reads the next page (028-7)", () => {
  beforeEach(() => {
    state.portfolio = REAL;
  });
  afterEach(cleanup);

  it("with more pages, the count says «at least» and «Ver más» asks for the next one", () => {
    const page: ContractEvent[] = Array.from({ length: 20 }, (_, i) => ({
      kind: "allocate",
      event_id: `p${i}`,
      ...base,
      commit_id: `TXP-${i}`,
      ts: base.ts + i * 60_000,
      token: "near",
      qty: 1,
    }));
    const fetchNextPage = vi.fn();
    state.history = query({ data: page, hasNextPage: true, fetchNextPage });
    const { container } = render(<HistoryView />);
    expect(screen.getByText(/20\+ eventos/)).toBeTruthy();
    expect(container.querySelectorAll("article").length).toBe(20);
    fireEvent.click(screen.getByRole("button", { name: "Ver más" }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});

describe("HistoryView — token colors", () => {
  afterEach(cleanup);

  it("dots a token with the portfolio's own color, the one its arc has in Overview", () => {
    const BTC = "nep141:btc.omft.near";
    // Portfolio order: BTC first (amber), NEAR second (indigo). The symbol hash would color
    // them differently.
    state.portfolio = {
      ...REAL,
      targets: [
        { id: "r1", tokenId: BTC, targetPct: 50, tolerancePct: 5, locked: false },
        { id: "r2", tokenId: "near", targetPct: 50, tolerancePct: 5, locked: false },
      ],
      deposits: {},
    };
    state.history = query({
      data: [
        { kind: "external_rebalance", event_id: "x", account_id: base.account_id, portfolio_id: base.portfolio_id, ts: base.ts, token_in: "near", qty_in: 2, token_out: BTC, qty_out: 0.001, attributed_spread: 0.1 },
      ],
    });
    const { container } = render(<HistoryView />);
    const dots = [...container.querySelectorAll("article span[aria-hidden='true']")] as HTMLElement[];
    const colors = dots.map((d) => d.style.backgroundColor);
    // jsdom normalizes hex to rgb(): #818cf8 (indigo) for NEAR, #d97706 (amber) for BTC.
    expect(colors).toEqual(["rgb(129, 140, 248)", "rgb(217, 119, 6)"]);
  });
});
