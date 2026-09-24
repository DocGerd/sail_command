import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NavMask } from '../lib/mask';
import { BOATS } from '../data/boats';
import { defaultSafetyDepthM, minSafetyDepthM } from '../lib/boatDepth';
import { safetyDepthFieldFor } from '../components/OptionsPanel';
import {
  computeHarborAccess,
  type HarborAccessState,
  type HarborWithReachability,
} from '../lib/harborReachability';
import type { MaskMeta } from '../types';
import { solverTimeoutMs } from './timeouts';

// #1329: `boat.harbors.hintNotFound` / `harborPicker.boatUnreachableAtOrAboveDefault`
// claim "not reachable at or above {boat}'s recommended safety depth", but
// `findLowerSettingHint` only checks gates BELOW the live one. The claim about
// deeper gates holds iff, per (boat, harbour), the reachable gates form a
// prefix of the settable range. `ok` vs `shallow-approach` is itself
// non-monotone on this mask; only the reachable/unreachable split is pinned.
const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const mask = new NavMask(
  JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta,
  new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))),
);
const harbors = JSON.parse(
  readFileSync(resolve(dataDir, 'harbors.json'), 'utf8'),
) as HarborWithReachability[];

type Reachable = (s: HarborAccessState) => boolean;
const reachable: Reachable = (s) => s === 'ok' || s === 'shallow-approach';

/** Gate (decimetres) → state, ascending. */
type Row = ReadonlyArray<readonly [number, HarborAccessState]>;

/** First gate that is reachable while a SHALLOWER gate is not, else null. */
function firstMonotonicityViolation(row: Row, isReachable: Reachable): number | null {
  let sawUnreachable = false;
  for (const [dm, state] of row) {
    if (isReachable(state)) {
      if (sawUnreachable) return dm;
    } else {
      sawUnreachable = true;
    }
  }
  return null;
}

// Gate-outer so every (boat) shares one cached flood per gate.
function measureRows(): Map<string, Row> {
  const lowDm = Math.min(...BOATS.map((b) => Math.round(minSafetyDepthM(b) * 10)));
  const highDm = Math.max(...BOATS.map((b) => Math.round(safetyDepthFieldFor(b).max * 10)));
  const rows = new Map<string, Array<readonly [number, HarborAccessState]>>();
  for (let dm = lowDm; dm <= highDm; dm++) {
    for (const boat of BOATS) {
      const field = safetyDepthFieldFor(boat);
      if (dm < Math.round(field.min * 10) || dm > Math.round(field.max * 10)) continue;
      const access = computeHarborAccess(mask, harbors, boat, dm / 10);
      for (const h of harbors) {
        if (h.knownDisconnected === true) continue;
        const key = `${boat.id}|${h.id}`;
        const row = rows.get(key) ?? [];
        row.push([dm, access.get(h.id)!]);
        rows.set(key, row);
      }
    }
  }
  return rows;
}

describe('#1329 harbour reachability is monotone in the safety depth (real mask)', () => {
  it('detector fires on a shallower-unreachable, deeper-reachable row', () => {
    expect(
      firstMonotonicityViolation(
        [
          [30, 'unreachable'],
          [31, 'ok'],
        ],
        reachable,
      ),
    ).toBe(31);
    expect(
      firstMonotonicityViolation(
        [
          [30, 'ok'],
          [31, 'shallow-approach'],
          [32, 'unreachable'],
        ],
        reachable,
      ),
    ).toBeNull();
  });

  it(
    'every catalogue boat, every settable gate, every harbour: no reachable gate above an unreachable one',
    { timeout: solverTimeoutMs(300_000) },
    () => {
      const rows = measureRows();
      const violations: string[] = [];
      let rowsWithUnreachable = 0;
      for (const [key, row] of rows) {
        if (row.some(([, s]) => s === 'unreachable')) rowsWithUnreachable++;
        const v = firstMonotonicityViolation(row, reachable);
        if (v !== null) violations.push(`${key} reachable at ${v / 10} m`);
      }
      // Non-vacuity: the unreachable branch is actually reached across the
      // range, so an empty violation list is not an empty search.
      expect(rowsWithUnreachable).toBeGreaterThan(0);
      expect(violations).toEqual([]);

      // Positive control on the REAL matrix: the same detector keyed on `ok`
      // alone does fire, because `ok` ↔ `shallow-approach` is non-monotone.
      const okOnly = [...rows].filter(
        ([, row]) => firstMonotonicityViolation(row, (s) => s === 'ok') !== null,
      );
      expect(okOnly.length).toBeGreaterThan(0);

      // Every boat's recommended depth lies inside the measured range.
      for (const boat of BOATS) {
        const def = Math.round(defaultSafetyDepthM(boat) * 10);
        const anyRow = rows.get(`${boat.id}|${harbors.find((h) => !h.knownDisconnected)!.id}`)!;
        expect(anyRow.some(([dm]) => dm === def)).toBe(true);
      }
    },
  );
});
