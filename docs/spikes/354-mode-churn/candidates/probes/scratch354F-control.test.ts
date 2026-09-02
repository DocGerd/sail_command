/**
 * #354 candidate F — NON-VACUITY CONTROL. Not the driver, and NOT evidence
 * about candidate F.
 *
 * The driver reports 12/12 fingerprints byte-identical to BASE. On its own that
 * reading is ambiguous: "the candidate is unreachable on these routes" and "the
 * new cost term is dead code that never executed" emit exactly the same output
 * (CLAUDE.md: an experiment that never ran emits the output of one that found
 * nothing). This file discriminates them.
 *
 * A. DATA MEASUREMENT — what a caller reading the real shipped asset gets.
 * B. POSITIVE CONTROL — feed the term a FABRICATED corridor and show the plan
 *    moves. The half-width used here is invented, which is precisely the number
 *    #244 §2.1 measured as absent from every available source; it exists to
 *    prove the code path is live, and licenses no conclusion about F.
 */
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { planRoute } from '../src/routing/planRoute';
import { NavMask } from '../src/lib/mask';
import { uniformWindGrid } from '../src/test/fixtures';
import { defaultBoatSnapshot, DEFAULT_SETTINGS } from '../src/types';
import type { LatLon, MaskMeta, PolarTable, SailId } from '../src/types';
import { boatById, DEFAULT_BOAT_ID, polarKey } from '../src/data/boats';
import { solverTimeoutMs } from '../src/test/timeouts';
import { serialize } from './sweepArms';
import { fairwayFieldFrom, fairwayCorridorsFromGeoJson } from '../src/lib/fairway';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '..', 'public', 'data');
/** Identical to the driver's own T0 and to sweepArms.ts's exported T0. */
const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);

interface Harbor {
  id: string;
  snap: LatLon;
}

function fp(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function loadDeps() {
  const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
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
  return { mask, boat, polars, harbors, sailIds };
}

it('A. the shipped seamark asset yields ZERO fairway corridors', () => {
  const raw = JSON.parse(readFileSync(resolve(dataDir, 'seamarks.json'), 'utf8')) as {
    features: { geometry: { type: string } }[];
  };
  const geometryTypes = new Set(raw.features.map((f) => f.geometry.type));
  // Positive control on the READ itself: a scan that found nothing because it
  // read nothing would report an empty set here.
  expect(raw.features.length).toBeGreaterThan(1000);
  // eslint-disable-next-line no-console
  console.log(
    `[A] seamarks.json features=${raw.features.length} geometryTypes=${[...geometryTypes].join(',')}`,
  );
  const corridors = fairwayCorridorsFromGeoJson(raw, 0.1);
  // eslint-disable-next-line no-console
  console.log(`[A] fairway corridors extracted = ${corridors.length}`);
  expect(corridors).toEqual([]);
});

it(
  'B. a FABRICATED corridor DOES move the plan (proves the cost term is live)',
  { timeout: solverTimeoutMs(120_000) },
  () => {
    const { mask, boat, polars, harbors, sailIds } = loadDeps();
    // R3-narrow-fairway — Svendborgsund, the driver's narrowest-channel route.
    const origin = harbors.find((h) => h.id === 'svendborg')!;
    const dest = harbors.find((h) => h.id === 'troense')!;
    const req = {
      origin: origin.snap,
      destination: dest.snap,
      viaPoints: [],
      originHarborId: 'svendborg',
      destinationHarborId: 'troense',
      departureMs: T0,
      settings: DEFAULT_SETTINGS,
      sailIds,
      boat: defaultBoatSnapshot(),
    };
    const wind = uniformWindGrid(5, 140);

    const baseline = planRoute(req, wind, { polars, boat, mask });
    const baseFp = fp(serialize(baseline));

    // FABRICATED corridor: the straight origin→destination line at a half-width
    // of 0.05 nm (~93 m). Both the geometry and the width are invented. This is
    // an instrument check, not a fairway.
    const corridors = [{ line: [origin.snap, dest.snap], halfWidthNm: 0.05 }];
    const perturbed = planRoute(req, wind, {
      polars,
      boat,
      mask,
      fairway: fairwayFieldFrom(corridors),
    });
    const perturbedFp = fp(serialize(perturbed));

    // Reverting must reproduce the baseline exactly — otherwise the difference
    // above could be nondeterminism rather than the term.
    const reverted = planRoute(req, wind, { polars, boat, mask });
    const revertFp = fp(serialize(reverted));

    // eslint-disable-next-line no-console
    console.log(
      `[B] baseline=${baseFp} withFabricatedCorridor=${perturbedFp} reverted=${revertFp} ` +
        `moved=${perturbedFp !== baseFp} revertMatches=${revertFp === baseFp}`,
    );
    for (const [label, r] of [
      ['baseline', baseline],
      ['perturbed', perturbed],
    ] as const) {
      if (r.status !== 'ok') {
        // eslint-disable-next-line no-console
        console.log(`[B] ${label}: status=error reason=${r.reason}`);
        continue;
      }
      const rec = r.sails.find((x) => x.sailId === r.recommended);
      const legs = rec?.result?.legs ?? [];
      const eta = legs.length
        ? (legs[legs.length - 1].endTimeMs - legs[0].startTimeMs) / 60000
        : null;
      // eslint-disable-next-line no-console
      console.log(
        `[B] ${label}: status=ok sail=${r.recommended} legs=${legs.length} ` +
          `etaMin=${eta === null ? 'null' : eta.toFixed(1)}`,
      );
    }

    expect(revertFp).toBe(baseFp);
    expect(perturbedFp).not.toBe(baseFp);
  },
);
