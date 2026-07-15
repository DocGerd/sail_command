import { describe, expect, it } from 'vitest';
import { toGpx } from './gpx';
import { uniformWindGrid } from '../test/fixtures';
import type { Plan } from '../types';

const plan: Plan = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Flensburg → <Marstal> & back',
  createdAtMs: Date.UTC(2026, 6, 15, 7, 0, 0),
  request: {
    origin: { lat: 54.79, lon: 9.43 }, destination: { lat: 54.85, lon: 10.52 },
    originHarborId: 'flensburg', destinationHarborId: 'marstal',
    departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
    settings: {
      safetyDepthM: 3, motorSpeedKn: 6.5, motorThresholdKn: 2.5,
      maneuverPenaltyS: 45, performanceFactor: 0.9, motorEnabled: true,
    },
  },
  windGrid: uniformWindGrid(10, 270),
  result: {
    status: 'ok',
    recommended: 'genoa',
    snappedOrigin: { lat: 54.79, lon: 9.43 },
    snappedDestination: { lat: 54.85, lon: 10.52 },
    fock: null,
    genoa: {
      rig: 'genoa',
      etaMs: Date.UTC(2026, 6, 15, 12, 0, 0),
      durationMs: 4 * 3_600_000,
      distanceNm: 20, maneuverCount: 1, motorDistanceNm: 5,
      legs: [
        {
          kind: 'sail', board: 'starboard',
          start: { lat: 54.79, lon: 9.43 }, end: { lat: 54.8, lon: 10.0 },
          startTimeMs: Date.UTC(2026, 6, 15, 8, 0, 0), endTimeMs: Date.UTC(2026, 6, 15, 10, 0, 0),
          headingDeg: 88, twaDeg: 92, twsKn: 10, speedKn: 7, distanceNm: 15, maneuverAtStart: null,
        },
        {
          kind: 'motor', board: null,
          start: { lat: 54.8, lon: 10.0 }, end: { lat: 54.85, lon: 10.52 },
          startTimeMs: Date.UTC(2026, 6, 15, 10, 0, 0), endTimeMs: Date.UTC(2026, 6, 15, 12, 0, 0),
          headingDeg: 90, twaDeg: NaN, twsKn: 2, speedKn: 6.5, distanceNm: 5, maneuverAtStart: null,
        },
      ],
    },
  },
};

describe('toGpx', () => {
  const xml = toGpx(plan, 'genoa');

  it('produces a GPX 1.1 route with rtepts for each leg start + destination', () => {
    expect(xml).toContain('<gpx version="1.1"');
    expect((xml.match(/<rtept /g) ?? []).length).toBe(3); // 2 legs + final point
    expect(xml).toContain('lat="54.85"');
    expect(xml).toContain('<time>2026-07-15T08:00:00.000Z</time>');
  });

  it('escapes XML and marks motor legs', () => {
    expect(xml).toContain('&lt;Marstal&gt; &amp; back');
    expect(xml).toContain('motor');
    expect(xml).not.toContain('<Marstal>');
  });

  it('throws a descriptive error when the rig result is missing or empty', () => {
    expect(() => toGpx(plan, 'fock')).toThrow(/no fock result/);
    const empty: Plan = structuredClone(plan);
    if (empty.result.status === 'ok' && empty.result.genoa) empty.result.genoa.legs = [];
    expect(() => toGpx(empty, 'genoa')).toThrow(/empty route/);
  });
});
