import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { BOATS, boatById, DEFAULT_BOAT_ID } from '../data/boats';
import { defaultSafetyDepthM } from '../lib/boatDepth';
import { MASK_TOLERANCE_M } from '../lib/mask';

// #54 Task 13 (spec C.6). pipeline/verify_mask.py scans harbour connectivity at
// every catalogue boat's DERIVED gate instead of one hardcoded 3.0 m. It is
// Python, the catalogue is TypeScript, and no compiler spans the two — so the
// change created two cross-language twins and this file is what keeps both
// honest. Same idiom as maskTolerance.test.ts / useBannerHeight.test.ts:
// readFileSync a sibling artifact, regex a value out of it, and fail CLOSED —
// an explicit not.toBeNull() BEFORE any value comparison, so a regex that
// silently stops matching reds loudly instead of passing quietly (#223).
//
// TWIN A — the draft. verify_mask.py reads draftM from
// pipeline/polars-source.json because it cannot import boats.ts. Two copies of
// a safety-critical number; a drift means the pipeline verifies a gate the app
// never routes at.
//
// TWIN B — the gate derivation. ceilToDecimetre(draftM + TOLERANCE_M) now
// exists in both languages. verify_mask.py carries a table of
// (draft, expected gate) rows and asserts its own implementation against them
// at import time; this file asserts the TypeScript implementation against the
// SAME rows. Needle and haystack are different artifacts on every row.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VERIFY_MASK_PATH = join(REPO, 'pipeline', 'verify_mask.py');
const POLARS_SOURCE_PATH = join(REPO, 'pipeline', 'polars-source.json');

interface SourceBoat {
  readonly id: string;
  readonly draftM?: unknown;
}

function readPipelineBoats(): SourceBoat[] {
  const parsed = JSON.parse(readFileSync(POLARS_SOURCE_PATH, 'utf8')) as { boats?: unknown };
  expect(
    Array.isArray(parsed.boats),
    'pipeline/polars-source.json has no `boats` array — restructured out from under this parse',
  ).toBe(true);
  const boats = parsed.boats as SourceBoat[];
  expect(boats.length, 'pipeline/polars-source.json lists no boats').toBeGreaterThan(0);
  return boats;
}

/**
 * verify_mask.py's GATE_DERIVATION_CASES, as (draftM, expected gate) pairs.
 *
 * Anchored on the annotated assignment and terminated by the closing bracket at
 * column 0, so it cannot run past the end of the literal into unrelated tuples
 * further down the file.
 */
function readGateDerivationCases(): Array<{ draftM: number; gateM: number }> {
  const py = readFileSync(VERIFY_MASK_PATH, 'utf8');
  const block = py.match(
    /^GATE_DERIVATION_CASES\s*:\s*list\[tuple\[float,\s*float\]\]\s*=\s*\[([\s\S]*?)^\]/m,
  );
  expect(
    block,
    'GATE_DERIVATION_CASES literal not found in pipeline/verify_mask.py (renamed, retyped or ' +
      'reformatted) — update this regex alongside the pipeline change',
  ).not.toBeNull();
  const rows = [...block![1].matchAll(/\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g)].map((m) => ({
    draftM: Number(m[1]),
    gateM: Number(m[2]),
  }));
  expect(rows.length, 'GATE_DERIVATION_CASES parsed to zero rows').toBeGreaterThan(0);
  return rows;
}

describe('#54 twin A: the catalogue draft and the pipeline draft are one number', () => {
  it('the catalogue and pipeline boat id sets are identical', () => {
    // Both directions matter and they fail differently. A catalogue boat with
    // no pipeline entry SHIPS WITHOUT a verify_mask.py run at its own derived
    // gate, which is exactly what spec C.6 forbids; a pipeline boat with no
    // catalogue entry makes the script scan a gate nothing routes at.
    const pipelineIds = readPipelineBoats()
      .map((b) => b.id)
      .sort();
    expect(pipelineIds).toEqual(BOATS.map((b) => b.id).sort());
  });

  it('every catalogue boat carries the same draftM in pipeline/polars-source.json', () => {
    const pipelineBoats = readPipelineBoats();
    for (const boat of BOATS) {
      const src = pipelineBoats.find((b) => b.id === boat.id);
      expect(src, `no boat ${boat.id} in polars-source.json`).toBeDefined();
      expect(
        typeof src!.draftM,
        `polars-source.json ${boat.id}: draftM missing or not a number — verify_mask.py derives ` +
          'its connectivity gate from this field and fails closed without it',
      ).toBe('number');
      expect(src!.draftM).toBe(boat.draftM);
    }
  });
});

describe('#54 twin B: verify_mask.py derives the same gate as lib/boatDepth.ts', () => {
  const cases = readGateDerivationCases();
  const asBoat = (draftM: number) => ({ ...boatById(DEFAULT_BOAT_ID), id: 'twin-probe', draftM });

  it.each(cases)('draft $draftM m -> gate $gateM m', ({ draftM, gateM }) => {
    expect(defaultSafetyDepthM(asBoat(draftM))).toBe(gateM);
  });

  // The rows above are only as good as the table they come from (#411, "a
  // guard's DATA needs a twin"). What discriminates is a property of
  // (draft + T) * 10, NOT of the draft: a decimetre draft is blind to the
  // round-down and banker's-tie hazards but reaches the nudge hazard perfectly
  // well, which is why 3.20 is in the table. These three assert the table still
  // contains a row for each hazard, so it cannot be quietly weakened to a set
  // of values that happen to pass. Each names a different row: deleting one row
  // reds one of them.
  it('the table still contains a row that lands exactly on a rounding tie', () => {
    // (draft + T) * 10 exactly n + 0.5. Python's round() is BANKER'S rounding,
    // which picks the nearest EVEN decimetre — for 30.5 that is 30, a gate
    // below draft + T. Only verify_mask.py's own import-time assert can observe
    // that; this row is what keeps the input it needs in the table. (2.15
    // today.)
    const ties = cases.filter((c) => {
      const tenths = (c.draftM + MASK_TOLERANCE_M) * 10;
      return tenths - Math.floor(tenths) === 0.5;
    });
    expect(ties.length, 'no exact-tie draft left in GATE_DERIVATION_CASES').toBeGreaterThan(0);
  });

  it('the table still contains a row where Math.round would give a different gate', () => {
    // Rounding to nearest instead of up puts the gate UNDER draft + T:
    // (1.73 + 0.9) * 10 is 26.299999999999997, so nearest gives 2.6 against a
    // 2.63 m requirement. Same hazard class as spec C.8's measured
    // Math.round(1.73 * 10) === 17, one level out — that one is about the
    // relaxation floor, this one about the gate. (1.73 today.)
    const discriminating = cases.filter(
      (c) => Math.round((c.draftM + MASK_TOLERANCE_M) * 10) / 10 !== c.gateM,
    );
    expect(
      discriminating.length,
      'no round-vs-ceiling discriminating draft left in GATE_DERIVATION_CASES',
    ).toBeGreaterThan(0);
  });

  it('the table still contains a row where a bare Math.ceil would give a different gate', () => {
    // Without the 1e-9 nudge, float residue buys a whole decimetre of gate the
    // boat never asked for: (3.2 + 0.9) * 10 is 41.00000000000001. (3.2 today.)
    const discriminating = cases.filter(
      (c) => Math.ceil((c.draftM + MASK_TOLERANCE_M) * 10) / 10 !== c.gateM,
    );
    expect(
      discriminating.length,
      'no nudge-discriminating draft left in GATE_DERIVATION_CASES',
    ).toBeGreaterThan(0);
  });
});
