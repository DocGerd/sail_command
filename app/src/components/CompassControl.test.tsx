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

interface EaseOptions {
  bearing?: number;
  duration?: number;
  easeId?: string;
}

/**
 * Camera fake that models MapLibre 5.24's INTERRUPTION semantics, which is
 * where the interesting bug lived. Verified against
 * `node_modules/maplibre-gl/dist/maplibre-gl-dev.js`:
 *
 *   easeTo(options)  -> `this._stop(false, options.easeId)` FIRST (:69468)
 *   _stop(_, easeId) -> runs the pending `_onEaseEnd(easeId)` synchronously (:69901)
 *   _afterEase(d,id) -> returns early ONLY when `this._easeId && id &&
 *                       this._easeId === id` (:69671); otherwise it fires
 *                       rotateend AND moveend
 *   ...then `this._easeId = options.easeId` and the new ease starts (:69512)
 *
 * So an ease that interrupts another fires the OLD ease's moveend from inside
 * the new easeTo call — before the new ease emits a frame — unless both carry
 * the same easeId. An ease that finishes naturally calls `_onEaseEnd` with no
 * id, so moveend always fires there.
 *
 * The bearing is applied immediately (the camera's *target* is what the tests
 * assert), but the ease stays IN FLIGHT until `finishEase()` or the next
 * `easeTo` — without that, no ease is ever interruptible and the whole class
 * of bug is invisible, which is exactly how the first version of this file
 * missed it.
 */
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
  const fire = (type: string, arg: unknown = {}) => {
    [...bucket(type)].forEach((fn) => fn(arg));
  };
  const state = { bearing: initialBearing };
  let pending: { easeId: string | undefined } | null = null;

  const endPending = (interruptingEaseId: string | undefined) => {
    if (!pending) return;
    const suppressed =
      pending.easeId !== undefined &&
      interruptingEaseId !== undefined &&
      pending.easeId === interruptingEaseId;
    pending = null;
    if (!suppressed) {
      fire('rotateend');
      fire('moveend');
    }
  };

  return {
    easeTo: vi.fn((options: EaseOptions) => {
      endPending(options.easeId); // _stop(false, options.easeId)
      if (typeof options.bearing === 'number') state.bearing = options.bearing;
      pending = { easeId: options.easeId };
      fire('rotate'); // the new ease's first frame
      if (options.duration === 0) endPending(undefined); // duration 0 settles at once
    }),
    /** Let an in-flight ease run to natural completion (no interrupting id). */
    finishEase: () => endPending(undefined),
    easeInFlight: () => pending !== null,
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
    fire,
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

  // An ease that interrupts another compass ease must not be mistaken for the
  // user grabbing the chart. MapLibre runs the interrupted ease's moveend
  // synchronously from inside the next easeTo (see makeCameraMap), so without
  // a shared easeId the guard is already down when the new ease emits its
  // first rotate frame — and the controller demotes its OWN animation to
  // `free`. Both paths below are reachable in ordinary use.
  describe('interrupted eases (the easeId guard)', () => {
    it('keeps following the course when fixes arrive faster than the ease lasts', () => {
      const { rerender } = render(<CompassControl fix={UNDER_WAY} showOwnship />);
      act(() => compass().click());
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');
      expect(map.easeInFlight()).toBe(true);

      // useOwnshipGps applies no throttle, so the fix cadence is the browser's
      // — two fixes inside EASE_TRACK_MS (900 ms) is normal, not exotic.
      rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 150 }} showOwnship />);
      rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 180 }} showOwnship />);

      expect(compass()).toHaveAttribute('data-orientation', 'track-up');
      expect(compass()).toHaveAttribute('aria-label', de['map.compass.trackUp']);
      expect(map.getBearing()).toBe(180);
    });

    it('never reports a hand rotation the user did not make (fast double tap)', () => {
      render(<CompassControl fix={UNDER_WAY} showOwnship />);
      // Start in free, at a bearing nowhere near north so the rotateend snap
      // cannot accidentally rescue the mode.
      act(() => {
        map.setBearing(75);
        map.fire('rotatestart', { originalEvent: new Event('touchstart') });
        map.fire('rotate', {});
      });
      expect(compass()).toHaveAttribute('data-orientation', 'free');

      // free -> north (600 ms ease), then a second tap inside that window.
      act(() => compass().click());
      act(() => compass().click());

      expect(compass()).toHaveAttribute('data-orientation', 'track-up');
      expect(map.getBearing()).toBe(120);
    });

    it('re-arms the hand-rotation guard once an ease finishes on its own', () => {
      // The easeId fix must not leave the guard stuck ON: a natural completion
      // passes no interrupting id, so moveend still fires and the next rotate
      // is correctly read as the user's.
      render(<CompassControl fix={UNDER_WAY} showOwnship />);
      act(() => compass().click());
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');

      act(() => map.finishEase());
      act(() => {
        map.setBearing(40);
        map.fire('rotate', {});
      });
      expect(compass()).toHaveAttribute('data-orientation', 'free');
    });
  });

  // The JS half of the reduced-motion contract (the pulse half is CSS-only).
  // jsdom has no matchMedia and src/test/setup.ts does not stub it, so
  // usePrefersReducedMotion is hard-wired to "motion allowed" unless a test
  // supplies one — which is why this branch shipped unverified at first.
  describe('prefers-reduced-motion', () => {
    beforeEach(() => {
      window.matchMedia = vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })) as unknown as typeof window.matchMedia;
    });
    afterEach(() => {
      Reflect.deleteProperty(window, 'matchMedia');
    });

    it('eases instantly instead of animating the camera', () => {
      render(<CompassControl fix={UNDER_WAY} showOwnship />);
      act(() => compass().click());
      expect(map.easeTo).toHaveBeenLastCalledWith(
        expect.objectContaining({ bearing: 120, duration: 0 }),
      );
    });

    it('widens the follow deadband so the chart moves less often', () => {
      const { rerender } = render(<CompassControl fix={UNDER_WAY} showOwnship />);
      act(() => compass().click());
      map.easeTo.mockClear();

      // 120 -> 123 is 3 deg: past the normal 2 deg deadband, inside the 5 deg
      // reduced-motion one, so it must NOT move the chart.
      rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 123 }} showOwnship />);
      expect(map.easeTo).not.toHaveBeenCalled();

      // 6 deg clears even the widened deadband.
      rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 126 }} showOwnship />);
      expect(map.easeTo).toHaveBeenCalledWith(
        expect.objectContaining({ bearing: 126, duration: 0 }),
      );
    });
  });

  it('unregisters its map listeners on unmount', () => {
    const { unmount } = render(<CompassControl fix={null} showOwnship={false} />);
    const registered = map.on.mock.calls.map((c) => c[0]);
    unmount();
    const removed = map.off.mock.calls.map((c) => c[0]);
    expect(new Set(removed)).toEqual(new Set(registered));
  });
});
