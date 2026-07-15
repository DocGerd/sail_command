import { describe, expect, it, vi } from 'vitest';
import { solve, type SolveParams } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { makeMask, openWaterMask, TEST_POLAR, uniformWindGrid, wallMask } from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../types';
import { haversineNm } from '../lib/geo';

// Solver-heavy file: CI runners execute the isochrone solver ~6-10x slower than
// dev machines (2026-07-15 CI run: tests at ~1s locally took 30-44s). Fast test
// files keep vitest's 5s default so hang detection stays meaningful there.
vi.setConfig({ testTimeout: 120_000 });

const A = { lat: 54.75, lon: 10.0 };
const B_EAST = { lat: 54.75, lon: 10.4 }; // ~13.9 nm due east of A

function params(overrides: Partial<SolveParams>): SolveParams {
  return {
    origin: A,
    destination: B_EAST,
    departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
    polar: new Polar(TEST_POLAR, 1.0),
    wind: new WindField(uniformWindGrid(12, 0)), // 12 kn from north
    mask: openWaterMask(),
    settings: { ...DEFAULT_SETTINGS, motorEnabled: false },
    ...overrides,
  };
}

describe('isochrone golden routes', () => {
  it('beam reach: sails ~straight with zero maneuvers', () => {
    const r = solve(params({}));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.legs.every((l) => l.kind === 'sail')).toBe(true);
    expect(r.legs.filter((l) => l.maneuverAtStart).length).toBe(0);
    const dist = r.legs.reduce((s, l) => s + l.distanceNm, 0);
    expect(dist).toBeLessThan(haversineNm(A, B_EAST) * 1.15);
    // ~13.9 nm at ~7.2 kn ≈ 1.9 h
    const hours = (r.etaMs - params({}).departureMs) / 3_600_000;
    expect(hours).toBeGreaterThan(1.5);
    expect(hours).toBeLessThan(2.6);
  });

  it('dead upwind: tacks a small, bounded number of times', () => {
    const r = solve(params({ wind: new WindField(uniformWindGrid(12, 90)) })); // wind FROM east
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const maneuvers = r.legs.filter((l) => l.maneuverAtStart).length;
    expect(maneuvers).toBeGreaterThanOrEqual(1);
    expect(maneuvers).toBeLessThanOrEqual(4); // penalty must suppress tack spam
    // VMG sanity: beat at ~42° at ~6.5 kn → VMG ~4.8 kn → ~2.9h for 13.9 nm; allow slack
    const hours = (r.etaMs - params({}).departureMs) / 3_600_000;
    expect(hours).toBeGreaterThan(2.2);
    expect(hours).toBeLessThan(4.2);
    // legs alternate boards only at flagged maneuvers
    for (let i = 1; i < r.legs.length; i++) {
      const prev = r.legs[i - 1];
      const cur = r.legs[i];
      if (prev.kind === 'sail' && cur.kind === 'sail' && prev.board !== cur.board) {
        expect(cur.maneuverAtStart).not.toBeNull();
      }
    }
  });

  it('rounds an island between the ports instead of crossing it', () => {
    // Wall at col 160 (lon≈10.2) with a gap only at rows 90–99 (lat 54.75–54.80).
    // Origin/destination sit at lat 54.60 — the direct track is blocked; the
    // route must climb ~9 nm north to the gap, thread it, and come back down.
    const detourA = { lat: 54.6, lon: 10.0 };
    const detourB = { lat: 54.6, lon: 10.4 };
    const m = wallMask();
    expect(m.segmentNavigable(detourA, detourB, 3)).toBe(false); // direct is blocked
    const r = solve(
      params({
        origin: detourA,
        destination: detourB,
        mask: m,
        wind: new WindField(uniformWindGrid(14, 0)),
      }),
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    for (const l of r.legs) expect(m.segmentNavigable(l.start, l.end, 3)).toBe(true);
    // the route genuinely detours through the gap
    const maxLat = Math.max(...r.legs.map((l) => Math.max(l.start.lat, l.end.lat)));
    expect(maxLat).toBeGreaterThan(54.74); // reached the gap band
    const dist = r.legs.reduce((s, l) => s + l.distanceNm, 0);
    expect(dist).toBeGreaterThan(20); // reviewer-verified detour ≈ 24.3 nm vs 13.9 direct
    expect(dist).toBeLessThan(30);
  });

  it('blocked destination → unreachable with reason', () => {
    // solid wall, no gap
    const solid = { ...params({}) };
    const r = solve({
      ...solid,
      mask: makeMask((_: number, c: number) => (c === 160 ? 0 : 200)),
    });
    expect(r).toEqual({ status: 'no-route', reason: 'unreachable' });
  });

  it('calm with motor off → calm-motor-off; beyond horizon reported', () => {
    // 0.1 kn TWS → polar speeds ~0.07 kn < MIN_SAIL_KN → every sail edge dies.
    // (At 0.5 kn the boat still "sails" at ~0.37 kn and would crawl in — not calm.)
    const calm = solve(params({ wind: new WindField(uniformWindGrid(0.1, 0)) }));
    expect(calm).toEqual({ status: 'no-route', reason: 'calm-motor-off' });

    const short = solve(
      params({
        wind: new WindField(uniformWindGrid(4, 90, { hours: 2 })), // 2h horizon, upwind, light
      }),
    );
    expect(short).toEqual({ status: 'no-route', reason: 'beyond-horizon' });
  });

  it('horizon boundary: eta just inside succeeds; one hour-bucket shorter reports beyond-horizon', () => {
    const departureMs = Date.UTC(2026, 6, 15, 8, 0, 0);
    // Generous reference horizon establishes the scenario's true (unconstrained) ETA.
    const reference = solve(
      params({
        departureMs,
        wind: new WindField(uniformWindGrid(12, 0, { hours: 24, t0Ms: departureMs })),
      }),
    );
    expect(reference.status).toBe('ok');
    if (reference.status !== 'ok') return;

    // Just inside: the smallest whole-hour grid horizon that still covers the ETA.
    // The result must be the identical (deterministic) solve as the reference.
    const hoursInside = Math.ceil((reference.etaMs - departureMs) / 3_600_000) + 1;
    const inside = solve(
      params({
        departureMs,
        wind: new WindField(uniformWindGrid(12, 0, { hours: hoursInside, t0Ms: departureMs })),
      }),
    );
    expect(inside.status).toBe('ok');
    if (inside.status === 'ok') expect(inside.etaMs).toBe(reference.etaMs);

    // Just outside: one hour-bucket shorter, so the same route no longer fits.
    const outside = solve(
      params({
        departureMs,
        wind: new WindField(uniformWindGrid(12, 0, { hours: hoursInside - 1, t0Ms: departureMs })),
      }),
    );
    expect(outside).toEqual({ status: 'no-route', reason: 'beyond-horizon' });
  });

  it('is deterministic', () => {
    const a = solve(params({ wind: new WindField(uniformWindGrid(12, 45)) }));
    const b = solve(params({ wind: new WindField(uniformWindGrid(12, 45)) }));
    expect(a).toEqual(b);
  });
});
