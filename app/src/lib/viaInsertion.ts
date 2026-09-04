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
