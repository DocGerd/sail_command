import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompassControl from './CompassControl';
import { ORIENTATION_STALE_MS } from '../lib/mapOrientation';
import { makeFakeCameraMap } from '../test/fakeMaplibre';
import { de } from '../i18n/dict.de';
import type { GpsFix } from '../services/geolocation';

// #155: the WIRING between lib/mapOrientation.ts's state machine and the map
// camera. The transition table itself is pinned in mapOrientation.test.ts;
// what this file proves is that a tap actually reaches the camera, that the
// four painted states end up on `data-orientation` and the aria-label, that
// hand rotation drops to free, and that the held-bearing ring only dims after
// the grace period. jsdom has no MapLibre runtime, so the camera surface is
// the shared fake in src/test/fakeMaplibre.ts, which models MapLibre 5.24's
// interruption semantics line-referenced against maplibre-gl-dev.js.
//
// #203 added the interruption matrix below: a compass ease is not the only
// thing that can move or stop this camera, and every OTHER source — a gesture
// abort, pan inertia, arrow-key panning, RouteLayer's plan-change fitBounds —
// used to be able to desync the painted orientation from the chart.

const hoisted = vi.hoisted(() => ({ map: null as unknown }));
vi.mock('./MapView', () => ({ useMapInstance: () => hoisted.map }));

const UNDER_WAY: GpsFix = { point: { lat: 54.8, lon: 9.9 }, cogDeg: 120, sogKn: 6, accuracyM: 8 };
const AT_REST: GpsFix = { point: { lat: 54.8, lon: 9.9 }, cogDeg: 120, sogKn: 0.2, accuracyM: 8 };

/** RouteLayer.tsx's own fitBounds argument shape (every new `plan.id`). */
const PLAN_BOUNDS: [[number, number], [number, number]] = [
  [9.4, 54.3],
  [11.0, 55.3],
];
const fitBoundsLikeRouteLayer = (map: ReturnType<typeof makeFakeCameraMap>) =>
  map.fitBounds(PLAN_BOUNDS, { padding: 48, duration: 0, bearing: map.getBearing() });

function compass() {
  return screen.getByRole('button');
}

let map: ReturnType<typeof makeFakeCameraMap>;

beforeEach(() => {
  vi.useFakeTimers();
  map = makeFakeCameraMap();
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
    act(() => map.finishEase());
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
    act(() => map.finishEase());
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
    act(() => map.finishEase());
    expect(compass()).toHaveAttribute('data-orientation', 'track-up');

    rerender(<CompassControl fix={null} showOwnship={false} />);
    act(() => map.finishEase());
    expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    expect(map.getBearing()).toBe(0);
  });

  it('drops to free on a gesture rotation and offers reset-to-north', () => {
    const { rerender } = render(<CompassControl fix={UNDER_WAY} showOwnship />);
    act(() => compass().click());

    // The gesture's first frame stops the follow ease (`map._stop(true)`) and
    // then turns the chart itself.
    act(() => {
      map.stopForGesture();
      map.gestureRotateTo(75);
    });
    expect(compass()).toHaveAttribute('data-orientation', 'free');
    expect(compass()).toHaveAttribute('aria-label', de['map.compass.free']);

    // Free wins over the follow loop: a new fix must not steal the bearing back.
    map.easeTo.mockClear();
    rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 300 }} showOwnship />);
    expect(map.easeTo).not.toHaveBeenCalled();

    act(() => compass().click());
    act(() => map.finishEase());
    expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    expect(map.getBearing()).toBe(0);
  });

  it('snaps a near-north hand rotation the rest of the way home', () => {
    render(<CompassControl fix={null} showOwnship={false} />);
    const originalEvent = new Event('touchend');
    act(() => {
      map.gestureRotateTo(0.6);
      map.fire('rotateend', { originalEvent });
    });
    expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    act(() => map.finishEase());
    expect(map.getBearing()).toBe(0);
  });

  it('leaves a deliberate rotation alone on rotateend', () => {
    render(<CompassControl fix={null} showOwnship={false} />);
    act(() => {
      map.gestureRotateTo(40);
      map.fire('rotateend', { originalEvent: new Event('touchend') });
    });
    expect(compass()).toHaveAttribute('data-orientation', 'free');
    expect(map.getBearing()).toBe(40);
  });

  // An ease that interrupts another compass ease must not be mistaken for the
  // user grabbing the chart. MapLibre runs the interrupted ease's moveend
  // synchronously from inside the next easeTo (see makeFakeCameraMap), so
  // without a shared easeId the guard is already down when the new ease emits
  // its first rotate frame. Both paths below are reachable in ordinary use.
  describe('interrupted eases (the easeId guard)', () => {
    it('keeps following the course when fixes arrive faster than the ease lasts', () => {
      const { rerender } = render(<CompassControl fix={UNDER_WAY} showOwnship />);
      act(() => compass().click());
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');
      expect(map.isEasing()).toBe(true);

      // useOwnshipGps applies no throttle, so the fix cadence is the browser's
      // — two fixes inside EASE_TRACK_MS (900 ms) is normal, not exotic.
      rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 150 }} showOwnship />);
      rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 180 }} showOwnship />);

      expect(compass()).toHaveAttribute('data-orientation', 'track-up');
      expect(compass()).toHaveAttribute('aria-label', de['map.compass.trackUp']);
      act(() => map.finishEase());
      expect(map.getBearing()).toBe(180);
    });

    it('never reports a hand rotation the user did not make (fast double tap)', () => {
      render(<CompassControl fix={UNDER_WAY} showOwnship />);
      // Start in free, at a bearing nowhere near north so the rotateend snap
      // cannot accidentally rescue the mode.
      act(() => map.gestureRotateTo(75));
      expect(compass()).toHaveAttribute('data-orientation', 'free');

      // free -> north (600 ms ease), then a second tap inside that window. The
      // chart is still at 75 deg when the second tap lands, so the tap must be
      // judged against the bearing the compass is ASSERTING (its outstanding
      // target, 0) — otherwise the reset-north guard added in #203 would read
      // the mid-ease camera as "not north-up" and re-assert north instead of
      // advancing to track-up.
      act(() => compass().click());
      act(() => compass().click());

      expect(compass()).toHaveAttribute('data-orientation', 'track-up');
      act(() => map.finishEase());
      expect(map.getBearing()).toBe(120);
    });

    it('re-arms the hand-rotation guard once an ease finishes on its own', () => {
      render(<CompassControl fix={UNDER_WAY} showOwnship />);
      act(() => compass().click());
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');

      act(() => map.finishEase());
      act(() => map.gestureRotateTo(40));
      expect(compass()).toHaveAttribute('data-orientation', 'free');
    });
  });

  // ------------------------------------------------------------------ #203
  //
  // F1: a reset-north ease that never reaches north. Nothing re-asserted the
  // target and nothing questioned the mode, so the button kept claiming
  // north-up over a rotated chart — and, with no GPS, `nextOrientation(north,
  // false)` answered `reject`, making the control a permanent no-op. The
  // camera, not a flag, now decides whether the claim survives a settle.
  describe('#203 F1: an aborted reset-north ease', () => {
    it('falls to free rather than claiming an orientation the chart does not have', () => {
      // No GPS at all: showOwnship off, fix null -> trackAvailable === false,
      // which is what made `reject` an absorbing state.
      render(<CompassControl fix={null} showOwnship={false} />);

      act(() => map.gestureRotateTo(75));
      expect(compass()).toHaveAttribute('data-orientation', 'free');

      act(() => compass().click());
      expect(compass()).toHaveAttribute('data-orientation', 'north-up');
      expect(map.isEasing()).toBe(true);

      // The user grabs the chart 200 ms in. HandlerManager calls
      // `map._stop(true)` with no easeId, so the ease dies where it got to and
      // `_afterEase` fires rotateend + moveend.
      act(() => {
        map.setBearing(40);
        map.stopForGesture();
      });

      expect(map.getBearing()).toBe(40);
      expect(compass()).toHaveAttribute('data-orientation', 'free');
      expect(compass()).toHaveAttribute('aria-label', de['map.compass.free']);
    });

    it('reaches north on the next tap instead of rejecting it', () => {
      render(<CompassControl fix={null} showOwnship={false} />);
      act(() => map.gestureRotateTo(75));
      act(() => compass().click());
      act(() => {
        map.setBearing(40);
        map.stopForGesture();
      });

      map.easeTo.mockClear();
      act(() => compass().click());
      expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ bearing: 0 }));
      act(() => map.finishEase());
      expect(map.getBearing()).toBe(0);
      expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    });

    it('falls to free when a plan-change fitBounds pins the half-turned chart', () => {
      // #201 made RouteLayer preserve the bearing across fitBounds, which is
      // right for track-up but removed the accidental repair the old
      // `bearing || 0` default gave this state. recalc / replanWithVias /
      // rerouteFromFix all land here.
      render(<CompassControl fix={null} showOwnship={false} />);
      act(() => map.gestureRotateTo(75));
      act(() => compass().click());

      act(() => {
        map.setBearing(40);
        fitBoundsLikeRouteLayer(map);
      });

      expect(map.getBearing()).toBe(40);
      expect(compass()).toHaveAttribute('data-orientation', 'free');
    });

    it('never answers a tap with nothing while north-up sits on a turned chart', () => {
      // Belt and braces for the same invariant one layer lower: even if no
      // settle ever reconciles the mode (a bearing change that reached us
      // through no event at all), the tap itself is judged against the camera,
      // so `reject` can never be the answer while the chart is not north-up.
      render(<CompassControl fix={null} showOwnship={false} />);
      expect(compass()).toHaveAttribute('data-orientation', 'north-up');

      act(() => map.setBearing(40));
      act(() => compass().click());

      expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ bearing: 0 }));
      expect(screen.getByRole('status')).toHaveTextContent('');
      act(() => map.finishEase());
      expect(map.getBearing()).toBe(0);
      expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    });
  });

  // F2: a FOREIGN ease in flight when one of ours starts. MapLibre suppresses
  // the interrupted ease's moveend only when the easeIds MATCH, so an ease we
  // do not own always delivers its settle from inside our own easeTo — which
  // is why no amount of easeId discipline could fix this direction.
  describe('#203 F2: a foreign ease interrupted by ours', () => {
    const enterTrackUp = () => {
      const view = render(<CompassControl fix={UNDER_WAY} showOwnship />);
      act(() => compass().click());
      act(() => map.finishEase());
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');
      expect(map.getBearing()).toBe(120);
      return view;
    };

    it('survives pan inertia: a flick-pan does not end course-following', () => {
      const { rerender } = enterTrackUp();

      // maplibre-gl-dev.js:68712 — the inertial ease carries the flick's
      // originalEvent but NO easeId, and a pan does not rotate, so it emits no
      // rotate frames of its own.
      act(() => map.easeTo({ duration: 300 }, { originalEvent: new Event('touchend') }));
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');

      // A GPS fix lands inside the inertia window and clears the deadband.
      act(() => rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 150 }} showOwnship />));

      expect(map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ bearing: 150 }));
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');
      expect(compass()).toHaveAttribute('aria-label', de['map.compass.trackUp']);
    });

    it('survives arrow-key panning, which eases under a foreign easeId', () => {
      const { rerender } = enterTrackUp();

      // KeyboardHandler (:67341) eases with `easeId: 'keyboardHandler'`. An
      // arrow key without shift PANS — same handler, same easeId, no bearing
      // change — so the user has not rotated anything.
      act(() =>
        map.easeTo(
          { duration: 300, easeId: 'keyboardHandler' },
          { originalEvent: new KeyboardEvent('keydown', { key: 'ArrowUp' }) },
        ),
      );
      act(() => rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 150 }} showOwnship />));

      expect(map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ bearing: 150 }));
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');
    });

    it('survives a plan-change fitBounds landing mid-follow', () => {
      const { rerender } = enterTrackUp();
      act(() => rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 150 }} showOwnship />));
      expect(map.isEasing()).toBe(true);

      // The Live tab reroutes from a fix while the follow ease is running.
      act(() => fitBoundsLikeRouteLayer(map));

      // Track-up holds: the follow loop owns the correction, and the next fix
      // re-eases from wherever fitBounds left the chart.
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');
      act(() => rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 180 }} showOwnship />));
      expect(map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ bearing: 180 }));
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');
    });

    it('does not read the settle of the ease it just replaced as its own', () => {
      // The north-mode half of the same mechanism: the foreign settle arrives
      // from INSIDE our easeTo, describing the camera we are replacing (75
      // deg), so reconciling the fresh north claim against it would demote the
      // control to free while it is correctly easing home.
      render(<CompassControl fix={null} showOwnship={false} />);
      act(() => map.gestureRotateTo(75));
      act(() => map.easeTo({ duration: 300 }, { originalEvent: new Event('touchend') }));

      act(() => compass().click());
      expect(compass()).toHaveAttribute('data-orientation', 'north-up');

      act(() => map.finishEase());
      expect(map.getBearing()).toBe(0);
      expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    });

    it('does not demote on a handler settle fired while its own ease still runs', () => {
      // HandlerManager fires a bare `moveend` at the end of a gesture
      // (:68716). When the gesture ended near north, our rotateend snap has
      // already started an ease toward 0 by then, so the camera is legitimately
      // mid-flight and the claim must not be judged yet.
      render(<CompassControl fix={null} showOwnship={false} />);
      const originalEvent = new Event('touchend');
      act(() => {
        map.gestureRotateTo(0.6);
        map.fire('rotateend', { originalEvent });
        map.fire('moveend', { originalEvent });
      });

      expect(map.isEasing()).toBe(true);
      expect(compass()).toHaveAttribute('data-orientation', 'north-up');
      act(() => map.finishEase());
      expect(map.getBearing()).toBe(0);
      expect(compass()).toHaveAttribute('data-orientation', 'north-up');
    });
  });

  // The other direction of the same guard, and the one a false-positive fix is
  // most likely to break: a real rotation gesture must still hand the bearing
  // to the user.
  describe('#203: a real rotation gesture still exits track-up', () => {
    it('exits on a two-finger rotation, and the next fix does not steal it back', () => {
      const { rerender } = render(<CompassControl fix={UNDER_WAY} showOwnship />);
      act(() => compass().click());
      act(() => map.finishEase());
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');

      act(() => {
        map.stopForGesture();
        map.gestureRotateTo(75);
      });
      expect(compass()).toHaveAttribute('data-orientation', 'free');

      map.easeTo.mockClear();
      rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 300 }} showOwnship />);
      expect(map.easeTo).not.toHaveBeenCalled();
      expect(map.getBearing()).toBe(75);
    });

    it('exits on keyboard ROTATION, which eases with the key event attached', () => {
      render(<CompassControl fix={UNDER_WAY} showOwnship />);
      act(() => compass().click());
      act(() => map.finishEase());

      // Shift+arrow rotates: same `keyboardHandler` easeId as the pan above,
      // but this one changes the bearing and is unambiguously user intent.
      act(() =>
        map.easeTo(
          { bearing: 135, duration: 300, easeId: 'keyboardHandler' },
          { originalEvent: new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true }) },
        ),
      );
      expect(compass()).toHaveAttribute('data-orientation', 'free');
    });

    it('exits on a rotate frame alone when rotatestart was suppressed', () => {
      // `_prepareEase` fires rotatestart only when no rotation was already in
      // progress (:69537), so a keyboard rotate ease chained onto another one
      // under the SAME easeId emits rotate frames with no rotatestart at all.
      // The per-frame check is what catches those.
      render(<CompassControl fix={UNDER_WAY} showOwnship />);
      act(() => compass().click());
      act(() => map.finishEase());

      act(() => {
        map.setBearing(150);
        map.fire('rotate', { originalEvent: new KeyboardEvent('keydown', { key: 'ArrowLeft' }) });
      });
      expect(compass()).toHaveAttribute('data-orientation', 'free');
    });

    it('does not exit on a programmatic rotation nobody asked for', () => {
      // The negative twin: an ease with no eventData is not a user gesture, so
      // it must not steal track-up. The follow loop corrects the chart on the
      // next fix.
      const { rerender } = render(<CompassControl fix={UNDER_WAY} showOwnship />);
      act(() => compass().click());
      act(() => map.finishEase());

      act(() => map.easeTo({ bearing: 40, duration: 300 }));
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');

      act(() => rerender(<CompassControl fix={{ ...UNDER_WAY, cogDeg: 150 }} showOwnship />));
      expect(map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ bearing: 150 }));
      expect(compass()).toHaveAttribute('data-orientation', 'track-up');
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
      // A duration-0 ease settles inside the easeTo call, so the camera is
      // already there and nothing is left in flight to reconcile.
      expect(map.getBearing()).toBe(120);
      expect(map.isEasing()).toBe(false);
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
