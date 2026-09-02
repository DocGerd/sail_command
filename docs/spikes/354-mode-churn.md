# Spike #354 — motor<->sail mode churn: a mode change costs the solver nothing

- **Issue:** #354 "Routing: motor<->sail mode changes cost nothing, so
  narrow-water plans churn motor -> short sail -> motor" — open, milestone
  **Backlog**, type: bug / priority: medium / area: routing.
- **Date:** 2026-09-02
- **Status:** Decision / Recommendation
- **Ruling (maintainer, 2026-09-02): "spike doc + defer."** #354 moves to
  Backlog and **no solver change ships this cycle**.
- **Verdict:** **The churn is real, it is not #264, and none of the seven
  candidate fixes is recommended at the one constant this repo owns.** The
  reproduction the 2026-08-25 ruling demanded as "first deliverable" is
  discharged: at `84b049a2` two of six routes (four of twelve rig rows) carry a
  motor -> sail -> motor sandwich with a 75-225 s sail run, while the #264
  motor-tacking archetype carries zero mode changes on either rig. Every
  candidate either leaves the worst route's churn intact while costing 2.4-5.0
  min (A) or makes the reproducing route worse (C), removes churn by deleting the sailing and breaks a documented
  #254 invariant (G), is inert at the mandated 45 s (D, E), or has no input
  data (F). B is the only direction worth a second increment, and its result is
  not yet interpretable (§4.2). The open question is a product judgement, not a
  measurement (§5).

> Companions: [`244-buoyed-fairways.md`](./244-buoyed-fairways.md) (forecloses
> candidate F) and the motor decision rule spec
> `docs/superpowers/specs/2026-07-30-motor-decision-rule-design.md` §8.6 (the
> heading-weave ruling this spike must not be confused with). Reproduction
> artefacts live beside this file under
> [`354-mode-churn/`](./354-mode-churn/) — the driver, its BASE output, and one
> `git diff` per rejected candidate (§8).

---

## 0. Provenance — where every figure below comes from

- **Measurement base: `origin/develop @ 84b049a2`.** Every baseline and
  candidate row was measured there. `develop` had advanced to `b7bfc0c8` by the
  time this document was written; **nothing was re-measured at that tip and no
  number here may be attributed to it.**
- **Instrument:** `354-mode-churn/scratch354.test.ts`, sha256
  `13487727fa7db42420b8fbae7a8ace658f1ec1f67bcde75718bb5a60125a350f`, run
  **byte-identically** (verified by `diff`/`cmp` in each report) in the BASE
  worktree and in all seven candidate worktrees. It plans six curated routes
  for both rigs through `planRoute()` only, against the real committed
  `app/public/data/mask.bin` + `mask.meta.json` and the real committed polar
  tables, Salona 45 (`DEFAULT_BOAT_ID`), `DEFAULT_SETTINGS`, departure
  `T0 = Date.UTC(2026, 6, 15, 6, 0, 0)` (the sweep's own), wind from
  `uniformWindGrid(twsKn, wdirDeg)`. Fingerprints are sha256 over the sweep's
  **own** exported `serialize(legs)` (`app/sweep/sweepArms.ts`), so they are
  directly comparable with existing #282 arm artefacts. Its BASE output is
  committed under `354-mode-churn/base-output/`.
- **Controls carried by every run:** a double-run control (run 1 vs run 2,
  every leg-array and whole-`PlanResult` fingerprint byte-identical, 0
  mismatches) and a positive control (`sailPreferenceKn` +2.0 kn on R1:
  `anyDiffered=true`, `revertMatches=true`). Every candidate report records
  the double-run control as byte-identical; every report except E's also
  restates the positive control as passed (E's states only the double-run).
- **Candidate implementations** existed only as uncommitted edits in scratch
  worktrees (branches `scratch/354-*`, merge-base `84b049a2`); each one's
  `git diff` is committed under `354-mode-churn/candidates/` (§8.3).
- **Every candidate figure is the implementing agent's own self-report.** No
  adversarial refutation pass was commissioned on any of the seven evaluations
  (§4.4). Several reports refute their own candidate, which is evidence of
  honest reporting, not a substitute for a refuter.
- **Numbers are per route / wind cell.** Nothing in this document is averaged
  across cells; a figure without a route and cell beside it is a transcription
  error.
- The decision brief that carried this material to the maintainer and the
  per-agent journal it was assembled from are session artefacts in
  `<scratchpad>`, not committed; where this document says "brief §n" or
  "report: candidate X" it names them, and the committed driver + diffs are
  what makes each figure re-derivable without them.

---

## 1. RECOMMENDATION

1. **Defer.** No solver change this cycle; #354 stays open in Backlog. This is
   the maintainer's ruling ("spike doc + defer", 2026-09-02) and the measured
   position coincides with it: at the only non-arbitrary constant this repo
   owns (45 s, the shipped `maneuverPenaltyS` default) no candidate removes the
   churn on the worst route without paying a cost the maintainer has already
   rejected once for headings (#264, §8.6).
2. **Treat the reproduction as discharged, and do not close #354 as a #264
   relitigation.** §3.4 settles the discriminator: the #264 weave motors on
   both sides of a sail-locked arc and carries no mode change; the #354 churn
   is motor -> sail -> motor and is charged nothing.
3. **If it is ever picked up again, take B (mode penalty on the ranking clock
   only, as a module constant), and only behind the gates in §6.3.** B is the
   only candidate that removed every motor-sandwiched short sail run on every
   row while leaving reported geometry and ETA honest, but it ran without a
   penalty-0 inertness control and it moved two all-motor rows it could not
   have charged, so its ETA deltas are a mixture of intended effect and search
   perturbation.
4. **Never carry 45 s forward as "the obvious constant."** It sits below the 75 s
   shortest mode run this battery produced (§4.3) — `dtS/8` at the 600 s
   ring — which is why three of the seven candidates could not bind on these
   routes.
5. **Do not let the declined directions return as fresh ideas** — §9 records
   each with the measurement that rejected it.

---

## 2. The question, the mechanism, and the rulings that constrain it

### 2.1 What #354 asks

In narrow waters the plan alternates motor -> short sail -> motor. In a
confined fairway sailing is only worth doing if the fairway can be held
**without tacking**; a brief sail segment sandwiched between motor legs is not
something a skipper would actually sail. The reporter asks for dampening —
hysteresis, or a minimum segment length.

### 2.2 The mechanism, re-verified at `84b049a2`

Read from `app/src/routing/isochrone.ts` (720 lines at that commit; anchor on
the symbols, the line numbers are hints that decay):

- A tack/gybe is charged at `:450-452` — `if (kind === 'sail' && node.kind ===
  'sail' && node.board && board !== node.board)` then `effS = Math.max(dtS -
  settings.maneuverPenaltyS, 0)`. That is the **only** transition-aware site
  in the solver: `grep -n "node.kind"` returns exactly one hit, `:450`.
- Mode is decided at `:431-445` by the classification cascade (`sailSpeed >=
  sailFloorKn` -> sail, else `motorEnabled` -> motor, else `sailSpeed >=
  MIN_SAIL_KN` -> sail, else calm). A sail<->motor candidate never enters the
  `:450` branch and keeps `effS = dtS` from `:449`. **A mode change costs
  zero.**
- `sailFloorKn` (`:321`) is resolved once per solve and is the only per-solve
  mode state that exists.
- No minimum segment length exists anywhere: **both** merge passes are
  same-kind-only — `postprocess.ts:18` (`a.kind !== b.kind || a.board !==
  b.board || b.maneuverAtStart !== null`) and `isochrone.ts:680` inside
  `backtrack`. Corollary the driver relies on: **the mode-change count is
  invariant under merging**, so counting it on the final leg list measures the
  solver, not the postprocessor (the driver records whether pre- and post-merge
  counts are equal on every row; they were, 12/12).
- Any penalty added at `:452` needs its mirror at `:529` (`subEffS`, the
  substep twin) or it silently vanishes on every substepped — i.e. every
  narrow-water — edge; `:468` (`penaltyS = dtS - effS`) is derived from `effS`
  and charges automatically.
- The penalty at `:452` is **geometric**: `:454 distNm = (speed * effS) / 3600`
  and `:455 if (distNm <= 0) continue`. It shortens the step; it does not
  merely re-price it. This is what gives candidate A its ceiling (§4.3).

### 2.3 A correction to the issue body, load-bearing for candidate selection

The issue says hysteresis "is not expressible where the decision currently
lives: there is nothing for a hysteresis band to read or write." **That is only
half true.** `node` is in scope at `:431`, `node.kind` is already read at
`:450`, and `pruneKey(lat, lon, kind, board)` (`:243-246`) already partitions
each prune cell three ways (`'M'`/`'P'`/`'S'`), so the search already keeps
separate motor and per-board incumbents per cell. A one-step hysteresis band
and a mode-change penalty are both expressible with zero new `Node` state and
zero prune-key change — candidate G confirmed this by building one in +38/-1
lines. What is genuinely not expressible today is a duration- or length-based
minimum segment (candidate C): that needs a new `Node` field plus a decision
about `pruneKey` (`:243`) or `visitedDominates` (`:269-271`).

### 2.4 Maintainer rulings on the issue

| Date | Ruling |
|---|---|
| 2026-08-25 | Owes a full #282 nine-arm sweep — `isochrone.ts`'s cost function is squarely inside the sweep's transitive input closure, and any accepted fix moves `PlanResult` bytes: REQUIRED BASE double-run control plus a BASE-vs-HEAD comparison, "roughly three arm-sets at ~31 min each". Not fix-ready: no reproducing case had ever been run and none of the four candidate directions had been chosen. "Committing sweep time before the fix direction exists spends the expensive thing first." **First deliverable when picked up: a reproducing case, before any solver edit.** |
| 2026-08-26 | "XL and highest-risk in this batch — `isochrone.ts` and `postprocess.ts` are both inside `app/sweep`'s documented #282 transitive input closure." |
| 2026-08-31 | "Sweep owed, traced rather than assumed. `isochrone.ts`'s `effS` feeds `distNm`, which sets leg boundaries and timings, which are `PlanResult` fields. A mode-change cost therefore moves plans by construction." Correction for whoever picks this up: **`app/src/routing/planRoute.reasonDecoupling.test.ts` belongs on this issue's guard list** — a real source-scanning guard a token-scoped grep missed during triage. |
| **2026-09-02** | **"Spike doc + defer."** (given in the maintainer's session, not recorded as an issue comment; this PR is its record) #354 to Backlog; no solver change this cycle. This document is the spike. |

Sweep operational rulings, the first two repeated on the issue twice: never run a full sweep
as a harness background task (one was observed killed at ~58 min); detach with
`setsid` + `nohup` and report `SC_SWEEP_OUT` **at detach, not on completion**;
check `compare.mjs`'s A-side outcome distribution before treating byte-identity
as evidence (`becalmed` and `deep-becalmed` are vacuous at 33/33 errors each).

### 2.5 Standing constraints that bind every candidate

- A motor-turn penalty and a heading-continuity tie-break were both evaluated
  for #264 and found counter-productive; #354 must not assume it inherits a
  different outcome **without measuring** (motor spec §8.6).
- `better()` cannot arbitrate between candidates that land in different prune
  cells — cells are ~223 x 192 m while a motor step is ~2006 m. A fix that
  assumes the cost function will simply pick the better option may never see
  both options.
- Measure a proposed fix's ETA **against a navigable alternative, not a
  straight chord** (#264's 32.9% "detour" was measured against a chord that
  crossed land).
- Regression bar: `app/src/routing/realmask.repro.test.ts` must stay green.
- Standing repo rule (CLAUDE.md + motor spec §8.6): **"the only allowed
  post-processing is merging near-collinear legs with re-validation."** This
  forecloses candidate D unless the maintainer lifts it explicitly; the ruling
  did not.

---

## 3. Reproduction at `84b049a2`

### 3.1 The six routes and their wind cells

One uniform wind field per route, both rigs, 12 rows. Route ids are the
driver's own.

| Route | Origin -> destination | Wind cell (TWS kn / wdir deg) | Why it was chosen |
|---|---|---|---|
| R6-control | Flensburg -> Gelting-Mole | 12 / 225 | Control: the `breeze` arm's own wind field, every heading clears the 3.7 kn floor by a wide margin, so the correct output is all-sail with zero mode changes. A non-zero count here invalidates every other row. |
| R1-primary-churn | Flensburg -> Sønderborg | 4 / 62 | The archetypal light-air beat, dead upwind; designed as the primary churn probe. |
| R2-confined-beat | Flensburg -> Glücksburg | 4.5 / 50 | Short confined inner-fjord beat; exercises the origin-pocket substep retry. |
| R3-narrow-fairway | Svendborg -> Troense | 5 / 140 | Svendborgsund, the narrowest fairway in the set; the closest geometric match to "a fairway that cannot be held without tacking". |
| R4-downwind-knife-edge | Ærøskøbing -> Søby | 5.5 / 120 | Dead run; the fan crosses the floor within ~10 deg of each board. Ærøskøbing's committed `approachNote` is a buoyed channel through flats. |
| R5-beam-reach-shoals | Fåborg -> Avernakø | 4.5 / 260 | Geometry-vs-wind control: on the rhumb line this should sail throughout, so any mode change is the mask forcing a course change. |

### 3.2 BASE table

| Route | Wind cell | Sail | status | legs | modeChanges | mode runs (legs) | mmJoints | msmTriples | shortSailRuns | rev>=45 | motor % (time) | ETA min | legs fingerprint |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R6-control | 12 / 225 | genoa | ok | 18 | **0** | `S(18)` | 0 | 0 | 0 | 2 | 0.0 | 195.1 | `d2c7b5fb5f875c1e` |
| R6-control | 12 / 225 | fock | ok | 16 | **0** | `S(16)` | 0 | 0 | 0 | 1 | 0.0 | 196.3 | `bd835eed77519786` |
| R1-primary-churn | 4 / 62 | genoa | ok | 19 | **0** | `M(19)` | 5 | 0 | 0 | 5 | 100.0 | 183.6 | `1ba60da557b0805a` |
| R1-primary-churn | 4 / 62 | fock | ok | 19 | **0** | `M(19)` | 6 | 0 | 0 | 6 | 100.0 | 183.3 | `80c7ba403a1c1490` |
| R2-confined-beat | 4.5 / 50 | genoa | ok | 4 | **0** | `M(4)` | 0 | 0 | 0 | 0 | 100.0 | 38.7 | `19bc20a65773d486` |
| R2-confined-beat | 4.5 / 50 | fock | ok | 4 | **0** | `M(4)` | 0 | 0 | 0 | 0 | 100.0 | 38.7 | `19bc20a65773d486` |
| **R3-narrow-fairway** | **5 / 140** | genoa | ok | 12 | **3** | `S(3) M(1) S(1) M(7)` | 2 | 1 | 1 | 3 | 70.8 | 21.4 | `9e8e043b29479fec` |
| **R3-narrow-fairway** | **5 / 140** | fock | ok | 11 | **3** | `S(3) M(1) S(1) M(6)` | 0 | 1 | 1 | 2 | 70.0 | 20.8 | `09475b452cb0e8c5` |
| **R4-downwind-knife-edge** | **5.5 / 120** | genoa | ok | 13 | **3** | `S(1) M(1) S(2) M(9)` | 2 | 0 | 1 | 4 | 92.6 | 67.6 | `5172f1736b02e94b` |
| **R4-downwind-knife-edge** | **5.5 / 120** | fock | ok | 15 | **3** | `S(1) M(1) S(3) M(10)` | 2 | 0 | 1 | 5 | 90.9 | 68.4 | `41c8a98ff5371d8c` |
| R5-beam-reach-shoals | 4.5 / 260 | genoa | ok | 7 | **0** | `M(7)` | 4 | 0 | 0 | 4 | 100.0 | 34.2 | `a8093ed20e61794a` |
| R5-beam-reach-shoals | 4.5 / 260 | fock | ok | 7 | **0** | `M(7)` | 4 | 0 | 0 | 4 | 100.0 | 33.9 | `92934aa96f0a9fc2` |

Column definitions are the driver's (`354-mode-churn/scratch354.test.ts`):
`mmJoints` = consecutive motor->motor joints with |Δheading| >= 45 deg (the
#264 signature); `msmTriples` = consecutive **leg** triples motor, sail, motor
(a one-leg sail run); `shortSailRuns` = maximal sail runs under 300 s bounded
by motor on both sides. 12/12 rows `status: ok`; `shallow` absent on every
plan (no #53 relaxation fired); `mergeCallConfounded` false on every row;
`chordNavigable` **false on all six routes**.

### 3.3 The four churning rows, as durations

Mode-run strings by **duration** on the shipped, post-merge leg lists at
`84b049a2` (report: candidate E's reachability probe, reproduced in the brief
§2.3):

| Row | Wind cell | mode runs (duration per run) |
|---|---|---|
| R3-narrow-fairway genoa | 5 / 140 | `S:300s M:75s S:75s M:835s` |
| R3-narrow-fairway fock | 5 / 140 | `S:300s M:75s S:75s M:800s` |
| R4-downwind-knife-edge genoa | 5.5 / 120 | `S:150s M:75s S:150s M:3681s` |
| R4-downwind-knife-edge fock | 5.5 / 120 | `S:150s M:75s S:225s M:3652s` |

Every one of the four contains a motor -> sail -> motor sandwich with the sail
run at 75 s, 75 s, 150 s and 225 s respectively — the "brief sail segment a
skipper would not actually sail" the report describes. The shortest mode run
anywhere in the battery is **75 s**, on every churning row; that number recurs
in §4.3.

### 3.4 The discriminator — #354 is not #264

#264/#254 are about **heading** weave: motor-tacking around a sail-locked arc,
measured faster (98-527 s per joint) and correctly priced. Its joints are
motor->motor on both sides of the arc and carry **no mode change at all**. #354
is about **mode** churn, a motor->sail->motor triple. The two are separable in
one column:

- **R1-primary-churn (Flensburg -> Sønderborg, TWS 4 / wdir 62), the #264
  archetype, is 100% motor with ZERO mode-change joints on both rigs** — `M(19)`
  / `M(19)`, `mmJoints` 5 / 6, `msmTriples` 0 / 0 — at BASE, and it stays at
  zero mode changes under the mode-penalty candidates (A: `dMode 0->0` both
  rigs; B: "all-motor both sides"). A mode-change lever has nothing to touch on
  it.
- **R3 and R4 carry the motor->sail->motor sandwiches** (§3.3) and are charged
  nothing for them today.

The two populations are **disjoint** in this battery. R3 genoa carries BOTH
patterns at once (`msmTriples` 1 and `mmJoints` 2), so it is not a clean
discriminator on its own; R1 is.

> **#354 is genuinely unpriced mode churn, not a relitigation of #264, and must
> not be closed as one.**

### 3.5 What did NOT churn, stated as a finding

- **R1 and R2 — the two routes chosen as the primary churn probes — did not
  churn.** Both came back 100% motor with zero mode changes on both rigs. R1
  (TWS 4 / 62) is the archetypal light-air beat; R2 (Flensburg -> Glücksburg,
  TWS 4.5 / 50) is the confined inner-fjord beat. In both, motoring wins every
  heading outright at that wind. The route brief's own "why" for R1 predicted a
  sail-capable fan (genoa TWA 55-95 clearing the floor); the solver's actual
  choice never uses it at these settings — recorded as a discrepancy between a
  route's design rationale and its measured behaviour, not as a bug.
- **R5 (Fåborg -> Avernakø, TWS 4.5 / 260), the geometry-vs-wind control, also
  did not churn** (100% motor, 0 mode changes, `mmJoints` 4 on both rigs — a
  #264-shaped weave).
- So on this battery **mode churn is neither a beating artefact nor a pure
  confinement artefact**. It appears only where the wind puts the 3.7 kn sail
  floor **inside** the useful heading fan — R3's TWS 5 and R4's TWS 5.5
  knife-edge — which is the mechanism §8.6 describes for headings, now
  observed in mode space.
- A secondary reading from the positive control's own perturbed run: with
  `sailPreferenceKn` +2.0 kn (i.e. the floor moved), R1 genoa (TWS 4 / 62)
  produces `M(1) S(1) M(10) S(2) M(1) S(1) M(1) S(1) M(5) S(1) M(4)` — 10
  mode changes, `msmTriples` 4 — and R1 fock 19 mode changes, `msmTriples` 9.
  Dense churn is reachable in this solver's state space once the floor moves;
  it is just not what R1/R2/R5 produce at shipped defaults.

### 3.6 Aperture — what this reproduction can and cannot say

- **Two routes of six, four rows of twelve**, both in Danish waters. The
  reporter's own route was never obtained.
- **Uniform wind only**, one departure instant. Nothing here speaks to a
  forecast with a TWS gradient — the same evidential gap the motor spec §8.2
  records as narrowed, not closed.
- **`chordNavigable` is false on all six routes**, so no chord comparison is
  available and every ETA judgement in §4 is BASE-vs-HEAD only — which is the
  comparison #264's own lesson demands anyway, but it means no absolute "is
  this route good" claim exists anywhere in this document.
- Six routes x one wind field is a targeted reproduction, not a sweep; it says
  nothing about how often #354-shaped churn occurs across the 33-harbour fleet
  the `app/sweep/` arms cover (§6.4 says how to find out without solving).

---

## 4. The seven candidates

Every candidate was run at the **same** constant — 45 s, the shipped
`maneuverPenaltyS` default, as instructed — with the same byte-identical
driver, in its own worktree off `84b049a2`. Numbers are per route / wind cell;
nothing is averaged. R6-control (Flensburg -> Gelting-Mole, TWS 12 / 225) was
byte-identical on both rigs under **all seven**.

### 4.1 Summary table

| key | mechanism | files touched | Δ mode changes (route / cell) | Δ ETA min (route / cell / rig) | control route touched? | #264 shape? | other defect | diff |
|---|---|---|---|---|---|---|---|---|
| **A** mode penalty, geometric | sibling branch of the tack penalty at `effS`, mirrored at `subEffS`; new `Settings.modeChangePenaltyS` field | `isochrone.ts` +25/-1, `types.ts` +8, `OptionsPanel.tsx` +10, `SettingsPanel.tsx` +2, `dict.de.ts` +1, `dict.en.ts` +1, `planForm.ts` +1, `gpx.test.ts` +1, `planForm.test.ts` +1, `recalc.test.ts` +2, `db.test.ts` +11, `changelog.d/354.fixed.md` +1 — 12 files, +64/-1 as committed | R3 (5/140): **3->1** both rigs. R4 (5.5/120): **3->3 unchanged** both rigs. R1 (4/62): 0->0 | R3 +0.5 genoa / +1.3 fock; **R4 +5.0 genoa / +2.4 fock**; R1 -0.2 / -2.5; R5 fock -0.1 | NO | **YES**, R4 both rigs | penalty >= 150 s deletes every mode-changing candidate; the field permits 300 | `candidates/354-a-mode-penalty-geometric.diff`, applies to `84b049a2` |
| **B** mode penalty, cost-only | module constant `MODE_CHANGE_PENALTY_S = 45` added to `costMs` at the direct-arrival and child sites; `effS`/`distNm`/`tMs` untouched | `isochrone.ts` only — +32/-16 as committed, of which two whitespace-only `edgeFactor(...)` re-wraps (§8.3) | R3: **3->1** genoa, **3->2** fock. R4: **3->2** both rigs. R1: 0->0 | R3 **-0.3** genoa / **+1.7** fock; R4 **+2.4** genoa / **+1.6** fock; R1 -1.8 / -1.4; R5 fock -0.1 | NO | **YES**, 3 of 12 rows | no penalty-0 control; R1 moved with no mode change on either side | `candidates/354-b-mode-penalty-cost-only.diff`, applies to `84b049a2` |
| **G** floor hysteresis band | enter sail at `floor + band`, stay down to `floor - band`, `band = motorSpeedKn * maneuverPenaltyS / dtS` | `isochrone.ts` +38/-1 as committed | R3: **3->0** both rigs — **by going 100% motor**. R4: **3->3 unchanged** | R3 -1.8 / -1.2; **R4 +0.5 / +0.3**; R1 -4.8 / -3.3; R5 -3.7 / -3.4 | NO | **YES**, R4 fock, isolated by ablation | `motor.test.ts` 2 failed / 21 passed — the #254 margin-disabling escape hatch no longer restores pre-#254 routing | `candidates/354-g-floor-hysteresis-band.diff`, applies to `84b049a2` |
| **C** minimum sail segment | `Node.modeRunMs`; a motor candidate is refused while the parent's sail run is under 45 s; run length joins `visitedDominates` | `isochrone.ts` +73/-3, `isochrone.followups.test.ts` +11/-11 — 2 files, +84/-14 as committed | R3: **3->5 both rigs (WORSE)**, `msmTriples` 1->2 genoa. R4: unchanged. R5 (4.5/260): **0->1** genoa | R3 +0.1 / +0.9; R5 genoa **+0.9**; R4 0.0 | NO | **YES**, R5 genoa, attributed to the guard by ablation | constraint admittedly unsound (`better()` unchanged) | `candidates/354-c-minimum-segment.diff`, applies to `84b049a2` |
| **D** postprocess absorption | new pass absorbs a motor-sandwiched sail run under 45 s into one motor leg, with depth re-validation | `postprocess.ts` +88/-1 as committed | **12/12 unchanged at 45 s — zero evidence.** At 300 s: R3 genoa 3->1, everything else unchanged | 0.0 on all rows in both arms | NO (structurally: R6 is 100% sail, no sandwich exists) | no (search never moves) | at 300 s the merged leg reads **5.79 kn** where every other motor leg reads 6.50; foreclosed by the standing post-processing rule | `candidates/354-d-postprocess-absorption.diff`, applies to `84b049a2` |
| **E** presentation only | flag legs of a mode run shorter than `settings.maneuverPenaltyS` in the legs table | `RouteSummary.tsx` +40, `app.css` +20, `dict.de.ts` +7, `dict.en.ts` +6, new `lib/briefModeRuns.ts` +67, new `lib/briefModeRuns.test.ts` +79, new `components/RouteSummary.briefRun.test.tsx` +123, `changelog.d/354.changed.md` +1 — 8 files, +343 as committed | **12/12 unchanged by construction** | 0.0 | NO | structurally impossible | fires on **0 of 12 rows** at 45 s | `candidates/354-e-presentation-only.diff`, applies to `84b049a2` |
| **F** fairway-aware | #244 §6.1 "corridor as a cost term", charged on `costMs` when an edge midpoint lies outside every corridor | `isochrone.ts` +46/-16, `planRoute.ts` +12, new `lib/fairway.ts` +110 — 3 files, +168/-16 as committed, of which two whitespace-only `edgeFactor(...)` re-wraps (§8.3) | **12/12 unchanged — no input data exists** | 0.0 | NO | not measured; structurally predicted by #244 §6.1 | `seamarks.json` holds 1794 features, all `Point`, zero corridors, by construction | `candidates/354-f-fairway-aware.diff`, applies to `84b049a2` |

Each diff applies to `84b049a2` (§8.3); none of the seven is empty. The BASE
worktree's own diff was empty by construction (no source edit) and is not
committed — `base-output/` is the baseline.

### 4.2 Why each was rejected

**A — mode penalty, geometric (`effS`).** It works on R3 (TWS 5 / 140): mode
changes 3 -> 1 on both rigs, at +0.5 min genoa (21.4 -> 21.9) / +1.3 min fock
(20.8 -> 22.1), bought by motoring through water the boat used to sail (genoa
motor time 15.15 -> 16.89 min, sail 6.25 -> 5.01 min). **It fails on R4 (TWS
5.5 / 120)**: mode changes stay at 3 on both rigs *and* ETA rises +5.0 min
genoa (67.6 -> 72.6) / +2.4 min fock (68.4 -> 70.8). The HEAD mode runs: genoa
`S(2) M(1) S(2) M(8)` retains a one-leg motor run between two sail runs, and
fock `S(2) M(1) S(1) M(7)` retains the motor -> sail -> motor triple itself
(`msmTriples` 1, `shortSailRuns` 1): a one-leg sail run survives a 45 s
charge. **The #264 shape is confirmed, not inferred:** on R4 genoa total time
rose +5.0 min while motor time *fell* 62.60 -> 60.11 min and sail time *rose*
5.00 -> 12.49 min — +7.5 min of sailing bought -2.5 min of motoring. The
penalty locks the boat into whichever mode it is already in. User-visible
side effect: R4's rig recommendation inverts (BASE genoa 67.6 < fock 68.4; HEAD
fock 70.8 < genoa 72.6, reported "decided" for fock); R3's ETA ordering also
inverts (BASE fock 20.8 < genoa 21.4; HEAD genoa 21.9 < fock 22.1), moving
the recommended rig fock -> genoa while the comparison stays `tie` on both
sides. Net over the 12 rows: 4 slower (+9.2 min
total), 3 faster (-2.8 min), 5 unchanged. **Its causal control is the
strongest evidence in the whole set:** with the penalty set to 0, all 12
fingerprints returned byte-identical to BASE — the implementation is a strict
no-op at 0, every delta is causally the penalty, and the BASE table is
reproduced on a second worktree. **Unbounded-input defect:** `dtS` is in {150,
300, 600}; at 45 s no candidate is deleted at the full step (`effS >= 105 s`),
but on substeps a mode change can no longer be fitted into a sub-45 s pocket,
and a penalty **>= 150 s deletes every mode-changing candidate outright** at
the finest ring — which would read in the metrics as a spectacular success —
while the shipped Settings field's max is 300. **No shipped test discriminates
it:** `isochrone` + `motor` 23/23, `planRoute`/`relaxedDepth`/`depthGate`
38/38, `SettingsPanel`/`planForm`/`recalc` 98/98 and `realmask.repro.test.ts`
17/17 all pass unchanged (the realmask duration of 795.5 s is discarded — the
machine was under multi-agent load). Nothing in the suite would catch A's R4
regression. Rejected: on the route where the churn is worst it removes none
of it and costs real time by locking the boat into its current mode — the
same family of counter-productive outcome as #264's two rejected levers,
arriving by a different route than the one the issue ruled out.

**B — mode penalty, cost-only (`costMs`).** The closest candidate. It removes
every `msmTriple` and every `shortSailRun` from all 12 rows (HEAD reads 0 and 0
everywhere): R3 (TWS 5 / 140) genoa `S(3) M(1) S(1) M(7)` -> `S(4) M(9)`
(3 -> 1, -0.3 min, 21.4 -> 21.1), R3 fock -> `S(4) M(5) S(2)` (3 -> 2,
**+1.7 min**, 20.8 -> 22.5, motor share 70.0 -> 55.6), R4 (TWS 5.5 / 120)
genoa `S(1) M(1) S(2) M(9)` -> `M(3) S(2) M(9)` (3 -> 2, **+2.4 min**, 67.6
-> 70.0), R4 fock -> `M(3) S(2) M(5)` (3 -> 2, **+1.6 min**, 68.4 -> 70.0).
R6 is byte-identical. Blast radius is smaller than A's by construction:
`effS`/`distNm`/`tMs` are untouched, so there is no candidate-deletion hazard,
reported ETA and geometry stay the solver's honest output, and as a module
constant it needs no `DEFAULT_SETTINGS` field (which would move every sweep
arm that does not spread-override it). The capture-arrival `candCostMs` (`:589` at
`84b049a2`) correctly needs **no** edit — it derives from `child.costMs` and editing it
would double-charge. **Two confounds must be removed before it can be
recommended.** (i) It has **no penalty-0 inertness control** — A ran one and
got 12/12; B did not. (ii) **R1 (TWS 4 / 62) is 100% motor with zero mode
changes on both sides, yet its fingerprint moved and its ETA improved 1.8 min
genoa (183.6 -> 181.8) / 1.4 min fock (183.3 -> 181.9).** No penalty is charged
on either winning path, so that is pure search perturbation — the penalty
re-ranks intermediate frontier candidates and changes which node wins its
prune cell. Every ETA delta B reports is therefore a mixture of the intended
effect and that perturbation, and the driver cannot separate the two. B also
did **not** run `realmask.repro.test.ts`. Cost: three rows slower by 1.6-2.4
min — the #264 shape, partially reproduced (the report records that the ETA
was paid, not that it was paid for a sail-locked heading, since the driver
holds no per-joint VMG). Rejected for this cycle on the ruling; the only
direction worth a second increment, behind §6.3.

**G — floor hysteresis band.** The reporter's own first word, and the issue
body was wrong to call it inexpressible (§2.3). It is immune to the
`better()`-across-prune-cells blindness because it never needs two candidates
compared — the churning candidate is simply not produced. **Disqualifying
finding: it breaks a documented #254 invariant.** `motor.test.ts` goes 2 failed
/ 21 passed (with `isochrone.test.ts`, 23 rows); the decisive failing row is
*"sailPreferenceKn at the disabling value restores pre-#254 routing"* —
expected `['sail']`, received `['sail','sail','motor','motor','motor']`.
CLAUDE.md and the motor spec both state that a margin at or above
`motorSpeedKn - motorThresholdKn` collapses the floor back and restores the
pre-#254 path **byte-for-byte**; the band depends only on `motorSpeedKn` and
`maneuverPenaltyS`, does not collapse with the margin, and so the pre-#254
escape hatch becomes unreachable. That is a structural defect of the
candidate, not a test to update. It also needs an arbitrary time->speed
conversion (`band = motorSpeedKn * maneuverPenaltyS / dtS`: 0.49 kn at dtS
600, 0.98 at 300, 1.95 at 150), making the band ring-dependent. **What it
buys:** R3 (TWS 5 / 140) mode changes 3 -> 0 on both rigs — **by making the
route 100% motor** (70.8 -> 100.0 genoa, 70.0 -> 100.0 fock, `M(9)` on both,
the two rigs collapsing to one identical fingerprint `3610774adcc5edd0`).
Churn eliminated by eliminating sailing, on a time-optimal sailing router. R4
(TWS 5.5 / 120) keeps all 3 mode changes and gets slower (+0.5 genoa, 67.6 ->
68.1; +0.3 fock, 68.4 -> 68.7). **#264 shape isolated by ablation** (enter-only
band vs full band): on R4 fock the enter-only variant reaches 67.0 min (faster
than BASE 68.4) while the full band reaches 68.7 (slower) — the stay-in-sail
half alone costs +1.7 min there; on R4 genoa the sign is the other way
(enter-only 69.7, full band 68.1), so it is not even consistent within one
route. **Its good-looking numbers are not attributable:** R1 (TWS 4 / 62) and
R5 (TWS 4.5 / 260) are 100% motor on both sides yet moved by -3.3 to -4.8 min
(R1 183.6 -> 178.8 genoa, 183.3 -> 180.0 fock; R5 34.2 -> 30.5 genoa, 33.9 ->
30.5 fock). A hysteresis band has no mode to hold on an all-motor route; the
ring loop's `minDist`/`minTMs`/`minCostMs` are computed over the whole
frontier and `dtS` derives from `minDist`, so suppressing sail candidates
changes the ring step for every node. That removing candidates *improves* ETA
is itself evidence the search is not exhaustive at these settings. Rejected.

**C — minimum sail segment.** Highest structural risk, and the measurement
agrees with the prior. At the mandated 45 s it **removes zero short sail runs
anywhere** and **doubles the #354 metric on the one route that reproduces
#354**: R3 (TWS 5 / 140) mode changes 3 -> 5 on both rigs (genoa `S(3) M(1)
S(1) M(7)` -> `S(2) M(1) S(1) M(5) S(1) M(1)`, `msmTriples` 1 -> 2,
`shortSailRuns` 1 -> 2; fock -> `S(2) M(1) S(1) M(5) S(2) M(1)`), at +0.1 /
+0.9 min. R5 (TWS 4.5 / 260) genoa goes 0 -> 1 mode change (`M(7)` -> `S(1)
M(4)`), 100% -> 71.5% motor, **+0.9 min** (34.2 -> 35.1) — and its rig
comparison turns from `moot` into `decided`. R4's short sail run survives
untouched. Two isolating arms attribute the R3 regression **entirely to the
extra `visitedDominates` axis** (the structural half is a net negative on its
own) and R5's +0.9 min **to the guard itself** — the #264 family one step
over: a slower ETA bought by declining the faster engine heading. **Why it
misses at 45 s:** the guard measures true duration, the solver's shortest full
step is `dtS = 150 s`, so a sail run below 45 s can only be built from
`dtS/4` or `dtS/8` substeps — the mask-fitting retry, not a sailing decision.
45 s sits at least ~3.3x below the phenomenon. **At 900 s it works and pays
#264's price every time** (8 of 12 rows move): R4 genoa `S(1) M(1) S(2) M(9)`
-> `S(3) M(7)` (3 -> 1) at **+3.9 min (+5.8%)**; R4 fock -> `S(6) M(5)`
(3 -> 1) at +3.5 min (+5.1%); R3 fock -> `S(7) M(6)` (3 -> 1) at **+6.0 min
(+28.8%)**; R3 genoa collapses to all-motor `M(28)` (3 -> 0) at +4.2 min
(+19.6%) with **reversals >= 45 deg 3 -> 19** — it trades mode churn for
exactly the heading weave §8.6 says not to fix; and R1 moved on both rigs
(genoa 1.8 min faster) where the constraint cannot bind on the returned path.
Residual admitted by the prototype: `better()` is unchanged, so a cheaper
child with a shorter run can evict a freer one — **the constraint is not
sound**; it is also sail->motor only, and nothing tests the new axis. Guards:
162/162 unit, `realmask.repro` 17/17, `invariants.property` 1/1 (durations
discarded, load). Rejected: both failures are one problem — the search is
heuristic (prune cells, componentwise domination, frontier cap), so any new
commitment state perturbs which threads survive, and the perturbation is far
larger than the constraint's intended effect, which is precisely the "every
moved plan must be explained" bar this direction cannot meet.

**D — postprocess absorption.** **Zero evidence at the mandated constant:**
12/12 byte-identical, because the shortest sail run in the whole battery is
75 s and the constant is 45 s. That is not evidence it is harmless. At a 300 s
threshold (the driver's own `shortSailRuns` definition, not a tuned value)
exactly **1 of 12** plans moves — R3 (TWS 5 / 140) genoa: mode changes 3 -> 1,
**reversals >= 45 unchanged at 3** (it does not touch the weave metric), ETA
exactly +0.0 min, motoring **+5.9 pp by time** (70.8 -> 76.7; +4.6 pp by
distance) for a byte-identical arrival — it relabels 75 s of sailing as
motoring and gains nothing. The merged leg reads `motor / 225 s / 097 deg /
0.362 nm / 5.79 kn` while every other motor leg on that plan reads exactly
6.50 kn (`motorSpeedKn`): **the plan tells the skipper to motor at a speed the
engine does not make.** Reported distance drops 0.371 -> 0.362 nm because the
sandwich is straightened to a chord. The depth re-validation refused the other
three sandwiches (R3 fock, R4 both rigs) — the gate does real work. The
prototype kept the sandwich's own timestamps, so the brief's predicted
"displayed plan slower than `etaMs`" harm did *not* occur (`etaMs -
lastLeg.endTimeMs = 0`); the harm is the fabricated speed and the motoring
over-claim. **No named guard catches it:** `postprocess.test.ts` +
`legDistanceReconciliation.test.ts` 12/12 and `realmask.repro` 17/17 all pass
at the reachable configuration — it would have merged green. It owes a sweep
regardless (`closure.mjs` returns IN_CLOSURE for `postprocess.ts` via
`sweepArms.ts -> planRoute.ts -> postprocess.ts`: the search does not move
but `PlanResult.legs` does). **It requires the standing post-processing rule
to be lifted first**, and the ruling did not lift it. Rejected.

**E — presentation only.** Safe, cheap, **owes no #282 sweep** (the same
`PlanResult`-untouched shape as #493 / PR #504), cannot slow the boat, cannot
re-open #254's floor. 12/12 byte-identical by construction — which is the
definition of the candidate and zero evidence about churn. **The finding that
matters: at the only non-arbitrary constant this repo owns (45 s) the
disclosure fires on 0 of 12 rows.** Cause measured, not argued: the shortest
mode run anywhere is 75 s (§3.3), the solver's own `dtS/8` quantum at the
600 s ring. Threshold sweep over the measured runs (arithmetic, no re-solve):
45 s -> 0/12 rows, 0 runs; 76 s -> 4/12 rows, 6 runs; 151 s -> 4/12, 9;
300 s -> 4/12, 10; 400 s -> 4/12, 12. Making E useful requires **inventing** a
threshold with no principled anchor — the hand-tuned knife-edge #254
documents, relocated into the UI where nothing measures it. The function is
not vacuous (it flags a 30 s run and reds at 45 s; an `if (false && ...)`
mutation takes the two new test files 10/10 -> 5 failed / 5 passed). E also
does not satisfy the reporter's constraint: a brief sail segment in a fairway
too narrow to tack is a **seamanship infeasibility**, and labelling it does not
make the plan followable. Rejected — and recorded rather than left unnamed,
because it is the cheapest thing that could possibly close the issue and a
future reader will ask why it was not taken. Its one honest anchor being
below the solver's time quantum is a fact about the **solver**, not the UI: an
argument for pricing the mode change, not for disclosing it.

**F — fairway-aware. FORECLOSED; listed as closed, not open.** Implemented as
#244 §6.1 "Option A, corridor as a cost term" (the option that spike calls
structurally the cleanest before rejecting it on data), charged on `costMs`
only, with `halfWidthNm` a required field so a width cannot be defaulted into
existence. 12/12 unchanged — **and the zero-delta is not dead code**: fed a
*fabricated* corridor (origin -> destination straight line, half-width 0.05
nm) on R3, the plan moves (whole-`PlanResult` fingerprint `58b2473a5832361b`
-> `51906593ae3bb0f3`, legs 11 -> 9, revert reproduces exactly — an instrument
check on invented data, licensing no conclusion about F), so the term is live
and the byte-identity is caused by **the absence of the input**. Measured:
`app/public/data/seamarks.json` holds **1794 features at `84b049a2`, geometry type
`Point` only** (buoy_lateral 689, buoy_special_purpose 445, beacon_special_purpose
258, beacon_lateral 139, buoy_cardinal 115, light_minor 107, ...) — zero
corridors, by construction, since `pipeline/build_seamarks.mjs` queries
`node["seamark:type"]` only; and `app/src/routing/` contains zero
seamark/fairway references. #244's own measurements stand: `seamark:type=
fairway` does not exist in-region; the 258 `waterway=fairway` ways carry zero
width/depth/draft tags; 144 (55.8%) are canoe-scheme geometry of which 132 are
`boat=discouraged`, and a naive lookup picks a paddling route for `maasholm`.
#244 also **falsified** the "depth already confines the boat" hypothesis
(corridor > 1 km wide at 90.8% of navigable centreline points), so the decline
rests on the data being unusable, **not** on the corridor being narrow —
anyone reopening this on the grounds that the corridor is wide has the
argument backwards. Entry condition (#244 §7.6) is unchanged and unmet: an
official ENC product with `FAIRWY`/`DRGARE` width or maintained depth
populated, licence first. Rejected.

### 4.3 The constant — 45 s is not a neutral choice

Every candidate was run at 45 s, the shipped `maneuverPenaltyS` default,
because it is the one constant this repo already owns. **It sits below the 75 s
shortest mode run this battery produced** (`dtS/8` at the 600 s ring, the
value of every shortest run in §3.3), which is why C, D and E could not bind
on these routes. Any re-measurement must state its constant relative to that
observed run. The meaningful band:

- **lower bound ~75 s on these routes** — the shortest run observed in this
  battery, `dtS/8` at the 600 s ring; the quantum is 75 s only at the 600 s
  ring, and near the destination it is `150/8 = 18.75 s` (`dtS` at
  `isochrone.ts:395`, the `[2, 4, 8]` substep divisors at `:527`, both at
  `84b049a2`);
- **hard ceiling 150 s for a geometric penalty (A)** — `dtS`'s minimum is
  150 s, so at or above it every mode-changing candidate is *deleted* rather
  than priced (`distNm <= 0` -> `continue`), and the shipped Settings field for
  the sibling `maneuverPenaltyS` permits **300** (`OptionsPanel.tsx`: min 0,
  max 300, step 1 — re-read at `b7bfc0c8`). If A is ever revived, the field
  must be clamped against `dtS` and a surviving-candidate assertion added;
- **B has no such ceiling** (it never touches `distNm`), a second argument for
  the cost-only form.

### 4.4 Refuter verdicts

**None were run.** No adversarial refutation pass was commissioned on any of
the seven candidate evaluations. **Any direction ever selected must get two
adversarial refuters before implementation begins** (§6.3).

---

## 5. The open product question

The ruling deferred the fix; it did not answer the question the brief put to
the maintainer (§4.4(1) there), which remains open in exactly these terms:

> **Is 1.6-2.4 min forfeited on a ~68 min passage (R4, Ærøskøbing -> Søby,
> TWS 5.5 / wdir 120) an acceptable price for removing one 150-225 s sail
> interlude?**

The figures are B's R4 rows (+2.4 min genoa, +1.6 min fock, §4.2) against the
R4 sail runs of §3.3. This is a judgement about what a plan is *for*, not a
measurement. §8.6 answered the analogous **heading** question with "no" — a
motor-tack weave that is faster stays; nothing measured here answers the
**mode** question, and nothing measured here can. Four smaller decisions ride
on it: user-visible Settings field or module constant (A vs B shape); whether
the standing post-processing rule is lifted for D (this document recommends
no); whether E ships as disclosure while the solver stays as-is, and on what
threshold given that the only principled one fires on nothing; and whether the
reporter's own route is obtained before any of the above.

---

## 6. What would re-open this

### 6.1 New evidence about the population

1. **The reporter's own route.** It was never obtained; the churn evidence is
   two routes of six, both Danish.
2. **A Flensburg-Fjord reproduction.** Every route here is in Danish waters,
   and the fleet's home water is unrepresented — a reproduction there could
   change both the population and the wind cell.
3. **A gradient forecast.** Every cell here is uniform wind. A real Open-Meteo
   field that churns differently would change the per-triple cost.
4. **The §6.4 offline count comes back non-zero across several arms.** Then
   the churn population is far larger than 4 rows in 6 routes and a fix may be
   worth more than it looks here.
5. **The 75 s sail runs turn out to be a substep artefact, not a sailing
   decision.** 75 s is exactly `dtS/8` at the 600 s ring — the mask-fitting
   retry — so the right fix may be in the substep path (never emit a
   sub-quantum mode flip) rather than in the cost function. **This is a fifth
   direction nobody prototyped**, it is cheap to test, and it would owe a much
   smaller argument than any cost-function change.

### 6.2 New evidence about a candidate

6. **B's confounds resolve favourably.** If a penalty-0 inertness control
   gives 12/12 byte-identity *and* the all-motor R1 rows (TWS 4 / 62) stop
   moving, then B's three slower rows are its whole cost and B becomes
   recommendable on the §5 product judgement alone.
7. **An adversarial refuter kills one of the seven self-reports.** None was
   attacked (§4.4).
8. **G's `motor.test.ts` failures are judged as tests to update rather than a
   broken invariant.** That reading requires amending CLAUDE.md and the motor
   spec, both of which state the margin-disabling value restores pre-#254
   routing byte-for-byte — a maintainer call, not an implementer's.
9. **The §7 `msmTriples` discrepancy resolves against §3.3.** If the target
   population is defined leg-wise (2) rather than run-wise (4), B's headline
   and its aggregate need re-deriving and A's R4 failure may be a smaller miss
   than it reads.

### 6.3 The gates a B implementation must clear before any sweep time is spent

Take B as a **module constant, not a Settings field** (a new
`DEFAULT_SETTINGS` field moves every arm that does not spread-override it;
A's penalty-0 control shows the cost sites can be made strictly inert). Then
require, in order:

1. a **penalty-0 inertness control** giving 12/12 byte-identity against the
   `84b049a2` BASE table (§3.2) — A's shape;
2. an explanation of the **R1 movement** (TWS 4 / 62, 100% motor, zero mode
   changes both sides): either it disappears or every ETA delta stays a
   mixture;
3. `realmask.repro.test.ts` **17/17** (B never ran it);
4. the §7 `msmTriples` discrepancy settled from artefacts, so the target
   population is fixed before it is scored;
5. `planRoute.reasonDecoupling.test.ts` on the guard list (2026-08-31 ruling),
   beside `motor.test.ts` (G fails 2 rows there), `isochrone.test.ts`,
   `postprocess.test.ts` + `legDistanceReconciliation.test.ts`,
   `invariants.property.test.ts`;
6. **two adversarial refuters** on the implementation before the sweep;
7. **the full #282 sweep** — REQUIRED BASE double-run recorded against the
   merge-base of the certifying branch, then BASE-vs-HEAD — under the §6.4
   arm analysis, detached from the outset with `SC_SWEEP_OUT` reported at
   detach.

### 6.4 The sweep this fix owes — and why the nine arms may not certify it

`isochrone.ts`'s `effS` feeds `distNm`, which sets leg boundaries and timings,
which are `PlanResult` fields, so A, B, C and G owe a sweep **by construction**;
D owes one for the output (`closure.mjs`: IN_CLOSURE via `postprocess.ts`); E
and F owe none. Read off `app/sweep/sweepArms.ts` at `84b049a2`:

| arm | wind | settings | origin |
|---|---|---|---|
| `breeze` | `uniformWindGrid(12, 225)` | DEFAULT | flensburg |
| `no-comfort` | `uniformWindGrid(12, 225)` | `depthComfortMarginM: 0` | flensburg |
| `short-horizon` | `uniformWindGrid(12, 225, {hours: 3})` | DEFAULT | flensburg |
| `light-motorless` | `uniformWindGrid(3, 0)` | **`motorEnabled: false`** | flensburg |
| `becalmed` | `uniformWindGrid(0.15, 0)` | **`motorEnabled: false`** | flensburg |
| `deep-becalmed` | `uniformWindGrid(0.15, 0)` | **`motorEnabled: false`**, `safetyDepthM: 4.0` | flensburg |
| `margin-zero` | `uniformWindGrid(12, 225)` | `depthComfortMarginM: 0` | marstal |
| `relaxation-dense` | `uniformWindGrid(12, 225)` | DEFAULT | marstal |
| `margin-extreme` | `uniformWindGrid(12, 225)` | `depthComfortMarginM: 8.0`, `safetyDepthM: 2.9` | marstal |

- **Three arms are structurally vacuous for a mode-change lever:**
  `light-motorless`, `becalmed` and `deep-becalmed` set `motorEnabled: false`,
  so the classification cascade can never assign `kind = 'motor'` — zero motor
  legs, zero mode changes, whatever the fix does. Their byte-identity is not
  evidence. This vacuity is structural rather than an artefact of failing
  routes, so it is a **different** vacuity from the documented depth one.
- **The other six all run `uniformWindGrid(12, 225)`.** At TWS 12 the sail
  floor is crossed only inside the polar's no-go taper (genoa first table row
  TWA 35 at 6.39 kn x 0.9 = 5.75 kn, tapered linearly to 0 at TWA 0, so
  `sailSpeed < 3.7` only below TWA ~22.5 deg). Motor candidates exist in these
  arms **only for near-dead-upwind headings**. Whether any of the 33
  destination pairs per arm keeps a mode change on the winning path is **not
  measured** — do not assume either way. R6-control is that exact wind field
  from Flensburg and was byte-identical under all seven candidates — one
  destination pair of 33.
- **Run this zero-solver-time test before committing any sweep budget:** each
  arm dump `<label>.json` is the full serialized `PlanResult` per destination,
  so `modeChanges`, mode-run strings and motor->sail->motor sandwiches are
  computable **offline from an existing BASE artefact with no re-solve**. Count
  them across all 33 rows of each of the nine arms; any arm with zero
  sandwiches is vacuous for #354 exactly as `becalmed` is for depth — record
  it, never count its byte-identity. This costs minutes and can save ~93 min of
  solver time spent proving nothing.
- **If that comes back empty, add one arm:** `mode-churn`: `{ settings:
  DEFAULT_SETTINGS, wind: () => uniformWindGrid(5.0, 140), originId:
  'svendborg' }` — TWS 5.0 / wdir 140 from Svendborg is the one cell in this
  battery measured to produce motor->sail->motor sandwiches on both rigs (R3),
  and TWS ~5 is where the 3.7 kn floor sits inside the useful heading fan. The
  harder second candidate is TWS 5.5 / wdir 120 from Ærøskøbing (R4), the cell
  every candidate failed on. **Honest risk:** the arm's discriminance must be
  verified by the same offline count on its own first BASE run — R2 was chosen
  on exactly this polar reasoning at TWS 4.5 / 50 and came back 100% motor.
- **Budget:** one arm-set = 9 arms x 33 destinations = 297 plans, ~1850 s
  (~31 min) unloaded for `base1`; the required control (BASE double-run +
  BASE-vs-HEAD) is 3 arm-sets, ~93 min; a tenth arm adds 33 plans, roughly
  +11% per run, ~103 min. Never as a harness background task.

---

## 7. Known discrepancies NOT settled from the artefacts

Recorded as discrepancies. This document deliberately picks no number for
the first two; whoever re-opens #354 settles them from the committed driver output
and the candidate diffs before scoring anything.

1. **The BASE `msmTriples` population is reported three ways.** Candidate B's
   report says "BASE carried msmTriples=1 on R3 (both sails)" — i.e. **2**.
   Candidate D's report says "the only three motor/sail/motor sandwiches in the
   whole battery" — **"three"** — while its own list gives **four** sail-run
   durations (75 s R3 genoa, 75 s R3 fock, 150 s R4 genoa, 225 s R4 fock).
   Candidate E's duration strings (§3.3) and the brief imply **four**, one per
   churning row. What the committed BASE output literally holds, per row and by
   the driver's own leg-level definition (`msmTriplesCount`: consecutive legs
   motor, sail, motor), is R3 genoa 1, R3 fock 1, R4 genoa 0, R4 fock 0 — R4's
   sail runs are 2 and 3 legs long, so they are caught by `shortSailRuns` (1 on
   each of the four rows) and not by `msmTriples`. The leg-level and run-level
   definitions therefore answer different questions, the candidate reports do
   not say which they scored against, and the brief did not fix one. **The
   target population size is what any fix is judged against**, so it must be
   fixed by definition before B's "every msmTriple gone" can be scored.
2. **Candidate B's aggregate does not reconcile with its own rows or with the
   BASE table.** B's prose says "total mode changes across the 12 rows fall
   **9 -> 5**". The BASE table (§3.2) sums to **12** (3 + 3 + 3 + 3), and B's
   own HEAD row table sums to **7** (R3 genoa 1, R3 fock 2, R4 genoa 2, R4
   fock 2). Candidate G's report, on the same BASE, says "12 -> 6", which does
   reconcile with G's rows. Neither 9 nor 5 is derivable from any table in the
   artefacts; the origin of B's figures is unexplained.
3. **The metre equivalents of the sail runs are not carried here.** The brief
   converts the 75 / 75 / 150 / 225 s runs to distances "at ~4 kn"; the first
   three reproduce at exactly 4.0 kn and the fourth does not (it needs ~4.23
   kn), and the driver records no per-leg speed for those runs, so only the
   measured durations are stated (§3.3). Settled by omission, not left open.

---

## 8. How to re-run

### 8.1 The driver

`docs/spikes/354-mode-churn/scratch354.test.ts` is the exact instrument, sha256
`13487727fa7db42420b8fbae7a8ace658f1ec1f67bcde75718bb5a60125a350f`. It lives
under `docs/spikes/` **so that no vitest config collects it**: `app/vite.config.ts`'s
`include` is `src/**/*.test.{ts,tsx}` and `app/sweep/vitest.config.ts` pins
`root: here` with `include: ['**/*.test.ts']` relative to `app/sweep/`, and
`grep -rn 'docs/spikes' app/vite.config.ts app/sweep/vitest.config.ts` is empty
(verified at `b7bfc0c8`). Its relative imports (`../src/...`, `./sweepArms`)
resolve only once it is copied into `app/sweep/`.

From the driver's own README, verbatim:

> From a checkout of `sail_command` with `app/node_modules` installed
> (`npm --prefix app ci`), copy `scratch354.test.ts` into `app/sweep/`, then
> from the `app/` directory:
>
> ```
> npx vitest run --config sweep/vitest.config.ts scratch354.test.ts
> ```
>
> or from the repo root:
>
> ```
> npm --prefix app run test -- --config sweep/vitest.config.ts scratch354.test.ts
> ```

`SC_DRIVER_OUT=/abs/path` controls where the JSON dumps land; it defaults to
`app/sweep/scratch354-out/`. **Correction to the README's own text:** that
directory is **not** gitignored — `git check-ignore -v app/sweep/scratch354-out/`
returns nothing at `b7bfc0c8` — so delete both the copied driver and its output
directory before committing anything (the copied driver also lints with 4
warnings, unused `eslint-disable` directives, under CI's `eslint src e2e
sweep`). Outputs: `run1.json`, `run2.json` (full per-sail and per-plan rows),
`double-run-control.json` (`{ byteIdentical, mismatches }`),
`positive-control.json`. All three `it()` blocks took ~31.5 s on a quiet
machine at `84b049a2` — 24 sail solves for the double-run control, plus 3 route
plans (6 sail solves) for the positive control. Every number in §3.2 is a transcription of
`354-mode-churn/base-output/run1.json` (identical to `run2.json` on every field
transcribed here; the two differ only in the wall-clock `solveMs` fields).

### 8.2 Reproducing the BASE table

Check out `84b049a2`, run the driver, and compare every `legsFingerprintPrefix16`
against §3.2. Candidate A's penalty-0 control already reproduced the whole
table on a second worktree; a third reproduction on a different machine and
day is the stronger control this repo prefers for sweep baselines.

### 8.3 Reproducing a candidate

Each rejected option is one `git diff` against `84b049a2` under
`docs/spikes/354-mode-churn/candidates/`:

| candidate | file | applies to |
|---|---|---|
| A | `candidates/354-a-mode-penalty-geometric.diff` | `84b049a2` |
| B | `candidates/354-b-mode-penalty-cost-only.diff` | `84b049a2` |
| C | `candidates/354-c-minimum-segment.diff` | `84b049a2` |
| D | `candidates/354-d-postprocess-absorption.diff` | `84b049a2` |
| E | `candidates/354-e-presentation-only.diff` | `84b049a2` |
| F | `candidates/354-f-fairway-aware.diff` | `84b049a2` |
| G | `candidates/354-g-floor-hysteresis-band.diff` | `84b049a2` |

Each file is the scratch worktree's `git diff` against `84b049a2`, with the
files that were NEW in that worktree (A's and E's changelog fragments, E's
`lib/briefModeRuns.ts` and its two tests, F's `lib/fairway.ts`) appended as
`/dev/null` new-file hunks so that one `git apply` recreates the whole
candidate. B and F each re-wrap two `edgeFactor(...)` calls onto one line (the
repo's prettier hook). In B one of the two is a standalone whitespace-only
hunk (`@@ -578`) and the other sits inside the substantive `@@ -451` hunk; in
F both are standalone whitespace-only hunks. Neither is part of either
candidate. All seven were dry-run with `git apply --check` at
`b7bfc0c8` and applied cleanly — none of the touched files changed in the two
commits between `84b049a2` and `b7bfc0c8`.

`git apply` the diff on a worktree at `84b049a2`, copy the driver into
`app/sweep/`, run §8.1, and diff the resulting rows against §3.2 and §4.1.
Where a candidate's report measured a second arm (A's penalty-0 control, C's
900 s override, D's 300 s threshold, G's enter-only band), that arm is
described in §4.2 and is not a separate diff; only the 45 s form is committed.
E's threshold-reachability probe and F's non-vacuity control test — the
instruments behind §4.2's "0 of 12 rows" and "the term is live" claims — are
committed beside the diffs under `candidates/probes/`; they are not part of
any candidate. The per-candidate output dumps the reports were read from are
not committed; their rows are transcribed in §4.1 and §4.2.

---

## 9. NOT RECOMMENDED — considered and rejected

| Option | Why it lost (route / cell) |
|---|---|
| **A — geometric mode penalty on `effS`** (§4.2) | Leaves R4 (5.5/120) at 3 mode changes on both rigs while costing +5.0 / +2.4 min; the #264 lock-in shape measured (R4 genoa +7.5 min sailing for -2.5 min motoring); inverts R4's rig recommendation; a penalty >= 150 s deletes candidates outright and the field permits 300; no shipped test catches its R4 regression. |
| **B — cost-only mode penalty** (§4.2) | The closest, and deferred rather than refuted: removes every sandwiched short sail run but pays +1.7 / +2.4 / +1.6 min on R3 fock, R4 genoa, R4 fock; no penalty-0 control; all-motor R1 (4/62) moved -1.8 / -1.4 min with nothing to charge, so every ETA delta is a mixture. Re-openable only through §6.3. |
| **G — floor hysteresis band** (§4.2) | Breaks the documented #254 margin-disabling invariant (`motor.test.ts` 2 failed / 21); removes R3's churn by making the route 100% motor; R4 keeps all 3 mode changes and gets slower; the stay-half alone costs +1.7 min on R4 fock; all-motor R1/R5 moved -3.3 to -4.8 min through the global ring schedule, not hysteresis. |
| **C — minimum sail segment** (§4.2) | At 45 s removes zero short sail runs and doubles the metric on R3 (3 -> 5 both rigs); R5 genoa 0 -> 1 at +0.9 min attributed to the guard; at 900 s pays +3.5 to +6.0 min per row and turns R3 genoa into a 19-reversal all-motor weave; the constraint is admittedly unsound. |
| **D — post-hoc absorption** (§4.2) | Inert at 45 s (zero evidence); at 300 s moves 1 of 12 plans, relabels 75 s of sailing as motoring at a fabricated 5.79 kn for a byte-identical arrival, touches no reversal; invisible to every named guard; requires lifting the standing post-processing rule, which the ruling did not. |
| **E — presentation-only disclosure** (§4.2) | Fires on 0 of 12 rows at the only principled threshold; any threshold that fires is invented; labelling a seamanship infeasibility does not make the plan followable. |
| **F — fairway-aware routing** (§4.2) | Foreclosed by #244: no corridor input exists (`seamarks.json` 1794 `Point` features, zero corridors), the term is live and inert by absence of data, and the entry condition (an ENC product with width or maintained depth) is unmet. |
| **A larger constant "to make it bite"** (§4.3) | 45 s is below the 75 s quantum, but raising it is exactly the tuning the issue's own warning forbids; a geometric form hits the 150 s deletion ceiling, and C at 900 s shows what a binding constant costs (+5 to +29% ETA). Any re-measurement states its constant relative to the `dtS/8` quantum. |
| **Closing #354 as a #264 relitigation** (§3.4) | Refuted by measurement: the #264 archetype R1 (4/62) carries zero mode changes on both rigs; the #354 sandwiches on R3 (5/140) and R4 (5.5/120) are motor->sail->motor and charged nothing. |
| **Running the nine-arm sweep now** (§6.4) | Three arms are structurally vacuous for a mode lever (`motorEnabled: false`) and the other six run TWS 12 where mode changes exist only near dead-upwind; discriminance is unmeasured. Run the offline sandwich count first; ~93 min of solver time is otherwise at risk of proving nothing. |

## 10. Invariants checked against this recommendation

- **No post-hoc tack/route reducer** — the only candidate that is one (D) is
  rejected and the standing rule stays.
- **The 3.7 kn floor stays measured, not tuned** — G, the one candidate that
  edits the classifier, is rejected on the invariant it breaks.
- **`PlanResult` bytes do not move** — nothing ships, so no #282 sweep is owed
  by this document; the sweep obligation for any future B is stated, not
  discharged.
- **Navigability stays a query-time decision; depth is never overstated** —
  no candidate touched the mask or the gate; D's absorption re-validated depth
  and was rejected on other grounds.
- **The app is a passage-planning aid, not a navigation device** — D's
  fabricated 5.79 kn motor leg is the concrete reason a relabelling
  post-process is a safety-adjacent claim, not a cosmetic tidy.
