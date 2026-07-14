import { describe, expect, it } from 'vitest';
import { solve } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { openWaterMask, TEST_POLAR, uniformWindGrid, makeWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../types';
import { haversineNm } from '../lib/geo';

const A = { lat: 54.75, lon: 10.0 };
const B = { lat: 54.75, lon: 10.4 };
const dep = Date.UTC(2026, 6, 15, 8, 0, 0);
const base = {
  origin: A, destination: B, departureMs: dep,
  polar: new Polar(TEST_POLAR, 1.0), mask: openWaterMask(), settings: DEFAULT_SETTINGS,
};

describe('motor fallback', () => {
  it('calm + motor on → one straight motor leg at motor speed', () => {
    const r = solve({ ...base, wind: new WindField(uniformWindGrid(0.5, 0)) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.legs.every((l) => l.kind === 'motor' && l.board === null)).toBe(true);
    expect(r.legs.length).toBe(1); // collinear motor steps merge in backtrack
    const hours = (r.etaMs - dep) / 3_600_000;
    expect(hours).toBeCloseTo(haversineNm(A, B) / DEFAULT_SETTINGS.motorSpeedKn, 1);
  });

  it('wind dying en route → sail first, flagged motor leg after', () => {
    const wind = new WindField(
      makeWindGrid((_la, lon) => ({ speedKn: lon < 10.2 ? 14 : 0.5, dirFromDeg: 0 })),
    );
    const r = solve({ ...base, wind });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const kinds = r.legs.map((l) => l.kind);
    expect(kinds[0]).toBe('sail');
    expect(kinds[kinds.length - 1]).toBe('motor');
  });

  it('motor threshold respected: marginal wind sails when above threshold', () => {
    // 6 kn TWS beam reach → TEST_POLAR speed ~4.3 kn > 2.5 threshold → must sail, not motor
    const r = solve({ ...base, wind: new WindField(uniformWindGrid(6, 0)) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.legs.every((l) => l.kind === 'sail')).toBe(true);
  });
});
