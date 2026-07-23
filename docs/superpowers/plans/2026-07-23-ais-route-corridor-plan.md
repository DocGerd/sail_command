# AIS Route-Corridor Subscription Implementation Plan (#146)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking. Source of truth: the `# Route-corridor subscription — Addendum (#146, 2026-07-23)` section of `docs/superpowers/specs/2026-07-23-ais-traffic-overlay-design.md` — read it before starting.

**Goal:** Extend the #25 AIS overlay so the live subscription also covers a ±5 nm corridor along the active route — a ferry crossing the track two legs ahead renders without panning there — while a plan is active and AIS is otherwise on (key + Live tab + online + visible). No new setting, no rendering/aging/declutter change, no CPA/TCPA. Without a plan the behavior is byte-for-byte today's viewport-only subscription; without a key the feature stays fully inert (zero sockets).

**Architecture:** A new pure module `app/src/lib/routeCorridor.ts` turns the active rig's legs + `activeLegIndex` into a merged, capped set of `AisBoundingBox`es (nm-true padding via `destinationPoint`, union-merge, budget caps). The aisstream client surface migrates from single-box to list-shaped (`buildSubscription(apiKey, bboxes)`, `start(bboxes)`, `updateSubscription(bboxes)` replacing `updateBbox`) — every existing lifecycle semantic (onOpen resend, store-during-backoff, keyError inertness, keyProven/stability machinery) is preserved unchanged. `AisTraffic` composes `corridor ∪ padded-viewport` and hands the merged list plus the corridor-only list to `useAisTraffic`, which subscribes to the union and counts corridor targets (`routeCount`) inside its existing ≤1 Hz snapshot pass. The status chip splits the count via a new `ais.status.liveRoute` key while a plan is active.

**Tech Stack:** Vite + React + TypeScript (strict, `exactOptionalPropertyTypes`), MapLibre GL, Vitest (unit) with injected fake socket + fake timers. No new runtime dependency.

---

## OPEN QUESTIONS (addendum vs. real code — resolve before/at implementation, do not silently absorb)

1. **`ships` vs `vessels` wording inconsistency (en).** The addendum locks the new key's English text as `AIS live · {count} ships ({routeCount} along route)`, but the *existing* `ais.status.live` (en) reads `AIS live · {count} vessels` (`app/src/i18n/dict.en.ts:277`). German is consistent (both use `Schiffe`). Flagging per the brief: as written, the chip switches the noun from "vessels" to "ships" the moment a plan becomes active. **Recommendation:** use `vessels` in the new en key for consistency. **Default if unanswered:** follow the addendum's locked literal (`ships`) verbatim — it is an explicit owner decision — and note the wrinkle in the PR description. (This is a one-word copy choice, not a design change.)

2. **Chip split when a plan is active but the corridor is empty.** The addendum says the split (`ais.status.liveRoute`) renders "while a plan is active". Two states make the corridor empty even with a plan: (a) the active rig solved no route (`activeRigResult(plan, rig) === null`), (b) the area-cap fallback returned `[]`. To avoid a misleading `(0 along route)`, this plan defines `routeActive = plan !== null && rig !== null && activeRigResult(plan, rig) !== null` (a real route exists for the active rig). Case (b) — a routable plan whose corridor was area-capped to `[]` — still shows `(0 along route)`; that is honest (the corridor is disabled) and is left as-is. Confirm this reading is acceptable; the alternative (`routeActive = corridorBoxes.length > 0`) also suppresses (b) but couples the chip copy to a defensive cap.

3. **Subscription box count can reach 9.** `AIS_CORRIDOR_MAX_BOXES = 8` caps the *corridor* set (per the addendum, "after merging"). The subscription is `corridor(≤8) ∪ viewport(1)`, re-merged, so overlaps collapse but a fully-disjoint viewport yields up to 9 `BoundingBoxes`. aisstream accepts a multi-box array; not a contradiction, but noted so the cap is not mistakenly applied to the union. If a hard ceiling on the *subscription* is ever wanted it is a separate decision.

None of the above blocks implementation; (1) needs a one-word confirmation, (2)/(3) are documented readings.

**RESOLVED (orchestrator, 2026-07-23):** (1) `vessels` — the addendum has been corrected to match the existing `ais.status.live` noun; use `AIS live · {count} vessels ({routeCount} along route)`. (2) The `routeActive = plan !== null && rig !== null && activeRigResult(plan, rig) !== null` reading is confirmed; the area-capped `(0 along route)` state stays as planned (honest degradation). (3) Acknowledged: corridor cap ≤ 8 + disjoint viewport ⇒ up to 9 subscription boxes is by design; no subscription-level ceiling.

---

## Global Constraints (apply to EVERY task)

- **TypeScript `strict` + `exactOptionalPropertyTypes` are ON.** Never assign `undefined` to a `?`-optional property — omit the key. Type "value-or-absent" call-site values as `T | undefined` (required key, maybe-undefined value), not `field?: T`.
- **No enums, no constructor parameter properties** (`erasableSyntaxOnly`).
- **Explicit vitest imports in every test:** `import { describe, it, expect, vi } from 'vitest';`.
- **Mutation-check discipline (repo tautology law):** every pinned literal is derived BY HAND from geometry/spec, independently of the function under test. Never copy current output; never re-derive an expectation from the implementation. Each test step below states the literal AND its independent derivation.
- **i18n both dicts with `satisfies` parity.** Add the new key to `dict.de.ts` (which defines `MsgKey`) first, then `dict.en.ts` (which ends `} satisfies Record<MsgKey, string>`). A missing key fails typecheck.
- **≤1 Hz publish rule / no per-second AppState churn.** `routeCount` is recomputed only in the existing 1 Hz snapshot tick, never per AIS message; the corridor recomputes only on `[plan, rig, activeLegIndex]`, never per GPS fix.
- **BYOK-inert.** No key ⇒ `useAisTraffic` creates no client and opens no socket; the network-free e2e/offline suites stay untouched.
- **No new runtime dependency; no backend; no runtime fetch to any new origin.**
- **Referential stability.** The box lists handed from `AisTraffic` to `useAisTraffic` MUST be memoized (`useMemo`) so an unchanged corridor/viewport does not re-fire the subscription effect (acceptance: leg/plan/rig change resends on the open socket, never reconnects).

---

### Task 1: `lib/routeCorridor.ts` — pure corridor geometry, caps, and counting

The whole feature's math, React-free and map-free (the `lib/projectionVector.ts` precedent). Produces the corridor box set from legs + `activeLegIndex`, plus the point-in-corridor counter used for `routeCount`.

**Files**
- Create: `app/src/lib/routeCorridor.ts`
- Create: `app/src/lib/routeCorridor.test.ts`

**Interfaces (produced)**
```ts
export const AIS_CORRIDOR_HALF_WIDTH_NM = 5;
export const AIS_CORRIDOR_MAX_BOXES = 8;
export const AIS_CORRIDOR_MAX_AREA_NM2 = 2000;

// Accepts RigResult.legs (Leg[]) AND bare {start,end} test literals — the
// function only reads each segment's endpoints. `activeLegIndex` is AppState's
// number | null. Returns lat-first AisBoundingBoxes (corridor only; viewport is
// composed in AisTraffic). Empty legs or area-cap fallback → [].
export function routeCorridorBoxes(
  legs: readonly Pick<Leg, 'start' | 'end'>[],
  activeLegIndex: number | null,
  halfWidthNm: number,
): AisBoundingBox[];

export function pointInBox(p: LatLon, box: AisBoundingBox): boolean;
export function countTargetsInCorridor(
  targets: readonly { position: { lat: number; lon: number } }[],
  boxes: readonly AisBoundingBox[],
): number;

// Exported for unit tests (internal helpers otherwise):
export function boundingBoxAreaNm2(box: AisBoundingBox): number;
export function mergeOverlappingBoxes(boxes: readonly AisBoundingBox[]): AisBoundingBox[];
```
Imports: `type { LatLon, Leg } from '../types'`, `{ destinationPoint, toRad, EARTH_RADIUS_NM } from './geo'`, `type { AisBoundingBox } from '../services/aisStream'` (type-only; `lib/aisTargets.ts` already imports a type from `services/aisStream`, so this direction is established and adds no runtime coupling).

**Geometry spec (implement exactly so the reviewer can re-derive):**
- **Extent selection.** `startIdx = activeLegIndex === null ? 0 : Math.max(0, activeLegIndex - 1)`. Included = `legs.slice(startIdx)`. Empty ⇒ return `[]`.
- **Per-leg box + nm-true pad.** For each included leg, take `latMin/latMax/lonMin/lonMax` over `{start, end}`. Pad each corner outward with `destinationPoint` (nm-true, NOT the degree-fraction `padBoundingBox` which stays viewport-only):
  - `sLat = destinationPoint({lat: latMin, lon: lonMin}, 180, halfWidthNm).lat` (due south)
  - `nLat = destinationPoint({lat: latMax, lon: lonMax}, 0,   halfWidthNm).lat` (due north)
  - `sLon = destinationPoint({lat: latMin, lon: lonMin}, 270, halfWidthNm).lon` (due west, cos at the SW corner's latitude)
  - `nLon = destinationPoint({lat: latMax, lon: lonMax}, 90,  halfWidthNm).lon` (due east)
  - box = `[[sLat, sLon], [nLat, nLon]]`.
- **Union merge (`mergeOverlappingBoxes`).** Fixpoint: while any pair overlaps-or-touches, replace with their envelope. Overlap test (inclusive, so touching merges): `a.latMin <= b.latMax && b.latMin <= a.latMax && a.lonMin <= b.lonMax && b.lonMin <= a.lonMax`. Envelope = component-wise min/max. Adjacent legs share an endpoint, so their padded boxes always overlap and collapse into one continuous corridor box per contiguous run.
- **Box-count cap.** After union, while `boxes.length > AIS_CORRIDOR_MAX_BOXES`, merge the nearest pair (minimum great-circle distance between box centers) into their envelope. Merging over-covers, never drops coverage.
- **Area cap.** `boundingBoxAreaNm2(box)`: `heightNm = toRad(latMax-latMin) * EARTH_RADIUS_NM`, `widthNm = toRad(lonMax-lonMin) * EARTH_RADIUS_NM * cos(toRad((latMin+latMax)/2))`, area = `heightNm * widthNm`. If the summed area of the capped set `> AIS_CORRIDOR_MAX_AREA_NM2`, `console.warn(...)` once and return `[]` (viewport-only fallback).
- Order of operations: extent → per-leg boxes → union merge → box-count cap → area cap check.

**Derivation constants used below** (independent of the code under test):
- `EARTH_RADIUS_NM = 3440.065` (from `geo.ts`) ⇒ `1° = (π/180)·3440.065 = 60.0405 nm`.
- 5 nm N/S = `toDeg(5/3440.065) = (5/3440.065)·(180/π) = 0.083277°` (meridian arc; spherically exact for due N/S).
- 5 nm E/W at 54.5°N = `5 / (60.0405 · cos 54.5°) = 5 / (60.0405 · 0.580703) = 5/34.8657 = 0.143407°`.

Steps:

- [ ] Write failing test `app/src/lib/routeCorridor.test.ts`. Include a tiny segment factory to avoid full `Leg` boilerplate: `const seg = (start: LatLon, end: LatLon) => ({ start, end });`.

  **1a — single horizontal leg, `activeLegIndex = null` (full route):**
  ```ts
  const [box] = routeCorridorBoxes(
    [seg({ lat: 54.5, lon: 10.0 }, { lat: 54.5, lon: 10.2 })],
    null,
    5,
  );
  // lat pad = toDeg(5/3440.065) = 0.083277° (meridian arc, exact):
  expect(box[0][0]).toBeCloseTo(54.416723, 5); // 54.5 − 0.083277
  expect(box[1][0]).toBeCloseTo(54.583277, 5); // 54.5 + 0.083277
  // lon pad = 5/(60.0405·cos54.5°) = 0.143407° (nm-true E/W at 54.5°N):
  expect(box[0][1]).toBeCloseTo(9.8566, 3);    // 10.0 − 0.143407
  expect(box[1][1]).toBeCloseTo(10.3434, 3);   // 10.2 + 0.143407
  ```
  (lon at precision 3 — tolerance 5e-4 — absorbs the sub-1e-4 great-circle-vs-flat difference while still killing any mutant that drops the `cos`, uses a degree-fraction pad, or changes the half-width; lat at precision 5.)

  **1b — two collinear adjacent legs merge to one envelope:**
  ```ts
  const boxes = routeCorridorBoxes(
    [seg({ lat: 54.5, lon: 10.0 }, { lat: 54.5, lon: 10.2 }),
     seg({ lat: 54.5, lon: 10.2 }, { lat: 54.5, lon: 10.4 })],
    null, 5,
  );
  expect(boxes).toHaveLength(1);           // box1.lonMax(10.3434) > box2.lonMin(10.0566) ⇒ overlap ⇒ merge
  expect(boxes[0][0][1]).toBeCloseTo(9.8566, 3);   // 10.0 − 0.143407
  expect(boxes[0][1][1]).toBeCloseTo(10.5434, 3);  // 10.4 + 0.143407
  ```

  **1c — astern/remaining extent (`Math.max(0, i-1)`), disjoint legs so boxes stay separate.** Four point-spaced legs at lon 10.0–10.1, lats 54.4 / 54.6 / 54.8 / 55.0 (0.2° apart ≈ 12 nm > 2·0.083° pad ⇒ no merge). Use containment (exact booleans):
  ```ts
  const legs = [
    seg({lat:54.4,lon:10.0},{lat:54.4,lon:10.1}), // L0
    seg({lat:54.6,lon:10.0},{lat:54.6,lon:10.1}), // L1
    seg({lat:54.8,lon:10.0},{lat:54.8,lon:10.1}), // L2
    seg({lat:55.0,lon:10.0},{lat:55.0,lon:10.1}), // L3
  ];
  const inAny = (p, bs) => bs.some((b) => pointInBox(p, b));
  // activeLegIndex = 2 ⇒ startIdx = max(0,1) = 1 ⇒ legs L1..L3
  const c2 = routeCorridorBoxes(legs, 2, 5);
  expect(c2).toHaveLength(3);
  expect(inAny({lat:54.4,lon:10.05}, c2)).toBe(false); // L0 dropped (astern boundary)
  expect(inAny({lat:54.6,lon:10.05}, c2)).toBe(true);  // L1 kept
  // activeLegIndex = 0 ⇒ startIdx = 0 ⇒ all four
  expect(routeCorridorBoxes(legs, 0, 5)).toHaveLength(4);
  // activeLegIndex = null ⇒ full route ⇒ L0 covered
  expect(inAny({lat:54.4,lon:10.05}, routeCorridorBoxes(legs, null, 5))).toBe(true);
  ```

  **1d — box-count cap (10 disjoint boxes → 8, coverage preserved).** Ten zero-length "point legs" (`start === end`) at lon 10.0, lats 54.0, 54.2, … 55.8 (0.2° apart ⇒ no merge; each padded box ≈ 10 nm × 10 nm ≈ 100 nm², total ≈ 1000 nm² < 2000 ⇒ area cap NOT triggered, isolating the box cap):
  ```ts
  const legs = Array.from({length:10}, (_,k)=>{ const p={lat:54.0+0.2*k, lon:10.0}; return seg(p,p); });
  const boxes = routeCorridorBoxes(legs, null, 5);
  expect(boxes).toHaveLength(8); // 10 − 2 nearest-pair merges
  for (const l of legs) expect(boxes.some((b)=>pointInBox(l.start,b))).toBe(true); // coverage invariant
  ```

  **1e — area cap fallback (`[]` + one warn).** One giant leg spanning the region:
  ```ts
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const boxes = routeCorridorBoxes(
    [seg({lat:54.0,lon:9.5},{lat:55.3,lon:11.0})], null, 5,
  );
  // padded ≈ 1.47° lat (≈88 nm) × ≈1.79° lon (≈62 nm) ≈ 5450 nm² > 2000 ⇒ fallback
  expect(boxes).toEqual([]);
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
  ```

  **1f — `boundingBoxAreaNm2` pinned (formula, hand-derivable):**
  ```ts
  // 1°×1° box at 54.5°N: height = toRad(1)·3440.065 = 60.0405 nm;
  // width = 60.0405·cos54.5° = 60.0405·0.580703 = 34.8657 nm; area ≈ 2093.35 nm².
  expect(boundingBoxAreaNm2([[54,10],[55,11]])).toBeCloseTo(2093, 0);
  ```
  (Note: this 1°×1° box ≈ 2093 nm² > 2000 — the cap is ≈ half the ~4400 nm² data region, exactly the addendum's "≈ half the data region" intent.)

  **1g — `pointInBox` / `countTargetsInCorridor` (exact):**
  ```ts
  const box: AisBoundingBox = [[54,10],[55,11]];
  expect(pointInBox({lat:54.5,lon:10.5}, box)).toBe(true);
  expect(pointInBox({lat:56.0,lon:10.5}, box)).toBe(false);
  const targets = [
    {position:{lat:54.5,lon:10.5}}, // in
    {position:{lat:56.0,lon:10.5}}, // out
    {position:{lat:54.2,lon:10.9}}, // in
  ];
  expect(countTargetsInCorridor(targets, [box])).toBe(2);
  ```

- [ ] Run to fail: `npm --prefix app run test -- routeCorridor` (module not found).
- [ ] Implement `app/src/lib/routeCorridor.ts` per the geometry spec above.
- [ ] Run to pass: `npm --prefix app run test -- routeCorridor`.
- [ ] `npm --prefix app run typecheck && npm --prefix app run lint` — clean.
- [ ] Commit: `git add app/src/lib/routeCorridor.ts app/src/lib/routeCorridor.test.ts && git commit -m "feat: pure route-corridor geometry + caps + counting (#146)"`

---

### Task 2: aisstream client — list-shaped subscription surface

Migrate the client from a single box to a box list. Pure state-machine change; every lifecycle semantic is preserved (addendum: onOpen resend, resend-replaces-filter-without-reconnect, store-during-backoff, keyError terminal, keyProven/stability untouched).

**Files**
- Modify: `app/src/services/aisStream.ts`
- Modify (tests): `app/src/services/aisStream.test.ts`

**API changes**
- `buildSubscription(apiKey: string, bboxes: AisBoundingBox[]): AisSubscription` — `BoundingBoxes: bboxes` (pass-through; drop the single-element wrap).
- `AisStreamClient`: field `currentBbox: AisBoundingBox | null` → `currentBboxes: AisBoundingBox[] = []`. Method `updateBbox(bbox)` → `updateSubscription(bboxes: AisBoundingBox[])`. `start(bbox)` → `start(bboxes: AisBoundingBox[])`. `sendSubscription()` guard `!this.currentBbox` → `this.currentBboxes.length === 0`, and builds `buildSubscription(this.apiKey, this.currentBboxes)`. `start`'s already-running branch calls `this.updateSubscription(bboxes)`.

Steps:

- [ ] Update `aisStream.test.ts` FIRST (tests define the new surface):
  - **Multi-box builder (new):**
    ```ts
    const A: AisBoundingBox = [[54,10],[55,11]];
    const B: AisBoundingBox = [[54.4,9.8],[54.6,10.4]];
    expect(buildSubscription('KEY', [A, B])).toEqual({
      APIKey: 'KEY',
      BoundingBoxes: [A, B],
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    });
    ```
  - **Migrate existing single-box call sites:** every `client.start(BBOX)` → `client.start([BBOX])`; the resend test's `client.updateBbox(bbox2)` → `client.updateSubscription([bbox2])`; every `buildSubscription('KEY', BBOX)` / `buildSubscription('KEY', bbox2)` expectation → `buildSubscription('KEY', [BBOX])` / `([bbox2])`.
  - **Add — 2-box list resent verbatim on reconnect (onOpen resend semantic):** start with `[A, B]`; open the fake socket; assert the sent frame parses to `buildSubscription('KEY', [A, B])`. Drive a close→backoff-timer→reopen; assert the resend on the fresh socket is again `[A, B]` (stored list survives reconnect).
  - **Add — store-during-backoff:** while the client is between connects (socket closed, backoff timer pending), call `updateSubscription([A, B])`; assert NO send happened yet; fire the backoff timer to reopen; assert the next `onOpen` sends `[A, B]` (updates during backoff only store).
  - **Preserve — keyError inertness:** after the client reaches `keyError` (3 subscribed-silent early closes, or an error frame), `updateSubscription([A, B])` must send nothing and schedule no timer (assert `fs.sent` unchanged and no new timer). Reuse the existing keyError fixtures, just via the list API.
- [ ] Run to fail: `npm --prefix app run test -- aisStream` (type/shape errors).
- [ ] Apply the API changes in `aisStream.ts`. Do NOT touch `open()`'s auth/keyProven/stability logic, `nextReconnectDelayMs`, the `AIS_AUTH_*` constants, or the error-frame terminal path — only the box field, its type, and the three method signatures.
- [ ] Mechanically migrate the callers IN THIS TASK so every commit passes the repo's lint+typecheck gate (green-per-task discipline): in `useAisTraffic.ts`, update `AisClientLike` to the list signatures and wrap the existing single box at the call sites (`client.start([bbox])`, `clientRef.current.updateSubscription([bbox])`) — NO input-shape or behavior change (that is Task 3); update the fake client in `useAisTraffic.test.tsx` the same mechanical way.
- [ ] Run to pass: `npm --prefix app run test -- aisStream useAisTraffic`.
- [ ] `npm --prefix app run typecheck && npm --prefix app run lint` — CLEAN (no known-red commit).
- [ ] Commit: `git add app/src/services/aisStream.ts app/src/services/aisStream.test.ts app/src/state/useAisTraffic.ts app/src/state/useAisTraffic.test.tsx && git commit -m "feat: list-shaped AIS subscription API (updateSubscription, multi-box) (#146)"`

---

### Task 3: `useAisTraffic` — list input, corridor box list, and `routeCount`

The hook subscribes to the composed box list and counts corridor targets in its existing 1 Hz snapshot pass. Corridor boxes reach the tick through a ref (the `ownMmsiRef` precedent) so the interval never re-arms.

**Files**
- Modify: `app/src/state/useAisTraffic.ts`
- Modify (tests): `app/src/state/useAisTraffic.test.tsx`

**Changes**
- `UseAisTrafficInput`: replace `bbox: AisBoundingBox | null` with `bboxes: AisBoundingBox[] | null` (the subscribed union — `null` = gates closed / no viewport yet) and add `corridorBoxes: AisBoundingBox[]` (corridor-only, for `routeCount`; `[]` without a plan).
- `AisClientLike` already carries the list signatures since Task 2's mechanical migration (`start(bboxes)`, `updateSubscription(bboxes)`); this task removes the Task-2 `[bbox]` wrapping in favor of the real list input.
- `defaultCreateClient` unchanged (`AisStreamClient` matches `AisClientLike` since Task 2).
- Lifecycle effect guard: `bbox === null` → `bboxes === null || bboxes.length === 0`; `client.start([bbox])` → `client.start(bboxes)`; `clientRef.current.updateSubscription([bbox])` → `clientRef.current.updateSubscription(bboxes)`; effect dep `bbox` → `bboxes`.
- Add `corridorBoxesRef` synced in an effect (`useEffect(() => { corridorBoxesRef.current = corridorBoxes; }, [corridorBoxes])`), exactly like `ownMmsiRef`.
- 1 Hz snapshot tick: after `setTargets(snap)`, `setRouteCount(countTargetsInCorridor(snap, corridorBoxesRef.current))`. Add `const [routeCount, setRouteCount] = useState(0);`. The interval effect's deps stay `[now]` (corridor read through the ref).
- `clientActive`: `bbox !== null` → `bboxes !== null && bboxes.length > 0`.
- `UseAisTrafficResult` gains `routeCount: number`; return it.

Steps:

- [ ] Update `useAisTraffic.test.tsx` FIRST:
  - Fake client `updateBbox` → `updateSubscription`; its recorder pushes the box LIST.
  - `base` input: `bbox: BBOX` → `bboxes: [BBOX], corridorBoxes: []`.
  - **Add — `routeCount` counts only corridor targets (1 Hz, hand-pinned):** render with `corridorBoxes: [[[54,10],[55,11]]]`, capture the injected client's `onMessage`, feed two position messages — one at `(54.5, 10.5)` (inside the corridor box) and one at `(56.0, 10.5)` (outside) — advance fake timers 1000 ms, assert `result.current.targetCount === 2` and `result.current.routeCount === 1`. Derivation: `pointInBox` over `[[54,10],[55,11]]` admits `(54.5,10.5)`, rejects `(56.0,10.5)`; `targetCount` is all rendered targets, `routeCount` only corridor ones.
  - **Add — no plan ⇒ `routeCount === 0`:** `corridorBoxes: []`, same two messages, after a tick `routeCount === 0`, `targetCount === 2`.
  - All existing bbox-consuming tests (no-key off, connecting, 1 Hz snapshot, ownship filter, offline-stop-keeps-targets, sweeper, keyError, updateSubscription-on-existing-client, key-change recreate, unmount teardown): migrate their `bbox`→`bboxes`/`corridorBoxes` inputs; behavior assertions unchanged (BYOK-inert with no key still opens no client).
- [ ] Run to fail: `npm --prefix app run test -- useAisTraffic`.
- [ ] Apply the hook changes.
- [ ] Run to pass: `npm --prefix app run test -- useAisTraffic`.
- [ ] `npm --prefix app run typecheck && npm --prefix app run lint` — clean (Task 2's caller break now resolved).
- [ ] Commit: `git add app/src/state/useAisTraffic.ts app/src/state/useAisTraffic.test.tsx && git commit -m "feat: useAisTraffic list subscription + corridor routeCount (#146)"`

---

### Task 4: i18n `ais.status.liveRoute` + split status chip

Pure, unit-tested. The chip renders the split count only while a plan is active (see OPEN QUESTION 2 for `routeActive`).

**Files**
- Modify: `app/src/i18n/dict.de.ts`, `app/src/i18n/dict.en.ts`
- Modify: `app/src/components/AisTraffic.tsx` (the `AisStatusChip` export only)
- Modify (tests): `app/src/components/AisTraffic.test.tsx`

**Changes**
- `dict.de.ts` — after `'ais.status.keyError': ...` add:
  `'ais.status.liveRoute': 'AIS live · {count} Schiffe ({routeCount} entlang Route)',`
- `dict.en.ts` — after `'ais.status.keyError': ...` add (OQ1 RESOLVED: `vessels`, matching the existing `ais.status.live` noun):
  `'ais.status.liveRoute': 'AIS live · {count} vessels ({routeCount} along route)',`
- `AisStatusChip` props: add `routeActive: boolean; routeCount: number`. Text:
  ```ts
  const text =
    status === 'live'
      ? routeActive
        ? t('ais.status.liveRoute', { count: targetCount, routeCount })
        : t('ais.status.live', { count: targetCount })
      : t(STATUS_KEY[status]);
  ```

Steps:

- [ ] Update `AisTraffic.test.tsx` FIRST (extend `renderChip` with the two new props, defaulting `routeActive=false, routeCount=0`):
  - **Split shown with an active plan:** `renderChip('live', { targetCount: 7, routeActive: true, routeCount: 3 })` (en) → the status text is EXACTLY `AIS live · 7 vessels (3 along route)` (de: `AIS live · 7 Schiffe (3 entlang Route)`) — pin the FULL literal so the noun is test-enforced. Assert against the literal dict string, not a re-interpolation of the code under test.
  - **Plain count without a plan:** `renderChip('live', { targetCount: 7, routeActive: false })` → text is `AIS live · 7 vessels` (en) / `AIS live · 7 Schiffe` (de); assert it does NOT contain `along route` / `entlang Route`.
  - Existing five-state tests: pass the new props with defaults; unchanged.
- [ ] Run to fail: `npm --prefix app run test -- AisTraffic` (unknown key / missing props).
- [ ] Add the dict keys (de first, then en) and the `AisStatusChip` props/text.
- [ ] Run to pass: `npm --prefix app run test -- AisTraffic`.
- [ ] `npm --prefix app run typecheck` (proves `satisfies` parity) `&& npm --prefix app run lint` — clean.
- [ ] Commit: `git add app/src/i18n/dict.de.ts app/src/i18n/dict.en.ts app/src/components/AisTraffic.tsx app/src/components/AisTraffic.test.tsx && git commit -m "feat: split AIS status chip with along-route count (#146)"`

---

### Task 5: `AisTraffic` corridor∪viewport composition + App wiring

Map-bound composition (verified in-browser, not jsdom — the component's map wiring follows `DataLayers`/`BoatMarker`). Composes the corridor and viewport into the subscription list and drives the chip.

**Files**
- Modify: `app/src/components/AisTraffic.tsx`
- Modify: `app/src/App.tsx`

**Changes**
- `AisTraffic` props: add `plan: Plan | null; rig: Rig | null; activeLegIndex: number | null` (keep `apiKey`, `ownMmsi`).
- Corridor (recomputes only on `[plan, rig, activeLegIndex]`):
  ```ts
  const corridorBoxes = useMemo(() => {
    if (!plan || !rig) return [];
    const rr = activeRigResult(plan, rig);
    if (!rr) return [];
    return routeCorridorBoxes(rr.legs, activeLegIndex, AIS_CORRIDOR_HALF_WIDTH_NM);
  }, [plan, rig, activeLegIndex]);
  ```
- Subscription union (memoized for referential stability; viewport `bbox` state is unchanged from today):
  ```ts
  const bboxes = useMemo<AisBoundingBox[] | null>(
    () => (bbox === null ? null : mergeOverlappingBoxes([bbox, ...corridorBoxes])),
    [bbox, corridorBoxes],
  );
  ```
- `routeActive = plan !== null && rig !== null && activeRigResult(plan, rig) !== null;` (OPEN QUESTION 2).
- Pass `{ apiKey, ownMmsi, bboxes, corridorBoxes, online, visible }` to `useAisTraffic`; destructure `{ status, targets, targetCount, routeCount }`.
- Render `<AisStatusChip status={status} targetCount={targetCount} routeActive={routeActive} routeCount={routeCount} />`.
- Imports: `activeRigResult` from `../lib/plan`; `routeCorridorBoxes`, `mergeOverlappingBoxes`, `AIS_CORRIDOR_HALF_WIDTH_NM` from `../lib/routeCorridor`; `Plan, Rig` types from `../types`.
- `App.tsx` (~line 583): `plan`, `rig`, `activeLegIndex` are already destructured from `useActivePlan()` (line 129). Pass them through:
  ```tsx
  <AisTraffic apiKey={settings.aisApiKey} ownMmsi={settings.ownMmsi}
    plan={plan} rig={rig} activeLegIndex={activeLegIndex} />
  ```

Steps:

- [ ] Apply the `AisTraffic` composition and the `App.tsx` prop wiring.
- [ ] Confirm no downstream viewport cull exists (addendum "verified during research"): `AisLayer` renders every snapshot target; `snapshotTargets` filters only on missing position. A quick read of `app/src/components/AisLayer.tsx` must show no viewport/bounds filter — if one exists, STOP and raise it (corridor targets outside the viewport must render).
- [ ] `npm --prefix app run typecheck && npm --prefix app run lint` — clean.
- [ ] Run adjacent suites: `npm --prefix app run test -- App.test AisTraffic useAisTraffic aisStream routeCorridor` — green.
- [ ] Verify referential stability by reasoning (and, if practical, a console log during the browser pass): with an unchanged plan/rig/activeLegIndex and viewport, `corridorBoxes` and `bboxes` keep identity across renders, so the subscription effect does not re-fire (no resend churn on GPS fixes).
- [ ] Commit: `git add app/src/components/AisTraffic.tsx app/src/App.tsx && git commit -m "feat: compose route corridor with viewport in the AIS subscription (#146)"`

---

### Task 6: Final assembly — full gate, real-browser pass, CHANGELOG, acceptance

No new production code. Runs the full gate, verifies against the live service with an active plan, records the changelog, walks the #146 acceptance criteria.

**Files**
- Modify: `CHANGELOG.md` (`[Unreleased]` → Added, #146)

Steps:

- [ ] Full local gate in CI order (each clean before the next):
  - `npm --prefix app run lint`
  - `npm --prefix app run typecheck`
  - `npm --prefix app run test` (full suite; generous timeout — the seeded property + real-mask files run for minutes)
  - `npm --prefix app run build`
- [ ] Network-free confirmation (no key ⇒ zero sockets): re-run the offline-sensitive suites explicitly — `npm --prefix app run test -- db.test aisStream aisTargets useAisTraffic routeCorridor AisTraffic` all green; no real WebSocket/`aisstream` traffic in the run (every client is injected).
- [ ] E2E smoke (no key set in e2e ⇒ zero AIS network; corridor changes must not disturb Live-tab e2e): `npm --prefix app run e2e -- live.spec.ts` (and `plan.spec.ts` if in doubt). DEPENDENCY: `app/e2e/live.spec.ts` ships with PR #152 (#142) — this plan executes on a develop that already contains it; if it is absent, stop and re-check your base. The `pree2e` hook rebuilds and rewrites `app/public/test-fixtures/wind-sw12.json` — restore it afterward (`git checkout -- app/public/test-fixtures/wind-sw12.json`); never commit its churn.
- [ ] Real-browser pass with the owner key AND an active plan crossing a ferry lane (repo verification lesson — synthetic tests alone don't count). The live key is at `/tmp/claude-1000/-home-pkuhn-sail-command/1e915eec-a8e1-42c1-bc01-54708e58df08/scratchpad/aisstream-key.txt` (if present; otherwise the owner provides it at run time) — read it from that PATH at run time; never paste its contents into any file, test, commit, or log.
  - `npm --prefix app run dev`; Options → paste the AIS key; plan a route that crosses a ferry lane (e.g. a Flensburg-area passage across the Baltic ferry track). Switch to the Live tab and confirm:
    - Vessels along the route corridor render even when far OUTSIDE the current viewport; panning to that stretch shows them already present with normal fresh/stale tiers (not freshly-appearing).
    - The status chip reads `AIS live · N vessels (M along route)` (en) / `… Schiffe (M entlang Route)` (de) with a plan; `AIS live · N vessels` without a plan.
    - The subscription frame (DevTools → WS) carries corridor ∪ viewport boxes with a plan, and a single viewport box with no plan.
    - Advancing legs / switching rig / changing the plan updates the corridor by RESENDING on the open socket (no new socket in the Network panel — no reconnect churn).
    - No key ⇒ zero sockets (unchanged #25 behavior); going offline/hiding still tears down and restores exactly as before.
- [ ] CHANGELOG — under `## [Unreleased]` → `### Added`, add:
  ```markdown
  - Extend the live AIS overlay to cover a ±5 nm corridor along the active route, so vessels crossing the track ahead show up without panning there; the status chip splits the count into total and along-route while a plan is active (#146).
  ```
- [ ] Commit: `git add CHANGELOG.md && git commit -m "docs: changelog entry for AIS route-corridor subscription (#146)"`
- [ ] #146 acceptance walkthrough — confirm each against the running app + tests, noting evidence:
  - [ ] Active plan + valid key: corridor vessels render even outside the viewport; panning shows them present with normal age tiers. → browser pass + `routeCorridor` coverage tests.
  - [ ] Subscription carries corridor ∪ viewport within caps; no plan ⇒ single viewport box exactly as today. → browser WS inspection + `aisStream` multi-box test + `routeCorridorBoxes` cap tests.
  - [ ] Leg advance / plan / rig change updates the corridor with a resend on the open socket, no reconnect. → browser Network panel + `useAisTraffic` resend + referential-stability reasoning.
  - [ ] Chip reads `live · N (M along route)` with a plan, `live · N` without. → `AisStatusChip` split test + browser pass.
  - [ ] No key ⇒ zero sockets; offline e2e untouched. → `useAisTraffic` off test + e2e smoke.

---

## Notes for the implementer

- **The corridor is a subscription concern, not a rendering one.** It only changes which boxes aisstream streams; targets flow through the unchanged store/layers/aging/declutter. Do NOT add viewport/corridor filtering downstream — `AisLayer` renders every snapshot target (confirm in Task 5).
- **Preserve every #25 client invariant.** Task 2 changes only the box field's shape and the three method signatures. The auth/keyProven/stability machinery, backoff, and error-frame terminal path are untouched — a "re-derived" backoff or auth literal is the tautology alarm (see the CLAUDE.md #145 lesson); leave them alone.
- **nm-true padding is `destinationPoint`, not `padBoundingBox`.** `padBoundingBox` (degree-fraction) stays viewport-only; the corridor pads in true nautical miles from the box corners.
- **Recompute discipline:** corridor on `[plan, rig, activeLegIndex]` only (all three are stable references / change on leg transitions, never per GPS fix); `routeCount` in the 1 Hz snapshot tick only (never per message). Memoize the box lists so the subscription effect resends only on real change.
- **No CPA/TCPA.** A distant vessel near the track is awareness, not collision math — the corridor adds coverage, nothing navigational.
