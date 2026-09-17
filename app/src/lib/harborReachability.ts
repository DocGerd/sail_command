import type { Harbor, LatLon } from '../types';
import type { BoatDef } from '../data/boats';
import { NavMask } from './mask';
import { approachGate, APPROACH_RADIUS_M } from './depthGate';
import { relaxationFloorM, minSafetyDepthM } from './boatDepth';

// #834: promoted out of HarborPicker.tsx, which is where #652 first added
// this field. That file's own comment explained why it lived there as a
// local intersection rather than widening the shared `Harbor` type in
// types.ts ("this picker is currently the ONLY consumer of that fact...
// Promote it onto `Harbor` itself if a second consumer ever needs it") — and
// #834 IS that second consumer (PlannerPanel's selected-endpoint row, which
// used to lose the #652 disclosure the instant a known-disconnected harbor
// was picked, #652's whole point). Promoting all the way onto `Harbor` in
// `types.ts` was deliberately declined: `app/sweep/sweepArms.ts` imports
// `defaultBoatSnapshot`/`DEFAULT_SETTINGS` (values) and `LatLon`/`MaskMeta`/
// `PolarTable`/`SailId`/`Settings`/`WindGrid` (types) from `types.ts`, which
// puts that whole FILE in the `app/sweep/` #282 acceptance-harness closure —
// the closure tool marks any hit OWED at file granularity, so widening
// `types.ts` at all would owe a ~31 min/arm-set sweep for a field that is
// presentation-only and never reaches `PlanResult`. This module sits outside
// that closure — nothing under `routing/**`, `lib/mask.ts` or `sweep/**`
// imports it — so a second consumer costs nothing there.
export type HarborWithReachability = Harbor & { knownDisconnected?: boolean };

// ---------------------------------------------------------------------------
// #1290: per-boat harbour access, derived at RUNTIME from the loaded mask.
//
// Design: docs/spikes/1135-boat-picker-gate-design.md §2 (states), §3
// (measured composition), §9 (cost/caching), §10 (sweep-closure verdict).
// This module is intentionally SOLVER-FREE — reachability is snap + gate
// BFS only, never `solve()`/`planRoute()` — and stays OUTSIDE the #282 sweep
// closure by importing `lib/mask.ts`/`lib/depthGate.ts`/`lib/boatDepth.ts`
// rather than editing them (§10's own table: this file is NOT_IN_CLOSURE,
// those three ARE, by the import walk).
//
// FROZEN API for #1291 (picker markers) and #1292 (Boat-tab disclosure) to
// build on: `HarborAccessState`, `computeHarborAccess`,
// `LowerSettingHintOutcome`, `findLowerSettingHint`. Widened once (PR #1316
// fix wave 1, Major 5) before either consumer landed — see
// `findLowerSettingHint`'s own comment for why.
// ---------------------------------------------------------------------------

/**
 * §2's four states, in ascending severity. `known-disconnected` wins over
 * every other state — it is a per-HARBOUR fact (the #9 channel/grid
 * connectivity gap `pipeline/verify_mask.py`'s own `KNOWN_DISCONNECTED`
 * allowlist already ships in `Harbor.knownDisconnected`), independent of
 * boat draft or safety-depth setting; no gate ever changes it.
 */
export type HarborAccessState = 'ok' | 'shallow-approach' | 'unreachable' | 'known-disconnected';

/** One (boat, safety-depth) classification, keyed by harbour id. `null` (never
 * an empty Map) is how a caller must represent "not yet computed" — an empty
 * Map reads as "every harbour known-good", exactly the segmentShallowestBelow
 * null-vs-zero hazard CLAUDE.md documents for this codebase's other depth
 * derivations. */
export type HarborAccessByHarbor = ReadonlyMap<string, HarborAccessState>;

/**
 * The payload of a `findLowerSettingHint` `'found'` outcome (§5.1/§13 item 1
 * Q5): the highest depth setting below the one a harbour was checked at
 * where it would read `ok` or `shallow-approach` for this boat.
 */
export interface LowerSettingHint {
  readonly depthM: number;
  readonly state: 'ok' | 'shallow-approach';
}

/**
 * PR #1316 fix-wave 1 Major 5: `findLowerSettingHint`'s result, WIDENED from
 * a bare `LowerSettingHint | null` before any consumer (#1291/#1292) shipped
 * against the narrower shape. A caller needs to tell three things apart —
 * found a setting; searched the WHOLE range and there is none; hit its own
 * step budget before finishing — because only the third one licenses design
 * §5.1's "Harbour access not yet checked." pending string and §9's
 * idle-slicing recommendation. `'not-found'` alone would have been read as
 * "definitely none exists" even when the search never got that far.
 */
export type LowerSettingHintOutcome =
  | { readonly kind: 'found'; readonly hint: LowerSettingHint }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'exhausted'; readonly resumeFromDepthM: number };

/**
 * Flensburg Fjord open-water reference point. Mirrors
 * `pipeline/verify_mask.py`'s `SEED_LAT, SEED_LON` — production code cannot
 * read the Python source, so this is a second, independently-declared copy;
 * `app/src/test/harborReachability.test.ts` pins it against that source via
 * the same regex idiom `verifyMaskConnectivity.test.ts`'s own `readSeed()`
 * uses (mirrors `maskTolerance.test.ts`'s TOLERANCE_M ↔ MASK_TOLERANCE_M twin
 * — no compiler spans Python and TypeScript).
 */
export const SEED_POINT: LatLon = { lat: 54.8455, lon: 9.5216 };

/**
 * One flood-fill result: which cells of the mask are 4-connected to
 * {@link SEED_POINT} at a single UNIFORM gate. Bit-packed (1 bit/cell, ~1.18
 * MB for the committed 3025x3120 mask) rather than one byte per cell, so the
 * per-gate cache (§9: "cache uniform fills by gate decimetre") can hold
 * several gates without costing tens of MB.
 *
 * `rows`/`cols` are carried alongside the bits (PR #1316 fix-wave 1 Major 4)
 * so `harborStateAt` can refuse to trust a `FloodResult` computed for a
 * DIFFERENT mask before ever reading a bit from it — belt-and-suspenders
 * beside the per-`NavMask` cache keying below, which is what actually
 * prevents that mismatch from arising in the first place.
 *
 * DUPLICATED TRAVERSAL, deliberately: `NavMask.cellsConnected` already runs
 * this exact BFS shape per PAIR of points, but adding a seed-COMPONENT method
 * to `NavMask` would be OWED at file granularity (§10) for a feature that
 * never touches `PlanResult`. Per §10's own recommendation this traversal
 * lives here instead, over `NavMask`'s PUBLIC surface only (`meta`,
 * `isNavigable`) — and per this repo's differential-testing rule for a
 * duplicated algorithm, `app/src/test/harborReachability.test.ts` proves it
 * equivalent to `NavMask.cellsConnected`, at the VERIFIED first-divergence
 * (gate, harbour) points a 4- vs 8-connectivity mutation needs to be caught
 * at all (PR #1316 fix-wave 1 Major 1) — not merely at gates neither
 * convention diverges on.
 */
interface FloodResult {
  readonly bits: Uint8Array;
  readonly rows: number;
  readonly cols: number;
}

/** Inlined (PR #1316 fix-wave 1 Minor): a `bitIndex()` helper allocating
 * `{byte, mask}` per call defeated the very allocation-avoidance this
 * traversal's neighbouring `probe` object exists for — same hot loop, same
 * order of magnitude (~16.8M calls over the committed mask's open-water
 * component). */
function setBit(bits: Uint8Array, idx: number): void {
  bits[idx >> 3] |= 1 << (idx & 7);
}

function hasBit(bits: Uint8Array, idx: number): boolean {
  return (bits[idx >> 3] & (1 << (idx & 7))) !== 0;
}

const BFS_DROW = [-1, 1, 0, 0] as const;
const BFS_DCOL = [0, 0, -1, 1] as const;

/**
 * One BFS from {@link SEED_POINT}, visiting every cell 4-connected to it at
 * `gateM` (uniform — the flood never applies a per-cell relaxation field;
 * that half of §2 is the separate `shallowApproachConnected` disc check
 * below). Reused, single-mutated-object `LatLon` argument to `isNavigable`
 * per neighbour test rather than a fresh object literal — over the
 * committed mask's ~4.2M-cell open-water component that is ~16.8M avoided
 * allocations (4 neighbour probes/cell). See PR #1316 for a measured cost
 * report (this module carries none itself — PR #1316 fix-wave 1 Minor: a
 * prior revision cited a "cost report" in the sibling test file that does
 * not exist there).
 */
function floodFromSeed(mask: NavMask, gateM: number): FloodResult {
  const { rows, cols, west, south, east, north } = mask.meta;
  const latStep = (north - south) / rows;
  const lonStep = (east - west) / cols;
  const bits = new Uint8Array(Math.ceil((rows * cols) / 8));
  const probe: LatLon = { lat: 0, lon: 0 };
  const centerOf = (row: number, col: number): LatLon => {
    probe.lat = south + (row + 0.5) * latStep;
    probe.lon = west + (col + 0.5) * lonStep;
    return probe;
  };

  const seedRow = Math.floor((SEED_POINT.lat - south) / latStep);
  const seedCol = Math.floor((SEED_POINT.lon - west) / lonStep);
  if (
    seedRow < 0 ||
    seedRow >= rows ||
    seedCol < 0 ||
    seedCol >= cols ||
    !mask.isNavigable(centerOf(seedRow, seedCol), gateM)
  ) {
    // Mirrors verifyMaskConnectivity.test.ts's own "a non-navigable seed
    // reports every harbour unreachable rather than throwing" choice —
    // never reachable on this mask (the seed reads 13.1 m of water), but a
    // synthetic test mask can legitimately exercise this branch.
    return { bits, rows, cols };
  }

  const queue = new Int32Array(rows * cols);
  let head = 0;
  let tail = 0;
  const startIdx = seedRow * cols + seedCol;
  setBit(bits, startIdx);
  queue[tail++] = startIdx;
  while (head < tail) {
    const idx = queue[head++];
    const row = (idx / cols) | 0;
    const col = idx - row * cols;
    for (let k = 0; k < 4; k++) {
      const nr = row + BFS_DROW[k];
      const nc = col + BFS_DCOL[k];
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nIdx = nr * cols + nc;
      if (hasBit(bits, nIdx)) continue;
      if (!mask.isNavigable(centerOf(nr, nc), gateM)) continue;
      setBit(bits, nIdx);
      queue[tail++] = nIdx;
    }
  }
  return { bits, rows, cols };
}

function cellIndexOf(mask: NavMask, p: LatLon): number | null {
  const { rows, cols, west, south, east, north } = mask.meta;
  const latStep = (north - south) / rows;
  const lonStep = (east - west) / cols;
  const row = Math.floor((p.lat - south) / latStep);
  const col = Math.floor((p.lon - west) / lonStep);
  if (row < 0 || row >= rows || col < 0 || col >= cols) return null;
  return row * cols + col;
}

/**
 * PR #1316 fix-wave 1 Major 4: fail CLOSED (never `'ok'`) if `flood` was
 * somehow computed for a DIFFERENT mask than `mask` — a cell index valid in
 * one grid can silently read a valid-but-WRONG bit in a differently-shaped
 * one instead of throwing or going out of bounds. The per-`NavMask` cache
 * keying below is what actually prevents this mismatch from arising; this
 * is the second, structural guard the review asked for on top of it.
 */
function floodHasCell(flood: FloodResult, mask: NavMask, idx: number): boolean {
  const expectedBits = Math.ceil((mask.meta.rows * mask.meta.cols) / 8);
  if (flood.rows !== mask.meta.rows || flood.cols !== mask.meta.cols) return false;
  if (flood.bits.length !== expectedBits) return false;
  return hasBit(flood.bits, idx);
}

/** Decimetre integer key — never a raw float (PR #1316 fix-wave 1 Minor): the
 * mask's depth encoding is itself decimetre-quantised, so `2.9` and a
 * `2.9000000000000004` reachable from a `step: 0.1` slider must share one
 * cache entry rather than each paying for their own flood. Same idiom as
 * `verifyMaskConnectivity.test.ts`'s `reachableCache`. */
function gateKeyOf(gateM: number): number {
  return Math.round(gateM * 10);
}

/**
 * PR #1316 fix-wave 1 Major 4: keyed on the `NavMask` INSTANCE, not merely on
 * the gate — a bare `Map<number, FloodResult>` shared across every caller
 * would silently hand a mask ITS OWN flood computed for a DIFFERENT mask
 * whenever two callers request the same gate on different masks (this app
 * constructs `NavMask` at four call sites plus test fixtures; nothing holds
 * callers to "one mask, ever"). A `WeakMap` also bounds this cache's own
 * lifetime to the mask's — no manual eviction needed for that axis.
 *
 * The inner `Map<gateDecimetre, FloodResult>` is separately capped
 * (`MAX_CACHED_FLOODS_PER_MASK`, PR #1316 fix-wave 1 Minor): each entry is
 * ~1.18 MB, and the Q5 hint search alone can visit a dozen distinct gates
 * for one mask in one page session.
 */
const floodCache = new WeakMap<NavMask, Map<number, FloodResult>>();

/** ~1.18 MB per entry on the committed mask; caps `floodCache`'s per-mask
 * growth from the Q5 hint search's decimetre sweep (bounded further still by
 * `findLowerSettingHint`'s own step budget, see there). Evicts the OLDEST
 * entry (Map preserves insertion order) — LRU would track recency more
 * precisely but is not worth the bookkeeping for a handful of entries. */
const MAX_CACHED_FLOODS_PER_MASK = 16;

function floodAtGate(mask: NavMask, gateM: number): FloodResult {
  let perMask = floodCache.get(mask);
  if (!perMask) {
    perMask = new Map();
    floodCache.set(mask, perMask);
  }
  const key = gateKeyOf(gateM);
  let result = perMask.get(key);
  if (!result) {
    result = floodFromSeed(mask, gateM);
    if (perMask.size >= MAX_CACHED_FLOODS_PER_MASK) {
      const oldestKey = perMask.keys().next().value;
      if (oldestKey !== undefined) perMask.delete(oldestKey);
    }
    perMask.set(key, result);
  }
  return result;
}

/**
 * §2's `shallow-approach` test: is `snapped` 4-connected to {@link SEED_POINT}
 * once a single relaxation disc of radius `APPROACH_RADIUS_M` around
 * `snapped` is granted `floorM` (`relaxationFloorM(boat)`), with the
 * REQUESTED gate `requestedDepthM` everywhere else? One `approachGate` field
 * over a single waypoint plus one `NavMask.cellsConnected` pairwise BFS —
 * deliberately NOT `findRelaxedGate` (`routing/relaxedDepth.ts`): that
 * function discs BOTH endpoints of a route leg, where here only the harbour
 * approach may relax (the open-water seed never needs it), and reusing it
 * would depend on its signature exactly when a routing-side PR may be
 * changing it. `findRelaxedGate` is a TEST-side ORACLE instead (called
 * with the real `APPROACH_RADIUS_M`, never the `Infinity` kill switch) —
 * see harborReachability.test.ts.
 */
function shallowApproachConnected(
  mask: NavMask,
  snapped: LatLon,
  requestedDepthM: number,
  floorM: number,
): boolean {
  const gate = approachGate(mask.meta, [snapped], requestedDepthM, [floorM], APPROACH_RADIUS_M);
  return mask.cellsConnected(SEED_POINT, snapped, gate);
}

/**
 * §2's full per-harbour state at one (boat, safety-depth) pair. `flood` is
 * passed in (rather than recomputed) so callers driving the Q5 decimetre
 * sweep — and `computeHarborAccess` below, over the whole catalogue for one
 * boat — pay for one flood per DISTINCT gate they visit, never one per
 * harbour.
 */
function harborStateAt(
  mask: NavMask,
  harbor: HarborWithReachability,
  boat: BoatDef,
  safetyDepthM: number,
  flood: FloodResult,
): HarborAccessState {
  if (harbor.knownDisconnected === true) return 'known-disconnected';

  const snapped = mask.snapToNavigable(harbor.snap, safetyDepthM);
  if (!snapped) return 'unreachable';

  const idx = cellIndexOf(mask, snapped);
  if (idx !== null && floodHasCell(flood, mask, idx)) return 'ok';

  return shallowApproachConnected(mask, snapped, safetyDepthM, relaxationFloorM(boat))
    ? 'shallow-approach'
    : 'unreachable';
}

/**
 * PR #1316 fix-wave 1 Major 4: keyed on the `NavMask` instance AND the
 * `harbors` array reference (both `WeakMap`s, so both axes bound this
 * cache's lifetime automatically), THEN on `${boat.id}@${gateDecimetre}`.
 * The `harbors` axis matters because a caller can legitimately pass a
 * FILTERED list — under the old string-only key, a filtered call and a
 * full-catalogue call at the same (boat, depth) collided, and whichever ran
 * first silently served its Map to the other (a partial Map read by a
 * caller expecting the full catalogue returns `undefined` for the missing
 * ids — a third value {@link HarborAccessByHarbor}'s own doc never defines).
 */
const resultCache = new WeakMap<
  NavMask,
  WeakMap<readonly HarborWithReachability[], Map<string, HarborAccessByHarbor>>
>();

function resultCacheFor(
  mask: NavMask,
  harbors: readonly HarborWithReachability[],
): Map<string, HarborAccessByHarbor> {
  let perMask = resultCache.get(mask);
  if (!perMask) {
    perMask = new WeakMap();
    resultCache.set(mask, perMask);
  }
  let perHarbors = perMask.get(harbors);
  if (!perHarbors) {
    perHarbors = new Map();
    perMask.set(harbors, perHarbors);
  }
  return perHarbors;
}

/**
 * §2/§12 Q2-Q3: every harbour's access state for one boat at one safety
 * depth. Memoised on `(mask, harbors, boat.id, safetyDepthM)` — a repeat call
 * with the same four returns the SAME Map instance, so a consumer may safely
 * use it as a `useMemo`/effect dependency without re-deriving.
 *
 * Cost: dominated by ONE `floodFromSeed` call — this function's own
 * per-harbour work beyond that is a snap (bounded 300 m ring search) plus,
 * for the few harbours that fail the flood test, one
 * `shallowApproachConnected` pairwise BFS. Measured per-boat costs and the
 * mutation evidence for the caching behaviour above are in PR #1316, not
 * repeated here (PR #1316 fix-wave 1 Minor: a prior revision cited a "cost
 * report" inside `harborReachability.test.ts` that does not exist there).
 * Call this EAGERLY for the selected boat (§12 Q3) and LAZILY (only once the
 * Boat tab actually renders a row) for every other catalogue boat — never
 * for all boats up front.
 */
export function computeHarborAccess(
  mask: NavMask,
  harbors: readonly HarborWithReachability[],
  boat: BoatDef,
  safetyDepthM: number,
): HarborAccessByHarbor {
  const cache = resultCacheFor(mask, harbors);
  const cacheKey = `${boat.id}@${gateKeyOf(safetyDepthM)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const flood = floodAtGate(mask, safetyDepthM);
  const out = new Map<string, HarborAccessState>();
  for (const harbor of harbors) {
    out.set(harbor.id, harborStateAt(mask, harbor, boat, safetyDepthM, flood));
  }
  cache.set(cacheKey, out);
  return out;
}

/**
 * Default per-call step (flood) budget for {@link findLowerSettingHint}. 12
 * steps costs roughly 2 s worst case on this repo's own measured ~150-200 ms
 * per uncached flood (PR #1316) — down from the UNBOUNDED search's measured
 * worst case of ~6.9 s / 42 floods for a harbour with no answer down to the
 * floor at a deep-drafted boat's own setting ceiling. Still a visible stall
 * per design §9's own caution (any synchronous multi-flood call is), which
 * is why the budget exists at all: a caller hitting it gets `'exhausted'`
 * with a `resumeFromDepthM` to continue from on a LATER idle slice, rather
 * than a call that blocks for however long the harbour's own worst case is.
 */
export const DEFAULT_HINT_MAX_STEPS = 12;

/**
 * §5.1/§13 item 1 Q5: for a harbour, the highest lower setting (searched
 * decimetre by decimetre, HIGH to LOW, down to `minSafetyDepthM(boat)` —
 * non-monotone in the gate per §7, since a lower gate can move the snap CELL
 * itself, so a binary search is unsound here) below `safetyDepthM` at which
 * it would read `ok` or `shallow-approach`.
 *
 * WIDENED (PR #1316 fix-wave 1 Major 5) from a bare `LowerSettingHint | null`
 * to {@link LowerSettingHintOutcome} before #1291/#1292 (the frozen API's
 * only planned consumers) ever called it: the unbounded form's measured
 * worst case — see `DEFAULT_HINT_MAX_STEPS`'s own comment — has no cap, no
 * cancellation and no distinguishable "still working" result, which blocks
 * design §9's idle-slicing and §5.1's pending-state requirement outright. A
 * caller reading `'exhausted'` should render the §5.1 pending string and
 * re-invoke later with `safetyDepthM: outcome.resumeFromDepthM` (continuing
 * the SAME downward scan, not restarting it) on a subsequent idle slice —
 * this function stays synchronous and step-bounded; it does not itself
 * schedule that continuation.
 *
 * DELIBERATELY LAZY, and never called from `computeHarborAccess` or any
 * eager path: each decimetre step costs up to one fresh `floodFromSeed` call
 * (cached afterwards via `floodAtGate`, so a repeated hint query — or a
 * second `unreachable` harbour at the same boat/depth — reuses every flood
 * already computed by an earlier step, INCLUDING one from a PRIOR exhausted
 * call to this same harbour, since the flood cache is keyed by mask+gate,
 * not by call). §9/§13 item 1's own recommendation is "compute it lazily
 * when the option renders"; this function is the thing to call FROM that
 * render, never before it.
 */
export function findLowerSettingHint(
  mask: NavMask,
  harbor: HarborWithReachability,
  boat: BoatDef,
  safetyDepthM: number,
  maxSteps: number = DEFAULT_HINT_MAX_STEPS,
): LowerSettingHintOutcome {
  if (harbor.knownDisconnected === true) return { kind: 'not-found' };
  const floorDm = Math.round(minSafetyDepthM(boat) * 10);
  const topDm = Math.round(safetyDepthM * 10) - 1;
  let steps = 0;
  for (let dm = topDm; dm >= floorDm; dm--) {
    if (steps >= maxSteps) return { kind: 'exhausted', resumeFromDepthM: (dm + 1) / 10 };
    steps++;
    const depthM = dm / 10;
    const flood = floodAtGate(mask, depthM);
    const state = harborStateAt(mask, harbor, boat, depthM, flood);
    if (state === 'ok' || state === 'shallow-approach')
      return { kind: 'found', hint: { depthM, state } };
  }
  return { kind: 'not-found' };
}
