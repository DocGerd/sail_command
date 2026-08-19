import type { LatLon, MaskMeta } from '../types';
import { toRad } from './geo';

/**
 * #452 P3: the radius, in metres, around each snapped waypoint inside which
 * #53's relaxed depth gate may apply. Outside every such disc the REQUESTED
 * safety depth governs, so relaxed water can only ever appear near a waypoint
 * the user actually chose.
 *
 * 1852 m (1 nm) is the maintainer's ruling. TWO separate constraints bear on
 * it, and the binding one is the POCKET-COVERAGE floor, not the pinch cliff:
 * docs/spikes/452-local-depth-relaxation.md §2.3 measures every one of the 103
 * relaxation-rescued pockets as covered at R = 1852 m with a worst-case pocket
 * extent of 1,839 m — a 13 m margin, a knife-edge rather than a buffer. (That
 * spike's §3.3 records the worst case as BOTH 1,839 m and 1,840 m and marks
 * which is real as unsettled, `Refs #502`; the subtraction here is stated
 * against the 1,839 m figure its own §2.3 quotes.) The spike's §3.3 also warns
 * that the ~790 m figure quoted elsewhere in that document is the margin over
 * the separate 1050->1060 m pinch cliff, NOT this radius's margin — do not
 * restate it here.
 *
 * ACCEPTANCE RULE, from that spike's §6 item 4: a re-derived worst-case pocket
 * extent ABOVE 1852 m invalidates this radius outright.
 */
export const APPROACH_RADIUS_M = 1852;

/** Metres per degree of latitude, matching `NavMask.snapToNavigable`'s constant. */
const M_PER_DEG = 111_320;

/**
 * A single route-wide gate. Produced whenever no per-cell variation exists —
 * every tier that solves at the requested depth, and the `APPROACH_RADIUS_M
 * = Infinity` kill switch.
 */
export interface UniformGate {
  readonly kind: 'uniform';
  readonly gateM: number;
}

/**
 * One relaxation disc, expressed entirely in GRID coordinates so the per-cell
 * membership test is multiply-and-add only — a metres-space circle is an
 * ellipse in grid space, and the conversion is done once here rather than per
 * cell. The squared radii are stored (rather than the radii) for the same
 * reason, and because it makes the degenerate `radiusM === 0` case cheap
 * instead of dividing by zero — though what actually confines that case to a
 * waypoint's own cell is `gateAtCell`'s union bounding-box reject, not this
 * ellipse test: at `radiusM === 0` the test below reduces to `0 <= 0`, which
 * is vacuously true for every cell that reaches it, so with two or more
 * waypoints it can match cells inside their bbox UNION that are neither
 * waypoint's own centre. `radiusM === 0` is unreachable in production (only
 * `APPROACH_RADIUS_M` and `Infinity` are ever passed).
 */
export interface Disc {
  /** Grid row of the waypoint's own cell. */
  readonly row: number;
  /** Grid column of the waypoint's own cell. */
  readonly col: number;
  /** `APPROACH_RADIUS_M` squared, in ROW units. */
  readonly rowRadius2: number;
  /** `APPROACH_RADIUS_M` squared, in COLUMN units (latitude-corrected). */
  readonly colRadius2: number;
  /** `rowRadius2 * colRadius2`, precomputed for the membership test. */
  readonly radiiProduct: number;
  /** The relaxed gate this disc licenses. */
  readonly gateM: number;
}

/**
 * A per-cell gate FIELD: the requested depth everywhere except inside one of
 * a few discs around the snapped waypoints.
 */
export interface ApproachGate {
  readonly kind: 'approach';
  /** The gate OUTSIDE every disc. */
  readonly requestedDepthM: number;
  readonly discs: readonly Disc[];
  /** Union bounding box of every disc, for an O(1) reject. */
  readonly rowLo: number;
  readonly rowHi: number;
  readonly colLo: number;
  readonly colHi: number;
  /** `min(requestedDepthM, ...disc gates)` — the shallowest gate in the field. */
  readonly minGateM: number;
}

export type DepthGate = UniformGate | ApproachGate;

export function uniformGate(gateM: number): UniformGate {
  return { kind: 'uniform', gateM };
}

/**
 * Build the #452 P3 gate field for `waypoints`, with `gatesM[i]` the relaxed
 * gate granted inside waypoint `i`'s disc.
 *
 * KILL SWITCH: a non-finite `radiusM` returns a {@link UniformGate} rather
 * than an `ApproachGate` with infinite radii. Under an infinite radius every
 * cell lies inside every disc, so `gateAtCell` would return the deepest disc
 * gate at every cell — which is exactly `Math.max(...gatesM)`, the value
 * returned here. That reproduces the pre-#452 route-wide behaviour cell for
 * cell, which is what lets the existing suite pin it verbatim.
 */
export function approachGate(
  meta: MaskMeta,
  waypoints: readonly LatLon[],
  requestedDepthM: number,
  gatesM: readonly number[],
  radiusM: number,
): DepthGate {
  if (!Number.isFinite(radiusM)) return uniformGate(Math.max(...gatesM));

  const latStep = (meta.north - meta.south) / meta.rows;
  const lonStep = (meta.east - meta.west) / meta.cols;
  const discs: Disc[] = [];
  let rowLo = Infinity;
  let rowHi = -Infinity;
  let colLo = Infinity;
  let colHi = -Infinity;
  let minGateM = requestedDepthM;

  for (let i = 0; i < waypoints.length; i++) {
    const w = waypoints[i];
    const gateM = gatesM[i];
    const row = Math.floor((w.lat - meta.south) / latStep);
    const col = Math.floor((w.lon - meta.west) / lonStep);
    // Same two conversions NavMask.snapToNavigable uses for its ring bound.
    const rowRadius = radiusM / (M_PER_DEG * latStep);
    const colRadius = radiusM / (M_PER_DEG * lonStep * Math.cos(toRad(w.lat)));
    const rowRadius2 = rowRadius * rowRadius;
    const colRadius2 = colRadius * colRadius;
    discs.push({
      row,
      col,
      rowRadius2,
      colRadius2,
      radiiProduct: rowRadius2 * colRadius2,
      gateM,
    });
    rowLo = Math.min(rowLo, Math.floor(row - rowRadius));
    rowHi = Math.max(rowHi, Math.ceil(row + rowRadius));
    colLo = Math.min(colLo, Math.floor(col - colRadius));
    colHi = Math.max(colHi, Math.ceil(col + colRadius));
    minGateM = Math.min(minGateM, gateM);
  }

  return { kind: 'approach', requestedDepthM, discs, rowLo, rowHi, colLo, colHi, minGateM };
}

/**
 * The depth gate governing one grid cell.
 *
 * OVERLAP IS RESOLVED BY MAX, DELIBERATELY — do not "fix" this to MIN. Two
 * discs overlap only when two snapped waypoints sit within 2 *
 * `APPROACH_RADIUS_M` of each other. Taking the DEEPEST gate among the discs
 * containing a cell licenses strictly LESS water than taking the shallowest,
 * which is the direction a safety guard must fail in. It is inert while every
 * disc carries the same gate (phase 1 of `findRelaxedGate`), so it can only
 * ever cost a tightening opportunity in phase 2, never safety.
 */
export function gateAtCell(gate: DepthGate, row: number, col: number): number {
  if (gate.kind === 'uniform') return gate.gateM;
  if (row < gate.rowLo || row > gate.rowHi || col < gate.colLo || col > gate.colHi)
    return gate.requestedDepthM;
  let deepest = -Infinity;
  for (const d of gate.discs) {
    const dr = row - d.row;
    const dc = col - d.col;
    // (dr/rowRadius)^2 + (dc/colRadius)^2 <= 1, multiplied through by
    // rowRadius2 * colRadius2 so no division happens per cell.
    if (dr * dr * d.colRadius2 + dc * dc * d.rowRadius2 <= d.radiiProduct && d.gateM > deepest)
      deepest = d.gateM;
  }
  return deepest === -Infinity ? gate.requestedDepthM : deepest;
}

/**
 * The most permissive gate anywhere in the field — the SEGMENT-level scalar
 * #243's comfort ramp is anchored at. For a `UniformGate` this is the gate
 * itself, which is what keeps every pre-#452 `edgeFactor` call byte-identical.
 */
export function gateFloorM(gate: DepthGate): number {
  return gate.kind === 'uniform' ? gate.gateM : gate.minGateM;
}
