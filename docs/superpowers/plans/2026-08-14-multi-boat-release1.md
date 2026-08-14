# Multi-boat Release 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the multi-boat machinery — a boat catalogue, per-boat draft driving every depth gate, a catalogue-derived sail id, and a lazy saved-plan migration — with the Salona 45 as the sole catalogue entry, so a plan comes out byte-identical to a pre-#54 plan.

**Architecture:** A TypeScript catalogue module (`app/src/data/boats.ts`) becomes the single source for boat and sail identity; every hardcoded constant it replaces is derived from it by a pinned formula rather than hand-typed. Work lands in three phases ordered by what can certify it: Phase 1 changes no `PlanResult` byte and is certified by `app/sweep/`'s existing byte comparator; Phase 2 renames `PlanResult` fields and therefore needs a canonicalising comparator built first; Phase 3 restructures the pipeline.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`), React 19, Vitest, Playwright, Node ESM (`pipeline/`), Python 3 (`pipeline/verify_mask.py`), `idb` for IndexedDB.

**Spec:** `docs/superpowers/specs/2026-08-10-multi-boat-design.md` (approved 2026-08-10, PR #487; four measured additions 2026-08-14). Read it alongside this plan — every task below argues from a numbered section of it.

**Issue:** #54. Use `Refs #54` in commits and the PR body, never a closing keyword — release 1 does not close the issue.

## Global Constraints

- **`TOLERANCE_M = 0.9` stays global and can never be per-boat.** One mask ships, one blend produced it. Every per-boat lever is on the *gate* side (§C.3). Write this into the code comment; a future reader reaches for `TOLERANCE_M` first.
- **Quantise gates to decimetres, and always UP.** `ceil₁₀(x) = Math.ceil(x * 10 - 1e-9) / 10`. Never `Math.round`: measured, `Math.round(1.73 * 10) === 17`, which would put a 1.73 m boat's relaxation floor at a 1.7 m gate under its own keel (§C.8).
- **Never use floating-point equality on these quantities.** Measured 2026-08-10 in node: `3.0 - 0.9 === 2.1` is exactly `true`, but `2.1 - 0.9 === 1.2000000000000002`. Do comparisons in integer decimetres or via the existing `round1` helper.
- **`erasableSyntaxOnly` forbids enums and constructor parameter properties.** The catalogue is `as const satisfies readonly BoatDef[]`; the sail-id union derives from it via `typeof BOATS[number]['sails'][number]['id']`.
- **`exactOptionalPropertyTypes` is ON.** An optional field is omitted entirely, never assigned `undefined`.
- **`Plan` is structured-clone-safe but NOT JSON-safe** — `WindGrid` carries three `Float32Array`s. A migration must stay in the structured-clone domain; a JSON round-trip silently destroys the wind grid.
- **Every user-facing string goes through BOTH i18n dicts** with `satisfies Record<MsgKey, string>` parity. Sail and boat *labels* are catalogue data (proper nouns), not dictionary keys.
- **No chart-authority language** in any new copy.
- **UI is OUT of scope** (§B) — a separate workstream. Release 1 makes sail selection *expressible* (`PlanRequest.sailIds`); it does not build the picker.
- **N is capped at 2 comparison sails per plan** (§J OQ-3). Do not design N-way `tie`/`moot` semantics; §L rejects that as speculative.
- **CI runs lint + typecheck BEFORE tests.** Run `npm --prefix app run typecheck` and `lint` locally; `lint` covers `app/e2e/**`.

---

## Phase ordering — read this before starting

The order is forced by what can certify each change, not by convenience.

| Phase | Tasks | Certified by |
|---|---|---|
| **1** | 1–6 | `app/sweep/` byte comparator — **sound here**, because no `PlanResult` field changes |
| **2** | 7–11 | a canonicalising comparator built in Task 8 — the byte comparator is **blind** to the rename |
| **3** | 12–13 | polar content equality modulo the renamed key; `verify_mask.py` exit 0 |

§K records why: `compare.mjs` compares `JSON.stringify` output plus a whole-file sha256 (`~:83-107`) with no field awareness, and `PlanResultError` (`types.ts ~:235-238`) carries no sail fields, so the all-error `becalmed` / `deep-becalmed` arms stay byte-identical through the rename and report IDENTICAL — a false green. **Do not reorder Phase 2 before Phase 1.**

### Task 0 — the sweep BASE control (do this first, it gates Task 6)

- [ ] **Step 1: Record the BASE double-run control**

`app/sweep/` is the #282 acceptance harness: nine arms × 33 harbours. Two BASE runs must be byte-identical **to each other** before any BASE-vs-HEAD comparison means anything. Record it against the merge-base of this branch.

```bash
git merge-base HEAD origin/develop          # note the SHA in the PR body
npm --prefix app run test -- --config sweep/vitest.config.ts   # run 1 -> out-base-1/
npm --prefix app run test -- --config sweep/vitest.config.ts   # run 2 -> out-base-2/
node app/sweep/compare.mjs out-base-1 out-base-2
```

Expected: every arm IDENTICAL. If the two BASE runs differ, stop — nothing downstream is interpretable.

- [ ] **Step 2: Record honestly which arms carry signal**

`becalmed` and `deep-becalmed` are **33/33 errors each** and therefore vacuous as safety evidence — their identity would survive any mask or shape change. Report per-arm and state this; never quote "9/9 green".

---

## Phase 1 — no `PlanResult` byte changes

### Task 1: The boat catalogue and `BoatDef`

**Files:**
- Create: `app/src/data/boats.ts`
- Test: `app/src/data/boats.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PolarTier`, `PolarProvenance`, `BoatDef`, `SailDef`, `BOATS`, `type BoatId = typeof BOATS[number]['id']`, `type SailId = typeof BOATS[number]['sails'][number]['id']`, `boatById(id: BoatId): BoatDef`, `DEFAULT_BOAT_ID: BoatId`.

**Layering note.** `data/boats.ts` imports nothing from `types.ts`, and `types.ts` imports `PolarProvenance` from it in Task 11 — one direction only, no cycle. If you prefer `PolarTier` / `PolarProvenance` to live in `types.ts` and be imported *into* the catalogue, that is equally sound; pick one in this task and keep every later task consistent with it.

Per §F.1 the catalogue is a **TypeScript module constant**, not JSON. §L rejects a JSON catalogue outright, and not for payload reasons: it degrades sail ids to bare `string`, removes exhaustiveness checking, and replaces the compiler with hand-written runtime validation.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { BOATS, boatById, DEFAULT_BOAT_ID } from './boats';

describe('boat catalogue', () => {
  it('release 1 ships exactly the Salona 45', () => {
    expect(BOATS.map((b) => b.id)).toEqual(['salona-45']);
  });

  it('states the Salona 45 draft as its own literal', () => {
    expect(boatById('salona-45').draftM).toBe(2.1);
  });

  it('carries per-boat motor and maneuver defaults matching today', () => {
    const b = boatById('salona-45');
    expect(b.motorSpeedKn).toBe(6.5);
    expect(b.maneuverPenaltyS).toBe(45);
  });

  it('requires a provenance tier on every sail', () => {
    for (const b of BOATS) {
      for (const s of b.sails) {
        expect(['certificate', 'modelled', 'estimated']).toContain(s.polarProvenance.tier);
        expect(s.polarProvenance.note.length).toBeGreaterThan(0);
      }
    }
  });

  it('ships no estimated-tier sail in release 1 (OQ-7)', () => {
    const tiers = BOATS.flatMap((b) => b.sails.map((s) => s.polarProvenance.tier));
    expect(tiers).not.toContain('estimated');
  });

  it('defaults to the Salona 45', () => {
    expect(DEFAULT_BOAT_ID).toBe('salona-45');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix app run test -- boats.test`
Expected: FAIL — `Cannot find module './boats'`.

- [ ] **Step 3: Write the catalogue**

```ts
// app/src/data/boats.ts
export type PolarTier = 'certificate' | 'modelled' | 'estimated';

export interface PolarProvenance {
  readonly tier: PolarTier;
  readonly note: string;
}

export interface SailDef {
  readonly id: string;
  readonly label: string;      // proper noun / size — NOT an i18n key (spec F.3)
  readonly polarAsset: string;
  readonly polarProvenance: PolarProvenance;
}

export interface BoatDef {
  readonly id: string;
  readonly name: string;
  /**
   * SAFETY-CRITICAL. Drives the derived default gate (spec C.3) AND the #53
   * relaxation floor (spec C.4a).
   *
   * State the literal. NEVER reference the old BOAT_DRAFT_M: the Salona 44's
   * 2.10 m draft coincides numerically with the Salona 45's constant, and a
   * shared reference means a later change to one silently moves the other
   * (spec C.5, "The Salona 44 trap").
   */
  readonly draftM: number;
  readonly motorSpeedKn: number;
  readonly maneuverPenaltyS: number;
  readonly sails: readonly SailDef[];
}

// Deliberately NOT per-boat, so nobody "completes" this later (spec F.2):
//  - motorThresholdKn (2.5): a seaworthiness floor about WATER, not the hull.
//  - depthComfortMarginM / sailPreferenceKn / performanceFactor / motorEnabled:
//    user preferences, not boat properties.
//  - displacement: nothing in the router consumes it; present in the type it
//    invites a fake physical model on top of an estimated polar.

const SALONA_45_NOTE =
  'Estimate derived from ORC International 2026 certificate Salona 45 "Miles Ahead" (AUT 035/26).';

export const BOATS = [
  {
    id: 'salona-45',
    // Release-1 carve-out (spec J OQ-4): the Salona 45 is the app's existing
    // reference boat, not a Skipperteam fleet vessel, so this entry is
    // model-level and carries no vessel name. The per-vessel rule governs
    // fleet boats.
    name: 'Salona 45',
    draftM: 2.1,
    motorSpeedKn: 6.5,
    maneuverPenaltyS: 45,
    sails: [
      {
        id: 'genoa',
        label: 'Genoa 135 %',
        polarAsset: 'data/polar-genoa.json',
        polarProvenance: { tier: 'modelled', note: `${SALONA_45_NOTE} Hand-modelled overlay on the certificate configuration. NOT race-calibrated.` },
      },
      {
        id: 'fock',
        label: 'Jib 110 %',
        polarAsset: 'data/polar-fock.json',
        polarProvenance: { tier: 'certificate', note: `${SALONA_45_NOTE} The measured ~110 % jib makes this effectively the certificate configuration. NOT race-calibrated.` },
      },
    ],
  },
] as const satisfies readonly BoatDef[];

export type BoatId = (typeof BOATS)[number]['id'];
export type SailId = (typeof BOATS)[number]['sails'][number]['id'];

export const DEFAULT_BOAT_ID: BoatId = 'salona-45';

export function boatById(id: BoatId): BoatDef {
  const b = BOATS.find((x) => x.id === id);
  if (!b) throw new Error(`unknown boat id: ${id}`);
  return b;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix app run test -- boats.test && npm --prefix app run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/data/boats.ts app/src/data/boats.test.ts
git commit -m "feat(boats): add the boat catalogue with the Salona 45 as its sole entry

Refs #54"
```

---

### Task 2: Decimetre quantisation and the derived gates

**Files:**
- Create: `app/src/lib/boatDepth.ts`
- Test: `app/src/lib/boatDepth.test.ts`

**Interfaces:**
- Consumes: `BoatDef` from `app/src/data/boats.ts`.
- Produces: `MASK_TOLERANCE_M` re-export, `ceilToDecimetre(x: number): number`, `defaultSafetyDepthM(b: BoatDef): number`, `minSafetyDepthM(b: BoatDef): number`, `relaxationFloorM(b: BoatDef): number`.

- [ ] **Step 1: Write the failing test — pin the METHOD and the ceiling trap**

The 1.73 m row is the whole point: it is the draft where `Math.round` and `Math.ceil` disagree, and where rounding down would put the gate under the keel.

```ts
import { describe, it, expect } from 'vitest';
import { ceilToDecimetre, defaultSafetyDepthM, minSafetyDepthM, relaxationFloorM } from './boatDepth';
import { MASK_TOLERANCE_M } from './mask';
import { boatById } from '../data/boats';

const boat = (draftM: number) => ({ id: 'x', name: 'X', draftM, motorSpeedKn: 6.5, maneuverPenaltyS: 45, sails: [] });

describe('ceilToDecimetre', () => {
  it('rounds UP, never to nearest', () => {
    expect(ceilToDecimetre(1.73)).toBe(1.8);   // Math.round would give 1.7
    expect(ceilToDecimetre(2.25)).toBe(2.3);
  });

  it('leaves an exact decimetre alone despite float error', () => {
    expect(ceilToDecimetre(2.1)).toBe(2.1);
    expect(ceilToDecimetre(3.0)).toBe(3.0);
  });
});

describe('derived gates', () => {
  it('derives the default gate as ceil to decimetre of draft + tolerance', () => {
    expect(defaultSafetyDepthM(boat(2.1))).toBe(3.0);   // today's DEFAULT_SETTINGS value
    expect(defaultSafetyDepthM(boat(1.73))).toBe(2.7);
    expect(defaultSafetyDepthM(boat(2.3))).toBe(3.2);
  });

  it('satisfies the C.3 invariant for every derived gate', () => {
    for (const d of [1.6, 1.73, 1.9, 2.0, 2.1, 2.25, 2.3, 2.8]) {
      const g = defaultSafetyDepthM(boat(d));
      expect(Math.round((g - MASK_TOLERANCE_M) * 10)).toBeGreaterThanOrEqual(Math.round(d * 10));
    }
  });

  it('sets the UI minimum to draft + 0.1 (OQ-1), reproducing today for the Salona 45', () => {
    expect(minSafetyDepthM(boatById('salona-45'))).toBe(2.2);
  });

  it('quantises the relaxation floor UP, so it is never under the keel', () => {
    expect(relaxationFloorM(boatById('salona-45'))).toBe(2.1);
    expect(relaxationFloorM(boat(1.73))).toBe(1.8);   // NOT 1.7
  });

  it('keeps the relaxation window exactly T wide for every boat (C.4c)', () => {
    for (const d of [1.6, 1.73, 1.9, 2.1, 2.25, 2.3]) {
      const lo = Math.round(relaxationFloorM(boat(d)) * 10);
      const hi = Math.round(defaultSafetyDepthM(boat(d)) * 10);
      expect(hi - lo).toBe(Math.round(MASK_TOLERANCE_M * 10));   // 9 decimetres, always
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix app run test -- boatDepth.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/src/lib/boatDepth.ts
import type { BoatDef } from '../data/boats';
import { MASK_TOLERANCE_M } from './mask';

/**
 * Quantise UP to a decimetre. The mask encodes decimetres, so a gate of 3.15 m
 * behaves IDENTICALLY to 3.2 m — make that explicit rather than accidental.
 *
 * Never Math.round: measured, Math.round(1.73 * 10) === 17, which would give a
 * 1.73 m boat a 1.7 m relaxation floor UNDER ITS OWN KEEL (spec C.8).
 *
 * The 1e-9 nudge mirrors findRelaxedDepthM's: 2.1 * 10 is not exactly 21.
 */
export function ceilToDecimetre(x: number): number {
  return Math.ceil(x * 10 - 1e-9) / 10;
}

/**
 * Spec C.3. The invariant "no cell the router may plan through reads below the
 * hull on the conservative channel" holds iff G >= draft + T.
 *
 * T CANNOT be per-boat — one mask ships, one blend produced it, one constant
 * governs it. Every per-boat lever is on the GATE side. Do not reach for
 * MASK_TOLERANCE_M here.
 */
export function defaultSafetyDepthM(b: BoatDef): number {
  return ceilToDecimetre(b.draftM + MASK_TOLERANCE_M);
}

/** Spec J OQ-1. Reproduces today's 2.2 m literal for the Salona 45's 2.1 m draft. */
export function minSafetyDepthM(b: BoatDef): number {
  return ceilToDecimetre(b.draftM + 0.1);
}

/**
 * Spec C.4(a). THE SINGLE MOST DANGEROUS SHORTCUT IN THIS FEATURE is leaving
 * this as the module constant BOAT_DRAFT_M: relaxation would then take a
 * 2.30 m boat down to a 2.1 m gate — 0.2 m shallower than its keel before the
 * mask tolerance is even applied — while the shallow banner reports the
 * relaxation as if it were the Salona's.
 */
export function relaxationFloorM(b: BoatDef): number {
  return ceilToDecimetre(b.draftM);
}

export { MASK_TOLERANCE_M };
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm --prefix app run test -- boatDepth.test && npm --prefix app run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/boatDepth.ts app/src/lib/boatDepth.test.ts
git commit -m "feat(depth): derive per-boat gates by ceiling quantisation

Pins the METHOD, not a value, so a future reader can run it backwards. The
1.73 m rows pin the Math.round trap: rounding to nearest would put a gate
under the boat's own keel (spec C.8).

Refs #54"
```

---

### Task 3: Generalise the #455 drift guard

**Files:**
- Modify: `app/src/test/maskTolerance.test.ts`

**Interfaces:**
- Consumes: `BOATS`, `boatById` (Task 1); `defaultSafetyDepthM`, `relaxationFloorM`, `ceilToDecimetre` (Task 2).
- Produces: nothing consumed by later tasks.

This guard must exist **before** Task 4 changes the relaxation floor. R4 is the row that would catch a 2.30 m boat relaxing to 2.1 m, and it is the highest-value row in the table (§C.8).

- [ ] **Step 1: Write the failing rows**

Add to the existing file, keeping R0 exactly as it is (its fail-closed `not.toBeNull()` before any value comparison is unchanged).

```ts
// R1 — the non-vacuity twin. Every row below iterates the catalogue, so a
// catalogue stubbed to [] leaves the whole guard green (#411, "a guard's DATA
// needs a twin"). This list is HAND-WRITTEN and must never be derived from BOATS.
//
// Discriminating experiment, recorded so it is run rather than assumed:
//   perturb production alone (add a boat) -> 1 row reds (this one)
//   perturb this table alone              -> 2 rows red (this one and R6)
const EXPECTED_BOAT_IDS = ['salona-45'];

it('R1: the catalogue matches the hand-written expected list', () => {
  expect(BOATS.map((b) => b.id)).toEqual(EXPECTED_BOAT_IDS);
});

it('R2: default safety depth is DERIVED, not hand-typed', () => {
  for (const b of BOATS) {
    expect(defaultSafetyDepthM(b)).toBe(ceilToDecimetre(b.draftM + MASK_TOLERANCE_M));
  }
});

it('R3: the C.3 invariant holds for every catalogue boat', () => {
  for (const b of BOATS) {
    const floorDm = Math.round((defaultSafetyDepthM(b) - MASK_TOLERANCE_M) * 10);
    expect(floorDm).toBeGreaterThanOrEqual(Math.round(b.draftM * 10));
  }
});

it('R4: the relaxation floor is per-boat, not a module constant', () => {
  for (const b of BOATS) {
    expect(relaxationFloorM(b)).toBe(ceilToDecimetre(b.draftM));
  }
  // The assertion that catches a 2.30 m boat relaxing to 2.1 m: a hypothetical
  // deeper boat must NOT floor at the Salona's draft.
  const deep = { ...boatById('salona-45'), id: 'x', draftM: 2.3 };
  expect(relaxationFloorM(deep)).toBe(2.3);
});

it('R6: the Salona 45 still reads its four literals', () => {
  const b = boatById('salona-45');
  expect(b.draftM).toBe(2.1);
  expect(defaultSafetyDepthM(b)).toBe(3.0);
  expect(round1(defaultSafetyDepthM(b) - MASK_TOLERANCE_M)).toBe(2.1);
  expect(round1(relaxationFloorM(b) - MASK_TOLERANCE_M)).toBe(1.2);
});

it('R7: every derived default fits inside the field range', () => {
  for (const b of BOATS) {
    expect(b.draftM + MASK_TOLERANCE_M).toBeLessThanOrEqual(SAFETY_DEPTH_FIELD.max);
  }
});

it('R8: report zero-margin boats rather than relying on a binary pass', () => {
  const zero = BOATS.filter(
    (b) => Math.round((defaultSafetyDepthM(b) - MASK_TOLERANCE_M - b.draftM) * 10) === 0,
  ).map((b) => b.id);
  // Reported, NOT failed — spec C.8 R8. The Salona 45 sits at exactly 0.0 m.
  console.info('[R8] zero floor-margin boats:', zero);
  expect(Array.isArray(zero)).toBe(true);
});
```

Keep **R5** (the disclosure twin) reading the two i18n dictionaries via the existing `containsMeasurement(text, …, 'en'|'de')` calls. With one catalogue boat the four numbers are unchanged (0.9 / 3.0 / 2.1 / 1.2), so **no copy change is required in release 1** — only the source of those numbers moves from literals to the catalogue.

- [ ] **Step 2: Run to verify the new rows fail**

Run: `npm --prefix app run test -- maskTolerance`
Expected: FAIL on R2/R4 — the helpers exist but nothing yet wires the relaxation floor to the boat.

- [ ] **Step 3: Run the R1 discriminating experiment — do not assume it**

§K flags that at a one-entry catalogue R2/R3/R8 iterate a single row and cannot fail differently from R6, so R1 is what stands between them and vacuity.

```bash
# perturb production alone: temporarily add a second entry to BOATS
npm --prefix app run test -- maskTolerance    # expect exactly 1 row red (R1)
git checkout app/src/data/boats.ts

# perturb the test's own table alone: change EXPECTED_BOAT_IDS
npm --prefix app run test -- maskTolerance    # expect 2 rows red (R1 and R6)
git checkout app/src/test/maskTolerance.test.ts
```

Record both counts in the PR body. If either count differs, the guard is not doing what it claims.

- [ ] **Step 4: Commit**

```bash
git add app/src/test/maskTolerance.test.ts
git commit -m "test(depth): generalise the #455 drift guard to the catalogue

R1's discriminating experiment was RUN, not assumed: production-only
perturbation reds 1 row, test-table-only reds 2.

Refs #54"
```

---

### Task 4: Per-boat relaxation floor — SAFETY-CRITICAL

**Files:**
- Modify: `app/src/routing/relaxedDepth.ts`
- Modify: `app/src/routing/planRoute.ts` (thread the boat through to the relaxation search)
- Test: `app/src/routing/relaxedDepth.test.ts`

**Interfaces:**
- Consumes: `relaxationFloorM` (Task 2), `BoatDef` (Task 1).
- Produces: `findRelaxedDepthM` now takes the floor as a parameter instead of reading a module constant.

With one boat at `draftM: 2.1`, `relaxationFloorM` returns `2.1` — **numerically identical to today's `BOAT_DRAFT_M`**, so this task changes no plan. That is exactly why it is safe to do while the byte comparator is still the instrument.

- [ ] **Step 1: Write the failing test**

```ts
it('#54: searches from the BOAT\'s floor, not a module constant', () => {
  // Same inputs, two different floors -> two different search windows.
  const shallowFloor = findRelaxedDepthM({ ...args, floorM: 1.8 });
  const deepFloor = findRelaxedDepthM({ ...args, floorM: 2.3 });
  expect(deepFloor).not.toBe(shallowFloor);
  expect(deepFloor).toBeGreaterThanOrEqual(2.3);
});

it('#54: reproduces today\'s behaviour at the Salona 45 floor', () => {
  expect(findRelaxedDepthM({ ...args, floorM: relaxationFloorM(boatById('salona-45')) }))
    .toBe(findRelaxedDepthM({ ...args, floorM: 2.1 }));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix app run test -- relaxedDepth`
Expected: FAIL — `findRelaxedDepthM` takes no `floorM`.

- [ ] **Step 3: Implement**

Replace the module constant read with a required parameter. Delete `BOAT_DRAFT_M`'s use as a floor; keep the symbol only if something else consumes it, and if nothing does, delete it and let the compiler find every reader.

```ts
/**
 * Spec C.4(a). floorM is the SELECTED BOAT's quantised draft, never a module
 * constant. Left global, relaxation would take a 2.30 m boat to a 2.1 m gate
 * while the shallow banner reported it as the Salona's.
 */
export function findRelaxedDepthM(args: { /* … */ floorM: number }): number | null {
  // search [floorM, requested) exactly as before
}
```

- [ ] **Step 4: Run the full routing suite**

Run: `npm --prefix app run test -- routing && npm --prefix app run typecheck`
Expected: PASS, including `realmask.repro.test.ts`'s DEFAULT_SETTINGS Flensburg→Marstal case pinning `requestedDepthM 3.0` / `usedDepthM ≈ 2.3`.

- [ ] **Step 5: Mutation-check R4**

```bash
# restore the module constant as the floor
npm --prefix app run test -- maskTolerance   # R4 MUST red
```

- [ ] **Step 6: Commit**

```bash
git add app/src/routing/relaxedDepth.ts app/src/routing/planRoute.ts app/src/routing/relaxedDepth.test.ts
git commit -m "feat(routing)!: take the #53 relaxation floor from the boat

Numerically a no-op at the Salona 45's 2.1 m draft; the point is that the
floor is now the selected boat's, so a deeper hull cannot inherit it.
R4 mutation-checked: restoring the module constant reds it.

Refs #54"
```

---

### Task 5: Per-boat settings defaults and the boat-switch clamp

**Files:**
- Modify: `app/src/types.ts` (`DEFAULT_SETTINGS`)
- Modify: `app/src/components/OptionsPanel.tsx` (`SAFETY_DEPTH_FIELD.min`)
- Create: `app/src/lib/boatSettings.ts`
- Test: `app/src/lib/boatSettings.test.ts`

**Interfaces:**
- Consumes: `defaultSafetyDepthM`, `minSafetyDepthM` (Task 2); `boatById`, `DEFAULT_BOAT_ID` (Task 1).
- Produces: `settingsDefaultsForBoat(b: BoatDef): Pick<Settings, 'safetyDepthM' | 'motorSpeedKn' | 'maneuverPenaltyS'>`, `clampSettingsToBoat(s: Settings, b: BoatDef): { settings: Settings; clamped: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
it('reproduces today\'s DEFAULT_SETTINGS for the Salona 45', () => {
  const d = settingsDefaultsForBoat(boatById('salona-45'));
  expect(d.safetyDepthM).toBe(3.0);
  expect(d.motorSpeedKn).toBe(6.5);
  expect(d.maneuverPenaltyS).toBe(45);
});

it('clamps a stored safety depth UP on a boat switch, and reports it', () => {
  const deep = { ...boatById('salona-45'), id: 'deep', draftM: 2.3 };
  const { settings, clamped } = clampSettingsToBoat({ ...DEFAULT_SETTINGS, safetyDepthM: 2.2 }, deep);
  expect(clamped).toBe(true);
  expect(settings.safetyDepthM).toBe(minSafetyDepthM(deep));   // 2.4
});

it('NEVER clamps down', () => {
  const shoal = { ...boatById('salona-45'), id: 'shoal', draftM: 1.6 };
  const { settings, clamped } = clampSettingsToBoat({ ...DEFAULT_SETTINGS, safetyDepthM: 4.0 }, shoal);
  expect(clamped).toBe(false);
  expect(settings.safetyDepthM).toBe(4.0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix app run test -- boatSettings`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Spec C.7. Deliberately DIFFERENT from usePersistedNumber's contract (#355),
 * where a bounds change alone leaves the stored value untouched. That asymmetry
 * is right for a panel width and wrong here: per the guard-asymmetry rule the
 * uncertain path must fail toward the expensive-but-safe direction, and a
 * silently retained below-hull gate is the cheap-and-dangerous one.
 *
 * NEVER clamp down.
 */
export function clampSettingsToBoat(s: Settings, b: BoatDef) { /* … */ }
```

`DEFAULT_SETTINGS.safetyDepthM` becomes `defaultSafetyDepthM(boatById(DEFAULT_BOAT_ID))` — which evaluates to `3.0`, so the literal is preserved by derivation rather than by hand.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npm --prefix app run test -- boatSettings && npm --prefix app run typecheck && npm --prefix app run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/types.ts app/src/components/OptionsPanel.tsx app/src/lib/boatSettings.ts app/src/lib/boatSettings.test.ts
git commit -m "feat(settings): derive per-boat defaults and clamp UP on boat switch

Refs #54"
```

---

### Task 6: Certify Phase 1 with the byte comparator

**Files:** none changed — this is evidence.

- [ ] **Step 1: Run HEAD and compare against the Task 0 BASE**

```bash
npm --prefix app run test -- --config sweep/vitest.config.ts   # -> out-head/
node app/sweep/compare.mjs out-base-1 out-head
```

Expected: **every arm IDENTICAL**. Phase 1 changed no `PlanResult` field and, at a one-boat catalogue, no derived value — so any difference is a real defect, not an expected shape change.

- [ ] **Step 2: Report per-arm, with the vacuity stated**

Record in the PR body: the merge-base SHA, the BASE double-run result, and the per-arm table. State that `becalmed` and `deep-becalmed` are 33/33 errors and carry no signal; the evidence is the other seven arms.

- [ ] **Step 3: Run the full suite**

Run: `npm --prefix app run typecheck && npm --prefix app run lint && npm --prefix app run test`
Expected: all green.

---

## Phase 2 — the rename, and the comparator it needs first

### Task 7: Structural guard against the sail enumeration regrowing

**Files:**
- Create: `app/src/test/sailLiteralCallSites.test.ts`

**Interfaces:**
- Consumes: `BOATS` (Task 1).
- Produces: nothing.

Nine non-test files enumerate the sail set with **no derivation between any of them** (§F.3). The compiler protects that asymmetrically: a `Record<SailId, …>` reds loudly, while a two-way ternary keeps compiling and silently selects the wrong sail. Model this on `app/src/test/chipShallowFill.test.ts`.

- [ ] **Step 1: Write the guard, with its allowlist twin**

```ts
// The allowlist is HAND-WRITTEN and pinned — per #411, a guard's DATA needs a
// twin, or stubbing this to [] silently disables the guard while it keeps
// reporting success.
const ALLOWED = [
  'src/data/boats.ts',
  'src/i18n/dict.de.ts',
  'src/i18n/dict.en.ts',
];

it('the allowlist is exactly what we expect', () => {
  expect(ALLOWED).toEqual(['src/data/boats.ts', 'src/i18n/dict.de.ts', 'src/i18n/dict.en.ts']);
});

it('no bare sail-id literal outside the allowlist', () => {
  const ids = BOATS.flatMap((b) => b.sails.map((s) => s.id));
  const pattern = new RegExp(`['"\`](${ids.join('|')})['"\`]`);
  const offenders = walkSourceFiles('app/src')
    .filter((f) => !f.includes('.test.') && !ALLOWED.some((a) => f.endsWith(a)))
    .filter((f) => pattern.test(readFileSync(f, 'utf8')));
  expect(offenders, `bare sail-id literals must go through the catalogue`).toEqual([]);
});
```

Match `'`, `"` **and** backtick — PR #411 measured a guard that matched only single quotes and stayed 10/10 green against a backtick re-coupling.

- [ ] **Step 2: Run it — it will fail, and that is correct**

Run: `npm --prefix app run test -- sailLiteralCallSites`
Expected: FAIL, listing the nine files. They are fixed in Task 9; keep this task's commit and Task 9's adjacent, or mark the assertion `it.fails` with a `#54` comment and flip it in Task 9.

- [ ] **Step 3: Mutation-check both directions**

```bash
# 1. plant a bare 'genoa' literal in a non-allowlisted file -> the scan row MUST red
# 2. stub ALLOWED to [] -> the allowlist row MUST red (the data twin)
# 3. write the planted literal with BACKTICKS instead of quotes -> MUST still red
```

Probe 3 is not optional: PR #411 measured a structural guard that matched only single-quoted literals and stayed **10/10 green** against a backtick re-coupling, passing both lint and typecheck (prettier normalises `"…"` to `'…'` but leaves a template literal alone).

- [ ] **Step 4: Commit**

```bash
git add app/src/test/sailLiteralCallSites.test.ts
git commit -m "test(sails): guard against the sail enumeration regrowing

Allowlist pinned per #411 and mutation-checked in three directions,
including the backtick form that defeated a single-quote-only guard.

Refs #54"
```

---

### Task 8: A canonicalising sweep comparator

**Files:**
- Create: `app/sweep/canonicalize.mjs`
- Modify: `app/sweep/compare.mjs` (accept `--canonical`)
- Modify: `app/sweep/README.md`

**Interfaces:**
- Produces: `canonicalizePlan(plan): object` — maps both the pre-rename and post-rename shapes onto one canonical form.

§K: the byte comparator is **blind** to the rename and fails in the reassuring direction. Build this **before** Task 9, or Task 9 has no valid instrument.

- [ ] **Step 1: Write the failing test**

```js
// A pre-rename and a post-rename plan carrying the SAME routes must canonicalize equal.
assert.deepStrictEqual(canonicalizePlan(legacyShapePlan), canonicalizePlan(renamedShapePlan));
// …and two plans whose ROUTES differ must NOT.
assert.notDeepStrictEqual(canonicalizePlan(planA), canonicalizePlan(planBWithOneLegMoved));
```

The second assertion is the one that matters: a canonicaliser that flattens everything would make every comparison pass.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test app/sweep/canonicalize.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the canonicaliser**

```js
// app/sweep/canonicalize.mjs
// Maps BOTH the pre-rename shape (named genoa/fock/genoaReason/fockReason)
// and the post-rename shape (a per-sail list) onto one form, so a rename can
// be certified as route-preserving.
//
// It deliberately does NOT normalise leg geometry, ETAs, distances or reasons —
// only the CONTAINER shape. Flattening any of those would make every
// comparison pass, which is the failure mode this file exists to avoid.
export function canonicalizePlan(plan) {
  if (plan?.status !== 'ok') return plan;                 // errors are already shape-stable
  const sails = plan.sails
    ? plan.sails.map((s) => ({ sailId: s.sailId, result: s.result ?? null, reason: s.reason ?? null }))
    : [
        { sailId: 'genoa', result: plan.genoa ?? null, reason: plan.genoaReason ?? null },
        { sailId: 'fock', result: plan.fock ?? null, reason: plan.fockReason ?? null },
      ];
  const { genoa, fock, genoaReason, fockReason, ...rest } = plan;
  return { ...rest, sails: sails.sort((a, b) => a.sailId.localeCompare(b.sailId)) };
}
```

- [ ] **Step 4: Run to verify it passes, then mutation-check it**

Run: `node --test app/sweep/canonicalize.test.mjs`
Expected: PASS.

Then prove it can fail — a canonicaliser that cannot fail is worse than none:

```bash
# perturb ONE leg's distanceNm in one input, re-run: the canonical comparison MUST red
# stub canonicalizePlan to `return {}`: the "routes differ" assertion MUST red
```

Record both outcomes in the PR body.

- [ ] **Step 5: Wire it into compare.mjs and document it**

Add a `--canonical` flag. Keep the default byte behaviour unchanged so Phase 1's evidence is untouched. Update `app/sweep/README.md` to state **when each comparator is valid**: byte for a no-change claim, canonical for a deliberate shape change, and that the byte comparator is blind to a `PlanResultOk` rename because `PlanResultError` carries no sail fields.

- [ ] **Step 6: Commit**

```bash
git add app/sweep/canonicalize.mjs app/sweep/canonicalize.test.mjs app/sweep/compare.mjs app/sweep/README.md
git commit -m "test(sweep): add a canonicalising comparator for the PlanResult rename

The byte comparator can certify NO change; it cannot certify a deliberate
one. PlanResultError carries no sail fields, so the all-error becalmed /
deep-becalmed arms would stay byte-identical through the rename and report
IDENTICAL — a false green.

Refs #54"
```

---

### Task 9: `Rig` → `SailId` and the per-sail result list

**Files:**
- Modify: `app/src/types.ts` — `Rig` → `SailId`, `PlanResultOk`'s `genoa`/`fock`/`genoaReason`/`fockReason` → a per-sail list; delete `RIG_ORDER`
- Modify: the nine literal-naming files listed in §F.3, plus `lib/resultSummary.ts` and `components/PlansList.tsx` (§F.3's added bullet — they hold `genoa`/`fock` as Record **property keys**, so the nine-file grep never saw them)
- Modify: `app/src/routing/planRoute.ts` — `runBoth` iterates `request.sailIds`
- Modify: `app/src/routing/planRoute.test.ts` — the #340 guard
- Test: all of the above

**Interfaces:**
- Consumes: `SailId` (Task 1), `canonicalizePlan` (Task 8).
- Produces — **declare these exactly; Tasks 8, 10b and 11 all depend on them:**

```ts
export interface SailResult {
  readonly sailId: SailId;
  readonly result: RigResult | null;      // RigResult itself is UNCHANGED
  readonly reason: NoRouteReason | null;
}

export interface PlanResultOk {
  readonly status: 'ok';
  readonly sails: readonly SailResult[];  // replaces genoa/fock/genoaReason/fockReason
  readonly recommended: SailId;
  readonly comparisonComplete: boolean;   // false when a sail exhausted the budget (Task 10b)
  readonly shallow?: ShallowInfo;         // unchanged: one value for the whole plan
  readonly rigRecommendation?: RigRecommendation;   // unchanged, still binary (OQ-3)
  readonly snappedOrigin: LatLon;
  readonly snappedDestination: LatLon;
}

// PlanRequest gains:
readonly sailIds: readonly SailId[];      // THE SOLVE ORDER. At most 2 (OQ-3).
```

`RigResult` keeps its `rig` field, renamed to `sailId`; nothing else about it changes. `recommendedResult()` moves to a lookup over `sails` and **preserves its invariant verbatim**: status `'ok'` guarantees the recommended sail has a non-null `result` — throw rather than fabricate an ETA.

§E.3: *"The plan's selected sails are an ordered list on `PlanRequest`, and that list — not a module constant — is the solve order. `RIG_ORDER` is deleted."* The #340 guard generalises from *"observed first-seen order equals `RIG_ORDER`"* to *"…equals `request.sailIds`"*, still recorded into an **array** (deliberately not a `Set`, which is order-blind).

- [ ] **Step 1: Generalise the #340 guard first**

```ts
it('#340/#54: solve order matches request.sailIds', () => {
  const seen: SailId[] = [];
  planRoute({ ...req, sailIds: ['fock', 'genoa'] }, deps, (sailId) => {
    if (!seen.includes(sailId)) seen.push(sailId);
  });
  expect(seen).toEqual(['fock', 'genoa']);   // reversed order must be honoured
});
```

Reversing the order in the request is what makes this non-vacuous: under the old module constant it would still report `['genoa','fock']`.

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Do the rename**

Preserve `recommendedResult()`'s invariant **verbatim**: *"status 'ok' guarantees the recommended sail has a non-null result — throw rather than fabricate an ETA."* It is why Task 11 needs the unreadable-row handling.

Cap N at 2 (§J OQ-3). Do **not** generalise `RigRecommendation` to N-way — §L rejects it as speculative and genuinely ambiguous.

- [ ] **Step 4: Certify with the canonical comparator, NOT the byte one**

```bash
npm --prefix app run test -- --config sweep/vitest.config.ts   # -> out-head-2/
node app/sweep/compare.mjs --canonical out-base-1 out-head-2
```

Expected: every arm CANONICALLY IDENTICAL. Record explicitly that the **byte** comparison is expected to differ on every `status:'ok'` row and that this is not evidence of a regression.

- [ ] **Step 5: Flip Task 7's guard green and commit**

---

### Task 10: A keyed polar map across assets, protocol and `PlanDeps`

**Files:**
- Modify: `app/src/services/assets.ts`, `app/src/routing/protocol.ts`, `app/src/routing/workerClient.ts`, `app/src/routing/planRoute.ts`, `app/sweep/sweepArms.ts`

§F.3: `init` carries a **keyed map** of every boat's polars (single-digit KB, structured-cloned once at startup) and `plan` names which keys to run — preserving "init once, plan many" at zero per-plan cost. Polars are plain objects and are **cloned, never transferred**; only the mask buffer is transferred, always as a `.slice(0)` copy.

- [ ] **Step 1: Write the failing test**

```ts
it('#54: init carries every catalogue polar, keyed', async () => {
  const posted: WorkerRequest[] = [];
  const client = new RoutingClient({ postMessage: (m) => posted.push(m) } as never);
  await client.init(assets);
  const init = posted.find((m) => m.type === 'init')!;
  expect(Object.keys(init.polars).sort()).toEqual(['salona-45/fock', 'salona-45/genoa']);
});

it('#54: transfers ONLY the mask buffer — polars are cloned', async () => {
  const transfers: unknown[][] = [];
  const client = new RoutingClient({ postMessage: (_m, t) => transfers.push(t ?? []) } as never);
  await client.init(assets);
  expect(transfers[0]).toHaveLength(1);          // the mask, and nothing else
});

it('#54: a plan names which keys to run', () => {
  const msg = buildPlanMessage({ ...req, boatId: 'salona-45', sailIds: ['genoa', 'fock'] });
  expect(msg.polarKeys).toEqual(['salona-45/genoa', 'salona-45/fock']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix app run test -- workerClient`
Expected: FAIL — `init.polars` is undefined; the message still carries `polarGenoa` / `polarFock`.

- [ ] **Step 3: Implement the keyed map**

Replace the two named fields on `RoutingAssets`, on `protocol.ts`'s `init` arm, on its closure `state`, and on `PlanDeps` with one `polars: Readonly<Record<string, PolarTable>>` keyed `` `${boatId}/${sailId}` ``. `loadRoutingAssets()` builds it by iterating `BOATS`, replacing the two hardcoded fetch paths.

- [ ] **Step 4: Update `app/sweep/sweepArms.ts`**

`runArm` constructs `PlanDeps` and reads the two polars by literal filename. Point it at the same keyed map. The sweep is the instrument for this task, so it must be updated in the same commit — the comparison is of outputs, which this task does not change.

- [ ] **Step 5: Verify with the canonical comparator**

```bash
npm --prefix app run test -- --config sweep/vitest.config.ts   # -> out-head-3/
node app/sweep/compare.mjs --canonical out-base-1 out-head-3
```

Expected: every arm CANONICALLY IDENTICAL — this task moves inputs, not results.

- [ ] **Step 6: Commit**

```bash
git add app/src/services/assets.ts app/src/routing/protocol.ts app/src/routing/workerClient.ts app/src/routing/planRoute.ts app/sweep/sweepArms.ts
git commit -m "refactor(routing): key polars by boat and sail across the worker boundary

Preserves init-once/plan-many: every catalogue polar is cloned once at
startup and the plan message names which keys to run. Only the mask buffer
is transferred.

Refs #54"
```

---

### Task 10b: Partial results when the budget runs out mid-comparison

**Files:**
- Modify: `app/src/routing/planRoute.ts` (`assemble`)
- Test: `app/src/routing/planRoute.budget.test.ts`

§E.3: *"Budget exhaustion partway through is a PARTIAL result, not a failure — today's semantics, generalised."* `assemble` needs only **one** non-null result, so it is still reached.

- [ ] **Step 1: Write the failing test**

```ts
it('#54: one sail solving and one exhausting yields status ok, not a failure', () => {
  const res = assemble([
    { sailId: 'genoa', rigResult: aResult, cause: null },
    { sailId: 'fock', rigResult: null, cause: 'budget-exhausted' },
  ], null);
  expect(res.status).toBe('ok');
  expect(res.sails.find((s) => s.sailId === 'fock')!.reason).toBe('search-budget-exceeded');
  expect(res.comparisonComplete).toBe(false);      // the UI must be able to say so
  expect(res.recommended).toBe('genoa');           // computed over the COMPLETED set only
});

it('#54: all sails exhausting yields plan-level search-budget-exceeded', () => {
  const res = assemble([
    { sailId: 'genoa', rigResult: null, cause: 'budget-exhausted' },
    { sailId: 'fock', rigResult: null, cause: 'budget-exhausted' },
  ], null);
  expect(res.status).toBe('error');
  expect(res.reason).toBe('search-budget-exceeded');
});
```

The `comparisonComplete` flag is what stops a one-sail result being presented as a comparison. Never re-run to fill the gap — `comfortRetryMayHelp` and `depthRelaxationMayHelp` both reject `budget-exhausted` precisely because a retry re-solves against a deadline that has already passed.

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix app run test -- planRoute.budget`
Expected: FAIL — `comparisonComplete` does not exist.

- [ ] **Step 3: Implement, keeping `combineFailureCause`'s existing top precedence**

`'budget-exhausted'` stays the highest precedence, which exists so the app never reports "unreachable" — a claim about the water — when the honest answer is "we ran out of time and do not know".

- [ ] **Step 4: Run tests and the canonical sweep**

Run: `npm --prefix app run test -- routing`
Expected: PASS. No arm should change: at a 120 s budget and one boat, no sweep arm exhausts today.

- [ ] **Step 5: Commit**

---

### Task 11: `PlanRequest.boat` snapshot, `schemaVersion`, and `migratePlan`

**Files:**
- Modify: `app/src/types.ts`, `app/src/services/db.ts`, `app/src/lib/sessionSnapshot.ts`
- Create: `app/src/services/migratePlan.ts`, `app/src/services/migratePlan.test.ts`

**Interfaces:**
- Produces: `migratePlan(raw: unknown): Plan | null`, `PlanSummary` gains an unreadable variant.

Per §I.2 there is **no IndexedDB version bump**: IndexedDB is scoped to origin, so production and UAT share the `'sailcommand'` database; UAT bumps first, and `db()` caches its promise with no rejection reset, so a `VersionError` would be sticky for the whole session and strand production's entire database.

- [ ] **Step 1: Write the failing tests**

```ts
it('relabels an old plan onto the Salona 45 with ZERO recomputation', () => {
  const migrated = migratePlan(legacyPlan)!;
  expect(migrated.request.boat.id).toBe('salona-45');
  expect(migrated.result.sails.map((s) => s.sailId)).toEqual(['genoa', 'fock']);
  // Pure relabelling — never re-plan, never re-derive an ETA.
  expect(migrated.result.sails[0]!.etaMs).toBe(legacyPlan.result.genoa.etaMs);
});

it('preserves the wind grid as Float32Array (structured-clone domain)', () => {
  expect(migratePlan(legacyPlan)!.windGrid.u).toBeInstanceOf(Float32Array);
});

it('lists an unmigratable record as UNREADABLE, never skipping or deleting it', () => {
  const rows = summarize([{ ...legacyPlan, schemaVersion: 999 }]);
  expect(rows[0]!.kind).toBe('unreadable');
  expect(rows[0]!.name).toBe(legacyPlan.name);   // readable from any shape
});

it('renders a saved plan whose boat has left the catalogue', () => {
  const plan = { ...migrated, request: { ...migrated.request, boat: { id: 'gone', name: 'Gone', draftM: 2.0, sails: [] } } };
  expect(() => renderSummary(plan)).not.toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix app run test -- migratePlan`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `Plan.schemaVersion` and the boat snapshot**

Key rule (§I.3): denormalise the boat **by value** into `PlanRequest.boat`, never a catalogue id reference — precedent is `PlanRequest.settings`, already a snapshot. Everything needed to render a saved plan then lives inside the record; the catalogue is needed only to *re-plan*.

```ts
// types.ts
export interface BoatSnapshot {
  readonly id: string;
  readonly name: string;
  readonly draftM: number;
  readonly sails: readonly { id: string; label: string; polarProvenance: PolarProvenance }[];
}
// PlanRequest gains `boat: BoatSnapshot`; Plan gains `schemaVersion: number`.
```

`schemaVersion` is stamped on write. The database version is not the only entry path — a plan can also arrive from a future import (#3) — and an untagged record has no self-description.

- [ ] **Step 4: Implement `migratePlan` as a pure relabelling**

Never re-plan, never re-derive an ETA, never re-run the solver. The stored wind grid is stale by definition and the result must keep rendering exactly as computed. Stay in the structured-clone domain — a JSON round-trip silently destroys the `Float32Array` wind grid.

- [ ] **Step 5: Replace `listPlans`'s skip with an unreadable placeholder row**

Today's per-row catch-and-skip makes a plan silently *vanish from the user's list* while the bytes survive — from where the user sits, indistinguishable from deletion. Keep the per-row isolation (one bad record must never blank the list), but emit a placeholder: `name` and `createdAtMs` are readable from any shape. **Never delete.**

- [ ] **Step 6: Narrow `sessionSnapshot`'s validator**

`isRig` becomes *"is this sail id present in the plan's own snapshot"*, not *"is it in the catalogue"* — a snapshot referencing a since-removed boat must still restore. Note today's failure mode: `parseSessionSnapshot` collapses the **entire** snapshot to `null` on any field failing its union check, so an unrecognised sail id would also lose the user's restored plan id and tab.

- [ ] **Step 7: Verify and commit**

Run: `npm --prefix app run test -- migratePlan sessionSnapshot db && npm --prefix app run typecheck`

```bash
git add app/src/types.ts app/src/services/db.ts app/src/services/migratePlan.ts app/src/services/migratePlan.test.ts app/src/lib/sessionSnapshot.ts
git commit -m "feat(persistence): lazy read-time plan migration, no IndexedDB version bump

IndexedDB is origin-scoped, so prod and UAT share the 'sailcommand' database
and UAT bumps first; db() caches its promise with no rejection reset, so a
VersionError would be sticky for the whole session and strand production's
entire database. Lazy migration scopes the failure to one plan.

Refs #54"
```

---

## Phase 3 — pipeline

### Task 12: Per-boat polars source, fail-closed provenance, boat-id output naming

**Files:**
- Modify: `pipeline/polars-source.json`, `pipeline/build_polars.mjs`
- Move: `app/public/data/polar-*.json` → `app/public/data/polars/salona-45-*.json`

§H, with the 2026-08-14 addition: `build_polars.mjs` enumerates the sail set **twice** (loop `~:45`, `SOURCE_NOTES` `~:9-21`) and neither list derives from the other, so a sail in one but not the other writes `"source": undefined` into a shipped asset with no throw. Derive the loop from the data and delete `SOURCE_NOTES`.

Also §F.1's live collision: `build_polars.mjs` writes ``join(outDir, `polar-${rig}.json`)`` (`~:57`) with **no boat identifier**, so a second boat's files would overwrite the first's.

- [ ] **Step 1: Prove the content is unchanged**

```bash
npm --prefix pipeline run polars
# content must be identical modulo the renamed key and the new path
```

- [ ] **Step 2: Fail closed on a missing provenance tier or missing anchors**

A boat added without its own sanity anchors, or without a `polarProvenance` tier, **fails the build** — never inherits the Salona's. An anchor that silently validates the wrong hull is worse than no anchor.

- [ ] **Step 3: Verify the precache still picks the assets up**

`globPatterns` sweeps `**/*.json`, so a new `polars/` subdirectory is covered with no config change — confirm in the built `dist` rather than assuming.

- [ ] **Step 4: Commit**

---

### Task 13: `verify_mask.py` per-boat gate scan

**Files:**
- Modify: `pipeline/verify_mask.py`

§C.6: the script verifies connectivity at exactly one gate (`DEFAULT_GATE_DEPTH_M = 3.0`, `~:75`). Navigability is monotone in the gate, so every harbour verified at 3.0 m may drop out at a higher one and **nothing in this repository has measured where**.

- [ ] **Step 1: Scan at every catalogue boat's derived gate**

Report per-boat connected / exception / disconnected sets. `CONNECTIVITY_EXCEPTIONS_M` and `KNOWN_DISCONNECTED` become **per-boat-gate aware**: an exception justified against a 3.0 m gate says nothing about a 3.2 m one.

- [ ] **Step 2: Add the snap-cell margin report**

Each harbour's snap-cell depth minus its gate, flagging anything under 0.2 m. Two harbours currently pass at exactly **0.0 m** (`aabenraa` 3.0 vs 3.0, `augustenborg` 2.8 vs 2.8) and a binary gate cannot see them.

- [ ] **Step 3: Verify exit 0 at the Salona 45's derived gate**

Run: `pipeline/.venv/bin/python pipeline/verify_mask.py`
Expected: exit 0, with the report naming the 3.0 m gate as the Salona 45's derived gate rather than a hardcoded default.

- [ ] **Step 4: Commit**

---

## Acceptance (from §K, scoped to release 1)

- [ ] **Reduces to today.** With only the Salona 45 in the catalogue: `draftM 2.1` → default gate 3.0 → mask floor 2.1; relaxation window `[2.1, 3.0)`; two sails; same solve order; same budget; same tiers.
- [ ] **Phase 1 certified by the byte comparator**, BASE double-run control recorded first, reported per-arm with `becalmed` / `deep-becalmed` named as vacuous.
- [ ] **Phase 2 certified by the canonical comparator**, with the byte difference explicitly recorded as expected.
- [ ] **The safety invariant is guarded, per boat.** R0–R8 pass; R1's discriminating experiment RUN (1 row vs 2 rows), not assumed; R4 reds under a mutation restoring the module constant; R6's Salona literals still read 2.1 / 3.0 / 2.1 / 1.2.
- [ ] **`verify_mask.py` exits 0** at the catalogue boat's derived gate, with the snap-cell margin report.
- [ ] **Per-boat polar validation fails closed** on a missing tier or missing anchors.
- [ ] **Saved plans survive.** A pre-#54 plan opens, renders identically, exports GPX identically, and reports the Salona 45. An unmigratable record is **listed as unreadable, never skipped and never deleted**.
- [ ] **de/en `MsgKey` parity** for every new string.
- [ ] **No changelog fragment for the internal tasks**; one fragment for the release-1 feature as a whole, describing what a user can observe (saved plans keep working; nothing else changes yet, because the UI is a separate workstream).

## Out of scope — do not build

- The settings/planner UI surface, including the boat picker and the sail-selection control (§B).
- Any fleet boat. OQ-7: release 1 ships **machinery only**, Salona 45 alone, **no estimated-polar boats**. Each further boat lands as its own PR once real per-hull draft **and** tier-A/B provenance exist.
- Tier-C UI (§G.3 rule 2), user-supplied polar import (§G.3 rule 3), N-way `tie`/`moot` semantics (§L), any change to `TOLERANCE_M` or the mask (§C.9).

## Parallel, off the critical path

- **Email Skipperteam** (§G.3 rule 4) — as the operator they would hold certificates for any boat that races, and one email may move several models from tier C to tier A. The cheapest available action on **OQ-6**, with zero dependency on release 1.
