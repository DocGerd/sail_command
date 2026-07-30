# Motor decision rule: a sailing preference margin (#254)

Status: approved (user, 2026-07-30)
Amends: `2026-07-14-sail-command-design.md` §Engine (L30), §Motor fallback (L119–120), §#46a motor semantics (L220–225)
Issue: #254

## 1. Problem

`app/src/routing/isochrone.ts:297` decides each candidate heading's leg kind from
sailing speed alone:

```ts
if (sailSpeed >= settings.motorThresholdKn) { kind = 'sail'; speed = sailSpeed; }
else if (settings.motorEnabled)             { kind = 'motor'; speed = settings.motorSpeedKn; }
```

`settings.motorSpeedKn` never appears in the decision. So a heading is locked to
sail whenever `sailSpeed >= 2.5`, **even when motoring at 6.5 kn would be nearly
three times faster**.

At TWS 3.6 the Salona 45 polar peaks at 3.82 kn (genoa) / 3.65 kn (fock), so
motoring is faster on every heading — yet the 2.5 kn threshold splits the compass
into motorable `000–094° ∪ 185–265°` and sail-locked `095–184° ∪ 266–355°`. The
Flensburg → Marstal destination bearing (~92°) sits on that edge and all the
southing the route needs to round Als lies inside the locked hole. The solver
therefore alternates 90° (easternmost motorable) with 190° (nearest motorable
heading that makes south), producing the reported zigzag under engine.

This is a **cost bug, not a search bug**. The straight path is generated and
survives pruning; the solver's own edge pricing rejects it. Diagnosis and the
disproof of three competing hypotheses are recorded in issue #254's comments.

## 2. Decision

Motoring becomes available wherever it is **meaningfully** faster than sailing,
where "meaningfully" is a user-set margin in knots.

This is a deliberate change of product position. The design spec currently states
the engine is a fallback triggered by `sailSpeed < threshold` alone. It is now a
term in the time optimisation, bounded by a sailing preference. The consequence
accepted with it: **in marginal wind the planner will start the engine when that
is faster.** See §8.

## 3. The rule

One substitution at the first branch of `isochrone.ts:297`. All other branches —
the motor-disabled fallback, `MIN_SAIL_KN`, and calm detection — are unchanged.

```ts
const sailFloorKn = settings.motorEnabled
  ? Math.max(settings.motorThresholdKn, settings.motorSpeedKn - settings.sailPreferenceKn)
  : settings.motorThresholdKn;

if (sailSpeed >= sailFloorKn)        { kind = 'sail';  speed = sailSpeed; }
else if (settings.motorEnabled)      { kind = 'motor'; speed = settings.motorSpeedKn; }
else if (sailSpeed >= MIN_SAIL_KN)   { kind = 'sail';  speed = sailSpeed; }
else { sawCalm = true; continue; }
```

At defaults this yields `max(2.5, 6.5 − 2.8) = 3.7` kn.

### 3.1 Why the margin form, and why `motorThresholdKn` survives

Because `motorSpeedKn` is heading-independent, every candidate formulation —
absolute margin, ratio margin, bare `max()` — reduces to a single **sail-speed
floor**. There is one knob, not a family of them; the existing rule is already
that shape with the floor at `motorThresholdKn`.

The margin's meaning is exact: under `motor iff sailSpeed < motorSpeed − margin`,
any heading left sail-locked satisfies `sailSpeed >= motorSpeed − margin`. **The
margin is therefore a hard upper bound on how much boat speed a sail-locked
heading can be losing.** Only `margin = 0` is fully hole-free; larger margins
trade guaranteed hole-freedom for preserved sailing.

`motorThresholdKn` is retained as the seaworthiness floor ("barely moving, start
the engine") and is what makes a small engine safe. `motorSpeedKn` is
user-editable (1–10 kn). Without the `Math.max`, a user setting `motorSpeedKn:
3.0` against a fixed floor would be handed motor legs **slower than sailing**.
With it, `max(2.5, 3.0 − 2.8) = max(2.5, 0.2) = 2.5` and the guard binds.

### 3.2 Rejected alternative: a per-TWS blanket rule

Considered and rejected: "if `motorSpeed > maxSailSpeed(TWS) + margin`, make the
whole compass motorable; otherwise keep today's threshold." It appeared to fix
#254 while preserving TWS 6 entirely.

Rejected on two grounds. First, it is **discontinuous in TWS**: at the critical
wind speed the motorable set jumps from 360/360 to ~51/360 in one step, and a
real forecast crosses that boundary spatially and hourly. It replaces a
heading-space hole with a wind-space cliff — the same failure class as #254,
with a larger discontinuity. Second, it does not preserve TWS 6 so much as
preserve **today's 309-heading hole** there, which measures clean on this route
only because the destination bearing happens to miss it. That is precisely the
bet #254 already lost. The floor rule, by contrast, is continuous in TWS:
headings enter and leave the motorable set one at a time.

## 4. The setting

New key in `Settings` (`app/src/types.ts`) and `DEFAULT_SETTINGS`:

```ts
sailPreferenceKn: number; // default 2.8
```

**Migration: none required.** `app/src/state/AppState.tsx:88` merges
`{ ...DEFAULT_SETTINGS, ...persisted, ...pending }`, and `app/src/state/reroute.ts:105`
does the same for a saved plan's settings. A key *absent* from an old IndexedDB
record is backfilled from defaults, so a new key reaches every existing install
automatically. This is the path `depthComfortMarginM` took in #243, already
pinned by `app/src/state/reroute.test.ts:135`.

The converse is why this fix **must** be a new key: there is no `settingsVersion`
and no upgrade function anywhere. A *changed default* for an existing key
(e.g. raising `motorThresholdKn`) is overridden by the stored value and would
never reach anyone who had opened Options or saved a plan — including the person
who reported #254.

**Disabling value.** `sailPreferenceKn >= motorSpeedKn − motorThresholdKn`
(4.0 at defaults) collapses the floor to `motorThresholdKn` and reproduces
pre-change behaviour byte-for-byte. This is the `depthComfortMarginM: 0` escape
hatch inverted — here *higher means sail more*. Note it **moves with
`motorSpeedKn`**; help copy must not name a fixed number.

## 5. UI and i18n

Follows the `depthComfortMarginM` precedent (`OptionsPanel.tsx:49-55`, `:96-112`):
its own `NumberInput` (min 0, max 10, step 0.1) rendered ahead of
`ADVANCED_FIELDS`, with an `aria-describedby` help paragraph. Max is 10 so the
disabling value stays reachable at any `motorSpeedKn`.

Keys in **both** dicts under `satisfies Record<MsgKey, string>`:

- `options.sailPreference.label` — en "Sail preference (kn)" / de "Segelvorzug (kn)"
- `options.sailPreference.help` — en: "How much boat speed the planner will give
  up to keep sailing. It keeps sailing while sailing speed is within this many
  knots of motor speed; higher means more sailing and later arrivals. Raise it to
  motor speed minus the motor threshold to motor only as a fallback, as before."

## 6. Documentation amended

Each of these currently states the rule the change replaces, and must be amended
rather than left to contradict the code:

- `docs/superpowers/specs/2026-07-14-sail-command-design.md` L30, L119–120, L220–225
- `CLAUDE.md` — the "Motor legs are first-class" domain bullet, including removal
  of the KNOWN DEFECT paragraph for #254
- `CHANGELOG.md` — `[Unreleased]`, user-visible behaviour change
- Issue #254 closed with a link to this spec and the evidence paths in §9

The "sail XOR motor" model is unchanged: this spec does **not** introduce
motorsailing (still #46 scope b).

## 7. Tests

`app/src/routing/motor.test.ts:45-51` currently asserts a marginal-wind passage
stays entirely under sail. That expectation is what this change gives up, so the
test is **rewritten, not re-baselined**, and renamed off "motor threshold
respected".

Per #252 it must assert on **values, not a boolean**. The existing assertion
`expect(r.legs.every((l) => l.kind === 'sail')).toBe(true)` fails with
`expected false to be true` and prints no leg data at all — the diagnostic
numbers in §9.4 exist only because a separate probe was run alongside.

New coverage:

1. Marginal wind (TWS 6): assert the **leg kinds per index and the sail speed at
   each leg's TWA**, not a predicate. Do **not** pin the new duration (2.6973 h)
   as a literal — it is this implementation's own output, and copying it makes the
   test tautological. Pin instead: (a) the kind sequence motor/sail/motor,
   (b) that leg 1 sails because its sail speed exceeds the floor, both values
   hand-derived from the test polar, and (c) that the duration is strictly less
   than the all-sail baseline, whose value is derived from the polar and the
   rhumb-line distance independently of the solver.
2. Disabling value: `sailPreferenceKn = motorSpeedKn − motorThresholdKn`
   reproduces pre-change legs exactly.
3. Small-engine guard binds: `motorSpeedKn: 3.0` yields floor 2.5, and no emitted
   motor leg is slower than sailing on the same heading.
4. Settings backfill: a stored settings object without `sailPreferenceKn` loads
   with the default (mirrors `reroute.test.ts:135`).

Per the repo's mutation-check rule, pinned literals are hand-derived from the
polar and the rule, never copied from the new implementation's own output.

Acceptance gates, both already green at floor 3.7 (§9.4):
`app/src/routing/realmask.repro.test.ts` and the `planRoute` suite.

## 8. Accepted limitations

Stated here deliberately, so they are not discovered later as defects.

1. **The floor has a knife-edge, wherever it is put.** Measured: a leg sailing at
   **3.699 kn** motors against a 3.700 floor. Inherent to any hard threshold;
   accepted rather than softened, because softening it reintroduces the pricing
   ambiguity the rule exists to remove.
2. **All measurement used uniform wind fields.** The rule's behaviour across a
   TWS *gradient* is untested and argued only from its continuity in TWS (§3.2).
   This is the main evidential gap in this spec.
3. **TWS 12 in band is bracketed, not measured** — 0% motor at floors 3.5 and 4.5,
   so 3.7 is expected to leave it under sail, but no cell was run at 3.7/TWS 12.
4. **Moderate air moves to engine.** At a synthetic uniform TWS 6, floor 3.7 gives
   83.0% motor and arrives 4.4 h earlier than today's all-sail route. Every floor
   that closes #254 does this; the onset lies below the whole admissible band.
   The synthetic row overstates it — the real reported forecast split 27.2 nm sail
   / 20.4 nm motor — and the margin is user-adjustable.
5. **Rig recommendation ties are silent.** `planRoute.ts:183` breaks ties with
   `genoa.etaMs <= fock.etaMs`, so an exact tie always badges genoa, and there is
   no near-tie copy (`route.recommended` is a bare "Recommended"/"Empfohlen").
   A higher floor makes both rigs near-all-motor in light air, converging their
   ETAs and making the badge arbitrary exactly when it means least — measured
   vacuous ties at TWS 3.6 floors ≥ 4.5 and TWS 6 floor 6.5, and a 2.5-second
   knife-edge at floor 3.8. **Disclosed, not fixed here**; follow-up issue to be
   filed.

## 9. Evidence

Headless runs against the real committed mask and polars, Flensburg
`54.798, 9.4335` → Marstal `54.8579, 10.528`, departure 2026-07-31T10:00Z,
`DEFAULT_SETTINGS` otherwise, uniform wind direction 225°. Both rigs measured.

### 9.1 Patch faithfulness

`isochrone.ts:297` is the only kind decision and its first conjunct has no extra
terms; only `settings.motorThresholdKn` was replaced, read at the use site (not
constant-folded — verified in the bundle). `motorEnabled` and `MIN_SAIL_KN = 0.2`
untouched. **Anchor: floor 2.5 reproduces the unpatched build's legs
byte-identically**, and reproduces the pre-existing arm-B measurement
(7.2800 h / 46.934 nm / Σ 877.1° / max 100°) exactly. This anchor is what makes
the table below attributable to the change and nothing else.

### 9.2 Why 3.7

The admissible window is **[3.7, 3.8]** — the only floors that close the weave at
TWS 3.6 *and* leave TWS 9 fully under sail, on **both** rigs.

| floor | TWS 3.6 reversals | TWS 9 motor % | note |
|---|---|---|---|
| 2.5 (today) | **5** (genoa), max turn 100° | 0% | the reported bug |
| 3.5 | 2, max turn **135°** | 0% | worse turns than today; saves 32 min |
| 3.6 | 1 (genoa), max 135° | 0% | not closed |
| **3.7** | **0, both rigs**, max 60° | **0%** | **chosen** |
| 3.8 | 0, but genoa max **83°** | 0% | rig ETA gap 2.5 s — flips on noise |
| 3.85 | 0 | fock 29.1% | TWS 9 lost |
| 3.9–4.3 | 0 | 28–48% | TWS 9 lost |
| 4.5 | 0 | 53.1% | TWS 9 lost; TWS 6 94.7% |

At floor 3.7: TWS 3.6 → 6.6914 h (fock, recommended) / 6.7541 h (genoa),
0 reversals both rigs, max motor→motor turn 60° — a monotonically unwinding
dogleg round Als, not a weave. TWS 9 → 8.3741 h genoa / 8.5207 h fock, **zero
motor legs**. TWS 6 → 7.2426 h at 83.0% motor.

For reference, at floors ≥ 3.9 the TWS 3.6 route settles at 43.435 nm ≈ **1.005×**
the 43.229 nm string-pulled navigable minimum.

### 9.3 Measurement caveats that the metrics cannot self-report

- The briefed closure criterion (max turn ≤ 45°) is **unreachable at TWS 3.6**: a
  genuine ~60° dogleg round Als survives at every floor. The discriminating
  measure is the **reversal count** — consecutive motor→motor turns of opposite
  sign, both ≥ 45°, i.e. the literal 190/90 signature.
- The reversal count can **structurally fail to fire**: at TWS 9 floor 3.9 (fock)
  there is exactly one motor→motor pair, so its 0 is not evidence of cleanliness —
  and that single turn is 155°.
- "Max motor→motor turn" is **undefined**, not zero, for a route with fewer than
  two consecutive motor legs. Measured at TWS 9 floor 3.85 (fock): 8 motor legs,
  zero consecutive pairs. Three states — value, not-applicable, failed — are kept
  distinct throughout; collapsing not-applicable to 0° would have scored all-sail
  cells as perfect closure.
- A weave-ratio metric was rejected at TWS 3.6: its denominator is
  origin→destination displacement, which crosses land in a fjord.
- An earlier "motor legs appear once ~110/360 headings fall below the floor"
  correlation **did not survive finer resolution** (TWS 9 has motor legs at 58/360)
  and is recorded here only as disproven.

### 9.4 Test outcomes at floor 3.7

`motor.test.ts` 1 failed / 2 passed; `realmask.repro.test.ts` 11/11;
`planRoute` 21/21. Independently reproduced in a second clean worktree.

The single failure is `L45-51`, and **its stated premise did not break**. On the
direct heading (TWA −90) the test polar still gives 4.297 kn, still above 3.7, and
the solver still sails it. What changes is the route shape:

```
floor=3.7        legs=3  duration=2.6973 h
  leg 0: motor heading  55.0  sailSpeedAtThisTWA=3.600  legSpeed=6.500
  leg 1: sail  heading  95.0  sailSpeedAtThisTWA=4.250  legSpeed=4.250
  leg 2: motor heading 129.0  sailSpeedAtThisTWA=3.699  legSpeed=6.500
floor=2.5        legs=1  duration=3.2243 h
  leg 0: sail  heading  89.8  sailSpeedAtThisTWA=4.297  legSpeed=4.299
```

The unstated assumption in that test was **"the fastest route is the all-sail
one"**, and floor 3.7 makes it false — the motor–sail–motor dogleg arrives 31.6
minutes earlier. Leg 2 is also the §8.1 knife-edge in the wild.

### 9.5 Sanity guard

Across the main grid (492 motor legs, 40 rig-cells) and the refinement grid
(823 motor legs, 54 rig-cells): **zero cases** of an emitted motor leg being
slower than sailing on the same heading, checked on post-merge headings. Tightest
observed case in the main grid: 6.442 kn sailing versus 6.5 kn motoring — a bare
`max()` would trade that leg for engine to gain 0.9%, which is the quantified case
for a margin.

### 9.6 Artifacts

Session scratch (not committed; cite before relying, they are not durable):

```
/tmp/claude-1000/-home-pkuhn-sail-command/7a969da0-a5e1-4546-874c-14d8cc0fd1e9/scratchpad/sweep254/
  isochrone-floor.diff          the measured patch
  METHOD.md                     method, three-state discipline, faithfulness argument
  out/RESULTS.txt out/CLOSURE.txt out/HEADINGS.txt out/polarref.json out/sanity.json
  out/grid/f<floor>_t<tws>.json         main grid, 20 cells
  refine/BAND_BOTH_RIGS.txt refine/CLOSURE.txt refine/sanity.json
  refine/grid/f<floor>_t<tws>.json      refinement, 27 cells
  tests/{motor_3.7.log,realmask_3.7.log,planRoute_3.7.log,probe_3.7.txt,probe_default.txt}
```

## 10. Out of scope

- Motorsailing (sail + engine simultaneously) — remains #46 scope b.
- Angle-based maneuver penalties on motor legs. Measured as **not** the cause of
  #254: no penalty can create a heading in the locked sector at 6.5 kn. Motor
  turns being uncharged is real and separate; it is not fixed here.
- Widening the collinear merge (`MAX_MERGE_DEG = 10`) — rejected as fabricating
  geometry the solver never validated.
- Redesigning the rig recommendation (§8.5) — disclosed, follow-up issue.
- Resolving the TWS 6 motor onset, which lies in (2.5, 3.5), below the admissible
  band and therefore not decision-relevant.
