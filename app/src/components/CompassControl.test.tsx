import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompassControl from './CompassControl';
import { ORIENTATION_STALE_MS } from '../lib/mapOrientation';
import { de } from '../i18n/dict.de';
import type { GpsFix } from '../services/geolocation';

// #155: the WIRING between lib/mapOrientation.ts's state machine and the map
// camera. The transition table itself is pinned in mapOrientation.test.ts;
// what this file proves is that a tap actually reaches the camera, that the
// four painted states end up on `data-orientation` and the aria-label, that
// hand rotation drops to free, and that the held-bearing ring only dims after
// the grace period. jsdom has no MapLibre runtime, so the camera surface is a
// local fake (the BoatMarker.test.tsx approach).

type Handler = (arg: unknown) => void;

function makeCameraMap(initialBearing = 0) {
  const listeners = new Map<string, Set<Handler>>();
  const bucket = (type: string) => {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    return set;
  };
  const state = { bearing: initialBearing };
  return {
    easeTo: vi.fn((options: { bearing?: number; duration?: number }) => {
      // Real easeTo animates and then settles; the fake settles immediately
      // and fires the events the component's own bookkeeping listens for.
      if (typeof options.bearing === 'number') state.bearing = options.bearing;
      bucket('rotate').forEach((fn) => fn({}));
      bucket('moveend').forEach((fn) => fn({}));
    }),
    getBearing: () => state.bearing,
    setBearing: (b: number) => {
      state.bearing = b;
    },
    on: vi.fn((type: string, fn: Handler) => {
      bucket(type).add(fn);
    }),
    off: vi.fn((type: string, fn: Handler) => {
      bucket(type).delete(fn);
    }),
    fire: (type: string, arg: unknown = {}) => {
      [...bucket(type)].forEach((fn) => fn(arg));
    },
  };
}

const hoisted = vi.hoisted(() => ({ map: null as unknown }));
vi.mock('./MapView', () => ({ useMapInstance: () => hoisted.map }));

const UNDER_WAY: GpsFix = { point: { lat: 54.8, lon: 9.9 }, cogDeg: 120, sogKn: 6, accuracyM: 8 };
const AT_REST: GpsFix = { point: { lat: 54.8, lon: 9.9 }, cogDeg: 120, sogKn: 0.2, accuracyM: 8 };

function compass() {
  return screen.getByRole('button');
}

let map: ReturnType<typeof makeCameraMap>;

beforeEach(() => {
  vi.useFakeTimers();
  map = makeCameraMap();
  hoisted.map = map;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CompassControl', () => {
  it('starts north-up and paints the live bearing onto the needle', () => {
    map.setBearing(30);
    render(<CompassControl fix={null} showOwnship={false} />);
    expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    // North stays north: the needle counter-rotates the map bearing.
    expect(document.querySelector('.compass-needle')).toHaveStyle({
      transform: 'rotate(-30deg)',
    });
  });

  it('announces that course-up is unavailable before the user taps', () => {
    render(<CompassControl fix={null} showOwnship={false} />);
    expect(compass()).toHaveAttribute('aria-label', de['map.compass.northUp.noTrack']);
  });

  it('rejects an ineligible tap loudly: no camera move, but a live-region status', () => {
    render(<CompassControl fix={AT_REST} showOwnship />);
    act(() => compass().click());
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    // Never greyed out (a dead control on a chart reads as broken).
    expect(compass()).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent(de['map.compass.unavailableStatus']);
  });

  it('eases to the ownship COG on an eligible tap and back to north on the next', () => {
    render(<CompassControl fix={UNDER_WAY} showOwnship />);

    act(() => compass().click());
    expect(compass()).toHaveAttribute('data-orientation', 'track-up');
    expect(compass()).toHaveAttribute('aria-label', de['map.compass.trackUp']);
    expect(map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ bearing: 120 }));

    act(() => compass().click());
    expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    expect(map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ bearing: 0 }));
  });

  it('holds the last bearing when the fix stops being usable, dimming only after the grace period', () => {
    const { rerender } = render(<CompassControl fix={UNDER_WAY} showOwnship />);
    act(() => compass().click());
    expect(compass()).toHaveAttribute('data-orientation', 'track-up');

    // Boat comes head-to-wind: SOG drops under the floor, so there is no
    // trustworthy course any more. The chart must NOT spin back to north.
    rerender(<CompassControl fix={AT_REST} showOwnship />);
    act(() => vi.advanceTimersByTime(ORIENTATION_STALE_MS - 1));
    expect(compass()).toHaveAttribute('data-orientation', 'track-up');
    expect(map.getBearing()).toBe(120);

    act(() => vi.advanceTimersByTime(1));
    expect(compass()).toHaveAttribute('data-orientation', 'track-up-stale');
    expect(compass()).toHaveAttribute('aria-label', de['map.compass.trackUp.stale']);
    expect(map.getBearing()).toBe(120);

    // She pays off and makes way again: follow resumes, ring undims.
    rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 200 }} showOwnship />);
    expect(compass()).toHaveAttribute('data-orientation', 'track-up');
    expect(map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ bearing: 200 }));
  });

  it('skips a follow ease inside the bearing deadband', () => {
    const { rerender } = render(<CompassControl fix={UNDER_WAY} showOwnship />);
    act(() => compass().click());
    map.easeTo.mockClear();

    // 120 -> 121 is a 1 deg turn: inside the 2 deg deadband, so GPS noise
    // never chains eases.
    rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 121 }} showOwnship />);
    expect(map.easeTo).not.toHaveBeenCalled();

    rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 125 }} showOwnship />);
    expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ bearing: 125 }));
  });

  it('returns to north when the ownship setting is switched off mid-track', () => {
    const { rerender } = render(<CompassControl fix={UNDER_WAY} showOwnship />);
    act(() => compass().click());
    expect(compass()).toHaveAttribute('data-orientation', 'track-up');

    rerender(<CompassControl fix={null} showOwnship={false} />);
    expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    expect(map.getBearing()).toBe(0);
  });

  it('drops to free on a gesture rotation and offers reset-to-north', () => {
    const { rerender } = render(<CompassControl fix={UNDER_WAY} showOwnship />);
    act(() => compass().click());

    act(() => {
      map.setBearing(75);
      map.fire('rotatestart', { originalEvent: new Event('touchstart') });
      map.fire('rotate', {});
    });
    expect(compass()).toHaveAttribute('data-orientation', 'free');
    expect(compass()).toHaveAttribute('aria-label', de['map.compass.free']);

    // Free wins over the follow loop: a new fix must not steal the bearing back.
    map.easeTo.mockClear();
    rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 300 }} showOwnship />);
    expect(map.easeTo).not.toHaveBeenCalled();

    act(() => compass().click());
    expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    expect(map.getBearing()).toBe(0);
  });

  it('drops to free on a keyboard rotation, which carries no originalEvent', () => {
    render(<CompassControl fix={null} showOwnship={false} />);
    act(() => {
      map.setBearing(15);
      map.fire('rotate', {});
    });
    expect(compass()).toHaveAttribute('data-orientation', 'free');
  });

  it('snaps a near-north hand rotation the rest of the way home', () => {
    render(<CompassControl fix={null} showOwnship={false} />);
    act(() => {
      map.setBearing(0.6);
      map.fire('rotatestart', { originalEvent: new Event('touchstart') });
      map.fire('rotateend', {});
    });
    expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    expect(map.getBearing()).toBe(0);
  });

  it('leaves a deliberate rotation alone on rotateend', () => {
    render(<CompassControl fix={null} showOwnship={false} />);
    act(() => {
      map.setBearing(40);
      map.fire('rotatestart', { originalEvent: new Event('touchstart') });
      map.fire('rotateend', {});
    });
    expect(compass()).toHaveAttribute('data-orientation', 'free');
    expect(map.getBearing()).toBe(40);
  });

  it('unregisters its map listeners on unmount', () => {
    const { unmount } = render(<CompassControl fix={null} showOwnship={false} />);
    const registered = map.on.mock.calls.map((c) => c[0]);
    unmount();
    const removed = map.off.mock.calls.map((c) => c[0]);
    expect(new Set(removed)).toEqual(new Set(registered));
  });
});
