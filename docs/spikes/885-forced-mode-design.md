# Spike #885 — forcing motor or sail on part of a route

- **Issue:** #885 "Let the captain force motor or sail on a chosen leg or
  waypoint-to-waypoint segment" — open, milestone **v0.33.0**, type: feature /
  priority: medium / area: routing.
- **Date:** 2026-09-10. **Base:** `origin/develop @ cd5e936`.
- **Status:** Design / Recommendation. **No production code ships with this
  document** (maintainer ruling, 2026-09-10: design pass only, implementation
  deferred).
- **Verdict:** buildable, and cheaper than the issue assumes on three of the
  four questions. Q3 needs no code at all. Q1 has a **soft** form the issue does
  not consider that needs no new `SolveFailureCause` and cannot make a plan
  unroutable; the hard form is a real option but carries the whole #282 cost
  line. The representation is decided by the five sites that build or rebuild
  the via list, not by taste: a positional per-segment array desynchronises
  silently on the LIVE plan path (`usePlanFlow.ts`, which spreads the request
  while pruning the via list), so modes must be **keyed to the waypoint the
  segment arrives at**.

> Companions: [`354-mode-churn.md`](./354-mode-churn.md) (§5 below — #885 does
> not close it), [`244-buoyed-fairways.md`](./244-buoyed-fairways.md) (why the
> data must come from the user), [ADR-0002](../adr/0002-pre-1.0-db-migration-low-priority.md)
> (§6.2), and the motor decision rule spec
> `docs/superpowers/specs/2026-07-30-motor-decision-rule-design.md` (the #254
> invariant §5 must not be confused with).

---

## 0. Provenance

Every claim below was re-read at `cd5e936` from the file cited beside it.
Nothing here is measured — this is a design pass, and no route was solved. Two
consequences: every cost is an ENUMERATION of edit sites, never a timing; and
every behavioural claim is an argument from the code as written, which a first
implementation increment should falsify rather than inherit.

**One citation in the issue is stale.** It anchors the input unit at
`types.ts:251`, `viaPoints: LatLon[]`. At `cd5e936` it is `types.ts:267`,
`viaPoints: ViaPoint[]` — #846 widened the element type to an optional-superset
interface (`ViaPoint extends LatLon { name?: string }`, `types.ts:30`). That
widening is the precedent this design reuses; see §1.3.

---

## 1. The input unit

### 1.1 The issue's argument survives, for a reason it does not give

The issue argues a solver `Leg` is an OUTPUT and cannot be selected before the
route exists, so the unit must be the segment between consecutive waypoints.
That is correct, and the stronger form is structural: **the waypoint-to-waypoint
segment is already the unit the solver iterates.** `planRoute.ts`'s `run()`
loops `for (let i = 0; i < waypoints.length - 1; i++)` and calls `solve()` once
per segment, each departing at the previous segment's ETA, over
`waypoints = [origin, ...viaPoints, destination]` (`planRoute.ts`, the
`const waypoints` binding). A per-segment mode is therefore a parameter of an
existing call, not a new concept in the search.

Two properties fall out of that loop and both help:

- `mergeCollinearLegs` is called INSIDE it, per segment, so a forced segment's
  legs can never merge with a neighbour's. The override boundary is
  structurally sharp with no extra work.
- Maneuver state already resets at each via joint (`run()`'s own comment: a
  board change across a via is not charged a maneuver penalty), so a forced
  segment does not perturb maneuver accounting beyond what a via already does.

### 1.2 What the issue does not price: marking a stretch is not free

The unit is only free where a via point already sits at each end. To force a
mode on an undelimited stretch the captain must ADD two vias, and adding a via
is not neutral:

- `planRoute.ts` snaps every waypoint with `mask.snapToNavigable(...)`, which
  returns the navigable CELL CENTRE, never the input point (`mask.ts`'s
  `snapToNavigable`, whose sole point-returning statement is
  `return best ? best.p : null`, with `best.p` only ever assigned `center`). So
  the route is pulled through a moved point — up to half a ~46 m cell diagonal
  when the drop was already navigable, up to `maxRadiusM = 300` when it was not.
- Splitting one segment into three re-partitions the search into three
  sequential solves whose maneuver state resets at the joints (§1.1). The plan
  changes even if both new segments keep the default mode.

This is a real cost of the segment unit, not an argument against it — the
alternative units are worse (§7 A, B). It matters most for §5.

### 1.3 Representation: keyed, not positional — decided by the rebuild sites

Five sites build or rebuild the via list, and they disagree about it:

| Site | What it does to `viaPoints` | What that does to a POSITIONAL `segmentModes[]` |
|---|---|---|
| `state/usePlanFlow.ts` `run()` | `req = { ...req, viaPoints: dedupeViaPoints(...).kept }` — **the live path**: every Plan-route press and every recalc | **PRUNED list, unpruned array — silent desynchronisation** |
| `lib/recalc.ts` | `planViaPoints(plan.request).map((v) => ({ ...v }))` | survives only if copied explicitly; a field ON each via survives free |
| `state/reroute.ts` | builds the object field by field with `viaPoints: []` and `origin: { ...fixPoint }` | array dropped, like every other unlisted field |
| `state/replan.ts` `replanWithVias` | same spread-and-prune shape; **dormant** — its own comment records that since #571 `App.tsx` no longer calls it or `useViaReplan`, kept "as still-valid infrastructure" | same hazard, currently unreachable from the UI |
| `routing/planRoute.ts` | does not rebuild the request; `run()` closes over `req` | unaffected (§4) |

`usePlanFlow.ts` is decisive, and it is live rather than hypothetical.
`dedupeViaPoints` drops any via within `DEDUPE_THRESHOLD_NM` of its predecessor
and pops trailing ones near the destination; the request then spreads
`{ ...req }` — so a sibling positional array SURVIVES the spread while the list
it indexes SHRINKS. Modes land on the wrong segments, silently, with no type
error. The dangerous direction of that shift is forcing SAIL in the channel the
captain marked motor. `usePlanFlow.ts`'s own comment calls this call "the
actual, authoritative enforcement", so it is not a path a future refactor is
likely to remove.

**Recommendation: key each mode to the waypoint its segment ARRIVES at.**
Concretely, an optional field on `ViaPoint` (the #846 optional-superset shape,
for the reason #846 itself gives: every call site typed at the plain `LatLon`
shape keeps compiling) plus one optional scalar on `PlanRequest` for the final
segment arriving at `destination`. Then:

- `dedupeViaPoints` carries each mode with its own via (`kept.push(via)` pushes
  the object), and a dropped via takes its mode with it — correct, because the
  segment it terminated no longer exists.
- `recalc.ts`'s `{ ...v }` spread copies it with no edit.
- `reroute.ts` drops all vias and their modes, keeping the destination scalar —
  which is the RIGHT survivor: the harbour-entrance override is the motivating
  case in the issue and the one that still applies after a mid-passage reroute.
  That site spreads nothing, so the scalar needs an explicit line there.

Two implementation sites this does NOT make free, both worth budgeting now.
`App.tsx`'s via draft state is `useState<LatLon[]>([])` (`draftViaPoints`), and
since #571 a via edit is plain form state applied at the next Plan-route press,
so the UI list must widen to carry modes at all. And `dedupeViaPoints` is typed
`(origin: LatLon, viaPoints: LatLon[], destination: LatLon)`: it preserves extra
properties at RUNTIME because it re-pushes the same objects, but nothing in the
type system stops a caller from handing it freshly-built `{ lat, lon }`
literals, which would drop modes before dedupe ever runs. #846's `name` field
has the identical exposure, so the right move is to check how `name` survives
that path and follow it — see §9.4.

Inside `planRoute()` the keyed form is flattened to a positional array ONCE,
where `waypoints` is built, and indexed by the existing loop. **Keyed at rest,
positional in flight** — nothing prunes between those two points.

---

## 2. Q1 — semantics: hard constraint or preference

### 2.1 Three levers already exist; none is a new branch in the hot loop

The mode decision is one scalar resolved ONCE per solve, outside every loop
(`isochrone.ts`, the `sailFloorKn` binding):

```
sailFloorKn = motorEnabled ? max(motorThresholdKn, motorSpeedKn - sailPreferenceKn)
                           : motorThresholdKn
```

applied per candidate as `sailSpeed >= sailFloorKn ? sail : motorEnabled ?
motor : sailSpeed >= MIN_SAIL_KN ? sail : (sawCalm, skip)`. So:

- **Force motor** = `sailFloorKn = +Infinity`. Every candidate takes the motor
  branch. No new failure mode exists: motoring is always available at
  `motorSpeedKn`.
- **Force sail, SOFT** = collapse the `max` to its floor, i.e. behave as if
  `sailPreferenceKn` were unbounded. The boat then sails wherever it makes at
  least `motorThresholdKn` (2.5 kn at defaults) and motors only below that
  seaworthiness floor. **Never unroutable**, no new cause, zero #282 exposure.
  This is not a new regime: CLAUDE.md records that a margin at or above
  `motorSpeedKn - motorThresholdKn` collapses the floor back and restores the
  pre-#254 path byte-for-byte, so the soft form is the app's own pre-#254 rule
  applied to one segment rather than an invented semantic.
- **Force sail, HARD** = `motorEnabled: false` semantics for that segment —
  `MOTOR_TWAS` leave the candidate set and sub-`MIN_SAIL_KN` candidates take the
  `sawCalm` path. This is the only form that can make a plan unroutable, and the
  only one needing a new `SolveFailureCause`.

The issue presents this as hard-or-preference and does not consider the soft
form. **The discriminating question is one line: must "insist on sailing" hold
BELOW the seaworthiness floor?** If no, soft is the entire feature. If yes, the
hard form and its cost line follow.

### 2.2 Implementation shape (not a maintainer question, but it bounds the cost)

The override reaches `solve()` as an optional `SolveParams` field resolved once
per solve, modelled on `gate` — **never** as a `{ ...settings, motorEnabled:
false }` copy. That copy is precisely the pre-#452 `{ ...s, safetyDepthM }`
shape whose deletion `planRoute.ts`'s tier-3 comment records as a correctness
improvement: a spread-and-overwrite leaves an object downstream carrying a value
a later reader mistakes for the user's own setting.

**Forced motor has one contradiction, and it is a request-validation reject,
not a cause:** with global `motorEnabled: false`, `sailFloorKn = +Infinity`
falls through the disabled-motor branch to `sailSpeed >= MIN_SAIL_KN` and the
segment SAILS — the override silently inverts. Reject the request at the planner
boundary (the `snap-failed-*` returns at the top of `planRoute()` are the
existing precedent for a pre-search typed reject), or forbid the combination in
the UI. Do not let it reach the solver.

### 2.3 If the hard form is chosen: the new cause is the `budget-exhausted` shape

#282's rule is that a CLASSIFICATION change moves routes while a LABELLING
change cannot. A fifth `SolveFailureCause` is safe under exactly the argument
`budget-exhausted`'s own doc comment makes for the fourth: it is emitted only on
a path no override-free solve can reach, so **the partition of the existing four
is untouched**, and no sweep arm (none sets an override) can produce it.

Two placements, and the cheaper one suffices:

- **In `planRoute.ts`** — translate a segment's `calm-without-motor` into the
  new cause when that segment carried a hard forced-sail override AND
  `settings.motorEnabled` is true. The two are then disjoint by construction: a
  genuine global motor-off cannot reach the translation. `solve()` and
  `SolveParams` need no cause-related change. **Recommended.**
- In `isochrone.ts`, at the `if (!best)` classification. Correct, but touches
  the solver for a presentational gain.

Edit sites the hard form owes, enumerated rather than estimated: the
`SolveFailureCause` union (`isochrone.ts`); `NoRouteReason` (`types.ts`); the
`NO_ROUTE_LABEL_OF_CAUSE` row, whose `satisfies Record<SolveFailureCause,
NoRouteReason>` makes an omission a compile error rather than a silent gap; a
`combineFailureCause` precedence slot — **recommend directly below
`budget-exhausted` and above the rest**, since removing an override is more
actionable than anything currently in that order; `comfortRetryMayHelp` and
`depthRelaxationMayHelp`, which must NOT admit it (no depth gate and no comfort
retry can answer "you forbade the engine in a calm"); one `error.noRoute.*` key
in BOTH `dict.de.ts` and `dict.en.ts`; and AT LEAST these test files, which a
grep for the cause union and the two gate predicates returns —
`planRoute.reasonDecoupling.test.ts`, `planRoute.budget.test.ts`,
`planRoute.depthComfort.test.ts` and `invariants.property.test.ts`. The
hardest-edged of them is `reasonDecoupling.test.ts`, which asserts
`SOLVER_CAUSES.length` `.toBe(4)` against a LITERAL 4 — deliberately not
`Object.keys(...).length`, per its own comment — so a fifth cause reds it by
construction. (`planRoute.ts`'s comments name `planRoute.test.ts` as holding
the exhaustive four-cause table; that grep does not find the gate predicates
there, so treat the source comment as the weaker citation and re-derive the
list at implementation time.)

**Caveat that must ship with it:** the `planRoute.ts` translation inherits the
solver's death-count heuristic. `isochrone.ts` returns
`blockedDeaths >= calmDeaths && blockedDeaths > 0 ? 'mask-blocked' :
'calm-without-motor'`, so BOTH-ZERO also lands as `calm-without-motor`. The new
label can therefore mislabel a "gave up" as an impossible override — the same
limit #866 records for `mask-blocked` at that same return. Say so in the copy;
do not claim the new cause proves the constraint unsatisfiable.

### 2.4 Recommendation

**Ship SOFT force-sail and hard force-motor first; defer hard force-sail.** That
combination delivers both halves of the issue's user story, adds no
`SolveFailureCause`, cannot make a plan unroutable, and leaves the hard form
reachable later as a strictly additive second increment. Hard force-sail is the
maintainer's call (§8), decided by §2.1's question.

---

## 3. Q2 — interaction with the rig comparison

**The override applies to BOTH solves, and this is not a judgement call.**
`runAll` maps over `req.sailIds` with one `(settings, gate, comfort)` triple, so
the rigs are priced against an identical problem by construction; #243's own
comment gives the reason a tier is plan-level rather than per-rig — solving the
rigs under different objectives "would skew the recommended-rig comparison". An
override applied to one rig only would be exactly that skew.

The issue's observation stands and belongs in the copy: forced MOTOR is
rig-independent (motor legs run at `settings.motorSpeedKn`, no polar is read),
so a fully-forced-motor segment contributes identical time to both solves and
the comparison is decided entirely elsewhere. Forced SAIL is rig-dependent, and
a consequence follows that reads as a bug and is a FEATURE: under a hard forced
sail one rig can fail where the other succeeds. `SailResult` already carries a
per-sail `reason`, so that surfaces with no new shape — and it answers a
question the captain actually has, namely which rig can carry the stretch. Under
the soft form of §2.1 it cannot arise, since neither rig can fail on mode
grounds.

---

## 4. Q3 — interaction with the depth-relaxation tiers

**No code. The property already holds, and the reason is structural.**

The tier ladder varies exactly three things: `runAll(s, requestedGate,
comfortDepthM)` (tier 1) then `runAll(s, requestedGate, undefined)` (tier 2)
then `runAll(s, relaxedGate, comfortDepthM)` (tier 3) then `runAll(s,
relaxedGate, undefined)` (tier 4). `req` is never rebuilt — `run()` closes over
it for `waypoints`, `sailIds` and `departureMs` — and since #452 the `Settings`
object `s` is passed UNCHANGED at every tier, the `{ ...s, safetyDepthM:
usedDepthM }` copy having been deleted (tier 3's own comment).

So **an override on `PlanRequest` survives all four tiers by construction**, and
that is the second reason to put it there rather than on `Settings`: a field on
`Settings` also survives today, but only because no tier spreads `s` — it is one
refactor away from being clobbered, and the object that would clobber it is the
exact shape #452 removed. A regression test should pin that a forced segment's
mode is identical in a tier-4 plan and a tier-1 plan; nothing else would catch a
future re-introduction.

One interaction to state rather than assume: relaxation is gated on
`depthRelaxationMayHelp(cause)`, which admits only `mask-blocked`. A hard
forced-sail failure classified as a calm (§2.3) therefore does NOT trigger
relaxation — correct, since a shallower gate cannot supply wind.

---

## 5. Q4 — does this fix or hide #354?

**It hides it, on a route shape #354 does not measure, and it does not change
#354's disposition.** Keep them separate, for three reasons.

1. **#885 is #354's rejected candidate G with consent.** That spike rejects G
   because it "removes churn by deleting the sailing, breaking a documented #254
   invariant". A user override removes the same sailing, but the #254 invariant
   is a claim about what the SOLVER may do unasked — the margin bounds how much
   boat speed a sail-locked heading can be losing. A captain overriding one
   named segment is not the solver applying a rule, so #885 neither breaks that
   invariant nor vindicates G.
2. **The churn routes have no vias to mark.** #354's reproduction plans six
   curated routes origin-to-destination and passes `viaPoints: []` for every
   one of them (`354-mode-churn/scratch354.test.ts`, its single `viaPoints`
   occurrence); its churn appears on two routes (four of twelve rig rows,
   75-225 s sail interludes). Suppressing that churn with #885 means ADDING via
   points, which moves the route (§1.2) and re-partitions the solve. The
   captain pays a geometry change to buy a mode change.
3. **#354's open question is untouched.** Its §5 asks whether forfeiting
   1.6-2.4 min on a ~68 min passage is an acceptable price for removing one
   150-225 s sail interlude — a judgement about what a plan is for, which #885
   does not answer for the general case. It only lets one captain answer it for
   one passage. (`354-mode-churn.md` contains no occurrence of "forced" or of
   #885 at `cd5e936`; the two documents currently do not reference each other.)

**Recommendation: shipping #885 leaves #354 open, and should not move it off
Backlog.** Whether it lowers #354's priority is the maintainer's call (§8) — the
honest input is that #885 gives a manual workaround at a geometry cost, for
passages the captain has already identified, which is not the population #354 is
about.

---

## 6. Costs, priced

### 6.1 The #282 sweep is OWED, and expected to be byte-identical

Verdict at `cd5e936`, verbatim:

```
IN_CLOSURE      app/src/types.ts  (import walk)
  via app/sweep/sweepArms.ts
  via app/src/types.ts  (import '../src/types')
```

So a field on `PlanRequest` or `Settings` owes the full run — BASE double-run
control plus BASE-vs-HEAD across every arm, i.e. three arm-sets. CLAUDE.md's
rule is that OWED is authoritative and gets paid; nothing below argues for
skipping it.

**Budget it from the README, not from the issue.** The issue says "roughly 3
hours detached, per `app/sweep/README.md`"; that README does not say 3 hours.
What it records is ONE arm-set at **2184.14 s wall** (11 arms,
`fileParallelism`, slowest single arm 2048.7 s), explicitly measured under
that session's own concurrent multi-agent load rather than on a quiet machine,
and it warns that its former `~20 minutes` figure is stale. Three arm-sets at
that figure is ~1.8 h loaded; the issue's 3 h is a safe upper bound but is the
issue's own number. Re-measure rather than inherit either — per CLAUDE.md,
counts are load-independent and durations are not.

What IS worth stating in advance is the expected RESULT, so a non-identical arm
reads as a red flag rather than an accepted diff: **every arm should be
byte-identical.** `sweepArms.ts` serialises `rows[h.id] = planRoute(...)`, i.e.
the `PlanResult` alone (its own comment: "`PlanResult` carries no `request`
field"), and every arm builds its request with `viaPoints: []` and either
`DEFAULT_SETTINGS` or a spread of it — so no arm sets an override, an absent
optional field changes no solver input, and one segment is solved exactly as
today. Any arm that moves means the change is not the additive one this document
describes.

### 6.2 IndexedDB: neither of the two options the issue names

The issue offers a breaking change with dropped records, or a fail-closed
read-site guard. **Recommend a third thing, which ADR-0002 already sanctions and
which this repo already implements for the sibling field.**

Make the field OPTIONAL, absence meaning "no override". An old record lacking it
is then not a migration problem at all: absence IS the pre-feature behaviour, so
nothing is dropped and nothing is fabricated. ADR-0002's boundary section is
explicit that it "waives migration machinery" but "does NOT waive defensive
reads", and that failing closed "must never mean falling back to a fabricated
default". Both hold — there is no default to fabricate.

The read-site pattern is already in the tree: `migratePlan.ts` normalises an
absent or malformed `viaPoints` via `normaliseViaPoints` and returns `null` (an
honestly-unreadable record, never a deletion) when it is malformed. A
forced-mode field takes the same two branches — absent normalises to "none",
malformed rejects the record. That is one guard, not migration machinery.

Residual, worth writing down rather than discovering: `reroute.ts` builds its
request field by field, so a Live reroute drops every via-keyed override (§1.3).
A captain who set one and then reroutes gets a plan without it. The failure
direction is benign for forced MOTOR (the planner reverts to the speed rule),
and it is why the destination-inbound scalar is worth keeping separate.

### 6.3 `PlanResult` must not gain a field — and need not

The override is a property of the REQUEST, and the plan already stores its
request. The legs table already distinguishes motor from sail via `Leg.kind`, so
"this stretch was forced" is presented from `plan.request`, beside where it was
set, rather than by marking legs. This is #846's own resolution —
presentation-only, `PlanResult` byte-identical, sweep baseline still comparable
— and it is what keeps §6.1's expected verdict true.

---

## 7. Considered and rejected

**A. Force a mode on a solver `Leg`, then re-plan.** Rejected: a `Leg` is an
output of the search, so there is nothing to select before the route exists, and
the leg identities do not survive the re-plan the override would trigger. This
is the issue's own argument and it holds (§1.1).

**B. Force a mode by GEOGRAPHY — a user-drawn box or corridor, mode by position
rather than by segment.** Genuinely attractive, with a precedent: `DepthGate` is
already a position-dependent per-cell policy resolved once per solve and read
via `gateAtCell(gate, row, col)` on `mask.ts`'s hot paths, so the cost profile
is known rather than speculative — a mode field could be hoisted to one lookup
per frontier NODE, the same order as the existing per-node `wind.sample`.
Rejected for THIS increment on scope, not feasibility: it needs a map-geometry
editor the app does not have, a second persisted shape, and its own answer to
what happens when a region only partly covers a leg. Reconsider it if §1.2's
"adding vias moves the route" cost is what users actually complain about.
Recorded here so it returns as a deliberate follow-up rather than a fresh idea.

**C. Put the override on `Settings`.** Rejected: `Settings` is per-user
preference, the override is per-route geography, and a plan-shaped fact stored
in the settings object would apply to every subsequent plan. It also sits one
`{ ...s, X }` refactor away from the shape #452 deleted (§4).

**D. A positional `segmentModes[]` array on `PlanRequest`.** Rejected on
evidence: `replan.ts` spreads the request while pruning `viaPoints` through
`dedupeViaPoints`, so array and list desynchronise with no type error, in the
direction that forces sail where the captain wanted motor (§1.3).

**E. Widen `PlanRequest.destination` to `ViaPoint` so all modes live on arrival
points uniformly.** Structurally safe — every consumer reads `.lat`/`.lon` — and
tempting for symmetry. Not recommended: it makes the destination a "via point"
in name, and the one scalar it saves is cheaper than the rename needed to keep
the vocabulary honest. Listed because it will occur to the implementer.

**F. Emit the new cause from `isochrone.ts`'s classification.** Correct, but it
touches the solver to gain a label; the `planRoute.ts` translation is equivalent
for the user and leaves the solver's vocabulary unchanged (§2.3).

**G. Infer the forced-motor stretches from chart data instead of asking.**
Foreclosed by #244, which measured the in-region fairway data unusable: zero
width/depth/draft tags on 258 ways, 51.2% explicitly `boat=discouraged`. Not
re-opened here.

---

## 8. What the maintainer decides, and what this document recommends

**Maintainer's, because they are product judgements no measurement settles:**

1. **Must "insist on sailing" hold below the `motorThresholdKn` seaworthiness
   floor?** (§2.1.) NO ⇒ soft force-sail is the whole feature and the
   `SolveFailureCause` question disappears. YES ⇒ the hard form ships with the
   §2.3 cost line and its mislabelling caveat.
2. **Does shipping #885 lower #354's priority?** (§5.) This document's input: it
   should not close it, and the workaround costs a geometry change on the route
   shapes #354 measures.
3. **Whether the geographic form (§7 B) is the real want**, in which case the
   segment form is an increment toward it rather than the destination.

**Recommended here, and offered as implementer-decidable:**

4. Input unit: the waypoint-to-waypoint segment (§1.1).
5. Representation: keyed to the ARRIVING waypoint — optional field on
   `ViaPoint` plus one scalar on `PlanRequest`, flattened to positional inside
   `planRoute()` (§1.3).
6. Override applies to BOTH rig solves (§3) — forced by the existing
   apples-to-apples requirement, not a free choice.
7. Relaxation tiers need no work; add the tier-1-vs-tier-4 regression pin (§4).
8. Reach the solver as an optional `SolveParams` field modelled on `gate`, never
   a `Settings` spread (§2.2).
9. Forced motor under global `motorEnabled: false` is a pre-search request
   reject, not a `SolveFailureCause` (§2.2).
10. Storage: optional field, absent means none, malformed rejects the record —
    no migration machinery, no dropped records, no fabricated default (§6.2).
11. `PlanResult` unchanged; the override is presented from the request (§6.3).

---

## 9. Open holes in this document

1. **Nothing here is measured.** In particular, the claim that forced motor is
   rig-independent in the SOLVED result (not merely in the leg speed) assumes
   the two rigs' searches through a fully-motored segment coincide; both rigs
   still generate sail-angle candidates that resolve to `kind: 'motor'`, so the
   candidate SETS are equal, but this was not run. A first increment should
   solve one segment both ways and compare rather than inherit the claim.
2. **The soft form's user-visible effect is unquantified.** How often collapsing
   `sailFloorKn` to `motorThresholdKn` actually changes a plan on a real route
   is unknown; if it rarely does, the feature under-delivers on "insist on
   sailing" and question 1 in §8 is decided by that rather than by principle.
3. **The UI is out of scope.** How a captain selects a segment, and what the
   affordance looks like on a tablet, is not designed here; #1170's armed
   "Add waypoint" mode is the nearest precedent, and #846 supplies the names
   that make a segment nameable in a control.
4. **"Survives by construction" is scoped to `dedupeViaPoints` itself, not to
   the whole path into it.** That function re-pushes the caller's own objects,
   so extra properties survive it; but its parameter is typed `LatLon[]`, and
   `App.tsx`'s `draftViaPoints` is `useState<LatLon[]>`, so a caller that
   rebuilds `{ lat, lon }` literals anywhere upstream drops the modes before
   dedupe runs — with no type error. This was NOT traced end to end here.
   #846's `name` field has the identical exposure and shipped, so the cheap
   first step is to establish how (or whether) `name` survives an edit-then-plan
   round trip today, and treat that as the contract rather than re-deriving one.
