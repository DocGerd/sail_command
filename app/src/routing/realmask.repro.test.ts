import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NavMask } from '../lib/mask';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { solve } from './isochrone';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../types';
import type { LatLon, Leg, MaskMeta, PolarTable, Settings } from '../types';

// Regression tests for issue #20: the solver returned 'unreachable' for real
// harbor-to-harbor routes because a full isochrone step (0.5-2 km) is longer
// than real harbor arms are straight (~200-400 m wide), so every candidate
// died on the first expansion. These run against the real shipped mask and
// polars, unlike the synthetic masks used everywhere else in the suite.
vi.setConfig({ testTimeout: 120_000 });

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
const mask = new NavMask(maskMeta, new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))));
const polarGenoa = JSON.parse(
  readFileSync(resolve(dataDir, 'polar-genoa.json'), 'utf8'),
) as PolarTable;
const polarFock = JSON.parse(
  readFileSync(resolve(dataDir, 'polar-fock.json'), 'utf8'),
) as PolarTable;

// Real harbor snap coordinates from harbors.json
const FLENSBURG: LatLon = { lat: 54.798, lon: 9.4335 };
const GLUECKSBURG: LatLon = { lat: 54.8415, lon: 9.5225 };
const MARSTAL: LatLon = { lat: 54.8579, lon: 10.528 };
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
      mask.segmentNavigable(leg.start, leg.end, safetyDepthM),
      `leg ${JSON.stringify(leg.start)} -> ${JSON.stringify(leg.end)} crosses non-navigable water`,
    ).toBe(true);
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
      },
      uniformWindGrid(12, 270),
      { polarGenoa, polarFock, mask },
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    for (const rig of [res.genoa, res.fock]) {
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
  // pruning deliberately widened the search; CI runners are 6-10x slower,
  // hence the generous timeout).
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
  it('Flensburg -> Marstal (direct request at 2.3 m safety depth)', { timeout: 600_000 }, () => {
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
      },
      uniformWindGrid(12, 270),
      { polarGenoa, polarFock, mask },
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    // Explicitly-requested 2.3 m needs no relaxation: no shallow warnings.
    expect('shallow' in res).toBe(false);
    const rig = res.recommended === 'genoa' ? res.genoa : res.fock;
    expect(rig).not.toBeNull();
    // ~38 nm great-circle; sane plans stay inside these envelopes
    expect(rig!.distanceNm).toBeGreaterThan(30);
    expect(rig!.durationMs).toBeLessThan(12 * 3_600_000);
    expectLegsNavigable(rig!.legs, settings.safetyDepthM);
  });

  // Spec acceptance case for #53 (graceful degradation below safety depth):
  // Flensburg -> Marstal at DEFAULT_SETTINGS (3.0 m) returns a route WITH
  // shallow warnings instead of 'unreachable'. usedDepthM = 2.3 was derived
  // INDEPENDENTLY of the router: a standalone stack-based flood fill over the
  // raw committed mask.bin reports the Flensburg/Marstal snap cells connected
  // at every decimeter gate <= 2.3 m and disconnected at >= 2.4 m (matching
  // the 2.3 m gate documented in pipeline/verify_mask.py's
  // CONNECTIVITY_EXCEPTIONS_M); the in-test cellsConnected assertions below
  // cross-check the shipped BFS against those literals. Runtime ≈ the 2.3 m
  // case above (the disconnection fast path skips the doomed 3.0 m solves;
  // the relaxed solve does the same work as a direct 2.3 m plan), hence the
  // same generous timeout.
  it(
    'Flensburg -> Marstal at DEFAULT_SETTINGS degrades gracefully with shallow warnings (#53)',
    { timeout: 600_000 },
    () => {
      const o = mask.snapToNavigable(FLENSBURG, DEFAULT_SETTINGS.safetyDepthM);
      const d = mask.snapToNavigable(MARSTAL, DEFAULT_SETTINGS.safetyDepthM);
      expect(o).not.toBeNull();
      expect(d).not.toBeNull();
      // The independently-derived connectivity flip pinning usedDepthM = 2.3:
      expect(mask.cellsConnected(o!, d!, 2.3)).toBe(true);
      expect(mask.cellsConnected(o!, d!, 2.4)).toBe(false);

      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings: DEFAULT_SETTINGS,
        },
        uniformWindGrid(12, 270),
        { polarGenoa, polarFock, mask },
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
      for (const rig of [res.genoa, res.fock]) {
        expect(rig).not.toBeNull();
        expect(rig!.distanceNm).toBeGreaterThan(30);
        expect(rig!.durationMs).toBeLessThan(12 * 3_600_000);
        expectLegsNavigable(rig!.legs, res.shallow!.usedDepthM);
        const flagged = rig!.legs.filter((l) => l.shallow);
        expect(flagged.length).toBeGreaterThan(0);
        for (const leg of flagged) {
          expect(leg.shallow!.minDepthM).toBeGreaterThanOrEqual(res.shallow!.minGateDepthM);
          expect(leg.shallow!.minDepthM).toBeLessThan(3.0);
        }
      }
    },
  );
});
