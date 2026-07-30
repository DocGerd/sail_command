# Motor Decision Rule (#254) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the isochrone router motor wherever motoring is meaningfully faster than sailing, bounded by a new user-set sailing preference margin, so light-air routes stop zigzagging under engine.

**Architecture:** One new `Settings` key, `sailPreferenceKn`, feeds a single computed sail-speed floor that replaces the bare `motorThresholdKn` comparison at the first branch of the leg-kind decision in `isochrone.ts`. No other solver branch changes. `motorThresholdKn` is retained underneath a `Math.max` as the seaworthiness floor, which is what keeps a user-lowered `motorSpeedKn` from producing motor legs slower than sailing.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`), React, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-30-motor-decision-rule-design.md` — read §3, §4, §7 before starting.

## Global Constraints

- Default value is exactly `sailPreferenceKn: 2.8`. At default `motorSpeedKn: 6.5` this yields a floor of `3.7`.
- The disabling value is `sailPreferenceKn >= motorSpeedKn - motorThresholdKn` (4.0 at defaults) and must restore pre-change behaviour exactly. It moves with `motorSpeedKn`; never hardcode 4.0 in copy or logic.
- TypeScript `strict` + `exactOptionalPropertyTypes` are ON. `erasableSyntaxOnly` forbids enums and constructor parameter properties.
- Every i18n key must be added to **both** `app/src/i18n/dict.en.ts` and `app/src/i18n/dict.de.ts` — they enforce parity via `satisfies Record<MsgKey, string>` and the build fails otherwise.
- Tests import vitest APIs explicitly: `import { describe, expect, it, vi } from 'vitest'`.
- **Never copy a literal from the new implementation's output.** Every pinned number must be hand-derived from `TEST_POLAR` and the rule. See the derivation table below — use it, do not recompute from a test run.
- CI runs lint + typecheck BEFORE tests. Run `npm --prefix app run typecheck` and `lint` before every commit.
- Do not add `Signed-off-by` trailers.

### Hand-derived reference: `TEST_POLAR` boat speed at TWS 6, `performanceFactor` 1.0

`TEST_POLAR.tws = [4, 8, ...]`, so TWS 6 is the midpoint of the 4 and 8 columns — every value below is the plain average of those two columns, then linearly interpolated across TWA.

| TWA | tws 4 | tws 8 | **speed @ TWS 6** | vs floor 3.7 |
|---|---|---|---|---|
| 40 | 2.0 | 4.0 | **3.0** | motor |
| 55 | — | — | **3.6** (interp 40→60) | motor |
| 60 | 2.6 | 5.0 | **3.8** | sail |
| 90 | 3.0 | 5.6 | **4.3** | sail |
| 120 | 2.8 | 5.2 | **4.0** | sail |
| 150 | 2.0 | 4.0 | **3.0** | motor |
| 180 | 1.6 | 3.2 | **2.4** | motor |

TWA 129 evaluates to **3.700** — exactly the floor, and floating point puts it fractionally under. **Never pin a TWA near 129**; it is a boundary case, not a behaviour.

Route fixture `A = {54.75, 10.0}` → `B = {54.75, 10.4}` is due east; `uniformWindGrid(6, 0)` blows from north, so the direct heading is TWA 90 → **4.3 kn**, above the floor. The direct heading still sails after this change. What changes is that off-axis headings (TWA 40–55, 3.0–3.6 kn) may now motor at 6.5 kn, letting the solver take a faster dogleg.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `app/src/types.ts` | `Settings.sailPreferenceKn` + `DEFAULT_SETTINGS` value | 1 |
| `app/src/state/reroute.test.ts` | pins that an old saved plan backfills the new key | 1 |
| `app/src/routing/isochrone.ts` | the floor computation and the kind decision | 2 |
| `app/src/routing/motor.test.ts` | the rule's behaviour, incl. the rewritten marginal-wind test | 2 |
| `app/src/components/OptionsPanel.tsx` | the numeric field + help paragraph | 3 |
| `app/src/i18n/dict.en.ts`, `dict.de.ts` | label + help copy, both languages | 3 |
| `docs/.../2026-07-14-sail-command-design.md`, `CLAUDE.md`, `CHANGELOG.md` | doc surfaces that currently state the old rule | 4 |

---

### Task 1: The setting and its migration path

**Files:**
- Modify: `app/src/types.ts` (the `Settings` interface and `DEFAULT_SETTINGS`)
- Test: `app/src/state/reroute.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Settings.sailPreferenceKn: number`, `DEFAULT_SETTINGS.sailPreferenceKn === 2.8`. Tasks 2 and 3 both depend on this key existing.

- [ ] **Step 1: Write the failing test**

Add to `app/src/state/reroute.test.ts`, directly after the existing `depthComfortMarginM` backfill test (currently ending near line 150). It mirrors that test's shape deliberately — same mechanism, new key.

```ts
  // #254: same mechanism as the depthComfortMarginM case above. A plan saved
  // before sailPreferenceKn existed has the field absent from its snapshot;
  // without the DEFAULT_SETTINGS backfill, rerouteFromFix would carry
  // `undefined` into a required `number` and the floor computation in
  // isochrone.ts would evaluate to NaN, silently disabling every motor leg.
  it('backfills sailPreferenceKn from DEFAULT_SETTINGS on a pre-#254-shaped saved plan', async () => {
    const oldShapedSettings = { ...DEFAULT_SETTINGS } as Partial<typeof DEFAULT_SETTINGS>;
    delete oldShapedSettings.sailPreferenceKn;
    const plan = makePlan({
      request: {
        ...makePlan().request,
        settings: oldShapedSettings as typeof DEFAULT_SETTINGS,
      },
    });
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });

    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.settings.sailPreferenceKn).toBe(DEFAULT_SETTINGS.sailPreferenceKn);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix app run test -- reroute.test.ts`
Expected: FAIL — TypeScript will not compile `delete oldShapedSettings.sailPreferenceKn` because the key does not exist on `Settings`.

- [ ] **Step 3: Add the key**

In `app/src/types.ts`, insert into the `Settings` interface immediately after the `motorThresholdKn` line, keeping the existing doc-comment style:

```ts
  motorThresholdKn: number; // default 2.5
  // #254 sailing preference: the solver motors a candidate heading whenever
  // sailing it would be more than this many knots slower than motoring, i.e.
  // the effective sail-speed floor is
  //   max(motorThresholdKn, motorSpeedKn - sailPreferenceKn).
  // The margin is therefore a hard upper bound on how much boat speed a
  // sail-locked heading can be losing. motorThresholdKn survives underneath as
  // the seaworthiness floor, which is what stops a user-lowered motorSpeedKn
  // from producing motor legs SLOWER than sailing. At or above
  // motorSpeedKn - motorThresholdKn (4.0 at defaults) the floor collapses back
  // to motorThresholdKn, taking the byte-identical pre-#254 path.
  sailPreferenceKn: number; // default 2.8
```

And into `DEFAULT_SETTINGS`, after `motorThresholdKn: 2.5,`:

```ts
  sailPreferenceKn: 2.8,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix app run test -- reroute.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Typecheck and lint**

Run: `npm --prefix app run typecheck && npm --prefix app run lint`
Expected: clean. If any other file fails to compile because `Settings` gained a required key, fix those call sites — they are constructing a `Settings` literal and must supply the new field (prefer spreading `DEFAULT_SETTINGS`).

- [ ] **Step 6: Commit**

```bash
git add app/src/types.ts app/src/state/reroute.test.ts
git commit -m "feat: add sailPreferenceKn setting with default 2.8

Refs #254."
```

---

### Task 2: The floor rule in the solver

**Files:**
- Modify: `app/src/routing/isochrone.ts` (the kind decision inside the candidate loop, currently at :292-309)
- Test: `app/src/routing/motor.test.ts`

**Interfaces:**
- Consumes: `settings.sailPreferenceKn` from Task 1.
- Produces: no new exported symbol. The observable contract is the leg-kind decision.

- [ ] **Step 1: Rewrite the marginal-wind test to assert values, not a boolean**

In `app/src/routing/motor.test.ts`, **replace the whole third `it(...)` block** (currently `'motor threshold respected: marginal wind sails when above threshold'`). The old test asserted `legs.every(l => l.kind === 'sail')`, which fails with `expected false to be true` and prints no leg data at all — the #252 trap. Every assertion below names a real value.

```ts
  // #254: at TWS 6 the DIRECT heading (TWA 90) makes 4.3 kn in TEST_POLAR,
  // still above the 3.7 kn floor, so it still sails. What the floor changes is
  // that off-axis headings (TWA 40-55 -> 3.0-3.6 kn, hand-derived from
  // TEST_POLAR's tws 4/8 columns) may now motor at 6.5 kn, so the solver can
  // take a faster dogleg than the all-sail rhumb line.
  it('marginal wind: off-axis headings may motor when that is faster', () => {
    const r = solve({ ...base, wind: new WindField(uniformWindGrid(6, 0)) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    // Assert the kind SEQUENCE, so a failure prints both arrays.
    expect(r.legs.map((l) => l.kind)).toContain('motor');

    // Every motor leg must be one the rule actually permits: its sailing speed
    // at that leg's own TWA must be below the floor. Mapping to objects keeps
    // the offending leg visible in the failure message.
    const floorKn = DEFAULT_SETTINGS.motorSpeedKn - DEFAULT_SETTINGS.sailPreferenceKn;
    const offenders = r.legs
      .filter((l) => l.kind === 'motor')
      .map((l) => ({ heading: l.headingDeg, speed: l.speedKn }))
      .filter((l) => l.speed !== DEFAULT_SETTINGS.motorSpeedKn);
    expect(offenders).toEqual([]);
    expect(floorKn).toBeCloseTo(3.7, 10);

    // And it must be FASTER than the all-sail baseline, which is hand-derived:
    // TWA 90 at TWS 6 is the mean of TEST_POLAR's tws-4 (3.0) and tws-8 (5.6)
    // values = 4.3 kn over the rhumb line. Never pin the solver's own output.
    const hours = (r.etaMs - dep) / 3_600_000;
    const allSailHours = haversineNm(A, B) / 4.3;
    expect(hours).toBeLessThan(allSailHours);
  });
```

- [ ] **Step 2: Add the disabling-value test**

Append inside the same `describe` block. This is the escape hatch from §4 of the spec.

```ts
  // #254: at or above motorSpeedKn - motorThresholdKn the floor collapses to
  // motorThresholdKn and the solve takes the byte-identical pre-#254 path.
  it('sailPreferenceKn at the disabling value restores pre-#254 routing', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      sailPreferenceKn: DEFAULT_SETTINGS.motorSpeedKn - DEFAULT_SETTINGS.motorThresholdKn,
    };
    const r = solve({ ...base, settings, wind: new WindField(uniformWindGrid(6, 0)) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    expect(r.legs.map((l) => l.kind)).toEqual(['sail']);
    // 4.3 kn hand-derived: TEST_POLAR TWA 90, mean of the tws-4 and tws-8 columns.
    const hours = (r.etaMs - dep) / 3_600_000;
    expect(hours).toBeCloseTo(haversineNm(A, B) / 4.3, 1);
  });
```

- [ ] **Step 3: Add the small-engine guard test**

```ts
  // #254: motorThresholdKn survives as the seaworthiness floor. With a small
  // engine, motorSpeedKn - sailPreferenceKn = 3.0 - 2.8 = 0.2, well below the
  // 2.5 threshold, so Math.max must clamp the floor to 2.5. Without the clamp
  // the floor would be 0.2 and nothing would ever motor; worse, a floor above
  // motorSpeedKn would hand out motor legs SLOWER than sailing.
  it('small engine: the floor never drops below motorThresholdKn', () => {
    const settings = { ...DEFAULT_SETTINGS, motorSpeedKn: 3.0 };
    const r = solve({ ...base, settings, wind: new WindField(uniformWindGrid(6, 0)) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    // At TWS 6 the direct heading sails at 4.3 kn, faster than this 3.0 kn
    // engine, so the route is all sail -- exactly as before #254.
    expect(r.legs.map((l) => l.kind)).toEqual(['sail']);

    // And no emitted motor leg anywhere may be slower than sailing would be.
    const slowerThanSailing = r.legs
      .filter((l) => l.kind === 'motor')
      .map((l) => ({ heading: l.headingDeg, motorSpeed: l.speedKn }));
    expect(slowerThanSailing).toEqual([]);
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm --prefix app run test -- motor.test.ts`
Expected: the marginal-wind test FAILS (no motor leg is produced yet — the array will not contain `'motor'`). The disabling-value and small-engine tests should already PASS, because today's behaviour is what they describe; if either fails now, stop and investigate before touching the solver.

- [ ] **Step 5: Implement the floor**

In `app/src/routing/isochrone.ts`, inside the `for (const twa of twas)` loop, replace only the first branch's condition. Compute the floor **once per solve**, not per candidate — hoist it above the frontier loop, next to the other `settings` reads.

Hoisted, near the top of `solve()` where `settings` is first available:

```ts
  // #254: the sail-speed floor. A heading motors when sailing it would be more
  // than settings.sailPreferenceKn slower than motoring. motorThresholdKn is the
  // seaworthiness floor underneath, so a small engine can never be handed legs
  // slower than sailing. When motoring is disabled the floor is the bare
  // threshold and the branch below falls through to the MIN_SAIL_KN path.
  const sailFloorKn = settings.motorEnabled
    ? Math.max(settings.motorThresholdKn, settings.motorSpeedKn - settings.sailPreferenceKn)
    : settings.motorThresholdKn;
```

Then the decision becomes — **only the first condition changes**:

```ts
        if (sailSpeed >= sailFloorKn) {
          kind = 'sail';
          speed = sailSpeed;
        } else if (settings.motorEnabled) {
          kind = 'motor';
          speed = settings.motorSpeedKn;
        } else if (sailSpeed >= MIN_SAIL_KN) {
          kind = 'sail';
          speed = sailSpeed;
        } else {
          sawCalm = true;
          continue;
        }
```

Do not touch `boardForCandidate`, the maneuver penalty block, `distNm`, or the direct-arrival test below it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix app run test -- motor.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 7: Run the acceptance gates**

Run: `npm --prefix app run test -- realmask.repro.test.ts` — expected 11/11 PASS.
Run: `npm --prefix app run test -- planRoute` — expected 21/21 PASS across 3 files.
These exercise the real committed mask and polars and were both measured green at floor 3.7. A failure here is a real regression, not a baseline to update.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npm --prefix app run typecheck && npm --prefix app run lint
git add app/src/routing/isochrone.ts app/src/routing/motor.test.ts
git commit -m "fix: motor a heading when motoring is meaningfully faster

Refs #254."
```

---

### Task 3: Options UI and i18n

**Files:**
- Modify: `app/src/components/OptionsPanel.tsx`
- Modify: `app/src/i18n/dict.en.ts`, `app/src/i18n/dict.de.ts`

**Interfaces:**
- Consumes: `Settings.sailPreferenceKn` (Task 1), the existing `FieldSpec` interface and `commitSetting` helper.
- Produces: message keys `options.sailPreference.label` and `options.sailPreference.help`.

- [ ] **Step 1: Add both dictionary entries**

`app/src/i18n/dict.en.ts`, after the `options.motorThreshold.label` line:

```ts
  'options.sailPreference.label': 'Sail preference (kn)',
  'options.sailPreference.help':
    'How much boat speed the planner will give up to keep sailing. It keeps sailing while sailing speed is within this many knots of motoring speed, and motors otherwise — so a higher value means more sailing and later arrivals. Raise it to motoring speed minus the motor threshold to motor only as a fallback.',
```

`app/src/i18n/dict.de.ts`, in the matching position:

```ts
  'options.sailPreference.label': 'Segelvorzug (kn)',
  'options.sailPreference.help':
    'Wie viel Fahrt die Planung aufgibt, um weiter zu segeln. Sie segelt weiter, solange die Segelfahrt höchstens um diesen Wert unter der Motorfahrtgeschwindigkeit liegt, und motort sonst — ein höherer Wert bedeutet also mehr Segeln und spätere Ankunft. Auf Motorfahrtgeschwindigkeit minus Motor-Schwellenwert gesetzt, wird nur noch im Rückfall motort.',
```

Note both help strings deliberately describe the disabling value as a formula, never as the number 4.0 — it moves with `motorSpeedKn`.

- [ ] **Step 2: Update the motorEnabled help, which now states the old rule**

Its current text says motoring happens "where predicted sailing speed drops below the threshold", which this change makes wrong. Replace in `dict.en.ts`:

```ts
  'options.motorEnabled.help':
    'Allow engine legs: the planner motors where sailing would be slower than motoring by more than the sail preference, and always below the motor threshold. Motor legs run at motoring speed and are marked as motor.',
```

And in `dict.de.ts`:

```ts
  'options.motorEnabled.help':
    'Motorabschnitte erlauben: Die Planung motort, wo Segeln um mehr als den Segelvorzug langsamer wäre als Motorfahrt, und immer unterhalb des Motor-Schwellenwerts. Motorabschnitte laufen mit Motorfahrtgeschwindigkeit und werden als Motor gekennzeichnet.',
```

- [ ] **Step 3: Add the field spec**

In `app/src/components/OptionsPanel.tsx`, after `DEPTH_COMFORT_MARGIN_FIELD`:

```ts
// #254: sailing preference margin. Rendered with its own help paragraph like
// DEPTH_COMFORT_MARGIN_FIELD above, because the behaviour it controls is not
// guessable from the label. max 10 so the disabling value stays reachable at
// any motorSpeedKn (which itself maxes at 10).
// eslint-disable-next-line react-refresh/only-export-components
export const SAIL_PREFERENCE_FIELD: FieldSpec = {
  key: 'sailPreferenceKn',
  labelKey: 'options.sailPreference.label',
  min: 0,
  max: 10,
  step: 0.1,
};
```

- [ ] **Step 4: Render it**

Insert immediately after the depth-comfort help paragraph (`<p className="options-help" id="options-depthComfortMarginM-help">…</p>`) and before `{ADVANCED_FIELDS.map(…)}`:

```tsx
      <div className="options-field">
        <label htmlFor={`options-${SAIL_PREFERENCE_FIELD.key}`}>
          {t(SAIL_PREFERENCE_FIELD.labelKey)}
        </label>
        <NumberInput
          id={`options-${SAIL_PREFERENCE_FIELD.key}`}
          value={value[SAIL_PREFERENCE_FIELD.key]}
          min={SAIL_PREFERENCE_FIELD.min}
          max={SAIL_PREFERENCE_FIELD.max}
          step={SAIL_PREFERENCE_FIELD.step}
          aria-describedby="options-sailPreferenceKn-help"
          onCommit={(n) => commitSetting(value, SAIL_PREFERENCE_FIELD.key, n, onChange)}
        />
      </div>
      <p className="options-help" id="options-sailPreferenceKn-help">
        {t('options.sailPreference.help')}
      </p>
```

- [ ] **Step 5: Verify**

Run: `npm --prefix app run typecheck && npm --prefix app run lint`
Expected: clean. A missing key in either dictionary fails typecheck via the `satisfies Record<MsgKey, string>` parity check — that is the intended gate.

Run: `npm --prefix app run test -- OptionsPanel`
Expected: PASS. If an existing test asserts the number of rendered numeric inputs or snapshots the panel, update it to include the new field.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/OptionsPanel.tsx app/src/i18n/dict.en.ts app/src/i18n/dict.de.ts
git commit -m "feat: surface the sail preference margin in Options

Refs #254."
```

---

### Task 4: Documentation surfaces

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-sail-command-design.md` (L30, L119-120, L220-225)
- Modify: `CLAUDE.md` (the "Motor legs are first-class" domain bullet)
- Modify: `CHANGELOG.md` (`[Unreleased]`)

**Interfaces:** none — prose only.

**Note:** spec edits under `docs/superpowers/specs/` go through the main session using Edit/Write, never a subagent and never a Bash append (`cat >>` bypasses the ask-gate hook).

- [ ] **Step 1: Amend the design spec's three motor passages**

L30 — the Engine table row. Replace the parenthetical `router may plan engine legs when sailing speed < threshold (default 2.5 kn), clearly marked` with:

```
router may plan engine legs where sailing would be slower than motoring by more
than the sail preference margin (default 2.8 kn), and always below the motor
threshold (default 2.5 kn), clearly marked
```

L119-120 — the **Motor fallback** bullet. Replace `where best sailing VMG toward candidate directions yields boat speed < threshold, add motor edges at motor speed, flagged` with:

```
**Motor edges**: for each candidate direction, add a motor edge at motor speed
where the sailing speed falls below the sail-speed floor
`max(motorThresholdKn, motorSpeedKn - sailPreferenceKn)`, flagged. Amended by
`2026-07-30-motor-decision-rule-design.md` (#254); the original threshold-only
rule left headings sail-locked where motoring was strictly faster.
```

L220-225 — the #46a motor semantics passage. Amend only the trigger clause `motor only where predicted sailing speed < threshold` to `motor only where predicted sailing speed falls below the sail-speed floor`. **Leave the "sail XOR motor / no motorsailing claims" sentences exactly as they are** — this change does not introduce motorsailing.

- [ ] **Step 2: Update the CLAUDE.md domain bullet**

Replace the `**Motor legs are first-class**` bullet, including deleting its whole `KNOWN DEFECT (#254, open)` paragraph, with:

```markdown
- **Motor legs are first-class**: planned where sailing speed falls below the
  sail-speed floor `max(motorThresholdKn, motorSpeedKn - sailPreferenceKn)`
  (defaults 2.5 / 6.5 / 2.8 → floor 3.7 kn), run at motor speed, and always
  flagged as motor. The margin is a hard upper bound on how much boat speed a
  sail-locked heading can be losing; `motorThresholdKn` survives underneath so a
  user-lowered `motorSpeedKn` can never yield motor legs slower than sailing, and
  a margin at or above `motorSpeedKn - motorThresholdKn` restores the pre-#254
  path byte-for-byte. 3.7 is measured, not chosen: it is the only floor that
  closes the light-air weave on BOTH rigs while leaving TWS 9 entirely under sail
  (window [3.7, 3.8]; 3.8 rejected on a 2.5 s rig-recommendation knife-edge).
  Accepted cost: marginal air moves to engine — a synthetic uniform TWS 6 goes
  from all-sail to 83% motor. All of that was measured on UNIFORM wind fields;
  TWS-gradient behaviour is untested and argued only from the rule's continuity
  in TWS. See `docs/superpowers/specs/2026-07-30-motor-decision-rule-design.md`.
```

- [ ] **Step 3: Add the CHANGELOG entry**

Under `## [Unreleased]`, in a `### Changed` section (create it if absent):

```markdown
- The planner now uses the engine wherever motoring would be meaningfully faster
  than sailing, instead of only when sailing speed fell below the motor
  threshold. A new **Sail preference** setting (default 2.8 kn) controls how much
  boat speed the planner will give up to keep sailing; raising it to motoring
  speed minus the motor threshold restores the previous behaviour. This removes
  the light-air zigzag where routes wove under engine as if beating to windward.
```

- [ ] **Step 4: Verify no stale statement of the old rule remains**

Run: `grep -rn "below the threshold\|< threshold\|sailing speed < " CLAUDE.md docs/superpowers/specs/2026-07-14-sail-command-design.md README.md`
Expected: no hit that describes the motor trigger. Hits about other thresholds (safety depth, calm) are fine.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CHANGELOG.md docs/superpowers/specs/2026-07-14-sail-command-design.md
git commit -m "docs: amend the motor trigger rule across spec, CLAUDE.md and changelog

Refs #254."
```

---

## Self-Review

**Spec coverage:** §3 rule → Task 2. §3.1 margin form and the `Math.max` guard → Task 2 step 5, pinned by Task 2 step 3. §3.2 rejected alternative → documentation only, no task needed. §4 setting and migration → Task 1. §5 UI/i18n → Task 3. §6 doc surfaces → Task 4. §7 tests → Tasks 1 and 2 (all four listed tests present: marginal wind, disabling value, small-engine guard, settings backfill). §8 limitations → recorded in the spec and CLAUDE.md, no code. §9 evidence → no task.

**Placeholder scan:** no TBD/TODO; every code step carries real code; no "similar to Task N".

**Type consistency:** `sailPreferenceKn` spelled identically in Tasks 1, 2, 3. `SAIL_PREFERENCE_FIELD` used only in Task 3, matching the existing `FieldSpec` interface (`key`/`labelKey`/`min`/`max`/`step`). `sailFloorKn` is local to `solve()` and exported nowhere. Message keys `options.sailPreference.label`/`.help` match between dictionary and component.

**One gap accepted deliberately:** no test pins the §8.1 knife-edge (a 3.699 kn leg motoring against a 3.700 floor). Pinning a floating-point boundary would be a brittle test of arithmetic rather than of behaviour; it is documented in the spec instead.
