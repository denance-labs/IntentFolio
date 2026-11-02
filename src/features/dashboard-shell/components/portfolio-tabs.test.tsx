// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { shellTranslations } from "../lib/translations";
import { portfolioColor } from "../lib/portfolio-color";

// 016 block 2.4: a portfolio signed from the tabs' "+" lands on it, like one confirmed from
// My Account — the tabs hand the shell's landing callback to the creation flow.

const flow = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
const data = vi.hoisted(() => ({
  portfolios: [{ id: "p1", name: "Old", isReal: false }] as Array<{ id: string; name: string; isReal: boolean }>,
}));

vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: "en", setLang: vi.fn() }) }));
vi.mock("../context/portfolio-context", () => ({
  usePortfolio: () => ({
    portfolios: data.portfolios,
    activePortfolioId: data.portfolios[0]?.id ?? null,
    setActivePortfolioId: vi.fn(),
  }),
}));
vi.mock("./portfolio-tab-menu", () => ({
  PortfolioTabMenu: ({ portfolioId }: { portfolioId: string }) => <span data-testid={`menu-${portfolioId}`} />,
}));
vi.mock("./portfolio-rename-modal", () => ({ PortfolioRenameModal: () => null }));
vi.mock("./create-portfolio-flow", () => ({
  CreatePortfolioFlow: (props: Record<string, unknown>) => {
    flow.props = props;
    return <div>create-flow</div>;
  },
}));

import { PortfolioTabs } from "./portfolio-tabs";

afterEach(() => {
  cleanup();
  data.portfolios = [{ id: "p1", name: "Old", isReal: false }];
});

describe("PortfolioTabs — '+'", () => {
  it("hands the creation flow both landings: the draft's tab and the new portfolio", () => {
    const onDraftSaved = vi.fn();
    const onPortfolioCreated = vi.fn();
    render(<PortfolioTabs onDraftSaved={onDraftSaved} onPortfolioCreated={onPortfolioCreated} />);
    fireEvent.click(screen.getAllByRole("button", { name: shellTranslations.en.addPortfolio })[0]);

    expect(screen.getByText("create-flow")).toBeTruthy();
    expect(flow.props).toMatchObject({ onDraftSaved, onCreated: onPortfolioCreated, signedOut: false });
  });

  it("signed out, the flow knows it (it builds the anonymous draft)", () => {
    data.portfolios = [];
    render(<PortfolioTabs signedOut />);
    fireEvent.click(screen.getAllByRole("button", { name: shellTranslations.en.addPortfolio })[0]);
    expect(flow.props).toMatchObject({ signedOut: true });
  });
});

// 022-D (D-455): one draft per account. 029 B-22: with one saved, "+" (desktop and mobile)
// stays pressable and opens a window that says why, with the way to the draft; the flow never
// opens.
describe("PortfolioTabs — '+' with a draft saved", () => {
  const t = shellTranslations.en;
  const plusButtons = () => screen.getAllByRole("button", { name: t.addPortfolio });
  const draftTab = () => ({ name: "My mix", active: false, onSelect: vi.fn(), rename: vi.fn() });

  beforeEach(() => {
    flow.props = null;
  });

  it.each([
    ["signed in, with portfolios", {}],
    ["signed out", { signedOut: true }],
  ])("%s: both open the window with the message, not the flow", (_label, extra) => {
    render(<PortfolioTabs draftTab={draftTab()} {...extra} />);
    expect(plusButtons()).toHaveLength(2);
    for (const button of plusButtons()) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(button.getAttribute("aria-haspopup")).toBe("dialog");
      // The reason reaches a screen reader before the press, too.
      expect(button.getAttribute("aria-describedby")).toBe("portfolio-tabs-new-blocked");
      expect(document.getElementById("portfolio-tabs-new-blocked")?.textContent).toBe(t.addPortfolioDraftWaiting);
      fireEvent.click(button);
      const dialog = screen.getByRole("dialog", { name: t.addPortfolio });
      expect(within(dialog).getByText(t.addPortfolioDraftWaiting)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: t.addPortfolioBlockedClose }));
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    expect(screen.queryByText("create-flow")).toBeNull();
    expect(flow.props).toBeNull();
  });

  it("'Go to “My mix”' closes the window and opens the draft's tab", () => {
    const tab = draftTab();
    render(<PortfolioTabs draftTab={tab} />);
    fireEvent.click(plusButtons()[0]);
    fireEvent.click(screen.getByRole("button", { name: t.addPortfolioBlockedGoTo.replace("{name}", "My mix") }));
    expect(tab.onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closing gives the focus back to '+'", () => {
    render(<PortfolioTabs draftTab={draftTab()} />);
    const [button] = plusButtons();
    button.focus();
    fireEvent.click(button);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("signed in with no portfolio, the draft alone makes it wait too", () => {
    data.portfolios = [];
    render(<PortfolioTabs miCuentaActive onMiCuentaClick={vi.fn()} draftTab={draftTab()} />);
    fireEvent.click(plusButtons()[0]);
    expect(screen.getByRole("dialog", { name: t.addPortfolio })).toBeTruthy();
    expect(flow.props).toBeNull();
  });

  it("without a draft (control): opens the flow, no window, nothing described", () => {
    render(<PortfolioTabs />);
    for (const button of plusButtons()) {
      expect(button.getAttribute("aria-haspopup")).toBeNull();
      expect(button.getAttribute("aria-describedby")).toBeNull();
    }
    fireEvent.click(plusButtons()[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("create-flow")).toBeTruthy();
  });
});

// D-476: at the app's cap (7) "+" waits the same way, so no draft is built that could never be
// created; its own message wins over the draft's. 029 B-22: on desktop the window has only
// "Close" (deleting means choosing which); on mobile the short text stays (D-476).
describe("PortfolioTabs — '+' at the portfolio cap", () => {
  const t = shellTranslations.en;
  const plusButtons = () => screen.getAllByRole("button", { name: t.addPortfolio });
  const withPortfolios = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}`, isReal: true }));
  const capMessage = t.addPortfolioCapReached.replace("{max}", "7");

  beforeEach(() => {
    flow.props = null;
  });

  it("with 7: desktop's opens the window with the cap message and only 'Close'; mobile's is plain text", () => {
    data.portfolios = withPortfolios(7);
    render(<PortfolioTabs />);
    expect(plusButtons()).toHaveLength(1);
    fireEvent.click(plusButtons()[0]);
    const dialog = screen.getByRole("dialog", { name: t.addPortfolio });
    expect(within(dialog).getByText(capMessage)).toBeTruthy();
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual([t.addPortfolioBlockedClose]);
    expect(flow.props).toBeNull();
    expect(screen.getByText(t.addPortfolioCapShort.replace("{max}", "7"))).toBeTruthy();
  });

  it("with 7 and a draft saved, the cap's message is the one shown, with no way to the draft", () => {
    data.portfolios = withPortfolios(7);
    render(<PortfolioTabs draftTab={{ name: "My mix", active: false, onSelect: vi.fn(), rename: vi.fn() }} />);
    fireEvent.click(plusButtons()[0]);
    const dialog = screen.getByRole("dialog", { name: t.addPortfolio });
    expect(within(dialog).getByText(capMessage)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /My mix/ })).toBeNull();
  });

  it("with 6 (control): opens the flow", () => {
    data.portfolios = withPortfolios(6);
    render(<PortfolioTabs />);
    fireEvent.click(plusButtons()[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("create-flow")).toBeTruthy();
  });
});

// D-355: on mobile, a native <select> fires no change for the option already selected, so with
// one portfolio preselected there was no way back from My Account. There the select shows a
// placeholder, like the desktop strip selects no tab, and picking the portfolio goes to it.
describe("PortfolioTabs — the mobile select on My Account", () => {
  const select = () => document.getElementById("portfolio-tabs-select") as HTMLSelectElement;

  it("shows no portfolio as chosen, and choosing the only one goes there", () => {
    const onPortfolioTabSelect = vi.fn();
    render(<PortfolioTabs miCuentaActive onMiCuentaClick={vi.fn()} onPortfolioTabSelect={onPortfolioTabSelect} />);
    expect(select().value).toBe("");
    expect(select().selectedOptions[0].textContent).toBe(shellTranslations.en.choosePortfolio);

    fireEvent.change(select(), { target: { value: "p1" } });
    expect(onPortfolioTabSelect).toHaveBeenCalledWith("p1");
  });

  it("on a portfolio, the select shows it and has no placeholder", () => {
    render(<PortfolioTabs miCuentaActive={false} onMiCuentaClick={vi.fn()} onPortfolioTabSelect={vi.fn()} />);
    expect(select().value).toBe("p1");
    expect(screen.queryByRole("option", { name: shellTranslations.en.choosePortfolio, hidden: true })).toBeNull();
  });

  // D-461: the ⋯ beside the select acts on what it shows; on My Account that is no portfolio.
  // The desktop strip keeps one menu per tab, so the mobile one is the second "p1" menu.
  it("on My Account there is no ⋯ beside the select; on a portfolio there is", () => {
    const { unmount } = render(
      <PortfolioTabs miCuentaActive onMiCuentaClick={vi.fn()} onPortfolioTabSelect={vi.fn()} />,
    );
    expect(screen.getAllByTestId("menu-p1")).toHaveLength(1);
    unmount();
    render(<PortfolioTabs miCuentaActive={false} onMiCuentaClick={vi.fn()} onPortfolioTabSelect={vi.fn()} />);
    expect(screen.getAllByTestId("menu-p1")).toHaveLength(2);
  });
});

// 019-4 (D-393 Q3): the New Portfolio Draft as a tab — after the portfolios, before "+",
// marked "not funded", with or without portfolios and with or without a wallet.
describe("PortfolioTabs — the draft's tab", () => {
  const t = shellTranslations.en;
  const select = () => document.getElementById("portfolio-tabs-select") as HTMLSelectElement;
  const tabs = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

  it("with no portfolio at all, a draft alone brings the strip", () => {
    data.portfolios = [];
    render(<PortfolioTabs onMiCuentaClick={vi.fn()} draftTab={{ name: "My mix", active: true, onSelect: vi.fn(), rename: vi.fn() }} />);
    expect(tabs()).toEqual([t.myAccountTab, "My mix"]);
    expect(screen.getByRole("tab", { name: "My mix" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(t.draftTabBadge)).toBeTruthy();
  });

  // D-419: the strip stays, with "New portfolio" and no empty select.
  it("without portfolios and without a draft: My Account and 'New portfolio', no select", () => {
    data.portfolios = [];
    render(<PortfolioTabs miCuentaActive onMiCuentaClick={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: shellTranslations.en.addPortfolio }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(shellTranslations.en.myAccountTab).length).toBeGreaterThan(0);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("sits after the portfolios, before '+'; on it no portfolio is selected", () => {
    render(
      <PortfolioTabs
        onMiCuentaClick={vi.fn()}
        onPortfolioTabSelect={vi.fn()}
        draftTab={{ name: "My mix", active: true, onSelect: vi.fn(), rename: vi.fn() }}
      />
    );
    expect(tabs()).toEqual([t.myAccountTab, "Old", "My mix"]);
    expect(screen.getByRole("tab", { name: "Old" }).getAttribute("aria-selected")).toBe("false");
    const strip = screen.getByRole("tablist");
    // D-318: "+" is not a tab, so it sits right after the tablist, outside the strip that scrolls.
    expect(within(strip).queryByRole("button", { name: t.addPortfolio })).toBeNull();
    const add = strip.nextElementSibling as HTMLElement;
    expect(add.textContent).toBe(t.addPortfolio);
    const draftTab = within(strip).getByRole("tab", { name: "My mix" });
    expect(draftTab.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("on a portfolio, the draft's tab is not selected and choosing it goes there", () => {
    const onSelect = vi.fn();
    render(<PortfolioTabs onMiCuentaClick={vi.fn()} draftTab={{ name: "My mix", active: false, onSelect, rename: vi.fn() }} />);
    expect(screen.getByRole("tab", { name: "Old" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "My mix" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("on mobile it is one more option of the select, marked, and choosing it goes there", () => {
    const onSelect = vi.fn();
    const onPortfolioTabSelect = vi.fn();
    render(
      <PortfolioTabs
        onMiCuentaClick={vi.fn()}
        onPortfolioTabSelect={onPortfolioTabSelect}
        draftTab={{ name: "My mix", active: false, onSelect, rename: vi.fn() }}
      />
    );
    const options = Array.from(select().options).map((o) => o.textContent);
    expect(options).toEqual(["Old", `My mix · ${t.draftTabBadge}`]);
    fireEvent.change(select(), { target: { value: select().options[1].value } });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onPortfolioTabSelect).not.toHaveBeenCalled();
  });

  it("on mobile, on the draft's tab the select shows it", () => {
    render(<PortfolioTabs onMiCuentaClick={vi.fn()} draftTab={{ name: "My mix", active: true, onSelect: vi.fn(), rename: vi.fn() }} />);
    expect(select().selectedOptions[0].textContent).toBe(`My mix · ${t.draftTabBadge}`);
  });

  // 022-B (D-453): signed out with a draft, My Account opens too (it was disabled, D-408).
  it("signed out with a draft, My Account can be chosen", () => {
    data.portfolios = [];
    const onMiCuentaClick = vi.fn();
    render(
      <PortfolioTabs
        onMiCuentaClick={onMiCuentaClick}
        signedOut
        draftTab={{ name: "My mix", active: true, onSelect: vi.fn(), rename: vi.fn() }}
      />
    );
    // The desktop tab and the mobile button.
    const myAccount = [
      screen.getByRole("tab", { name: t.myAccountTab }),
      screen.getByRole("button", { name: t.myAccountTab }),
    ];
    for (const button of myAccount) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(button.hasAttribute("title")).toBe(false);
      fireEvent.click(button);
    }
    expect(onMiCuentaClick).toHaveBeenCalledTimes(2);
  });

  // D-360: discarding on the draft's tab leaves for My Account with the focus gone with it.
  it("My Account, when on screen, is where the focus can land", () => {
    render(<PortfolioTabs miCuentaActive onMiCuentaClick={vi.fn()} draftTab={{ name: "My mix", active: false, onSelect: vi.fn(), rename: vi.fn() }} />);
    expect(screen.getByRole("tab", { name: t.myAccountTab }).hasAttribute("data-focus-landing")).toBe(true);
    expect(screen.getByRole("tab", { name: "My mix" }).hasAttribute("data-focus-landing")).toBe(false);
  });
});

// 021 R5: each portfolio's name in its color with its value under it; My Account its funding
// account (029 B-16).
describe("PortfolioTabs — color and value", () => {
  const t = shellTranslations.en;
  const values = { fundingUsd: 1234.5, byPortfolio: new Map([["p1", 612.4]]) };
  const select = () => document.getElementById("portfolio-tabs-select") as HTMLSelectElement;

  it("a portfolio's tab shows its name and, under it, its value", () => {
    render(<PortfolioTabs onMiCuentaClick={vi.fn()} values={values} />);
    expect(screen.getByRole("tab", { name: "Old $612.40" })).toBeTruthy();
  });

  it("My Account shows its funding account, and says so to a screen reader", () => {
    render(<PortfolioTabs onMiCuentaClick={vi.fn()} values={values} />);
    expect(screen.getByRole("tab", { name: "My account, funding account $1,234.50" })).toBeTruthy();
  });

  // D-541: before the funding account is read, a dash — never a $0 it does not know.
  it("My Account's funding account not read yet: a dash", () => {
    render(<PortfolioTabs onMiCuentaClick={vi.fn()} values={{ ...values, fundingUsd: null }} />);
    expect(screen.getByRole("tab", { name: "My account, funding account —" })).toBeTruthy();
  });

  it("the name is in the portfolio's color, the same on every render", () => {
    render(<PortfolioTabs onMiCuentaClick={vi.fn()} values={values} />);
    const color = portfolioColor("p1").text;
    expect(within(screen.getByRole("tablist")).getByText("Old").className).toContain(color);
    cleanup();
    render(<PortfolioTabs onMiCuentaClick={vi.fn()} miCuentaActive values={values} />);
    expect(within(screen.getByRole("tablist")).getByText("Old").className).toContain(color);
  });

  it("a long name is cut on screen and whole in the tooltip", () => {
    const name = "A very long portfolio nam"; // PORTFOLIO_NAME_MAX_LENGTH (25)
    data.portfolios = [{ id: "p1", name, isReal: false }];
    render(<PortfolioTabs onMiCuentaClick={vi.fn()} values={values} />);
    const tab = screen.getByRole("tab", { name: `${name} $612.40` });
    expect(tab.getAttribute("title")).toBe(name);
    expect(within(tab).getByText(name).className).toContain("truncate");
  });

  it("the draft's tab has no value: nothing is in it yet", () => {
    render(
      <PortfolioTabs
        onMiCuentaClick={vi.fn()}
        values={values}
        draftTab={{ name: "My mix", active: false, onSelect: vi.fn(), rename: vi.fn() }}
      />
    );
    expect(screen.getByRole("tab", { name: "My mix" }).textContent).toBe("My mix");
  });

  it("signed out, My Account shows no total", () => {
    data.portfolios = [];
    render(
      // The shell hands no values signed out: there is no account to total.
      <PortfolioTabs
        onMiCuentaClick={vi.fn()}
        signedOut
        draftTab={{ name: "My mix", active: true, onSelect: vi.fn(), rename: vi.fn() }}
      />
    );
    expect(screen.getByRole("tab", { name: t.myAccountTab }).textContent).toBe(t.myAccountTab);
  });

  it("on mobile, the select carries the color dot of the portfolio on screen, and none on My Account", () => {
    const dot = portfolioColor("p1").dot;
    render(<PortfolioTabs onMiCuentaClick={vi.fn()} values={values} />);
    expect(select().parentElement?.querySelector(`.${dot}`)).not.toBeNull();
    cleanup();
    render(<PortfolioTabs onMiCuentaClick={vi.fn()} miCuentaActive values={values} />);
    expect(select().parentElement?.querySelector("[aria-hidden='true'].rounded-full")).toBeNull();
  });
});

// D-421: the active tab is brought back into the strip when the window shrinks after load.
describe("PortfolioTabs — the strip shrinks", () => {
  let width = 0;
  const observers: Array<() => void> = [];
  const scrollTo = vi.fn();

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly cb: () => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      }
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    // jsdom has no layout: the strip starts at 0, every tab at 500 px and 100 px wide.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { left: this.classList.contains("overflow-x-auto") ? 0 : 500, width: 100 } as DOMRect;
    });
    HTMLElement.prototype.scrollTo = scrollTo;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    observers.length = 0;
    scrollTo.mockReset();
    width = 0;
  });

  it("brings the active tab back into view when the strip's width changes", () => {
    width = 1000;
    render(<PortfolioTabs onMiCuentaClick={vi.fn()} />);
    // Wide enough on load: the tab already fits, nothing scrolls.
    expect(scrollTo).not.toHaveBeenCalled();
    width = 300;
    act(() => observers.forEach((cb) => cb()));
    // 500 + 100 + the 56 px margin, minus the 300 px the strip now shows.
    expect(scrollTo).toHaveBeenCalledWith({ left: 356, behavior: "smooth" });
  });
});
