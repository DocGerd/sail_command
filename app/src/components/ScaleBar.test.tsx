import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ScaleBar from './ScaleBar';
import { de } from '../i18n/dict.de';

// #155: ScaleBar's measuring/DOM-writing shell. The rung arithmetic itself is
// pinned in lib/mapOrientation.test.ts; this file proves the component feeds
// it a real screen span, keeps the visible bar out of React state, only
// rewrites the live aria-label on moveend, and applies the narrow-layout
// occlusion rule against the Live tab's docked readout.

type Handler = (arg: unknown) => void;

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

beforeEach(() => {
  map = makeFakeMap();
  hoisted.map = map;
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

  it('unregisters its map listeners on unmount', () => {
    const { unmount } = render(<ScaleBar />);
    const registered = map.on.mock.calls.map((c) => c[0]);
    unmount();
    expect(new Set(map.off.mock.calls.map((c) => c[0]))).toEqual(new Set(registered));
  });
});
