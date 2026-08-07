/**
 * #282 ACCEPTANCE SWEEP — the shared engine.
 *
 * Flensburg -> every harbour in the shipped `harbors.json`, across six settings
 * arms, against the REAL committed mask and polars. Every `PlanResult` is
 * serialised deterministically so a BASE run and a HEAD run can be compared
 * byte-for-byte: #282's standing requirement is that a change which is meant to
 * be presentational moves NO route.
 *
 * DELIBERATELY OUTSIDE `app/src/`. `vite.config.ts`'s `test.include` is
 * `['src/**\/*.test.{ts,tsx}']`, so nothing here is collected by
 * `npm --prefix app run test` or by CI — this is an on-demand experiment
 * costing ~20 minutes of real solver time, not part of the suite's contract.
 * See `README.md` in this directory for how to run it.
 *
 * BASELINE PARAMETERS ARE LOAD-BEARING. Every constant below — the arm list,
 * each arm's wind field, `T0`, the origin, and the serializer — defines what a
 * stored baseline means. Change any one and previously-recorded output is no
 * longer comparable, which silently destroys the only evidence a future
 * classification change has to argue against. Add a new arm rather than
 * editing an existing one.
 *
 * Imports nothing that exists on only one side of a refactor (no
 * `SolveFailureCause`, no `NO_ROUTE_LABEL_OF_CAUSE`), so the identical file
 * runs unchanged at BASE and at HEAD.
 */
import { expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NavMask } from '../src/lib/mask';
import { planRoute } from '../src/routing/planRoute';
import { uniformWindGrid } from '../src/test/fixtures';
import { DEFAULT_SETTINGS } from '../src/types';
import type { LatLon, MaskMeta, PolarTable, Settings, WindGrid } from '../src/types';
import { solverTimeoutMs } from '../src/test/timeouts';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
/** Absolute output directory. REQUIRED — fail closed rather than silently overwrite a default. */
const OUT_DIR = env?.SC_SWEEP_OUT;
/** Optional: first N destinations only, for calibrating a change to this harness. */
const LIMIT = Number(env?.SC_SWEEP_LIMIT ?? '0');

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data');

interface Harbor {
  id: string;
  snap: LatLon;
}

export interface Arm {
  label: string;
  settings: Settings;
  wind: () => WindGrid;
}

/** Departure instant. Part of the baseline identity — never "refresh" it. */
export const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);

/**
 * The six arms, with the role each one actually plays — MEASURED on the
 * 2026-08-07 baseline (198 plans), not assumed. Gate counts below are
 * `depthRelaxationMayHelp` true/false and come from an instrumented run.
 *
 *   breeze          - ordinary sailing breeze; 27 `ok`. The happy path, and
 *                     (with no-comfort) the source of the only two plans
 *                     carrying a #53 shallow warning. Gate 6/0.
 *   no-comfort      - `depthComfortMarginM: 0` => `comfortDepthM` undefined =>
 *                     the byte-identical pre-#243 path, on which the #243
 *                     tier-2 retry is unreachable and `comfortRetryMayHelp` is
 *                     never consulted at all. Shares breeze's wind field, but
 *                     only 6 of 33 rows match it — the comfort margin really
 *                     does move 27 of 33 routes. Gate 6/0.
 *   short-horizon   - a 3 h forecast grid. THE reason all three causes are
 *                     reachable: it alone contributes 26 of the 28
 *                     `beyond-horizon` outcomes and 21 of the 23
 *                     `horizon-exceeded` gate observations. Gate 11/20.
 *   light-motorless - #282's own configuration, verbatim: uniform TWS 3 /
 *                     dir 0, `motorEnabled: false`, otherwise DEFAULT_SETTINGS.
 *                     TWS is below the polar's 4 kn floor (scaled linearly to
 *                     0), so the boat is slow and the search exhausts. The
 *                     heaviest relaxation arm. Gate 16/2.
 *   becalmed        - TWS far below the polar floor + engine off => every
 *                     candidate heading dies calm => cause
 *                     'calm-without-motor', which both gates must reject.
 *                     Gate 6/27.
 *   deep-becalmed   - the same at a 4.0 m gate. Its real and UNIQUE
 *                     contribution is the 3 `snap-failed-destination` rows no
 *                     other arm produces — the pre-solve failure path. Note
 *                     what it does NOT do: the relaxation gate fires TRUE 6
 *                     times here, identical to breeze, no-comfort and
 *                     becalmed, so a deeper gate does NOT relax "far more
 *                     often" (an earlier version of this comment claimed it
 *                     did; the counters refute it). Gate 6/24.
 */
export const ARMS: Record<string, Arm> = {
  breeze: { label: 'breeze', settings: DEFAULT_SETTINGS, wind: () => uniformWindGrid(12, 225) },
  'no-comfort': {
    label: 'no-comfort',
    settings: { ...DEFAULT_SETTINGS, depthComfortMarginM: 0 },
    wind: () => uniformWindGrid(12, 225),
  },
  'short-horizon': {
    label: 'short-horizon',
    settings: DEFAULT_SETTINGS,
    wind: () => uniformWindGrid(12, 225, { hours: 3 }),
  },
  'light-motorless': {
    label: 'light-motorless',
    settings: { ...DEFAULT_SETTINGS, motorEnabled: false },
    wind: () => uniformWindGrid(3, 0),
  },
  becalmed: {
    label: 'becalmed',
    settings: { ...DEFAULT_SETTINGS, motorEnabled: false },
    wind: () => uniformWindGrid(0.15, 0),
  },
  'deep-becalmed': {
    label: 'deep-becalmed',
    settings: { ...DEFAULT_SETTINGS, motorEnabled: false, safetyDepthM: 4.0 },
    wind: () => uniformWindGrid(0.15, 0),
  },
};

/**
 * Deterministic serialization. `JSON.stringify(value, replacer, 1)` — the
 * 1-space indent is part of the baseline identity, not cosmetics: it fixes the
 * byte layout every stored comparison was made against. Non-finite numbers
 * become explicit sentinels because JSON would otherwise turn NaN/Infinity
 * into `null` and quietly erase a real difference.
 */
export function serialize(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? `#nf:${String(v)}` : v),
    1,
  );
}

export function runArm(label: string): void {
  const arm = ARMS[label];
  if (!arm) throw new Error(`unknown sweep arm ${label}`);

  const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
  const mask = new NavMask(maskMeta, new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))));
  const polarGenoa = JSON.parse(
    readFileSync(resolve(dataDir, 'polar-genoa.json'), 'utf8'),
  ) as PolarTable;
  const polarFock = JSON.parse(
    readFileSync(resolve(dataDir, 'polar-fock.json'), 'utf8'),
  ) as PolarTable;
  const harbors = JSON.parse(readFileSync(resolve(dataDir, 'harbors.json'), 'utf8')) as Harbor[];
  const flensburg = harbors.find((h) => h.id === 'flensburg');
  if (!flensburg) throw new Error('#282 sweep: harbors.json has no `flensburg` entry');

  it(
    `#282 sweep arm ${label}: Flensburg -> all harbours`,
    () => {
      // Fail closed, and inside the test so the whole file still collects when
      // the variable is unset (a thrown error at module scope reads as a
      // collection crash rather than an actionable message).
      expect(OUT_DIR, '#282 sweep: set SC_SWEEP_OUT to an absolute output directory').toBeTruthy();
      const outDir = OUT_DIR as string;
      mkdirSync(outDir, { recursive: true });

      const dests = LIMIT > 0 ? harbors.slice(0, LIMIT) : harbors;
      const windGrid = arm.wind();
      const rows: Record<string, unknown> = {};
      const timings: Record<string, number> = {};
      for (const h of dests) {
        const t = Date.now();
        rows[h.id] = planRoute(
          {
            origin: flensburg.snap,
            destination: h.snap,
            viaPoints: [],
            originHarborId: 'flensburg',
            destinationHarborId: h.id,
            departureMs: T0,
            settings: arm.settings,
          },
          windGrid,
          { polarGenoa, polarFock, mask },
        );
        timings[h.id] = Date.now() - t;
      }
      writeFileSync(resolve(outDir, `${label}.json`), serialize(rows));
      writeFileSync(resolve(outDir, `${label}.timings.json`), serialize(timings));
      expect(Object.keys(rows).length).toBe(dests.length);
    },
    solverTimeoutMs(3_600_000),
  );
}
