import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NavMask } from '../lib/mask';
import { haversineNm } from '../lib/geo';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../types';
import type { Leg, LatLon, MaskMeta, PolarTable } from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

// #379 asks that per-leg distance be "reconciled against the plan total".
//
// AS LITERALLY STATED THAT IS A TAUTOLOGY. `planRoute.ts:216` DEFINES
// `RigResult.distanceNm` as `legs.reduce((d, l) => d + l.distanceNm, 0)`, so
// `expect(sum of leg.distanceNm).toBe(RigResult.distanceNm)` compares a sum
// with itself and would pass unconditionally -- the #50 equivalence-test
// shape (CLAUDE.md's "mutation-check new tests" lesson). Do not write that
// assertion; if it reappears in review, it is the tautology, not the check.
//
// The genuinely independent check compares the reported total against
// `Σ haversineNm(leg.start, leg.end)` -- the great-circle CHORD of each
// FINAL leg, recomputed straight from stored endpoint geometry rather than
// read from `leg.distanceNm`. This has teeth because the two merge passes
// that can produce a final leg use OPPOSITE conventions for `distanceNm`:
//
//   - isochrone.ts's OWN collinear-hop bookkeeping inside `backtrack`
//     (gated `< 0.5°` between consecutive sub-hop headings, isochrone.ts's
//     `collinear` check) sets `prev.distanceNm += distanceNm` while only
//     `prev.end` moves -- the POLYLINE length of the merged sub-hops. A
//     polyline is never shorter than the chord between its own endpoints.
//   - postprocess.ts's collinear-LEG merge (`tryMerge`, gated
//     `MAX_MERGE_DEG = 10`, the CLAUDE.md-governed RE-VALIDATING pass, not
//     the same pass as above) sets `distanceNm = haversineNm(a.start,
//     b.end)` directly at postprocess.ts:46 -- the CHORD -- so a
//     postprocess-merged leg contributes exactly zero residual.
//   - every leg untouched by either merge also has `distanceNm ===
//     haversineNm(start, end)` exactly, because that is how isochrone.ts's
//     `backtrack` computed it in the first place (`distanceNm =
//     haversineNm(start, end)`, immediately above the collinear check).
//
// So the only legs where `leg.distanceNm > haversineNm(leg.start, leg.end)`
// are ones that survived an isochrone-internal collinear merge, and the
// SIGN of the residual needs no tolerance and no epsilon at all: the
// reported total (== Σ leg.distanceNm, by planRoute.ts:216) can never be
// LESS than Σ haversineNm(leg.start, leg.end) recomputed independently from
// those same legs' own stored endpoints. That inequality is what this file
// pins as the load-bearing assertion. A secondary magnitude bound is pinned
// too, from a MEASURED residual on this fixture (see the comment at that
// assertion) -- never from a closed-form formula: an earlier draft tried
// `legCount * maxLegNm * (1 - cos(0.25°))` and it is wrong on two counts --
// the 0.5° gate in isochrone.ts's `collinear` check applies PAIRWISE between
// consecutive sub-hops, not as a single half-angle bound on the whole merged
// leg, and the polyline-vs-chord deficit can accumulate across a long
// merged chain (hop k can be up to (k-1) x 0.5 degrees off hop 1), so a
// per-leg small-angle substitution under-bounds a long chain. The honest
// bound is measured, with a stated margin.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
const mask = new NavMask(maskMeta, new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))));
const polarGenoa = JSON.parse(
  readFileSync(resolve(dataDir, 'polar-genoa.json'), 'utf8'),
) as PolarTable;
const polarFock = JSON.parse(
  readFileSync(resolve(dataDir, 'polar-fock.json'), 'utf8'),
) as PolarTable;

// Real harbor snap coordinates, matching realmask.repro.test.ts.
const FLENSBURG: LatLon = { lat: 54.798, lon: 9.4335 };
const SOENDERBORG: LatLon = { lat: 54.9046, lon: 9.7833 };
const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);

function chordSumNm(legs: Leg[]): number {
  let total = 0;
  for (const leg of legs) total += haversineNm(leg.start, leg.end);
  return total;
}

// A leg's stored `distanceNm` exceeding its own endpoint chord is only
// possible via isochrone.ts's internal collinear-hop accumulation (see the
// file header) -- postprocess-merged and untouched legs are bit-identical
// to their own chord. `1e-9` nm (~1.85 um) is pure float noise, not a
// tolerance on the geometry itself.
function isochroneMergedLegCount(legs: Leg[]): number {
  let n = 0;
  for (const leg of legs) if (leg.distanceNm - haversineNm(leg.start, leg.end) > 1e-9) n++;
  return n;
}

describe('#379 leg-distance reconciliation (real mask/polars)', () => {
  it('genoa: reported total distance is never less than the summed leg chords', () => {
    const res = planRoute(
      {
        origin: FLENSBURG,
        destination: SOENDERBORG,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'soenderborg',
        departureMs: T0,
        settings: DEFAULT_SETTINGS,
      },
      uniformWindGrid(12, 270),
      { polarGenoa, polarFock, mask },
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const genoa = res.genoa;
    expect(genoa).not.toBeNull();
    if (!genoa) return;

    const chordSum = chordSumNm(genoa.legs);
    const mergedCount = isochroneMergedLegCount(genoa.legs);

    // The load-bearing assertion: no epsilon, because it is a triangle-
    // inequality guarantee (a polyline is never shorter than its own
    // chord), not a numeric approximation. Reds if isochrone.ts:558 is ever
    // flipped to chord semantics (the residual would vanish or invert) or
    // if postprocess.ts:46 is flipped to polyline semantics.
    expect(genoa.distanceNm).toBeGreaterThanOrEqual(chordSum);

    // The magnitude bound: MEASURED on this exact fixture (real mask +
    // real polar + uniformWindGrid(12, 270), Flensburg -> Soenderborg,
    // DEFAULT_SETTINGS, T0 = 2026-07-15T06:00Z) at
    // genoa.distanceNm = 19.377470074773907, chordSum = 19.37747007095334,
    // legCount = 19, mergedCount = 1, residual = 3.820566973899986e-9 nm
    // (~7 um -- one isochrone-internal merge over very short sub-hops on
    // this route). That is far smaller than the design record's "small but
    // nonzero" expectation, and it is genuine, not float noise: double-
    // precision haversine error on a ~19 nm distance is on the order of
    // 1e-14 nm, roughly six orders of magnitude below this residual.
    // Bound set to 1e-3 nm (~1.85 m) -- about 260,000x the measured
    // residual, deliberately loose so this assertion is not a source of
    // flakiness from JS engine/platform floating-point reordering, while
    // still failing hard against any regression on the scale of even a
    // fraction of a real leg length (every leg on this route is >= ~0.1 nm
    // by the solver's own position quantum, isochrone.ts's PRUNE_LAT/LON).
    // If a future change pushes the measured residual past this bound,
    // that is a ROUTING finding per #379's own escalation clause, not a
    // display one -- investigate isochrone.ts's collinear accumulation
    // rather than widening the margin to make this pass.
    const residual = genoa.distanceNm - chordSum;
    expect(residual).toBeGreaterThanOrEqual(0);
    expect(residual).toBeLessThan(1e-3);
    expect(mergedCount).toBeGreaterThan(0);
  });

  it('fock: reported total distance is never less than the summed leg chords', () => {
    const res = planRoute(
      {
        origin: FLENSBURG,
        destination: SOENDERBORG,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'soenderborg',
        departureMs: T0,
        settings: DEFAULT_SETTINGS,
      },
      uniformWindGrid(12, 270),
      { polarGenoa, polarFock, mask },
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const fock = res.fock;
    expect(fock).not.toBeNull();
    if (!fock) return;

    const chordSum = chordSumNm(fock.legs);
    // Same fixture, fock rig: distanceNm = 19.571885101792418,
    // chordSum = 19.571884766730506, legCount = 20, mergedCount = 3,
    // residual = 3.350619124375953e-7 nm (~0.62 mm). Same bound reasoning
    // as the genoa case above (~3,000,000x the measured residual here).
    expect(fock.distanceNm).toBeGreaterThanOrEqual(chordSum);
    expect(fock.distanceNm - chordSum).toBeLessThan(1e-3);
  });

  // F4b (design record): the drawn route on the map is a two-point
  // LineString start -> end per leg (routeGeoJson.ts), so its length is
  // exactly Σ chord -- never Σ leg.distanceNm. On an isochrone-merged leg
  // the table's distance column is therefore slightly LONGER than the line
  // drawn for it. This is the honest meaning of the distance column, stated
  // here rather than left to a future bug report.
  it('the drawn-route length (sum of chords) is strictly less than the reported total when a merge fired', () => {
    const res = planRoute(
      {
        origin: FLENSBURG,
        destination: SOENDERBORG,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'soenderborg',
        departureMs: T0,
        settings: DEFAULT_SETTINGS,
      },
      uniformWindGrid(12, 270),
      { polarGenoa, polarFock, mask },
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const genoa = res.genoa;
    expect(genoa).not.toBeNull();
    if (!genoa) return;
    expect(isochroneMergedLegCount(genoa.legs)).toBeGreaterThan(0);
    expect(chordSumNm(genoa.legs)).toBeLessThan(genoa.distanceNm);
  });
});
