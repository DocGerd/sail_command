// #845: where a newly picked waypoint (e.g. a seamark) lands in the via
// list. Design spec §2.6 (docs/superpowers/specs/2026-09-04-named-waypoints-
// design.md): insert at the point's NEAREST position along the current
// route, not appended to the end — "route via that buoy" names a point the
// skipper will pass, and appending a mid-route mark after the destination
// would produce a nonsense route until the user manually reorders it.
//
// Reuses seamarkProximity.ts's pointToSegmentM (itself built on geo.ts's
// primitives) instead of adding a new helper to lib/geo.ts. geo.ts sits
// inside app/sweep/'s import closure (sweepArms.ts -> lib/mask.ts ->
// lib/geo.ts), and adding an unrelated segment helper there would flip
// #845's own closure verdict to OWED for a change the solver never reads —
// the same reasoning seamarkProximity.ts's own header records for #615.
// This file is imported only from App.tsx/DataLayers.tsx/SeamarksInView.tsx,
// none of which sit in the sweep's import closure, so it stays out of it
// regardless of what it itself imports.
import { pointToSegmentM } from './seamarkProximity';
import type { LatLon } from '../types';

/**
 * Index into `viaPoints` (0-based, valid for Array#splice's insertion
 * position — 0 means "before every existing via point", `viaPoints.length`
 * means "at the end") of the segment of the origin -> viaPoints ->
 * destination chain that `point` projects closest to.
 *
 * The chain used is the DRAFT waypoint chain the panel is editing — the
 * straight great-circle segments between origin, the current via list and
 * destination — not the solved isochrone polyline. The solved route has
 * extra tack/gybe vertices with no via-index of their own, so mapping a
 * nearest LEG back to a via-array position would need information legs
 * don't carry (no `Leg` field names which via-to-via stretch it belongs
 * to). The draft chain is always well-defined once both endpoints exist,
 * works whether or not a solve has run yet, and is exactly what the next
 * Plan-route press will submit — so "nearest point along the route" here
 * means nearest point along that chain.
 *
 * Callers must not invoke this with no route context (§2.6: "with no route
 * planned yet, append" — there is no chain to project onto). With an empty
 * `viaPoints` list the chain is just [origin, destination], one segment,
 * and this always returns 0 — matching "with an empty via list the two
 * rules agree anyway".
 */
export function nearestViaInsertIndex(
  point: LatLon,
  origin: LatLon,
  destination: LatLon,
  viaPoints: readonly LatLon[],
): number {
  const chain: readonly LatLon[] = [origin, ...viaPoints, destination];
  let bestIndex = 0;
  let bestDistM = Infinity;
  for (let i = 0; i < chain.length - 1; i++) {
    const d = pointToSegmentM(point, chain[i]!, chain[i + 1]!);
    if (d < bestDistM) {
      bestDistM = d;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * Great-circle midpoint of `a` and `b` — the default coordinate for #1171's
 * keyboard "insert waypoint between N and N+1" control, which has no
 * pointer-release point to place the new waypoint at (unlike #850's
 * drag-to-insert gesture). A simple lat/lon average would drift off the
 * great-circle line for a long segment; this is the standard spherical
 * midpoint formula, self-contained here (no dependency on lib/geo.ts, which
 * IS in `app/sweep/`'s import closure — see this file's own header comment)
 * rather than a haversine/bearing-based construction that would need it.
 */
export function segmentMidpoint(a: LatLon, b: LatLon): LatLon {
  const lat1 = (a.lat * Math.PI) / 180;
  const lon1 = (a.lon * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;

  const bx = Math.cos(lat2) * Math.cos(dLon);
  const by = Math.cos(lat2) * Math.sin(dLon);
  const lat3 = Math.atan2(
    Math.sin(lat1) + Math.sin(lat2),
    Math.sqrt((Math.cos(lat1) + bx) ** 2 + by ** 2),
  );
  const lon3 = lon1 + Math.atan2(by, Math.cos(lat1) + bx);

  return {
    lat: (lat3 * 180) / Math.PI,
    // Normalize back into (-180, 180] rather than leaving lon1 + atan2(...)
    // to drift outside it for a segment crossing the antimeridian.
    lon: (((lon3 * 180) / Math.PI + 540) % 360) - 180,
  };
}
