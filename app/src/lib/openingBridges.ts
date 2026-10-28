// #1881: which opening bridges the active rig's route passes. PRESENTATION-
// ONLY, the same shape as seamarkProximity.ts: recomputed at render from the
// plan's own legs, so PlanResult, types.ts and routing/** gain nothing and no
// #282 sweep is owed. Primitives are IMPORTED; lib/geo.ts is in the sweep
// closure and is never extended for this.
import { OPENING_BRIDGES, type OpeningBridge } from '../data/openingBridges';
import type { LatLon, Leg } from '../types';
import { pointToSegmentM } from './seamarkProximity';

/**
 * A leg within this many metres of a bridge's passage line counts as passing
 * it. A maintainer judgement call, about one ~46 m mask cell: the merged
 * chord polyline has no finer precision. Not interpolated into any copy.
 */
export const BRIDGE_PASS_M = 50;

const M_PER_DEG_LAT = 111_320;

interface XY {
  x: number;
  y: number;
}

function cross(o: XY, a: XY, b: XY): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function segmentsIntersect(p1: XY, p2: XY, q1: XY, q2: XY): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  const within = (a: XY, b: XY, c: XY) =>
    Math.min(a.x, b.x) <= c.x &&
    c.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= c.y &&
    c.y <= Math.max(a.y, b.y);
  return (
    (d1 === 0 && within(q1, q2, p1)) ||
    (d2 === 0 && within(q1, q2, p2)) ||
    (d3 === 0 && within(p1, p2, q1)) ||
    (d4 === 0 && within(p1, p2, q2))
  );
}

/**
 * Metres between segments a1-a2 and b1-b2: 0 when they intersect, else the
 * smallest of the four endpoint-to-segment distances. The intersection test
 * runs on a local equirectangular plane around `b1`, exact enough at bridge
 * scale.
 */
export function segmentDistanceM(a1: LatLon, a2: LatLon, b1: LatLon, b2: LatLon): number {
  const kx = M_PER_DEG_LAT * Math.cos((b1.lat * Math.PI) / 180);
  const xy = (p: LatLon): XY => ({ x: (p.lon - b1.lon) * kx, y: (p.lat - b1.lat) * M_PER_DEG_LAT });
  if (segmentsIntersect(xy(a1), xy(a2), xy(b1), xy(b2))) return 0;
  return Math.min(
    pointToSegmentM(a1, b1, b2),
    pointToSegmentM(a2, b1, b2),
    pointToSegmentM(b1, a1, a2),
    pointToSegmentM(b2, a1, a2),
  );
}

const isFinitePoint = (p: LatLon): boolean => Number.isFinite(p.lat) && Number.isFinite(p.lon);

/**
 * Bridges whose passage line lies within BRIDGE_PASS_M of any leg, ordered by
 * the first leg that reaches them, one entry per bridge. Fails OPEN to []: a
 * missing leg list or a leg with a non-finite coordinate is skipped, never
 * thrown on.
 */
export function bridgesPassed(
  legs: readonly Leg[] | null | undefined,
  bridges: readonly OpeningBridge[] = OPENING_BRIDGES,
): OpeningBridge[] {
  if (!legs) return [];
  const found: OpeningBridge[] = [];
  for (const leg of legs) {
    if (!isFinitePoint(leg.start) || !isFinitePoint(leg.end)) continue;
    for (const bridge of bridges) {
      if (found.includes(bridge)) continue;
      const { a, b } = bridge.passageLine;
      if (segmentDistanceM(leg.start, leg.end, a, b) < BRIDGE_PASS_M) found.push(bridge);
    }
  }
  return found;
}
