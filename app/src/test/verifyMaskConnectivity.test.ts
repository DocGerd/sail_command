import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NavMask } from '../lib/mask';
import { APPROACH_RADIUS_M, approachGate, uniformGate, type DepthGate } from '../lib/depthGate';
import { BOATS, type BoatDef } from '../data/boats';
import { defaultSafetyDepthM } from '../lib/boatDepth';
import { makeMask, TEST_MASK_META } from './fixtures';
import { solverTimeoutMs } from './timeouts';
import type { LatLon, MaskMeta } from '../types';

// #550 (spec C.6): pipeline/verify_mask.py's per-harbor connectivity flood
// fill is the acceptance criterion for a new catalogue boat's derived depth
// gate, but `Mask integrity` (verify-mask.yml) is NOT a required check —
// `protect-main` requires only `app` and `e2e` (see CLAUDE.md's "Python
// gates live OUTSIDE the app toolchain" bullet) — so a connectivity
// regression there merges silently. This file promotes only the
// harbour-reachability assertion of the pipeline check into the REQUIRED
// `app` Vitest suite by re-running it here, against the SAME committed
// mask.bin/harbors.json, for every boat in the real catalogue (`BOATS`).
//
// #1256 appended two further describe blocks at the END of this file, with
// their own header: a probe-sequence differential for `NavMask.cellsConnected`
// and its scratch-reuse guards. They are here because this file already loads
// the real mask; the scope note below governs the #550 block only.
//
// SCOPE, deliberately narrow — only the harbour-reachability assertion.
// Everything else in verify_mask.py's connectivity section stays
// Python-only, including checks that are part of the SAME gate this file
// claims to promote, not just unrelated sanity probes (PR #568 review,
// MINOR 7):
//   - a KNOWN_DISCONNECTED harbour that has become connected (a stale
//     allowlist entry — Python fails the run; this file does not check it,
//     so the required gate's own suppression list can rot with nothing red
//     anywhere — the one with real teeth);
//   - an exception that is no longer needed because the harbour reaches
//     open water unaided;
//   - an exception keyed to a gate no catalogue boat derives, or one that
//     does not lower its own gate;
//   - the seed's own navigability (Python asserts `seed_cells != 0`
//     directly; here a non-navigable seed instead reports every harbour
//     unreachable, pointing the diagnostic at the harbours rather than the
//     seed — reachable only above a ~12.2 m draft on this mask, since the
//     seed cell itself reads 13.1 m, so noted rather than pressed).
// The gate DERIVATION twin (draft -> gate) already exists in
// verifyMaskBoatGate.test.ts (Task 13); this file does not repeat it
// either. The water/land depth probes and the harbor-snap >= 2.2 m sanity
// check also stay Python-only — those two ARE general mask-sanity
// assertions unrelated to a boat's gate, and porting them would widen this
// PR well past a mechanical CI-gating fix.
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
// ACROSS THE WHOLE FILE (module-scoped cache, PR #568 review MINOR 5 — not
// merely per boat, which would still repeat a fill every time two boats or
// a differential-test row share a gate), matching pipeline/verify_mask.py's
// own `ndimage.label`-per-gate shape — measured ~200-300 ms per DISTINCT
// gate, comfortably under the default timeout with headroom for catalogue
// growth. Because this is a second implementation of the same connectivity
// predicate, the differential-testing rule below applies: it is proven
// equivalent to `NavMask.cellsConnected`, not trusted by reading — see the
// differential describe block for what that sample actually covers.

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
  // MINOR 3 (PR #568 review): the block-level match above fails LOUD on its
  // own (a collection error), but a block that matched with zero ENTRIES
  // extracted (a dropped trailing comma, a re-quoted id) previously failed
  // SILENTLY — an empty map that quietly stopped enforcing every exception.
  expect(
    out.size,
    'CONNECTIVITY_EXCEPTIONS_M matched but zero entries were extracted — the entry regex stopped ' +
      'matching (dropped comma, re-quoted id?) — update it alongside the pipeline change',
  ).toBeGreaterThan(0);
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
  // MINOR 3 (PR #568 review): same silent-empty hole as the exceptions map
  // above — e.g. single-quoted keys parse fine in Python but this regex
  // (which only matches double quotes, mirroring the source's own style)
  // would then extract zero ids and silently disarm every allowlist entry.
  expect(
    out.size,
    'KNOWN_DISCONNECTED matched but zero entries were extracted — the entry regex stopped matching ' +
      '(single-quoted keys?) — update it alongside the pipeline change',
  ).toBeGreaterThan(0);
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
 * Mirrors pipeline/verify_mask.py's per-gate `ndimage.label` sweep. 4- vs
 * 8-connectivity is a deliberate safety choice, not an implementation
 * detail — see the differential describe block below (PR #568 review
 * MAJOR 1) for why a diagonal-only neighbourhood is never acceptable here. */
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
  // MINOR 4 (PR #568 review): an emptied harbors.json would otherwise make
  // BOTH the required loop below and the guard-fires proof pass vacuously
  // (CLAUDE.md: "Validate `length > 0` explicitly wherever a list means 'at
  // least one'"). This is the file's own version of that rule, checked once
  // for every test in this describe.
  expect(
    harbors.length,
    'harbors.json parsed to zero harbours — this check would pass vacuously',
  ).toBeGreaterThan(0);

  const SEED = readSeed();
  const EXCEPTIONS = readConnectivityExceptions();
  const KNOWN_DISCONNECTED = readKnownDisconnected();

  // MINOR 5 (PR #568 review): module-describe-scoped, so it is shared by
  // EVERY test below — the required `it.each(BOATS)` loop, the guard-fires
  // proof, and the differential proof's own gate-3.0 rows — not just within
  // one boat's `connectivityFailures` call. This is what makes the
  // PERFORMANCE comment above's "one flood fill per distinct gate" literal
  // rather than "per distinct gate per boat".
  const reachableCache = new Map<number, Uint8Array>();
  function reachableAt(gateM: number): Uint8Array {
    const key = Math.round(gateM * 10);
    let r = reachableCache.get(key);
    if (!r) {
      r = reachableSetAtGate(SEED, gateM);
      reachableCache.set(key, r);
    }
    return r;
  }

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
    // MAJOR 1 (PR #568 review): the original six-harbour, single-3.0m-gate
    // sample could not discriminate 4- vs 8-connectivity — substituting an
    // 8-neighbourhood in `reachableSetAtGate` left this describe block
    // 8/8 GREEN, because none of the six harbours diverge at 3.0 m. 4- vs
    // 8-connectivity is a deliberate safety choice (verify_mask.py's own
    // comment: a diagonal-only "connection" through a pinched corner is not
    // something a 4.2 m-beam boat can reliably thread), and measured over
    // every decimetre gate from 0.1 to 14.0 m, the two disagree on 41
    // (gate, harbour) pairs — always in the OVER-permissive direction (8conn
    // reachable where 4conn is not), i.e. a stranded harbour silently
    // passing the required check. Three rows below are picked at VERIFIED
    // first-divergence gates (re-measured against this checkout's mask, not
    // copied from the review comment unchecked — its own prose and its own
    // supplied code disagreed on troense's gate, 4.2 vs 4.4; 4.2 is the
    // measured first divergence and is used here) so an 8-conn substitution
    // reds this block again. RE-VERIFIED after #564/#565 grew the catalogue
    // to three boats across two gates (3.0 m, 2.8 m): the required
    // `it.each(BOATS)` loop below still does NOT catch the 8-conn mutation on
    // its own — 2.8 m (and the 2.0 m marstal exception gate it uses) is not a
    // divergence point on this mask either, so it stayed 3/3 green under the
    // same mutation that reds these three rows. These three rows remain the
    // ONLY thing standing between an 8-conn regression and a silent pass.
    const SAMPLE: ReadonlyArray<readonly [string, number]> = [
      ['flensburg', 3.0],
      ['aabenraa', 3.0],
      ['marstal', 3.0],
      ['augustenborg', 3.0],
      ['arnis', 3.0],
      ['dyvig', 3.0],
      // These three are where 4- and 8-connectivity first diverge on this
      // mask (measured over every decimetre gate 0.1-14.0 m). Without them
      // the equivalence proof is blind to the connectivity structure it
      // exists to check.
      ['rudkoebing', 3.5],
      ['troense', 4.2],
      ['flensburg', 8.8],
    ];

    it.each(SAMPLE)('%s at a %s m gate', (hid, gateM) => {
      const h = harbors.find((x) => x.id === hid);
      expect(h, `fixture harbor "${hid}" missing from harbors.json — update SAMPLE`).toBeDefined();
      const reachable = reachableAt(gateM);
      const fast = connectedAtGate(reachable, h!.snap);
      const slow = mask.cellsConnected(SEED, h!.snap, uniformGate(gateM));
      expect(fast).toBe(slow);
    });
  });

  it.each(BOATS)('$id: every harbor reaches open water at its derived gate', (boat) => {
    expect(connectivityFailures(boat)).toEqual([]);
  });

  // "Prove the guard can fail" (CLAUDE.md): a fixture boat drafted deep
  // enough to strand most of the fleet — never added to BOATS — is reported
  // as disconnected. This is what a real catalogue regression (a new boat
  // whose draft strands a harbor) would look like in this check.
  //
  // MINOR 2 (PR #568 review): the ORIGINAL version of this test used a 50 m
  // draft, deriving a 50.9 m gate — deeper than the open-water SEED cell
  // itself (13.1 m), so `reachableSetAtGate` returned at its seed-navigability
  // check (the very first line of the BFS) without ever expanding a
  // neighbour. Measured: it completed in 1 ms and stayed GREEN when the
  // BFS's own depth test was deleted — it exercised the reporting path,
  // never the traversal. 7.1 m instead derives an 8.0 m gate: deep enough to
  // strand most of the fleet, but shallow enough that the seed stays
  // navigable, so the flood fill genuinely runs (measured ~23 stranded
  // harbours, ~77 ms). `toBeGreaterThan(20)`, not an exact 23, deliberately
  // leaves headroom for a future harbor-list change and does not attempt to
  // catch the 4-/8-connectivity distinction — that is the differential
  // proof's job above, not this one's.
  it('guard-fires proof: a deep-draft fixture boat is reported as disconnected (exercises the real flood fill)', () => {
    const fixtureBoat: BoatDef = {
      id: 'fixture-deep-draft-550',
      name: 'fixture (test-only, never added to BOATS)',
      draftM: 7.1,
      // #563 made `draftProvenance` REQUIRED on BoatDef, so this fixture must
      // carry one. Requiredness is one half of that fix — it makes a boat
      // shipping without the FIELD a compile error; the other half moved the
      // §N.2 disclosure onto that same field, so the paragraph can no longer
      // read something nothing writes. This fixture exercised the first half:
      // the field landed on `develop` while this PR was open and the merged
      // result failed `typecheck` here, in a PR that touches no catalogue code.
      draftProvenance: {
        keel: 'n/a — synthetic fixture, not a real hull',
        hullVerified: false,
        note: 'Test-only fixture for the guard-fires proof below. Never added to BOATS.',
      },
      motorSpeedKn: 6,
      maneuverPenaltyS: 30,
      sails: [],
    };
    const failures = connectivityFailures(fixtureBoat);
    expect(failures.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// #1256: NavMask.cellsConnected reuses module-level BFS scratch
// ---------------------------------------------------------------------------
//
// WHY HERE. This file already loads the real committed mask.bin /
// mask.meta.json / harbors.json, and the differential below needs that real
// mask. A new `node:fs` test file would additionally need matching entries in
// tsconfig.app.json's `exclude` and tsconfig.test.json's `include` (see both
// files' comments), outside #1256's change scope.
//
// WHAT IS PROVEN. #1256 replaced `cellsConnected`'s two per-call mask-sized
// allocations with module-level scratch stamped by a generation counter, and
// its per-dequeued-cell `[[row-1,col],…]` array literals with a fixed offset
// table. Both are meant to leave behaviour byte-identical, so the RETURN
// VALUE alone cannot see a traversal-ORDER regression — the guard therefore
// hashes the PROBE SEQUENCE (every `cellNavigable(row,col)` call, in order),
// which determines the visit order and the visited set.
//
// COUPLING: the recorder patches `NavMask.prototype.cellNavigable`, so
// `cellsConnected` must keep calling it as a method. Inlining the depth read
// there would silently record nothing — mask.ts carries the same note at its
// call site.

/** Runtime view of the TS-private members the pre-#1256 oracle below needs. */
type MaskInternals = {
  readonly meta: MaskMeta;
  cellOf(p: LatLon): { row: number; col: number } | null;
  cellNavigable(row: number, col: number, gate: DepthGate): boolean;
};

/**
 * The 4-neighbourhood in the order the shipped BFS visits it. The pre-#1256
 * source spelled this as an inline `[[row-1,col],[row+1,col],[row,col-1],
 * [row,col+1]]` literal; hoisting it to an offset table is the ONLY edit to
 * the verbatim body below, and is what lets the positive control re-use the
 * same oracle with two entries swapped.
 */
const PRE_1256_NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/** Positive control: the same oracle with the first two neighbours swapped. */
const PERTURBED_NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, -1],
  [0, 1],
];

/**
 * `NavMask.cellsConnected` as it stood at `99a983a` (this change's
 * merge-base), copied verbatim except that `this` became `self` and the
 * neighbour literal became `neighbours`. The oracle for the differential.
 */
function cellsConnectedPre1256(
  m: NavMask,
  a: LatLon,
  b: LatLon,
  gate: DepthGate,
  neighbours: ReadonlyArray<readonly [number, number]> = PRE_1256_NEIGHBOURS,
): boolean {
  const self = m as unknown as MaskInternals;
  const ca = self.cellOf(a);
  const cb = self.cellOf(b);
  if (!ca || !cb) return false;
  if (!self.cellNavigable(ca.row, ca.col, gate) || !self.cellNavigable(cb.row, cb.col, gate))
    return false;
  const { rows, cols } = self.meta;
  const target = cb.row * cols + cb.col;
  const startIdx = ca.row * cols + ca.col;
  if (startIdx === target) return true;
  const visited = new Uint8Array(rows * cols);
  const queue = new Int32Array(rows * cols);
  let head = 0;
  let tail = 0;
  visited[startIdx] = 1;
  queue[tail++] = startIdx;
  while (head < tail) {
    const idx = queue[head++];
    const row = (idx / cols) | 0;
    const col = idx - row * cols;
    for (const [dr, dc] of neighbours) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nIdx = nr * cols + nc;
      if (visited[nIdx]) continue;
      if (!self.cellNavigable(nr, nc, gate)) continue;
      if (nIdx === target) return true;
      visited[nIdx] = 1;
      queue[tail++] = nIdx;
    }
  }
  return false;
}

interface ProbeDump {
  readonly result: boolean;
  readonly digest: string;
  readonly probes: number;
}

/**
 * Run `bfs` with every `cellNavigable(row,col)` call streamed into a sha256.
 * A full-mask BFS makes millions of calls, so the rows/cols are buffered into
 * a fixed Int32Array and flushed rather than retained (a `vi.spyOn` would keep
 * every call's arguments alive).
 */
function recordProbes(bfs: () => boolean): ProbeDump {
  const proto = NavMask.prototype as unknown as MaskInternals;
  const original = proto.cellNavigable;
  const hash = createHash('sha256');
  const buf = new Int32Array(1 << 16);
  let n = 0;
  let probes = 0;
  const flush = () => {
    if (n === 0) return;
    hash.update(Buffer.from(buf.buffer, 0, n * 4));
    n = 0;
  };
  proto.cellNavigable = function (this: MaskInternals, row: number, col: number, gate: DepthGate) {
    buf[n++] = row;
    buf[n++] = col;
    probes++;
    if (n === buf.length) flush();
    return original.call(this, row, col, gate);
  };
  try {
    const result = bfs();
    flush();
    return { result, digest: hash.digest('hex'), probes };
  } finally {
    proto.cellNavigable = original;
  }
}

describe('#1256: cellsConnected scratch reuse is byte-identical to the pre-#1256 BFS', () => {
  const SEED = readSeed();
  const snapOf = (id: string): LatLon => {
    const h = harbors.find((x) => x.id === id);
    expect(h, `fixture harbor "${id}" missing from harbors.json`).toBeDefined();
    return h!.snap;
  };

  // Mixed by outcome and by gate shape. `dyvig` and `graasten` are
  // KNOWN_DISCONNECTED pockets (pipeline/verify_mask.py), so using them as the
  // ORIGIN exhausts a small component and yields a cheap `false`; `SEED` as
  // origin yields `true` against reachable harbours. The last row is the #452
  // per-cell gate FIELD, whose `gateAtCell` path the uniform rows never take.
  const CASES: ReadonlyArray<{ label: string; from: LatLon; to: LatLon; gate: DepthGate }> = [
    { label: 'seed->flensburg @3.0', from: SEED, to: snapOf('flensburg'), gate: uniformGate(3.0) },
    { label: 'seed->marstal @2.3', from: SEED, to: snapOf('marstal'), gate: uniformGate(2.3) },
    { label: 'seed->troense @4.2', from: SEED, to: snapOf('troense'), gate: uniformGate(4.2) },
    { label: 'dyvig->seed @3.0', from: snapOf('dyvig'), to: SEED, gate: uniformGate(3.0) },
    { label: 'graasten->seed @3.0', from: snapOf('graasten'), to: SEED, gate: uniformGate(3.0) },
    {
      label: 'graasten->flensburg @approachGate(3.0, relaxed 2.3)',
      from: snapOf('graasten'),
      to: snapOf('flensburg'),
      gate: approachGate(
        maskMeta,
        [snapOf('graasten'), snapOf('flensburg')],
        3.0,
        [2.3, 2.3],
        APPROACH_RADIUS_M,
      ),
    },
  ];

  it(
    'result, probe count and probe-sequence sha256 all match the oracle on the real mask',
    { timeout: solverTimeoutMs(300_000) },
    () => {
      const lines: string[] = [];
      const outcomes = new Set<boolean>();
      const probeCounts: number[] = [];
      for (const c of CASES) {
        const shipped = recordProbes(() => mask.cellsConnected(c.from, c.to, c.gate));
        const oracle = recordProbes(() => cellsConnectedPre1256(mask, c.from, c.to, c.gate));
        // Non-vacuity: a harness that recorded nothing would emit two
        // identical empty dumps and read as proof.
        expect(shipped.probes, `${c.label}: recorded no probes`).toBeGreaterThan(0);
        expect(shipped.result, `${c.label}: result`).toBe(oracle.result);
        expect(shipped.probes, `${c.label}: probe count`).toBe(oracle.probes);
        expect(shipped.digest, `${c.label}: probe-sequence sha256`).toBe(oracle.digest);
        outcomes.add(shipped.result);
        probeCounts.push(shipped.probes);
        lines.push(`${c.label}|${shipped.result}|${shipped.probes}|${shipped.digest}`);
      }
      // Both outcomes must occur, and at least one row must actually walk the
      // grid — otherwise every row could agree on the pre-BFS early-exit path
      // alone, where the two implementations share the same code.
      expect([...outcomes].sort()).toEqual([false, true]);
      expect(Math.max(...probeCounts)).toBeGreaterThan(1000);
      const combined = createHash('sha256').update(lines.join('\n')).digest('hex');
      console.log(`#1256 differential dump sha256=${combined}\n${lines.join('\n')}`);
    },
  );

  it(
    'positive control: swapping two neighbour offsets moves the dump while the result does not',
    { timeout: solverTimeoutMs(300_000) },
    () => {
      const c = CASES[0]; // seed->flensburg @3.0 — deliberately a case that walks the grid
      const oracle = recordProbes(() => cellsConnectedPre1256(mask, c.from, c.to, c.gate));
      const perturbed = recordProbes(() =>
        cellsConnectedPre1256(mask, c.from, c.to, c.gate, PERTURBED_NEIGHBOURS),
      );
      // A control on a case that exits before the BFS could not move the dump
      // at all, and its equal digests would read as a broken recorder.
      expect(oracle.probes).toBeGreaterThan(1000);
      expect(perturbed.result).toBe(oracle.result);
      expect(perturbed.digest).not.toBe(oracle.digest);
    },
  );
});

describe('#1256: the shared BFS scratch leaks no state between calls', () => {
  // Two masks whose grids differ in BOTH dimensions and in cell count, so the
  // scratch must serve a smaller grid after it has grown for a larger one.
  const SMALL_META: MaskMeta = {
    west: 9.4,
    south: 54.3,
    east: 9.8,
    north: 54.5,
    cols: 40,
    rows: 20,
  };
  const cellCentre = (m: MaskMeta, row: number, col: number): LatLon => ({
    lat: m.south + ((row + 0.5) * (m.north - m.south)) / m.rows,
    lon: m.west + ((col + 0.5) * (m.east - m.west)) / m.cols,
  });

  // Big grid: one open row 10, everything else land — A and B connect along it.
  const big = makeMask((r) => (r === 10 ? 200 : 0));
  const bigA = cellCentre(TEST_MASK_META, 10, 5);
  const bigB = cellCentre(TEST_MASK_META, 10, 300);
  // Small grid: two navigable cells with a land cell between them — never
  // connected, so an interleaved `true` here would be leaked state.
  const small = makeMask((r, c) => (r === 5 && (c === 4 || c === 6) ? 200 : 0), SMALL_META);
  const smallA = cellCentre(SMALL_META, 5, 4);
  const smallB = cellCentre(SMALL_META, 5, 6);
  const gate = uniformGate(3);

  it('interleaved calls on two differently-sized masks each answer as they do alone', () => {
    expect(big.cellsConnected(bigA, bigB, gate)).toBe(true);
    expect(small.cellsConnected(smallA, smallB, gate)).toBe(false);
    for (let i = 0; i < 5; i++) {
      expect(small.cellsConnected(smallA, smallB, gate)).toBe(false);
      expect(big.cellsConnected(bigA, bigB, gate)).toBe(true);
      expect(small.cellsConnected(smallB, smallA, gate)).toBe(false);
      expect(big.cellsConnected(bigB, bigA, gate)).toBe(true);
    }
  });

  it('the generation stamp survives its own wraparound (a one-byte counter)', () => {
    // The stamp is one byte, so the counter's period is 255 and the scratch is
    // zeroed once per period. EXACTLY 254 intervening BFS calls therefore
    // bring the third assertion back to the SAME stamp value the first used —
    // the one alignment at which STALE MARKS are indistinguishable from fresh
    // ones. That is all this test covers: it says nothing about the stamp's
    // DOMAIN, and a too-late wrap threshold passes straight through it (the
    // open-water test below covers that half). Drop the zeroing and the last
    // call reads its own first call's marks and answers false.
    // The filler must not restamp the corridor, and
    // cannot: `small`'s only marked index is 5*40+4 = 204, while `big`'s
    // corridor is row 10 of a 320-column grid, indices 3200-3519.
    expect(big.cellsConnected(bigA, bigB, gate)).toBe(true);
    for (let i = 0; i < 254; i++) {
      expect(small.cellsConnected(smallA, smallB, gate), `filler ${i}`).toBe(false);
    }
    expect(big.cellsConnected(bigA, bigB, gate)).toBe(true);
  });

  it('every stamp value in one full period keeps a 2-D open-water pair connected', () => {
    // #1256: the stamp is one byte, so a too-LATE wrap threshold (`> 255`, or
    // `>= 256`) hands back 256, which truncates to 0 in the Uint8Array and
    // disables visited-tracking for that one call in every 256. 260 CONSECUTIVE
    // calls cover a full period from any starting generation, so this cannot be
    // defeated by test ordering the way an alignment-exact shape can. Open water
    // (2-D) is load-bearing: a thin corridor still reaches its target under the
    // mutant and stays green.
    const open = makeMask(() => 200);
    const A = cellCentre(TEST_MASK_META, 0, 0);
    const B = cellCentre(TEST_MASK_META, 199, 319);
    for (let i = 0; i < 260; i++) {
      expect(open.cellsConnected(A, B, gate), `call ${i}`).toBe(true);
    }
  });
});
