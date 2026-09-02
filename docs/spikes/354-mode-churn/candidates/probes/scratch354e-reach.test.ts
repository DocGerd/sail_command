/**
 * #354 candidate E REACHABILITY PROBE — separate from, and not a modification
 * of, scratch354.test.ts (which was run UNCHANGED).
 *
 * Candidate E is presentation-only, so the solver driver's fingerprints CANNOT
 * move and carry zero evidence about it. The only thing measurable is whether
 * the DISCLOSURE fires on real plans at all. This re-plans the same six routes
 * with the same inputs the driver uses and applies the shipped
 * `briefModeRunFlags(legs, DEFAULT_SETTINGS.maneuverPenaltyS)` to each result.
 */
import { it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { planRoute } from '../src/routing/planRoute';
import { NavMask } from '../src/lib/mask';
import { uniformWindGrid } from '../src/test/fixtures';
import { defaultBoatSnapshot, DEFAULT_SETTINGS } from '../src/types';
import type { LatLon, MaskMeta, PolarTable, SailId } from '../src/types';
import { boatById, DEFAULT_BOAT_ID, polarKey } from '../src/data/boats';
import { solverTimeoutMs } from '../src/test/timeouts';
import { briefModeRunFlags, modeChangeCount } from '../src/lib/briefModeRuns';

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data');
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'scratch354-out');
const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);

interface Harbor {
  id: string;
  snap: LatLon;
}

const ROUTES = [
  { id: 'R6-control', origin: 'flensburg', dest: 'gelting-mole', twsKn: 12, wdirDeg: 225 },
  { id: 'R1-primary-churn', origin: 'flensburg', dest: 'soenderborg', twsKn: 4, wdirDeg: 62 },
  { id: 'R2-confined-beat', origin: 'flensburg', dest: 'gluecksburg', twsKn: 4.5, wdirDeg: 50 },
  { id: 'R3-narrow-fairway', origin: 'svendborg', dest: 'troense', twsKn: 5, wdirDeg: 140 },
  { id: 'R4-downwind-knife-edge', origin: 'aeroeskoebing', dest: 'soeby', twsKn: 5.5, wdirDeg: 120 },
  { id: 'R5-beam-reach-shoals', origin: 'faaborg', dest: 'avernakoe', twsKn: 4.5, wdirDeg: 260 },
];

it(
  '#354 E: how often does the brief-mode-run disclosure fire on real plans?',
  () => {
    const maskMeta = JSON.parse(
      readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8'),
    ) as MaskMeta;
    const mask = new NavMask(maskMeta, new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))));
    const boat = boatById(DEFAULT_BOAT_ID);
    const polars: Record<string, PolarTable> = {};
    for (const sail of boat.sails) {
      polars[polarKey(boat.id, sail.id)] = JSON.parse(
        readFileSync(resolve(dataDir, '..', sail.polarAsset), 'utf8'),
      ) as PolarTable;
    }
    const harbors = JSON.parse(readFileSync(resolve(dataDir, 'harbors.json'), 'utf8')) as Harbor[];
    const sailIds: readonly SailId[] = boat.sails.map((s) => s.id as SailId);

    const rows: Record<string, unknown>[] = [];
    for (const spec of ROUTES) {
      const origin = harbors.find((h) => h.id === spec.origin);
      const dest = harbors.find((h) => h.id === spec.dest);
      if (!origin || !dest) throw new Error(`no harbor for ${spec.id}`);
      const result = planRoute(
        {
          origin: origin.snap,
          destination: dest.snap,
          viaPoints: [],
          originHarborId: spec.origin,
          destinationHarborId: spec.dest,
          departureMs: T0,
          settings: DEFAULT_SETTINGS,
          sailIds,
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(spec.twsKn, spec.wdirDeg),
        { polars, boat, mask },
      );
      if (result.status !== 'ok') {
        rows.push({ route: spec.id, status: 'error' });
        continue;
      }
      for (const s of result.sails) {
        if (!s.result) continue;
        const legs = s.result.legs;
        const flags = briefModeRunFlags(legs, DEFAULT_SETTINGS.maneuverPenaltyS);
        rows.push({
          route: spec.id,
          sail: s.sailId,
          legs: legs.length,
          modeChanges: modeChangeCount(legs),
          flaggedLegs: flags.filter(Boolean).length,
          runDurationsS: (() => {
            const out: string[] = [];
            let i = 0;
            while (i < legs.length) {
              let j = i;
              while (j < legs.length && legs[j].kind === legs[i].kind) j++;
              out.push(
                `${legs[i].kind === 'motor' ? 'M' : 'S'}:${Math.round(
                  (legs[j - 1].endTimeMs - legs[i].startTimeMs) / 1000,
                )}s`,
              );
              i = j;
            }
            return out.join(' ');
          })(),
        });
      }
    }
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, 'candidate-e-reach.json'), JSON.stringify(rows, null, 2));
    for (const r of rows) console.log(JSON.stringify(r));
    expect(rows.length).toBeGreaterThan(0);
  },
  solverTimeoutMs(120_000),
);
