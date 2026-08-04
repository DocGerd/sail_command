import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBannerHeight, BANNER_HEIGHT_UNMEASURABLE_FALLBACK_PX } from './useBannerHeight';

const APP_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../app.css');

// jsdom has no real ResizeObserver (CLAUDE.md: "any unit test will need a
// stub") — this fake is deliberately minimal: it records the callback and
// the observed element, and only ever fires when a test explicitly calls
// `fire()`. It never auto-fires on its own, so stubbing it globally cannot
// silently change any OTHER test's behaviour anywhere in the suite.
type RoEntry = { contentRect: { height: number } };
type RoCallback = (entries: RoEntry[]) => void;

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element | null = null;
  disconnected = false;
  private readonly callback: RoCallback;
  constructor(callback: RoCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed = el;
  }
  unobserve() {
    this.observed = null;
  }
  disconnect() {
    this.disconnected = true;
  }
  fire(height: number) {
    this.callback([{ contentRect: { height } }]);
  }
}

function stubBannerArea(initialHeight = 0) {
  const el = document.createElement('div');
  el.className = 'banner-area';
  el.getBoundingClientRect = () =>
    ({
      height: initialHeight,
      width: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: initialHeight,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.querySelectorAll('.banner-area').forEach((el) => el.remove());
  document.documentElement.style.removeProperty('--sc-banner-height');
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
});

describe('useBannerHeight', () => {
  it('returns the generous fallback constant when ResizeObserver is unavailable (the real jsdom default)', () => {
    // No stub installed — this is the SAME environment every other unit
    // test in this suite runs under.
    stubBannerArea(48);
    const { result } = renderHook(() => useBannerHeight());
    expect(result.current).toBe(BANNER_HEIGHT_UNMEASURABLE_FALLBACK_PX);
  });

  it('never touches the DOM in the unmeasurable case (no --sc-banner-height write)', () => {
    stubBannerArea(48);
    renderHook(() => useBannerHeight());
    expect(document.documentElement.style.getPropertyValue('--sc-banner-height')).toBe('');
  });

  it('measures the real .banner-area height once ResizeObserver is available, and writes --sc-banner-height', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    stubBannerArea(48);
    const { result } = renderHook(() => useBannerHeight());
    // Synchronous initial measurement — no act()-wrapped resize needed for
    // the first read, since the hook measures once immediately rather than
    // waiting on the (real-world async) first ResizeObserver callback.
    expect(result.current).toBe(48);
    expect(document.documentElement.style.getPropertyValue('--sc-banner-height')).toBe('48px');
  });

  it('re-measures on a real resize (banner mount/unmount, or a wrapped 2-line banner growing taller)', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    stubBannerArea(48);
    const { result } = renderHook(() => useBannerHeight());
    const observer = FakeResizeObserver.instances[0];
    expect(observer, 'ResizeObserver was never constructed').toBeDefined();

    act(() => {
      observer!.fire(98); // a second banner mounted alongside the first
    });
    expect(result.current).toBe(98);
    expect(document.documentElement.style.getPropertyValue('--sc-banner-height')).toBe('98px');
  });

  it('collapses to a real 0 once every banner is dismissed — 0 is a legitimate measurement, distinct from the unmeasurable-environment fallback', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    stubBannerArea(48);
    const { result } = renderHook(() => useBannerHeight());
    const observer = FakeResizeObserver.instances[0]!;

    act(() => {
      observer.fire(0);
    });
    expect(result.current).toBe(0);
    expect(document.documentElement.style.getPropertyValue('--sc-banner-height')).toBe('0px');
  });

  it('disconnects the observer on unmount', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    stubBannerArea();
    const { unmount } = renderHook(() => useBannerHeight());
    const observer = FakeResizeObserver.instances[0]!;
    unmount();
    expect(observer.disconnected).toBe(true);
  });

  it('does nothing when .banner-area is absent from the DOM (defensive — App.tsx renders it unconditionally today)', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // Deliberately no stubBannerArea() call.
    const { result } = renderHook(() => useBannerHeight());
    // canObserve is true, so the initial state is 0 (not the unmeasurable
    // fallback) — the element is simply missing, a separate case.
    expect(result.current).toBe(0);
    expect(FakeResizeObserver.instances).toHaveLength(0);
  });

  // PR #382 review, MAJOR fix-wave: a real, checkable structural property —
  // NOT a claim about timing/first-paint behaviour, which no test in this
  // suite can observe (a Playwright assertion polls post-settle, so it
  // would pass whether or not a pre-paint race exists; see this PR's own
  // report for why that test was deliberately NOT written). What CAN be
  // checked is that the two independent copies of this fallback number stay
  // in sync: app.css's `var(--sc-banner-height, <N>px)` can't import this
  // JS constant (a CSS `var()` fallback takes a literal), so nothing else
  // keeps them equal. `useBannerHeight.ts`'s own CSS_VAR comment explains
  // why BOTH matter — `useLayoutEffect` closes the pre-paint timing window,
  // this sync is what protects the layout if the custom property is never
  // written at all for some other reason (the hook not mounted, an error
  // thrown before the write, a future refactor).
  it('matches the CSS var(...) fallback app.css uses for the same unmeasurable-environment case', () => {
    const css = readFileSync(APP_CSS_PATH, 'utf8');
    const match = css.match(/var\(--sc-banner-height,\s*(\d+)px\)/);
    expect(
      match,
      'app.css no longer has a var(--sc-banner-height, <N>px) fallback to check against',
    ).not.toBeNull();
    expect(Number(match![1])).toBe(BANNER_HEIGHT_UNMEASURABLE_FALLBACK_PX);
  });
});
