import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeLiveSimTick,
  isLiveSimRequested,
  isLiveSimScenario,
  getLiveSimController,
  liveSimScenarioFromSearch,
  liveSimTrackLengthNm,
  subscribeLiveSim,
} from './liveSimulator';
import type { LatLon } from '../types';

afterEach(() => {
  getLiveSimController().pause();
  getLiveSimController().setScenario('track');
  getLiveSimController().setSpeedMultiplier(50);
  getLiveSimController().jumpToFraction(0);
  vi.useRealTimers();
});

describe('#143 activation gate', () => {
  it('is requested only when a liveSim query param is present', () => {
    expect(isLiveSimRequested('')).toBe(false);
    expect(isLiveSimRequested('?other=1')).toBe(false);
    expect(isLiveSimRequested('?liveSim=drift')).toBe(true);
    expect(isLiveSimRequested('?liveSim=')).toBe(true); // bare param still counts
  });

  it('falls back to the track scenario for an absent or unknown value', () => {
    expect(liveSimScenarioFromSearch('')).toBe('track');
    expect(liveSimScenarioFromSearch('?liveSim=bogus')).toBe('track');
    expect(liveSimScenarioFromSearch('?liveSim=stop')).toBe('stop');
  });

  it('isLiveSimScenario rejects a value outside the known set', () => {
    expect(isLiveSimScenario('drift')).toBe(true);
    expect(isLiveSimScenario('warp-speed')).toBe(false);
    expect(isLiveSimScenario(null)).toBe(false);
  });
});

describe('computeLiveSimTick', () => {
  const base = { scenario: 'track' as const, speedMultiplier: 1, tick: 0, startDistNm: 0 };

  it('emits a fix with no error at tick 0 on the track scenario', () => {
    const result = computeLiveSimTick(base);
    expect(result.errorKind).toBeNull();
    expect(result.fix).not.toBeNull();
    expect(result.fix?.sogKn).toBeGreaterThan(0);
  });

  it('is a pure function of its inputs: same params, same output', () => {
    const a = computeLiveSimTick({ ...base, tick: 12 });
    const b = computeLiveSimTick({ ...base, tick: 12 });
    expect(a).toEqual(b);
  });

  it('advances position with tick — later ticks travel further along the track', () => {
    const early = computeLiveSimTick({ ...base, tick: 1 });
    const later = computeLiveSimTick({ ...base, tick: 50 });
    expect(early.fix).not.toBeNull();
    expect(later.fix).not.toBeNull();
    // Different tick indices must not collapse to the identical point —
    // otherwise the simulator would render a stationary "moving" boat.
    expect(later.fix?.point).not.toEqual(early.fix?.point);
  });

  it("scenario 'stop' pins position and reports sogKn 0 with a null cogDeg (mirrors a real stationary device fix, see geolocation.ts)", () => {
    const t0 = computeLiveSimTick({ ...base, scenario: 'stop', tick: 0 });
    const t50 = computeLiveSimTick({ ...base, scenario: 'stop', tick: 50 });
    expect(t0.fix?.sogKn).toBe(0);
    expect(t0.fix?.cogDeg).toBeNull();
    expect(t50.fix?.point).toEqual(t0.fix?.point);
  });

  it("scenario 'degraded-accuracy' reports a materially worse accuracyM than the default scenarios", () => {
    const track = computeLiveSimTick({ ...base, tick: 5 });
    const degraded = computeLiveSimTick({ ...base, scenario: 'degraded-accuracy', tick: 5 });
    expect(degraded.fix?.accuracyM).toBeGreaterThan(track.fix!.accuracyM);
  });

  it("scenario 'drift' pulls the fix progressively away from the on-track point as tick grows", () => {
    const onTrack = computeLiveSimTick({ ...base, tick: 20 });
    const drifting = computeLiveSimTick({ ...base, scenario: 'drift', tick: 20 });
    expect(drifting.fix).not.toBeNull();
    expect(drifting.fix?.point).not.toEqual(onTrack.fix?.point);
    // Drift must be MONOTONE non-decreasing early on (capped later) —
    // tick 40 is off track further than tick 5.
    const early = computeLiveSimTick({ ...base, scenario: 'drift', tick: 5 }).fix!.point;
    const late = computeLiveSimTick({ ...base, scenario: 'drift', tick: 40 }).fix!.point;
    const trackAtEarly = computeLiveSimTick({ ...base, tick: 5 }).fix!.point;
    const trackAtLate = computeLiveSimTick({ ...base, tick: 40 }).fix!.point;
    const distEarly = Math.hypot(early.lat - trackAtEarly.lat, early.lon - trackAtEarly.lon);
    const distLate = Math.hypot(late.lat - trackAtLate.lat, late.lon - trackAtLate.lon);
    expect(distLate).toBeGreaterThan(distEarly);
  });

  it("scenario 'dropout' periodically reports an error instead of a fix", () => {
    const results = Array.from({ length: 12 }, (_, tick) =>
      computeLiveSimTick({ ...base, scenario: 'dropout', tick }),
    );
    const errored = results.filter((r) => r.errorKind !== null);
    const fixed = results.filter((r) => r.fix !== null);
    expect(errored.length).toBeGreaterThan(0);
    expect(fixed.length).toBeGreaterThan(0);
    // Contract: exactly one of fix/errorKind is non-null per tick.
    for (const r of results) {
      expect(r.fix === null).toBe(r.errorKind !== null);
    }
  });

  it('the track loops: a distance one full lap ahead reproduces the same point', () => {
    const lengthNm = liveSimTrackLengthNm();
    const start = computeLiveSimTick({ ...base, speedMultiplier: 0, tick: 0, startDistNm: 0 });
    const oneLapLater = computeLiveSimTick({
      ...base,
      speedMultiplier: 0,
      tick: 0,
      startDistNm: lengthNm,
    });
    expect(oneLapLater.fix?.point.lat).toBeCloseTo(start.fix!.point.lat, 6);
    expect(oneLapLater.fix?.point.lon).toBeCloseTo(start.fix!.point.lon, 6);
  });
});

// #1486 review: LiveView's heading-to-steer/depth-caution math is computed
// against the ACTIVE PLAN's `legs`, so a 'track' scenario following a route
// unrelated to that plan produces false cautions (a real "bearing crosses
// charted land" was observed against the old synthetic-loop-only behaviour).
// Minimum perpendicular ("cross-track") distance from a point to the nearest
// segment of a polyline, in degrees — a flat approximation, fine at the
// sub-nm scale these fixes ever move; only used to assert "on the line".
function crossTrackDeg(point: { lat: number; lon: number }, route: readonly LatLon[]): number {
  let best = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const dx = b.lon - a.lon;
    const dy = b.lat - a.lat;
    const lenSq = dx * dx + dy * dy;
    const t =
      lenSq > 0
        ? Math.max(0, Math.min(1, ((point.lon - a.lon) * dx + (point.lat - a.lat) * dy) / lenSq))
        : 0;
    const px = a.lon + t * dx;
    const py = a.lat + t * dy;
    const dist = Math.hypot(point.lon - px, point.lat - py);
    if (dist < best) best = dist;
  }
  return best;
}

describe('#1486 review: track scenario follows the active plan route', () => {
  const planRoute: LatLon[] = [
    { lat: 54.79, lon: 9.43 }, // Flensburg
    { lat: 54.83, lon: 9.7 }, // out toward the fjord mouth
    { lat: 54.87, lon: 9.95 }, // Sønderborg direction — far from the synthetic loop
  ];

  it('fixes lie on the plan polyline (cross-track ~0) at several ticks', () => {
    for (const tick of [0, 5, 20, 60, 150]) {
      const result = computeLiveSimTick({
        scenario: 'track',
        speedMultiplier: 1,
        tick,
        startDistNm: 0,
        routePoints: planRoute,
      });
      expect(result.fix).not.toBeNull();
      expect(crossTrackDeg(result.fix!.point, planRoute)).toBeLessThan(1e-6);
    }
  });

  it('mutation check: WITHOUT routePoints the fixes follow the synthetic loop instead and drift off the plan route', () => {
    const result = computeLiveSimTick({
      scenario: 'track',
      // A larger multiplier than the "on route" test above so the fix has
      // travelled well past both routes' shared starting point (Flensburg)
      // by this tick — otherwise the two routes' early points sit too close
      // together to discriminate the mutation.
      speedMultiplier: 100,
      tick: 60,
      startDistNm: 0,
      routePoints: null, // the pre-#1486 behaviour
    });
    expect(result.fix).not.toBeNull();
    // The synthetic Flensburg-Fjord loop and this plan route diverge by more
    // than a trivial rounding distance — this is the exact assertion the
    // route-following test above would fail if the routePoints wiring were
    // reverted (mutation-checked: deleting `routePoints` from the object
    // above reproduces this same "off the line" reading in THAT test).
    expect(crossTrackDeg(result.fix!.point, planRoute)).toBeGreaterThan(0.01);
  });
});

describe('LiveSimController / subscribeLiveSim (the watchPosition-shaped adapter)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('emits an initial fix synchronously on subscribe, before any timer tick', () => {
    const onFix = vi.fn();
    const onError = vi.fn();
    const unsubscribe = subscribeLiveSim(onFix, onError);
    expect(onFix).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('shares ONE ticking clock across two independent subscribers (both GPS seams driven from one source)', () => {
    getLiveSimController().setScenario('track');
    const fixesA: number[] = [];
    const fixesB: number[] = [];
    const unsubA = subscribeLiveSim((f) => fixesA.push(f.point.lat), vi.fn());
    const unsubB = subscribeLiveSim((f) => fixesB.push(f.point.lat), vi.fn());
    // subscribe() broadcasts an immediate emit to ALL current listeners, so
    // A's own subscribe call and B's subsequent one both land in fixesA —
    // discard those two synchronous emits and compare only the shared
    // ticks that follow, which is the property under test.
    fixesA.length = 0;
    fixesB.length = 0;

    vi.advanceTimersByTime(3000);

    expect(fixesA.length).toBe(fixesB.length);
    expect(fixesA).toEqual(fixesB); // identical fix stream, not two independent tickers
    unsubA();
    unsubB();
  });

  it('stops the timer once the last subscriber unsubscribes (mutation-checked: with the guard removed the timer keeps firing forever)', () => {
    const unsubscribe = subscribeLiveSim(vi.fn(), vi.fn());
    unsubscribe();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    vi.advanceTimersByTime(10_000);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('pause() stops advancing; play() resumes from where it left off', () => {
    const fixes: number[] = [];
    const unsubscribe = subscribeLiveSim((f) => fixes.push(f.point.lat), vi.fn());
    vi.advanceTimersByTime(2000);
    const countBeforePause = fixes.length;
    getLiveSimController().pause();
    vi.advanceTimersByTime(5000);
    expect(fixes.length).toBe(countBeforePause); // frozen while paused
    getLiveSimController().play();
    vi.advanceTimersByTime(1000);
    expect(fixes.length).toBeGreaterThan(countBeforePause);
    unsubscribe();
  });

  it('jumpToFraction() repositions immediately, without waiting for a tick', () => {
    const fixes: Array<{ lat: number; lon: number }> = [];
    const unsubscribe = subscribeLiveSim((f) => fixes.push(f.point), vi.fn());
    getLiveSimController().jumpToFraction(0.5);
    const afterJump = fixes.at(-1);
    getLiveSimController().jumpToFraction(0);
    const afterReset = fixes.at(-1);
    expect(afterJump).not.toEqual(afterReset);
    unsubscribe();
  });

  it('setScenario() resets the clock (tick 0) rather than continuing the old scenario mid-flight', () => {
    const fixes: number[] = [];
    const unsubscribe = subscribeLiveSim((f) => fixes.push(f.point.lat), vi.fn());
    vi.advanceTimersByTime(5000);
    getLiveSimController().setScenario('stop');
    const stoppedAt = fixes.at(-1);
    vi.advanceTimersByTime(5000);
    expect(fixes.at(-1)).toBe(stoppedAt); // stop scenario never moves
    unsubscribe();
  });

  it('subscribeState reports the current state immediately and on every change', () => {
    const states: string[] = [];
    const unsubscribe = getLiveSimController().subscribeState((s) => states.push(s.scenario));
    getLiveSimController().setScenario('drift');
    getLiveSimController().setScenario('track');
    expect(states).toEqual(['track', 'drift', 'track']);
    unsubscribe();
  });
});
