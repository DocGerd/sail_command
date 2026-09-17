import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NavMask } from '../lib/mask';
import { uniformGate } from '../lib/depthGate';
import { findRelaxedGate } from '../routing/relaxedDepth';
import { BOATS, type BoatDef } from '../data/boats';
import { defaultSafetyDepthM, relaxationFloorM } from '../lib/boatDepth';
import {
  computeHarborAccess,
  findLowerSettingHint,
  SEED_POINT,
  type HarborWithReachability,
} from '../lib/harborReachability';
import type { MaskMeta } from '../types';

// #1290 (design docs/spikes/1135-boat-picker-gate-design.md §13 item 1).
// Loads the SAME committed mask/harbors assets `verifyMaskConnectivity
// .test.ts` uses, for the same reason: this is a differential/acceptance
// suite over real production data, not a synthetic-fixture unit test.
const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VERIFY_MASK_PATH = join(REPO, 'pipeline', 'verify_mask.py');

const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
const maskBytes = new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin')));
const mask = new NavMask(maskMeta, maskBytes);
const harbors = JSON.parse(
  readFileSync(resolve(dataDir, 'harbors.json'), 'utf8'),
) as HarborWithReachability[];

// ---- TWIN: SEED_POINT vs pipeline/verify_mask.py's SEED_LAT, SEED_LON ----
// Same regex idiom verifyMaskConnectivity.test.ts's own readSeed() uses — no
// compiler spans Python and TypeScript, so this is the only thing that can
// catch the two drifting apart.
function readPythonSeed(): { lat: number; lon: number } {
  const py = readFileSync(VERIFY_MASK_PATH, 'utf8');
  const m = py.match(/^SEED_LAT,\s*SEED_LON\s*=\s*([\d.]+),\s*([\d.]+)/m);
  expect(
    m,
    'SEED_LAT, SEED_LON not found in pipeline/verify_mask.py (renamed, reformatted or moved) — ' +
      'update the regex above and harborReachability.ts::SEED_POINT together',
  ).not.toBeNull();
  return { lat: Number(m![1]), lon: Number(m![2]) };
}

describe('#1290 harborReachability', () => {
  it('SEED_POINT matches pipeline/verify_mask.py::SEED_LAT, SEED_LON', () => {
    const pySeed = readPythonSeed();
    expect(SEED_POINT.lat).toBe(pySeed.lat);
    expect(SEED_POINT.lon).toBe(pySeed.lon);
  });

  // ---- §3's own table, reproduced independently ----
  // The design doc's §3 measured these exact counts with a SEPARATE plain-JS
  // scratch port (never committed) reading the mask's raw bytes directly.
  // Getting the identical counts here, through this module's own
  // isNavigable()-based flood, is a real cross-check between two independent
  // implementations, not a self-consistency tautology.
  it.each(BOATS)(
    '$id: 34 ok, marstal shallow-approach, 0 unreachable, 5 known-disconnected',
    (boat) => {
      const g = defaultSafetyDepthM(boat);
      const result = computeHarborAccess(mask, harbors, boat, g);
      expect(result.size).toBe(harbors.length);
      const byState = { ok: 0, 'shallow-approach': 0, unreachable: 0, 'known-disconnected': 0 };
      for (const state of result.values()) byState[state]++;
      expect(byState.ok).toBe(34);
      expect(byState['shallow-approach']).toBe(1);
      expect(byState.unreachable).toBe(0);
      expect(byState['known-disconnected']).toBe(5);
      expect(result.get('marstal')).toBe('shallow-approach');
    },
  );

  it('known-disconnected wins over both flood and disc checks, for exactly the 5 #9 harbours', () => {
    const boat = BOATS[0];
    const g = defaultSafetyDepthM(boat);
    const result = computeHarborAccess(mask, harbors, boat, g);
    const disconnectedIds = harbors.filter((h) => h.knownDisconnected === true).map((h) => h.id);
    expect(disconnectedIds.sort()).toEqual(
      ['arnis', 'dyvig', 'graasten', 'kappeln', 'maasholm'].sort(),
    );
    for (const id of disconnectedIds) expect(result.get(id)).toBe('known-disconnected');
  });

  // ---- §3's EASY GO! row (draft 2.55 m, deferred boat, #573) ----
  // A synthetic BoatDef reproduces §3's measured composition for the one
  // catalogue boat whose gate is deep enough to reach the unreachable
  // branch at all — the three REAL catalogue boats never do (row above).
  it('synthetic 2.55 m draft: 31 ok, 2 shallow-approach, 2 unreachable, 5 known-disconnected', () => {
    const synthetic: BoatDef = {
      ...BOATS[0],
      id: 'easy-go-2026-09-17-synthetic' as BoatDef['id'],
      draftM: 2.55,
    };
    const g = defaultSafetyDepthM(synthetic);
    expect(g).toBe(3.5);
    const result = computeHarborAccess(mask, harbors, synthetic, g);
    const byState = { ok: 0, 'shallow-approach': 0, unreachable: 0, 'known-disconnected': 0 };
    for (const state of result.values()) byState[state]++;
    expect(byState.ok).toBe(31);
    expect(byState['shallow-approach']).toBe(2);
    expect(byState.unreachable).toBe(2);
    expect(byState['known-disconnected']).toBe(5);
    expect(result.get('faldsled')).toBe('shallow-approach');
    expect(result.get('rudkoebing')).toBe('shallow-approach');
    expect(result.get('augustenborg')).toBe('unreachable');
    expect(result.get('marstal')).toBe('unreachable');
  });

  // ---- Differential: the duplicated flood traversal vs NavMask's own ----
  // For every non-known-disconnected harbour, "the harbour's snapped cell is
  // in the seed flood at gate G" must agree with NavMask.cellsConnected —
  // the PRODUCTION per-pair BFS #53's relaxation retry itself calls — over a
  // UNIFORM gate. This is the differential-testing rule for a duplicated
  // algorithm (CLAUDE.md): proven equivalent by running both, not trusted by
  // reading. Runs over all three catalogue boats' own default gates so both
  // gate values (2.8 m, 3.0 m) get covered.
  it.each(BOATS)(
    '$id: flood membership agrees with NavMask.cellsConnected for every harbour',
    (boat) => {
      const g = defaultSafetyDepthM(boat);
      const gate = uniformGate(g);
      for (const harbor of harbors) {
        if (harbor.knownDisconnected === true) continue;
        const snapped = mask.snapToNavigable(harbor.snap, g);
        const floodOk = computeHarborAccess(mask, harbors, boat, g).get(harbor.id) === 'ok';
        if (!snapped) {
          expect(floodOk, `${harbor.id}: snap failed but flood reported ok`).toBe(false);
          continue;
        }
        const oracleConnected = mask.cellsConnected(SEED_POINT, snapped, gate);
        expect(floodOk, `${harbor.id} @ ${g}m: flood vs cellsConnected disagree`).toBe(
          oracleConnected,
        );
      }
    },
  );

  // ---- Oracle: shallow-approach agrees with the REAL production relaxation ----
  // marstal is the one harbour that actually exercises this path on the real
  // catalogue. findRelaxedGate discs BOTH waypoints (the seed too), where
  // this module's shallowApproachConnected only discs the harbour — the
  // seed sits in 13.1 m water (verifyMaskConnectivity.test.ts's own comment),
  // so discing it too should never change the answer for a real approach,
  // but this test does not assume that: it runs the real function and
  // checks it agrees, rather than asserting the two are the same by
  // construction.
  it.each(BOATS)('$id: marstal shallow-approach agrees with the real findRelaxedGate', (boat) => {
    const g = defaultSafetyDepthM(boat);
    const marstal = harbors.find((h) => h.id === 'marstal')!;
    const snapped = mask.snapToNavigable(marstal.snap, g)!;
    expect(snapped).not.toBeNull();
    const relaxed = findRelaxedGate(
      mask,
      [SEED_POINT, snapped],
      g,
      Infinity,
      relaxationFloorM(boat),
    );
    expect(
      relaxed,
      `${boat.id}: real relaxation search found no connecting gate for marstal`,
    ).not.toBeNull();
  });

  // ---- Cache: same (boatId, safetyDepthM) returns the SAME Map instance ----
  it('memoises on (boat.id, safetyDepthM): repeat calls return the identical Map', () => {
    const boat = BOATS[0];
    const g = defaultSafetyDepthM(boat);
    const first = computeHarborAccess(mask, harbors, boat, g);
    const second = computeHarborAccess(mask, harbors, boat, g);
    expect(second).toBe(first);
  });

  // ---- Q5 hint search: the augustenborg/marstal cases from §3's EASY GO! row ----
  it('findLowerSettingHint: augustenborg reaches ok at a lower setting, marstal reaches none down to the floor', () => {
    const synthetic: BoatDef = {
      ...BOATS[0],
      id: 'easy-go-2026-09-17-synthetic-2' as BoatDef['id'],
      draftM: 2.55,
    };
    const g = defaultSafetyDepthM(synthetic);
    const augustenborg = harbors.find((h) => h.id === 'augustenborg')!;
    const marstal = harbors.find((h) => h.id === 'marstal')!;
    const augustenborgHint = findLowerSettingHint(mask, augustenborg, synthetic, g);
    expect(augustenborgHint).not.toBeNull();
    expect(augustenborgHint!.depthM).toBeLessThan(g);
    expect(['ok', 'shallow-approach']).toContain(augustenborgHint!.state);
    const marstalHint = findLowerSettingHint(mask, marstal, synthetic, g);
    expect(marstalHint).toBeNull();
  });

  it('findLowerSettingHint returns null for a known-disconnected harbour without searching', () => {
    const boat = BOATS[0];
    const g = defaultSafetyDepthM(boat);
    const arnis = harbors.find((h) => h.id === 'arnis')!;
    expect(findLowerSettingHint(mask, arnis, boat, g)).toBeNull();
  });
});
