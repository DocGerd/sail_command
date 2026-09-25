import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NavMask } from '../lib/mask';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { solve } from '../routing/isochrone';
import { findRelaxedGate } from '../routing/relaxedDepth';
import { uniformWindGrid } from './fixtures';
import { uniformGate } from '../lib/depthGate';
import { defaultSafetyDepthM, relaxationFloorM } from '../lib/boatDepth';
import { BOATS, boatById, DEFAULT_BOAT_ID, polarKey } from '../data/boats';
import type {
  LatLon,
  Leg,
  MaskMeta,
  PlanResultOk,
  PolarTable,
  RigResult,
  SailId,
  Settings,
} from '../types';

// #878: shared fixtures/helpers extracted from the former single
// realmask.repro.test.ts (~1286 lines, five top-level describe blocks) so
// vitest can parallelise the real-mask suite across files/cores instead of
// running it as one monopolizing file. This module is PURE RELOCATION of
// that file's module-scope setup (lines 1-302 at the point of the split,
// `bca2561`) — no logic changed, no case renamed, no assertion tightened.
// Every `realmask.repro.*.test.ts` sibling imports from here.
//
// This file is deliberately NOT itself a `*.test.ts` — it carries no
// `describe`/`it` calls, so vitest's `test.include` glob never collects it
// as a test file, and each importing test file still fully controls its own
// `vi.setConfig({ testTimeout: ... })` (that call must stay in each test
// file, not here — see each sibling's own top-of-file comment).
//
// Regression tests for issue #20: the solver returned 'unreachable' for real
// harbor-to-harbor routes because a full isochrone step (0.5-2 km) is longer
// than real harbor arms are straight (~200-400 m wide), so every candidate
// died on the first expansion. These run against the real shipped mask and
// polars, unlike the synthetic masks used everywhere else in the suite.

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
export const mask = new NavMask(
  maskMeta,
  new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))),
);
export const polarGenoa = JSON.parse(
  readFileSync(resolve(dataDir, 'polars', 'salona-45-genoa.json'), 'utf8'),
) as PolarTable;
export const polarFock = JSON.parse(
  readFileSync(resolve(dataDir, 'polars', 'salona-45-fock.json'), 'utf8'),
) as PolarTable;

// #653: the Salona 44 "SPEEDY GO!" polars, for the second-boat coverage in
// the `#653` describe block (realmask.repro.salona44.test.ts). Real shipped
// assets (`build_polars.mjs` output), not a fixture.
const polarGenoa44 = JSON.parse(
  readFileSync(resolve(dataDir, 'polars', 'salona-44-speedy-go-genoa.json'), 'utf8'),
) as PolarTable;
const polarFock44 = JSON.parse(
  readFileSync(resolve(dataDir, 'polars', 'salona-44-speedy-go-fock.json'), 'utf8'),
) as PolarTable;

// #54: PlanDeps carries polars keyed `${boatId}/${sailId}` instead of two
// named fields. `deep-test` is the hypothetical 2.30 m boat the spec C.4(a)
// safety rows plan with — it is deliberately absent from BOATS, so its keys
// must be supplied here rather than derived from the catalogue.
export const polars: Record<string, PolarTable> = {
  [polarKey(DEFAULT_BOAT_ID, 'genoa')]: polarGenoa,
  [polarKey(DEFAULT_BOAT_ID, 'fock')]: polarFock,
  [polarKey('deep-test', 'genoa')]: polarGenoa,
  [polarKey('deep-test', 'fock')]: polarFock,
  [polarKey('salona-44-speedy-go', 'genoa')]: polarGenoa44,
  [polarKey('salona-44-speedy-go', 'fock')]: polarFock44,
};

export const SALONA_DEPS = { polars, boat: boatById(DEFAULT_BOAT_ID), mask };
// #653: the harness must plan for a boat OTHER than DEFAULT_BOAT_ID at least
// once against the real mask/polars — see the `#653` describe block
// (realmask.repro.salona44.test.ts) for why (issue #653's own concern: a
// boatDepth.ts/depthGate.ts regression correct for the Salona 45's gate but
// wrong for a different per-boat gate was invisible to every case in this
// suite before that describe block existed).
export const SALONA44_DEPS = { polars, boat: boatById('salona-44-speedy-go'), mask };

// Real harbor snap coordinates from harbors.json
export const FLENSBURG: LatLon = { lat: 54.798, lon: 9.4335 };
export const GLUECKSBURG: LatLon = { lat: 54.8415, lon: 9.5225 };
export const MARSTAL: LatLon = { lat: 54.8579, lon: 10.528 };
export const SOENDERBORG: LatLon = { lat: 54.9046, lon: 9.7833 };
export const BAGENKOP: LatLon = { lat: 54.753, lon: 10.668 };
export const AEROESKOEBING: LatLon = { lat: 54.8935, lon: 10.416 };
export const DREJOE: LatLon = { lat: 54.9645, lon: 10.439 };
// Open-water anchors (navigable at 3.0 m in the shipped mask)
export const FJORD_MOUTH: LatLon = { lat: 54.83, lon: 9.9 };
export const OPEN_BALTIC: LatLon = { lat: 54.75, lon: 10.3 };

export const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);

/** #54: the pre-#54 shape had a direct `res.genoa`/`res.fock` field per sail;
 * this suite leaned on that shape heavily. Rather than rewrite every call
 * site to walk `res.sails` inline, this one helper preserves the exact
 * pre-#54 access pattern (`sailResult(res, 'genoa')` reads identically to
 * the old `res.genoa`) so the diff stayed about the shape change, not a
 * rewrite of what each test actually asserts. */
export function sailResult(res: PlanResultOk, sailId: SailId): RigResult | null {
  return res.sails.find((s) => s.sailId === sailId)?.result ?? null;
}

export function solveGenoa(
  origin: LatLon,
  destination: LatLon,
  dirFromDeg: number,
  settings: Settings,
  onProgress?: (info: { tMs: number; frontierSize: number }) => void,
) {
  const o = mask.snapToNavigable(origin, settings.safetyDepthM);
  const d = mask.snapToNavigable(destination, settings.safetyDepthM);
  if (!o || !d) throw new Error('snap failed');
  return solve({
    origin: o,
    destination: d,
    departureMs: T0,
    polar: new Polar(polarGenoa, settings.performanceFactor),
    wind: new WindField(uniformWindGrid(12, dirFromDeg)),
    mask,
    settings,
    onProgress,
  });
}

/** Every leg the planner emits must itself be navigable at the plan's safety depth. */
export function expectLegsNavigable(legs: Leg[], safetyDepthM: number) {
  for (const leg of legs)
    expect(
      mask.segmentNavigable(leg.start, leg.end, uniformGate(safetyDepthM)),
      `leg ${JSON.stringify(leg.start)} -> ${JSON.stringify(leg.end)} crosses non-navigable water`,
    ).toBe(true);
}

/**
 * #243 §E's EXACT sub-threshold exposure metric: sample each leg every
 * ~15 m (well under the 46 m cell) and sum the sampled length whose cell is
 * charted below `thresholdM`. A whole-leg ("charge the leg if any cell is
 * shallow") metric over-states exposure by 3-4x and is not comparable across
 * routes with different leg counts — never use one for this feature.
 */
export function exposureNm(legs: Leg[], thresholdM: number): number {
  const STEP_NM = 15 / 1852;
  let nm = 0;
  for (const leg of legs) {
    const n = Math.max(2, Math.ceil(leg.distanceNm / STEP_NM));
    const seg = leg.distanceNm / n;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p: LatLon = {
        lat: leg.start.lat + (leg.end.lat - leg.start.lat) * t,
        lon: leg.start.lon + (leg.end.lon - leg.start.lon) * t,
      };
      const info = mask.depthInfoM(p);
      const d = info.capped ? 25.4 : info.depthM;
      if (d < thresholdM) nm += seg;
    }
  }
  return nm;
}

// ---------------------------------------------------------------------------
// #452 / #494 approach-disc geometry, shared by the #452 route-wide test
// (realmask.repro.issue20.marstalMargin0.test.ts) and the #494 per-leg assertions at the
// two RELAXED-path call sites.
//
// Hoisted to module scope by #494 rather than copied: two independent
// haversines in one file is exactly the kind of duplicated prose-and-arithmetic
// that drifts silently. It still never calls into depthGate.ts, so needle and
// haystack stay independently sourced — the implementation tests an ELLIPSE in
// grid space (a linearised metres-per-degree at the waypoint's own latitude)
// while everything here measures an exact haversine.
// ---------------------------------------------------------------------------

const R_EARTH_M = 6_371_000;
const toRadLocal = (d: number) => (d * Math.PI) / 180;
export function metresBetween(a: LatLon, b: LatLon): number {
  const dLat = toRadLocal(b.lat - a.lat);
  const dLon = toRadLocal(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadLocal(a.lat)) * Math.cos(toRadLocal(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(h));
}

/**
 * The cell CENTRE is what disc membership is defined on. #1451: routed
 * through `mask.grid`'s exact integer-cells-per-degree axes (#1259) rather
 * than a bbox-quotient step, so this fixture cannot drift from the
 * production convention `mask.ts` itself uses.
 */
export function centreOf(p: LatLon): LatLon {
  return {
    lat: mask.grid.lat.centre(mask.grid.lat.index(p.lat)),
    lon: mask.grid.lon.centre(mask.grid.lon.index(p.lon)),
  };
}

/**
 * The 1 nm approach radius plus a 2% allowance for the grid-ellipse vs.
 * haversine difference described above (well under 1% over 1852 m).
 *
 * The 1852 is a LITERAL on purpose — deriving it from `depthGate.ts`'s
 * `APPROACH_RADIUS_M` (imported directly in the #54 spec C.4(a) file) would
 * make needle and haystack the same source, so raising the production
 * radius would raise this bound with it and no assertion here could ever red.
 */
export const APPROACH_LIMIT_M = 1852 * 1.02;

/**
 * Every cell charted below `requestedDepthM` that these legs actually cross,
 * with each one's distance to `anchor`'s cell centre.
 *
 * Samples well below the ~46 m cell pitch, so any cell crossed for more than a
 * step is seen; a corner-clip shorter than one step can still be missed, which
 * is why callers are sized to catch gross violations kilometres out rather than
 * to certify an exact zero.
 */
function subRequestedCrossings(
  legs: Leg[],
  requestedDepthM: number,
  anchor: LatLon,
): { depthM: number; metresFromAnchor: number }[] {
  const out: { depthM: number; metresFromAnchor: number }[] = [];
  for (const leg of legs) {
    const legM = metresBetween(leg.start, leg.end);
    const steps = Math.max(2, Math.ceil(legM / 10));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p: LatLon = {
        lat: leg.start.lat + (leg.end.lat - leg.start.lat) * t,
        lon: leg.start.lon + (leg.end.lon - leg.start.lon) * t,
      };
      const info = mask.depthInfoM(p);
      // Deep-capped cells are a floor, never a shallow reading (#53).
      if (info.capped || info.depthM >= requestedDepthM) continue;
      out.push({ depthM: info.depthM, metresFromAnchor: metresBetween(anchor, centreOf(p)) });
    }
  }
  return out;
}

/**
 * #494 §(a): the PER-LEG half of what `exposureNm(legs, 3.0) < 0.6` already
 * bounds at the route level — the relaxed gate may license sub-requested water
 * at the PINCH that forced the relaxation, and nowhere else.
 *
 * Stronger than the #452 mechanism guarantees, deliberately. `gateAtCell`
 * returns `requestedDepthM` outside EVERY disc, so "within one approach disc of
 * SOME waypoint" is a theorem of the shipped gate; this asserts confinement to
 * ONE NAMED waypoint, which the origin's own disc could legitimately violate.
 *
 * MEASURED, both halves, 2026-08-20. Headroom: the farthest sub-requested cell
 * on either passage sits 0.667 nm from the Marstal snap, against the 1.02 nm
 * bound. Discriminating probe: passing `res.snappedOrigin` here instead reds
 * BOTH call sites — "2.9 m at 38.36 nm from the pinch" (Flensburg) and
 * "2.9 m at 7.32 nm from the pinch" (Bagenkop) — so the bound is tight, the
 * crossing set is real, and the two anchors are not interchangeable.
 *
 * WHAT THIS DOES NOT CLAIM, at the two DEFAULT_SETTINGS call sites. Three
 * localization-reverting mutations were run against both, and ALL THREE left
 * every farthest distance INSIDE the bound — which is the claim; the distances
 * themselves are not all unchanged, and saying so was the sharper statement:
 * `APPROACH_RADIUS_M = Infinity` (the documented pre-#452 route-wide kill
 * switch) moves the Flensburg GENOA from 0.607 to 0.572 nm as its leg count
 * goes 22 -> 31, while the Flensburg fock (0.667 nm) and Bagenkop (0.607 nm)
 * legs stay byte-identical; `APPROACH_RADIUS_M = 20000` leaves every farthest
 * distance at 0.607/0.667 nm though the Flensburg genoa still moves (22 -> 27
 * legs, 54 -> 61 crossings); `findRelaxedGate`'s phase-2 per-disc ascent
 * disabled is byte-identical to baseline on all four SOLVER rig/route
 * combinations the probe measured (both rigs on both passages) — a superset of
 * the three calls the assertions at these two sites actually make, since the
 * Flensburg test loops both rigs while the Bagenkop one checks only the
 * recommended rig.
 * So the mutations reach, and the assertion does not see them. At
 * DEFAULT_SETTINGS the #243 comfort preference already holds these routes in
 * deep water everywhere but the pinch, so a gate-localization regression is NOT
 * detectable at those two sites. It IS detectable at the third call site — the
 * `depthComfortMarginM: 0` test in realmask.repro.issue20.marstalMargin0.test.ts, added by
 * the #494 review — so read the DEFAULT_SETTINGS pair as a structural pin plus
 * a disclosure check, and the margin-0 call as the locality detector.
 */
export function expectRelaxedWaterConfinedToPinch(
  legs: Leg[],
  requestedDepthM: number,
  pinch: LatLon,
  label: string,
) {
  const crossings = subRequestedCrossings(legs, requestedDepthM, pinch);
  // LICENCE, and it must come first: the confinement assertion below is an
  // ABSENCE assertion, and an empty crossing set satisfies it while proving
  // nothing. This is the row that establishes there was anything to confine.
  expect(
    crossings.length,
    `${label}: the route crosses NO cell below ${requestedDepthM} m, so the confinement assertion below would pass vacuously`,
  ).toBeGreaterThan(0);
  // Report the offending cells, not a bare boolean: at 3am in CI the depth and
  // the distance are the whole diagnostic.
  const strays = crossings
    .filter((c) => c.metresFromAnchor > APPROACH_LIMIT_M)
    .map(
      (c) =>
        `${c.depthM.toFixed(1)} m at ${(c.metresFromAnchor / 1852).toFixed(2)} nm from the pinch`,
    );
  expect(strays.slice(0, 10), label).toEqual([]);
}

// ---------------------------------------------------------------------------
// #930 R3 relaxation-trade harness helpers (#1261 move). Pure relocation of
// code that was duplicated verbatim across relaxationTrade.differential.test.ts
// and its three realmask.repro.relaxationTrade.originMarstal/originFlensburg/
// destinationMarstal.test.ts population siblings — no logic changed. See
// relaxationTrade.differential.test.ts's own #1261 comment for why the split
// exists and why the helpers live here rather than in a per-population copy.
// ---------------------------------------------------------------------------

export interface RelaxationTradeHarbor {
  id: string;
  snap: LatLon;
}

const relaxationTradeHarbors = JSON.parse(
  readFileSync(resolve(dataDir, 'harbors.json'), 'utf8'),
) as RelaxationTradeHarbor[];

/**
 * `planRoute`'s own snap at the requested gate; null means `planRoute` returns
 * `snap-failed-*` and never reaches relaxation.
 */
export function relaxationTradeSnapAt(h: RelaxationTradeHarbor, requestedM: number): LatLon | null {
  return mask.snapToNavigable(h.snap, requestedM);
}

function relaxationTradeHarbor(id: string): RelaxationTradeHarbor {
  const h = relaxationTradeHarbors.find((x) => x.id === id);
  if (!h) throw new Error(`fixture drift: '${id}' missing from harbors.json`);
  return h;
}

/**
 * Snapped (origin, harbour) pairs for every other harbour. Pairs whose snap
 * fails are returned separately so the caller logs them — never dropped silently.
 */
export function relaxationTradeSnappedPairs(
  originId: string,
  requestedM: number,
  reversed = false,
): { pairs: { id: string; waypoints: LatLon[] }[]; snapFailed: string[] } {
  const origin = relaxationTradeSnapAt(relaxationTradeHarbor(originId), requestedM);
  if (!origin) throw new Error(`origin '${originId}' fails to snap at ${requestedM} m`);
  const pairs: { id: string; waypoints: LatLon[] }[] = [];
  const snapFailed: string[] = [];
  for (const h of relaxationTradeHarbors) {
    if (h.id === originId) continue;
    const dest = relaxationTradeSnapAt(h, requestedM);
    if (dest) pairs.push({ id: h.id, waypoints: reversed ? [dest, origin] : [origin, dest] });
    else snapFailed.push(h.id);
  }
  return { pairs, snapFailed };
}

export interface RelaxationTradeDepthCase {
  /** Catalogue boats sharing this (gate, floor) pair — deduplicated, never dropped. */
  readonly boatIds: readonly string[];
  readonly requestedM: number;
  readonly floorM: number;
}

// Each boat's OWN default gate and relaxation floor, derived from the
// catalogue. Boats with an identical pair would repeat the same computation,
// so they share one case; the merge is logged, not silent.
export const RELAXATION_TRADE_DEPTH_CASES: readonly RelaxationTradeDepthCase[] = (() => {
  const byKey = new Map<string, { boatIds: string[]; requestedM: number; floorM: number }>();
  for (const b of BOATS) {
    const requestedM = defaultSafetyDepthM(b);
    const floorM = relaxationFloorM(b);
    const key = `${requestedM}/${floorM}`;
    const existing = byKey.get(key);
    if (existing) existing.boatIds.push(b.id);
    else byKey.set(key, { boatIds: [b.id], requestedM, floorM });
  }
  return [...byKey.values()];
})();

function relaxationTradeUsedDepthM(
  m: NavMask,
  waypoints: readonly LatLon[],
  requestedM: number,
  radiusM: number,
  floorM: number,
): number | null {
  return findRelaxedGate(m, [...waypoints], requestedM, radiusM, floorM)?.usedDepthM ?? null;
}

export interface RelaxationTradeRow {
  id: string;
  /** Snapped pair disconnected at the requested gate (BFS). */
  relevant: boolean;
  localUsedDepthM: number | null;
  globalUsedDepthM: number | null;
}

export function measureRelaxationTrade(
  m: NavMask,
  pairs: readonly { id: string; waypoints: readonly LatLon[] }[],
  requestedM: number,
  floorM: number,
  localRadiusM: number,
): RelaxationTradeRow[] {
  return pairs.map(({ id, waypoints }) => ({
    id,
    relevant: !m.cellsConnected(waypoints[0], waypoints[1], uniformGate(requestedM)),
    localUsedDepthM: relaxationTradeUsedDepthM(m, waypoints, requestedM, localRadiusM, floorM),
    globalUsedDepthM: relaxationTradeUsedDepthM(m, waypoints, requestedM, Infinity, floorM),
  }));
}

/**
 * THE TRIPWIRE: per pair, the shipped radius must give the same outcome
 * (null vs non-null) and the same relaxed gate as the global search. The gate
 * FIELD necessarily differs (approach vs uniform); `usedDepthM` is what the
 * plan reports.
 */
export function expectRelaxationTradeRadiusInvariant(
  rows: readonly RelaxationTradeRow[],
  label: string,
): void {
  if (rows.length === 0) throw new Error(`${label}: empty population — nothing measured`);
  for (const r of rows) {
    expect(
      r.localUsedDepthM,
      `${label} ${r.id}: local usedDepthM ${r.localUsedDepthM} != global ${r.globalUsedDepthM} — ` +
        `the per-disc trade bites here.\n${JSON.stringify(rows)}`,
    ).toBe(r.globalUsedDepthM);
  }
}

/** Consistency checks only: both CANNOT fail given the code (subset argument above). */
export function expectRelaxationTradeSubsetConsistency(
  rows: readonly RelaxationTradeRow[],
  label: string,
): void {
  for (const r of rows) {
    if (r.localUsedDepthM === null) continue;
    expect(r.globalUsedDepthM, `${label} ${r.id}: local relaxed, global did not`).not.toBeNull();
    expect(r.localUsedDepthM, `${label} ${r.id}: local <= global`).toBeLessThanOrEqual(
      r.globalUsedDepthM as number,
    );
  }
}
