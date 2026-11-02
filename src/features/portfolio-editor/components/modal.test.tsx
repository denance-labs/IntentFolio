// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Modal } from "./portfolio-primitives";

// 017-5 (D-309 + D-360): the keyboard contract every dialog shares through `useDialogFocus`.

afterEach(cleanup);

function Dialog({ id, onClose, children }: { id: string; onClose: () => void; children?: React.ReactNode }) {
  return (
    <Modal titleId={`${id}-title`} onClose={onClose}>
      <h2 id={`${id}-title`}>{id}</h2>
      {children ?? (
        <>
          <button type="button">{`${id} first`}</button>
          <button type="button">{`${id} last`}</button>
        </>
      )}
    </Modal>
  );
}

const tab = (shiftKey = false) => fireEvent.keyDown(document, { key: "Tab", shiftKey });

describe("Modal keyboard", () => {
  it("focuses the first control on open", () => {
    render(<Dialog id="a" onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "a first" }));
  });

  it("keeps Tab inside: from the last control to the first, and Shift+Tab back", () => {
    render(<Dialog id="a" onClose={vi.fn()} />);
    const first = screen.getByRole("button", { name: "a first" });
    const last = screen.getByRole("button", { name: "a last" });

    last.focus();
    tab();
    expect(document.activeElement).toBe(first);

    tab(true);
    expect(document.activeElement).toBe(last);
  });

  it("brings a focus lost to <body> back into the dialog, not onto the page behind", () => {
    render(
      <>
        <a href="#main">Skip to main content</a>
        <Dialog id="a" onClose={vi.fn()} />
      </>
    );
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "a first" }));
    (document.activeElement as HTMLElement).blur();
    tab(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "a last" }));
  });

  it("skips disabled controls and a disabled fieldset", () => {
    render(
      <Dialog id="a" onClose={vi.fn()}>
        <button type="button">only</button>
        <fieldset disabled>
          <input aria-label="frozen" />
        </fieldset>
        <button type="button" disabled>
          off
        </button>
      </Dialog>
    );
    const only = screen.getByRole("button", { name: "only" });
    expect(document.activeElement).toBe(only);
    tab();
    expect(document.activeElement).toBe(only);
  });

  it("Escape closes only the top dialog of a stack", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    render(
      <>
        <Dialog id="a" onClose={closeA} />
        <Dialog id="b" onClose={closeB} />
      </>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
  });

  it("Escape reads the latest handler — a guard set while open holds", () => {
    const close = vi.fn();
    function Guarded() {
      const [signing, setSigning] = useState(false);
      return (
        <Modal titleId="t" onClose={signing ? () => {} : close}>
          <h2 id="t">t</h2>
          <button type="button" onClick={() => setSigning(true)}>
            sign
          </button>
        </Modal>
      );
    }
    render(<Guarded />);
    fireEvent.click(screen.getByRole("button", { name: "sign" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });

  it("hands the focus back to the control that opened it", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          {open && <Dialog id="a" onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "open" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "a first" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
  });

  it("D-360: when the opener is gone, the focus goes to the landing that replaced it", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      const [saved, setSaved] = useState(false);
      return (
        <>
          {saved ? (
            <h2 tabIndex={-1} data-focus-landing>
              card
            </h2>
          ) : (
            <button type="button" onClick={() => setOpen(true)}>
              build
            </button>
          )}
          {open && (
            <Dialog id="a" onClose={() => setOpen(false)}>
              <button
                type="button"
                onClick={() => {
                  setSaved(true);
                  setOpen(false);
                }}
              >
                save
              </button>
            </Dialog>
          )}
        </>
      );
    }
    render(<Host />);
    const build = screen.getByRole("button", { name: "build" });
    build.focus();
    fireEvent.click(build);
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "card" }));
  });

  it("D-360: a landing that mounts a frame later still gets the focus", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
    try {
      let mountLanding = () => {};
      function Host() {
        const [open, setOpen] = useState(false);
        const [used, setUsed] = useState(false);
        const [landing, setLanding] = useState(false);
        mountLanding = () => setLanding(true);
        return (
          <>
            {/* There while the dialog is open, gone once it closes. */}
            {!used || open ? (
              <button
                type="button"
                onClick={() => {
                  setUsed(true);
                  setOpen(true);
                }}
              >
                build
              </button>
            ) : null}
            {landing ? (
              <button type="button" data-focus-landing>
                later
              </button>
            ) : null}
            {open && <Dialog id="a" onClose={() => setOpen(false)} />}
          </>
        );
      }
      render(<Host />);
      const build = screen.getByRole("button", { name: "build" });
      build.focus();
      fireEvent.click(build);
      // Closing removes nothing the focus could return to, and no landing is there yet.
      fireEvent.keyDown(document, { key: "Escape" });
      expect(document.activeElement).toBe(document.body);
      act(() => mountLanding());
      act(() => {
        vi.advanceTimersToNextFrame();
      });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "later" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("D-360: a landing that cannot take the focus is skipped for the next one", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      const [used, setUsed] = useState(false);
      return (
        <>
          <button type="button" disabled data-focus-landing>
            unreachable
          </button>
          <button type="button" data-focus-landing>
            reachable
          </button>
          {!used || open ? (
            <button
              type="button"
              onClick={() => {
                setUsed(true);
                setOpen(true);
              }}
            >
              build
            </button>
          ) : null}
          {open && <Dialog id="a" onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Host />);
    const build = screen.getByRole("button", { name: "build" });
    build.focus();
    fireEvent.click(build);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "reachable" }));
  });

  it("opened with nothing focused (a dialog shown on arrival, a menu item gone), it hands the focus to the landing", () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" data-focus-landing>
            landing
          </button>
          {open && <Dialog id="a" onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Host />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "landing" }));
  });
});
