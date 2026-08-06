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
// read from `leg.distanceNm`. This is independent because the two merge
// passes that can produce a final leg use OPPOSITE conventions for
// `distanceNm`:
//
//   - isochrone.ts's OWN collinear-hop bookkeeping inside `backtrack`
//     (gated `< 0.5°` between consecutive sub-hop headings, isochrone.ts's
//     `collinear` check) sets `prev.distanceNm += distanceNm` while only
//     `prev.end` moves -- the POLYLINE length of the merged sub-hops.
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
// TWO SEPARATE ASSERTIONS below, and they catch TWO DIFFERENT bug classes
// -- read what each one actually proves before trusting either alone
// (corrected after review, PR #410 review #1, which measured both flips
// below in an isolated worktree; the original comment here overclaimed):
//
// 1. THE SIGN ASSERTION (`distanceNm >= chordSum`) IS A NEAR-TAUTOLOGY
//    UNDER THE CURRENT ARCHITECTURE, not a strong regression catcher. Every
//    leg's `distanceNm` is either exactly its own chord, or a SUM of
//    sub-chords (isochrone's internal merge) -- and a sum of sub-chords is
//    >= the chord between the sum's own endpoints by the triangle
//    inequality, for ANY merge convention. So the sign holds whether
//    isochrone.ts:558 accumulates (today) or is flipped to chord semantics,
//    and whether postprocess.ts:46 uses the chord (today) or is flipped to
//    accumulate the sub-legs' distances instead -- MEASURED: both flips,
//    run and reverted in this worktree, left the sign assertion PASSING.
//    What it DOES catch: a leg reporting LESS distance than the straight
//    line between its own stored endpoints, which is not possible under
//    either legitimate convention (verified: halving isochrone.ts:545's
//    per-hop `distanceNm` reds this assertion hard, e.g.
//    `14.657655903577167 to be greater than or equal to 19.37747007095334`
//    on the genoa fixture below). Kept as a cheap, epsilon-free invariant
//    guard -- not the check that actually discriminates the two merge
//    conventions from each other.
// 2. THE MAGNITUDE BOUND is the one that DOES discriminate them on this
//    fixture. Flipping postprocess.ts:46 to accumulate
//    (`a.distanceNm + b.distanceNm`, polyline semantics) instead of taking
//    the chord reds the bound at 27.5x over for genoa (measured residual
//    0.027475406327489793 nm) and 10.5x over for fock (0.010527711806410878
//    nm) -- while the sign assertion stays green throughout. Flipping
//    isochrone.ts:558 to chord semantics instead of accumulating reds the
//    separate `mergedCount > 0` / F4b assertions (residual collapses to
//    exactly 0, so no leg is detected as isochrone-merged) -- again with the
//    sign assertion still green. See the per-test comments for the exact
//    measured numbers and the bound's own honesty caveat (it is not a
//    universal safe ceiling -- a longer, legitimately-merged chain can
//    exceed it with no bug at all; derivation at that assertion).
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

    // ASSERTION 1 -- the sign, near-tautological given the current code
    // (see the file header): every leg's distanceNm is its own chord or a
    // sum of sub-chords, which by the triangle inequality is always >= the
    // chord between that sum's own endpoints. MEASURED to hold under BOTH
    // convention flips (postprocess.ts:46 -> polyline, isochrone.ts:558 ->
    // chord) -- it does NOT discriminate them. What it DOES catch: a leg
    // under-reporting its own chord (verified: halving isochrone.ts:545's
    // per-hop distanceNm reds this with
    // `expected 14.657655903577167 to be greater than or equal to
    // 19.37747007095334`). Kept as a cheap, epsilon-free invariant guard.
    expect(genoa.distanceNm).toBeGreaterThanOrEqual(chordSum);

    // ASSERTION 2 -- the magnitude bound, the one that actually catches a
    // postprocess-convention regression. MEASURED on this exact fixture
    // (real mask + real polar + uniformWindGrid(12, 270),
    // Flensburg -> Soenderborg, DEFAULT_SETTINGS, T0 = 2026-07-15T06:00Z):
    // genoa.distanceNm = 19.377470074773907, chordSum = 19.37747007095334,
    // legCount = 19, mergedCount = 1, residual = 3.820566973899986e-9 nm
    // (~7 um -- one isochrone-internal merge over very short sub-hops on
    // this route). Confirmed as the DISCRIMINATING assertion: flipping
    // postprocess.ts:46 to `a.distanceNm + b.distanceNm` (polyline
    // semantics) reds THIS bound at 0.027475406327489793 nm -- 27.5x over
    // -- while assertion 1 above stays green throughout (residual > 0).
    //
    // The bound (1e-3 nm, ~1.85 m) is NOT a universal safe ceiling and a
    // future red here does not automatically mean a bug -- quote the
    // method, not just the number: for a chain of k sub-hops of length d
    // (nm) each turning by the isochrone.ts:554 gate's permitted maximum
    // (just under 0.5 deg from the previous sub-hop), the worst-case
    // polyline-vs-chord residual is `k*d - |sum_{i=0}^{k-1} d * unit(i*phi)|`
    // (a discretised circular arc; phi ~ 0.5deg). At d = 1 nm this is
    // ~1.9e-5 nm for a single pair (k=2, matching the "small but nonzero"
    // design-record expectation) but ~3.14e-3 nm for a k=10 chain --
    // already ABOVE this bound, with no bug involved, because
    // isochrone.ts's OWN internal merge (unlike postprocess.ts's
    // MAX_MERGE_DEG=10 cap) has no overall degree ceiling: it chains for as
    // long as each CONSECUTIVE pair of sub-hops satisfies the <0.5deg gate.
    // On this fixture mergedCount stayed at 1-3, keeping the observed
    // residual in the micrometre range, far under 1e-3 -- but a longer,
    // gently-curving passage could legitimately push a future measurement
    // past this bound. Before treating a red here as a ROUTING finding,
    // check mergedCount and each leg's own (distanceNm - its chord) to see
    // whether a long benign merge chain explains it; only investigate
    // isochrone.ts's collinear accumulation as a bug if it doesn't.
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
    const mergedCount = isochroneMergedLegCount(fock.legs);
    // Same fixture, fock rig: distanceNm = 19.571885101792418,
    // chordSum = 19.571884766730506, legCount = 20, mergedCount = 3,
    // residual = 3.350619124375953e-7 nm (~0.62 mm). Same two-assertion
    // reasoning as the genoa case above: MEASURED, flipping
    // postprocess.ts:46 to polyline semantics reds the magnitude bound at
    // 0.010527711806410878 nm (10.5x over) while the sign stays green;
    // `mergedCount > 0` is what catches isochrone.ts:558 flipped to chord
    // semantics instead (both assertions below were MISSING here in the
    // first version of this file, which is why that second flip left this
    // test fully green -- fixed in review).
    const residual = fock.distanceNm - chordSum;
    expect(fock.distanceNm).toBeGreaterThanOrEqual(chordSum);
    expect(residual).toBeGreaterThanOrEqual(0);
    expect(residual).toBeLessThan(1e-3);
    expect(mergedCount).toBeGreaterThan(0);
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
