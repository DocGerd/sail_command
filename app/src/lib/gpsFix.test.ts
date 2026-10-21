import { describe, expect, it } from 'vitest';
import {
  GPS_LOST_AFTER_MS,
  GPS_STALE_AFTER_MS,
  REROUTE_MAX_ACCURACY_M,
  acceptFix,
  emptyTrack,
  fixAgeS,
  gpsState,
  markDenied,
  rerouteGate,
  type TimedFix,
} from './gpsFix';

const fix = (timestampMs: number, accuracyM = 8): TimedFix => ({ accuracyM, timestampMs });

describe('gpsState', () => {
  it('walks waiting -> fresh -> stale (10 s) -> lost (30 s) -> fresh on a new fix', () => {
    let track = emptyTrack<TimedFix>();
    expect(gpsState(track, 0)).toBe('waiting');

    track = acceptFix(track, fix(1000), 5_000, 0);
    expect(gpsState(track, 5_000)).toBe('fresh');
    expect(gpsState(track, 5_000 + GPS_STALE_AFTER_MS - 1)).toBe('fresh');
    expect(gpsState(track, 5_000 + GPS_STALE_AFTER_MS)).toBe('stale');
    expect(gpsState(track, 5_000 + GPS_LOST_AFTER_MS - 1)).toBe('stale');
    expect(gpsState(track, 5_000 + GPS_LOST_AFTER_MS)).toBe('lost');

    track = acceptFix(track, fix(2000), 60_000, 0);
    expect(gpsState(track, 60_000)).toBe('fresh');
  });

  it('a constant device-clock offset cannot pin a healthy stream at stale or lost', () => {
    for (const offsetMs of [60_000, -60_000]) {
      let track = emptyTrack<TimedFix>();
      for (let i = 0; i < 100; i++) {
        const mono = 1_000 * i;
        track = acceptFix(track, fix(1_700_000_000_000 + offsetMs + mono), mono, 0);
        expect(gpsState(track, mono + 900)).toBe('fresh');
      }
    }
  });

  it('a re-delivered fix with an unchanged device timestamp does not refresh the age', () => {
    const first = acceptFix(emptyTrack<TimedFix>(), fix(1000), 0, 0);
    const again = acceptFix(first, fix(1000), 12_000, 0);
    expect(again).toBe(first);
    expect(gpsState(again, 12_000)).toBe('stale');
    const older = acceptFix(first, fix(900), 12_000, 0);
    expect(gpsState(older, 12_000)).toBe('stale');
  });

  it('a fix without a device timestamp always counts as new', () => {
    const a = acceptFix(emptyTrack<TimedFix>(), { accuracyM: 5 }, 0, 0);
    const b = acceptFix(a, { accuracyM: 5 }, 20_000, 0);
    expect(gpsState(b, 20_000)).toBe('fresh');
  });

  it('denied wins over age and clears on the next new fix', () => {
    let track = acceptFix(emptyTrack<TimedFix>(), fix(1000), 0, 0);
    track = markDenied(track);
    expect(gpsState(track, 0)).toBe('denied');
    expect(gpsState(track, 60_000)).toBe('denied');
    track = acceptFix(track, fix(2000), 61_000, 0);
    expect(gpsState(track, 61_000)).toBe('fresh');
  });
});

describe('fixAgeS', () => {
  it('floors age to whole seconds and is null before the first fix', () => {
    const track = acceptFix(emptyTrack<TimedFix>(), fix(1), 1_000, 0);
    expect(fixAgeS(emptyTrack<TimedFix>(), 5_000)).toBeNull();
    expect(fixAgeS(track, 12_999)).toBe(11);
  });
});

describe('rerouteGate', () => {
  it('allows a fresh fix with good accuracy', () => {
    expect(rerouteGate('fresh', fix(1, 8), 1)).toMatchObject({ allowed: true, reason: null });
  });

  it('stale with good accuracy is still allowed', () => {
    expect(rerouteGate('stale', fix(1, 8), 15).allowed).toBe(true);
  });

  it.each(['waiting', 'denied', 'lost'] as const)('blocks while %s', (state) => {
    const g = rerouteGate(state, state === 'waiting' ? null : fix(1, 8), null);
    expect(g).toMatchObject({ allowed: false, reason: state });
  });

  it('blocks above the accuracy threshold and reports accuracy and threshold', () => {
    const g = rerouteGate('fresh', fix(1, REROUTE_MAX_ACCURACY_M + 0.5), 2);
    expect(g).toMatchObject({
      allowed: false,
      reason: 'accuracy',
      accuracyM: REROUTE_MAX_ACCURACY_M + 0.5,
      thresholdM: REROUTE_MAX_ACCURACY_M,
    });
    expect(rerouteGate('fresh', fix(1, REROUTE_MAX_ACCURACY_M), 2).allowed).toBe(true);
  });
});
