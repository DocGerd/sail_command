import { describe, expect, it } from 'vitest';
import { makeMask, openWaterMask } from '../test/fixtures';
import type { Leg } from '../types';
import {
  indicatorTimes,
  legPositionAt,
  profileSamples,
  sampleCount,
  tickIntervalMs,
  tickTimes,
} from './routeProfile';

const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);
const HOUR = 3_600_000;

function sailLeg(
  startMs: number,
  endMs: number,
  start: Leg['start'],
  end: Leg['end'],
  headingDeg = 90,
): Leg {
  return {
    kind: 'sail',
    board: 'starboard',
    start,
    end,
    startTimeMs: startMs,
    endTimeMs: endMs,
    headingDeg,
    twaDeg: 90,
    twsKn: 10,
    speedKn: 6,
    distanceNm: 5,
    maneuverAtStart: null,
  };
}

function motorLeg(
  startMs: number,
  endMs: number,
  start: Leg['start'],
  end: Leg['end'],
  headingDeg = 90,
): Leg {
  return {
    kind: 'motor',
    board: null,
    start,
    end,
    startTimeMs: startMs,
    endTimeMs: endMs,
    headingDeg,
    twsKn: 2,
    speedKn: 6.5,
    distanceNm: 5,
    maneuverAtStart: null,
  };
}

describe('sampleCount', () => {
  it('is one sample per 5 min, clamped to [60, 240]', () => {
    expect(sampleCount(0)).toBe(60); // below floor
    expect(sampleCount(30 * 60_000)).toBe(60); // 6 -> floor
    expect(sampleCount(5 * HOUR)).toBe(60); // exactly 60
    expect(sampleCount(10 * HOUR)).toBe(120);
    expect(sampleCount(100 * HOUR)).toBe(240); // above ceiling
  });
});

describe('legPositionAt', () => {
  it('interpolates linearly along the active leg', () => {
    const legs = [sailLeg(T0, T0 + HOUR, { lat: 54.5, lon: 10.0 }, { lat: 54.5, lon: 10.2 })];
    expect(legPositionAt(legs, T0 + HOUR / 2)?.pos).toEqual({ lat: 54.5, lon: 10.1 });
    expect(legPositionAt(legs, T0)?.pos.lon).toBeCloseTo(10.0, 6);
    expect(legPositionAt(legs, T0 + HOUR)?.pos.lon).toBeCloseTo(10.2, 6);
  });

  it('picks the leg active at the time and carries heading/motor/index', () => {
    const legs = [
      sailLeg(T0, T0 + HOUR, { lat: 54.5, lon: 10.0 }, { lat: 54.5, lon: 10.1 }, 80),
      motorLeg(T0 + HOUR, T0 + 2 * HOUR, { lat: 54.5, lon: 10.1 }, { lat: 54.5, lon: 10.2 }, 100),
    ];
    const a = legPositionAt(legs, T0 + HOUR / 2)!;
    expect(a).toMatchObject({ legIndex: 0, headingDeg: 80, motor: false });
    const b = legPositionAt(legs, T0 + 1.5 * HOUR)!;
    expect(b).toMatchObject({ legIndex: 1, headingDeg: 100, motor: true });
  });

  it('clamps times outside the route to the first/last leg endpoints; null for no legs', () => {
    const legs = [sailLeg(T0, T0 + HOUR, { lat: 54.5, lon: 10.0 }, { lat: 54.5, lon: 10.2 })];
    expect(legPositionAt(legs, T0 - HOUR)?.pos.lon).toBeCloseTo(10.0, 6);
    expect(legPositionAt(legs, T0 + 5 * HOUR)?.pos.lon).toBeCloseTo(10.2, 6);
    expect(legPositionAt([], T0)).toBeNull();
  });
});

describe('profileSamples', () => {
  const leg = sailLeg(T0, T0 + HOUR, { lat: 54.5, lon: 10.0 }, { lat: 54.5, lon: 10.2 });

  it('takes no safety depth (absolute depth only — asserted by arity)', () => {
    // (legs, mask, n) — safetyDepthM must never be a parameter.
    expect(profileSamples.length).toBe(3);
  });

  it('emits n samples that interpolate along the active leg', () => {
    const samples = profileSamples([leg], openWaterMask(), 3);
    expect(samples).toHaveLength(3);
    expect(samples.map((s) => s.pos.lon)).toEqual([10.0, 10.1, 10.2]);
    expect(samples.map((s) => s.tMs)).toEqual([T0, T0 + HOUR / 2, T0 + HOUR]);
    expect(samples.every((s) => s.depthM === 20 && !s.capped && !s.motor)).toBe(true);
    expect(samples.every((s) => s.headingDeg === 90 && s.legIndex === 0)).toBe(true);
  });

  it('flags capped samples over the deep-cap sentinel (byte 255)', () => {
    const samples = profileSamples(
      [leg],
      makeMask(() => 255),
      4,
    );
    expect(samples.every((s) => s.capped && s.depthM === 25.4)).toBe(true);
  });

  it('identifies motor time spans from the active leg', () => {
    const legs = [
      sailLeg(T0, T0 + HOUR, { lat: 54.5, lon: 10.0 }, { lat: 54.5, lon: 10.1 }),
      motorLeg(T0 + HOUR, T0 + 2 * HOUR, { lat: 54.5, lon: 10.1 }, { lat: 54.5, lon: 10.2 }),
    ];
    const samples = profileSamples(legs, openWaterMask(), 60);
    expect(samples.some((s) => s.motor)).toBe(true);
    expect(samples.some((s) => !s.motor)).toBe(true);
    // Every motor sample belongs to the motor leg (index 1).
    expect(samples.filter((s) => s.motor).every((s) => s.legIndex === 1)).toBe(true);
  });

  it('returns [] for an empty route', () => {
    expect(profileSamples([], openWaterMask(), 60)).toEqual([]);
  });
});

describe('tickIntervalMs', () => {
  it('adapts: <=4 h -> 30 min, <=12 h -> 1 h, else 2 h', () => {
    expect(tickIntervalMs(3 * HOUR)).toBe(30 * 60_000);
    expect(tickIntervalMs(4 * HOUR)).toBe(30 * 60_000);
    expect(tickIntervalMs(5 * HOUR)).toBe(HOUR);
    expect(tickIntervalMs(12 * HOUR)).toBe(HOUR);
    expect(tickIntervalMs(13 * HOUR)).toBe(2 * HOUR);
  });
});

describe('tickTimes', () => {
  it('emits clock-aligned ticks within [start, end] at the adaptive interval', () => {
    const start = Date.UTC(2026, 6, 15, 8, 7, 0); // 08:07 -> first 30-min tick is 08:30
    const end = start + 3 * HOUR;
    const ticks = tickTimes(start, end);
    const interval = 30 * 60_000;
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t % interval === 0)).toBe(true);
    expect(ticks[0]).toBeGreaterThanOrEqual(start);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(end);
    expect(ticks[1] - ticks[0]).toBe(interval);
  });
});

describe('indicatorTimes', () => {
  it('mirrors the ticks when the trip spans at least one tick', () => {
    const start = Date.UTC(2026, 6, 15, 8, 0, 0);
    const end = start + 3 * HOUR;
    expect(indicatorTimes(start, end)).toEqual(tickTimes(start, end));
  });

  it('falls back to the midpoint for a trip shorter than one tick interval', () => {
    const start = Date.UTC(2026, 6, 15, 8, 5, 0);
    const end = Date.UTC(2026, 6, 15, 8, 20, 0); // 15 min, no aligned 30-min tick inside
    expect(tickTimes(start, end)).toEqual([]);
    expect(indicatorTimes(start, end)).toEqual([start + (end - start) / 2]);
  });
});
