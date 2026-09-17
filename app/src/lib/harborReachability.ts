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
// build on: `HarborAccessState`, `computeHarborAccess`, `findLowerSettingHint`.
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
 * §5.1/§13 item 1 Q5: for an `unreachable` harbour, the highest depth setting
 * BELOW the one it was checked at where it would read `ok` or
 * `shallow-approach` for this boat — or `null` if none exists down to the
 * boat's `minSafetyDepthM` floor. `null` also covers "not `unreachable`" and
 * "not searched" alike; callers only ever request a hint for a harbour they
 * already know is `unreachable`.
 */
export interface LowerSettingHint {
  readonly depthM: number;
  readonly state: 'ok' | 'shallow-approach';
}

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
 * several gates without costing tens of MB — the catalogue has only two
 * distinct default gates (2.8 m, 3.0 m) today, but a user-adjusted
 * `safetyDepthM` or the Q5 hint search's decimetre sweep can each add more.
 *
 * DUPLICATED TRAVERSAL, deliberately: `NavMask.cellsConnected` already runs
 * this exact BFS shape per PAIR of points, but adding a seed-COMPONENT method
 * to `NavMask` would be OWED at file granularity (§10) for a feature that
 * never touches `PlanResult`. Per §10's own recommendation this traversal
 * lives here instead, over `NavMask`'s PUBLIC surface only (`meta`,
 * `isNavigable`) — and per this repo's differential-testing rule for a
 * duplicated algorithm, `app/src/test/harborReachability.test.ts` proves it
 * equivalent to `NavMask.cellsConnected` rather than trusting it by reading.
 */
interface FloodResult {
  readonly bits: Uint8Array;
  readonly cols: number;
}

function bitIndex(idx: number): { byte: number; mask: number } {
  return { byte: idx >> 3, mask: 1 << (idx & 7) };
}

function setBit(bits: Uint8Array, idx: number): void {
  const { byte, mask } = bitIndex(idx);
  bits[byte] |= mask;
}

function hasBit(bits: Uint8Array, idx: number): boolean {
  const { byte, mask } = bitIndex(idx);
  return (bits[byte] & mask) !== 0;
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
 * allocations (4 neighbour probes/cell), measured to matter in
 * `harborReachability.test.ts`'s own cost report.
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
    return { bits, cols };
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
  return { bits, cols };
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

/** Process-lifetime cache of {@link floodFromSeed} results, keyed by the raw
 * gate depth in metres — shared across every boat, since the flood itself is
 * boat-independent (§9: "today's catalogue has two distinct default gates").
 * Never cleared: the mask is a build-time-committed, never-refetched asset
 * (`services/assets.ts`'s own comment), so a cached flood can never go stale
 * within one page lifetime. */
const floodCache = new Map<number, FloodResult>();

function floodAtGate(mask: NavMask, gateM: number): FloodResult {
  let result = floodCache.get(gateM);
  if (!result) {
    result = floodFromSeed(mask, gateM);
    floodCache.set(gateM, result);
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
 * changing it. `findRelaxedGate` is the TEST-side oracle instead — see
 * harborReachability.test.ts.
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
  if (idx !== null && hasBit(flood.bits, idx)) return 'ok';

  return shallowApproachConnected(mask, snapped, safetyDepthM, relaxationFloorM(boat))
    ? 'shallow-approach'
    : 'unreachable';
}

/** `${boatId}@${safetyDepthM}` — see the module comment for why the flood
 * half of the work is cached separately (by gate alone) while the WHOLE
 * per-harbour map is additionally cached here (by boat + depth), per the
 * issue's own "cache keyed on (boatId, safetyDepthM)" instruction. */
const resultCache = new Map<string, HarborAccessByHarbor>();

/**
 * §2/§12 Q2-Q3: every harbour's access state for one boat at one safety
 * depth. Memoised on `(boat.id, safetyDepthM)` — a repeat call with the same
 * pair (e.g. a re-render after an unrelated state change) returns the SAME
 * Map instance, so a consumer may safely use it as a `useMemo`/effect
 * dependency without re-deriving.
 *
 * Cost (measured, see harborReachability.test.ts's own report): dominated by
 * ONE `floodFromSeed` call — this function's own per-harbour work beyond that
 * is a snap (bounded 300 m ring search) plus, for the few harbours that fail
 * the flood test, one `shallowApproachConnected` pairwise BFS. Call this
 * EAGERLY for the selected boat (§12 Q3) and LAZILY (only once the Boat tab
 * actually renders a row) for every other catalogue boat — never for all
 * boats up front.
 */
export function computeHarborAccess(
  mask: NavMask,
  harbors: readonly HarborWithReachability[],
  boat: BoatDef,
  safetyDepthM: number,
): HarborAccessByHarbor {
  const cacheKey = `${boat.id}@${safetyDepthM}`;
  const cached = resultCache.get(cacheKey);
  if (cached) return cached;

  const flood = floodAtGate(mask, safetyDepthM);
  const out = new Map<string, HarborAccessState>();
  for (const harbor of harbors) {
    out.set(harbor.id, harborStateAt(mask, harbor, boat, safetyDepthM, flood));
  }
  resultCache.set(cacheKey, out);
  return out;
}

/**
 * §5.1/§13 item 1 Q5: for a harbour already known to be `unreachable` at
 * `safetyDepthM`, the highest lower setting (searched decimetre by
 * decimetre, HIGH to LOW, down to `minSafetyDepthM(boat)` — non-monotone in
 * the gate per §7, since a lower gate can move the snap CELL itself, so a
 * binary search is unsound here) at which it would read `ok` or
 * `shallow-approach`. `null` if no such setting exists.
 *
 * DELIBERATELY LAZY, and never called from `computeHarborAccess` or any
 * eager path: each decimetre step costs up to one fresh `floodFromSeed` call
 * (cached afterwards, so a repeated hint query — or a second `unreachable`
 * harbour at the same boat/depth — reuses every flood already computed by an
 * earlier step). §9/§13 item 1's own recommendation is "compute it lazily
 * when the option renders"; this function is the thing to call FROM that
 * render, never before it. Worst case (a hull far below its recommended
 * gate) is several fresh floods — see harborReachability.test.ts for a
 * measured per-flood cost and a worked worst-case total.
 */
export function findLowerSettingHint(
  mask: NavMask,
  harbor: HarborWithReachability,
  boat: BoatDef,
  safetyDepthM: number,
): LowerSettingHint | null {
  if (harbor.knownDisconnected === true) return null;
  const floorDm = Math.round(minSafetyDepthM(boat) * 10);
  const topDm = Math.round(safetyDepthM * 10) - 1;
  for (let dm = topDm; dm >= floorDm; dm--) {
    const depthM = dm / 10;
    const flood = floodAtGate(mask, depthM);
    const state = harborStateAt(mask, harbor, boat, depthM, flood);
    if (state === 'ok' || state === 'shallow-approach') return { depthM, state };
  }
  return null;
}
