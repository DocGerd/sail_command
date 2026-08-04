import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScaleBar from './ScaleBar';
import { de } from '../i18n/dict.de';

// #155: ScaleBar's measuring/DOM-writing shell. The rung arithmetic itself is
// pinned in lib/mapOrientation.test.ts; this file proves the component feeds
// it a real screen span, keeps the visible bar out of React state, only
// rewrites the live aria-label on moveend, and applies the narrow-layout
// occlusion rule against the Live tab's docked readout AND (#208) against
// `.app-bottom-sheet` itself.

type Handler = (arg: unknown) => void;

// jsdom has no real ResizeObserver (CLAUDE.md: "any unit test will need a
// stub") — this fake is deliberately inert until a test explicitly calls
// `fire()` on one of its instances, so installing it globally in every
// test's `beforeEach` cannot silently change any OTHER test's behaviour:
// `liveRo`/`sheetRo`/`barRo` (ScaleBar's own observers) and
// `useBannerHeight`'s own observer all get real instances instead of being
// skipped, but none of them ever CALLS BACK unless a test asks for it.
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

/** Finds the FakeResizeObserver instance watching a specific element. */
function roFor(el: Element): FakeResizeObserver {
  const found = FakeResizeObserver.instances.find((o) => o.observed === el);
  if (!found) throw new Error('no ResizeObserver instance is observing this element');
  return found;
}

// Degrees of longitude per screen pixel, chosen so the bar's 100 px reference
// spans ~3 NM. At 54.85 N one NM is 1 / (60 * cos 54.85) = 0.028950 deg of
// longitude, so 3 NM across 100 px is 0.0008685 deg/px. The largest 1-2-5
// rung at or below a 3 NM span is 2 NM, and the bar is therefore 2/3 of the
// 100 px reference — both hand-derived, neither read off the component.
const DEG_PER_PX = 0.0008685;

function makeFakeMap() {
  const listeners = new Map<string, Set<Handler>>();
  const bucket = (type: string) => {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    return set;
  };
  const state = { degPerPx: DEG_PER_PX };
  return {
    setDegPerPx: (v: number) => {
      state.degPerPx = v;
    },
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }) as HTMLCanvasElement,
    unproject: (p: [number, number]) => ({
      lng: 9.9 + (p[0] - 400) * state.degPerPx,
      lat: 54.85,
    }),
    on: vi.fn((type: string, fn: Handler) => {
      bucket(type).add(fn);
    }),
    off: vi.fn((type: string, fn: Handler) => {
      bucket(type).delete(fn);
    }),
    fire: (type: string) => {
      [...bucket(type)].forEach((fn) => fn({}));
    },
  };
}

const hoisted = vi.hoisted(() => ({ map: null as unknown }));
vi.mock('./MapView', () => ({ useMapInstance: () => hoisted.map }));

let map: ReturnType<typeof makeFakeMap>;
let bannerArea: HTMLElement;

beforeEach(() => {
  map = makeFakeMap();
  hoisted.map = map;
  // #368 fix-wave, round 4: `.banner-area` is present UNCONDITIONALLY in the
  // real app (App.tsx renders it with no gating condition), so ScaleBar's
  // `.banner-area` MutationObserver is created on every real mount too — a
  // test suite where only 2 of ~18 cases stub it exercises a `ScaleBar` with
  // NO such observer for the other ~16, a configuration production never
  // has, and prints ScaleBar.tsx's own `console.warn` (added for exactly
  // this null case) on every one of them. Stubbing it here, once, for every
  // test removes both problems at the source instead of patching the
  // symptom.
  bannerArea = stubBannerArea();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  FakeResizeObserver.instances = [];
});

function bar() {
  return screen.getByRole('img');
}

// jsdom lays nothing out, so both sides of the lift arithmetic are stubbed:
// the map wrapper is 667 px tall (a phone viewport) and the docked card
// reports where its top edge sits inside it.
const HOST_H = 667;

function stubHost(container: HTMLElement) {
  Object.defineProperty(container, 'offsetHeight', { value: HOST_H, configurable: true });
}

/** A stand-in for LiveView's narrow-layout docked readout. */
function occluder(className: string, topPx: number) {
  const el = document.createElement('div');
  el.className = className;
  Object.defineProperty(el, 'offsetTop', { value: topPx, configurable: true });
  return el;
}

// #208: `.app-bottom-sheet` is a SIBLING of the map in the real app (App.tsx),
// not a descendant of the ScaleBar host the way the Live occluders above are
// — ScaleBar finds it via `document.querySelector`, so the stand-in is
// appended to `document.body` rather than into the rendered container, and
// its offsetHeight (not offsetTop — it is flush against the shared bottom
// edge, see the component's own comment) stands in for its rendered size.
function stubSheet(heightPx: number) {
  const el = document.createElement('div');
  el.className = 'app-bottom-sheet';
  Object.defineProperty(el, 'offsetHeight', { value: heightPx, configurable: true });
  document.body.appendChild(el);
  return el;
}

/** A stand-in for the top-left compass/toggle stack, `.map-stack-tl`. */
function stubMapStack(container: HTMLElement, topPx: number, heightPx: number) {
  const el = document.createElement('div');
  el.className = 'map-stack-tl';
  Object.defineProperty(el, 'offsetTop', { value: topPx, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: heightPx, configurable: true });
  container.appendChild(el);
  return el;
}

// #368 fix-wave: `.banner-area`, like `.app-bottom-sheet`, is a SIBLING of
// the map in the real app (App.tsx) — not a descendant of the ScaleBar host
// — so it is found via `document.querySelector` and stood in for via
// `document.body`, same shape as `stubSheet` above. Starts empty (no
// `.banner` children), matching the real `.banner-area`'s own always-
// mounted-but-often-childless shape.
function stubBannerArea() {
  const el = document.createElement('div');
  el.className = 'banner-area';
  document.body.appendChild(el);
  return el;
}

function setWideLayout(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  // `window.matchMedia` is undefined by default in this jsdom setup (see
  // lib/useWideLayout.ts's own comment) — every test not explicitly opting
  // into the wide layout relies on that absence to stay on the narrow
  // branch, so a wide-layout test must not leak its mock into the next one.
  // @ts-expect-error -- deliberately restoring the untouched jsdom default
  delete window.matchMedia;
  document.querySelectorAll('.app-bottom-sheet').forEach((el) => el.remove());
  document.querySelectorAll('.banner-area').forEach((el) => el.remove());
  document.documentElement.style.removeProperty('--sc-banner-height');
  vi.unstubAllGlobals();
});

describe('ScaleBar', () => {
  it('measures a real screen span and writes the bar straight to the DOM', () => {
    render(<ScaleBar />);
    // 100 px spans ~3 NM here, so the rung is 2 NM (the ladder is 1-2-5) and
    // the drawn bar is 2/3 of the reference: ~66.6 px.
    expect(bar().querySelector('.scale-bar-label')).toHaveTextContent(
      `2 ${de['map.scale.unit.nm']}`,
    );
    const width = Number.parseFloat(
      (bar().querySelector('.scale-bar-bracket') as HTMLElement).style.width,
    );
    expect(width).toBeGreaterThan(66);
    expect(width).toBeLessThan(67);
  });

  it('exposes the labelled distance with the unit spelled out for screen readers', () => {
    render(<ScaleBar />);
    expect(bar()).toHaveAttribute('aria-label', `Maßstab: 2 ${de['map.scale.unit.nm.other']}`);
  });

  it('rewrites the aria-label only once the map settles, never per move frame', async () => {
    render(<ScaleBar />);
    // Zoom in by 1000x to land in the metre branch. The base span is 3.0021 NM
    // across the 100 px reference, so this is 0.0030021 NM = 5.560 m, and the
    // largest 1-2-5 rung at or below that is 5 m. (Pinned exactly, not as
    // /\d+ Meter/: a loose matcher here accepted any integer and let an
    // earlier, 10x-wrong derivation comment sit next to a passing assertion.)
    act(() => {
      map.setDegPerPx(DEG_PER_PX / 1000);
      map.fire('move');
    });
    // The visible label is written straight to the DOM under rAF, so the frame
    // has to be flushed — which also pins that the throttle actually paints.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(bar().querySelector('.scale-bar-label')).toHaveTextContent(
      `5 ${de['map.scale.unit.m']}`,
    );
    // The live region, meanwhile, must NOT churn while the user is still
    // dragging — it still reads the pre-move value.
    expect(bar()).toHaveAttribute('aria-label', `Maßstab: 2 ${de['map.scale.unit.nm.other']}`);

    act(() => map.fire('moveend'));
    expect(bar()).toHaveAttribute('aria-label', `Maßstab: 5 ${de['map.scale.unit.m.other']}`);
  });

  it('leaves its stylesheet offset alone when nothing is docked over the corner', () => {
    render(<ScaleBar />);
    expect(bar().style.bottom).toBe('');
    expect(bar().className).not.toContain('scale-bar-suppressed');
  });

  it('lifts clear of the Live tab readout docked in the same corner', async () => {
    const { container } = render(<ScaleBar />);
    stubHost(container);
    // The docked readout is discovered through a MutationObserver, whose
    // callback is a microtask — hence the async act.
    await act(async () => {
      // Card top edge 480 px down a 667 px map: 187 px of it is below the top
      // edge, so the bar must sit 187 + 8 px of breathing space up from the
      // map's bottom. Lifting by the card's HEIGHT instead would leave it
      // overlapping (the bug the browser pass caught).
      container.insertBefore(occluder('live-view', 480), container.firstChild);
    });
    expect(bar().style.bottom).toBe('195px');
    expect(bar().className).not.toContain('scale-bar-suppressed');
  });

  it('lifts clear of the no-plan card too, which docks at a different offset', async () => {
    const { container } = render(<ScaleBar />);
    stubHost(container);
    await act(async () => {
      container.insertBefore(occluder('live-view-no-plan', 539), container.firstChild);
    });
    // 667 - 539 = 128, plus the 8 px gap.
    expect(bar().style.bottom).toBe('136px');
  });

  it('suppresses itself rather than floating into the middle of the chart', async () => {
    const { container } = render(<ScaleBar />);
    stubHost(container);
    await act(async () => {
      // A readout filling the bottom 55% of the map: the lift would be 367 px,
      // past jsdom's 768 px viewport x 0.4 = 307.2 px ceiling.
      container.insertBefore(occluder('live-view', HOST_H - 367), container.firstChild);
    });
    expect(bar().className).toContain('scale-bar-suppressed');
  });

  it('comes back when the readout goes away', async () => {
    const { container } = render(<ScaleBar />);
    stubHost(container);
    const docked = occluder('live-view', HOST_H - 367);
    await act(async () => {
      container.insertBefore(docked, container.firstChild);
    });
    expect(bar().className).toContain('scale-bar-suppressed');
    await act(async () => {
      docked.remove();
    });
    expect(bar().className).not.toContain('scale-bar-suppressed');
    expect(bar().style.bottom).toBe('');
  });

  it('lifts clear of .app-bottom-sheet on tabs with no docked Live readout (#208 NEW-1)', () => {
    // Plan/Routes never dock a Live readout, so before the fix `liftPx`
    // stayed null here and the bar sat at the stylesheet's tab-strip-only
    // offset — buried under the sheet's own (taller, real-content) height.
    // The sheet must already be in the document at mount: unlike the Live
    // occluders, ScaleBar finds it once via `document.querySelector`, not
    // through the MutationObserver that watches its own host.
    const sheet = stubSheet(200);
    render(<ScaleBar />);
    expect(bar().style.bottom).toBe('208px'); // 200 + the 8 px gap
    expect(bar().className).not.toContain('scale-bar-suppressed');
    sheet.remove();
  });

  it('picks whichever of the sheet or a docked Live readout currently reaches further', async () => {
    const sheet = stubSheet(200);
    const { container } = render(<ScaleBar />);
    stubHost(container);
    await act(async () => {
      // liveLift = 667 - 620 = 47, well under the sheet's 200 — the sheet
      // must win, not silently overwrite what the Live-readout rule found.
      container.insertBefore(occluder('live-view', 620), container.firstChild);
    });
    expect(bar().style.bottom).toBe('208px');
    sheet.remove();
  });

  it('suppresses rather than overlap .map-stack-tl when no position clears both it and the occluder (#208 NEW-3)', async () => {
    const { container } = render(<ScaleBar />);
    stubHost(container);
    // A tall toggle/compass column: bottom edge at 56 + 400 = 456 px down the
    // 667 px host.
    stubMapStack(container, 56, 400);
    Object.defineProperty(bar(), 'offsetHeight', { value: 40, configurable: true });
    await act(async () => {
      // liveLift = 667 - 467 = 200, under the OLD Live-readout heuristic's
      // threshold (window.innerHeight * 0.4 = 307.2 in jsdom's 768 px
      // default) — this suppression can only be coming from the geometric
      // check. floor = 200 + 8 = 208; ceiling = 667 (host) - 40 (bar) - 456
      // (stack bottom) - 8 (gap) = 163. floor > ceiling: clamping to 163
      // would draw the bar's bottom edge only 163 px up, well short of what
      // clearing the occluder needs (208) — i.e. still under it. There is no
      // single position that clears both, so this must suppress instead of
      // quietly clamping into a position that still buries the bar (the
      // #208 NEW-1 regression a naive clamp-only fix would reintroduce).
      container.insertBefore(occluder('live-view', 467), container.firstChild);
    });
    expect(bar().className).toContain('scale-bar-suppressed');
  });

  it('does NOT suppress a large sheet-driven lift that still clears .map-stack-tl with room to spare', async () => {
    // Regression guard for the design flaw a live-browser check caught: an
    // earlier version of this fix reused the Live-readout heuristic
    // (window.innerHeight * 0.4) for the sheet too, which suppressed the bar
    // even at ordinary portrait sizes with plenty of headroom (measured live
    // at 375x667: ~79 px clear between .map-stack-tl and a 55vh-capped
    // sheet). The geometric ceiling below is what actually governs it.
    const sheet = stubSheet(400);
    const { container } = render(<ScaleBar />);
    stubHost(container);
    Object.defineProperty(bar(), 'offsetHeight', { value: 30, configurable: true });
    await act(async () => {
      // Realistic ~165 px toggle/compass column (mirrors the real 375x667
      // measurement): bottom edge 56 + 165 = 221, leaving room even against
      // a tall 400 px sheet lift.
      stubMapStack(container, 56, 165);
    });
    // ceiling = 667 (host) - 30 (bar) - 221 (stack bottom) - 8 (gap) = 408,
    // exactly meeting floor = 400 + 8 = 408.
    expect(bar().style.bottom).toBe('408px');
    expect(bar().className).not.toContain('scale-bar-suppressed');
    sheet.remove();
  });

  it('caches the last known-good bar height, so a zeroed (display:none/unpainted) reading cannot widen the ceiling (#208 review "Major 1")', async () => {
    // Reproduces the exact review-measured symptom: a naive LIVE
    // `rootRef.current.offsetHeight` read is ~18px before the label first
    // paints and exactly 0 once `.scale-bar-suppressed` (display:none) has
    // ever applied — both inflate the ceiling and can un-suppress (or
    // overlap .map-stack-tl by a few px) a position that should stay
    // suppressed. This pins that a later, ZEROED reading can never override
    // an earlier, real one.
    const sheet = stubSheet(412); // floor = 412 + 8 = 420
    const { container } = render(<ScaleBar />);
    stubHost(container);
    // The bar's real rendered height (label painted, bracket drawn).
    Object.defineProperty(bar(), 'offsetHeight', { value: 30, configurable: true });
    await act(async () => {
      // A realistic ~165 px toggle/compass column, mirrors the other #208
      // NEW-3 tests: bottom edge 56 + 165 = 221.
      stubMapStack(container, 56, 165);
    });
    // Sanity check with the CORRECT height: ceiling = 667 - 30 - 221 - 8 =
    // 408 < floor (420) -> no position clears both, so this must suppress.
    expect(bar().className).toContain('scale-bar-suppressed');

    // Now simulate the bar's box having gone display:none (post-suppression)
    // — a naive live read would see 0 here.
    Object.defineProperty(bar(), 'offsetHeight', { value: 0, configurable: true });
    await act(async () => {
      // Re-trigger apply() via an unrelated mutation (liveLift stays 0 here
      // — HOST_H - HOST_H — so only the cached-vs-live bar height differs
      // between this call and the one above).
      container.insertBefore(occluder('live-view', HOST_H), container.firstChild);
    });
    // Must STAY suppressed: with the buggy live-0 reading, ceiling would
    // widen to 667 - 0 - 221 - 8 = 438 >= floor (420), un-suppressing at
    // bottom=420px — whose top edge (667 - 420 - 30 = 217) overlaps
    // .map-stack-tl's bottom (221) by 4px, the exact review-reported number.
    expect(bar().className).toContain('scale-bar-suppressed');
    sheet.remove();
  });

  it('recovers the correct (non-zero) bar height once it repaints, and does not stay stuck on the first reading', async () => {
    // Companion to the hysteresis test above: once a genuinely fresh,
    // positive reading arrives, it must become the new cached value (this is
    // what lets the bar ever correct an initial too-small reading, e.g. the
    // ~18px pre-label-paint case) — the cache must not get stuck at a stale
    // value forever either.
    //
    // `floor` is pinned CONSTANT at 412 throughout via a fixed sheet lift
    // (404 + the 8px gap) so `barHeight` is the ONLY thing that changes
    // between the two measurements — re-triggered by a "poke" live-view
    // occluder whose OWN liveLift is 0 (topPx = HOST_H), which does two
    // things deliberately: it re-invokes `apply()` (jsdom has no
    // ResizeObserver, so this childList mutation is the only re-trigger
    // available), and it stays far under the UNRELATED liveLift-based
    // suppression heuristic (`window.innerHeight * 0.4` = 307.2 in jsdom's
    // 768px default) — an earlier version of this test picked a poke offset
    // whose liveLift (404) tripped that heuristic on its own, which made the
    // assertion pass FOR THE WRONG REASON regardless of whether barHeight
    // caching worked at all.
    const sheet = stubSheet(404);
    const { container } = render(<ScaleBar />);
    stubHost(container);
    Object.defineProperty(bar(), 'offsetHeight', { value: 18, configurable: true }); // pre-label-paint size
    await act(async () => {
      stubMapStack(container, 56, 165); // bottom = 221; this mutation is what first triggers apply().
    });
    // ceiling@18 = 667 - 18 - 221 - 8 = 420 >= floor (412) -> visible.
    expect(bar().className).not.toContain('scale-bar-suppressed');
    expect(bar().style.bottom).toBe('412px');

    // The label paints; the bar's real height arrives. Poke to re-trigger.
    Object.defineProperty(bar(), 'offsetHeight', { value: 30, configurable: true });
    await act(async () => {
      container.insertBefore(occluder('live-view', HOST_H), container.firstChild);
    });
    // With the cache correctly updated to 30 (not stuck at 18): ceiling@30 =
    // 667 - 30 - 221 - 8 = 408 < floor (412) -> suppressed. A stuck-at-18
    // cache would wrongly stay visible (412 <= 420).
    expect(bar().className).toContain('scale-bar-suppressed');
    sheet.remove();
  });

  it('never overrides the wide stylesheet rule, even with a tall .app-bottom-sheet present', () => {
    // On wide, .app-bottom-sheet is a static grid column beside the map, not
    // an overlay — measuring it would be wrong, and an inline `bottom` would
    // beat the wide stylesheet rule (`bottom: 0.75rem`) by specificity
    // regardless. `matches: true` mirrors app.css's own
    // `@media (min-width: 1024px)` breakpoint (lib/useWideLayout.ts).
    setWideLayout(true);
    const sheet = stubSheet(400);
    render(<ScaleBar />);
    expect(bar().style.bottom).toBe('');
    sheet.remove();
  });

  it('re-measures when .banner-area resizes after the initial measurement (#368)', async () => {
    // Reproduces the exact bug found while investigating #368's push: nothing
    // watched `.map-stack-tl` itself (it can now reposition at runtime, via
    // app.css's banner-clearance rule reading `--sc-banner-height`), so a
    // banner mounting AFTER the first measurement left `apply()`'s ceiling
    // calculation stale — measured live, the bar rendered fully overlapping
    // `.map-stack-tl`'s new position instead of suppressing. `useBannerHeight`
    // (via its own ResizeObserver on `.banner-area`, the FakeResizeObserver
    // installed in `beforeEach`) is what re-triggers this component's main
    // effect now; `bannerArea` comes from the shared `beforeEach` stub.
    const sheet = stubSheet(400); // floor = 400 + 8 = 408
    const { container } = render(<ScaleBar />);
    stubHost(container);
    Object.defineProperty(bar(), 'offsetHeight', { value: 30, configurable: true });
    // Initial, comfortably-visible geometry — bottom edge 56 + 165 = 221,
    // mirrors the "does NOT suppress... with room to spare" test above. This
    // insertion (into `container`/`host`) is what triggers the FIRST apply().
    const stack = await act(async () => {
      return stubMapStack(container, 56, 165);
    });
    // ceiling = 667 (host) - 30 (bar) - 221 (stack bottom) - 8 (gap) = 408,
    // exactly meeting floor (408) — same arithmetic as the sibling test.
    expect(bar().className).not.toContain('scale-bar-suppressed');
    expect(bar().style.bottom).toBe('408px');

    // Simulate app.css's banner-clearance rule pushing `.map-stack-tl` down
    // (the real 375x667, two-banner measured values: top 152px, height
    // 140px -> bottom 292px) WITHOUT triggering anything — a plain property
    // redefinition, not a DOM mutation/resize either observer could see. This
    // is the moment the real bug goes stale: nothing has re-read the new
    // geometry yet, mirroring exactly what CSS alone does.
    Object.defineProperty(stack, 'offsetTop', { value: 152, configurable: true });
    Object.defineProperty(stack, 'offsetHeight', { value: 140, configurable: true });
    expect(bar().className).not.toContain('scale-bar-suppressed'); // still stale

    // NOW fire the .banner-area ResizeObserver — the ONLY trigger in this
    // test after the geometry change above, standing in for a real banner
    // mounting (or a banner wrapping to a second line, which a childList
    // MutationObserver could never have seen in the first place).
    await act(async () => {
      roFor(bannerArea).fire(98);
    });
    // ceiling = 667 - 30 - 292 (new stack bottom) - 8 = 337 < floor (408) ->
    // must suppress. Failing here (staying visible) means the banner-height
    // observer did not re-trigger `apply()`.
    expect(bar().className).toContain('scale-bar-suppressed');
    sheet.remove();
  });

  it('unregisters its map listeners on unmount', () => {
    const { unmount } = render(<ScaleBar />);
    const registered = map.on.mock.calls.map((c) => c[0]);
    unmount();
    expect(new Set(map.off.mock.calls.map((c) => c[0]))).toEqual(new Set(registered));
  });

  it('disconnects the .banner-area (useBannerHeight) observer on unmount too, not just the map listeners', () => {
    // #368: the sibling test above only proves the map's own on/off pairing
    // unregisters — it says nothing about `useBannerHeight`'s own
    // ResizeObserver on `.banner-area`, which has no map listener at all and
    // would leak silently. Isolating the SPECIFIC instance that observed
    // `.banner-area` (via `roFor`, the same technique the fake exposes for
    // the re-measure test above) is the same fix the sibling `on`/`off` SET
    // comparison already applies to the map listeners — a bare "disconnect
    // was called N times" count cannot tell ScaleBar's OWN `liveRo`/`sheetRo`/
    // `barRo` instances apart from `useBannerHeight`'s.
    const { unmount } = render(<ScaleBar />);
    const observer = roFor(bannerArea);

    unmount();

    expect(observer.disconnected).toBe(true);
  });
});
