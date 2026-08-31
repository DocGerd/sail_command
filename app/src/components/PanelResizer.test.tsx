import { createRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import PanelResizer from './PanelResizer';

// #355 test plan (CLAUDE.md framing rule — state the blind spot explicitly):
// this file covers the A11Y CONTRACT ONLY. jsdom has no `setPointerCapture`
// and no real hit-testing/layout, so a synthesised `pointermove` here would
// prove an event handler ran, not that a drag visually works — writing a
// jsdom test that claims to cover DRAGGING would pass against a resizer
// that moves nothing on screen. That path (and "the map renders correctly
// during a drag") is out of reach for this suite entirely; see the PR
// description for the source-level argument and the e2e spec for the
// resize-and-persist behaviour Playwright CAN observe.
//
// A SECOND, sharper blind spot this file cannot see by construction: every
// test below hands PanelResizer a `panelRef`/`targetRef` whose `.current` is
// ALREADY populated before mount (`renderResizer` sets it directly). The
// real bug this component actually shipped with — `panelRef.current` still
// `null` inside a `useLayoutEffect` because that effect ran before a LATER
// sibling's ref got attached, a real cross-fiber ordering issue — is
// invisible to a harness that never lets the ref start `null` and get
// attached through React's own commit. That bug was caught only by the e2e
// spec, in a real browser, against the real App.tsx tree; see
// PanelResizer.tsx's own comment on the `useEffect` fix. This file proves
// the KEYBOARD/ARIA contract once `widthPx` is known-good; it was never able
// to prove `widthPx` gets set correctly on a cold mount in the real app.
//
// Same fake as lib/useBannerHeight.test.ts (jsdom has no real
// ResizeObserver) — deliberately minimal and never auto-fires. PanelResizer
// seeds its width synchronously from `getBoundingClientRect()` inside its
// own `useEffect` (see that file's comment for why `useEffect`, not
// `useLayoutEffect`) — these tests only need a real `ResizeObserver`
// constructor to exist so that code path runs; no test here exercises an
// ONGOING resize, so the fake never needs to invoke its callback.
class FakeResizeObserver {
  observed: Element | null = null;
  observe(el: Element) {
    this.observed = el;
  }
  unobserve() {
    this.observed = null;
  }
  disconnect() {
    this.observed = null;
  }
}

function stubMeasuredWidth(el: HTMLElement, width: number) {
  el.getBoundingClientRect = () =>
    ({
      width,
      height: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    }) as DOMRect;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderResizer({
  min = 320,
  max = 700,
  measuredWidth = 400,
  onCommit = vi.fn(),
  inert = false,
}: {
  min?: number;
  max?: number;
  measuredWidth?: number;
  onCommit?: (next: number | null) => void;
  inert?: boolean;
} = {}) {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const panelRef = createRef<HTMLDivElement>();
  const targetRef = createRef<HTMLDivElement>();
  // The elements PanelResizer measures/writes must exist in the DOM before
  // mount for the refs to be non-null when its measurement effect runs —
  // see the file header comment above for why that is NOT how the real
  // App.tsx tree behaves on a cold mount.
  const panelEl = document.createElement('div');
  const targetEl = document.createElement('div');
  document.body.append(panelEl, targetEl);
  (panelRef as { current: HTMLDivElement }).current = panelEl;
  (targetRef as { current: HTMLDivElement }).current = targetEl;
  stubMeasuredWidth(panelEl, measuredWidth);

  const rendered = render(
    <PanelResizer
      panelRef={panelRef}
      targetRef={targetRef}
      min={min}
      max={max}
      onCommit={onCommit}
      aria-label="Resize panel"
      inert={inert}
    />,
  );
  // Re-renders the SAME PanelResizer instance (same refs/min/max/onCommit)
  // with only `inert` changed — used to assert the open -> close TRANSITION
  // rather than two independent fresh mounts.
  const rerenderInert = (next: boolean) =>
    rendered.rerender(
      <PanelResizer
        panelRef={panelRef}
        targetRef={targetRef}
        min={min}
        max={max}
        onCommit={onCommit}
        aria-label="Resize panel"
        inert={next}
      />,
    );
  return { onCommit, targetEl, rerenderInert, unmount: rendered.unmount };
}

// jsdom has neither `setPointerCapture` nor `releasePointerCapture` at all
// (see the file header) — a real `handlePointerDown` call throws without
// this. `releasePointerCapture` is a `vi.fn()`, not a no-op, so the #468
// drag-abort tests below can assert PanelResizer actually calls it (the one
// thing this suite CAN observe about capture release — never that a real
// browser's capture state changed, which jsdom cannot model).
function stubPointerCapture(el: HTMLElement) {
  const releasePointerCapture = vi.fn();
  (el as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  (el as unknown as { releasePointerCapture: typeof releasePointerCapture }).releasePointerCapture =
    releasePointerCapture;
  return { releasePointerCapture };
}

// Flushes exactly one real animation frame — used to prove `writeLive`'s
// rAF-coalesced write to `--sc-panel-w` actually lands (or, after an abort,
// that a PREVIOUSLY scheduled one does NOT).
async function flushOneFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

describe('PanelResizer — a11y contract', () => {
  it('exposes role=separator with the WAI-ARIA window-splitter value attributes', () => {
    renderResizer({ min: 320, max: 700, measuredWidth: 400 });
    const el = screen.getByRole('separator');
    expect(el).toHaveAttribute('aria-orientation', 'vertical');
    expect(el).toHaveAttribute('aria-valuemin', '320');
    expect(el).toHaveAttribute('aria-valuemax', '700');
    expect(el).toHaveAttribute('aria-valuenow', '400');
    expect(el).toHaveAttribute('aria-label', 'Resize panel');
  });

  it('is keyboard-focusable (tabIndex 0)', () => {
    renderResizer();
    expect(screen.getByRole('separator')).toHaveAttribute('tabIndex', '0');
  });

  // #696: the `inert` prop must reach the rendered separator element itself
  // — App.tsx applies it to every other app-shell sibling directly, but
  // PanelResizer is the one sibling that has to forward it through its own
  // named-prop interface (PanelResizerProps has no `...rest` spread). jsdom
  // 30.0.1 does not implement `inert` BEHAVIOURALLY (confirmed: the IDL
  // property reads `undefined` and a descendant's `.focus()` still succeeds
  // under it), so this pins only the attribute's presence/absence — never a
  // claim that focus is actually blocked here.
  it('#696: forwards inert to the rendered role="separator" element, present -> absent on toggle', () => {
    const { rerenderInert } = renderResizer({ inert: true });
    expect(screen.getByRole('separator')).toHaveAttribute('inert');

    rerenderInert(false);
    expect(screen.getByRole('separator')).not.toHaveAttribute('inert');
  });

  it('ArrowRight commits a step increase from the measured current width', () => {
    const { onCommit } = renderResizer({ min: 320, max: 700, measuredWidth: 400 });
    act(() => fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' }));
    expect(onCommit).toHaveBeenCalledWith(416); // 400 + STEP_PX(16)
  });

  it('ArrowLeft commits a step decrease', () => {
    const { onCommit } = renderResizer({ min: 320, max: 700, measuredWidth: 400 });
    act(() => fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' }));
    expect(onCommit).toHaveBeenCalledWith(384); // 400 - 16
  });

  it('Shift+ArrowRight uses the coarse step', () => {
    const { onCommit } = renderResizer({ min: 320, max: 700, measuredWidth: 400 });
    act(() =>
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight', shiftKey: true }),
    );
    expect(onCommit).toHaveBeenCalledWith(464); // 400 + STEP_PX_COARSE(64)
  });

  it('ArrowRight clamps at max rather than overshooting', () => {
    const { onCommit } = renderResizer({ min: 320, max: 700, measuredWidth: 695 });
    act(() => fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' }));
    expect(onCommit).toHaveBeenCalledWith(700);
  });

  it('ArrowLeft clamps at min rather than undershooting', () => {
    const { onCommit } = renderResizer({ min: 320, max: 700, measuredWidth: 325 });
    act(() => fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' }));
    expect(onCommit).toHaveBeenCalledWith(320);
  });

  it('Home jumps straight to min', () => {
    const { onCommit } = renderResizer({ min: 320, max: 700, measuredWidth: 500 });
    act(() => fireEvent.keyDown(screen.getByRole('separator'), { key: 'Home' }));
    expect(onCommit).toHaveBeenCalledWith(320);
  });

  it('End jumps straight to max', () => {
    const { onCommit } = renderResizer({ min: 320, max: 700, measuredWidth: 500 });
    act(() => fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' }));
    expect(onCommit).toHaveBeenCalledWith(700);
  });

  it('Enter resets (commits null)', () => {
    const { onCommit } = renderResizer();
    act(() => fireEvent.keyDown(screen.getByRole('separator'), { key: 'Enter' }));
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('a double-click resets (commits null)', () => {
    const { onCommit } = renderResizer();
    act(() => fireEvent.doubleClick(screen.getByRole('separator')));
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('an unrelated key (e.g. Tab) neither commits nor throws', () => {
    const { onCommit } = renderResizer();
    act(() => fireEvent.keyDown(screen.getByRole('separator'), { key: 'Tab' }));
    expect(onCommit).not.toHaveBeenCalled();
  });
});

// #468: an interrupted drag (pointercancel, or the component unmounting
// mid-drag) must never persist a width — this suite CAN exercise the real
// `handlePointerDown`/`handlePointerMove` path (unlike the a11y-contract
// block above, which drives commits purely through keyboard handlers), once
// `setPointerCapture`/`releasePointerCapture` are stubbed for jsdom.
describe('PanelResizer — #468 interrupted-drag cleanup', () => {
  it('pointercancel reverts the live write and does not commit, even with net movement', async () => {
    const { onCommit, targetEl } = renderResizer({ min: 320, max: 700, measuredWidth: 400 });
    const el = screen.getByRole('separator');
    const { releasePointerCapture } = stubPointerCapture(el);

    act(() => fireEvent.pointerDown(el, { pointerId: 1, clientX: 100, button: 0 }));
    act(() => fireEvent.pointerMove(el, { pointerId: 1, clientX: 150 })); // dx = 50
    await flushOneFrame();
    // Positive control: prove the live write actually landed before the
    // cancel, so the revert assertion below is undoing something real
    // rather than trivially matching an already-empty property.
    expect(targetEl.style.getPropertyValue('--sc-panel-w')).toBe('450px');

    act(() => fireEvent.pointerCancel(el, { pointerId: 1, clientX: 150 }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(targetEl.style.getPropertyValue('--sc-panel-w')).toBe('');
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it('pointercancel with a startCssVar restores that value, not empty', async () => {
    const { onCommit, targetEl } = renderResizer({ min: 320, max: 700, measuredWidth: 400 });
    targetEl.style.setProperty('--sc-panel-w', '500px'); // a prior committed override
    const el = screen.getByRole('separator');
    stubPointerCapture(el);

    act(() => fireEvent.pointerDown(el, { pointerId: 1, clientX: 100, button: 0 }));
    act(() => fireEvent.pointerMove(el, { pointerId: 1, clientX: 130 }));
    await flushOneFrame();
    expect(targetEl.style.getPropertyValue('--sc-panel-w')).toBe('430px');

    act(() => fireEvent.pointerCancel(el, { pointerId: 1, clientX: 130 }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(targetEl.style.getPropertyValue('--sc-panel-w')).toBe('500px');
  });

  it('unmounting mid-drag cancels the pending live write instead of letting it land later', async () => {
    const { onCommit, targetEl, unmount } = renderResizer({
      min: 320,
      max: 700,
      measuredWidth: 400,
    });
    const el = screen.getByRole('separator');
    stubPointerCapture(el);

    act(() => fireEvent.pointerDown(el, { pointerId: 1, clientX: 100, button: 0 }));
    act(() => fireEvent.pointerMove(el, { pointerId: 1, clientX: 200 })); // schedules a rAF write of 600px, not yet flushed
    expect(targetEl.style.getPropertyValue('--sc-panel-w')).toBe(''); // rAF hasn't fired yet

    act(() => unmount());

    // Cleanup reverts synchronously, before any frame is flushed.
    expect(targetEl.style.getPropertyValue('--sc-panel-w')).toBe('');
    // The stronger assertion: the rAF scheduled by the pointermove above
    // must have been CANCELLED, not merely raced — flush a frame and
    // confirm it never lands a stale write on the now-unmounted target.
    await flushOneFrame();
    expect(targetEl.style.getPropertyValue('--sc-panel-w')).toBe('');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
