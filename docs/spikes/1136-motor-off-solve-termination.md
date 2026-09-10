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
  against that mechanism was NOT implemented: its containment is airtight at
  SOLVE level and breaks at PLAN level — a solve dying inside a plan that
  returns `ok` today, which is the designer's `planRoute` row and is
  UNCORROBORATED (§5, hole 1); its trigger cannot distinguish a solver give-up
  from a genuine no-route; and as of 2026-09-09 its efficacy had not been run
  on any input. #1136
  was DEFERRED to milestone v0.32.0 on 2026-09-09 (maintainer ruling); v0.32.0
  has since SHIPPED and #1136 sits open in v0.33.0 as of 2026-09-10 (see §10
  for the first of §5's four prerequisites, now run). This
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
patch (Appendix A), the surviving harness states (Appendix B) and all five raw
logs (Appendix C) are reproduced VERBATIM here — each byte-diffed against its
source, with only the two absolute paths placeholdered — because the scratch
directory they lived in is not tracked and will not survive this session. One
harness state did not survive even that long: the F4 driver's `it()` body is
absent from disk, and Appendix B says so rather than reconstructing it.

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
unchanged (`comfort.txt` against `base.txt`, byte-for-byte on the logged rows —
covering `tws2.8`, `tws3` and `tws8`, i.e. **three of the four** motor-off
configurations in `base.txt`; `tws2` was not re-run at tier-1 fidelity). So
this is not an artifact of running bare `solve()` at tier-2 fidelity: the
depth-comfort preference does not touch it.

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
writing this document, not spot-checked).

**The count carries its filter.** The harness logs `RING_STATS.slice(-4)`, so
"188 logged rings" is the LAST FOUR rings of each of **47** runs — 188 of the
**1356** rings those runs executed, about 14 %. That aperture does not weaken
the conclusion, and the reason is structural rather than lucky: a run's dying
ring is by construction its last, so every ring the argument turns on is inside
its own window. It does mean the identity is verified on the tail of each run,
not on every ring executed. On the dying rings the other three
terms are 0, so the identity collapses to `accepted == dominatedDrops`. That
is an accounting identity over the recorded quantities, not an argument about
which code paths exist — an unenumerated drop channel would have shown up as
a shortfall in the sum and did not. The `#866` comment's "solver gave up"
alternative is therefore the measured case here, not a possibility.

Also measured, and worth recording because the brief for this document assumed
otherwise: `directAccepted` and `captureAccepted` are **0 on every one of
those 188 rings**, not merely on the dying ones.

### 1.3 The mechanism, by symbol

`stampVisited` LOWERS each surviving node's prune cell toward
`{costMs, maneuvers}` at the end of every ring (the loop over `next` after the
frontier cap) — it takes the minimum on each axis INDEPENDENTLY, so a cell's
stamp need not be any single node's arrival. The doc comment that says what
follows is `visitedDominates`'s, not `stampVisited`'s (`isochrone.ts:263-264`
at `035d662`): "Componentwise minima can combine two different stampers into a
dominator neither of them was alone". On the next ring `visitedDominates(seen, child)` discards any child that
is no better on **both** axes — `seen.costMs <= cand.costMs && seen.maneuvers
<= cand.maneuvers`. A node's own stamp dominates a child that lands back in the
node's **own** cell by construction, since the ranking clock only advances and
maneuvers only accumulate — but read that clause with the paragraph below: on
this route only a `dtS/2`..`dtS/8` substep produces a same-cell child at all,
so self-domination is a sufficient condition that a full step cannot meet.
`pruneKey`'s third component is `'M' | 'P' | 'S'`, so a beating thread has two
lanes (port and starboard) rather than one.

**Label: the same-cell clause above is ARGUED from the code, not measured.** The
instrumentation counts `dominatedDrops` but does not record *which* stamp
dominated each dropped child — the parent's own cell, or a cell stamped in an
earlier ring by different threads. Both are `visitedDominates` drops and the
counter cannot tell them apart. Note the componentwise merge above makes the
question "WHICH stamp dominated?" not quite well-posed: the dominating pair may
be a synthetic minimum no node ever arrived with. The by-CELL split is still
exhaustive, so the argument survives — but a child landing back in its parent's
own cell may be dominated by a foreign thread's lower `costMs` merged into that
cell rather than by its parent. See §4.

**One DEDUCED refinement, because it changes what a fix would have to
target.** `dtS` is 600 s while the destination is more than 5 nm away
(`isochrone.ts`: `minDist < 2 ? 150 : minDist < 5 ? 300 : 600`). Maximum
Salona-45 genoa speed over TWA, computed here from the committed polar, is
3.30 kn at TWS 2.8 and 7.39 kn at TWS 8 — so a **full** step runs ~1020 m and
~2281 m respectively, against `PRUNE_LAT = 0.002` (~220 m) and `PRUNE_LON =
0.003` (~190 m). A full-step child therefore lands several prune cells away
from its parent and cannot be dominated by its parent's own stamp. Same-cell
self-domination is reachable only through the `dtS/2`, `dtS/4`, `dtS/8`
substep retry, whose shortest hop is 127.5 m at TWS 2.8's BEST TWA, and less
at any other heading — inside one cell there. That is TWS-2.8-only: the same
`dtS/8` substep runs 285.1 m at TWS 8, which exceeds both `PRUNE_LAT` and
`PRUNE_LON`, so a same-cell child at TWS 8 needs a heading slower than the
best one. The
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
passage having spent **under 0.5 %** of the budget.

Do not read this table as showing that direction decides between routing and
not routing: at fixed TWS 3, dir 0 dies in the refuter's bare `solve()` while
dir 45 routes in the designer's `planRoute` — two different instruments, and no
bare `solve()` was run at dir 45. At the instrument the user actually meets,
`planRoute` returns `ok` at dir 0 as well; what direction changes there is a
full two-rig comparison versus a half one (the #1166 row).

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
identity holds exactly on all 188 LOGGED rings — that aperture, and why it does
not weaken the conclusion, is stated in §1.2 — and `directAccepted` /
`captureAccepted` are 0 on every one of them. All three extra channels read
zero on the measured rings, so `accepted == dominatedDrops` on the dying rings is a
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
frontiers, whose `nextLen` never exceeds **15** across the **three** dying runs
in `base.txt` (`OFF tws2.8`, `OFF tws3`, `OFF tws8`). The fourth motor-off run
there, `OFF tws2`, is ALIVE at ring 45 and reaches `nextLen` 130, so it belongs
to neither side of this contrast.

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
- **That a genuinely disconnected destination dies with the same signature
  (§5 hole 5): DEDUCED from the identity, never instanced** — every run here is
  Flensburg → Bagenkop, which the oracle proves connected.
- **No `planRoute`-level run by the refuter at all.** Every refuter measurement
  is a bare `solve()` call.
- **Salvage efficacy: as of 2026-09-09, not run on any input.** The proposal
  had not been executed at that date.
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

### Hole 1 — containment breaks at PLAN level (that half UNCORROBORATED)

Containment at **solve level** is airtight: a solve that already holds a `best`
never salvages. But `planRoute` does not succeed on a solve — it succeeds on
`tierN.some((r) => r.rigResult)`, i.e. **per rig**, at each tier. The measured
counter-example is #1166: at TWS 3, snapped, dir 0, one rig's `solve()` dies
with `next = 0`, `best === false`, `dominated == accepted` at **both** tier-1
and tier-2 fidelity, inside a plan that returns `ok` **today**. The salvage
would fire inside a currently-succeeding plan and can change `sails`, the rig
comparison, and the ★ recommendation.

Both halves are measured, but by different agents and only one is corroborated:
the refuter measured the `solve()`-level death, while "inside a plan that
returns `ok` today" is the designer's `planRoute` row, which §4 records the
refuter never ran. Read the plan-level half as UNCORROBORATED (§1.4).

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
Flensburg → Marstal — the route #1147 records as the least forgiving input in
the repo for a change that adds rings. Quote its figure with BOTH qualifiers
#1147 puts in bold — the CLOCK and the LOAD. The clock: **29.5 %** headroom on
the monotonic clock, **36.8 %** on the wall clock, and #1147's own body says
the wall-clock figure is the operative one because the deadline check is
`Date.now() - startedAtMs >= budgetMs`. The load: #1147 records the
environment as WSL2 with roughly a dozen concurrent sibling agent sessions on
the same machine at measurement time — measured under real, unquantified CPU
contention — and therefore calls the reported headroom a **conservative lower
bound**. Note also
that #1147 locates `PLAN_BUDGET_MS` in `protocol.ts`; it is not there —
`grep -c PLAN_BUDGET_MS app/src/routing/protocol.ts` returns **0** and the
constant is declared at `workerClient.ts:108` (verified 2026-09-09 at
`035d662`). The next reader will meet that contradiction.

### Hole 4 — the design was never RUN

Its author was read-only. Every claim about behaviour on working plans is
structural, not empirical. In particular, **salvage efficacy had not been
measured on any input as of 2026-09-09**: salvaged nodes sit in already-stamped cells and may
simply re-die on the next ring. The fix could cost a full `app/sweep/` baseline
(BASE double-run plus BASE-vs-HEAD, roughly 90 minutes, never runnable as a
harness background task) and rescue nothing.

### Hole 5 — the trigger is not defect-specific

**This is the hole that most changes the design's standing.** A genuinely
disconnected destination dies with the **identical** signature: once the
frontier has covered all reachable water, the last ring's children all land in
stamped cells and `dominatedDrops == accepted`.

**Label: DEDUCED, not observed** — every run in this document is
Flensburg → Bagenkop, which §0's oracle proves CONNECTED, so no disconnected
destination was ever logged. The derivation is short enough to give rather than
hedge: `next.length === 0` means `byKey` is empty, i.e. `byKeySet == 0`;
`betterLoss` requires a truthy `incumbent`, which requires a prior `byKey.set`
in the same ring, so `byKeySet == 0` forces `betterLoss == 0`; §1.2's identity
then gives `accepted == horizonDrops + dominatedDrops`, and THAT equality
holds for ANY frontier-exhaustion death, connected or not. Its collapse to
`dominatedDrops == accepted` additionally needs `horizonDrops == 0`, which is
measured on all 188 logged rings here but is not derived for a disconnected
destination. The hole's conclusion is safe
either way, because the proposed trigger is `next.length === 0 && best === null`
and fires on every frontier-exhaustion death whatever the counters read. The proposed trigger therefore
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
BEFORE any HEAD run of the proposal, and as of that date no HEAD run had
happened.

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

**A second, OLDER and unrelated source corroborates the 16 and the 2 — but not
the 15, and not as an outcome distribution.** `app/sweep/sweepArms.ts`'s own
arm-inventory comment records `light-motorless` as `Gate 16/2`, measured on the
**2026-08-07 baseline (198 plans)**, i.e. a different day and a different tree
from §7's BASE run. Quote it with the meaning that comment's own header gives
it: "Gate counts below are `depthRelaxationMayHelp` true/false and come from an
instrumented run" — so 16/2 is a PREDICATE's true/false split over 18
observations, **not** 16 `unreachable` and 2 `beyond-horizon` outcomes.

What makes it corroboration rather than coincidence is DEDUCED, not stated
there: `depthRelaxationMayHelp` is consulted only on a failed solve and admits
only `mask-blocked`, so a gate-TRUE observation corresponds to a `mask-blocked`
failure and a gate-FALSE one to a failure of another cause — on this arm,
`horizon-exceeded`. Its 18 total also matches §7's 16 + 2 = 18 error rows
against 33 harbours. Two limits worth stating rather than glossing: the gate can
in principle be consulted more than once per plan, so the counts are
observations and not necessarily per-harbour; and a gate observation happens
only on FAILURE, so this source says **nothing** about the 15 `ok` rows.

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

Three grounds:

1. **Plan-level containment is refuted by measurement** (hole 1, #1166) — the
   change is not inert on currently-succeeding plans, which is what the design
   claimed for it. The `solve()`-level half is the refuter's, corroborated; the
   plan-level half is the designer's `planRoute` run and is UNCORROBORATED
   (§1.4, §4).
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
- The efficacy question (§5 prerequisite 1) is cheap and is the first thing to
  run. It needs no sweep — a scratch measurement owes no baseline, only a
  shipped change does — but it does need the salvage itself written: the
  instrumentation in Appendix A contains no salvage, so answering it takes that
  instrumentation PLUS a scratch implementation of the re-expansion PLUS one
  probe.
- Two separable surfaces were split out (#1166, #1168) so a future #1136 fix is
  not judged on their behaviour.

#1136 was **open** at `035d662` on 2026-09-09. This document is evidence for
a decision, not a fix and not a spec.

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
motor-on ring at TWS 8 (`base.txt`, `ON tws8 dir0`, ring 42),
`dominatedDrops` reaches **384 379** of **464 874** accepted edges —
`dominatedDrops / accepted` = **82.7 %**, discarded by domination alone on that
one ring — and ring 45's `nextLen` is still 8 491 (that ring's `nodes` is
10 910). State the
denominator with the figure: 94 % is reachable here only as
`dom / (dom + byKeySet)`, which excludes the 57 599 children `better()` dropped
and is not the set this sentence is about. Removing the test
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

- **Unmeasured.** As of 2026-09-09 no run at any other grid size existed. Per §1.3 it is not even
  established that same-cell self-domination is the dominant channel — the
  instrumentation does not record which stamp dominated.
- **It changes `pruneKey` for every plan**, so it owes a full `app/sweep/`
  baseline (BASE double-run plus BASE-vs-HEAD, ~90 min) before anyone knows
  whether it helps.
- **Search-shape changes are unpredictable, on two different axes.** §2.2
  (MEASURED) shows the OUTCOME itself flipping both ways, dead to alive and
  back; §3.5 (NOT RE-RUN) shows search COST changing sign, +83 % / -34 %. A
  finer grid is a search-shape change of exactly that kind; there is no reason
  to expect it monotone where adding a heading was not.
- It multiplies frontier and memory at every ring, against `MAX_FRONTIER`.

Not refuted — untested, and untestable cheaply. If the full-step/fitted split
of §1.3 shows self-domination dominating, this becomes worth one measurement —
but note that split cannot see a COMPONENTWISE dominator (§1.3): a synthetic
cell minimum is neither self- nor cross-thread domination, and a finer grid
would not obviously remove it.

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
 // #243 depth comfort preference: the maximum fraction by which a segment's
 // clock cost is inflated when its clearance sits exactly at the gate (linear
@@ -400,6 +408,7 @@ export function solve(p: SolveParams): SolveResult {
     }
 
     const byKey = new Map<string, Node>();
+    let _accepted = 0, _blocked = 0, _horizonDrops = 0, _dominatedDrops = 0, _betterLoss = 0, _byKeySet = 0, _directAcc = 0, _captureAcc = 0;
     for (const node of frontier) {
       const from = { lat: node.lat, lon: node.lon };
       const w = wind.sample(from, node.tMs);
@@ -466,6 +475,7 @@ export function solve(p: SolveParams): SolveResult {
             comfortDepthM,
           );
           if (directFactor !== null) {
+            _directAcc++;
             const penaltyS = dtS - effS;
             // TRUE elapsed time for this hop — unaffected by the depth
             // comfort factor (#243 §D.5: geometry and true time stay honest;
@@ -513,6 +523,7 @@ export function solve(p: SolveParams): SolveResult {
         const fullFactor = edgeFactor(mask, from, end, gate, comfortDepthM);
         let factor: number;
         if (fullFactor !== null) {
+          _accepted++;
           factor = fullFactor;
         } else {
           // A full step can be far longer than the local channel is straight
@@ -540,12 +551,14 @@ export function solve(p: SolveParams): SolveResult {
             }
           }
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
 
         const child: Node = {
           lat: end.lat,
@@ -587,6 +600,7 @@ export function solve(p: SolveParams): SolveResult {
               comfortDepthM,
             );
             if (captureFactor !== null) {
+              _captureAcc++;
               const candCostMs = child.costMs + durMs / captureFactor;
               if (!best || candCostMs < best.costMs) {
                 const last: Node = {
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
     // Report the true frontier clock: substepped nodes lag the ring clock by
```

Note the `_directAcc++` site sits inside the direct-arrival block, which ends
in `continue` before either `_accepted++` site — which is why `directAccepted`
is outside the `accepted` total (§2.1).

---

## Appendix B — the probe harness, in the three states that survive

**Read this section header before reusing anything below.** The harness was
edited in place as the investigation went, and three successive on-disk states
survive. They are printed SEPARATELY and verbatim rather than merged: each has a
different `it()` body, and B.2 additionally uses the RAW harbour coordinates
where B.1 and B.3 use snapped ones, so a single combined body would be a file
that never existed and never produced any of these logs. (Only B.3's `run()`
SIGNATURE differs — it adds `beat?`, `gybe?`, `comfort?`; B.1's and B.2's are
byte-identical, so the signature is not what separates those two.)
An earlier draft of this appendix did exactly that — unioning the option surface
of the last state onto the `it()` of the first — and it regenerated `base.txt`
alone while claiming to be the harness.

| state | `it()` | produced |
|---|---|---|
| B.1 `probe.f3.bak` | `F3 + F1 + F7` | `base.txt` |
| B.2 `tmp.ts` | `F2 chaos, UNSNAPPED` | `f2.txt` |
| B.3 `probe.test.ts` | `tier-1 fidelity: comfortDepthM present` | `comfort.txt` |

**The F4 driver is NOT among them and is not recoverable from disk.** No
surviving file contains the `beat: 35` / `gybe: 35` call sites or the
`(doc ADD)` / `(doc SWAP)` labels that `f4_base.txt` and `f4_add.txt` record, so
that `it()` body is lost. What survives of it: B.3's `run()` signature carries
the `beat`/`gybe` options it used, and the logs in C.4 record exactly which
combinations it iterated (TWS 2 / 2.4 / 2.8 / 3 / 8 x PLAIN / `gybe: 35` /
`beat: 35`, snapped, dir 0, with `SC_PURE_ADD=35` supplying the corrected pure
add). Reconstructing that loop from B.3 is straightforward and is deliberately
left to whoever needs it — this document does not print invented code as though
it had been recovered.

Every import path below is placeholdered: `<scratchpad>/wt-refute/` is the
worktree created at step 2 of §0, `<repo>` the repository root. Each block was
byte-diffed against its source file after that substitution and the
substitution was verified reversible.

### B.0 `vitest.config.ts` (shared by all three states)

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['probe.test.ts'], environment: 'node', testTimeout: 1800_000 } });
```

`node_modules` beside it is a symlink to `<repo>/app/node_modules`.

### B.1 `probe.f3.bak` — produced `base.txt` (§1.1, §3.1, §3.3)

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
const ORIGIN = realMask.snapToNavigable(FLENSBURG, 3)!;
const DEST = realMask.snapToNavigable(BAGENKOP, 3)!;
const ALIVE = 'ALIVE_AT_CAP';

function run(label: string, o: { tws: number; dir: number; motor: boolean; cap?: number; origin?: {lat:number;lon:number} }) {
  resetRingStats();
  const base = new Polar(tG);
  const settings: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 3, motorEnabled: o.motor };
  const wind = new WindField(uniformWindGrid(o.tws, o.dir));
  const cap = o.cap ?? 45;
  let rings = 0;
  let out = '';
  try {
    const res = solve({
      origin: o.origin ?? ORIGIN, destination: DEST, departureMs: T0,
      polar: base, wind, mask: realMask, settings,
      onProgress: () => { rings++; if (rings >= cap) throw new Error(ALIVE); },
    });
    out = `status=${res.status} cause=${(res as any).cause ?? '-'} rings=${rings}` + (res.status==='ok'?` etaH=${((res.etaMs-T0)/3.6e6).toFixed(2)}`:'');
  } catch (e) {
    if ((e as Error).message === ALIVE) out = `ALIVE at ring ${cap}`; else throw e;
  }
  OUT(`### [${label}] ${out}  RING_STATS.len=${RING_STATS.length}`);
  for (const r of RING_STATS.slice(-4)) OUT(`    ring${r.ring} nodes=${r.nodes} acc=${r.accepted} blk=${r.blocked} horiz=${r.horizonDrops} dom=${r.dominatedDrops} betterLoss=${r.betterLoss} set=${r.byKeySet} dir=${r.directAccepted} cap=${r.captureAccepted} next=${r.nextLen} best=${r.hasBest}`);
}

it('F3 + F1 + F7', () => {
  writeFileSync(LOG, `PURE_ADD=${process.env.SC_PURE_ADD ?? '(none)'}\norigin=${JSON.stringify(ORIGIN)} dest=${JSON.stringify(DEST)}\n`);
  OUT(`connected@3.0 = ${realMask.cellsConnected(ORIGIN, DEST, uniformGate(3))}`);
  for (const tws of [2.0, 2.8, 3, 8]) run(`OFF tws${tws} dir0`, { tws, dir: 0, motor: false });
  run('ON tws2.8 dir0 (motor control)', { tws: 2.8, dir: 0, motor: true, cap: 46 });
  run('ON tws8 dir0 (motor control)', { tws: 8, dir: 0, motor: true, cap: 46 });
});
```

### B.2 `tmp.ts` — produced `f2.txt` (§3.2)

Note `ORIGIN`/`DEST` are the RAW harbour coordinates here: this is the
unsnapped state, and its second loop re-runs the same four inputs in reverse
order inside one process, which is the order-independence control.

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
const ORIGIN = FLENSBURG;
const DEST = BAGENKOP;
const ALIVE = 'ALIVE_AT_CAP';

function run(label: string, o: { tws: number; dir: number; motor: boolean; cap?: number; origin?: {lat:number;lon:number} }) {
  resetRingStats();
  const base = new Polar(tG);
  const settings: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 3, motorEnabled: o.motor };
  const wind = new WindField(uniformWindGrid(o.tws, o.dir));
  const cap = o.cap ?? 45;
  let rings = 0;
  let out = '';
  try {
    const res = solve({
      origin: o.origin ?? ORIGIN, destination: DEST, departureMs: T0,
      polar: base, wind, mask: realMask, settings,
      onProgress: () => { rings++; if (rings >= cap) throw new Error(ALIVE); },
    });
    out = `status=${res.status} cause=${(res as any).cause ?? '-'} rings=${rings}` + (res.status==='ok'?` etaH=${((res.etaMs-T0)/3.6e6).toFixed(2)}`:'');
  } catch (e) {
    if ((e as Error).message === ALIVE) out = `ALIVE at ring ${cap}`; else throw e;
  }
  OUT(`### [${label}] ${out}  RING_STATS.len=${RING_STATS.length}`);
  for (const r of RING_STATS.slice(-4)) OUT(`    ring${r.ring} nodes=${r.nodes} acc=${r.accepted} blk=${r.blocked} horiz=${r.horizonDrops} dom=${r.dominatedDrops} betterLoss=${r.betterLoss} set=${r.byKeySet} dir=${r.directAccepted} cap=${r.captureAccepted} next=${r.nextLen} best=${r.hasBest}`);
}

it('F2 chaos, UNSNAPPED', () => {
  writeFileSync(LOG, `UNSNAPPED origin=${JSON.stringify(ORIGIN)} dest=${JSON.stringify(DEST)}\n`);
  OUT(`connected@3.0 = ${realMask.cellsConnected(ORIGIN, DEST, uniformGate(3))}`);
  // forward order
  for (const tws of [2.4, 2.6, 2.8, 3.0]) run(`UNSNAP tws${tws}`, { tws, dir: 0, motor: false });
  // determinism / order-independence: reverse order, repeat
  for (const tws of [3.0, 2.8, 2.6, 2.4]) run(`REPEAT-REV tws${tws}`, { tws, dir: 0, motor: false });
});
```

### B.3 `probe.test.ts` — produced `comfort.txt` (§1.1's tier-1 row)

The `run()` signature here is the widest of the three — `beat`, `gybe` and
`comfort` — and the polar facade it builds under `o.beat`/`o.gybe` is the
DESIGNER's swap form, not a pure add (§2.2). The corrected pure add needs no
facade at all: it is `SC_PURE_ADD=35` against the untouched `Polar`.

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
const ORIGIN = realMask.snapToNavigable(FLENSBURG, 3)!;
const DEST = realMask.snapToNavigable(BAGENKOP, 3)!;
const ALIVE = 'ALIVE_AT_CAP';

function run(label: string, o: { tws: number; dir: number; motor: boolean; cap?: number; origin?: {lat:number;lon:number}; beat?: number; gybe?: number; comfort?: number }) {
  resetRingStats();
  const b0 = new Polar(tG);
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
    out = `status=${res.status} cause=${(res as any).cause ?? '-'} rings=${rings}` + (res.status==='ok'?` etaH=${((res.etaMs-T0)/3.6e6).toFixed(2)}`:'');
  } catch (e) {
    if ((e as Error).message === ALIVE) out = `ALIVE at ring ${cap}`; else throw e;
  }
  OUT(`### [${label}] ${out}  RING_STATS.len=${RING_STATS.length}`);
  for (const r of RING_STATS.slice(-4)) OUT(`    ring${r.ring} nodes=${r.nodes} acc=${r.accepted} blk=${r.blocked} horiz=${r.horizonDrops} dom=${r.dominatedDrops} betterLoss=${r.betterLoss} set=${r.byKeySet} dir=${r.directAccepted} cap=${r.captureAccepted} next=${r.nextLen} best=${r.hasBest}`);
}

it('tier-1 fidelity: comfortDepthM present', () => {
  writeFileSync(LOG, `margin=${DEFAULT_SETTINGS.depthComfortMarginM}\n`);
  const c = 3 + DEFAULT_SETTINGS.depthComfortMarginM;
  for (const tws of [2.8, 3, 8]) run(`tws${tws} comfort=${c}`, { tws, dir: 0, motor: false, comfort: c });
});
```

---

## Appendix C — the five raw logs, complete

All five files verbatim, not excerpted. Each run's block is whatever
`RING_STATS.slice(-4)` emitted, so a run of four or more rings shows its last
four and a shorter one shows all it had — that is why the block lengths differ.
`ALIVE at ring N` means the probe's `onProgress` cap fired, i.e. **still
searching**, never "routed" (§3.2).

### C.1 `base.txt` — snapped, dir 0; the decisive measurement

```
PURE_ADD=(none)
origin={"lat":54.798125,"lon":9.433818181818182} dest={"lat":54.753125,"lon":10.668}
connected@3.0 = true
### [OFF tws2 dir0] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=59 acc=1925 blk=81 horiz=0 dom=1217 betterLoss=478 set=230 dir=0 cap=0 next=88 best=false
    ring42 nodes=88 acc=2917 blk=75 horiz=0 dom=1821 betterLoss=821 set=275 dir=0 cap=0 next=92 best=false
    ring43 nodes=92 acc=3085 blk=43 horiz=0 dom=2016 betterLoss=813 set=256 dir=0 cap=0 next=92 best=false
    ring44 nodes=92 acc=3039 blk=89 horiz=0 dom=1767 betterLoss=912 set=360 dir=0 cap=0 next=130 best=false
### [OFF tws2.8 dir0] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=8 acc=203 blk=69 horiz=0 dom=130 betterLoss=46 set=27 dir=0 cap=0 next=13 best=false
    ring2 nodes=13 acc=305 blk=137 horiz=0 dom=261 betterLoss=22 set=22 dir=0 cap=0 next=7 best=false
    ring3 nodes=7 acc=146 blk=92 horiz=0 dom=134 betterLoss=6 set=6 dir=0 cap=0 next=5 best=false
    ring4 nodes=5 acc=104 blk=66 horiz=0 dom=104 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [OFF tws3 dir0] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=8 acc=186 blk=86 horiz=0 dom=135 betterLoss=32 set=19 dir=0 cap=0 next=11 best=false
    ring2 nodes=11 acc=289 blk=85 horiz=0 dom=249 betterLoss=20 set=20 dir=0 cap=0 next=5 best=false
    ring3 nodes=5 acc=106 blk=64 horiz=0 dom=80 betterLoss=17 set=9 dir=0 cap=0 next=3 best=false
    ring4 nodes=3 acc=49 blk=53 horiz=0 dom=49 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [OFF tws8 dir0] status=no-route cause=mask-blocked rings=4  RING_STATS.len=4
    ring0 nodes=1 acc=17 blk=17 horiz=0 dom=0 betterLoss=4 set=13 dir=0 cap=0 next=9 best=false
    ring1 nodes=9 acc=128 blk=178 horiz=0 dom=63 betterLoss=41 set=24 dir=0 cap=0 next=15 best=false
    ring2 nodes=15 acc=235 blk=275 horiz=0 dom=226 betterLoss=3 set=6 dir=0 cap=0 next=4 best=false
    ring3 nodes=4 acc=51 blk=85 horiz=0 dom=51 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [ON tws2.8 dir0 (motor control)] ALIVE at ring 46  RING_STATS.len=46
    ring42 nodes=5870 acc=219957 blk=8251 horiz=0 dom=175123 betterLoss=31405 set=13429 dir=0 cap=0 next=5622 best=false
    ring43 nodes=5622 acc=210857 blk=7708 horiz=0 dom=167274 betterLoss=30495 set=13088 dir=0 cap=0 next=5582 best=false
    ring44 nodes=5582 acc=208969 blk=8095 horiz=0 dom=165953 betterLoss=30588 set=12428 dir=0 cap=0 next=5366 best=false
    ring45 nodes=5366 acc=203410 blk=5227 horiz=0 dom=178719 betterLoss=17146 set=7545 dir=0 cap=0 next=3121 best=false
### [ON tws8 dir0 (motor control)] ALIVE at ring 46  RING_STATS.len=46
    ring42 nodes=12309 acc=464874 blk=13765 horiz=0 dom=384379 betterLoss=57599 set=22896 dir=0 cap=0 next=11802 best=false
    ring43 nodes=11802 acc=448881 blk=10099 horiz=0 dom=344689 betterLoss=74660 set=29532 dir=0 cap=0 next=13370 best=false
    ring44 nodes=13370 acc=509769 blk=10346 horiz=0 dom=416673 betterLoss=67122 set=25974 dir=0 cap=0 next=10910 best=false
    ring45 nodes=10910 acc=415126 blk=9340 horiz=0 dom=345617 betterLoss=49390 set=20119 dir=0 cap=0 next=8491 best=false
```

### C.2 `comfort.txt` — tier-1 fidelity, `comfortDepthM = 5`

`DEFAULT_SETTINGS.depthComfortMarginM` is 2, so the tier-1 comfort depth is
3 + 2 = 5. Every counter matches its `base.txt` twin for the three
configurations re-run.

```
margin=2
### [tws2.8 comfort=5] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=8 acc=203 blk=69 horiz=0 dom=130 betterLoss=46 set=27 dir=0 cap=0 next=13 best=false
    ring2 nodes=13 acc=305 blk=137 horiz=0 dom=261 betterLoss=22 set=22 dir=0 cap=0 next=7 best=false
    ring3 nodes=7 acc=146 blk=92 horiz=0 dom=134 betterLoss=6 set=6 dir=0 cap=0 next=5 best=false
    ring4 nodes=5 acc=104 blk=66 horiz=0 dom=104 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws3 comfort=5] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=8 acc=186 blk=86 horiz=0 dom=135 betterLoss=32 set=19 dir=0 cap=0 next=11 best=false
    ring2 nodes=11 acc=289 blk=85 horiz=0 dom=249 betterLoss=20 set=20 dir=0 cap=0 next=5 best=false
    ring3 nodes=5 acc=106 blk=64 horiz=0 dom=80 betterLoss=17 set=9 dir=0 cap=0 next=3 best=false
    ring4 nodes=3 acc=49 blk=53 horiz=0 dom=49 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws8 comfort=5] status=no-route cause=mask-blocked rings=4  RING_STATS.len=4
    ring0 nodes=1 acc=17 blk=17 horiz=0 dom=0 betterLoss=4 set=13 dir=0 cap=0 next=9 best=false
    ring1 nodes=9 acc=128 blk=178 horiz=0 dom=63 betterLoss=41 set=24 dir=0 cap=0 next=15 best=false
    ring2 nodes=15 acc=235 blk=275 horiz=0 dom=226 betterLoss=3 set=6 dir=0 cap=0 next=4 best=false
    ring3 nodes=4 acc=51 blk=85 horiz=0 dom=51 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
```

### C.3 `f2.txt` — UNSNAPPED, dir 0; non-monotonicity and its control

The `REPEAT-REV` block re-runs the same four inputs in reverse order inside one
process. Every counter is byte-identical to the forward run, which is what
kills the shared-mutable-state hypothesis.

```
UNSNAPPED origin={"lat":54.798,"lon":9.4335} dest={"lat":54.753,"lon":10.668}
connected@3.0 = true
### [UNSNAP tws2.4] status=no-route cause=mask-blocked rings=6  RING_STATS.len=6
    ring2 nodes=13 acc=297 blk=145 horiz=0 dom=280 betterLoss=6 set=11 dir=0 cap=0 next=6 best=false
    ring3 nodes=6 acc=121 blk=83 horiz=0 dom=119 betterLoss=0 set=2 dir=0 cap=0 next=1 best=false
    ring4 nodes=1 acc=16 blk=18 horiz=0 dom=6 betterLoss=5 set=5 dir=0 cap=0 next=3 best=false
    ring5 nodes=3 acc=77 blk=25 horiz=0 dom=77 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [UNSNAP tws2.6] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=264 acc=8577 blk=399 horiz=0 dom=6600 betterLoss=1356 set=621 dir=0 cap=0 next=231 best=false
    ring42 nodes=231 acc=7639 blk=215 horiz=0 dom=5374 betterLoss=1632 set=633 dir=0 cap=0 next=245 best=false
    ring43 nodes=245 acc=8057 blk=273 horiz=0 dom=5378 betterLoss=1915 set=764 dir=0 cap=0 next=296 best=false
    ring44 nodes=296 acc=9855 blk=209 horiz=0 dom=6672 betterLoss=2245 set=938 dir=0 cap=0 next=374 best=false
### [UNSNAP tws2.8] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=9 acc=222 blk=84 horiz=0 dom=143 betterLoss=52 set=27 dir=0 cap=0 next=11 best=false
    ring2 nodes=11 acc=297 blk=77 horiz=0 dom=260 betterLoss=20 set=17 dir=0 cap=0 next=6 best=false
    ring3 nodes=6 acc=119 blk=85 horiz=0 dom=99 betterLoss=13 set=7 dir=0 cap=0 next=5 best=false
    ring4 nodes=5 acc=117 blk=53 horiz=0 dom=117 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [UNSNAP tws3] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=664 acc=22119 blk=420 horiz=0 dom=16527 betterLoss=3785 set=1807 dir=0 cap=0 next=760 best=false
    ring42 nodes=760 acc=25432 blk=343 horiz=0 dom=19188 betterLoss=4204 set=2040 dir=0 cap=0 next=865 best=false
    ring43 nodes=865 acc=28847 blk=484 horiz=0 dom=21791 betterLoss=4742 set=2314 dir=0 cap=0 next=1012 best=false
    ring44 nodes=1012 acc=33689 blk=625 horiz=0 dom=25077 betterLoss=5906 set=2706 dir=0 cap=0 next=1195 best=false
### [REPEAT-REV tws3] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=664 acc=22119 blk=420 horiz=0 dom=16527 betterLoss=3785 set=1807 dir=0 cap=0 next=760 best=false
    ring42 nodes=760 acc=25432 blk=343 horiz=0 dom=19188 betterLoss=4204 set=2040 dir=0 cap=0 next=865 best=false
    ring43 nodes=865 acc=28847 blk=484 horiz=0 dom=21791 betterLoss=4742 set=2314 dir=0 cap=0 next=1012 best=false
    ring44 nodes=1012 acc=33689 blk=625 horiz=0 dom=25077 betterLoss=5906 set=2706 dir=0 cap=0 next=1195 best=false
### [REPEAT-REV tws2.8] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=9 acc=222 blk=84 horiz=0 dom=143 betterLoss=52 set=27 dir=0 cap=0 next=11 best=false
    ring2 nodes=11 acc=297 blk=77 horiz=0 dom=260 betterLoss=20 set=17 dir=0 cap=0 next=6 best=false
    ring3 nodes=6 acc=119 blk=85 horiz=0 dom=99 betterLoss=13 set=7 dir=0 cap=0 next=5 best=false
    ring4 nodes=5 acc=117 blk=53 horiz=0 dom=117 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [REPEAT-REV tws2.6] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=264 acc=8577 blk=399 horiz=0 dom=6600 betterLoss=1356 set=621 dir=0 cap=0 next=231 best=false
    ring42 nodes=231 acc=7639 blk=215 horiz=0 dom=5374 betterLoss=1632 set=633 dir=0 cap=0 next=245 best=false
    ring43 nodes=245 acc=8057 blk=273 horiz=0 dom=5378 betterLoss=1915 set=764 dir=0 cap=0 next=296 best=false
    ring44 nodes=296 acc=9855 blk=209 horiz=0 dom=6672 betterLoss=2245 set=938 dir=0 cap=0 next=374 best=false
### [REPEAT-REV tws2.4] status=no-route cause=mask-blocked rings=6  RING_STATS.len=6
    ring2 nodes=13 acc=297 blk=145 horiz=0 dom=280 betterLoss=6 set=11 dir=0 cap=0 next=6 best=false
    ring3 nodes=6 acc=121 blk=83 horiz=0 dom=119 betterLoss=0 set=2 dir=0 cap=0 next=1 best=false
    ring4 nodes=1 acc=16 blk=18 horiz=0 dom=6 betterLoss=5 set=5 dir=0 cap=0 next=3 best=false
    ring5 nodes=3 acc=77 blk=25 horiz=0 dom=77 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
```

### C.4 `f4_base.txt` — snapped, base `EXTRA_TWAS`

`PLAIN` rows use the untouched polar; `gybe=35` and `beat=35` are the
designer's two swap forms (§2.2).

```
PURE_ADD=(none)
### [tws2 PLAIN] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=59 acc=1925 blk=81 horiz=0 dom=1217 betterLoss=478 set=230 dir=0 cap=0 next=88 best=false
    ring42 nodes=88 acc=2917 blk=75 horiz=0 dom=1821 betterLoss=821 set=275 dir=0 cap=0 next=92 best=false
    ring43 nodes=92 acc=3085 blk=43 horiz=0 dom=2016 betterLoss=813 set=256 dir=0 cap=0 next=92 best=false
    ring44 nodes=92 acc=3039 blk=89 horiz=0 dom=1767 betterLoss=912 set=360 dir=0 cap=0 next=130 best=false
### [tws2 gybe=35 (doc ADD)] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=9 acc=243 blk=63 horiz=0 dom=171 betterLoss=47 set=25 dir=0 cap=0 next=12 best=false
    ring2 nodes=12 acc=344 blk=64 horiz=0 dom=325 betterLoss=9 set=10 dir=0 cap=0 next=6 best=false
    ring3 nodes=6 acc=133 blk=71 horiz=0 dom=128 betterLoss=2 set=3 dir=0 cap=0 next=2 best=false
    ring4 nodes=2 acc=39 blk=29 horiz=0 dom=39 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws2 beat=35 (doc SWAP)] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=9 acc=244 blk=62 horiz=0 dom=176 betterLoss=39 set=29 dir=0 cap=0 next=12 best=false
    ring2 nodes=12 acc=344 blk=64 horiz=0 dom=324 betterLoss=10 set=10 dir=0 cap=0 next=6 best=false
    ring3 nodes=6 acc=132 blk=72 horiz=0 dom=127 betterLoss=2 set=3 dir=0 cap=0 next=2 best=false
    ring4 nodes=2 acc=40 blk=28 horiz=0 dom=40 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws2.4 PLAIN] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=9 acc=240 blk=66 horiz=0 dom=161 betterLoss=41 set=38 dir=0 cap=0 next=16 best=false
    ring2 nodes=16 acc=434 blk=110 horiz=0 dom=419 betterLoss=3 set=12 dir=0 cap=0 next=6 best=false
    ring3 nodes=6 acc=126 blk=78 horiz=0 dom=118 betterLoss=5 set=3 dir=0 cap=0 next=3 best=false
    ring4 nodes=3 acc=77 blk=25 horiz=0 dom=77 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws2.4 gybe=35 (doc ADD)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=344 acc=11235 blk=461 horiz=0 dom=7843 betterLoss=2661 set=731 dir=0 cap=0 next=316 best=false
    ring42 nodes=316 acc=10273 blk=471 horiz=0 dom=7243 betterLoss=2306 set=724 dir=0 cap=0 next=308 best=false
    ring43 nodes=308 acc=10176 blk=296 horiz=0 dom=7150 betterLoss=2288 set=738 dir=0 cap=0 next=338 best=false
    ring44 nodes=338 acc=11141 blk=351 horiz=0 dom=7670 betterLoss=2616 set=855 dir=0 cap=0 next=374 best=false
### [tws2.4 beat=35 (doc SWAP)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=159 acc=5170 blk=236 horiz=0 dom=3454 betterLoss=1280 set=436 dir=0 cap=0 next=130 best=false
    ring42 nodes=130 acc=4171 blk=249 horiz=0 dom=2887 betterLoss=905 set=379 dir=0 cap=0 next=117 best=false
    ring43 nodes=117 acc=3760 blk=218 horiz=0 dom=2374 betterLoss=1012 set=374 dir=0 cap=0 next=136 best=false
    ring44 nodes=136 acc=4467 blk=157 horiz=0 dom=2839 betterLoss=1166 set=462 dir=0 cap=0 next=167 best=false
### [tws2.8 PLAIN] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=8 acc=203 blk=69 horiz=0 dom=130 betterLoss=46 set=27 dir=0 cap=0 next=13 best=false
    ring2 nodes=13 acc=305 blk=137 horiz=0 dom=261 betterLoss=22 set=22 dir=0 cap=0 next=7 best=false
    ring3 nodes=7 acc=146 blk=92 horiz=0 dom=134 betterLoss=6 set=6 dir=0 cap=0 next=5 best=false
    ring4 nodes=5 acc=104 blk=66 horiz=0 dom=104 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws2.8 gybe=35 (doc ADD)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=387 acc=12975 blk=182 horiz=0 dom=9474 betterLoss=2501 set=1000 dir=0 cap=0 next=461 best=false
    ring42 nodes=461 acc=15439 blk=219 horiz=0 dom=11397 betterLoss=2879 set=1163 dir=0 cap=0 next=535 best=false
    ring43 nodes=535 acc=17975 blk=185 horiz=0 dom=13392 betterLoss=3252 set=1331 dir=0 cap=0 next=643 best=false
    ring44 nodes=643 acc=21440 blk=375 horiz=0 dom=16049 betterLoss=3790 set=1601 dir=0 cap=0 next=744 best=false
### [tws2.8 beat=35 (doc SWAP)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=261 acc=8800 blk=74 horiz=0 dom=5955 betterLoss=2109 set=736 dir=0 cap=0 next=321 best=false
    ring42 nodes=321 acc=10722 blk=178 horiz=0 dom=7568 betterLoss=2313 set=841 dir=0 cap=0 next=387 best=false
    ring43 nodes=387 acc=12897 blk=238 horiz=0 dom=9173 betterLoss=2691 set=1033 dir=0 cap=0 next=475 best=false
    ring44 nodes=475 acc=15868 blk=244 horiz=0 dom=11387 betterLoss=3261 set=1220 dir=0 cap=0 next=560 best=false
### [tws3 PLAIN] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=8 acc=186 blk=86 horiz=0 dom=135 betterLoss=32 set=19 dir=0 cap=0 next=11 best=false
    ring2 nodes=11 acc=289 blk=85 horiz=0 dom=249 betterLoss=20 set=20 dir=0 cap=0 next=5 best=false
    ring3 nodes=5 acc=106 blk=64 horiz=0 dom=80 betterLoss=17 set=9 dir=0 cap=0 next=3 best=false
    ring4 nodes=3 acc=49 blk=53 horiz=0 dom=49 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws3 gybe=35 (doc ADD)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=610 acc=20367 blk=319 horiz=0 dom=15166 betterLoss=3681 set=1520 dir=0 cap=0 next=697 best=false
    ring42 nodes=697 acc=23130 blk=508 horiz=0 dom=16911 betterLoss=4418 set=1801 dir=0 cap=0 next=832 best=false
    ring43 nodes=832 acc=27777 blk=436 horiz=0 dom=20497 betterLoss=5280 set=2000 dir=0 cap=0 next=896 best=false
    ring44 nodes=896 acc=30056 blk=321 horiz=0 dom=22672 betterLoss=5251 set=2133 dir=0 cap=0 next=954 best=false
### [tws3 beat=35 (doc SWAP)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=716 acc=23942 blk=348 horiz=0 dom=18122 betterLoss=3995 set=1825 dir=0 cap=0 next=827 best=false
    ring42 nodes=827 acc=27715 blk=331 horiz=0 dom=20782 betterLoss=4809 set=2124 dir=0 cap=0 next=987 best=false
    ring43 nodes=987 acc=33115 blk=363 horiz=0 dom=25130 betterLoss=5537 set=2448 dir=0 cap=0 next=1122 best=false
    ring44 nodes=1122 acc=37566 blk=452 horiz=0 dom=29315 betterLoss=5700 set=2551 dir=0 cap=0 next=1166 best=false
### [tws8 PLAIN] status=no-route cause=mask-blocked rings=4  RING_STATS.len=4
    ring0 nodes=1 acc=17 blk=17 horiz=0 dom=0 betterLoss=4 set=13 dir=0 cap=0 next=9 best=false
    ring1 nodes=9 acc=128 blk=178 horiz=0 dom=63 betterLoss=41 set=24 dir=0 cap=0 next=15 best=false
    ring2 nodes=15 acc=235 blk=275 horiz=0 dom=226 betterLoss=3 set=6 dir=0 cap=0 next=4 best=false
    ring3 nodes=4 acc=51 blk=85 horiz=0 dom=51 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws8 gybe=35 (doc ADD)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=10491 acc=351862 blk=3709 horiz=0 dom=271773 betterLoss=58746 set=21343 dir=0 cap=0 next=11929 best=false
    ring42 nodes=11929 acc=400266 blk=4111 horiz=0 dom=311521 betterLoss=62664 set=26081 dir=0 cap=0 next=12372 best=false
    ring43 nodes=12372 acc=414559 blk=4898 horiz=0 dom=348223 betterLoss=44686 set=21650 dir=0 cap=0 next=9644 best=false
    ring44 nodes=9644 acc=321989 blk=4921 horiz=0 dom=260652 betterLoss=41663 set=19674 dir=0 cap=0 next=8802 best=false
### [tws8 beat=35 (doc SWAP)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=11198 acc=375787 blk=3822 horiz=0 dom=293877 betterLoss=57663 set=24247 dir=0 cap=0 next=10787 best=false
    ring42 nodes=10787 acc=360542 blk=5123 horiz=0 dom=303942 betterLoss=37606 set=18994 dir=0 cap=0 next=8090 best=false
    ring43 nodes=8090 acc=269251 blk=4887 horiz=0 dom=214096 betterLoss=36742 set=18413 dir=0 cap=0 next=7768 best=false
    ring44 nodes=7768 acc=258350 blk=4876 horiz=0 dom=201271 betterLoss=38238 set=18841 dir=0 cap=0 next=8167 best=false
```

### C.5 `f4_add.txt` — snapped, `SC_PURE_ADD=35`

Identical driver, `EXTRA_TWAS` prepended with 35 and the polar untouched. Read
the `PLAIN` rows here against C.4's `PLAIN` rows: that pair is the corrected
pure-add comparison of §2.2.

```
PURE_ADD=35
### [tws2 PLAIN] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=9 acc=259 blk=65 horiz=0 dom=186 betterLoss=48 set=25 dir=0 cap=0 next=12 best=false
    ring2 nodes=12 acc=364 blk=68 horiz=0 dom=345 betterLoss=9 set=10 dir=0 cap=0 next=6 best=false
    ring3 nodes=6 acc=140 blk=76 horiz=0 dom=135 betterLoss=2 set=3 dir=0 cap=0 next=2 best=false
    ring4 nodes=2 acc=42 blk=30 horiz=0 dom=42 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws2 gybe=35 (doc ADD)] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=9 acc=243 blk=63 horiz=0 dom=171 betterLoss=47 set=25 dir=0 cap=0 next=12 best=false
    ring2 nodes=12 acc=344 blk=64 horiz=0 dom=325 betterLoss=9 set=10 dir=0 cap=0 next=6 best=false
    ring3 nodes=6 acc=133 blk=71 horiz=0 dom=128 betterLoss=2 set=3 dir=0 cap=0 next=2 best=false
    ring4 nodes=2 acc=39 blk=29 horiz=0 dom=39 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws2 beat=35 (doc SWAP)] status=no-route cause=mask-blocked rings=5  RING_STATS.len=5
    ring1 nodes=9 acc=244 blk=62 horiz=0 dom=176 betterLoss=39 set=29 dir=0 cap=0 next=12 best=false
    ring2 nodes=12 acc=344 blk=64 horiz=0 dom=324 betterLoss=10 set=10 dir=0 cap=0 next=6 best=false
    ring3 nodes=6 acc=132 blk=72 horiz=0 dom=127 betterLoss=2 set=3 dir=0 cap=0 next=2 best=false
    ring4 nodes=2 acc=40 blk=28 horiz=0 dom=40 betterLoss=0 set=0 dir=0 cap=0 next=0 best=false
### [tws2.4 PLAIN] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=378 acc=13070 blk=538 horiz=0 dom=9374 betterLoss=2707 set=989 dir=0 cap=0 next=344 best=false
    ring42 nodes=344 acc=11963 blk=421 horiz=0 dom=8511 betterLoss=2564 set=888 dir=0 cap=0 next=322 best=false
    ring43 nodes=322 acc=11269 blk=323 horiz=0 dom=7590 betterLoss=2734 set=945 dir=0 cap=0 next=342 best=false
    ring44 nodes=342 acc=11915 blk=397 horiz=0 dom=7870 betterLoss=2971 set=1074 dir=0 cap=0 next=401 best=false
### [tws2.4 gybe=35 (doc ADD)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=344 acc=11235 blk=461 horiz=0 dom=7843 betterLoss=2661 set=731 dir=0 cap=0 next=316 best=false
    ring42 nodes=316 acc=10273 blk=471 horiz=0 dom=7243 betterLoss=2306 set=724 dir=0 cap=0 next=308 best=false
    ring43 nodes=308 acc=10176 blk=296 horiz=0 dom=7150 betterLoss=2288 set=738 dir=0 cap=0 next=338 best=false
    ring44 nodes=338 acc=11141 blk=351 horiz=0 dom=7670 betterLoss=2616 set=855 dir=0 cap=0 next=374 best=false
### [tws2.4 beat=35 (doc SWAP)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=159 acc=5170 blk=236 horiz=0 dom=3454 betterLoss=1280 set=436 dir=0 cap=0 next=130 best=false
    ring42 nodes=130 acc=4171 blk=249 horiz=0 dom=2887 betterLoss=905 set=379 dir=0 cap=0 next=117 best=false
    ring43 nodes=117 acc=3760 blk=218 horiz=0 dom=2374 betterLoss=1012 set=374 dir=0 cap=0 next=136 best=false
    ring44 nodes=136 acc=4467 blk=157 horiz=0 dom=2839 betterLoss=1166 set=462 dir=0 cap=0 next=167 best=false
### [tws2.8 PLAIN] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=302 acc=10679 blk=192 horiz=0 dom=7566 betterLoss=2276 set=837 dir=0 cap=0 next=354 best=false
    ring42 nodes=354 acc=12526 blk=208 horiz=0 dom=9053 betterLoss=2498 set=975 dir=0 cap=0 next=409 best=false
    ring43 nodes=409 acc=14597 blk=101 horiz=0 dom=10460 betterLoss=3051 set=1086 dir=0 cap=0 next=490 best=false
    ring44 nodes=490 acc=17405 blk=193 horiz=0 dom=12665 betterLoss=3431 set=1309 dir=0 cap=0 next=559 best=false
### [tws2.8 gybe=35 (doc ADD)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=387 acc=12975 blk=182 horiz=0 dom=9474 betterLoss=2501 set=1000 dir=0 cap=0 next=461 best=false
    ring42 nodes=461 acc=15439 blk=219 horiz=0 dom=11397 betterLoss=2879 set=1163 dir=0 cap=0 next=535 best=false
    ring43 nodes=535 acc=17975 blk=185 horiz=0 dom=13392 betterLoss=3252 set=1331 dir=0 cap=0 next=643 best=false
    ring44 nodes=643 acc=21440 blk=375 horiz=0 dom=16049 betterLoss=3790 set=1601 dir=0 cap=0 next=744 best=false
### [tws2.8 beat=35 (doc SWAP)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=261 acc=8800 blk=74 horiz=0 dom=5955 betterLoss=2109 set=736 dir=0 cap=0 next=321 best=false
    ring42 nodes=321 acc=10722 blk=178 horiz=0 dom=7568 betterLoss=2313 set=841 dir=0 cap=0 next=387 best=false
    ring43 nodes=387 acc=12897 blk=238 horiz=0 dom=9173 betterLoss=2691 set=1033 dir=0 cap=0 next=475 best=false
    ring44 nodes=475 acc=15868 blk=244 horiz=0 dom=11387 betterLoss=3261 set=1220 dir=0 cap=0 next=560 best=false
### [tws3 PLAIN] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=761 acc=26933 blk=397 horiz=0 dom=20476 betterLoss=4466 set=1991 dir=0 cap=0 next=864 best=false
    ring42 nodes=864 acc=30604 blk=430 horiz=0 dom=22965 betterLoss=5357 set=2282 dir=0 cap=0 next=1030 best=false
    ring43 nodes=1030 acc=36500 blk=488 horiz=0 dom=27450 betterLoss=6425 set=2625 dir=0 cap=0 next=1129 best=false
    ring44 nodes=1129 acc=40266 blk=284 horiz=0 dom=30930 betterLoss=6555 set=2781 dir=0 cap=0 next=1175 best=false
### [tws3 gybe=35 (doc ADD)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=610 acc=20367 blk=319 horiz=0 dom=15166 betterLoss=3681 set=1520 dir=0 cap=0 next=697 best=false
    ring42 nodes=697 acc=23130 blk=508 horiz=0 dom=16911 betterLoss=4418 set=1801 dir=0 cap=0 next=832 best=false
    ring43 nodes=832 acc=27777 blk=436 horiz=0 dom=20497 betterLoss=5280 set=2000 dir=0 cap=0 next=896 best=false
    ring44 nodes=896 acc=30056 blk=321 horiz=0 dom=22672 betterLoss=5251 set=2133 dir=0 cap=0 next=954 best=false
### [tws3 beat=35 (doc SWAP)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=716 acc=23942 blk=348 horiz=0 dom=18122 betterLoss=3995 set=1825 dir=0 cap=0 next=827 best=false
    ring42 nodes=827 acc=27715 blk=331 horiz=0 dom=20782 betterLoss=4809 set=2124 dir=0 cap=0 next=987 best=false
    ring43 nodes=987 acc=33115 blk=363 horiz=0 dom=25130 betterLoss=5537 set=2448 dir=0 cap=0 next=1122 best=false
    ring44 nodes=1122 acc=37566 blk=452 horiz=0 dom=29315 betterLoss=5700 set=2551 dir=0 cap=0 next=1166 best=false
### [tws8 PLAIN] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=10339 acc=367432 blk=3670 horiz=0 dom=281365 betterLoss=63652 set=22415 dir=0 cap=0 next=11776 best=false
    ring42 nodes=11776 acc=418421 blk=4353 horiz=0 dom=323831 betterLoss=67515 set=27075 dir=0 cap=0 next=12301 best=false
    ring43 nodes=12301 acc=436399 blk=5180 horiz=0 dom=365778 betterLoss=48262 set=22359 dir=0 cap=0 next=9583 best=false
    ring44 nodes=9583 acc=338818 blk=5117 horiz=0 dom=273583 betterLoss=44638 set=20597 dir=0 cap=0 next=8757 best=false
### [tws8 gybe=35 (doc ADD)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=10491 acc=351862 blk=3709 horiz=0 dom=271773 betterLoss=58746 set=21343 dir=0 cap=0 next=11929 best=false
    ring42 nodes=11929 acc=400266 blk=4111 horiz=0 dom=311521 betterLoss=62664 set=26081 dir=0 cap=0 next=12372 best=false
    ring43 nodes=12372 acc=414559 blk=4898 horiz=0 dom=348223 betterLoss=44686 set=21650 dir=0 cap=0 next=9644 best=false
    ring44 nodes=9644 acc=321989 blk=4921 horiz=0 dom=260652 betterLoss=41663 set=19674 dir=0 cap=0 next=8802 best=false
### [tws8 beat=35 (doc SWAP)] ALIVE at ring 45  RING_STATS.len=45
    ring41 nodes=11198 acc=375787 blk=3822 horiz=0 dom=293877 betterLoss=57663 set=24247 dir=0 cap=0 next=10787 best=false
    ring42 nodes=10787 acc=360542 blk=5123 horiz=0 dom=303942 betterLoss=37606 set=18994 dir=0 cap=0 next=8090 best=false
    ring43 nodes=8090 acc=269251 blk=4887 horiz=0 dom=214096 betterLoss=36742 set=18413 dir=0 cap=0 next=7768 best=false
    ring44 nodes=7768 acc=258350 blk=4876 horiz=0 dom=201271 betterLoss=38238 set=18841 dir=0 cap=0 next=8167 best=false
```

---

## 10. Prerequisite 1 — RUN 2026-09-10 (efficacy of the solve-level salvage)

**Filter.** Real committed mask + Salona-45 genoa polar, Flensburg → Bagenkop,
`safetyDepthM: 3`, `motorEnabled: false`, uniform wind dir 0, snapped
endpoints (§0's convention) — the exact §1 configuration, at
`chore/1136-salvage-efficacy-probe`'s merge-base `4e1e92d` (develop tip,
2026-09-10; `isochrone.ts` unchanged since `035d662`, confirmed via
`git log 035d662..HEAD -- app/src/routing/isochrone.ts`, empty). Three TWS,
each capped at 80 onProgress calls (higher for the TWS 8 confirmation run,
§10.2).

**Method — SCRATCH, never committed.** §5's salvage was written directly into
a local copy of `isochrone.ts`: after an ordinary ring produces
`byKey.size === 0 && best === null` (§5's exact trigger) and the salvage
counter is under a cap, the SAME per-node expansion is re-run verbatim over
the SAME frontier with the one `visitedDominates` line skipped, and its
result becomes `next` — reusing the real edge/substep/capture logic rather
than a hand-written approximation of it. The instrumented file was reverted
with `git restore` before any commit — `git show --stat` on this task's own
commits confirms no routing source is in them.

**Positive control.** A motor-on run (known to keep expanding) records
non-zero `RING_STATS` with `salvaged: false` throughout — the instrument
fires and the salvage path stays dormant when it should. Confirms the
zero-rows below are a genuine finding, not a silent instrument.

**Ring-by-ring result, salvage cap 30** (full per-ring dump kept only in this
session's transcript, not reproduced here — the table below is every ring
where the ordinary expansion died, i.e. every `salvaged=true` row, condensed):

| TWS | ordinary-expansion deaths in rings 4–24 | salvage rounds fired | outcome by ring 80 |
|---|---|---|---|
| 2.8 | 16 of 21 rings (interspersed with 5 tiny 1–3-node ordinary survivals) | 16 (rings 4,6,8,10,12,13,14,15,17–24) | recovers permanently at ring 25 — 0 further salvages needed through ring 79, frontier 667 at ring 78 |
| 3   | 1 of 21 rings (ring 4 only) | 1 | recovers permanently at ring 5 — 0 further salvages needed through ring 79, frontier 2087+ at ring 78 |
| 8   | every ring from 7 onward, no exception | 30 of 30 (budget exhausted) | dies for good at ring 35, `no-route cause=mask-blocked` — identical to the unsalvaged case |

TWS 8 rescued counts across those 30 salvage rounds hover at 1–4 and never
trend upward (`1,2,2,2,2,3,3,3,2,2,3,3,4,4,4,3,3,3,3,4,4,4,3,3,3,3,4,4,4,3`) —
a stuck pocket, not a slow recovery.

### 10.1 Answer

**Efficacy is TWS-dependent, and the two outcomes are qualitatively
different, not two points on one spectrum.** At TWS 2.8 and TWS 3, skipping
`visitedDominates` for the dying ring DOES produce a surviving frontier: the
ordinary expansion permanently resumes producing children on its own after a
bounded number of salvage rounds (1 at TWS 3, 16 at TWS 2.8, all within
21 rings) and the salvage is never needed again. At TWS 8 it does NOT: every
single ring from 7 onward dies on ordinary expansion, salvage rescues only a
token 1–4 nodes each time with no growth trend, and the search dies
identically to the unsalvaged case the moment the budget runs out —
confirmed at 4x the budget (§10.2) rather than assumed from one cap.

### 10.2 Confirmation at 4x budget (TWS 8 only)

Re-run at salvage cap 120, probe cap 200: 118 consecutive salvage rounds
(rings 7–124), rescued counts still oscillating 2–4 with no growth trend,
dies for good at ring 125 once the enlarged budget is exhausted. Rules out
"budget 30 was merely too small" for this TWS specifically — this input is
trapped, not slow.
