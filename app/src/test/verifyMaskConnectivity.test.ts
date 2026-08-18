import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NavMask } from '../lib/mask';
import { uniformGate } from '../lib/depthGate';
import { BOATS, type BoatDef } from '../data/boats';
import { defaultSafetyDepthM } from '../lib/boatDepth';
import type { LatLon, MaskMeta } from '../types';

// #550 (spec C.6): pipeline/verify_mask.py's per-harbor connectivity flood
// fill is the acceptance criterion for a new catalogue boat's derived depth
// gate, but `Mask integrity` (verify-mask.yml) is NOT a required check —
// `protect-main` requires only `app` and `e2e` (see CLAUDE.md's "Python
// gates live OUTSIDE the app toolchain" bullet) — so a connectivity
// regression there merges silently. This file promotes exactly that half of
// the pipeline check into the REQUIRED `app` Vitest suite by re-running it
// here, against the SAME committed mask.bin/harbors.json, for every boat in
// the real catalogue (`BOATS`).
//
// SCOPE, deliberately narrow: only the connectivity gate. The gate
// DERIVATION twin (draft -> gate) already exists in
// verifyMaskBoatGate.test.ts (Task 13); this file does not repeat it. The
// water/land depth probes and the harbor-snap >= 2.2 m sanity check stay
// Python-only — they are general mask-sanity assertions, not the "does a
// new boat's gate strand a harbor" safety property spec C.6 is about, and
// porting them would widen this PR well past a mechanical CI-gating fix.
//
// TWIN: the exception table and the known-disconnected allowlist are read
// DIRECTLY out of pipeline/verify_mask.py's own source via regex (same idiom
// as verifyMaskBoatGate.test.ts's readGateDerivationCases / maskTolerance
// .test.ts's readToleranceM) rather than hand-copied here — a hand copy
// would be a THIRD place these two lists could drift out of sync, on top of
// the Python source and this file.
//
// PERFORMANCE, why there are TWO connectivity implementations below rather
// than one: `NavMask.cellsConnected` (the production per-PAIR BFS #53's
// depth-relaxation retry calls at plan time) is the obviously-correct choice
// — zero new algorithm, zero differential-testing burden — but MEASURED
// 2026-08-18 on this checkout at ~3.1 s for one boat's 33 harbors (a fresh
// BFS per harbor, worst case exploring the whole reachable component before
// giving up on a disconnected one). Vitest's DEFAULT per-test timeout is
// 5000 ms, and CI runs ~2.1x slower than local (CLAUDE.md's measured
// `npm run test` ratio) — 3.1 s locally could exceed 6 s in CI, over the
// default budget, and get WORSE every time the catalogue grows a boat.
// `reachableSetAtGate` below instead does ONE flood fill per DISTINCT gate
// (not per harbor), matching pipeline/verify_mask.py's own
// `ndimage.label`-per-gate shape — measured ~200 ms per boat, comfortably
// under the default timeout with headroom for catalogue growth. Because
// this is a second implementation of the same connectivity predicate, the
// differential-testing rule below applies: it is proven equivalent to
// `NavMask.cellsConnected` on a representative harbor sample (connected,
// exception-covered, and known-disconnected cases), not trusted by reading.

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VERIFY_MASK_PATH = join(REPO, 'pipeline', 'verify_mask.py');

const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
const maskBytes = new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin')));
const mask = new NavMask(maskMeta, maskBytes);

interface HarborFixture {
  readonly id: string;
  readonly snap: LatLon;
}
const harbors = JSON.parse(
  readFileSync(resolve(dataDir, 'harbors.json'), 'utf8'),
) as HarborFixture[];

// ---- Config read out of pipeline/verify_mask.py's own source ----

function readSeed(): LatLon {
  const py = readFileSync(VERIFY_MASK_PATH, 'utf8');
  const m = py.match(/^SEED_LAT,\s*SEED_LON\s*=\s*([\d.]+),\s*([\d.]+)/m);
  expect(
    m,
    'SEED_LAT, SEED_LON not found in pipeline/verify_mask.py (renamed, reformatted or moved) — ' +
      'update the regex above alongside the pipeline change',
  ).not.toBeNull();
  return { lat: Number(m![1]), lon: Number(m![2]) };
}

/** Keyed `${harborId}@${gateDm}` — decimetre integer, never a stringified
 * float, so this can never miss a match over a float-formatting difference
 * between how Python and TypeScript render the same whole-decimetre gate. */
function readConnectivityExceptions(): Map<string, number> {
  const py = readFileSync(VERIFY_MASK_PATH, 'utf8');
  const block = py.match(
    /^CONNECTIVITY_EXCEPTIONS_M\s*:\s*dict\[tuple\[str,\s*float\],\s*float\]\s*=\s*\{([\s\S]*?)^\}/m,
  );
  expect(
    block,
    'CONNECTIVITY_EXCEPTIONS_M literal not found in pipeline/verify_mask.py (renamed, retyped or ' +
      'reformatted) — update this regex alongside the pipeline change',
  ).not.toBeNull();
  const out = new Map<string, number>();
  for (const m of block![1].matchAll(
    /\(\s*"([a-z0-9-]+)"\s*,\s*([\d.]+)\s*\)\s*:\s*([\d.]+)\s*,/g,
  )) {
    out.set(`${m[1]}@${Math.round(Number(m[2]) * 10)}`, Number(m[3]));
  }
  return out;
}

function readKnownDisconnected(): Set<string> {
  const py = readFileSync(VERIFY_MASK_PATH, 'utf8');
  const block = py.match(/^KNOWN_DISCONNECTED\s*:\s*dict\[str,\s*str\]\s*=\s*\{([\s\S]*?)^\}/m);
  expect(
    block,
    'KNOWN_DISCONNECTED literal not found in pipeline/verify_mask.py (renamed, retyped or ' +
      'reformatted) — update this regex alongside the pipeline change',
  ).not.toBeNull();
  const out = new Set<string>();
  for (const m of block![1].matchAll(/^\s*"([a-z0-9-]+)"\s*:/gm)) {
    out.add(m[1]);
  }
  return out;
}

// ---- Fast connectivity: one flood fill per distinct gate ----

function cellOf(p: LatLon): { row: number; col: number } | null {
  const latStep = (maskMeta.north - maskMeta.south) / maskMeta.rows;
  const lonStep = (maskMeta.east - maskMeta.west) / maskMeta.cols;
  const row = Math.floor((p.lat - maskMeta.south) / latStep);
  const col = Math.floor((p.lon - maskMeta.west) / lonStep);
  if (row < 0 || row >= maskMeta.rows || col < 0 || col >= maskMeta.cols) return null;
  return { row, col };
}

/** Mirrors NavMask's private byteToDepthM (byte 0 = land, byte 255 = capped
 * >= 25.4 m, else byte/10) — the same decode `NavMask.cellsConnected` uses,
 * which is exactly what the differential test below exists to confirm. */
function byteToDepthM(b: number): number {
  return b === 0 ? 0 : b === 255 ? 25.4 : b / 10;
}

/** 4-connected BFS from `seed`, one pass, over cells with depth >= gateM.
 * Mirrors pipeline/verify_mask.py's per-gate `ndimage.label` sweep. */
function reachableSetAtGate(seed: LatLon, gateM: number): Uint8Array {
  const { rows, cols } = maskMeta;
  const visited = new Uint8Array(rows * cols);
  const seedCell = cellOf(seed);
  if (!seedCell) return visited;
  const startIdx = seedCell.row * cols + seedCell.col;
  if (byteToDepthM(maskBytes[startIdx]) < gateM) return visited;
  const queue = new Int32Array(rows * cols);
  let head = 0;
  let tail = 0;
  visited[startIdx] = 1;
  queue[tail++] = startIdx;
  while (head < tail) {
    const idx = queue[head++];
    const row = (idx / cols) | 0;
    const col = idx - row * cols;
    const neighbors: ReadonlyArray<readonly [number, number]> = [
      [row - 1, col],
      [row + 1, col],
      [row, col - 1],
      [row, col + 1],
    ];
    for (const [nr, nc] of neighbors) {
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nIdx = nr * cols + nc;
      if (visited[nIdx]) continue;
      if (byteToDepthM(maskBytes[nIdx]) < gateM) continue;
      visited[nIdx] = 1;
      queue[tail++] = nIdx;
    }
  }
  return visited;
}

function connectedAtGate(reachable: Uint8Array, p: LatLon): boolean {
  const c = cellOf(p);
  return c !== null && reachable[c.row * maskMeta.cols + c.col] === 1;
}

describe('#550: mask connectivity is a REQUIRED check (promoted from advisory verify-mask.yml)', () => {
  const SEED = readSeed();
  const EXCEPTIONS = readConnectivityExceptions();
  const KNOWN_DISCONNECTED = readKnownDisconnected();

  /**
   * Mirrors pipeline/verify_mask.py's per-boat connectivity loop: every
   * harbor snap must 4-connect to the open-water seed at the boat's derived
   * gate (or its exception gate), UNLESS the harbor is in
   * KNOWN_DISCONNECTED. Returns one string per failing harbor; an empty
   * array is the pass case.
   */
  function connectivityFailures(boat: BoatDef): string[] {
    const gateM = defaultSafetyDepthM(boat);
    const gateDm = Math.round(gateM * 10);
    const cache = new Map<number, Uint8Array>();
    const reachableAt = (m: number): Uint8Array => {
      const key = Math.round(m * 10);
      let r = cache.get(key);
      if (!r) {
        r = reachableSetAtGate(SEED, m);
        cache.set(key, r);
      }
      return r;
    };
    const failures: string[] = [];
    for (const h of harbors) {
      const exceptionM = EXCEPTIONS.get(`${h.id}@${gateDm}`);
      const effectiveGateM = exceptionM ?? gateM;
      const connected = connectedAtGate(reachableAt(effectiveGateM), h.snap);
      if (!connected && !KNOWN_DISCONNECTED.has(h.id)) {
        failures.push(
          `${boat.id}: harbor ${h.id} not reachable from open water at gate ${effectiveGateM} m ` +
            `(derived gate ${gateM} m)`,
        );
      }
    }
    return failures;
  }

  describe('differential proof: the fast flood-fill agrees with NavMask.cellsConnected', () => {
    // Representative sample spanning every case the check needs to get
    // right: a deeply-connected harbor, a zero-margin one (#245/#455), the
    // two exception-covered harbors, and two KNOWN_DISCONNECTED ones.
    const SAMPLE = ['flensburg', 'aabenraa', 'marstal', 'augustenborg', 'arnis', 'dyvig'];

    it.each(SAMPLE)('%s at the default 3.0 m gate', (hid) => {
      const h = harbors.find((x) => x.id === hid);
      expect(h, `fixture harbor "${hid}" missing from harbors.json — update SAMPLE`).toBeDefined();
      const gateM = 3.0;
      const reachable = reachableSetAtGate(SEED, gateM);
      const fast = connectedAtGate(reachable, h!.snap);
      const slow = mask.cellsConnected(SEED, h!.snap, uniformGate(gateM));
      expect(fast).toBe(slow);
    });
  });

  it.each(BOATS)('$id: every harbor reaches open water at its derived gate', (boat) => {
    expect(connectivityFailures(boat)).toEqual([]);
  });

  // "Prove the guard can fail" (CLAUDE.md): an absurdly deep-drafted
  // fixture boat — never added to BOATS — derives a gate far past anything
  // this fjord's bathymetry connects at, so every harbor not already in
  // KNOWN_DISCONNECTED comes back unreachable. This is what a real
  // catalogue regression (a new boat whose draft strands a harbor) would
  // look like in this check.
  it('guard-fires proof: an absurd-draft fixture boat is reported as disconnected', () => {
    const fixtureBoat: BoatDef = {
      id: 'fixture-absurd-draft-550',
      name: 'fixture (test-only, never added to BOATS)',
      draftM: 50,
      motorSpeedKn: 6,
      maneuverPenaltyS: 30,
      sails: [],
    };
    const failures = connectivityFailures(fixtureBoat);
    expect(failures.length).toBeGreaterThan(harbors.length - KNOWN_DISCONNECTED.size - 1);
  });
});
