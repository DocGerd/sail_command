# Spike #1136 — motor-off solves terminate holding mask-validated children

- **Issue:** #1136 (siblings filed from this work: #1166, #1168)
- **Date:** 2026-09-09
- **Merge-base of every measurement:** `035d662`
- **Status:** Decision / Recommendation — record of an investigation, not a plan
  to implement
- **Verdict:** **The mechanism is MEASURED and is not the one #1136's title
  names. Motor-off solves do not die for lack of a heading inside the beat
  angle; they die holding fully mask-validated children that domination
  pruning discards — on the dying ring, every accepted edge is dropped by
  `visitedDominates` and nothing else. The re-expansion salvage designed
  against that mechanism was NOT implemented: its plan-level containment is
  refuted by measurement, its trigger cannot distinguish a solver give-up from
  a genuine no-route, and its efficacy has never been run on any input. #1136
  is DEFERRED to milestone v0.32.0 (maintainer ruling, 2026-09-09). This
  document exists so the next attempt starts from the measurement rather than
  from the issue title.**

> Read alongside the `#866` comment in `app/src/routing/isochrone.ts`'s
> `if (!best)` branch, which already concedes that `'mask-blocked'` "cannot
> distinguish 'genuinely unreachable' from 'solver gave up'". That admission
> now has a positive measurement behind it.

---

## 0. Provenance, and how to reproduce every number here

Three agents produced the material this document preserves: a designer (design
pass B), an independent refuter who instrumented `solve()` and re-ran the
designer's claims, and the orchestrator (the sweep BASE distribution in §7).
**Every figure carries its origin.** Where a designer claim was not re-run by
the refuter it is labelled so, and where the refuter's own instrumentation
never reached a claim it appears in §4 (UNTESTED) rather than among the
findings.

Common configuration for everything in §1–§3 unless stated otherwise: real
committed mask (`<repo>/app/public/data/mask.bin` + `mask.meta.json`) and the
committed Salona-45 genoa polar, Flensburg → Bagenkop,
`safetyDepthM: 3`, `motorEnabled: false`, uniform wind field, departure
`Date.UTC(2026, 6, 15, 6, 0, 0)`.

Two endpoint conventions appear in the raw material and they are **not**
interchangeable:

- **snapped** — both endpoints through `NavMask.snapToNavigable(p, 3)`, which
  is what `planRoute` does. Snapped origin `{54.798125, 9.433818181818182}`.
- **unsnapped** — the raw harbour coordinates `{54.798, 9.4335}`.

The difference is **24.7 m** (derived here from the two coordinate pairs:
Δlat 13.9 m, Δlon 20.5 m at φ = 54.798°), and it flips outcomes — see §3.2.
Rows are labelled; do not mix them.

Reproduction (the refuter's `REPRO.md`, paths rewritten to placeholders):

```
cd <repo>
git worktree add <scratchpad>/wt-refute 035d662
cd <scratchpad>/wt-refute && git apply <scratchpad>/ref2/instrumentation.patch
cd <scratchpad>/ref2 && SC_LOG=<scratchpad>/ref2/out.txt \
  npx vitest run --config vitest.config.ts --reporter=verbose
# true pure add of +-35 to EXTRA_TWAS:
SC_PURE_ADD=35 SC_LOG=... npx vitest run --config vitest.config.ts --reporter=verbose
```

`--reporter=verbose` is required because vitest's default reporter suppresses
console output from PASSING tests; the harness writes to a file for that
reason, so the flag matters only for incidental logs. The instrumentation
patch is reproduced verbatim in Appendix A and the probe harness in
Appendix B, because the scratch directory they lived in is not tracked and
will not survive this session.

Connectivity is established by the repo's **own oracle**, not by assertion and
not by `solve()` itself:
`mask.cellsConnected(snappedOrigin, snappedDest, uniformGate(3))` returned
`true` for this pair (logged as `connected@3.0 = true` in both `base.txt` and
`f2.txt`). That is the same independent-oracle discipline
`realmask.repro.mirrorCase.test.ts` uses.

---

## 1. The diagnosis — MEASURED

### 1.1 The frontier dies holding fully mask-validated children

`RING_STATS` records, per ring: `nodes` (frontier size entering the ring),
`accepted` (edges the mask accepted, full-step or fitted substep), `blocked`,
`horizonDrops`, `dominatedDrops`, `betterLoss`, `byKeySet`, `directAccepted`,
`captureAccepted`, `nextLen`, `hasBest`.

Last ring before death, **snapped**, dir 0, `motorEnabled: false`:

| input | nodes | accepted | horizonDrops | dominatedDrops | betterLoss | direct / capture | next |
|---|---|---|---|---|---|---|---|
| TWS 2.8 | 5 | 104 | 0 | 104 | 0 | 0 / 0 | 0 |
| TWS 3   | 3 | 49  | 0 | 49  | 0 | 0 / 0 | 0 |
| TWS 8   | 4 | 51  | 0 | 51  | 0 | 0 / 0 | 0 |

All three returned `status: 'no-route'`, `cause: 'mask-blocked'` — the label a
user sees as `error.noRoute.unreachable` — on water the oracle above proves
connected at the requested gate.

**Identical at tier-1 fidelity.** Re-run with `comfortDepthM = 3 +
DEFAULT_SETTINGS.depthComfortMarginM = 5`, every counter on every ring is
unchanged (`comfort.txt` against `base.txt`, byte-for-byte on the logged
rows). So this is not an artifact of running bare `solve()` at tier-2
fidelity: the depth-comfort preference does not touch it.

### 1.2 Why the conclusion is exact rather than an enumeration argument

The design pass B appendix reached this conclusion by enumerating drop points
between edge acceptance and `byKey.set` and finding "exactly two" (the horizon
test and `visitedDominates`). **That enumeration is wrong** — see §2.1. The
conclusion survives anyway, and it survives for a stronger reason than the
enumeration could ever have given, so state it that way:

On **every one of the 188 logged rings** across all five raw logs
(`base.txt`, `comfort.txt`, `f2.txt`, `f4_base.txt`, `f4_add.txt` — dying and
surviving runs alike), the counters satisfy exactly

```
accepted == horizonDrops + dominatedDrops + betterLoss + byKeySet
```

with **zero violations** (checked mechanically over the logged rows while
writing this document, not spot-checked). On the dying rings the other three
terms are 0, so the identity collapses to `accepted == dominatedDrops`. That
is an accounting identity over the recorded quantities, not an argument about
which code paths exist — an unenumerated drop channel would have shown up as
a shortfall in the sum and did not. The `#866` comment's "solver gave up"
alternative is therefore the measured case here, not a possibility.

Also measured, and worth recording because the brief for this document assumed
otherwise: `directAccepted` and `captureAccepted` are **0 on every one of
those 188 rings**, not merely on the dying ones.

### 1.3 The mechanism, by symbol

`stampVisited` writes each surviving node's `{costMs, maneuvers}` into its own
prune cell at the end of every ring (the loop over `next` after the frontier
cap). On the next ring `visitedDominates(seen, child)` discards any child that
is no better on **both** axes — `seen.costMs <= cand.costMs && seen.maneuvers
<= cand.maneuvers`. A node's own stamp dominates its own same-cell children by
construction, since the ranking clock only advances and maneuvers only
accumulate. `pruneKey`'s third component is `'M' | 'P' | 'S'`, so a beating
thread has two lanes (port and starboard) rather than one.

**Label: the clause above is ARGUED from the code, not measured.** The
instrumentation counts `dominatedDrops` but does not record *which* stamp
dominated each dropped child — the parent's own cell, or a cell stamped in an
earlier ring by an entirely different thread. Both are `visitedDominates`
drops and the counter cannot tell them apart. See §4.

**One DEDUCED refinement, because it changes what a fix would have to
target.** `dtS` is 600 s while the destination is more than 5 nm away
(`isochrone.ts`: `minDist < 2 ? 150 : minDist < 5 ? 300 : 600`). Maximum
Salona-45 genoa speed over TWA, computed here from the committed polar, is
3.30 kn at TWS 2.8 and 7.39 kn at TWS 8 — so a **full** step runs ~1020 m and
~2281 m respectively, against `PRUNE_LAT = 0.002` (~220 m) and `PRUNE_LON =
0.003` (~190 m). A full-step child therefore lands several prune cells away
from its parent and cannot be dominated by its parent's own stamp. Same-cell
self-domination is reachable only through the `dtS/2`, `dtS/4`, `dtS/8`
substep retry, whose shortest hop is ~128 m at TWS 2.8 — inside one cell. The
blocked counts on the dying rings are large (66, 53, 85 against accepted 104,
49, 51), which is consistent with most accepted edges being fitted substeps,
but **the instrumentation does not split `accepted` into full-step and fitted**,
so this stays DEDUCED. Anyone attacking the mechanism should add that split
first; it decides whether the target is self-domination or cross-thread
domination, and those want different fixes.

### 1.4 The user-visible surface — NOT RE-RUN

Designer's appendix, `planRoute` (the whole tier ladder, endpoints snapped by
`planRoute` itself), Flensburg → Bagenkop, `motorEnabled: false`,
`safetyDepthM: 3`:

| TWS, dir 0 | `planRoute` result |
|---|---|
| 1.5 | error `unreachable` (13 808 ms) |
| 2.0 | error `unreachable` (451 ms) |
| 2.4 | error `unreachable` (387 ms) |
| 2.8 | error `unreachable` (558 ms) |
| 3   | **ok, but `sails = [null, 17.99 h]`** — one rig lost, comparison withheld (#1166) |
| 8   | ok 7.69 h |
| 12  | ok 6.61 / 6.65 h |
| TWS 3, dir 45 | ok 18.65 / 19.91 h |

`PLAN_BUDGET_MS` is 120 000 ms. Three of the four failures abandon a 43 nm
passage having spent **under 0.5 %** of the budget. Note also that at fixed
TWS 3 the direction alone decides: dir 0 dies in bare `solve()` and dir 45
routes.

**The refuter ran no `planRoute` call at all** (§4), so this table is the
designer's alone — with the single exception of the TWS 3 row, whose
`solve()`-level shape (`next = 0`, `best === false`, `dominated == accepted` at
both tier-1 and tier-2 fidelity) the refuter did confirm, and which is the
measured basis of hole 1 in §5.

---

## 2. Corrections to the design pass B appendix

Three. The first two were found by the independent refuter; the third was
found while writing this document. Recording the corrected version alone would
lose the more useful half — each of these is a trap positioned exactly where
the next investigator will walk.

### 2.1 "Exactly two drop points" is wrong as an enumeration

The appendix says that between edge acceptance and `byKey.set` there are
"exactly two drop points: the horizon test … and `visitedDominates`". There
are more:

- **`better()`-loss.** When a child reaches `byKey` and an incumbent already
  holds its cell, `if (!incumbent || better(child, incumbent))` silently drops
  the loser. Counted as `betterLoss`; it is large on surviving rings (478 on
  one TWS 2.0 ring) and 0 on the dying ones.
- **Direct arrivals.** A successful direct-candidate arrival ends with
  `continue; // the direct edge is consumed by the arrival attempt`, before
  either `_accepted++` site. So a direct arrival is counted in
  `directAccepted` and is **outside** the `accepted` total entirely — it
  consumes a candidate heading without producing a child.

**And a correction to that correction:** the brief for this document grouped
"direct/capture" together as channels that "consume accepted edges without
producing children". **That is false for capture.** The capture block
(`if (child.distToDestNm < CAPTURE_NM)`) does not `continue` — the child falls
through to `pruneKey` / `visitedDominates` / `byKey` exactly like any other.
Capture is not a drop channel at all. This is reported as a contradiction
between sources rather than silently harmonised; the code is the authority and
was read directly.

**The conclusion is unaffected** for the reason in §1.2: the accounting
identity holds exactly on all 188 rings, and `directAccepted` /
`captureAccepted` are 0 on every one. All three extra channels read zero on
the measured rings, so `accepted == dominatedDrops` on the dying rings is a
complete account of where the children went.

### 2.2 The designer's "pure ADD" was not additive — a second swap

The appendix's F4 de-confounds a candidate-set experiment into a SWAP
(`beatAngleDeg` overridden to 35, losing the beat angle) and a "pure ADD"
(`gybeAngleDeg` overridden to 35, on the stated grounds that "135/145 still
come from `EXTRA_TWAS`"). **That reasoning is the error.** 135 and 145 are
indeed retained — but they are not the angle being deleted.

Verified here against the committed polar and `isochrone.ts`'s own dedupe
(`if (!twas.some((x) => Math.abs(x - t) < 1)) twas.push(t)`):

| TWS | `beatAngleDeg` | `gybeAngleDeg` | nearest `EXTRA_TWAS` neighbours | deduped away? |
|---|---|---|---|---|
| 2.0 – 3.0 | 47.8 | 142 | 135 (Δ 7), 145 (Δ 3) | no — 142 is its own entry |
| 8 | 42.8 | 146 | 145 (Δ 1) | no — the dedupe is `< 1`, strict |

`|47.8 − 45| = 2.8`. So **both** designer forms delete a heading while adding
one: overriding gybe → 35 deletes ±142 (or ±146 at TWS 8) and adds ±35;
overriding beat → 35 deletes ±47.8 and adds ±35. Neither is a pure add, and
the "= triage's proposal shape" annotation on the ADD column is therefore
unsupported.

**The corrected mutation and its result.** The refuter re-ran with ±35
injected into `EXTRA_TWAS` itself (`SC_PURE_ADD=35`, base set ∪ {±35}, polar
untouched, so beat 47.8 and gybe 142 are both retained — see the patch in
Appendix A). Snapped, dir 0, PLAIN polar:

| TWS | base set | base set ∪ {±35} |
|---|---|---|
| 2.0 | ALIVE at ring 45 | **dies at ring 5** |
| 2.4 | dies at ring 5 | ALIVE at ring 45 |
| 2.8 | dies at ring 5 | ALIVE at ring 45 |
| 3   | dies at ring 5 | ALIVE at ring 45 |
| 8   | dies at ring 4 | ALIVE at ring 45 |

The conclusion held under the corrected mutation: four inputs flip dead → alive
and **TWS 2.0 flips alive → dead**. Adding a heading is not monotone
improvement — it changes which node wins each `byKey` cell under `better()`,
and therefore the whole search shape.

**METHOD NOTE, recorded deliberately.** The refuter also re-ran the designer's
*flawed* forms and reproduced the designer's F4 table exactly (`f4_base.txt`).
The numbers were right; only the interpretation was wrong. That is the trap:
an experiment that measures something real, reported under a description of
what it did that does not match what it did. A reader checking the F4 table
numerically would have confirmed every cell and learned nothing about the
defect in it. Check what a mutation *changes*, not only what it *reports*.

### 2.3 "Byte-identical frontier traces" is true only of the sizes

F4 states the ADD and SWAP forms kill TWS 2.0 "with byte-identical frontier
traces `9,12,6,2,0`". Checked here against `f4_base.txt`: the frontier-SIZE
sequence is indeed identical across both forms (and across the corrected
`SC_PURE_ADD` run). The per-ring counters are **not** — ring 1 reads
`acc=243 dom=171 betterLoss=47 set=25` for the ADD form against
`acc=244 dom=176 betterLoss=39 set=29` for the SWAP form. Two searches that
differ internally converged on the same frontier cardinalities. Quote the
claim as "identical frontier sizes", never as "identical traces".

---

## 3. The other findings, with refutation status

Status vocabulary: **SURVIVED** = the refuter re-ran it independently and it
held. **NOT RE-RUN** = designer's appendix only. A NOT RE-RUN finding is not
thereby doubted; it is simply not corroborated, and §4 keeps that visible.

### 3.1 Not a light-air problem — SURVIVED

Snapped `solve()` dies at **ring 4 at TWS 8**, where the boat makes ~7.4 kn at
its best TWA (computed here; the appendix's "~5.8 kn" is the designer's
figure, presumably at a sailed rather than optimal angle, and is not
re-derived here). The heading-availability framing in #1136's title predicts a
light-air defect. This is not one.

### 3.2 Non-monotonic in continuous inputs — SURVIVED, and both artifact hypotheses are DEAD

Unsnapped, dir 0, `motorEnabled: false`:

| TWS | outcome |
|---|---|
| 2.4 | dies at ring 6 |
| 2.6 | ALIVE at ring 45 |
| 2.8 | dies at ring 5 |
| 3.0 | ALIVE at ring 45 |

and the 24.7 m origin shift of §0 flips TWS 3 (unsnapped alive, snapped dies at
ring 5).

Two obvious artifact explanations were **tested and killed**, not assumed:

- **Shared mutable state:** the same four inputs re-run in REVERSE order inside
  one process produced byte-identical outcomes and byte-identical per-ring
  counters (`f2.txt`, the `REPEAT-REV` rows against the forward rows).
- **Per-run input regeneration:** `uniformWindGrid` is a constant function with
  a fixed `t0Ms`, and `NavMask` holds no cache, so nothing is regenerated
  between runs.

**Caveat that must travel with this table:** the refuter verified
**"alive at ring 45"**, not "routes to completion". The `dies` rows are
terminal and final; the `ALIVE` rows establish only "still searching". Do not
quote the table as a routed / not-routed split. Filed separately as **#1168**,
which carries this caveat in its own body.

### 3.3 Motor-on control — SURVIVED on 2 of 12 configurations

The appendix reports motor-on alive past ring 45 in all 12 configurations it
tested, with frontier "5 000–20 000". The refuter re-checked **2** of those 12
(TWS 2.8 and TWS 8, snapped, dir 0), both alive at ring 46, with ring-45
`nextLen` of **3121** and **8491** respectively — against motor-off's dying
frontiers, whose `nextLen` never exceeds 17 across the four dying runs in
`base.txt`.

Note the two figures are different apertures and must not be conflated: the
designer's 5 000–20 000 is a peak-frontier range over 12 configurations (the
refuter's own logs show `nodes` of 5870 and 13370 on rings inside it), while
3121 / 8491 are single ring-45 `nextLen` values on 2 configurations.

### 3.4 Step length alone is not the driver — NOT RE-RUN

Designer's appendix: polar speeds scaled ×0.5 and ×0.25 (shortening steps
including the `dtS/8` substep floor, with an identical heading set) rescue
nothing — death moves from ring 5 to ring 7, delayed rather than prevented. At
TWS 2.0 the ×0.25 scaling turns a surviving search into a ring-3
`calm-without-motor` death. The refuter did not re-run this.

### 3.5 Search cost of the candidate-set lever is unpredictable in SIGN — NOT RE-RUN

Designer's appendix, accepted-edge tests:

| case | base | with ±35 | change |
|---|---|---|---|
| unsnapped TWS 3 dir 0 (not improved by the lever) | 5 035 577 | 9 202 135 | **+83 %** |
| snapped TWS 12 dir 0 (routes either way) | 13 249 392 | 8 771 083 | **−34 %**, 68 → 59 rings |

So **"adding candidates is expensive" is FALSE as a general claim** — it is
expensive on some inputs and cheaper on others, because it changes which nodes
win cells and therefore the entire search shape. The rejection of the
candidate-set lever in §9 rests on §2.2 and §1, not on cost. The refuter did
not re-run this.

### 3.6 Siblings isolated from this work and filed separately

- **#1166** — `planRoute` at TWS 3, snapped, dir 0, sails `['genoa','fock']`
  returns `status: 'ok'` with `sails = [null, 17.99 h]`: one rig solved, the
  other returned nothing, and the two-rig recommendation — the app's headline
  output — is silently withheld. This **survives any solver fix**: whenever one
  rig's `solve()` fails for any reason while the other succeeds, the surface
  reports unqualified success. It is also the measured case that refutes the
  proposal's containment claim (§5, hole 1).
- **#1168** — the §3.2 non-monotonicity, with its caveat.

---

## 4. What is NOT established — the refuter's own UNTESTED list

Recorded as its own section so that an unreached claim can never read as a
surviving one.

- **F5 (search cost unpredictable in sign) and F6 (step length not the
  driver): UNTESTED by the refuter entirely.** Designer's appendix only.
- **F7 (motor-on control): re-checked on 2 of 12 configurations.**
- **F2: verified "alive at ring 45", not "routes to completion".**
- **The "byte-identical frontier traces `9,12,6,2,0`" claim: not tested by the
  refuter.** Checked while writing this document — see §2.3, where it turns out
  to be true of the sizes and false of the counters.
- **Tier-escalation perturbation and the cause-flip (§5 hole 2): ARGUED from
  the code, never instanced.**
- **No `planRoute`-level run by the refuter at all.** Every refuter measurement
  is a bare `solve()` call.
- **Salvage efficacy: never run on any input.** The proposal has never been
  executed.
- **Which stamp dominated each dropped child** (parent's own cell vs. an
  earlier ring's), and **the full-step / fitted-substep split of `accepted`**
  (§1.3). The instrumentation records neither.

---

## 5. The proposed fix, and the five holes that stopped it

**The proposal (design pass B).** Inside `solve()`, when a ring ends with
`next.length === 0 && best === null` and `salvages < MAX_SALVAGES`, re-run that
ring's expansion over the same frontier with the `visitedDominates` test
skipped, and use the result as `next`. Nothing else changes — `stampVisited`,
the frontier cap, `SolveFailureCause`, `NO_ROUTE_LABEL_OF_CAUSE` and the death
classifier are untouched. `best === null` is the intended containment clause: a
ring that empties with a route already in hand must keep returning that route
byte-for-byte.

It was **not implemented**. Five holes, in the order they bite.

### Hole 1 — plan-level containment is REFUTED by measurement

Containment at **solve level** is airtight: a solve that already holds a `best`
never salvages. But `planRoute` does not succeed on a solve — it succeeds on
`tierN.some((r) => r.rigResult)`, i.e. **per rig**, at each tier. The measured
counter-example is #1166: at TWS 3, snapped, dir 0, one rig's `solve()` dies
with `next = 0`, `best === false`, `dominated == accepted` at **both** tier-1
and tier-2 fidelity, inside a plan that returns `ok` **today**. The salvage
would fire inside a currently-succeeding plan and can change `sails`, the rig
comparison, and the ★ recommendation. This is measured, not argued.

### Hole 2 — the classifier's INPUTS are not frozen, and freezing them is not sufficient

`blockedDeaths` and `calmDeaths` accumulate per node per ring, so a re-expanded
ring double-counts them; a solve that still fails can then flip
`SolveFailureCause` between `'mask-blocked'` and `'calm-without-motor'`. That
cause gates `depthRelaxationMayHelp` and `comfortRetryMayHelp` — it is #282's
label-as-control coupling re-entering through the counters, and #1136's own
issue text records the measured cost of the last time that fired (Bagenkop
+515.2 s, Wackerballig +499.4 s, Gelting-Mole +353.2 s).

Freezing the counters across a salvaged re-expansion is **NECESSARY but NOT
SUFFICIENT**, and this corrects the design's own framing: a salvaged solve runs
more rings, so it can newly reach the horizon guard (`horizon-exceeded`) or
spend more wall clock (`budget-exhausted`). Both bypass the counters entirely
and still change `SolveFailureCause`. Freezing closes one route to cause-drift
and leaves two open.

### Hole 3 — `MAX_SALVAGES` has no value and no evidence

The designer declined to guess, correctly. Width is bounded by the existing
`MAX_FRONTIER` slice; **depth** is the real cost and is unmeasured. It must be
measured against `PLAN_BUDGET_MS` (120 000 ms, `workerClient.ts`) on
Flensburg → Marstal — the route #1147 already records as leaving only ~30 %
headroom against that budget in a real browser, i.e. the least forgiving input
in the repo for a change that adds rings.

### Hole 4 — the design was never RUN

Its author was read-only. Every claim about behaviour on working plans is
structural, not empirical. In particular, **salvage efficacy has never been
measured on any input**: salvaged nodes sit in already-stamped cells and may
simply re-die on the next ring. The fix could cost a full `app/sweep/` baseline
(BASE double-run plus BASE-vs-HEAD, roughly 90 minutes, never runnable as a
harness background task) and rescue nothing.

### Hole 5 — the trigger is not defect-specific

**This is the hole that most changes the design's standing.** A genuinely
disconnected destination dies with the **identical** signature: once the
frontier has covered all reachable water, the last ring's children all land in
stamped cells and `dominatedDrops == accepted`. The proposed trigger therefore
cannot distinguish "the solver gave up on reachable water" from "this really is
unreachable", and the salvage fires up to `MAX_SALVAGES` times on **every**
frontier-exhaustion death, true no-routes included. The cost of that is bounded
by `MAX_SALVAGES`, but it multiplies hole 2 — every true no-route now runs
extra rings through an unfrozen classifier. The defect is in the trigger's
**specificity**, not only in its cost.

### The identified path to containment — a different architecture

A gate inside `solve()` cannot see its siblings, so hole 1 cannot be closed
there. Restoring containment needs a **two-pass structure in `planRoute`**: run
the whole tier ladder unchanged and, only if it is about to return no-route,
re-run it with a `SolveParams.allowSalvage` flag. Gating at tier 1 alone is
explicitly **not** enough — a plan that fails tier 1 and succeeds at tier 3
today would flip tier.

That is a **different design from the solve-level salvage**, not a fix wave on
it: a fresh design pass, with its own containment argument and its own
pre-registered prediction (§7 does not transfer to it — see §7's closing note).

### Ordered prerequisites, if this is picked up again

1. **Efficacy** on snapped TWS 2.8 / 3 / 8 — does skipping `visitedDominates`
   for one ring actually produce a surviving frontier, or do the salvaged nodes
   re-die immediately? Nothing else is worth doing until this is answered.
2. A containment gate at **ladder** level per the section above.
3. The counter freeze, plus the two residual cause-drift routes of hole 2, plus
   a maintainer ruling on acceptable cause drift.
4. Only then BASE-vs-HEAD on the three `motorEnabled: false` sweep arms.

---

## 6. The `mirrorCase` disposition — standing instruction

A salvage may red `app/src/routing/realmask.repro.mirrorCase.test.ts` by making
Flensburg → Marstal route at the relaxed 2.3 m gate. That test pins a
genuinely mask-disconnected destination to `unreachable`, with ground truth
from `mask.cellsConnected` rather than from the solver.

**Do NOT edit, relax or delete that assertion, and do NOT add a settings tweak
to keep it red.** If it reds, stop and hand the disposition to the maintainer:
re-pinning at a deeper gate, or retiring the case, is a maintainer call. A test
that goes red because the product changed is information; a test edited to stay
green is the information destroyed.

---

## 7. The pre-registered prediction

Recorded **as pre-registered**: the designer stated this on **2026-09-09**,
BEFORE any HEAD run of the proposal, and no HEAD run has happened since.

**Target.** The `light-motorless` sweep arm (`app/sweep/sweepArms.ts`): real
committed mask and polars, `motorEnabled: false`, otherwise `DEFAULT_SETTINGS`,
uniform TWS 3 / dir 0, Flensburg to all 33 harbours.

**BASE distribution at merge-base `035d662`, measured 2026-09-09** by a
separate agent (the orchestrator's BASE sweep run; not re-run in this
document): **16** `error`/`unreachable`, **15** `ok`, **2**
`error`/`beyond-horizon`.

The 16 failing destinations: aeroeskoebing, aabenraa, arnis, augustenborg,
damp, dyvig, fynshav, graasten, kappeln, langballigau, lyoe, maasholm, marstal,
olpenitz, rudkoebing, schleimuende.

**The prediction, in the designer's own terms, quoted rather than
paraphrased:**

> **6–10 of 16 flip to routed.** Not flipping are arnis, kappeln, maasholm,
> dyvig, graasten — all five in `verify_mask.py`'s `KNOWN_DISCONNECTED` (issue
> #9), a source-data limit with no cell path at any permitted gate. marstal MAY
> flip and would red `mirrorCase`.

> **Falsification criterion: if more than 7 fail to flip, that is evidence
> against the design, not tuning headroom.**

**Independently verified while writing this document** (not taken from the
designer): `verify_mask.py`'s `KNOWN_DISCONNECTED` contains exactly those five
ids — arnis, kappeln, maasholm, dyvig, graasten — and `marstal` carries a
`CONNECTIVITY_EXCEPTIONS_M[("marstal", 3.0)] = 2.0` entry, i.e. it is
exempted at 2.0 m against the 3.0 m gate.

### Recorder's note — the criterion's BASIS is unstated and must be fixed before any HEAD run

The two quoted sentences are preserved verbatim above and are **not** repaired
here, because repairing a pre-registration destroys it. But they do not compose
until someone says what "fail to flip" is counted over:

- **Over all 16.** Flips *F* ∈ [6, 10] means failures 16 − *F* ∈ [6, 10];
  "more than 7 fail" means failures ≥ 8, i.e. *F* ≤ 8. Then *F* = 6, 7, 8 is
  simultaneously predicted and falsifying. Inconsistent.
- **Over the 11 that are not in `KNOWN_DISCONNECTED`.** Failures ∈ [1, 5]
  under the prediction; falsifying at failures ≥ 8, i.e. *F* ≤ 3. Consistent,
  with *F* = 4–5 an unclassified grey zone.

**Resolve the basis with the designer before any HEAD run**, and record the
resolution alongside the original. A prediction that cannot be falsified in a
stated direction is not pre-registration, it is decoration.

### Scope of the pre-registration

This prediction is for **the design AS PROPOSED** in §5 — the solve-level
re-expansion salvage with no counter freeze and no ladder gate. **Any
modification is a DIFFERENT design** — a counter freeze, a ladder-level
containment gate per §5, a different gate, a different trigger — **and must be
re-registered before a HEAD run, or the prediction is worthless.** In
particular the two-pass `planRoute` architecture identified in §5 is a
different design and inherits nothing from this section.

---

## 8. Recommendation

**HOLD. Do not implement the solve-level salvage. #1136 is DEFERRED to
milestone v0.32.0 (maintainer ruling, 2026-09-09).**

Both independent verdicts on the proposal were HOLD, on three grounds:

1. **Plan-level containment is refuted by measurement** (hole 1, #1166) — the
   change is not inert on currently-succeeding plans, which is what the design
   claimed for it.
2. **Efficacy is unmeasured** (hole 4) — salvaged nodes sit in already-stamped
   cells and may re-die immediately, so the fix could cost a full sweep baseline
   and rescue nothing.
3. **The trigger is not defect-specific** (hole 5) — it fires on genuine
   no-routes with the identical signature.

What this spike **does** settle, and what makes the next attempt cheap:

- The mechanism is measured and is **not** the one #1136's title names. It is
  domination pruning discarding mask-validated children, not a missing
  candidate heading. Anyone scoping this should start from §1, not from the
  issue title.
- The candidate-set lever — the intervention #1136's own text points at — is
  **rejected on measurement**, not on cost (§9.1).
- The efficacy question (§5 prerequisite 1) is cheap, is the first thing to
  run, and needs no sweep: the instrumentation in Appendix A plus one probe
  answers it.
- Two separable surfaces were split out (#1166, #1168) so a future #1136 fix is
  not judged on their behaviour.

#1136 stays **open**. This document is evidence for a decision, not a fix and
not a spec.

---

## 9. Considered and rejected

### 9.1 Force `MOTOR_TWAS` (or any extra heading) into the motor-off candidate set — REJECTED on measurement

This is the intervention #1136's own text points at, and the maintainer's
`MOTOR_TWAS`-forcing experiment (quoted in the issue, which itself carries the
caveat that it "identifies the mechanism … is not a proposed fix") is what
motivated it.

Killed by **§2.2**: the corrected pure-add mutation flips four inputs dead →
alive and flips **TWS 2.0 alive → dead**. Adding a heading is not a monotone
improvement — it changes which node wins each `byKey` cell under `better()`,
so it moves the boundary rather than removing it. A lever that rescues four
inputs by breaking a fifth is retuning, not fixing. §3.5 additionally shows its
search cost is unpredictable even in sign (+83 % on one input, −34 % on
another), so it cannot be justified on efficiency either — but note the
rejection rests on §2.2, not on §3.5, which is the weaker (NOT RE-RUN)
evidence.

Secondary objection, and independently sufficient: TWA 20 sits inside the
polar's no-go taper, so a motor-off solve given `MOTOR_TWAS` sails headings its
own polar says it cannot sail.

### 9.2 Relax `visitedDominates` unconditionally — REJECTED

Pruning is what bounds this search. The measured magnitudes: on a single
motor-on ring at TWS 8, `dominatedDrops` reaches **384 379** against
`byKeySet` 22 896 — pruning is discarding roughly 94 % of accepted children on
that ring, and the frontier is still 8 491 wide at ring 45. Removing the test
unconditionally would multiply the frontier by something of that order at every
ring, against `MAX_FRONTIER = 30 000` and `PLAN_BUDGET_MS = 120 000`.

**Labelled honestly:** the magnitudes are MEASURED; the consequence of removing
the test is ARGUED from them, since no unconditional-relaxation run exists. The
salvage in §5 is precisely the attempt to buy this relaxation for one ring at a
time; its own holes are the reason it did not ship, and they do not make the
unconditional form better.

### 9.3 A finer prune grid (`PRUNE_LAT` / `PRUNE_LON`) — REJECTED for now, as unmeasured and expensive

Superficially attractive given §1.3: a finer grid would make fewer children
share a cell with a stamped ancestor. Against it:

- **Unmeasured.** No run exists at any other grid size. Per §1.3 it is not even
  established that same-cell self-domination is the dominant channel — the
  instrumentation does not record which stamp dominated.
- **It changes `pruneKey` for every plan**, so it owes a full `app/sweep/`
  baseline (BASE double-run plus BASE-vs-HEAD, ~90 min) before anyone knows
  whether it helps.
- **§2.2 and §3.5 both show search-shape changes are unpredictable in sign.** A
  finer grid is a search-shape change of exactly that kind; there is no reason
  to expect it monotone where adding a heading was not.
- It multiplies frontier and memory at every ring, against `MAX_FRONTIER`.

Not refuted — untested, and untestable cheaply. If the full-step/fitted split
of §1.3 shows self-domination dominating, this becomes worth one measurement.

### 9.4 A new `SolveFailureCause` to distinguish "gave up" from "unreachable" — REJECTED as a fix

A correct label still leaves connected water unrouted: the user is told
something truer and still gets no route. #1136's own text records that **two**
independent prior attempts at the classifier were built, measured and reverted
(`5a7a35a`), leaving `isochrone.ts` byte-identical to pre-attempt `develop`
with only a test shipping. A third classifier patch would be the same move a
third time.

It is also the most dangerous cheap change available: `SolveFailureCause` gates
`depthRelaxationMayHelp` and `comfortRetryMayHelp`, so a classification change
silently moves routes — the #282 label-as-control coupling, with the measured
cost quoted in hole 2.

**Not rejected as future work**, only as a fix for this: surfacing the
distinction is a real gap (the `#866` comment says so, and `isochrone.ts`'s
`MAX_FRONTIER` comment records the same "search capacity vs. actual
unreachability" ambiguity as a deferred plan amendment). It is a separate
issue from routing connected water.

---

## Appendix A — `instrumentation.patch`, verbatim

Behaviour-neutral except for the `SC_PURE_ADD` env hook on `EXTRA_TWAS`. Adds a
`RING_STATS` array and per-ring counters. Reproduced in full because the
scratch directory it lived in is untracked.

```diff
diff --git a/app/src/routing/isochrone.ts b/app/src/routing/isochrone.ts
index d34083e..c133712 100644
--- a/app/src/routing/isochrone.ts
+++ b/app/src/routing/isochrone.ts
@@ -171,7 +171,15 @@ const PRUNE_LON = 0.003; // ~190 m at 55°N
 // reflect search capacity rather than actual unreachability; surfacing that
 // distinction to the caller is deferred (plan-amendment pending).
 const MAX_FRONTIER = 30_000;
-const EXTRA_TWAS = [45, 55, 65, 75, 85, 95, 105, 115, 125, 135, 145, 155, 165, 175];
+const EXTRA_TWAS = (process.env.SC_PURE_ADD
+  ? process.env.SC_PURE_ADD.split(',').map(Number).concat([45, 55, 65, 75, 85, 95, 105, 115, 125, 135, 145, 155, 165, 175])
+  : [45, 55, 65, 75, 85, 95, 105, 115, 125, 135, 145, 155, 165, 175]);
+export const RING_STATS: {
+  ring: number; nodes: number; accepted: number; blocked: number;
+  horizonDrops: number; dominatedDrops: number; betterLoss: number; byKeySet: number;
+  directAccepted: number; captureAccepted: number; nextLen: number; hasBest: boolean;
+}[] = [];
+export function resetRingStats() { RING_STATS.length = 0; }
 const MOTOR_TWAS = [0, 20, 35];
@@ -400,6 +408,7 @@ export function solve(p: SolveParams): SolveResult {
     }
 
     const byKey = new Map<string, Node>();
+    let _accepted = 0, _blocked = 0, _horizonDrops = 0, _dominatedDrops = 0, _betterLoss = 0, _byKeySet = 0, _directAcc = 0, _captureAcc = 0;
     for (const node of frontier) {
@@ -466,6 +475,7 @@ export function solve(p: SolveParams): SolveResult {
           );
           if (directFactor !== null) {
+            _directAcc++;
             const penaltyS = dtS - effS;
@@ -513,6 +523,7 @@ export function solve(p: SolveParams): SolveResult {
         const fullFactor = edgeFactor(mask, from, end, gate, comfortDepthM);
         let factor: number;
         if (fullFactor !== null) {
+          _accepted++;
           factor = fullFactor;
         } else {
@@ -540,12 +551,14 @@ export function solve(p: SolveParams): SolveResult {
           if (fitted === null) {
+            _blocked++;
             sawBlocked = true;
             continue;
           }
+          _accepted++;
           factor = fitted;
         }
-        if (node.tMs + stepMs > horizonMs) continue;
+        if (node.tMs + stepMs > horizonMs) { _horizonDrops++; continue; }
@@ -587,6 +600,7 @@ export function solve(p: SolveParams): SolveResult {
             if (captureFactor !== null) {
+              _captureAcc++;
               const candCostMs = child.costMs + durMs / captureFactor;
@@ -608,9 +622,9 @@ export function solve(p: SolveParams): SolveResult {
         const key = pruneKey(child.lat, child.lon, child.kind, child.board);
         const seen = visited.get(key);
-        if (seen !== undefined && visitedDominates(seen, child)) continue;
+        if (seen !== undefined && visitedDominates(seen, child)) { _dominatedDrops++; continue; }
         const incumbent = byKey.get(key);
-        if (!incumbent || better(child, incumbent)) byKey.set(key, child);
+        if (!incumbent || better(child, incumbent)) { byKey.set(key, child); _byKeySet++; } else { _betterLoss++; }
         produced++;
       }
 
@@ -642,6 +656,9 @@ export function solve(p: SolveParams): SolveResult {
         costMs: n.costMs,
         maneuvers: n.maneuvers,
       });
+    RING_STATS.push({ ring: RING_STATS.length, nodes: frontier.length, accepted: _accepted, blocked: _blocked,
+      horizonDrops: _horizonDrops, dominatedDrops: _dominatedDrops, betterLoss: _betterLoss, byKeySet: _byKeySet,
+      directAccepted: _directAcc, captureAccepted: _captureAcc, nextLen: next.length, hasBest: best !== null });
     frontier = next;
     tMs += dtS * 1000;
```

Note the `_directAcc++` site sits inside the direct-arrival block, which ends
in `continue` before either `_accepted++` site — which is why `directAccepted`
is outside the `accepted` total (§2.1).

---

## Appendix B — probe harness

Imports rewritten to placeholders: `<scratchpad>/wt-refute/` is the worktree
created at step 2 of §0, `<repo>` the repository root. The harness reads the
real committed assets from `<repo>/app/public/data`, so the mask and polars are
the shipped ones, not fixtures.

```ts
import { it } from 'vitest';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { NavMask } from '<scratchpad>/wt-refute/app/src/lib/mask';
import { Polar } from '<scratchpad>/wt-refute/app/src/lib/polar';
import { WindField } from '<scratchpad>/wt-refute/app/src/lib/wind';
import { solve, RING_STATS, resetRingStats } from '<scratchpad>/wt-refute/app/src/routing/isochrone';
import { uniformWindGrid } from '<scratchpad>/wt-refute/app/src/test/fixtures';
import { DEFAULT_SETTINGS } from '<scratchpad>/wt-refute/app/src/types';
import { uniformGate } from '<scratchpad>/wt-refute/app/src/lib/depthGate';
import type { MaskMeta, PolarTable, Settings } from '<scratchpad>/wt-refute/app/src/types';

const LOG = process.env.SC_LOG!;
const OUT = (s: string) => appendFileSync(LOG, s + '\n');
const dd = '<repo>/app/public/data';
const meta = JSON.parse(readFileSync(`${dd}/mask.meta.json`, 'utf8')) as MaskMeta;
const realMask = new NavMask(meta, new Uint8Array(readFileSync(`${dd}/mask.bin`)));
const tG = JSON.parse(readFileSync(`${dd}/polars/salona-45-genoa.json`, 'utf8')) as PolarTable;
const FLENSBURG = { lat: 54.798, lon: 9.4335 };
const BAGENKOP = { lat: 54.753, lon: 10.668 };
const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);
// SNAPPED variant (faithful to planRoute). The unsnapped variant sets
// ORIGIN = FLENSBURG, DEST = BAGENKOP instead; the two differ by 24.7 m.
const ORIGIN = realMask.snapToNavigable(FLENSBURG, 3)!;
const DEST = realMask.snapToNavigable(BAGENKOP, 3)!;
const ALIVE = 'ALIVE_AT_CAP';

function run(label: string, o: { tws: number; dir: number; motor: boolean; cap?: number;
    origin?: {lat:number;lon:number}; beat?: number; gybe?: number; comfort?: number }) {
  resetRingStats();
  const b0 = new Polar(tG);
  // beat/gybe overrides are the DESIGNER'S forms; both are swaps, not adds -
  // see section 2.2. The corrected pure-add uses SC_PURE_ADD=35 and leaves
  // the polar alone (o.beat and o.gybe both undefined).
  const base = (o.beat === undefined && o.gybe === undefined) ? b0 : ({
    rig: b0.rig,
    speedKn: (t: number, w: number) => b0.speedKn(t, w),
    beatAngleDeg: (w: number) => o.beat ?? b0.beatAngleDeg(w),
    gybeAngleDeg: (w: number) => o.gybe ?? b0.gybeAngleDeg(w),
  } as unknown as Polar);
  const settings: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 3, motorEnabled: o.motor };
  const wind = new WindField(uniformWindGrid(o.tws, o.dir));
  const cap = o.cap ?? 45;
  let rings = 0;
  let out = '';
  try {
    const res = solve({
      origin: o.origin ?? ORIGIN, destination: DEST, departureMs: T0,
      polar: base, wind, mask: realMask, settings,
      ...(o.comfort !== undefined ? { comfortDepthM: o.comfort } : {}),
      onProgress: () => { rings++; if (rings >= cap) throw new Error(ALIVE); },
    });
    out = `status=${res.status} cause=${(res as any).cause ?? '-'} rings=${rings}`
      + (res.status === 'ok' ? ` etaH=${((res.etaMs - T0) / 3.6e6).toFixed(2)}` : '');
  } catch (e) {
    if ((e as Error).message === ALIVE) out = `ALIVE at ring ${cap}`; else throw e;
  }
  OUT(`### [${label}] ${out}  RING_STATS.len=${RING_STATS.length}`);
  for (const r of RING_STATS.slice(-4))
    OUT(`    ring${r.ring} nodes=${r.nodes} acc=${r.accepted} blk=${r.blocked} horiz=${r.horizonDrops}`
      + ` dom=${r.dominatedDrops} betterLoss=${r.betterLoss} set=${r.byKeySet} dir=${r.directAccepted}`
      + ` cap=${r.captureAccepted} next=${r.nextLen} best=${r.hasBest}`);
}

it('F3 + F1 + F7', () => {
  writeFileSync(LOG, `PURE_ADD=${process.env.SC_PURE_ADD ?? '(none)'}\n`
    + `origin=${JSON.stringify(ORIGIN)} dest=${JSON.stringify(DEST)}\n`);
  OUT(`connected@3.0 = ${realMask.cellsConnected(ORIGIN, DEST, uniformGate(3))}`);
  for (const tws of [2.0, 2.8, 3, 8]) run(`OFF tws${tws} dir0`, { tws, dir: 0, motor: false });
  run('ON tws2.8 dir0 (motor control)', { tws: 2.8, dir: 0, motor: true, cap: 46 });
  run('ON tws8 dir0 (motor control)', { tws: 8, dir: 0, motor: true, cap: 46 });
});
```

The `vitest.config.ts` beside it is a three-line file setting `include` to
`probe.test.ts`; `node_modules` is a symlink to `<repo>/app/node_modules`.

---

## Appendix C — raw `RING_STATS` tails

The last four rings of each cited run. `ALIVE at ring N` means the probe's
`onProgress` cap fired, i.e. **still searching** — not "routed" (§3.2).

### C.1 Snapped, dir 0 — the decisive measurement (`base.txt`)

```
origin={"lat":54.798125,"lon":9.433818181818182} dest={"lat":54.753125,"lon":10.668}
connected@3.0 = true
### [OFF tws2 dir0] ALIVE at ring 45
    ring41 nodes=59 acc=1925 blk=81 horiz=0 dom=1217 betterLoss=478 set=230 dir=0 cap=0 next=88 best=false
    ring42 nodes=88 acc=2917 blk=75 horiz=0 dom=1821 betterLoss=821 set=275 dir=0 cap=0 next=92 best=false
    ring43 nodes=92 acc=3085 blk=43 horiz=0 dom=2016 betterLoss=813 set=256 dir=0 cap=0 next=92 best=false
    ring44 nodes=92 acc=3039 blk=89 horiz=0 dom=1767 betterLoss=912 set=360 dir=0 cap=0 next=130 best=false
### [OFF tws2.8 dir0] status=no-route cause=mask-blocked rings=5
    ring1 nodes=8 acc=203 blk=69 horiz=0 dom=130 betterLoss=46 set=27 dir=0 cap=0 next=13 best=false
    ring2 nodes=13 acc=305 blk=137 horiz=0 dom=261 betterLoss=22 set=22 dir=0 cap=0 next=7 best=false
    ring3 nodes=7 acc=146 blk=92 horiz=0 dom=134 betterLoss=6 set=6 dir=0 cap=0 next=5 best=false
    ring4 nodes=5 acc=104 blk=66 horiz=0 dom=104 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [OFF tws3 dir0] status=no-route cause=mask-blocked rings=5
    ring1 nodes=8 acc=186 blk=86 horiz=0 dom=135 betterLoss=32 set=19 dir=0 cap=0 next=11 best=false
    ring2 nodes=11 acc=289 blk=85 horiz=0 dom=249 betterLoss=20 set=20 dir=0 cap=0 next=5 best=false
    ring3 nodes=5 acc=106 blk=64 horiz=0 dom=80 betterLoss=17 set=9 dir=0 cap=0 next=3 best=false
    ring4 nodes=3 acc=49 blk=53 horiz=0 dom=49 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [OFF tws8 dir0] status=no-route cause=mask-blocked rings=4
    ring0 nodes=1 acc=17 blk=17 horiz=0 dom=0 betterLoss=4 set=13 dir=0 cap=0 next=9 best=false
    ring1 nodes=9 acc=128 blk=178 horiz=0 dom=63 betterLoss=41 set=24 dir=0 cap=0 next=15 best=false
    ring2 nodes=15 acc=235 blk=275 horiz=0 dom=226 betterLoss=3 set=6 dir=0 cap=0 next=4 best=false
    ring3 nodes=4 acc=51 blk=85 horiz=0 dom=51 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [ON tws2.8 dir0 (motor control)] ALIVE at ring 46
    ring45 nodes=5366 acc=203410 blk=5227 horiz=0 dom=178719 betterLoss=17146 set=7545 dir=0 cap=0 next=3121 best=false
### [ON tws8 dir0 (motor control)] ALIVE at ring 46
    ring44 nodes=13370 acc=509769 blk=10346 horiz=0 dom=416673 betterLoss=67122 set=25974 dir=0 cap=0 next=10910 best=false
    ring45 nodes=10910 acc=415126 blk=9340 horiz=0 dom=345617 betterLoss=49390 set=20119 dir=0 cap=0 next=8491 best=false
```

### C.2 Tier-1 fidelity, `comfortDepthM = 5` (`comfort.txt`)

`DEFAULT_SETTINGS.depthComfortMarginM` is 2, so the tier-1 comfort depth is
3 + 2 = 5. Every counter matches C.1 exactly.

```
margin=2
### [tws2.8 comfort=5] status=no-route cause=mask-blocked rings=5
    ring4 nodes=5 acc=104 blk=66 horiz=0 dom=104 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws3 comfort=5] status=no-route cause=mask-blocked rings=5
    ring4 nodes=3 acc=49 blk=53 horiz=0 dom=49 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws8 comfort=5] status=no-route cause=mask-blocked rings=4
    ring3 nodes=4 acc=51 blk=85 horiz=0 dom=51 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
```

### C.3 Non-monotonicity and the order-independence control (`f2.txt`, unsnapped)

The `REPEAT-REV` block re-runs the same four inputs in reverse order inside one
process. Every counter is byte-identical to the forward run, which is what
kills the shared-mutable-state hypothesis.

```
UNSNAPPED origin={"lat":54.798,"lon":9.4335} dest={"lat":54.753,"lon":10.668}
connected@3.0 = true
### [UNSNAP tws2.4] status=no-route cause=mask-blocked rings=6
    ring5 nodes=3 acc=77 blk=25 horiz=0 dom=77 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [UNSNAP tws2.6] ALIVE at ring 45
    ring44 nodes=296 acc=9855 blk=209 horiz=0 dom=6672 betterLoss=2245 set=938 dir=0 cap=0 next=374 best=false
### [UNSNAP tws2.8] status=no-route cause=mask-blocked rings=5
    ring4 nodes=5 acc=117 blk=53 horiz=0 dom=117 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [UNSNAP tws3] ALIVE at ring 45
    ring44 nodes=1012 acc=33689 blk=625 horiz=0 dom=25077 betterLoss=5906 set=2706 dir=0 cap=0 next=1195 best=false
### [REPEAT-REV tws3] ALIVE at ring 45
    ring44 nodes=1012 acc=33689 blk=625 horiz=0 dom=25077 betterLoss=5906 set=2706 dir=0 cap=0 next=1195 best=false
### [REPEAT-REV tws2.8] status=no-route cause=mask-blocked rings=5
    ring4 nodes=5 acc=117 blk=53 horiz=0 dom=117 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [REPEAT-REV tws2.6] ALIVE at ring 45
    ring44 nodes=296 acc=9855 blk=209 horiz=0 dom=6672 betterLoss=2245 set=938 dir=0 cap=0 next=374 best=false
### [REPEAT-REV tws2.4] status=no-route cause=mask-blocked rings=6
    ring5 nodes=3 acc=77 blk=25 horiz=0 dom=77 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
```

### C.4 The candidate-set mutation, corrected form (`f4_base.txt` / `f4_add.txt`, snapped)

`PLAIN` rows use the untouched polar; the difference between the two files is
`SC_PURE_ADD=35` alone. Read the PLAIN rows against each other — those are the
corrected pure-add comparison of §2.2. The `gybe=35` / `beat=35` rows are the
designer's two swap forms, kept so the method note in §2.2 stays checkable.

```
--- f4_base.txt (PURE_ADD=(none)) ---
### [tws2 PLAIN] ALIVE at ring 45
### [tws2 gybe=35 (doc ADD)] status=no-route cause=mask-blocked rings=5
    ring1 nodes=9 acc=243 blk=63 horiz=0 dom=171 betterLoss=47 set=25 dir=0 cap=0 next=12 best=false
    ring4 nodes=2 acc=39 blk=29 horiz=0 dom=39 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws2 beat=35 (doc SWAP)] status=no-route cause=mask-blocked rings=5
    ring1 nodes=9 acc=244 blk=62 horiz=0 dom=176 betterLoss=39 set=29 dir=0 cap=0 next=12 best=false
    ring4 nodes=2 acc=40 blk=28 horiz=0 dom=40 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws2.4 PLAIN] status=no-route cause=mask-blocked rings=5
### [tws2.8 PLAIN] status=no-route cause=mask-blocked rings=5
### [tws3 PLAIN]   status=no-route cause=mask-blocked rings=5
### [tws8 PLAIN]   status=no-route cause=mask-blocked rings=4

--- f4_add.txt (PURE_ADD=35) ---
### [tws2 PLAIN] status=no-route cause=mask-blocked rings=5
    ring1 nodes=9 acc=259 blk=65 horiz=0 dom=186 betterLoss=48 set=25 dir=0 cap=0 next=12 best=false
    ring2 nodes=12 acc=364 blk=68 horiz=0 dom=345 betterLoss=9 set=10 dir=0 cap=0 next=6 best=false
    ring3 nodes=6 acc=140 blk=76 horiz=0 dom=135 betterLoss=2 set=3 dir=0 cap=0 next=2 best=false
    ring4 nodes=2 acc=42 blk=30 horiz=0 dom=42 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws2.4 PLAIN] ALIVE at ring 45
### [tws2.8 PLAIN] ALIVE at ring 45
### [tws3 PLAIN]   ALIVE at ring 45
### [tws8 PLAIN]   ALIVE at ring 45
```

The three TWS 2.0 death runs share the frontier-size sequence 9, 12, 6, 2, 0
while their per-ring counters differ — see §2.3.
