import { describe, expect, it } from 'vitest';
import type { Feature, Point } from 'geojson';
import { destinationPoint, haversineNm, initialBearingDeg } from './geo';
import type { SeamarkFeatureCollection } from './seamarkGeoJson';
import type { LatLon, Leg, SeamarkProperties } from '../types';
import { nearbyHazardMarkCount, pointToSegmentM, SEAMARK_PROXIMITY_M } from './seamarkProximity';

// #615: the advisory seamark-proximity count is presentation-only, so THIS
// file is the only thing that pins its geometry — nothing in routing/** or
// app/sweep/** ever runs it. Every row names the mutation it must red on
// (the design brief's §3.6 table); the two positive controls carry
// independently hand-computed literals (spherical law of cosines and the
// closed-form cross-track from a meridian, both computed in Python outside
// this codebase — never read back from the function under test, which is the
// #50 equivalence-test tautology).

const M_PER_NM = 1852;
const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);

function motorLeg(start: LatLon, end: LatLon): Leg {
  return {
    kind: 'motor',
    board: null,
    start,
    end,
    startTimeMs: T0,
    endTimeMs: T0 + 3_600_000,
    headingDeg: initialBearingDeg(start, end),
    twsKn: 5,
    speedKn: 6,
    distanceNm: haversineNm(start, end),
    maneuverAtStart: null,
  };
}

function mark(p: LatLon, seamarkType: string): Feature<Point, SeamarkProperties> {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { seamarkType },
  };
}

function collection(...features: Feature<Point, SeamarkProperties>[]): SeamarkFeatureCollection {
  return { type: 'FeatureCollection', features };
}

// One ~27.9 km leg NE across the Flensburg Fjord mouth (the same segment the
// #615 research packet's 10/10 control used), plus its midpoint and the
// bearing needed to place marks a known distance ABEAM of it.
const A: LatLon = { lat: 54.8, lon: 9.5 };
const B: LatLon = { lat: 54.9, lon: 9.9 };
const AB_BEARING = initialBearingDeg(A, B);
const MID = destinationPoint(A, AB_BEARING, haversineNm(A, B) / 2);
const abeam = (metres: number): LatLon => destinationPoint(MID, AB_BEARING + 90, metres / M_PER_NM);

describe('#615 pointToSegmentM', () => {
  it('POSITIVE CONTROL: perpendicular distance to a meridian segment matches the closed form R·asin(cos φ · sin Δλ)', () => {
    // Segment along the 9.5°E meridian from 54.7°N to 54.9°N; the mark sits
    // at 54.8°N 9.6°E, so its foot lies mid-segment. Hand-computed:
    // 3440.065 nm × asin(cos 54.8° × sin 0.1°) × 1852 = 6409.633 m.
    const d = pointToSegmentM(
      { lat: 54.8, lon: 9.6 },
      { lat: 54.7, lon: 9.5 },
      { lat: 54.9, lon: 9.5 },
    );
    expect(Math.abs(d - 6409.63)).toBeLessThan(0.05);
  });

  it('POSITIVE CONTROL: a mark past the far end clamps to the endpoint distance (spherical law of cosines)', () => {
    // Segment 54.5°N→54.7°N along 9.5°E; the mark at 54.8°N 9.6°E projects
    // BEYOND b, so the answer is the great-circle distance to b itself.
    // Hand-computed via the law of cosines: 12838.54 m. Mutation: dropping
    // the `f >= 1` clamp reads the perpendicular to the EXTENDED great circle
    // instead (≈6.4 km) — red by ~6.4 km, never a near miss.
    const d = pointToSegmentM(
      { lat: 54.8, lon: 9.6 },
      { lat: 54.5, lon: 9.5 },
      { lat: 54.7, lon: 9.5 },
    );
    expect(Math.abs(d - 12838.54)).toBeLessThan(0.05);
  });

  it('endpoint clamping: 500 m PAST b reads ≈500 m, 750 m BEFORE a reads ≈750 m', () => {
    const past = destinationPoint(B, AB_BEARING, 500 / M_PER_NM);
    const before = destinationPoint(A, AB_BEARING + 180, 750 / M_PER_NM);
    expect(Math.abs(pointToSegmentM(past, A, B) - 500)).toBeLessThan(0.5);
    expect(Math.abs(pointToSegmentM(before, A, B) - 750)).toBeLessThan(0.5);
  });

  it('a mark abeam of the midpoint reads its abeam offset (300 m → 300 m)', () => {
    expect(Math.abs(pointToSegmentM(abeam(300), A, B) - 300)).toBeLessThan(0.5);
  });

  it('a zero-length segment degrades to the plain point distance', () => {
    const p = destinationPoint(A, 90, 1000 / M_PER_NM);
    expect(Math.abs(pointToSegmentM(p, A, A) - 1000)).toBeLessThan(0.5);
  });
});

describe('#615 nearbyHazardMarkCount', () => {
  const LEG = motorLeg(A, B);

  it('SEAMARK_PROXIMITY_M is the ratified 300 m', () => {
    // A deliberate twin of the literal in route.seamarks.proximity's
    // rendered copy (pinned in RouteSummary.test.tsx) and of the spike
    // doc's table: a re-ratification must move all three together.
    expect(SEAMARK_PROXIMITY_M).toBe(300);
  });

  it('threshold boundary: a cardinal mark 299 m abeam counts', () => {
    // Mutation: `<` → `>` (or an ε sign flip) → 0.
    const fc = collection(mark(abeam(299), 'buoy_cardinal'));
    expect(nearbyHazardMarkCount([LEG], fc, 300)).toBe(1);
  });

  it('threshold boundary: a cardinal mark 301 m abeam does NOT count', () => {
    // Mutation: loosening the comparison (`<=` on a rounded value, or a
    // wider constant) → 1.
    const fc = collection(mark(abeam(301), 'buoy_cardinal'));
    expect(nearbyHazardMarkCount([LEG], fc, 300)).toBe(0);
  });

  it('category: a lateral mark 1 m from the leg does NOT count, an isolated-danger beacon does', () => {
    // Mutation: replace isHazardSeamark with `() => true` → 2.
    const fc = collection(mark(abeam(1), 'buoy_lateral'), mark(abeam(2), 'beacon_isolated_danger'));
    expect(nearbyHazardMarkCount([LEG], fc, 300)).toBe(1);
  });

  it('dedupe: two hazard features at one coordinate count as ONE mark', () => {
    // Measured on the shipped seamarks.json: one MVP pair shares exact
    // coordinates, which the user sees as a single symbol. Mutation: delete
    // the coordinate dedupe → 2.
    const p = abeam(100);
    const fc = collection(mark(p, 'buoy_cardinal'), mark(p, 'beacon_cardinal'));
    expect(nearbyHazardMarkCount([LEG], fc, 300)).toBe(1);
  });

  it('a mark near a LATER leg counts, and the per-mark minimum is over ALL legs', () => {
    // Leg 2 continues from B; the mark sits 100 m abeam of leg 2's midpoint
    // and ~14 km from leg 1. Mutation: only the first leg walked → 0.
    const C = destinationPoint(B, AB_BEARING + 60, 15);
    const leg2 = motorLeg(B, C);
    const mid2 = destinationPoint(B, initialBearingDeg(B, C), haversineNm(B, C) / 2);
    const p = destinationPoint(mid2, initialBearingDeg(B, C) + 90, 100 / M_PER_NM);
    expect(nearbyHazardMarkCount([LEG, leg2], collection(mark(p, 'buoy_cardinal')), 300)).toBe(1);
    expect(nearbyHazardMarkCount([LEG], collection(mark(p, 'buoy_cardinal')), 300)).toBe(0);
  });

  it('a mark just inside range of a leg END (not its middle) still counts', () => {
    // 250 m past B along the leg's own bearing: any early-out that prunes a
    // leg by distance to its START would drop it. Mutation: prune on
    // `haversine(p, start) > threshold` alone → 0.
    const p = destinationPoint(B, AB_BEARING, 250 / M_PER_NM);
    expect(nearbyHazardMarkCount([LEG], collection(mark(p, 'buoy_cardinal')), 300)).toBe(1);
  });

  it('no legs → 0; no features → 0; a non-Point/malformed feature is skipped, never thrown on', () => {
    const fc = collection(mark(abeam(10), 'buoy_cardinal'));
    expect(nearbyHazardMarkCount([], fc, 300)).toBe(0);
    expect(nearbyHazardMarkCount([LEG], collection(), 300)).toBe(0);
    const malformed = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [] },
          properties: { seamarkType: 'buoy_cardinal' },
        },
        { type: 'Feature', geometry: null, properties: { seamarkType: 'buoy_cardinal' } },
      ],
    } as unknown as SeamarkFeatureCollection;
    expect(nearbyHazardMarkCount([LEG], malformed, 300)).toBe(0);
  });

  it('counts DISTINCT marks in range, not (mark, leg) pairs — three marks at 50/150/250 m → 3', () => {
    const fc = collection(
      mark(abeam(50), 'buoy_cardinal'),
      mark(abeam(150), 'buoy_cardinal'),
      mark(abeam(250), 'buoy_isolated_danger'),
      mark(abeam(350), 'buoy_cardinal'),
    );
    expect(nearbyHazardMarkCount([LEG], fc, 300)).toBe(3);
  });
});
