# Issue #243 — design: routing crosses shallow water when a deeper route was free

> **PRESERVED RECORD — read this note before anything below it.** This
> document was the ONLY design document #243 (depth comfort margin, shipped
> v0.6.0) ever had. It was written 2026-07-27 in the (gitignored)
> `.superpowers/` SDD ledger and was moved into this repository's tracked
> `docs/spikes/` on 2026-08-28, verbatim, with no edits to its body — a
> spec-coverage audit found that most shipped features have no design
> document at all, and that this second tier of design records is invisible
> on a fresh clone. **Every claim below describes the state of the code, the
> mask, and the solver as they were on 2026-07-27, at `develop` @ `14fea97`
> — NOT the state of the repository today.** Line numbers, file layouts,
> measured figures (route distances, durations, cell counts) and even
> whether cited functions still exist may all have moved since. Where a
> later CLAUDE.md bullet or spike doc corrects or narrows a claim made here
> (`#452`'s per-cell relaxation, `#455`'s mask-tolerance work, and #612 are
> three that are known to touch the same code paths — see
> `docs/spikes/452-local-depth-relaxation.md`,
> `docs/spikes/455-depth-mask-optimism.md`, and CLAUDE.md's "disclosure
> stack" bullet), that later source governs. Do not treat an undated claim
> in the body below as current-state fact.

---

Design pass, 2026-07-27. Base: `develop` @ 14fea97, tree clean, **no tracked file
modified**. Every number below was measured against the **real committed mask**
(`app/public/data/mask.bin`, 2200×2400 cells, ~46 m) and the **real committed
polars**, driving the repo's own `planRoute`/`solve` from a throwaway Node
harness in the session scratchpad.

> **Read §C.1, §D and §D.5 first if you read nothing else.** The obvious form of
> the obvious fix was measured to **lose a route that works today**. The design
> below is the form that survived measurement, plus a fallback that makes route
> loss structurally impossible.
>
> **CORRECTION (added after review).** §D as originally written recommends the
> *clock* encoding. That encoding **breaks the solver's wall-clock semantics** —
> node clocks stop being elapsed time, which corrupts wind sampling, the horizon
> guard, the displayed ETA and every per-leg timestamp the UI renders. I did not
> catch this during the measurement pass; it was raised in review and it is
> correct. **§D.5 supersedes the encoding choice in §D.1.** Everything else in
> §D — the comfort depth anchored to the REQUESTED gate, the parameter values,
> the fallback ladder — stands.

---

## A. Mechanism confirmation

### Mechanism 1 — "depth is a binary gate; the cost function is pure time" — **CONFIRMED**

Depth enters the solver at exactly four points, always the same boolean at the
user's gate, never as a cost:

`app/src/routing/isochrone.ts:221` (direct arrival), `:252` (full step), `:266`
(substep retry), `:309` (endpoint-capture hop) — all of the form
```ts
mask.segmentNavigable(from, end, settings.safetyDepthM)
```
plus a fifth the issue does not list, `app/src/routing/postprocess.ts:12`, in the
collinear-merge re-validation:
```ts
if (!mask.segmentNavigable(a.start, b.end, s.safetyDepthM)) return null;
```

`app/src/lib/mask.ts:115-117` is the whole depth semantic, and `cellNavigable`
(`mask.ts:67-71`) is `b !== LAND && byteToDepthM(b) >= safetyDepthM`.

The cost side confirms the other half — there is **no depth term in the
objective**:
- `isochrone.ts:215` — `const distNm = (speed * effS) / 3600;`
- `isochrone.ts:211-214` — the *only* cost modifier, the maneuver penalty,
  charged by shortening effective travel time:
  ```ts
  maneuver = classifyManeuver(node.twaSigned, twa);
  effS = Math.max(dtS - settings.maneuverPenaltyS, 0);
  ```
- `isochrone.ts:107-116` — `better()` ranks on `tMs`, `maneuvers`,
  `distToDestNm`, `headingDeg`, lat/lon. No depth axis.
- `isochrone.ts:82-84` — `visitedDominates` is a componentwise minimum over
  `{tMs, maneuvers}`. No depth axis.

A cell at exactly the gate and a 25 m cell are literally indistinguishable to the
objective, exactly as the issue states.

### Mechanism 2 — "the #53 relaxed gate is applied to the WHOLE route" — **CONFIRMED, with a scoping correction and a measured magnitude**

`app/src/routing/planRoute.ts:200-207`:
```ts
if (reason === 'unreachable' && s.safetyDepthM > BOAT_DRAFT_M) {
  const usedDepthM = findRelaxedDepthM(mask, waypoints, s.safetyDepthM, onProbe);
  if (usedDepthM !== null) {
    const relaxed = runBoth({ ...s, safetyDepthM: usedDepthM });
```
`runBoth` → `run` → `solve({ ..., settings })` (`planRoute.ts:112-121`), so
`usedDepthM` becomes *the* gate for every edge of every segment of both rigs.
`flagShallowLegs` (`planRoute.ts:58-78`) only *labels* the result afterwards;
geometry is never reshaped.

**Correction to the issue's framing.** The issue reads as though relaxation could
degrade an otherwise-fine plan. It cannot: `planRoute.ts:182-191` runs the strict
solve first and returns immediately if either rig succeeds, so the relaxed solve
runs **only when the requested gate produced no route at all**. Mechanism 2 is
therefore not "routes get relaxed unnecessarily" but the narrower, still-real
"once relaxation is unavoidable, the *entire* passage is licensed at the relaxed
gate, including stretches where 15 m was free."

**Measured magnitude.** Flensburg → Marstal at `DEFAULT_SETTINGS` (the #53 spec
acceptance case) relaxes to `usedDepthM = 2.3` and then spends **1.33 nm of its
44.93 nm below the requested 3.0 m**. With the comfort depth anchored to the
**requested** depth (§D), the same passage, same relaxed gate, spends
**0.23 nm** — so **≈83 % of today's sub-requested-depth exposure on that passage
is unnecessary**, bought for +1.6 % ETA.

**What #53 actually needed, and the correct scope.** Marstal's snap cell sits in
a 119-cell pocket that 4-connects to open water only at gate ≤ 2.3 m, because
EMODnet at 46 m cells cannot resolve the dredged approach (#9,
`CONNECTIVITY_EXCEPTIONS_M` in `pipeline/verify_mask.py`). #53 needed **a lower
gate at the pocket mouth**; it took **a lower gate everywhere**. The correct
scope is "relaxed where the mask forces it, requested-depth-preferring
everywhere else".

**The fix must not re-break #53**: relaxation must still find the route, both
rigs must still use the same single gate (`planRoute.ts:203` — apples-to-apples
by construction), the gate must never go below `BOAT_DRAFT_M`, and
`settings.safetyDepthM` must stay unmutated.

### Mechanism 3 (issue §3, data caveat) — **CONFIRMED as stated, not a cause**

`pipeline/build_mask.py` blends `Resampling.max` with `Resampling.bilinear`,
trusting bilinear wherever the two agree within `TOLERANCE_M = 2.0`. A cell
reading 3.0 m is not a guaranteed shallowest-in-footprint reading. Not the cause,
but it is the quantitative anchor for the recommended default (§D).

---

## B. The current cost model, precisely

**Shape of the search.** `solve` (`isochrone.ts:118-380`) is a *time-layered
frontier expansion*, not Dijkstra/A*. Each ring advances one global clock by
`dtS` — 600 s, or 300 s within 5 nm, or 150 s within 2 nm of the destination
(`isochrone.ts:156`). Every frontier node expands over that same `dtS`; the child
clock is `node.tMs + stepMs` (`:283`), `stepMs = dtS * 1000` unless a substep
fitted.

**How cost is expressed.** Because the clock advance is fixed per ring, cost is
not *added* to a node — it is charged by making the node cover **less ground per
ring**. That is exactly the maneuver penalty (`:210-215`). This is the only cost
lever the architecture has, and CLAUDE.md's "tack/gybe minimization emerges from
the maneuver time penalty inside the isochrone cost" is a statement about it.

*(Note for §D: `stepMs` is a **per-child** quantity, and substepped children
already carry earlier clocks than their ring — so "charge the clock" is an
equally native second lever, and it turns out to be the safer one.)*

**Every place depth is consulted** (complete):

| Site | Purpose | Gate used |
|---|---|---|
| `isochrone.ts:221` | direct-arrival hop admission | `settings.safetyDepthM` |
| `isochrone.ts:252` | full-step admission | `settings.safetyDepthM` |
| `isochrone.ts:266` | substep-retry admission (÷2, ÷4, ÷8) | `settings.safetyDepthM` |
| `isochrone.ts:309` | endpoint-capture hop admission | `settings.safetyDepthM` |
| `postprocess.ts:12` | collinear-merge re-validation | `settings.safetyDepthM` |
| `planRoute.ts:89,91,96` | origin/dest/via snapping | `s.safetyDepthM` — the **requested** depth, never the relaxed one |
| `planRoute.ts:169`, `relaxedDepth.ts:49` | connectivity BFS (fast path + relaxed-gate probes) | probe depth |
| `planRoute.ts:66` | `flagShallowLegs`, labelling only | requested depth |

**How `safetyDepthM` flows.** `Settings.safetyDepthM` (`types.ts:12`, default 3.0
at `types.ts:35`) → `PlanRequest.settings` → `planRoute`'s `s` → snapping and the
connectivity pre-check at the requested value → `solve` at either the requested
value (`planRoute.ts:184`) or the relaxed value (`:203`). Persisted settings are
merged `{ ...DEFAULT_SETTINGS, ...persisted, ...pending }` at
`app/src/state/AppState.tsx:88`, so **a new `Settings` field with a default is
backfilled automatically** — no migration.

**How the relaxed gate interacts.** A whole-`Settings` substitution
(`{ ...s, safetyDepthM: usedDepthM }`), per plan, never written back. Note the
asymmetry that already exists deliberately: snapping stays at the **requested**
depth while the solve runs at the **relaxed** depth. §D exploits exactly that —
it keeps a second, requested-depth-derived quantity alive inside the relaxed
solve.

**Cost of a depth query.** `segmentNavigable` and `segmentShallowestBelow`
(`mask.ts:115`, `:129`) walk the *same* cells through the same private
`walkCells` Amanatides–Woo traversal (`mask.ts:79-112`). Measuring clearance is
therefore free if fused into the navigability walk: same cells, one extra
comparison each, early abort on a below-gate cell preserved. Load-bearing for
§D's runtime claim, and **measured**: wall-clock is unchanged within run-to-run
noise (Flensburg→Sønderborg 2.6 s base vs. 2.7 s; Faaborg→Faldsled 7.1 s vs.
7.2 s) even though the prototype used a *separate, unfused* extra walk.

---

## C. Options considered

Throughout: *reachability* = "the set of passages that produce a route at all",
which is what #53's and #9's acceptance criteria depend on.

### C.1 — Option 1: a soft depth-margin term inside the isochrone cost

Give the solver a **comfort depth** `comfort = requested safety depth + margin`.
For each candidate edge take the *minimum* charted clearance over the cells it
sweeps, and charge a bounded penalty:

```
shortfall = clamp((comfort - clearance) / (comfort - gate), 0, 1)
factor    = 1 - DERATE_MAX * shortfall            // 0 < factor <= 1
```

There are **two ways to spend `factor`**, and the difference turned out to be the
whole ballgame:

**(a) Distance encoding** — keep the ring clock, shorten the step:
`end = destinationPoint(from, heading, distNm * factor)`.
**(b) Clock encoding** — keep the geometry, charge the child's clock:
`stepMs = dtS * 1000 / factor`.

Both express "shallow water is slow". Both are bounded (`factor > 0`), so **no
edge that was admissible becomes inadmissible** — I initially took that as a
proof that reachability is preserved.

**That proof is wrong, and measurement caught it.** Edge admissibility is not
search success. The expansion keeps **one node per `pruneKey` bucket**
(~220 × 190 m, `isochrone.ts:61-64`, `byKey` at `:328-329`), seals buckets via
`visitedDominates`, and caps the frontier at `MAX_FRONTIER`. Encoding (a) *moves
every child's position*, which reshuffles which candidate wins each bucket — and
in a sub-cell pinch like Marstal's pocket mouth, where the route survives only
because a `dtS/8` substep happens to fit, landing short can strand the node.
Worse, (a) applies the derate *after* the fit test, so the accepted child is not
the child that was proven to fit.

Measured, at margin 2.0 m / derate 0.30:

| passage | shipped solver | encoding (a) distance | encoding (b) clock |
|---|---|---|---|
| Bagenkop → Marstal, `DEFAULT_SETTINGS` | **ok** (genoa; fock null) | **ERROR `unreachable` — ROUTE LOST** | **ok, both rigs** |
| Flensburg → Marstal @ explicit 2.3 m | ok, both rigs | ok but **fock rig lost** (`unreachable`) | **ok, both rigs** |
| Flensburg → Sønderborg 270° | min 3.1 m, 1.32 nm < 4 m | min 4.3 m, 0.00 nm | **min 4.1 m, 0.00 nm** |
| Flensburg → Sønderborg 090° | min 3.1 m, 0.84 nm < 4 m | min 3.6 m, 0.00 nm | **min 4.7 m, 0.00 nm** |

Encoding (a) was also **non-monotone** in strength — Flensburg → Marstal @ 2.3 m
kept both rigs at derate 0.40 but lost the fock rig at 0.30 — which is the
signature of a search-capacity effect rather than a systematic gradient, and is
itself a reason to distrust it.

Encoding (b) recovers both losses, matches or beats (a) on shallow exposure at
comparable time cost, and in one case *recovers a rig the shipped solver itself
loses* (Bagenkop → Marstal fock). It leaves `distNm`, the fit tests and the whole
substep ladder **bit-identical to today**; only `child.tMs` moves — a quantity
`better()`, `visitedDominates` and both termination guards already understand,
and which substepped children already vary.

Other properties (both encodings):
- **Interaction with the maneuver penalty.** They compose without ever cancelling
  an edge: the maneuver penalty shortens `effS`, the depth factor scales
  separately. An *additive seconds* penalty would be unsafe here — it could drive
  `effS` to 0 and hit `if (distNm <= 0) continue` (`:216`) or `if (d <= 0) break`
  (`:264`), deleting the only edge through a pinch. Neither multiplicative form
  can.
- **Rigs.** The factor is mask-only and rig-independent, applied identically to
  both solves, so the comparison stays apples-to-apples. Measured routes differ
  per rig, so measured time costs differ — same as for the maneuver penalty.
- **Fixes mechanism 2 for free**, if `comfort` derives from the **requested**
  depth rather than the relaxed gate: a #53-relaxed solve then still prefers
  ≥ requested+margin water everywhere and pays the penalty only where the mask
  forces it. That is localization of the relaxation *in the cost* — which is what
  CLAUDE.md requires ("A depth preference belongs in the cost or in the gate
  selection, not in a cleanup pass").

### C.2 — Option 2: lexicographic clearance tie-break among near-equal-time candidates — **rejected**

*Structural:* the only home for a tie-break is `better()` (`isochrone.ts:107`),
which arbitrates only **within one prune bucket** and within the frontier cap.
Two genuinely different routes — over the shoal vs. around it — do not meet in one
bucket until they have already converged. Making the preference act across rings
means carrying path-minimum clearance on `Node` and adding a third axis to
`visitedDominates`, converting a componentwise-minimum test into a 3-D Pareto
front — a frontier-size multiplier against a `MAX_FRONTIER` that exists precisely
because frontier size is already a problem.

*Empirical:* it fires only on ties, and the measured shallow routes are **not
tied — they are faster**. Flensburg → Sønderborg at gate 3.0 m beats the
4.0 m-gate route by 167 s. A tie-break cannot move a route that is winning.

### C.3 — Option 3: raise the effective gate, keep a relaxed fallback — **rejected as the primary fix**

Solve at `safetyDepthM + margin`; on failure fall back to `safetyDepthM`; then
#53's relaxation. Zero solver changes; the §E.1 ladder shows it yields the
desired geometry.

It is **mechanism 2 in a mirror**: all-or-nothing per passage, so one unavoidable
pinch — Marstal's approach, Ærøskøbing's buoyed channel through flats, any
harbour entrance — drops the **whole** passage back to the bare gate and discards
the preference on every open-water stretch where it was free. That is the defect
this issue is about. It also multiplies solver runs by up to 3× per rig on
*every* plan, and solver time is the app's dominant worker cost (measured
0.1–63 s per plan here).

The issue's direction 3 ("binary-search the gate upward within an ETA tolerance")
is the same idea at O(log n) *full solves* per rig — strictly worse on the axis
that already hurts.

**However**, Option 3's fallback *structure* is exactly what Option 1 needs as a
safety net. See §D.

### C.4 — Option 4: bake a margin into the mask — **rejected outright**

Violates CLAUDE.md's hard rule that navigability is decided at query time and
that safety depth must never require regenerating data. Named only to close it
off.

---

## D. Recommendation

**Option 1 with the CLOCK encoding (C.1b), the comfort depth anchored to the
REQUESTED safety depth, and a mandatory un-preferenced fallback solve.**

### D.1 — The three pieces

**1. Clock-charged comfort preference.** In `solve`, replace the four
`segmentNavigable` calls with one `edgeFactor(a, b): number | null` helper
(`null` = blocked, identical to `segmentNavigable === false`), and spend the
factor on the clock:
- full step: `stepMs = (dtS * 1000) / factor`
- substep: `stepMs = (subDtS * 1000) / factor`
- direct-arrival ETA (`:223`) and capture-hop ETA (`:304-305`): divide the travel
  term by `factor` (equivalently, use `speed * factor`).

Geometry — `distNm`, every fit test, the whole substep ladder — is **unchanged**.

**2. Comfort depth from the requested gate.** `planRoute.ts` passes
`comfortDepthM: s.safetyDepthM + s.depthComfortMarginM` using **`s`, the
requested settings, in BOTH the strict solve (`:184`) and the relaxed solve
(`:203`)**. That single argument is the entire mechanism-2 fix.

**3. Fallback ladder — the part that makes route loss impossible.** Because §C.1
proved by measurement that "no edge removed" does **not** imply "no route lost",
do not rely on the argument. In `planRoute`, whenever a solve attempt fails with
reason `unreachable` while the preference was on, **redo that attempt with the
preference off** before moving to the next tier:

| tier | gate | preference | note |
|---|---|---|---|
| 1 | requested | on | the common case; nothing extra is paid |
| 2 | requested | **off** | *bit-identical to today's `planRoute.ts:184`* |
| 3 | relaxed (#53) | on | mechanism-2 fix |
| 4 | relaxed (#53) | **off** | *bit-identical to today's `planRoute.ts:203`* |

Tiers 2 and 4 are today's exact solves, so **any plan that routes today still
routes** — by construction, not by argument. Extra solver runs are paid **only on
failure**, never on the happy path (contrast Option 3, which pays on every plan).

Two details:
- **Decide the tier at plan level, not per rig.** If *either* rig fails with the
  preference on, redo **both** without it. Otherwise the two rigs would be costed
  under different objectives and the recommended-rig comparison would be skewed —
  violating the spirit of #53's "genoa/fock stay apples-to-apples by
  construction". (This is why tier 2 exists as a tier rather than a per-rig
  retry.)
- **Only `unreachable` falls back**, mirroring #53's own rule that only
  mask-unreachability degrades; `calm-motor-off` and `beyond-horizon` keep their
  classes and must not trigger a pointless re-solve.

### D.2 — Parameters

| name | value | kind |
|---|---|---|
| `depthComfortMarginM` | **2.0 m** (0 = feature off) | **new `Settings` field**, user-tunable |
| `DEPTH_DERATE_MAX` | **0.30** | fixed constant in `isochrone.ts` |
| ramp | linear in shortfall | fixed |

At defaults: *water ≥ 5.0 m is free; water at exactly the 3.0 m gate costs 1/0.70
≈ 1.43× the time to cross; linear in between.*

**Why 2.0 m for the margin.** Not chosen for feel — it is the pipeline's own
stated depth uncertainty. `build_mask.py` accepts the bilinear value over the
`Resampling.max` (shallowest-contributing-source) value whenever the two agree
within `TOLERANCE_M = 2.0`, so a cell reading *D* can correspond to a shallowest
source reading as low as *D* − 2.0 m. A 2.0 m margin is exactly "prefer water
whose reading is trustworthy at the gate even under the pipeline's own worst
accepted blend error." Two independent checks:

- **Selectivity, measured on the shipped mask.** Of the 2 473 845 cells navigable
  at 3.0 m, only **5.4 %** (134 150) lie in the 3.0–5.0 m band. The preference
  touches a twentieth of the searchable water — a preference, not a blanket tax.
  (1.0 m margin → 1.4 %; 3.0 m → 8.3 %.)
- **Measured effect.** 1.0 m and 1.5 m are too narrow to move the route; 2.5 m
  starts causing harm (Flensburg→Glücksburg at 135° regressed from 5.0 m minimum
  to 3.9 m). See the sweep in §E.3.

**Why 0.30 for the strength.** It must exceed the time advantage the shoal
shortcut buys (measured 0.4–1.6 % of passage time) or nothing moves, and stay
well below 1. On the 13-case sweep, **2.0 m / 0.30 gave the lowest residual
shallow exposure of any setting with zero regressions on either metric, at lower
total time cost than 0.40** (§E.3). Above it the response degrades: at 0.50 two
cases got *worse* shallow exposure than baseline, which is over-driving the
search, not preferring depth.

A quadratic ramp was measured and is **worse** — it softens exactly the mid-band
where the decision is made. Keep it linear.

**Why the margin is a setting and the strength is not.**
- The margin is **in metres of water** — the sailor's own unit, directly
  analogous to the safety depth they already set and directly inspectable against
  the depth overlay and depth profile. The issue explicitly requires
  configurability; this is the knob that deserves it.
- The strength is dimensionless with no seamanlike meaning; exposing it invites
  users toward the region where §C.1's search-capacity effects bite.
- `depthComfortMarginM: 0` disables the feature exactly (the `derateMax <= 0`
  short-circuit restores the untouched `segmentNavigable` path) — an honest
  escape hatch and the cleanest test lever (§G.5).
- **No data regeneration**: the comfort depth is a query-time quantity computed
  from a setting, exactly like the safety depth.
- **Backfill is automatic** via `AppState.tsx:88`.

### D.3 — Placement (what the implementer changes)

1. `NavMask.segmentClearanceM(a, b, gateM): number | null` next to
   `segmentNavigable` (`mask.ts:115`) — one `walkCells` pass returning the minimum
   charted depth over swept cells, or `null` when any cell is below the gate
   (i.e. exactly `segmentNavigable === false`). Deep-capped byte 255 contributes
   25.4 m and is never shallow, mirroring `segmentShallowestBelow`'s documented
   rule — **never** infer the cap from `depthM === 25.4`. `segmentNavigable`
   stays, for `postprocess.ts` and the existing tests.
2. `SolveParams.comfortDepthM?: number` in `isochrone.ts`. **Absent ⇒ no
   preference ⇒ byte-identical behaviour to today.** This is what leaves every
   synthetic-mask solver test untouched, and it is also how tiers 2 and 4 are
   expressed.
3. In `solve`: the `edgeFactor` helper + the clock changes in D.1.
4. `planRoute.ts`: the comfort argument (D.1 piece 2) and the tier ladder
   (piece 3).
5. `types.ts`: `depthComfortMarginM: number` on `Settings`, `2.0` in
   `DEFAULT_SETTINGS`; `OptionsPanel` field; de/en keys in **both** dicts
   (`satisfies Record<MsgKey, string>` enforces parity).

**Measurement order matters and must be commented.** Clearance is measured on the
segment the fit test accepted, and with the clock encoding that *is* the traversed
segment — so unlike the distance encoding there is no prefix/measurement mismatch
and no fixed-point iteration. One walk, exact charge.

### D.4 — Residual risks (state these in the PR; do not paper over them)

- **The reachability argument is not a proof — the fallback ladder is.** §C.1
  measured a real route loss from a form of this change whose "no edge removed"
  argument was airtight. The clock encoding removes the mechanism that caused it
  and lost nothing in testing, but the same class of effect (bucket sealing via
  `visitedDominates`, `MAX_FRONTIER`, the two termination guards) still exists.
  **Do not ship the preference without tiers 2 and 4.**
- **Forecast horizon.** Later clocks ⇒ `node.tMs + stepMs > horizonMs` (`:278`)
  and `minTMs + dtS * 1000 > horizonMs` (`:157`) trip sooner. A passage finishing
  within a hair of the horizon could return `beyond-horizon`. Not observed
  (worst measured cost +6.4 %), and `beyond-horizon` is *actionable* for the user
  unlike `unreachable` — but tier 2 only catches `unreachable`, so consider
  whether `beyond-horizon` should fall back too. **Open question for the
  implementer; I lean yes**, since a horizon failure caused by our own preference
  is not an honest forecast-horizon statement.
- **`postprocess.ts` merging is not preference-aware.** `mergeCollinearLegs`
  re-validates at `s.safetyDepthM` only, so a merge can straighten two legs
  across a shallower corner than either crossed, partially undoing the
  preference. It cannot violate the *gate* (it re-validates), so this is a
  quality gap, not a safety hole — but it is the same defect class and belongs in
  this PR: pass the comfort depth in and reject merges that worsen the merged
  span's clearance.
- **Minimum vs. integral.** The factor prices each edge's minimum but composes
  over edges, so the route-level quantity optimized is closer to an integral of
  shortfall than to the route minimum. At 0.30 no measured case regressed on
  either, but they can diverge — §G pins both.
- **The parameter sweep was run on the distance encoding.** 2.0 m / 0.30 was then
  spot-checked on the clock encoding with equal-or-better results (§E.4), but the
  implementer should **re-run the sweep on the final encoding** before locking the
  constant.
- **Recommended rig can flip.** Both rig results stay user-visible, but a plan's
  recommendation may change from today's. Expected, not a defect — worth a
  CHANGELOG line.

### D.5 — CORRECTION: the clock encoding breaks wall-clock semantics; separate cost from time

Raised in review, verified against the code, and **not caught by any measurement
I ran** — my harness compared routes, exposure and wall-clock runtime, none of
which can see a corrupted *model* clock. It is a real defect in §D.1's encoding
choice.

**The precise statement** (the problem is not generic to "a depth penalty in the
cost" — it depends entirely on how the penalty is spent):

- **Distance encoding (`isochrone243.ts`)** — `stepMs` untouched, step shortened.
  Node clocks stay exactly today's true elapsed time. Wind sampling, the horizon
  guard, ETA and leg timestamps are all still honest. The fiction is confined to
  *boat speed* over the shallow stretch, and the app already emits legs whose
  speed is not the polar speed (motor legs at `motorSpeedKn`). **Semantically
  clean — but this is the encoding measured to lose a route (§C.1).**
- **Clock encoding (`isochroneClock.ts`)** — `stepMs = (dtS * 1000) / factor`.
  Geometry is honest, but `Node.tMs` is no longer elapsed time, and `tMs` is
  load-bearing in at least four places beyond ranking:
  1. `isochrone.ts:165` — `wind.sample(from, node.tMs)`: a node that crossed
     shallow water samples the forecast at the **wrong hour** from then on, and
     the error compounds along the branch.
  2. `isochrone.ts:157, 278` — the horizon guards compare an inflated clock to
     `wind.horizonMs()`, so `beyond-horizon` starts firing on passages that fit.
  3. `solve`'s returned `etaMs` — displayed as the plan ETA, and inflated.
  4. `backtrack` (`isochrone.ts:382-436`) — every leg's `startTimeMs`/`endTimeMs`,
     hence the depth profile's per-instant wind hour, the Live view's ETA
     projection along the route, and the stale-forecast warning.

  So the clock encoding buys geometric safety by paying in exactly the currency
  the UI displays. **Do not ship it as written.**

**The fix: two scalars, not one.** Keep the ring in true wall-clock exactly as
today, and add a separate ranking scalar:

- `Node.tMs` — unchanged, true elapsed time. Drives `wind.sample`, both horizon
  guards, `backtrack`'s leg timestamps and the reported `etaMs`.
- `Node.costMs` — advances by `dtS / factor`. Drives **only** `better()`,
  `visitedDominates`, and the arrival comparison that selects `best`.

The frontier stays time-synchronised (every ring advances true time uniformly),
so the ring structure, the substep ladder and the geometry are byte-identical to
today — the clock encoding's reachability advantage is retained — while every
user-visible time is real wall-clock again. `visitedDominates` becomes a
componentwise minimum over `{costMs, maneuvers}`; note that the substep comment
at `isochrone.ts:143-145` about earlier clocks then refers to `costMs`.

**Status: designed, NOT measured.** I measured the distance and clock encodings;
I did not measure the two-scalar form. It must be re-run through the §E.5
reachability set and the §E.3 sweep before the constant in §D.2 is locked —
`DEPTH_DERATE_MAX = 0.30` was chosen on the distance encoding.

**If a smaller change is preferred**, Option 3 (§C.3 — raise the effective gate,
fall back on failure) is the only option here that touches **no** cost semantics
at all: it changes edge *admissibility* only, so wall-clock time, wind sampling
and every displayed timestamp stay exactly as today. Its all-or-nothing weakness
(§C.3) is real, but it is the safe fallback if the two-scalar change is judged
too invasive for this issue.

---

## E. Reproducing cases on the real committed mask

Harness: the repo's own `planRoute`, real `mask.bin` / `mask.meta.json` /
`polar-genoa.json` / `polar-fock.json`, `uniformWindGrid(12, dir)` from
`app/src/test/fixtures.ts` (the same fixture the committed real-mask acceptance
test uses), departure `T0 = Date.UTC(2026, 6, 15, 6, 0, 0)`, `DEFAULT_SETTINGS`
except where stated. Reported rig = `res.recommended`.

Two metrics, and the difference matters:
- **min clearance** — minimum charted depth over all cells swept by all legs, via
  `mask.segmentShallowestBelow(start, end, 1e6)`; deep-capped cells count 25.4 m.
- **exposure < X m** — *exact* distance in water shallower than X, by sampling
  each leg every ~15 m (well under the 46 m cell) and summing the sampled length
  whose cell is below X.
  **A whole-leg metric ("charge the leg if any cell is shallow") over-states
  exposure by 3–4× and is not comparable across routes with different leg
  counts** — it is what my first pass used and it inflated Flensburg → Sønderborg
  from a true 1.32 nm to 5.48 nm. All figures below are the exact metric.

### E.1 — Primary case: Flensburg → Sønderborg (the spec's own manual-acceptance passage, §5)

`flensburg { lat: 54.798, lon: 9.4335 }` → `soenderborg { lat: 54.9046, lon: 9.7833 }`,
committed `harbors.json` snap points. `DEFAULT_SETTINGS` (safety depth **3.0 m**,
draft 2.1 m, motor on, maneuver penalty 45 s, performance factor 0.9). Wind:
uniform **12 kn from 270°**.

| gate | min clearance | duration | Δ vs 3.0 m | distance | exp<3.5 m | exp<4.0 m | exp<5.0 m |
|---|---|---|---|---|---|---|---|
| **3.0 m (default, today)** | **3.1 m** | **2.9790 h** | — | 19.09 nm | **0.41 nm** | **1.32 nm** | **2.84 nm** |
| 3.5 m | 3.5 m | 2.9963 h | +62 s (+0.58 %) | 19.21 nm | 0.00 | 0.62 | 1.95 |
| 4.0 m | 4.0 m | 3.0253 h | **+167 s (+1.55 %)** | 19.29 nm | 0.00 | **0.00** | 1.30 |
| 5.0 m | 5.0 m | 3.0589 h | +288 s (+2.68 %) | 19.74 nm | 0.00 | 0.00 | 0.00 |
| 6.0 m | 6.2 m | 3.1030 h | +447 s (+4.16 %) | 19.89 nm | 0.00 | 0.00 | 0.00 |

**The finding.** The default plan touches **3.1 m** — 1.0 m under a 2.1 m keel,
on a reading the pipeline itself only trusts to ±2.0 m — and spends **760 m in
water under 3.5 m and 1.32 nm under 4.0 m**, when a route with a 4.0 m minimum
and *zero* sub-4 m exposure costs **2 min 47 s on a 3-hour passage (+1.55 %)**.
The shallowest legs are **mid-passage, not harbour approaches**:
`54.8559,9.6405 → 54.8510,9.6527` (3.1 m over 0.51 nm) and
`54.8357,9.7489 → 54.8423,9.7603` (3.1 m over 0.56 nm).

Same passage, **12 kn from 090°**: min 3.1 m, 2.8219 h, 0.38 nm < 3.5 m,
0.84 nm < 4.0 m; the 4.0 m-gate route costs **+148 s (+1.46 %)** for zero sub-4 m
exposure. Not an artefact of one wind direction.

### E.2 — Supporting cases (shipped solver, `DEFAULT_SETTINGS`, 12 kn)

| passage | wind | today: min / duration | deeper alternative |
|---|---|---|---|
| Hørup Hav → Sønderborg (`54.9037,9.888` → `54.9046,9.7833`) | 270° | **3.0 m** (exactly the gate) / 0.7141 h | gate 4.0 m: 4.0 m, **+40 s (+1.55 %)** |
| Hørup Hav → Sønderborg | 090° | **3.0 m** / 0.7998 h | gate 4.0 m: 4.0 m, +47 s (+1.62 %) |
| Glücksburg → Langballigau (`54.8415,9.5225` → `54.8237,9.6524`) | 090° | 3.3 m / 1.1752 h | gate 5.0 m: **5.0 m, −14 s — deeper AND faster** |
| Damp → Olpenitz | 270° | 3.5 m / 0.6220 h | gate 4.5 m: 4.5 m, +24 s (+1.06 %) |

Hørup Hav → Sønderborg is the sharpest minimum: the route sits **exactly on the
gate** (0.9 m under the keel) for 0.30 nm at `54.8943,9.7948 → 54.8984,9.7899`.

The Glücksburg → Langballigau row deserves a note: the 5.0 m-gate route is **both
deeper and faster**. That is not proof the 3.0 m route was time-suboptimal — it is
evidence that the isochrone expansion is already approximate (bucket pruning,
`visitedDominates`, `MAX_FRONTIER`). "We might lose optimality" is therefore a
weaker objection to §D than it sounds: there is no exact optimum being defended.

### E.3 — Parameter sweep (13 cases, distance encoding)

Aggregate over the 13 passages; baseline exposure < 4 m totals 36.96 nm on the
whole-leg metric used for the sweep (relative comparison only — see §E's metric
note); `Δt` is total added seconds across all 13; "min−" / "nm−" count cases that
got *worse* than baseline on minimum clearance / shallow exposure.

| margin / derate / exp | residual exposure | Δt (s) | min− | nm− |
|---|---|---|---|---|
| 2.5 / 0.40 / 1 | 3.71 | 2156 | 1 | 1 |
| **2.0 / 0.30 / 1** | **5.26** | **1565** | **0** | **0** |
| 2.0 / 0.40 / 1 | 6.20 | 1782 | 0 | 0 |
| 2.0 / 0.25 / 1 | 9.98 | 1391 | 1 | 0 |
| 2.0 / 0.50 / 1 | 11.92 | 1981 | 0 | 2 |
| 3.0 / 0.25 / 1 | 12.64 | 2068 | 2 | 1 |
| 1.5 / 0.25 / 1 | 16.30 | 1235 | 1 | 0 |
| 2.0 / 0.25 / 2 (quadratic) | 21.45 | 1007 | 1 | 0 |
| 2.0 / 0.15 / 1 | 23.07 | 1063 | 1 | 1 |
| 1.0 / 0.25 / 1 | 23.18 | 683 | 0 | 1 |

2.0 / 0.30 is the best setting with **zero regressions**, and it costs less time
than 0.40. Note the response is **non-monotone** in strength (0.50 is worse than
0.40 on two cases) — a direct consequence of the search being heuristic, and a
reason §G must not pin exact output values.

### E.4 — The recommendation, measured (clock encoding, margin 2.0 m / derate 0.30)

Shipped `planRoute` vs. prototype, same mask, polars, wind, settings; exact
exposure metric:

| passage | gate | min: base → new | duration: base → new | exp<3.0: base → new | exp<4.0: base → new | rigs |
|---|---|---|---|---|---|---|
| Flensburg → Sønderborg 270° | 3.0 | 3.1 → **4.1 m** | 2.9790 → 3.0636 h (**+2.84 %**) | 0.00 → 0.00 | **1.32 → 0.00 nm** | both → both |
| Flensburg → Sønderborg 090° | 3.0 | 3.1 → **4.7 m** | 2.8219 → 2.8918 h (**+2.48 %**) | 0.00 → 0.00 | **0.84 → 0.00 nm** | both → both |
| Flensburg → Marstal (relaxed to 2.3) | 3.0 req. | 2.3 → 2.3 m | 7.8611 → 7.9875 h (**+1.61 %**) | **1.33 → 0.23 nm** | 3.61 → 0.69 nm | both → both |
| Bagenkop → Marstal (relaxed to 2.3) | 3.0 req. | 2.3 → 2.3 m | 1.1243 → 1.1775 h (+4.73 %) | 0.32 → 0.33 nm | 0.58 → 0.60 nm | genoa only → **both** |

Every emitted leg was re-checked with `segmentNavigable` at the gate actually
used: **0 invalid legs** in every row. `res.shallow.usedDepthM` stayed **2.3** on
both Marstal plans, with shallow flagging intact — #53's contract is preserved.

Where deep water is already free the change is **exactly zero**: Flensburg →
Glücksburg at 000° and 135° is byte-identical in duration.

The Flensburg → Marstal row is the **mechanism-2 fix, quantified**: same relaxed
gate, same warnings, **83 % less sub-requested-depth water**, for +1.6 %.

The Bagenkop → Marstal row is the passage the distance encoding **lost entirely**
(§C.1). It has no deeper alternative to find (exposure is unchanged) — the point
is that it still routes, and in fact recovers a rig the shipped solver drops.

### E.5 — Reachability checks (clock encoding, 2.0 m / 0.30)

- **Flensburg → Marstal at `DEFAULT_SETTINGS`** (#53 spec acceptance): still
  routes, still relaxes to `usedDepthM = 2.3`, both rigs non-null, shallow
  warnings present, all legs navigable at 2.3 m.
- **Flensburg → Marstal at explicit 2.3 m**: still routes, both rigs, still no
  `shallow` field.
- **Flensburg → Glücksburg at wind 0/90/135/180/270/315°** (#20 repro): all six
  still `ok`; four are byte-identical in duration.
- **A 5.0 m-gate user, Flensburg → Sønderborg**: still routes, both rigs.
- **Bagenkop → Marstal at `DEFAULT_SETTINGS`**: still routes (the distance
  encoding did not).

These **confirm** rather than establish safety — §C.1 is why the tier ladder is
mandatory regardless.

**The 5 `KNOWN_DISCONNECTED` harbours (#9) are untouched**: they fail at the mask
connectivity BFS (`planRoute.ts:169`, `relaxedDepth.ts:49`), which the preference
never enters — the decision is made before any edge is expanded. Confirmed
indirectly: in a 132-run sweep over all harbour pairs 3–10 nm apart, all 42
failures involve those harbours.

---

## F. Spec impact

Source of truth: `docs/superpowers/specs/2026-07-14-sail-command-design.md`.

### F.1 — §3.2 "Routing engine", lines 82–91 — the depth bullet is the one being extended

Exact current text:
```
- **Routing engine** — TypeScript, runs in a **Web Worker**:
  - Isochrone algorithm: expand reachable frontier every Δt (adaptive,
    ~10 min), candidate headings every 5–10°, prune dominated points,
    terminate on destination convergence, backtrack path.
  - Wind interpolated in space and time at each expansion.
  - **Maneuver penalty** (default 45 s per tack/gybe) added when a candidate
    heading crosses the wind relative to the parent leg — this is the
    tack/gybe minimization mechanism.
  - Land/depth mask collision test along every candidate segment (grid
    traversal).
```
Proposed new bullet, immediately after the collision-test bullet:

> - **Depth comfort preference** (#243; default margin 2.0 m above the safety
>   depth, user-tunable, 0 = off): beyond the hard navigability gate, every
>   candidate segment is also *priced* on its minimum charted clearance. Clearance
>   at or above `safety depth + margin` is free; at the gate itself the segment
>   costs ≈1.43× its time to cross, linearly in between. The charge lands on the
>   candidate's arrival clock, never on its geometry — step lengths, fit tests and
>   the substep ladder are unchanged. Evaluated at query time against the
>   **requested** safety depth, so it never regenerates data and stays anchored
>   even when the #53 relaxed gate is in force. Because the isochrone expansion
>   prunes per spatial bucket, a preference can in principle change search success
>   as well as route choice: whenever a preferenced solve reports mask
>   unreachability, the identical un-preferenced solve is retried before the plan
>   degrades further, so no passage that routes without the preference can fail
>   with it.

### F.2 — §2 Decisions table, line 23

Exact current text:
```
| Obstacles | Land **and** depth aware; safety depth configurable, default 3.0 m (draft 2.1 m) |
```
Proposed replacement:
```
| Obstacles | Land **and** depth aware; safety depth configurable, default 3.0 m (draft 2.1 m); depth beyond the gate is a *preference*, not just a gate — comfort margin default 2.0 m (#243) |
```

### F.3 — §3.2 options panel, lines 75–76 (the settings list is enumerated)

Exact current text:
```
  tap), departure time picker, options panel: safety depth, motor speed,
  motor threshold, maneuver penalty, performance factor. "Plan route" button.
```
Proposed replacement:
```
  tap), departure time picker, options panel: safety depth, depth comfort
  margin, motor speed, motor threshold, maneuver penalty, performance factor.
  "Plan route" button.
```

### F.4 — Addendum 2026-07-17 (#53), lines 222–223 — needs a qualifier, not a change

Exact current text:
```
  requested − 0.1 m. The full solver then runs ONCE per rig at that single relaxed depth (depth
  gates are rig-independent, so genoa/fock stay apples-to-apples by construction).
```
This stays true and must **not** be weakened — the relaxed *gate* is still single
and rig-independent. What changes is that the gate is no longer the only depth
input. Proposed sentence appended to that bullet:

> *Amendment (#243):* the relaxed solve keeps the depth **comfort preference**
> anchored to the REQUESTED safety depth, not the relaxed gate. The relaxed gate
> therefore only widens what is *possible*; it no longer makes sub-requested water
> equally *attractive* along the whole passage. Measured on Flensburg → Marstal at
> `DEFAULT_SETTINGS`: same relaxed gate (2.3 m), same warnings, sub-requested-depth
> exposure 1.33 nm → 0.23 nm for +1.6 % ETA. The relaxation is thus localized to
> the pinch that forced it, in the cost function — not in a post-hoc pass. "Runs
> ONCE per rig" becomes "runs once per rig per preference tier": an un-preferenced
> retry happens only when the preferenced solve reports mask unreachability.

### F.5 — §5 Testing, lines 133–138

Exact current text:
```
- **Golden routes** (synthetic wind fields): dead upwind in open water →
  small tack count (bounded, not 20); beam reach → 0 maneuvers; island
  between ports → clean rounding; calm + motor on → straight motor leg;
  calm + motor off → "no route" with reason.
- **Property tests**: no leg crosses land/shallow mask; leg times strictly
  increasing; legs geometrically continuous.
```
Proposed addition to the golden-routes bullet: `shoal shortcut available but a
deeper route costs little → route prefers the deeper water; a passage that only
exists through a shoal pinch still routes`.

---

## G. Test plan

Anchored on the real mask. **Every literal is derived from pre-change measurement
or from independent arithmetic — never copied from the new implementation's
output** (#50's tautology).

### G.1 — Real-mask acceptance (extend `app/src/routing/realmask.repro.test.ts`)

Flensburg → Sønderborg, `DEFAULT_SETTINGS`, `uniformWindGrid(12, 270)`, `T0`:

1. **Pin the behaviour change against pre-change literals.** Today's route
   measures **3.1 m minimum** and **1.32 nm below 4.0 m**. Assert the fixed
   route's minimum is `> 3.5 m` and its sub-4 m exposure is `< 0.4 nm`. Both
   thresholds sit far from the measured baseline (3.1 / 1.32) *and* from the
   measured fixed value (4.1 / 0.00), so the test pins the change, not either
   implementation's arithmetic. **Do not assert `min === 4.1`** — that is the new
   implementation's own output, and §E.3 showed the response is non-monotone in
   the tuning constant, so pinning it converts any retune into a test edit.
2. **Time envelope from independent arithmetic.** Baseline 2.9790 h; the 4.0 m
   *gate* route (a different mechanism, measured independently) costs +1.55 %;
   the recommendation measured +2.84 %. Assert `durationMs` is within **8 %** of
   the pre-change 2.9790 h literal — above every measured cost, far below
   anything indicating the solver started padding.
3. Every leg still `segmentNavigable` at 3.0 m (reuse `expectLegsNavigable`).
4. The exposure helper must sample along the leg (≈15 m), **not** charge whole
   legs — see §E's metric note; a whole-leg metric over-states by 3–4× and is not
   comparable across differing leg counts.

### G.2 — Unit test for the charge arithmetic (synthetic mask)

The one place a literal can be hand-derived exactly. Gate 3.0, margin 2.0
(comfort 5.0), `DEPTH_DERATE_MAX = 0.30`, an edge whose swept minimum is 4.0 m:
shortfall = (5.0 − 4.0)/(5.0 − 3.0) = 0.5; factor = 1 − 0.30 × 0.5 = **0.85**;
a 600 s ring therefore advances the child clock by 600/0.85 = **705.88 s** while
covering the **same** distance as today. Assert the child's `endTimeMs − startTimeMs`
against that hand-derived value, and assert `distanceNm` is **unchanged** from the
no-preference run — the second half is what pins the clock encoding rather than
the distance one.

Pin both boundaries: clearance ≥ 5.0 m ⇒ factor exactly 1 (geometry *and* clocks
identical to `depthComfortMarginM: 0`); clearance = 3.0 m ⇒ factor 0.70.

### G.3 — Reachability guard — these must stay green **unmodified**

- `app/src/routing/planRoute.shallow.test.ts` — all seven cases. The probe-sequence
  assertions (`expect(probes.map(p => p.probeDepthM)).toEqual([2.5, 2.7, 2.6])`)
  exercise `findRelaxedDepthM`, which this change does not touch; if they move,
  something is wrong.
- `app/src/routing/relaxedDepth.test.ts` — untouched by construction.
- `app/src/routing/realmask.repro.test.ts` — Flensburg → Marstal at
  `DEFAULT_SETTINGS` still returns a route with `usedDepthM ≈ 2.3` and non-empty
  flagged legs; Flensburg → Marstal at 2.3 m still carries **no** `shallow` field;
  Flensburg → Glücksburg still routes at all five pinned wind directions.

**New, and the most important test in this plan** — the regression that actually
happened during design (§C.1): **Bagenkop → Marstal at `DEFAULT_SETTINGS`,
`uniformWindGrid(12, 270)` must return `status: 'ok'` with `usedDepthM === 2.3`.**
An earlier form of this fix turned that passage into `error: unreachable`. Pin it.

### G.4 — Mechanism-2 assertion

Flensburg → Marstal at `DEFAULT_SETTINGS`: assert `res.shallow.usedDepthM` is
still `2.3` **and** that exact sub-3.0 m exposure is `< 0.6 nm`. The pre-change
literal is **1.33 nm** (measured on `develop` before the fix exists); the
threshold sits between it and the measured 0.23 nm. This is the assertion that
proves the relaxation was *localized* rather than removed — `usedDepthM === 2.3`
proves it was not removed, the exposure bound proves it was localized.

### G.5 — "Feature off" identity test

`depthComfortMarginM: 0` must produce a **byte-identical** route to the
pre-change solver on a real-mask case — the strongest available guard against the
change leaking into the no-preference path, and cheap: one plan at margin 0
compared against a leg list captured from `develop` before the change.

### G.6 — Tier-ladder test

On a synthetic mask, force the preferenced solve to fail with `unreachable` while
the un-preferenced solve succeeds (a corridor whose only gap is at the gate, wide
enough to pass but narrow enough that the preference's cost never wins). Assert
the plan returns `ok`, and that its legs match the un-preferenced solve's. Without
this, tiers 2/4 are dead code nobody notices is broken.

### G.7 — Tests that could regress (name them in the PR)

| test | why |
|---|---|
| `realmask.repro.test.ts` — `Flensburg → Gluecksburg routes at default settings` | asserts `durationMs < 1.5 h`; measured cost +11 s on 0.67 h, holds with wide margin, but it is the closest existing time envelope |
| `realmask.repro.test.ts` — both Marstal cases | assert `distanceNm > 30` and `durationMs < 12 h`; both grow slightly (44.93 → 45.51 nm, 7.86 → 7.99 h) — still inside, but check |
| `invariants.property.test.ts` | the ~463 s seeded property suite asserts no leg crosses the shallow mask; geometry changes on every generated case, so a latent seed-specific assumption surfaces here. **Run this file explicitly before opening the PR** — it is scheduled first by the custom sequencer in `app/vite.config.ts` |
| `isochrone.test.ts`, `isochrone.followups.test.ts` | synthetic masks; unaffected **only because** `comfortDepthM` is optional and absent there. If the implementer instead defaults the margin inside `solve`, these all move — do not |
| `postprocess.test.ts` | moves only if the merge pass is made preference-aware (§D.4) |
| `app/e2e/plan.spec.ts` | plans a real route; any hard-coded duration/distance text moves |

### G.8 — Mutation check before trusting any new test

Per CLAUDE.md's #50 lesson: after writing G.1/G.2/G.4, set
`DEPTH_DERATE_MAX = 0` and confirm each new assertion **fails**. An assertion that
passes with the feature disabled is measuring nothing.

---

## Appendix — harness

Scratchpad only, nothing added to the repo:
`lib243.ts` (real mask/polar/harbor loading + metrics), `sweep.ts` (all harbour
pairs), `ladder2.ts` (gate ladder, exact exposure), `isochrone243.ts` /
`planRoute243.ts` (distance encoding), `isochroneClock.ts` / `planRouteClock.ts`
(clock encoding), `compare.ts` / `exact.ts` / `regress.ts` / `clocktest.ts`
(measurement), `hist.ts` (mask depth histogram), `tsresolve.mjs` (Node ESM hook
so `--experimental-strip-types` can load the app's extensionless imports).
Run e.g.
`node --experimental-strip-types --import ./tsresolve.mjs ./clocktest.ts 0.30`.
