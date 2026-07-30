# Live Heading Depth Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Live view's heading-to-steer readout say when the bearing it displays crosses water shallower than the plan's safety depth — and say when it could not check at all.

**Architecture:** A new pure module `app/src/lib/headingDepth.ts` answers "does the straight line from the fix to the active waypoint cross sub-safety water?" as a three-valued result, plus a pure reducer implementing asymmetric hysteresis. A small hook supplies the `NavMask` from the existing asset singleton. `LiveView` composes them and renders one of three states. No routing code changes.

**Tech Stack:** TypeScript (strict + `exactOptionalPropertyTypes`, `erasableSyntaxOnly`), React 19, Vitest, @testing-library/react.

Spec: `docs/superpowers/specs/2026-07-30-live-heading-depth-honesty-design.md`. Issue: #251.

## Global Constraints

- TypeScript `strict` and `exactOptionalPropertyTypes` are ON. `erasableSyntaxOnly` forbids enums and constructor parameter properties.
- Every user-facing string goes through the i18n dictionary. Add each new key to **both** `app/src/i18n/dict.de.ts` and `app/src/i18n/dict.en.ts` — parity is enforced by `satisfies Record<MsgKey, string>`.
- Copy must never claim safety or chart authority. Do not use "safe" / "sicher" / "verified" / "geprüft sicher". The app is a passage-planning aid.
- Do **not** modify `app/src/lib/live.ts`, anything under `app/src/routing/`, or `app/e2e/live.spec.ts`.
- Do **not** add any element with `role="alert"` or `aria-live` to the Live view. `app/e2e/live.spec.ts` asserts `[role="alert"]` count is 0 after a reroute, and that assertion must stay valid by construction.
- Tests import vitest APIs explicitly: `import { describe, expect, it } from 'vitest'`.
- Expected depth values in tests are hand-derived from the documented mask encoding, never copied from the function's own output.
- Mask byte encoding (`app/src/types.ts:231-234`): byte `0` = LAND/unknown; `1..254` = depth in decimetres rounded down (0.1–25.4 m); `255` = deep, ≥ 25.4 m. `byteToDepthM(b) = b === 0 ? 0 : b === 255 ? 25.4 : b / 10`.
- Run a single test file with: `npm --prefix app run test -- src/lib/headingDepth.test.ts`
- Full gate before the PR: `npm --prefix app run lint`, `npm --prefix app run typecheck`, `npm --prefix app run test`.
- Never use `--no-verify`, `--force`, `-f`, or `--force-with-lease`. Stage explicit paths; never `git add -A`.
- Branch: `feat/251-live-heading-depth-honesty` (already has the spec commit `74abda8`). Sync with `develop` before starting: `git fetch origin && git merge origin/develop`.

---

### Task 1: `checkHeadingDepth` — the pure three-valued probe

**Files:**
- Create: `app/src/lib/headingDepth.ts`
- Test: `app/src/lib/headingDepth.test.ts`

**Interfaces:**
- Consumes: `NavMask` from `app/src/lib/mask.ts` (public: `readonly meta: MaskMeta`, `segmentShallowestBelow(a: LatLon, b: LatLon, thresholdM: number): number | null`); `LatLon`, `Leg`, `MaskMeta` from `app/src/types.ts`.
- Produces: `export type HeadingDepthCheck`, `export function checkHeadingDepth(...)`, `export function maskCellKey(...)` — used by Tasks 2 and 4.

**Critical correctness note — read before writing code.** `NavMask.segmentShallowestBelow` returns `null` in **two** different situations: when no touched cell is below the threshold (our `clear`), *and* when the walk leaves the grid or trips its iteration guard (our `unavailable`). It cannot distinguish them. Relying on `null` alone would render a false all-clear whenever the boat is outside mask coverage — the exact failure this feature exists to prevent. Because `NavMask.meta` is public and the mask is a lat/lon rectangle, check both endpoints against the bounds *first*; only then is a `null` trustworthy as `clear`.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/headingDepth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NavMask } from './mask';
import { checkHeadingDepth } from './headingDepth';
import type { LatLon, Leg, MaskMeta } from '../types';

// 10x10 cells of 0.01 deg over 54.00-54.10 N, 9.00-9.10 E.
// Row 0 is the southernmost row, col 0 the westernmost (types.ts:233).
const META: MaskMeta = { west: 9.0, south: 54.0, east: 9.1, north: 54.1, cols: 10, rows: 10 };
const STEP = 0.01;

// Byte 255 = "deep, >= 25.4 m", which segmentShallowestBelow never counts as
// shallow — so an all-255 grid is unambiguously clear at any threshold.
function maskWith(cells: Array<{ row: number; col: number; byte: number }>): NavMask {
  const data = new Uint8Array(META.rows * META.cols).fill(255);
  for (const c of cells) data[c.row * META.cols + c.col] = c.byte;
  return new NavMask(META, data);
}

function centreOf(row: number, col: number): LatLon {
  return { lat: META.south + (row + 0.5) * STEP, lon: META.west + (col + 0.5) * STEP };
}

function legTo(start: LatLon, end: LatLon): Leg {
  return {
    kind: 'sail',
    start,
    end,
    startTimeMs: 0,
    endTimeMs: 3_600_000,
    headingDeg: 90,
    twsKn: 12,
    speedKn: 5,
    distanceNm: 1,
    board: 'starboard',
    twaDeg: 45,
    maneuverAtStart: null,
  };
}

describe('checkHeadingDepth', () => {
  it('reports clear when every cell along the bearing is deep', () => {
    const from = centreOf(0, 0);
    const to = centreOf(0, 9);
    const result = checkHeadingDepth(maskWith([]), [legTo(from, to)], 0, from, 3.0);
    expect(result).toEqual({ state: 'clear' });
  });

  it('reports caution with the shallowest depth on the bearing', () => {
    const from = centreOf(0, 0);
    const to = centreOf(0, 9);
    // byte 20 -> 20/10 = 2.0 m; byte 25 -> 2.5 m. Shallowest is 2.0.
    const mask = maskWith([
      { row: 0, col: 4, byte: 25 },
      { row: 0, col: 6, byte: 20 },
    ]);
    const result = checkHeadingDepth(mask, [legTo(from, to)], 0, from, 3.0);
    expect(result).toEqual({ state: 'caution', shallowestM: 2.0 });
  });

  it('ignores shallow cells that the bearing does not cross', () => {
    const from = centreOf(0, 0);
    const to = centreOf(0, 9);
    const mask = maskWith([{ row: 9, col: 4, byte: 20 }]);
    const result = checkHeadingDepth(mask, [legTo(from, to)], 0, from, 3.0);
    expect(result).toEqual({ state: 'clear' });
  });

  it('treats a cell exactly at the safety depth as clear, one decimetre below as caution', () => {
    const from = centreOf(0, 0);
    const to = centreOf(0, 9);
    // segmentShallowestBelow uses strict `depthM < thresholdM`.
    // byte 30 -> 3.0 m, not below 3.0. byte 29 -> 2.9 m, below.
    expect(
      checkHeadingDepth(maskWith([{ row: 0, col: 5, byte: 30 }]), [legTo(from, to)], 0, from, 3.0),
    ).toEqual({ state: 'clear' });
    expect(
      checkHeadingDepth(maskWith([{ row: 0, col: 5, byte: 29 }]), [legTo(from, to)], 0, from, 3.0),
    ).toEqual({ state: 'caution', shallowestM: 2.9 });
  });

  it('reports unavailable when there is no mask', () => {
    const from = centreOf(0, 0);
    const to = centreOf(0, 9);
    expect(checkHeadingDepth(null, [legTo(from, to)], 0, from, 3.0)).toEqual({
      state: 'unavailable',
    });
  });

  it('reports unavailable — never clear — when the fix is outside mask coverage', () => {
    const inside = centreOf(0, 9);
    const outside: LatLon = { lat: 53.5, lon: 8.5 };
    const result = checkHeadingDepth(maskWith([]), [legTo(outside, inside)], 0, outside, 3.0);
    expect(result).toEqual({ state: 'unavailable' });
  });

  it('reports unavailable when the waypoint is outside mask coverage', () => {
    const from = centreOf(0, 0);
    const outside: LatLon = { lat: 54.05, lon: 9.6 };
    const result = checkHeadingDepth(maskWith([]), [legTo(from, outside)], 0, from, 3.0);
    expect(result).toEqual({ state: 'unavailable' });
  });

  it('reports unavailable when the leg index does not exist', () => {
    const from = centreOf(0, 0);
    const to = centreOf(0, 9);
    expect(checkHeadingDepth(maskWith([]), [legTo(from, to)], 5, from, 3.0)).toEqual({
      state: 'unavailable',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix app run test -- src/lib/headingDepth.test.ts`
Expected: FAIL — cannot resolve `./headingDepth`.

- [ ] **Step 3: Write the implementation**

Create `app/src/lib/headingDepth.ts`:

```ts
// #251: the Live view's heading-to-steer is a great-circle bearing to the
// active waypoint, not a depth-validated course. This module answers whether
// that bearing crosses water shallower than the plan's safety depth, as a
// three-valued result so "we could not check" is never mistaken for "clear".
import type { LatLon, Leg, MaskMeta } from '../types';
import type { NavMask } from './mask';

export type HeadingDepthCheck =
  | { state: 'clear' }
  | { state: 'caution'; shallowestM: number }
  | { state: 'unavailable' };

// The mask is a lat/lon rectangle (MaskMeta west/south/east/north), so testing
// both endpoints is enough to know the whole segment stays inside coverage.
// Upper bounds are exclusive, matching NavMask.cellOf's row/col range check.
function withinMask(meta: MaskMeta, p: LatLon): boolean {
  return p.lat >= meta.south && p.lat < meta.north && p.lon >= meta.west && p.lon < meta.east;
}

/**
 * Whether the straight line from `p` to the active leg's end crosses water
 * charted below `safetyDepthM`.
 *
 * The coverage check is NOT redundant: NavMask.segmentShallowestBelow returns
 * null both when nothing is shallow AND when the walk leaves the grid, so it
 * cannot tell "clear" from "could not check". Testing the endpoints first is
 * what makes a subsequent null trustworthy as 'clear'.
 */
export function checkHeadingDepth(
  mask: NavMask | null,
  legs: Leg[],
  legIndex: number,
  p: LatLon,
  safetyDepthM: number,
): HeadingDepthCheck {
  if (!mask) return { state: 'unavailable' };
  const leg = legs[legIndex];
  if (!leg) return { state: 'unavailable' };
  if (!withinMask(mask.meta, p) || !withinMask(mask.meta, leg.end)) return { state: 'unavailable' };
  const shallowestM = mask.segmentShallowestBelow(p, leg.end, safetyDepthM);
  return shallowestM === null ? { state: 'clear' } : { state: 'caution', shallowestM };
}

/**
 * Identity of the mask cell containing `p`, for memoising the probe: a boat
 * that has not left its cell cannot have changed the answer. Returns a stable
 * string; points outside coverage collapse to a single 'out' key, which is
 * correct because they all yield 'unavailable'.
 */
export function maskCellKey(meta: MaskMeta, p: LatLon): string {
  if (!withinMask(meta, p)) return 'out';
  const row = Math.floor(((p.lat - meta.south) / (meta.north - meta.south)) * meta.rows);
  const col = Math.floor(((p.lon - meta.west) / (meta.east - meta.west)) * meta.cols);
  return `${row}:${col}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix app run test -- src/lib/headingDepth.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add the `maskCellKey` test and re-run**

Append to `app/src/lib/headingDepth.test.ts`:

```ts
describe('maskCellKey', () => {
  it('is stable within a cell and changes between cells', () => {
    const a = { lat: 54.0 + 0.001, lon: 9.0 + 0.001 };
    const b = { lat: 54.0 + 0.009, lon: 9.0 + 0.009 };
    const c = { lat: 54.0 + 0.011, lon: 9.0 + 0.001 };
    expect(maskCellKey(META, a)).toBe(maskCellKey(META, b));
    expect(maskCellKey(META, a)).not.toBe(maskCellKey(META, c));
    expect(maskCellKey(META, a)).toBe('0:0');
    expect(maskCellKey(META, c)).toBe('1:0');
  });

  it('collapses every out-of-coverage point to one key', () => {
    expect(maskCellKey(META, { lat: 53.0, lon: 8.0 })).toBe('out');
    expect(maskCellKey(META, { lat: 55.0, lon: 10.0 })).toBe('out');
  });
});
```

Add `maskCellKey` to the import at the top of the test file.
Run: `npm --prefix app run test -- src/lib/headingDepth.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/headingDepth.ts app/src/lib/headingDepth.test.ts
git commit -m "feat(live): add three-valued heading depth probe (#251)"
```

---

### Task 2: Asymmetric hysteresis reducer

**Files:**
- Modify: `app/src/lib/headingDepth.ts`
- Test: `app/src/lib/headingDepth.test.ts`

**Interfaces:**
- Consumes: `HeadingDepthCheck` from Task 1.
- Produces: `HEADING_DEPTH_CLEAR_MS`, `HeadingDepthHold`, `initialHold()`, `advanceHold(prev, raw, nowMs, clearMs?)` — used by Task 4.

Behaviour required by the spec: a caution engages on the first detecting observation; it clears only after `clear` has held for a cumulative 5 s; an `unavailable` observation neither advances nor resets that timer and leaves the caution displayed. Accumulating elapsed clear time (rather than storing a single start timestamp) is what makes the `unavailable` gap freeze the timer instead of silently counting toward it.

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/headingDepth.test.ts`:

```ts
describe('advanceHold', () => {
  const CAUTION = { state: 'caution', shallowestM: 2.0 } as const;
  const CLEAR = { state: 'clear' } as const;
  const UNAVAIL = { state: 'unavailable' } as const;

  it('engages a caution on the very first detecting observation', () => {
    const hold = advanceHold(initialHold(), CAUTION, 0);
    expect(hold.shown).toEqual(CAUTION);
  });

  it('keeps showing the caution through a single clear observation', () => {
    let hold = advanceHold(initialHold(), CAUTION, 0);
    hold = advanceHold(hold, CLEAR, 1000);
    expect(hold.shown).toEqual(CAUTION);
  });

  it('clears only once clear has held for the full window', () => {
    let hold = advanceHold(initialHold(), CAUTION, 0);
    hold = advanceHold(hold, CLEAR, 1000);
    hold = advanceHold(hold, CLEAR, 5900);
    expect(hold.shown).toEqual(CAUTION);
    hold = advanceHold(hold, CLEAR, 6000);
    expect(hold.shown).toEqual(CLEAR);
  });

  it('re-arms the caution when shallow water reappears mid-window', () => {
    let hold = advanceHold(initialHold(), CAUTION, 0);
    hold = advanceHold(hold, CLEAR, 1000);
    hold = advanceHold(hold, CAUTION, 2000);
    hold = advanceHold(hold, CLEAR, 3000);
    hold = advanceHold(hold, CLEAR, 7500);
    expect(hold.shown).toEqual(CAUTION);
  });

  it('freezes the timer across an unavailable gap instead of counting it', () => {
    let hold = advanceHold(initialHold(), CAUTION, 0);
    hold = advanceHold(hold, CLEAR, 1000);
    hold = advanceHold(hold, CLEAR, 3000); // 2000 ms accumulated
    hold = advanceHold(hold, UNAVAIL, 4000);
    expect(hold.shown).toEqual(CAUTION);
    hold = advanceHold(hold, CLEAR, 20000); // gap must not count
    expect(hold.shown).toEqual(CAUTION);
    hold = advanceHold(hold, CLEAR, 23100); // +3100 -> 5100 total
    expect(hold.shown).toEqual(CLEAR);
  });

  it('passes unavailable straight through when no caution is held', () => {
    const hold = advanceHold(initialHold(), UNAVAIL, 0);
    expect(hold.shown).toEqual(UNAVAIL);
  });
});
```

Add `advanceHold` and `initialHold` to the test file's import from `./headingDepth`. Do **not** import `HEADING_DEPTH_CLEAR_MS` — these tests rely on its default value rather than referencing it, so importing it would trip `@typescript-eslint/no-unused-vars`. (Corrected during execution; the original instruction listed it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix app run test -- src/lib/headingDepth.test.ts`
Expected: FAIL — `advanceHold` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `app/src/lib/headingDepth.ts`:

```ts
/**
 * How long the probe must read 'clear' before a displayed caution drops.
 * ~5 GPS fixes at the ~1 Hz fix rate. Deliberately asymmetric: a caution
 * appears instantly and leaves slowly, because a missed shallow warning costs
 * more than a redundant one.
 */
export const HEADING_DEPTH_CLEAR_MS = 5000;

export interface HeadingDepthHold {
  shown: HeadingDepthCheck;
  /** Cumulative time the probe has read 'clear' while a caution is displayed. */
  clearAccumMs: number;
  /** Timestamp of the previous 'clear' observation, or null if the run is broken. */
  lastClearMs: number | null;
}

export function initialHold(): HeadingDepthHold {
  return { shown: { state: 'unavailable' }, clearAccumMs: 0, lastClearMs: null };
}

/**
 * Fold one probe result into the displayed state.
 *
 * 'unavailable' is deliberately NOT treated as evidence the hazard is gone: it
 * holds the caution and breaks the accrual run without discarding the time
 * already banked, so an asset failure can never time out a warning.
 */
export function advanceHold(
  prev: HeadingDepthHold,
  raw: HeadingDepthCheck,
  nowMs: number,
  clearMs: number = HEADING_DEPTH_CLEAR_MS,
): HeadingDepthHold {
  if (raw.state === 'caution') return { shown: raw, clearAccumMs: 0, lastClearMs: null };
  if (prev.shown.state !== 'caution') return { shown: raw, clearAccumMs: 0, lastClearMs: null };
  if (raw.state === 'unavailable') return { ...prev, lastClearMs: null };
  const accum =
    prev.clearAccumMs + (prev.lastClearMs === null ? 0 : nowMs - prev.lastClearMs);
  if (accum >= clearMs) return { shown: raw, clearAccumMs: 0, lastClearMs: null };
  return { shown: prev.shown, clearAccumMs: accum, lastClearMs: nowMs };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix app run test -- src/lib/headingDepth.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/headingDepth.ts app/src/lib/headingDepth.test.ts
git commit -m "feat(live): asymmetric hysteresis for the heading depth caution (#251)"
```

---

### Task 3: `useNavMask` — main-thread mask acquisition

**Files:**
- Create: `app/src/state/useNavMask.ts`
- Test: `app/src/state/useNavMask.test.ts`

**Interfaces:**
- Consumes: `loadRoutingAssets()` from `app/src/services/assets.ts` (returns `Promise<RoutingAssets>` with `maskMeta: MaskMeta` and `maskBuffer: ArrayBuffer`); `NavMask` from `app/src/lib/mask.ts`.
- Produces: `useNavMask(): NavMask | null` — used by Task 4. `null` means "not ready or failed", which Task 1 maps to `unavailable`.

This mirrors how `RouteLayer` and `DepthProfile` already obtain the mask on the main thread. `loadRoutingAssets` is a fetch-once module-cached singleton that resets itself on rejection, so repeated mounts are cheap and a transient failure can retry.

- [ ] **Step 1: Write the failing test**

Create `app/src/state/useNavMask.test.ts`:

```ts
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavMask } from '../lib/mask';
import type { MaskMeta } from '../types';

const META: MaskMeta = { west: 9.0, south: 54.0, east: 9.1, north: 54.1, cols: 4, rows: 4 };

vi.mock('../services/assets', () => ({ loadRoutingAssets: vi.fn() }));
import { loadRoutingAssets } from '../services/assets';
import { useNavMask } from './useNavMask';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useNavMask', () => {
  it('starts null and resolves to a NavMask', async () => {
    vi.mocked(loadRoutingAssets).mockResolvedValue({
      maskMeta: META,
      maskBuffer: new Uint8Array(META.rows * META.cols).fill(255).buffer,
    } as never);

    const { result } = renderHook(() => useNavMask());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBeInstanceOf(NavMask));
  });

  it('stays null when the assets fail to load, and does not throw', async () => {
    vi.mocked(loadRoutingAssets).mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useNavMask());
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix app run test -- src/state/useNavMask.test.ts`
Expected: FAIL — cannot resolve `./useNavMask`.

- [ ] **Step 3: Write the implementation**

Create `app/src/state/useNavMask.ts`:

```ts
// #251: the Live view needs the depth mask on the MAIN thread to probe the
// heading-to-steer bearing. Same acquisition path RouteLayer and DepthProfile
// already use — loadRoutingAssets is a fetch-once module-cached singleton, so
// this adds no extra network work. The routing Web Worker is not involved.
import { useEffect, useState } from 'react';
import { NavMask } from '../lib/mask';
import { loadRoutingAssets } from '../services/assets';

export function useNavMask(): NavMask | null {
  const [mask, setMask] = useState<NavMask | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadRoutingAssets()
      .then((assets) => {
        if (cancelled) return;
        setMask(new NavMask(assets.maskMeta, new Uint8Array(assets.maskBuffer)));
      })
      .catch((err: unknown) => {
        // Stays null, which the caller renders as 'depth not checked'. Never
        // throws into the Live view: a missing mask must degrade to an honest
        // "could not check", never to a blank readout.
        console.warn('useNavMask: routing assets unavailable, depth check disabled', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return mask;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix app run test -- src/state/useNavMask.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/state/useNavMask.ts app/src/state/useNavMask.test.ts
git commit -m "feat(live): main-thread NavMask hook for the depth probe (#251)"
```

---

### Task 4: Wire into `LiveView`, with copy and styling

**Files:**
- Modify: `app/src/components/LiveView.tsx`
- Modify: `app/src/i18n/dict.en.ts`, `app/src/i18n/dict.de.ts`
- Modify: `app/src/app.css`
- Test: `app/src/components/LiveView.test.tsx`

**Interfaces:**
- Consumes: `checkHeadingDepth`, `maskCellKey`, `advanceHold`, `initialHold`, `HeadingDepthHold` (Tasks 1–2); `useNavMask` (Task 3).
- Produces: DOM classes `live-view-hts--caution` and `live-view-hts-note` (plus modifier `live-view-hts-note--muted`), consumed only by tests and CSS.

Safety depth comes from **`plan.request.settings.safetyDepthM`** — the depth the plan was actually computed with — not from current app settings. This matches the standing rule that a saved route renders against what it was computed from. `LiveView` does not currently read settings at all; it already has `plan` via `useActivePlan()`.

- [ ] **Step 1: Add the i18n keys**

In `app/src/i18n/dict.en.ts`, immediately after the `'live.eta.label'` entry:

```ts
  // #251: the heading-to-steer is a bearing to the active waypoint, not a
  // depth-validated course. Never claims the course is safe.
  'live.hts.depthCaution': 'Bearing crosses {depth} m — shallower than your safety depth ({safety} m)',
  'live.hts.depthUnchecked': 'Depth not checked',
```

In `app/src/i18n/dict.de.ts`, at the matching position after `'live.eta.label'`:

```ts
  // #251: der Steuerkurs ist eine Peilung zum aktiven Wegpunkt, kein
  // tiefengeprüfter Kurs. Behauptet nie, der Kurs sei sicher.
  'live.hts.depthCaution':
    'Peilung kreuzt {depth} m — flacher als deine Sicherheitstiefe ({safety} m)',
  'live.hts.depthUnchecked': 'Tiefe nicht geprüft',
```

- [ ] **Step 2: Add the CSS tokens and rules**

In `app/src/app.css`, in the light `:root` token block next to `--sc-banner-warning-fg` (around line 16):

```css
  --sc-depth-warning-fg: #e69f00;
  --sc-depth-warning-bg: rgba(230, 159, 0, 0.16);
```

In the dark block next to `--sc-banner-warning-fg` (around line 36):

```css
    --sc-depth-warning-fg: #e69f00;
    --sc-depth-warning-bg: rgba(230, 159, 0, 0.22);
```

Replace the hardcoded values in the existing `.shallow-warning` rule so both depth warnings share one source of truth:

```css
/* #53: prominent shallow-water warning on the route summary (both rig tabs).
   Safety-depth warning color family (#E69F00) — matches the map casing and
   the depth profile emphasis. #251 moved the family into --sc-depth-warning-*
   so the Live view's heading caution uses the same one. */
.shallow-warning {
  margin: 0;
  padding: 0.6rem 0.75rem;
  border-left: 4px solid var(--sc-depth-warning-fg);
  border-radius: 4px;
  background: var(--sc-depth-warning-bg);
  font-weight: 500;
}
```

Append the new Live view rules at the end of the Live view section of `app/src/app.css`:

```css
/* #251: heading-to-steer depth check. Colour is never the only signal — the
   note text carries the meaning, and there is deliberately no aria-live
   region here (the readout updates at ~1 Hz, so announcing every fix would be
   hostile). */
.live-view-hts--caution .live-view-hts-value {
  color: var(--sc-depth-warning-fg);
}

.live-view-hts-note {
  margin: 0.15rem 0 0;
  font-size: 0.85em;
  color: var(--sc-depth-warning-fg);
}

.live-view-hts-note--muted {
  color: var(--sc-muted);
  font-weight: 400;
}
```

If `--sc-muted` does not exist, use the nearest existing muted-text token in `app.css` rather than inventing one — check the token block before writing this rule.

- [ ] **Step 3: Write the failing RTL tests**

Append inside the existing `describe('LiveView', ...)` block in `app/src/components/LiveView.test.tsx`:

```ts
  it('shows the depth caution with the measured depth when the bearing crosses shallow water', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(2.1);
    renderLive(wp, TEST_PLAN);

    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
    act(() => {
      emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
    });

    await screen.findByText(/Bearing crosses 2\.1 m/);
    expect(screen.getByText(/shallower than your safety depth \(3 m\)/)).toBeInTheDocument();
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it('shows no depth note when the bearing is clear', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(null);
    renderLive(wp, TEST_PLAN);

    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
    act(() => {
      emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
    });

    await screen.findByText(formatHeading(headingToSteerDeg(LEGS, 0, FIX_POINT)));
    expect(screen.queryByText(/Bearing crosses/)).not.toBeInTheDocument();
    expect(screen.queryByText('Depth not checked')).not.toBeInTheDocument();
  });

  it('shows "Depth not checked" while the mask is unavailable', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    // No mask resolves in this test environment, so the probe is unavailable.
    renderLive(wp, TEST_PLAN);

    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
    act(() => {
      emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
    });

    await screen.findByText('Depth not checked');
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });
```

Add to the test file's imports:

```ts
import * as NavMaskModule from '../lib/mask';
```

The third test relies on `loadRoutingAssets` failing or never resolving under jsdom (no `fetch` of real assets). If it resolves in this environment, mock `../services/assets` at the top of the file the same way `./BoatMarker` is mocked, and have `loadRoutingAssets` reject.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm --prefix app run test -- src/components/LiveView.test.tsx`
Expected: FAIL — the caution text and the "Depth not checked" note do not render.

- [ ] **Step 5: Wire it into `LiveView`**

Add to the imports in `app/src/components/LiveView.tsx`:

```ts
import { useMemo, useRef } from 'react';
import {
  advanceHold,
  checkHeadingDepth,
  initialHold,
  maskCellKey,
  type HeadingDepthHold,
} from '../lib/headingDepth';
import { useNavMask } from '../state/useNavMask';
```

Merge `useMemo` and `useRef` into the existing `react` import rather than adding a second one.

After the existing `const hts = ...` line, add:

```ts
  const mask = useNavMask();
  const safetyDepthM = plan?.request.settings.safetyDepthM ?? null;

  // Memoised on everything that can change the answer. legIndex alone does not
  // identify a waypoint: a reroute can keep the index while moving
  // legs[legIndex].end, so plan.id and rig are part of the key.
  const rawDepthCheck = useMemo(() => {
    if (!fix || legIdx === null || safetyDepthM === null) return null;
    return checkHeadingDepth(mask, legs, legIdx, fix.point, safetyDepthM);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cell key stands in for fix.point: a boat that has not left its mask cell cannot change the result
  }, [
    mask,
    legs,
    legIdx,
    safetyDepthM,
    plan?.id,
    rig,
    mask && fix ? maskCellKey(mask.meta, fix.point) : null,
  ]);

  // Asymmetric hysteresis: engages instantly, drops only after a sustained
  // clear run. Reset when the plan or rig changes, so a caution from a
  // superseded route cannot survive a reroute (#158 convention).
  const holdRef = useRef<{ hold: HeadingDepthHold; key: string }>({
    hold: initialHold(),
    key: '',
  });
  const holdKey = `${plan?.id ?? ''}:${rig ?? ''}`;
  if (holdRef.current.key !== holdKey) {
    holdRef.current = { hold: initialHold(), key: holdKey };
  }
  if (rawDepthCheck) {
    holdRef.current.hold = advanceHold(holdRef.current.hold, rawDepthCheck, fixAtMs ?? 0);
  }
  const depthCheck = rawDepthCheck ? holdRef.current.hold.shown : null;
```

Replace the `.live-view-hts` JSX block with:

```tsx
          <div
            className={
              depthCheck?.state === 'caution'
                ? 'live-view-hts live-view-hts--caution'
                : 'live-view-hts'
            }
          >
            <span className="live-view-label">{t('live.hts.label')}</span>
            <span className="live-view-hts-value">{formatHeading(steerable.hts)}</span>
          </div>
          {depthCheck?.state === 'caution' && safetyDepthM !== null && (
            <p className="live-view-hts-note">
              {t('live.hts.depthCaution', {
                depth: depthCheck.shallowestM.toFixed(1),
                safety: String(safetyDepthM),
              })}
            </p>
          )}
          {depthCheck?.state === 'unavailable' && (
            <p className="live-view-hts-note live-view-hts-note--muted">
              {t('live.hts.depthUnchecked')}
            </p>
          )}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix app run test -- src/components/LiveView.test.tsx`
Expected: PASS, including the three new tests and every pre-existing one.

- [ ] **Step 7: Commit**

```bash
git add app/src/components/LiveView.tsx app/src/components/LiveView.test.tsx app/src/i18n/dict.en.ts app/src/i18n/dict.de.ts app/src/app.css
git commit -m "feat(live): surface heading-to-steer depth state in the readout (#251)"
```

---

### Task 5: Changelog and full verification

**Files:**
- Modify: `CHANGELOG.md`

This is a solo PR, so it may carry its own atomic `[Unreleased]` entry (the conflict rule only applies when 2+ PRs are in flight).

- [ ] **Step 1: Add the changelog entry**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md` (create the `### Added` subsection if absent):

```markdown
- Live view: the heading-to-steer readout now shows when the bearing to the active waypoint crosses water shallower than the plan's safety depth, and shows "Depth not checked" when the depth data is unavailable. The heading is a bearing to the waypoint, not a depth-validated course (#251).
```

- [ ] **Step 2: Run the full gate**

```bash
npm --prefix app run lint
npm --prefix app run typecheck
npm --prefix app run test
```
Expected: all pass. The unit suite takes ~4 min; allow a generous timeout.

If any pre-existing test expectation would have to CHANGE to pass, STOP and report which one and why — do not adjust it. An expectation rewritten to match new behaviour proves nothing.

- [ ] **Step 3: Confirm the e2e assertion is still valid by construction**

```bash
grep -n 'role="alert"' app/src/components/LiveView.tsx
```
Expected: no matches. Do not run the e2e suite for this change; nothing in `app/e2e/` was modified.

- [ ] **Step 4: Commit and push**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): live heading depth honesty (#251)"
git push
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --repo DocGerd/sail_command --base develop \
  --title "feat(live): heading-to-steer depth honesty (#251)" \
  --body-file <path to a body file>
```
The body must include `Closes #251`. Then self-review per the project's PR rules: one inline review thread per finding, fix all findings, resolve every thread.

---

## Self-Review

**Spec coverage.** §2 three states → Tasks 1 and 4. §3.1 module, signature, and the out-of-coverage requirement → Task 1 (the coverage pre-check is the substantive finding; `segmentShallowestBelow` conflates clear with out-of-grid). §3.2 hysteresis incl. `unavailable`-does-not-clear, the state-not-waypoint rule, and the `[plan.id, rig]` reset → Task 2 plus the `holdRef` reset in Task 4. §3.3 mask acquisition and memoisation → Tasks 3 and 4. §3.4 rendering, no live region, 0.1 m rounding, token refactor → Task 4. §3.5 i18n → Task 4. §4 error handling → Task 3's catch and Task 1's guards. §5 testing → Tasks 1, 2, 3, 4. §7 changelog → Task 5.

**Deviation from the spec, recorded deliberately.** §3.2 says the held caution displays "the last measured `shallowestM`". `advanceHold` achieves this by keeping the whole previous `shown` object, which carries that value — no separate field needed.

**Known soft spots for the implementer.**
- Task 4 Step 2 assumes a `--sc-muted` token; verify against `app.css` and substitute the real muted-text token if the name differs.
- Task 4 Step 3's third test assumes `loadRoutingAssets` does not resolve under jsdom. A fallback (mock the module) is written into the step.
- The `useMemo` dependency array intentionally includes a computed cell key and carries an eslint-disable with a stated reason. If the project's lint config rejects that, hoist the cell key into a `const` above the memo and depend on that instead.

**Type consistency.** `HeadingDepthCheck`, `HeadingDepthHold`, `checkHeadingDepth`, `maskCellKey`, `advanceHold`, `initialHold`, `HEADING_DEPTH_CLEAR_MS`, `useNavMask` are named identically everywhere they appear. `safetyDepthM` matches `Settings.safetyDepthM` (`types.ts:12`). `segmentShallowestBelow(a, b, thresholdM): number | null` matches `mask.ts:166`. `maskMeta` / `maskBuffer` match `RoutingAssets` (`assets.ts:5-6`).
