import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NavMask } from '../lib/mask';
import { uniformGate, APPROACH_RADIUS_M } from '../lib/depthGate';
import { findRelaxedGate } from '../routing/relaxedDepth';
import { BOATS, type BoatDef } from '../data/boats';
import { defaultSafetyDepthM, relaxationFloorM } from '../lib/boatDepth';
import { openWaterMask } from './fixtures';
import { solverTimeoutMs } from './timeouts';
import {
  computeHarborAccess,
  findLowerSettingHint,
  floodHasCell,
  SEED_POINT,
  type FloodResult,
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

const synthetic: BoatDef = {
  ...BOATS[0],
  id: 'harborReachability-fixture-easy-go' as BoatDef['id'],
  draftM: 2.55,
};

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
  // scratch port (never committed) reading the mask's raw bytes directly, and
  // its own §3 text flags that port's snap/disc halves as uncontrolled beyond
  // the marstal row. Matching its counts here is corroboration for the FILL,
  // not a proof for the snap/disc boundary — see the oracle tests below for
  // that half's own evidence (PR #1316 fix-wave 1 Minor: this comment
  // previously over-claimed "two independent implementations… not a
  // self-consistency tautology" for the whole state, not just the fill).
  it.each(BOATS)(
    '$id: 34 ok, marstal shallow-approach, 0 unreachable, 5 known-disconnected',
    { timeout: solverTimeoutMs(300_000) },
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
  it(
    'synthetic 2.55 m draft: 31 ok, 2 shallow-approach, 2 unreachable, 5 known-disconnected',
    { timeout: solverTimeoutMs(300_000) },
    () => {
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
    },
  );

  // ---- Differential: the duplicated flood traversal vs NavMask's own ----
  // For every non-known-disconnected harbour, "the harbour's snapped cell is
  // in the seed flood at gate G" must agree with NavMask.cellsConnected —
  // the PRODUCTION per-pair BFS #53's relaxation retry itself calls — over a
  // UNIFORM gate. This is the differential-testing rule for a duplicated
  // algorithm (CLAUDE.md): proven equivalent by running both, not trusted by
  // reading. Runs over all three catalogue boats' own default gates so both
  // gate values (2.8 m, 3.0 m) get covered.
  //
  // PR #1316 fix-wave 1 Major 1: NONE of these three gates is a verified
  // 4- vs 8-connectivity divergence point on this mask, so this block alone
  // cannot catch a broken neighbourhood (measured: substituting an
  // 8-neighbourhood here left all three rows GREEN). See the DIVERGENCE
  // block below, which is what actually closes that gap.
  it.each(BOATS)(
    '$id: flood membership agrees with NavMask.cellsConnected for every harbour',
    { timeout: solverTimeoutMs(300_000) },
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

  // ---- Differential, at the VERIFIED first-divergence points ----
  // PR #1316 fix-wave 1 Major 1. `rudkoebing`@3.5, `troense`@4.2 and
  // `flensburg`@8.8 are the three (harbour, gate) pairs
  // `verifyMaskConnectivity.test.ts`'s own `SAMPLE` names as where 4- and
  // 8-connectivity first diverge on this committed mask (re-measured there
  // over every decimetre gate 0.1-14.0 m) — without a row at one of these,
  // a broken neighbourhood in `floodFromSeed` passes silently, because
  // neither this module's own default gates (2.8/3.0/3.5 m) nor most
  // arbitrary gates are divergence points at all. Uses `computeHarborAccess`
  // (the real entry point), not `floodFromSeed` directly, so the assertion
  // exercises the same code path a consumer does.
  const DIVERGENCE_SAMPLE: ReadonlyArray<readonly [string, number]> = [
    ['rudkoebing', 3.5],
    ['troense', 4.2],
    ['flensburg', 8.8],
  ];

  it.each(DIVERGENCE_SAMPLE)(
    '%s at a %s m gate: flood membership agrees with NavMask.cellsConnected (verified first-divergence point)',
    { timeout: solverTimeoutMs(300_000) },
    (hid, gateM) => {
      const harbor = harbors.find((h) => h.id === hid);
      expect(harbor, `fixture harbor "${hid}" missing from harbors.json`).toBeDefined();
      const snapped = mask.snapToNavigable(harbor!.snap, gateM);
      expect(snapped, `${hid}@${gateM}m: snap failed`).not.toBeNull();
      const floodOk = computeHarborAccess(mask, harbors, BOATS[0], gateM).get(hid) === 'ok';
      const oracleConnected = mask.cellsConnected(SEED_POINT, snapped!, uniformGate(gateM));
      expect(floodOk, `${hid}@${gateM}m: flood vs cellsConnected disagree`).toBe(oracleConnected);
    },
  );

  // ---- Oracle: shallow-approach agrees with the REAL production relaxation ----
  // PR #1316 fix-wave 1 Major 2 REPLACES the prior version of this block,
  // which called `findRelaxedGate` with `Infinity` as `approachRadiusM` —
  // `depthGate.ts`'s documented KILL SWITCH, which disables discing
  // entirely and so never exercised the shipped 1 nm disc behaviour this
  // module's own `shallowApproachConnected` implements. Uses the REAL
  // `APPROACH_RADIUS_M` here. `findRelaxedGate` still discs BOTH waypoints
  // (the seed too) where `shallowApproachConnected` only discs the harbour —
  // the seed sits in 13.1 m water (verifyMaskConnectivity.test.ts's own
  // comment), so discing it too should never change the answer for a real
  // approach, but this test does not assume that: it runs the real function
  // and checks it AGREES, rather than asserting the two are the same by
  // construction.
  it.each(BOATS)(
    '$id: marstal shallow-approach agrees with the real findRelaxedGate at the shipped disc radius',
    { timeout: solverTimeoutMs(300_000) },
    (boat) => {
      const g = defaultSafetyDepthM(boat);
      const marstal = harbors.find((h) => h.id === 'marstal')!;
      const state = computeHarborAccess(mask, harbors, boat, g).get('marstal');
      const snapped = mask.snapToNavigable(marstal.snap, g)!;
      expect(snapped).not.toBeNull();
      const relaxed = findRelaxedGate(
        mask,
        [SEED_POINT, snapped],
        g,
        APPROACH_RADIUS_M,
        relaxationFloorM(boat),
      );
      expect(state !== 'unreachable', `${boat.id}: marstal state vs oracle disagree`).toBe(
        relaxed !== null,
      );
    },
  );

  // Comprehensive form of the oracle, over EVERY non-known-disconnected
  // harbour of the one boat that actually reaches BOTH the `unreachable` and
  // `shallow-approach` branches on the real catalogue (§3's EASY GO! row) —
  // the reviewer's own suggested fix for Major 2, run as specified.
  it(
    'synthetic 2.55 m draft: every non-known-disconnected harbour agrees with the real findRelaxedGate at the shipped disc radius',
    { timeout: solverTimeoutMs(300_000) },
    () => {
      const g = defaultSafetyDepthM(synthetic);
      const result = computeHarborAccess(mask, harbors, synthetic, g);
      let checked = 0;
      for (const harbor of harbors) {
        if (harbor.knownDisconnected === true) continue;
        const state = result.get(harbor.id);
        const snapped = mask.snapToNavigable(harbor.snap, g);
        if (!snapped) {
          expect(state, `${harbor.id}: snap failed but state is not unreachable`).toBe(
            'unreachable',
          );
          checked++;
          continue;
        }
        const relaxed = findRelaxedGate(
          mask,
          [SEED_POINT, snapped],
          g,
          APPROACH_RADIUS_M,
          relaxationFloorM(synthetic),
        );
        expect(state !== 'unreachable', `${harbor.id}: state vs oracle disagree`).toBe(
          relaxed !== null,
        );
        checked++;
      }
      // Both directions must actually have been exercised — a filter bug
      // that skipped every harbour would otherwise pass vacuously.
      expect(checked).toBe(harbors.length - 5);
    },
  );

  // ---- Cache: same (mask, harbors, boat.id, safetyDepthM) returns the SAME Map ----
  it('memoises on (mask, harbors, boat.id, safetyDepthM): repeat calls return the identical Map', () => {
    const boat = BOATS[0];
    const g = defaultSafetyDepthM(boat);
    const first = computeHarborAccess(mask, harbors, boat, g);
    const second = computeHarborAccess(mask, harbors, boat, g);
    expect(second).toBe(first);
  });

  // ---- Cache correctness: PR #1316 fix-wave 1 Major 4 ----
  // Reproduces the pre-fix defect directly: a cache keyed only on
  // `${boat.id}@${depth}` cannot tell two DIFFERENT masks apart, so the
  // second call below would (under the old bug) silently return the FIRST
  // mask's cached Map, computed for a mask with a different `meta` entirely.
  it('caches independently per NavMask instance, not merely per (boatId, depth)', () => {
    const boat = BOATS[0];
    const g = defaultSafetyDepthM(boat);
    const resultForRealMask = computeHarborAccess(mask, harbors, boat, g);
    // openWaterMask() uses TEST_MASK_META (54.3-55.3N, 9.4-11.0E), a
    // DIFFERENT grid shape than the real committed mask, and SEED_POINT
    // falls inside its bounds — a small, genuinely different NavMask
    // instance, not a clone.
    const syntheticMask = openWaterMask();
    const resultForSyntheticMask = computeHarborAccess(syntheticMask, harbors, boat, g);
    expect(resultForSyntheticMask).not.toBe(resultForRealMask);
  });

  // Reproduces the other half of the same pre-fix defect: a cache keyed only
  // on `${boat.id}@${depth}` cannot tell a FILTERED harbours array from the
  // full catalogue, so a later full-catalogue call would (under the old bug)
  // silently return the earlier filtered call's partial Map — `.get(id)` on
  // an id outside the filtered set then returns `undefined`, a third value
  // `HarborAccessByHarbor`'s own doc comment says must never happen.
  it('caches independently per harbors array reference, not merely per (boatId, depth)', () => {
    const boat = BOATS[0];
    const g = defaultSafetyDepthM(boat);
    const filteredHarbors = harbors.slice(0, 5);
    const filteredResult = computeHarborAccess(mask, filteredHarbors, boat, g);
    expect(filteredResult.size).toBe(5);

    const fullResult = computeHarborAccess(mask, harbors, boat, g);
    expect(fullResult.size).toBe(harbors.length);
    expect(fullResult).not.toBe(filteredResult);
    // Every id outside the filtered set must be genuinely present, not
    // `undefined` from a stale partial cache entry.
    for (const harbor of harbors.slice(5)) {
      expect(
        fullResult.get(harbor.id),
        `${harbor.id} missing from the full-catalogue result`,
      ).toBeDefined();
    }
  });

  // ---- Q5 hint search ----
  // PR #1316 fix-wave 2 (maintainer ruling) raised the search floor from
  // `minSafetyDepthM(boat)` to `defaultSafetyDepthM(boat)` — measured against
  // the real mask, this moves BOTH augustenborg's and marstal's synthetic-boat
  // "found" case below the new floor entirely (their whole reachable band for
  // this boat sits under 3.5 m), so §3's EASY GO! row no longer demonstrates
  // the 'found' path. faldsled DOES: 'ok'/'shallow-approach' from 3.5 m up
  // through 5.0 m, 'unreachable' from 5.1 m — measured by sweeping
  // `computeHarborAccess` across that boat/harbour pair.
  it(
    'findLowerSettingHint: faldsled reaches shallow-approach at a lower setting within the default budget',
    { timeout: solverTimeoutMs(300_000) },
    () => {
      const faldsled = harbors.find((h) => h.id === 'faldsled')!;
      const outcome = findLowerSettingHint(mask, faldsled, synthetic, 5.2);
      expect(outcome).toEqual({ kind: 'found', hint: { depthM: 5, state: 'shallow-approach' } });
    },
  );

  it(
    'findLowerSettingHint: marstal has no answer down to the floor (scanned in full, under the default budget)',
    { timeout: solverTimeoutMs(300_000) },
    () => {
      const marstal = harbors.find((h) => h.id === 'marstal')!;
      const outcome = findLowerSettingHint(mask, marstal, synthetic, 4.6);
      expect(outcome.kind).toBe('not-found');
    },
  );

  // PR #1316 fix-wave 2 maintainer ruling: the raised floor's accepted cost.
  // augustenborg's ENTIRE reachable band for the synthetic boat sits BELOW
  // `defaultSafetyDepthM(synthetic)` (measured, same sweep as faldsled's
  // above) — #1293 raises `clampSettingsToBoat`'s own floor to the boat's
  // default on a boat switch, so a hint below it would be silently clamped
  // away the instant the app applied it. This pins that the search therefore
  // returns `'not-found'` rather than a depth the app would then undo.
  it('findLowerSettingHint never returns a hint below defaultSafetyDepthM(boat)', () => {
    const g = defaultSafetyDepthM(synthetic);
    const augustenborg = harbors.find((h) => h.id === 'augustenborg')!;
    const outcome = findLowerSettingHint(mask, augustenborg, synthetic, g + 0.1);
    expect(outcome).toEqual({ kind: 'not-found' });
  });

  // PR #1316 fix-wave 1 Major 5: the step budget and its resumability
  // contract. A caller supplying a small `maxSteps` must see `'exhausted'`
  // with a `resumeFromDepthM` that, fed back in as the next call's
  // `safetyDepthM`, continues the SAME downward scan rather than restarting
  // it. Pins the EXACT `resumeFromDepthM` sequence a correct resume must
  // produce for this boat/harbour/depth (topDm 43, floorDm 35 under the
  // fix-wave-2 floor, so decimetres 43-41 / 40-38 / 37-35 across three
  // budget-3 calls — a resume that restarted from the top, or skipped a
  // decimetre, would diverge from this exact sequence), and confirms the
  // chain still ends at marstal's known full-range answer ('not-found',
  // pinned above).
  it(
    'findLowerSettingHint is resumable across a step budget, continuing rather than restarting the scan',
    { timeout: solverTimeoutMs(300_000) },
    () => {
      const marstal = harbors.find((h) => h.id === 'marstal')!;
      const first = findLowerSettingHint(mask, marstal, synthetic, 4.4, 3);
      expect(first).toEqual({ kind: 'exhausted', resumeFromDepthM: 4.1 });
      const second =
        first.kind === 'exhausted'
          ? findLowerSettingHint(mask, marstal, synthetic, first.resumeFromDepthM, 3)
          : null;
      expect(second).toEqual({ kind: 'exhausted', resumeFromDepthM: 3.8 });
      const third =
        second?.kind === 'exhausted'
          ? findLowerSettingHint(mask, marstal, synthetic, second.resumeFromDepthM, 3)
          : null;
      expect(third).toEqual({ kind: 'not-found' });
    },
  );

  it('findLowerSettingHint returns not-found for a known-disconnected harbour without searching', () => {
    const boat = BOATS[0];
    const g = defaultSafetyDepthM(boat);
    const arnis = harbors.find((h) => h.id === 'arnis')!;
    expect(findLowerSettingHint(mask, arnis, boat, g)).toEqual({ kind: 'not-found' });
  });

  // PR #1316 fix-wave 2 Minor: `maxSteps <= 0` must not silently make no
  // progress — that would return `resumeFromDepthM === safetyDepthM`
  // unchanged and loop a caller following the resume contract above forever.
  it(
    'findLowerSettingHint clamps a non-positive maxSteps to make at least one step of progress',
    { timeout: solverTimeoutMs(300_000) },
    () => {
      const marstal = harbors.find((h) => h.id === 'marstal')!;
      const outcome = findLowerSettingHint(mask, marstal, synthetic, 4.4, 0);
      expect(outcome).toEqual({ kind: 'exhausted', resumeFromDepthM: 4.3 });
    },
  );

  // PR #1316 fix-wave 2 Minor: `floodHasCell`'s shape guard (exported for
  // this test only) is unreachable through the public API — the per-`NavMask`
  // cache keying prevents the mismatch from arising naturally — so it must be
  // pinned directly with a synthetic, deliberately mismatched `FloodResult`.
  it('floodHasCell fails closed on a FloodResult shaped for a different mask', () => {
    const validIdx = 0;
    // All-ones bits: absent the shape guard, `hasBit` would read a `1` here
    // and the function would (wrongly) return `true`.
    const allOnes = (n: number) => new Uint8Array(Math.ceil(n / 8)).fill(0xff);

    const wrongRows: FloodResult = {
      bits: allOnes(mask.meta.rows * mask.meta.cols),
      rows: mask.meta.rows + 1,
      cols: mask.meta.cols,
    };
    expect(floodHasCell(wrongRows, mask, validIdx)).toBe(false);

    const wrongCols: FloodResult = {
      bits: allOnes(mask.meta.rows * mask.meta.cols),
      rows: mask.meta.rows,
      cols: mask.meta.cols + 1,
    };
    expect(floodHasCell(wrongCols, mask, validIdx)).toBe(false);

    const wrongBitsLength: FloodResult = {
      bits: allOnes(mask.meta.rows * mask.meta.cols + 8),
      rows: mask.meta.rows,
      cols: mask.meta.cols,
    };
    expect(floodHasCell(wrongBitsLength, mask, validIdx)).toBe(false);
  });
});
