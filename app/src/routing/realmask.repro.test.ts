import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NavMask } from '../lib/mask';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { solve } from './isochrone';
import { mergeCollinearLegs } from './postprocess';
import { planRoute } from './planRoute';
import { findRelaxedGate } from './relaxedDepth';
import { uniformWindGrid } from '../test/fixtures';
import { APPROACH_RADIUS_M, uniformGate } from '../lib/depthGate';
import { boatById, DEFAULT_BOAT_ID, polarKey, type BoatDef } from '../data/boats';
import { DEFAULT_SETTINGS } from '../types';
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
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { boatSnapshot, defaultBoatSnapshot } from '../types';

// #54: the pre-#54 shape had a direct `res.genoa`/`res.fock` field per sail;
// this test file leaned on that shape heavily (11 planRoute() calls). Rather
// than rewrite every call site to walk `res.sails` inline, this one helper
// preserves the exact pre-#54 access pattern (`sailResult(res, 'genoa')`
// reads identically to the old `res.genoa`) so the diff stays about the
// shape change, not a rewrite of what each test actually asserts.
function sailResult(res: PlanResultOk, sailId: SailId): RigResult | null {
  return res.sails.find((s) => s.sailId === sailId)?.result ?? null;
}

// Regression tests for issue #20: the solver returned 'unreachable' for real
// harbor-to-harbor routes because a full isochrone step (0.5-2 km) is longer
// than real harbor arms are straight (~200-400 m wide), so every candidate
// died on the first expansion. These run against the real shipped mask and
// polars, unlike the synthetic masks used everywhere else in the suite.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
const mask = new NavMask(maskMeta, new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))));
const polarGenoa = JSON.parse(
  readFileSync(resolve(dataDir, 'polars', 'salona-45-genoa.json'), 'utf8'),
) as PolarTable;
const polarFock = JSON.parse(
  readFileSync(resolve(dataDir, 'polars', 'salona-45-fock.json'), 'utf8'),
) as PolarTable;

// #653: the Salona 44 "SPEEDY GO!" polars, for the second-boat coverage
// added to this file's `#653` describe block below. Real shipped assets
// (`build_polars.mjs` output), not a fixture.
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
const polars: Record<string, PolarTable> = {
  [polarKey(DEFAULT_BOAT_ID, 'genoa')]: polarGenoa,
  [polarKey(DEFAULT_BOAT_ID, 'fock')]: polarFock,
  [polarKey('deep-test', 'genoa')]: polarGenoa,
  [polarKey('deep-test', 'fock')]: polarFock,
  [polarKey('salona-44-speedy-go', 'genoa')]: polarGenoa44,
  [polarKey('salona-44-speedy-go', 'fock')]: polarFock44,
};

const SALONA_DEPS = { polars, boat: boatById(DEFAULT_BOAT_ID), mask };
// #653: the harness must plan for a boat OTHER than DEFAULT_BOAT_ID at least
// once against the real mask/polars — see this file's `#653` describe block
// for why (issue #653's own concern: a boatDepth.ts/depthGate.ts regression
// correct for the Salona 45's gate but wrong for a different per-boat gate
// was invisible to every case in this file before this one).
const SALONA44_DEPS = { polars, boat: boatById('salona-44-speedy-go'), mask };

// Real harbor snap coordinates from harbors.json
const FLENSBURG: LatLon = { lat: 54.798, lon: 9.4335 };
const GLUECKSBURG: LatLon = { lat: 54.8415, lon: 9.5225 };
const MARSTAL: LatLon = { lat: 54.8579, lon: 10.528 };
const SOENDERBORG: LatLon = { lat: 54.9046, lon: 9.7833 };
const BAGENKOP: LatLon = { lat: 54.753, lon: 10.668 };
const AEROESKOEBING: LatLon = { lat: 54.8935, lon: 10.416 };
const DREJOE: LatLon = { lat: 54.9645, lon: 10.439 };
// Open-water anchors (navigable at 3.0 m in the shipped mask)
const FJORD_MOUTH: LatLon = { lat: 54.83, lon: 9.9 };
const OPEN_BALTIC: LatLon = { lat: 54.75, lon: 10.3 };

const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);

function solveGenoa(
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
function expectLegsNavigable(legs: Leg[], safetyDepthM: number) {
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
function exposureNm(legs: Leg[], thresholdM: number): number {
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
// #452 / #494 approach-disc geometry, shared by the #452 route-wide test below
// and the #494 per-leg assertions at the two RELAXED-path call sites.
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
function metresBetween(a: LatLon, b: LatLon): number {
  const dLat = toRadLocal(b.lat - a.lat);
  const dLon = toRadLocal(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadLocal(a.lat)) * Math.cos(toRadLocal(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(h));
}

const CELL_LAT_STEP = (maskMeta.north - maskMeta.south) / maskMeta.rows;
const CELL_LON_STEP = (maskMeta.east - maskMeta.west) / maskMeta.cols;
/** The cell CENTRE is what disc membership is defined on. */
function centreOf(p: LatLon): LatLon {
  return {
    lat:
      maskMeta.south + (Math.floor((p.lat - maskMeta.south) / CELL_LAT_STEP) + 0.5) * CELL_LAT_STEP,
    lon:
      maskMeta.west + (Math.floor((p.lon - maskMeta.west) / CELL_LON_STEP) + 0.5) * CELL_LON_STEP,
  };
}

/**
 * The 1 nm approach radius plus a 2% allowance for the grid-ellipse vs.
 * haversine difference described above (well under 1% over 1852 m).
 *
 * The 1852 is a LITERAL on purpose — deriving it from `depthGate.ts`'s
 * `APPROACH_RADIUS_M` (imported in this file for the #54 rows) would make
 * needle and haystack the same source, so raising the production radius would
 * raise this bound with it and no assertion here could ever red.
 */
const APPROACH_LIMIT_M = 1852 * 1.02;

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
 * `depthComfortMarginM: 0` test below, added by the #494 review — so read the
 * DEFAULT_SETTINGS pair as a structural pin plus a disclosure check, and the
 * margin-0 call as the locality detector.
 */
function expectRelaxedWaterConfinedToPinch(
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

describe('real mask routing (issue #20)', () => {
  it('open water sanity: fjord mouth -> open baltic', () => {
    const res = solveGenoa(FJORD_MOUTH, OPEN_BALTIC, 270, DEFAULT_SETTINGS);
    expect(res.status).toBe('ok');
  });

  it('Flensburg -> Gluecksburg routes at default settings (the issue #20 repro)', () => {
    const res = planRoute(
      {
        origin: FLENSBURG,
        destination: GLUECKSBURG,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'gluecksburg',
        departureMs: T0,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      uniformWindGrid(12, 270),
      SALONA_DEPS,
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    for (const rig of [sailResult(res, 'genoa'), sailResult(res, 'fock')]) {
      expect(rig).not.toBeNull();
      // ~4 nm; anything over 1.5 h means the solver padded its way out
      expect(rig!.durationMs).toBeLessThan(1.5 * 3_600_000);
      expectLegsNavigable(rig!.legs, DEFAULT_SETTINGS.safetyDepthM);
    }
  });

  it('progress reports the true frontier clock, not the ring clock, under substeps', () => {
    // Out of Flensburg every full-step candidate is blocked (that was the bug),
    // so the entire first frontier consists of substepped children with clocks
    // at most dtS/2 = 150 s past departure. The ring clock would report
    // T0 + 300 s here; the frontier clock must not.
    const reports: number[] = [];
    const res = solveGenoa(FLENSBURG, GLUECKSBURG, 270, DEFAULT_SETTINGS, ({ tMs }) =>
      reports.push(tMs),
    );
    expect(res.status).toBe('ok');
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toBeGreaterThan(T0);
    expect(reports[0]).toBeLessThan(T0 + 300_000);
    for (let i = 1; i < reports.length; i++)
      expect(reports[i]).toBeGreaterThanOrEqual(reports[i - 1]);
  });

  it('Flensburg -> Gluecksburg routes under any wind direction', () => {
    for (const dir of [0, 90, 135, 180, 315]) {
      const res = solveGenoa(FLENSBURG, GLUECKSBURG, dir, DEFAULT_SETTINGS);
      expect(res.status, `wind from ${dir}`).toBe('ok');
    }
  });

  // Direct-request case (Flensburg -> Marstal at an explicit 2.3 m),
  // runtime-heavy: ~45 s locally (~40 s before #21's clock-aware visited
  // pruning deliberately widened the search; CI is measurably slower than
  // dev machines, hence the generous timeout — the 600 s base budget below
  // has ample headroom over 45 s regardless of the exact ratio).
  //
  // Runs at safetyDepthM 2.3: in the shipped mask Marstal's snap cell sits in
  // a 119-cell pocket that only 4-connects to open water at gate depths
  // <= 2.3 m (EMODnet can't resolve the dredged approach channel at 46 m
  // cells; see CONNECTIVITY_EXCEPTIONS_M in pipeline/verify_mask.py and PR
  // #8). A user explicitly planning at 2.3 m gets a plain route with no
  // shallow warnings — nothing was relaxed. The former note here ("at 3.0 m
  // 'unreachable' is the CORRECT answer for this data") is superseded by
  // #53's graceful degradation: the DEFAULT_SETTINGS spec acceptance case
  // below now expects a route WITH shallow warnings instead.
  it(
    'Flensburg -> Marstal (direct request at 2.3 m safety depth)',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const settings: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 2.3 };
      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings,
          sailIds: ['genoa', 'fock'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(12, 270),
        SALONA_DEPS,
      );
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      // Explicitly-requested 2.3 m needs no relaxation: no shallow warnings.
      expect('shallow' in res).toBe(false);
      const rig = sailResult(res, res.recommended);
      expect(rig).not.toBeNull();
      // ~38 nm great-circle; sane plans stay inside these envelopes
      expect(rig!.distanceNm).toBeGreaterThan(30);
      expect(rig!.durationMs).toBeLessThan(12 * 3_600_000);
      expectLegsNavigable(rig!.legs, settings.safetyDepthM);
    },
  );

  // Spec acceptance case for #53 (graceful degradation below safety depth):
  // Flensburg -> Marstal at DEFAULT_SETTINGS (3.0 m) returns a route WITH
  // shallow warnings instead of 'unreachable'. usedDepthM = 2.3 was derived
  // INDEPENDENTLY of the router: a standalone stack-based flood fill over the
  // raw committed mask.bin reports the Flensburg/Marstal snap cells connected
  // at every decimeter gate <= 2.3 m and disconnected at >= 2.4 m. That 2.3 m
  // is the measured reconnection threshold recorded in the PROSE comment of
  // pipeline/verify_mask.py's CONNECTIVITY_EXCEPTIONS_M["marstal"] entry; the
  // entry's actual gate VALUE is 2.0 m — a deliberate safety margin below the
  // 2.3 m, used only for the pipeline's connectivity self-check, never for
  // routing. The in-test cellsConnected assertions below cross-check the
  // shipped BFS against the 2.3 m reconnection literal. Runtime ≈ the 2.3 m
  // case above (the disconnection fast path skips the doomed 3.0 m solves;
  // the relaxed solve does the same work as a direct 2.3 m plan), hence the
  // same generous timeout.
  it(
    'Flensburg -> Marstal at DEFAULT_SETTINGS degrades gracefully with shallow warnings (#53)',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const o = mask.snapToNavigable(FLENSBURG, DEFAULT_SETTINGS.safetyDepthM);
      const d = mask.snapToNavigable(MARSTAL, DEFAULT_SETTINGS.safetyDepthM);
      expect(o).not.toBeNull();
      expect(d).not.toBeNull();
      // The independently-derived connectivity flip pinning usedDepthM = 2.3:
      expect(mask.cellsConnected(o!, d!, uniformGate(2.3))).toBe(true);
      expect(mask.cellsConnected(o!, d!, uniformGate(2.4))).toBe(false);

      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings: DEFAULT_SETTINGS,
          sailIds: ['genoa', 'fock'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(12, 270),
        SALONA_DEPS,
      );
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      expect(res.shallow).toBeDefined();
      expect(res.shallow!.requestedDepthM).toBe(3.0);
      expect(res.shallow!.usedDepthM).toBeCloseTo(2.3, 6);
      // Every traversed cell is >= the 2.3 m gate, and the warning only exists
      // because something charted below 3.0 m was actually crossed.
      expect(res.shallow!.minGateDepthM).toBeGreaterThanOrEqual(2.3);
      expect(res.shallow!.minGateDepthM).toBeLessThan(3.0);
      for (const rig of [sailResult(res, 'genoa'), sailResult(res, 'fock')]) {
        expect(rig).not.toBeNull();
        expect(rig!.distanceNm).toBeGreaterThan(30);
        expect(rig!.durationMs).toBeLessThan(12 * 3_600_000);
        expectLegsNavigable(rig!.legs, res.shallow!.usedDepthM);
        // #494 §(a): `expectLegsNavigable` above checks the CHOSEN gate
        // (2.3 m), which by construction cannot see anything the relaxation
        // licensed. This is the missing per-leg half: the sub-requested water
        // it licensed is confined to the Marstal approach — the pinch the two
        // `cellsConnected` rows at the top of this test identify as the reason
        // the relaxation happened at all.
        expectRelaxedWaterConfinedToPinch(
          rig!.legs,
          res.shallow!.requestedDepthM,
          res.snappedDestination,
          'Flensburg -> Marstal: relaxed water away from the Marstal pinch',
        );
        const flagged = rig!.legs.filter((l) => l.shallow);
        expect(flagged.length).toBeGreaterThan(0);
        for (const leg of flagged) {
          expect(leg.shallow!.minDepthM).toBeGreaterThanOrEqual(res.shallow!.minGateDepthM);
          expect(leg.shallow!.minDepthM).toBeLessThan(3.0);
        }
      }
    },
  );

  // #452's INVARIANT, asserted directly against the real mask: no leg of a
  // returned plan crosses a cell charted below the requested depth unless
  // that cell lies within APPROACH_RADIUS_M of a snapped waypoint.
  //
  // WHY depthComfortMarginM: 0 SPECIFICALLY, and why this test is worthless
  // at DEFAULT_SETTINGS. The maintainer's own measurement on issue #452
  // (2026-08-07T21:04:54Z) records that at DEFAULT settings the sub-requested
  // crossings on this passage are ALREADY "all inside ~1 km of the Marstal
  // approach" — so at DEFAULT the assertion below holds with or without the
  // fix, and the kill-switch mutation would not red it. At margin 0 that same
  // measurement records "5 separate sites spread along the whole passage",
  // two of them inside Flensburg Fjord roughly 40 nm from the pinch. Margin 0
  // is therefore the only configuration in which this assertion has teeth.
  //
  // The geometry here is computed from the leg polylines and the plan's own
  // snapped waypoints with a local haversine — it never calls into
  // depthGate.ts, so needle and haystack are independently sourced.
  it(
    '#452: at margin 0, every sub-requested cell the route crosses lies within one approach disc',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 0 };
      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings,
          sailIds: ['genoa', 'fock'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(12, 270),
        SALONA_DEPS,
      );
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;

      const anchors = [res.snappedOrigin, res.snappedDestination];
      // `metresBetween`, `centreOf` and `APPROACH_LIMIT_M` moved to module
      // scope in #494 so the two relaxed-path call sites share this exact
      // geometry instead of re-deriving it. The 2% allowance they carry
      // absorbs the grid-ellipse vs. haversine difference without weakening
      // anything that matters here: reverting to the pre-#452 route-wide gate
      // (spike §3, M8) reds this test with offenders 7.46-8.01 nm from the
      // nearest waypoint — 12.0-13.0 km past the 1852 m radius, against a
      // 37 m allowance.
      const LIMIT_M = APPROACH_LIMIT_M;

      const offenders: string[] = [];
      for (const rig of [sailResult(res, 'genoa'), sailResult(res, 'fock')]) {
        if (!rig) continue;
        for (const leg of rig.legs) {
          // Sample well below the ~46 m cell pitch, so any cell crossed for
          // more than a step is seen; a corner-clip shorter than one step can
          // still be missed, which is why this test is sized to catch gross
          // violations kilometres out rather than to certify an exact zero.
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
            if (info.capped || info.depthM >= settings.safetyDepthM) continue;
            const centre = centreOf(p);
            const nearestM = Math.min(...anchors.map((a) => metresBetween(a, centre)));
            if (nearestM > LIMIT_M)
              offenders.push(
                `${info.depthM.toFixed(1)} m at ${centre.lat.toFixed(4)},${centre.lon.toFixed(4)} — ${(nearestM / 1852).toFixed(2)} nm from the nearest waypoint`,
              );
          }
        }
        // #494 review F1/F2: the PINCH-anchored form of the same bound, at the
        // ONE configuration in this file where it can red — and the licence row
        // this test otherwise lacks entirely (`offenders` empty because nothing
        // was crossed reads identically to `offenders` empty because everything
        // was confined; MEASURED 172 crossings at baseline, but nothing pinned
        // that).
        //
        // NOT redundant with the `nearestM` bound above, and not a second copy
        // of it. `gateAtCell` returns the requested depth outside EVERY disc,
        // so "inside SOME disc" is a theorem of the shipped gate and the
        // `nearestM` form can never red for a stray the ORIGIN disc absorbs.
        // Anchoring on the destination alone removes that absorber, which is
        // the residual #494 §(a) actually names. No NEW knife-edge — every
        // baseline crossing here is nearer the destination than the origin, so
        // this bound and the `nearestM` one above are the SAME number on
        // correct behaviour — but the shared headroom is thin in the unit that
        // matters, and that predates #494: MEASURED 83 crossings on the first
        // rig (172 across both), spanning 0.079-0.997 nm from the Marstal snap
        // against the 1.02 nm bound. That leaves 1.02 - 0.997 = 0.023 nm, i.e.
        // ~42 m — which sounds comfortable until it is read against the ~46 m
        // mask cell this file samples below: the margin is under ONE CELL, so a
        // single cell of outward drift at the farthest crossing reds it. State
        // it that way rather than as a bare metre count, which invites exactly
        // the widening the paragraph above rules out. Widening the bound would
        // forfeit the teeth, and the drift would red BOTH assertions anyway,
        // not just this one.
        expectRelaxedWaterConfinedToPinch(
          rig.legs,
          settings.safetyDepthM,
          res.snappedDestination,
          'margin 0: relaxed water away from the Marstal pinch',
        );
      }
      // Report the actual offending cells, not a bare boolean: at 3am in CI
      // the depth and the distance are the whole diagnostic.
      expect(offenders.slice(0, 10)).toEqual([]);
    },
  );
});

describe('#243 depth comfort preference (real mask)', () => {
  // Pre-change (baseline, before #243) literals for Flensburg -> Sonderborg
  // at 270 deg / DEFAULT_SETTINGS, measured independently by running the
  // PRE-#243 planRoute (git show 14fea97:app/src/routing/planRoute.ts)
  // against this exact mask/polar/wind fixture — never copied from this PR's
  // own implementation output (the #50 tautology rule).
  const BASELINE_DURATION_MS = 10_724_310.589355469; // genoa, 2.9790 h

  it('Flensburg -> Sonderborg 270: pins the min-clearance and shallow-exposure change against pre-change literals (G.1)', () => {
    const res = planRoute(
      {
        origin: FLENSBURG,
        destination: SOENDERBORG,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'soenderborg',
        departureMs: T0,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      uniformWindGrid(12, 270),
      SALONA_DEPS,
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const rig = sailResult(res, res.recommended);
    expect(rig).not.toBeNull();
    expectLegsNavigable(rig!.legs, DEFAULT_SETTINGS.safetyDepthM);

    // Today's (pre-#243) route measures 3.1 m minimum and 1.32 nm below
    // 4.0 m. Both thresholds sit far from that baseline AND far from this
    // PR's own measured value (4.1 m / 0.00 nm) — pinning the CHANGE, not
    // either implementation's exact arithmetic (§E.3: the search is
    // heuristic and non-monotone in the tuning constant, so pinning an exact
    // value would convert any future retune into a test edit).
    let min = Infinity;
    for (const leg of rig!.legs) {
      const m = mask.segmentShallowestBelow(leg.start, leg.end, 1e6);
      min = Math.min(min, m === null ? 25.4 : m);
    }
    expect(min).toBeGreaterThan(3.5);
    expect(exposureNm(rig!.legs, 4.0)).toBeLessThan(0.4);

    // Time envelope from independent arithmetic: the pre-change baseline is
    // 2.9790 h; a gate-only (different mechanism) alternative independently
    // measures +1.55%, this PR's own measurement +1.39%. 8% sits far above
    // every measured cost and far below anything indicating the solver
    // started padding.
    expect(rig!.durationMs).toBeGreaterThan(BASELINE_DURATION_MS * 0.92);
    expect(rig!.durationMs).toBeLessThan(BASELINE_DURATION_MS * 1.08);
  });

  // #243 §C.1's regression guard — the most important test in this plan. An
  // earlier (superseded) distance-encoded form of this fix turned this exact
  // passage into 'unreachable': reshuffling which candidate wins a prune
  // bucket in Bagenkop's approach pocket stranded the only surviving path.
  // The shipped (pre-#243) solver itself already only finds genoa here (fock
  // dies) — this test pins the REQUIRED property (still routes, #53's
  // contract intact), not the bonus (this implementation, measured,
  // recovers fock too).
  it(
    'Bagenkop -> Marstal at DEFAULT_SETTINGS still routes (the regression a superseded encoding introduced)',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const res = planRoute(
        {
          origin: BAGENKOP,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'bagenkop',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings: DEFAULT_SETTINGS,
          sailIds: ['genoa', 'fock'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(12, 270),
        SALONA_DEPS,
      );
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      expect(res.shallow).toBeDefined();
      expect(res.shallow!.usedDepthM).toBeCloseTo(2.3, 6);
      const rig = sailResult(res, res.recommended);
      expect(rig).not.toBeNull();
      expectLegsNavigable(rig!.legs, res.shallow!.usedDepthM);
      // #494 §(a): the second RELAXED-path call site. Same pinch as the
      // Flensburg case — Marstal's pocket is what only 4-connects below
      // 2.4 m — reached from the opposite side of the fjord, so the origin
      // anchor is 7.3 nm away here against 38.4 nm there.
      expectRelaxedWaterConfinedToPinch(
        rig!.legs,
        res.shallow!.requestedDepthM,
        res.snappedDestination,
        'Bagenkop -> Marstal: relaxed water away from the Marstal pinch',
      );
    },
  );

  // #243 mechanism-2 assertion (G.4): the relaxed gate no longer licenses
  // sub-requested-depth water along the WHOLE passage — only where the pinch
  // actually forces it. usedDepthM===2.3 proves the relaxation was not
  // removed; the tightened exposure bound proves it was localized.
  // Pre-change literal (measured on develop before #243 existed): 1.33 nm.
  // This PR's own measured value: ~0.23 nm. The 0.6 nm threshold sits
  // strictly between the two.
  it(
    'Flensburg -> Marstal at DEFAULT_SETTINGS: the relaxed gate is localized to the pinch, not the whole passage (G.4, #243 mechanism 2)',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings: DEFAULT_SETTINGS,
          sailIds: ['genoa', 'fock'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(12, 270),
        SALONA_DEPS,
      );
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      expect(res.shallow).toBeDefined();
      expect(res.shallow!.usedDepthM).toBeCloseTo(2.3, 6);
      const rig = sailResult(res, res.recommended);
      expect(rig).not.toBeNull();
      expect(exposureNm(rig!.legs, 3.0)).toBeLessThan(0.6);
    },
  );

  // §G.5: the strongest available guard against the preference leaking into
  // the no-preference path.
  //
  // #455 CHANGED THIS TEST'S METHOD, not just its numbers. It used to pin
  // full-precision float literals captured from the pre-#243 solver
  // (`git show 14fea97`) on the then-committed mask. Those literals were a
  // SNAPSHOT of one route, so they were only valid for one mask — and #455's
  // `TOLERANCE_M` correction legitimately moved the route, which broke the
  // assertion without anything being wrong with the invariant it names.
  // Worse, the route they pinned is one the corrected mask refuses on
  // purpose: its minimum clearance reads 1.8 m under the conservative
  // resampling (fock 2.0 m), i.e. below the 3.0 m gate AND below the boat's
  // 2.1 m draft. The literals had stopped describing a baseline and started
  // encoding the defect.
  //
  // So the claim is now tested as the INVARIANT it actually is, against a
  // reference computed live on whatever mask is committed: with the margin
  // at 0, `planRoute` must produce exactly what the pre-#243 pipeline
  // produces — `solve()` with `SolveParams.comfortDepthM` ABSENT, followed
  // by the same collinear merge with no comfort argument (planRoute.ts's
  // `comfortDepthM` line and its `run()` spread; postprocess.ts's optional
  // 5th parameter). That is byte-for-byte what planRoute did before #243.
  //
  // This is a DIFFERENTIAL test, not the #50 equivalence tautology: the
  // reference is built from `solve` + `mergeCollinearLegs` directly, while
  // the subject is `planRoute` — the layer that could leak a comfort term
  // (a non-zero default margin, an unconditionally-applied derate, comfort
  // surviving from a #53 relaxed tier). Legs are compared wholesale because
  // every scalar `RigResult` field except `etaMs` is a pure function of them
  // (planRoute.ts's `rigResult` literal), and `etaMs` is asserted separately
  // so the clock is covered too.
  it('depthComfortMarginM: 0 takes the pre-#243 path: identical to a solve() carrying NO comfortDepthM (feature-off identity, G.5)', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 0 };
    const res = planRoute(
      {
        origin: FLENSBURG,
        destination: SOENDERBORG,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'soenderborg',
        departureMs: T0,
        settings,
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      uniformWindGrid(12, 270),
      SALONA_DEPS,
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.recommended).toBe('genoa');
    expect('shallow' in res).toBe(false);

    /** The pre-#243 pipeline, reconstructed on today's code and this mask. */
    const preFeatureReference = (table: PolarTable) => {
      const o = mask.snapToNavigable(FLENSBURG, settings.safetyDepthM);
      const d = mask.snapToNavigable(SOENDERBORG, settings.safetyDepthM);
      expect(o, 'origin must snap').not.toBeNull();
      expect(d, 'destination must snap').not.toBeNull();
      const wind = new WindField(uniformWindGrid(12, 270));
      const solved = solve({
        origin: o!,
        destination: d!,
        departureMs: T0,
        polar: new Polar(table, settings.performanceFactor),
        wind,
        mask,
        settings,
        // comfortDepthM DELIBERATELY ABSENT — that absence is the whole
        // point of this reference; never add it "for symmetry".
      });
      expect(solved.status, 'the reference solve must itself succeed').toBe('ok');
      if (solved.status !== 'ok') throw new Error('reference solve failed');
      return {
        legs: mergeCollinearLegs(solved.legs, mask, wind, uniformGate(settings.safetyDepthM)),
        etaMs: solved.etaMs,
      };
    };

    for (const [rig, table] of [
      ['genoa', polarGenoa],
      ['fock', polarFock],
    ] as const) {
      const ref = preFeatureReference(table);
      const sail = sailResult(res, rig);
      expect(sail!.legs, `${rig}: margin-0 legs must equal the comfort-free solve`).toEqual(
        ref.legs,
      );
      expect(sail!.etaMs, `${rig}: margin-0 clock must equal the comfort-free solve`).toBe(
        ref.etaMs,
      );
    }
  });

  // Design §D.4 "minimum vs. integral": the preference minimizes total
  // shallow-water exposure along a route (an integral of shortfall), not the
  // route's single shallowest point, so the two CAN diverge. This passage
  // used to be the worked example of that divergence — turning the
  // preference on made the MINIMUM worse (3.7 m off -> 3.0 m on).
  //
  // #455 ENDED THAT DIVERGENCE HERE, and the old prose is now false rather
  // than merely stale, so it is rewritten rather than re-pinned. MEASURED on
  // this passage, comfort-off vs comfort-on, on each mask:
  //     pre-#455 mask:  3.7 m -> 3.0 m   (the documented non-improvement)
  //     corrected mask: 3.7 m -> 4.1 m   (the preference now IMPROVES it)
  // The comfort-OFF route is untouched by #455 (4.3465 nm, identical
  // duration on both masks) — only the preference's own choice moved. Cause:
  // the shallower corridor it used to accept was made of cells reading
  // optimistically; reverted to the conservative max resampling, the
  // integral-minimizing choice now lands on the deeper corridor too.
  //
  // §D.4 IS STILL TRUE AS A GENERAL CLAIM — min and integral can diverge,
  // and nothing here promises they won't. This is a per-route drift
  // detector, not a guarantee that the preference improves the minimum
  // anywhere else.
  //
  // Asserted as a live RELATIONSHIP against a comfort-off run rather than a
  // pinned literal (§E.3: the search is heuristic and non-monotone, and a
  // literal here is mask-derived — it moves on any legitimate mask
  // regeneration, which is exactly how the previous 3.5 m bound came to
  // fail). The two figures above are documentation of this mask, not
  // assertions; the relationship is what a future change must not silently
  // reverse. A regression back to non-improvement reds this test.
  //
  // THIS DETECTOR IS ONE-DIRECTIONAL — say so rather than let a future reader
  // assume otherwise. The removed `min < 3.5` was half of a two-sided band,
  // and its own comment named BOTH directions: not silently regressed further,
  // and not silently "fixed" back toward the baseline. `min > minOff` is
  // strict but UNBOUNDED ABOVE, so after #455 nothing in this file detects
  // drift in the IMPROVEMENT direction — an unexplained jump to, say, 12 m
  // would pass silently. That is a deliberate trade, not an oversight: every
  // ceiling available here is either mask-derived (the failure mode being
  // fixed) or an arbitrary constant with no invariant behind it, and a
  // one-directional detector that says so beats a two-directional one that
  // reds on every regeneration. Reviewer note (PR #476): a "comfort target
  // doubled" mutation was tried as a probe of the improvement side and is
  // INCONCLUSIVE, not reassuring — it left the file 13/13 green because the
  // Drejoe route did not move at all (min stayed 4.1 m, minOff 3.7 m), so the
  // mutation was inert on this passage rather than the assertion being blind.
  // The one-sidedness is a structural property of `toBeGreaterThan`, which no
  // experiment here established or refuted.
  it('Aeroeskoebing -> Drejoe at DEFAULT_SETTINGS: the comfort preference improves this passage minimum rather than degrading it', () => {
    const res = planRoute(
      {
        origin: AEROESKOEBING,
        destination: DREJOE,
        viaPoints: [],
        originHarborId: 'aeroeskoebing',
        destinationHarborId: 'drejoe',
        departureMs: T0,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      uniformWindGrid(12, 270),
      SALONA_DEPS,
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const rig = sailResult(res, res.recommended);
    expect(rig).not.toBeNull();
    expectLegsNavigable(rig!.legs, DEFAULT_SETTINGS.safetyDepthM);
    let min = Infinity;
    for (const leg of rig!.legs) {
      const m = mask.segmentShallowestBelow(leg.start, leg.end, 1e6);
      min = Math.min(min, m === null ? 25.4 : m);
    }
    // Never below the hard gate (redundant with expectLegsNavigable above,
    // stated explicitly since it's the safety-relevant half of the claim).
    expect(min).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.safetyDepthM);

    // The same passage with the preference OFF — the comparison baseline,
    // recomputed live so this survives a mask regeneration.
    const off = planRoute(
      {
        origin: AEROESKOEBING,
        destination: DREJOE,
        viaPoints: [],
        originHarborId: 'aeroeskoebing',
        destinationHarborId: 'drejoe',
        departureMs: T0,
        settings: { ...DEFAULT_SETTINGS, depthComfortMarginM: 0 },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      uniformWindGrid(12, 270),
      SALONA_DEPS,
    );
    expect(off.status).toBe('ok');
    if (off.status !== 'ok') return;
    const offRig = sailResult(off, off.recommended);
    expect(offRig).not.toBeNull();
    let minOff = Infinity;
    for (const leg of offRig!.legs) {
      const m = mask.segmentShallowestBelow(leg.start, leg.end, 1e6);
      minOff = Math.min(minOff, m === null ? 25.4 : m);
    }
    expect(
      min,
      `comfort-on minimum ${min} m must beat comfort-off ${minOff} m on this passage`,
    ).toBeGreaterThan(minOff);
  });
});

describe('issue #265: the mirror case — genuinely mask-limited must stay unreachable', () => {
  // Flensburg -> Marstal at the REQUESTED 3.0 m gate is genuinely
  // mask-disconnected (documented in this file's DEFAULT_SETTINGS test above
  // and in issue #9): the shipped mask only 4-connects Flensburg to Marstal
  // at gates <= 2.3 m. This is the #265 review's Blocker-2 concern in
  // concrete form — a light-air, motor-off plan against a destination that
  // is disconnected for reasons having NOTHING to do with wind. A
  // reclassification that makes masked-but-slow headings read as "calm"
  // (the subFloor idea evaluated and REJECTED in this PR — see the PR
  // description) would make this exact case regress to 'calm-motor-off',
  // telling the user to wait for wind that can never help. Ground truth
  // comes from an independent oracle (mask.cellsConnected), not from
  // solve()/planRoute() itself.
  const settings: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 3, motorEnabled: false };

  it('is mask-disconnected at the requested 3.0 m gate but connected at 2.3 m (independent oracle)', () => {
    const o = mask.snapToNavigable(FLENSBURG, settings.safetyDepthM);
    const d = mask.snapToNavigable(MARSTAL, settings.safetyDepthM);
    expect(o).not.toBeNull();
    expect(d).not.toBeNull();
    expect(mask.cellsConnected(o!, d!, uniformGate(3.0))).toBe(false);
    expect(mask.cellsConnected(o!, d!, uniformGate(2.3))).toBe(true);
  });

  it(
    'a light-air, motor-off plan reports unreachable, not calm-motor-off, even though #53 relaxation is attempted',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      // Measured directly (not derived from this PR's own reasoning): #53's
      // relaxed-gate mechanism DOES fire here (reason defaults to
      // 'unreachable' from the disconnected-at-3.0m fast path, which is the
      // relaxation trigger), finds the same 2.3 m gate as the DEFAULT_SETTINGS
      // test above, and re-solves both rigs there under this scenario's
      // light air + motor-off settings — which still fails (the pinch is
      // narrow enough that the solver can't thread it at this wind/motor
      // combination), so the plan correctly falls through to 'unreachable'
      // rather than being coerced into 'calm-motor-off'.
      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings,
          sailIds: ['genoa', 'fock'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(3, 0),
        SALONA_DEPS,
      );
      // Split so a red run names WHICH fact broke: `status` is the
      // solver-capability/mask-connectivity fact (would flip to 'ok' if
      // either the mask reconnects at 3.0 m OR the relaxed 2.3 m re-solve
      // starts succeeding — both "good news", neither a classification
      // regression), while `reason` is the actual classification guard this
      // test exists to protect. A single `toEqual` would report both as one
      // failure and couldn't tell them apart.
      expect(res.status).toBe('error');
      if (res.status === 'error') expect(res.reason).toBe('unreachable');
    },
  );
});

// #54 spec §C.4(a): the #53 relaxation floor is the SELECTED boat's draft,
// not a module constant. Left global, relaxation takes a 2.30 m boat down to
// a 2.1 m gate — 0.2 m shallower than its keel before the mask tolerance is
// even applied — while the shallow banner reports the relaxation as if it
// were the Salona's.
//
// Fixture: Flensburg->54.8652,10.5313 (pocket ~0.45 nm N of the Marstal snap).
// MEASURED 2026-08-16: floor 2.1 -> usedDepthM 2.1, floor 2.3 -> no route.
//
// NOT a harbour pair on purpose. `findRelaxedGate` MAXIMISES the connecting
// gate, so a fixture whose maximum gate is >= 2.3 returns the IDENTICAL value
// at floor 2.1 and floor 2.3 and the obvious `usedDepthM >= 2.3` assertion is
// a theorem. All 528 unordered harbour pairs measure 2.9, 2.3 or null — none
// of them can red a wrongly-wired floor (Flensburg->Marstal is exactly the
// 2.3 boundary case). This pocket's maximum connecting gate is 2.1, verified
// against an independent numpy flood fill using a haversine disc.
describe('#54 spec C.4(a): the relaxation floor comes from the selected boat', () => {
  const POCKET: LatLon = { lat: 54.8652, lon: 10.5313 };
  const REQUESTED_DEPTH_M = 3.0;

  // The two rows below are NOT redundant. (a) guards the FIXTURE at the
  // `findRelaxedGate` level and cannot see this task's wiring at all; (b) is
  // the wiring test and is the only row a `planRoute.ts` perturbation can
  // red. Without (a), a future mask rebuild that made this pocket unroutable
  // at every gate would leave (b) passing for the wrong reason.
  it('(a) FIXTURE KEEPER: the pocket still diverges between floor 2.1 and floor 2.3', () => {
    const origin = mask.snapToNavigable(FLENSBURG, REQUESTED_DEPTH_M);
    const dest = mask.snapToNavigable(POCKET, REQUESTED_DEPTH_M);
    expect(origin, 'Flensburg must still snap at 3.0 m').not.toBeNull();
    expect(dest, 'the pocket must still snap at 3.0 m').not.toBeNull();

    const deep = findRelaxedGate(mask, [origin!, dest!], REQUESTED_DEPTH_M, APPROACH_RADIUS_M, 2.3);
    expect(deep, 'a 2.30 m boat must NOT be granted a gate below its own draft').toBeNull();

    // Licences the assertion above: without this the null could mean the
    // fixture has gone unroutable at every gate (a mask change), not that
    // the floor held.
    const shallow = findRelaxedGate(
      mask,
      [origin!, dest!],
      REQUESTED_DEPTH_M,
      APPROACH_RADIUS_M,
      2.1,
    );
    expect(shallow?.usedDepthM).toBeCloseTo(2.1, 6);
  });

  // #54 fix round 1: findRelaxedGate must quantise `floorM` UP, so it fails
  // closed for a caller that hands over a RAW draft. Round would take a
  // 2.14 m boat to a 2.1 m gate — under its own keel — which is the class
  // lib/boatDepth.ts's ceilToDecimetre forbids in capitals (spec C.8).
  //
  // This row calls findRelaxedGate DIRECTLY, and it has to: MEASURED over
  // 4501 millimetre-spaced drafts, ceil-vs-round in the callee is invisible
  // through planRoute (0 disagreements) because the caller already quantises
  // via relaxationFloorM. Only a raw floor reaches the branch.
  //
  // 2.14 is the discriminating value for THIS fixture, not 2.24: the pocket's
  // maximum connecting gate is 21 dm, and round(2.14*10)=21 connects while
  // ceil=22 does not. round(2.24*10)=22 also fails to connect, so a 2.24 row
  // would pass either way.
  it('(a2) CALLEE KEEPER: a RAW non-decimetre floor is quantised UP, not down', () => {
    const origin = mask.snapToNavigable(FLENSBURG, REQUESTED_DEPTH_M);
    const dest = mask.snapToNavigable(POCKET, REQUESTED_DEPTH_M);
    const raw = findRelaxedGate(mask, [origin!, dest!], REQUESTED_DEPTH_M, APPROACH_RADIUS_M, 2.14);
    expect(raw, 'a 2.14 m floor must not be granted the 2.1 m gate below it').toBeNull();
  });

  it(
    '(b) WIRING: planRoute relaxes to the floor of deps.boat, not to a shared constant',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const salona = boatById(DEFAULT_BOAT_ID);
      // Deliberately NOT a catalogue entry: the catalogue has one boat, whose
      // draft coincides with the old module constant, so no real boat can
      // discriminate the wiring.
      const deepBoat: BoatDef = { ...salona, id: 'deep-test', draftM: 2.3 };
      const request = {
        origin: FLENSBURG,
        destination: POCKET,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: null,
        departureMs: T0,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'] as SailId[],
        boat: defaultBoatSnapshot(),
      };
      const wind = uniformWindGrid(12, 270);

      const deepRes = planRoute(request, wind, { polars, boat: deepBoat, mask });
      expect(deepRes.status, 'a 2.30 m boat must not be routed through a 2.1 m relaxed gate').toBe(
        'error',
      );
      if (deepRes.status === 'error') expect(deepRes.reason).toBe('unreachable');

      // MANDATORY companion, not optional: without it the row above is
      // indistinguishable from "this fixture is simply unroutable", which is
      // the vacuity mode the whole fixture measurement exists to avoid.
      const salonaRes = planRoute(request, wind, { polars, boat: salona, mask });
      expect(salonaRes.status, 'the 2.10 m Salona 45 must still reach the pocket').toBe('ok');
      if (salonaRes.status === 'ok') expect(salonaRes.shallow?.usedDepthM).toBeCloseTo(2.1, 6);
    },
  );
});

// #653: pinned literals for the describe block below, recomputed from actual
// solver output observed against the real committed mask/polars (see each
// assertion site's own comment for the sanity checks applied).
const SALONA44_GLUECKSBURG_DISTANCE_NM = 4.211804567041051;
const SALONA44_GLUECKSBURG_DURATION_MS = 2374384.2580566406;
const SALONA44_MARSTAL_DURATION_MS = 28020116.832763672;

// #653: both real-mask harnesses (this file and app/sweep/) exercised only
// the Salona 45 before this describe block — see the issue for the
// motivating concern (a boatDepth.ts/depthGate.ts regression correct for
// the Salona 45's gate but wrong for a DIFFERENT per-boat gate, or a
// boat-keyed polar lookup bug, was invisible to both). The Salona 44 shares
// the Salona 45's 2.1 m draft, so `defaultSafetyDepthM`/`relaxationFloorM`
// (both pure functions of `b.draftM`, see lib/boatDepth.ts) compute the
// IDENTICAL gate for either boat — these cases therefore do NOT discriminate
// a depth-gate difference by themselves (see each case's own comment for
// what it discriminates instead: the boat-keyed POLAR lookup and the
// plan/ETA it produces, proven via a same-request comparison against
// SALONA_DEPS whose failure mode, if this file's boat wiring regressed to
// always resolving DEFAULT_BOAT_ID, would be `expect(x).not.toBe(x)`).
describe('#653: Salona 44 real-mask coverage (second catalogue boat)', () => {
  // Cheap case (open water, ~seconds): mirrors this file's #20 repro
  // ('Flensburg -> Gluecksburg routes at default settings') at DEFAULT
  // safety depth, where neither boat is anywhere near its gate. Isolates
  // the boat-keyed polar lookup from any #53 relaxation interaction.
  it('Flensburg -> Gluecksburg with the Salona 44: boat-keyed polar changes the plan under identical wind (issue #20 repro, second boat)', () => {
    const request = {
      origin: FLENSBURG,
      destination: GLUECKSBURG,
      viaPoints: [],
      originHarborId: 'flensburg',
      destinationHarborId: 'gluecksburg',
      departureMs: T0,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'] as SailId[],
      // #653 review Minor 6: `request.boat` must agree with the `deps.boat`
      // it is actually paired with in EACH call below — planRoute reads only
      // `deps.boat` (never `req.boat`), so this is presentationally inert
      // today, but constructing a request/deps boat mismatch is exactly the
      // shape `workerClient.boatId.test.ts` exists to forbid at a multi-boat
      // catalogue. The res45 companion call below overrides this back to the
      // Salona 45 for its own call.
      boat: boatSnapshot(boatById('salona-44-speedy-go')),
    };
    const wind = uniformWindGrid(12, 270);

    const res44 = planRoute(request, wind, SALONA44_DEPS);
    expect(res44.status).toBe('ok');
    if (res44.status !== 'ok') return;
    expect('shallow' in res44).toBe(false);
    for (const rig of [sailResult(res44, 'genoa'), sailResult(res44, 'fock')]) {
      expect(rig).not.toBeNull();
      // ~4 nm; anything over 1.5 h means the solver padded its way out
      // (same envelope the #20 repro itself uses).
      expect(rig!.durationMs).toBeLessThan(1.5 * 3_600_000);
      expectLegsNavigable(rig!.legs, DEFAULT_SETTINGS.safetyDepthM);
    }

    // MANDATORY companion, not optional (same pattern as this file's own
    // C.4(a) WIRING row): without it, "the Salona 44 plan looks sane" is not
    // evidence it is BOAT-SENSITIVE — a `SALONA44_DEPS` that silently
    // resolved to the Salona 45 (a wrong catalogue lookup) would pass every
    // assertion above identically, since both boats share the 2.1 m draft
    // and this route is not depth-limited for either. Plan the identical
    // request/wind against SALONA_DEPS and require the two plans' chosen-rig
    // duration to differ.
    const res45 = planRoute({ ...request, boat: defaultBoatSnapshot() }, wind, SALONA_DEPS);
    expect(res45.status).toBe('ok');
    if (res45.status !== 'ok') return;
    const rig44 = sailResult(res44, res44.recommended);
    const rig45 = sailResult(res45, res45.recommended);
    expect(rig44).not.toBeNull();
    expect(rig45).not.toBeNull();
    expect(rig44!.durationMs).not.toBe(rig45!.durationMs);

    // Pinned literals, recomputed from the actual solver output observed for
    // this PR (2026-09-02) and sanity-checked against: (a) the < 1.5 h bound
    // above, (b) the #20 repro's own ~4 nm distance note, and (c) the Salona
    // 44's polar being faster than the Salona 45's at TWS 12 kn across the
    // nine sampled TWA from 35 to 100 deg and EXACTLY EQUAL from 110 deg to
    // 180 (measured against the shipped salona-44-speedy-go-genoa.json /
    // salona-45-genoa.json tables; same 9-faster/6-equal split at every one
    // of the nine TWS rows, both rigs) — so on THIS route, which is not
    // purely downwind, the Salona 44 plan is expected to be faster. That is
    // a claim about this route only: `salona44-breeze` in app/sweep/ is
    // SLOWER than `breeze` on rudkoebing and svendborg, so "faster polar
    // implies faster plan" does NOT hold arm-wide.
    expect(rig44!.distanceNm).toBeCloseTo(SALONA44_GLUECKSBURG_DISTANCE_NM, 6);
    expect(rig44!.durationMs).toBe(SALONA44_GLUECKSBURG_DURATION_MS);
    expect(rig44!.durationMs).toBeLessThan(rig45!.durationMs);
  });

  // Heavier case (~45 s per solve x2, same runtime class as this file's own
  // 'Flensburg -> Marstal at DEFAULT_SETTINGS degrades gracefully with
  // shallow warnings (#53)' case): the #53 relaxation path, for a SECOND
  // catalogue boat. This is the case the issue's own motivating concern
  // names directly — a defaultSafetyDepthM/relaxationFloorM mixup would be
  // invisible without it.
  it(
    'Flensburg -> Marstal at DEFAULT_SETTINGS with the Salona 44: identical relaxed depth gate to the Salona 45, different ETA (#53, second boat)',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const request = {
        origin: FLENSBURG,
        destination: MARSTAL,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'marstal',
        departureMs: T0,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'] as SailId[],
        // #653 review Minor 6: see the Gluecksburg case above for why this
        // must agree with SALONA44_DEPS's boat, and why the res45 companion
        // call below overrides it back.
        boat: boatSnapshot(boatById('salona-44-speedy-go')),
      };
      const wind = uniformWindGrid(12, 270);

      const res44 = planRoute(request, wind, SALONA44_DEPS);
      expect(res44.status).toBe('ok');
      if (res44.status !== 'ok') return;
      expect(res44.shallow).toBeDefined();
      expect(res44.shallow!.requestedDepthM).toBe(3.0);
      // SAME usedDepthM as the Salona 45's own DEFAULT_SETTINGS case above
      // (2.3 m) — NOT a coincidence: defaultSafetyDepthM/relaxationFloorM
      // are pure functions of b.draftM, and both Salonas draft 2.1 m, so the
      // search range findRelaxedGate probes is identical for either boat.
      // This equality is itself the evidence that the per-boat gate math is
      // reading `deps.boat` (a real Salona-44 BoatDef) rather than a
      // hardcoded Salona-45 value: had SALONA44_DEPS silently resolved a
      // draft-DIFFERENT boat (say the 1.9 m PIRANJA) here instead, this
      // assertion would red.
      expect(res44.shallow!.usedDepthM).toBeCloseTo(2.3, 6);
      expect(res44.shallow!.minGateDepthM).toBeGreaterThanOrEqual(2.3);
      expect(res44.shallow!.minGateDepthM).toBeLessThan(3.0);

      for (const rig of [sailResult(res44, 'genoa'), sailResult(res44, 'fock')]) {
        expect(rig).not.toBeNull();
        expect(rig!.distanceNm).toBeGreaterThan(30);
        expect(rig!.durationMs).toBeLessThan(12 * 3_600_000);
        expectLegsNavigable(rig!.legs, res44.shallow!.usedDepthM);
        const flagged = rig!.legs.filter((l) => l.shallow);
        expect(flagged.length).toBeGreaterThan(0);
      }

      // MANDATORY companion (same pattern as above): prove the plan is
      // BOAT-SENSITIVE, not merely depth-gate-sensitive — the gate math
      // alone (checked above) cannot discriminate a boat-keyed POLAR mixup,
      // since it is identical for both boats on this route.
      const res45 = planRoute({ ...request, boat: defaultBoatSnapshot() }, wind, SALONA_DEPS);
      expect(res45.status).toBe('ok');
      if (res45.status !== 'ok') return;
      expect(res45.shallow!.usedDepthM).toBeCloseTo(res44.shallow!.usedDepthM, 6);
      const rig44 = sailResult(res44, res44.recommended);
      const rig45 = sailResult(res45, res45.recommended);
      expect(rig44).not.toBeNull();
      expect(rig45).not.toBeNull();
      expect(rig44!.durationMs).not.toBe(rig45!.durationMs);

      // Pinned literal, recomputed from the actual solver output observed
      // for this PR (2026-09-02) and sanity-checked against: (a) the
      // 30 nm / 12 h envelope above (same as the Salona 45's own DEFAULT
      // case), (b) usedDepthM/minGateDepthM matching the Salona 45's case
      // exactly, and (c) at least one flagged shallow leg on every sail —
      // all consistent with a route through the SAME Marstal pinch as the
      // Salona 45's plan, at a genuinely different boat speed.
      expect(rig44!.durationMs).toBe(SALONA44_MARSTAL_DURATION_MS);
    },
  );
});
