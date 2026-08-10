# Spike #452 — local depth-gate relaxation

- **Issue:** #452 (open — this document does not close it; see the do-not-ship
  conditions in §4)
- **Date:** 2026-08-10
- **Status:** Decision / Recommendation — **conditional**, not a go
- **Verdict:** **Both an independent feasibility-lens judge and an independent
  safety-lens judge, working from the same three designs but without seeing
  each other's reasoning, landed on the same proposal: Proposal 3
  ("approach-scoped relaxation discs"), with named grafts from the other two.
  Its central constant is the only one of the three that is measured rather
  than a placeholder, and its kill switch reproduces today's behaviour
  cell-for-cell rather than approximately. But neither judge would ship it
  this session, and for reasons the maintainer should read before scheduling
  the work: the configuration that actually needs this fix was never
  identified, and the repo's own acceptance sweep cannot currently tell the
  difference between a correct implementation and a silently broken one.**

> Companions: [`245-depth-mask-resolution.md`](./245-depth-mask-resolution.md)
> (why the 46 m mask grid is source-limited — upstream of this question) and
> [`455-depth-mask-optimism.md`](./455-depth-mask-optimism.md) (a different
> mechanism at a neighbouring seam: #455 tightens what the *mask* reports as
> depth; this spike is about how far a #53 *relaxation* is permitted to spread
> once the mask has already been consulted at the requested gate). The two are
> independent and both real: #455's `TOLERANCE_M` fix changes which cells the
> mask calls navigable at all; #452 is about scoping relaxation once
> `findRelaxedDepthM` has already decided the requested gate cannot connect.

---

## 0. Provenance and verification discipline

This document is not itself a fresh investigation. It synthesizes a six-agent
design workflow run earlier this session against `develop @ 836be3f`: one
ground-truth pass (pure code enumeration, no proposal), three independent
design agents (P1/P2/P3 below, each with no visibility into the other two),
and two adversarial judges — one instructed to weigh feasibility ("land it
today, in a repo where a solver change costs three ~20-min sweep runs"), one
instructed to weigh safety ("can it put the boat in water shallower than the
user believes they asked for") — each re-deriving claims from the code rather
than trusting the three designs' own arithmetic. The full transcript
(`journal.jsonl`, six `result` records) is the primary source; this document
extracts and organizes it.

**What this session independently re-verified against the repo**, rather than
inheriting: the `edgeFactor` function body and signature
(`isochrone.ts:202-220`); the exhaustive `safetyDepthM` grep in
`isochrone.ts` (five hits — four call sites at `:439`, `:487`, `:508`, `:560`,
plus one doc-comment mention at `:30` — confirming the ground truth's "four
and only four" claim); `postprocess.ts`'s merge-clearance re-validation
(`:22`) and the comfort-gated per-leg comparison (`:35-38`);
`DEFAULT_SETTINGS.safetyDepthM = 3.0` / `depthComfortMarginM = 2.0`
(`types.ts:68-69`); the `exposureNm` assertions and their in-comment
pre-/post-#243 literals in `realmask.repro.test.ts:359-386`; the six-arm
header comment in `app/sweep/sweepArms.ts:60-95`, including the "only two
plans carrying a #53 shallow warning" line; and the `MAX_FRONTIER` /
`DEPTH_DERATE_MAX` comments in `isochrone.ts:157-186`, including the
Ærøskøbing→Drejø "derate-insensitive" residual P2 and the safety judge both
cite. All matched the workflow's citations exactly. The repo moved one
docs-only commit past the workflow's `836be3f` reference point before this
branch was cut (`4f0c786`, CLAUDE.md citation anchoring only, verified via
`git show --stat` to touch no `app/` file) — nothing below is stale on that
account.

**What this document did NOT independently re-run**: the numpy/scipy mask
measurements P3 and its feasibility-judge grafter report (component counts,
minimum connecting radii, licensed-cell counts). Those are reported here as
**MEASURED-BY-THE-SOURCE**, with an explicit note on which of the two — the
proposing agent or the judge — actually ran the script, since the brief
requires distinguishing re-run numbers from inherited ones and the transcript
does distinguish them (§2.3, §3). Anything not so marked and not verified in
the paragraph above is the workflow's own claim, carried through unverified;
this document tries not to state anything as fact that the source only
argued.

---

## 1. The seam (ground truth)

### 1.1 One function, four call sites, nothing else reads the gate

Every navigability decision inside `solve()` goes through one function:

`edgeFactor(mask, a, b, gateM, comfortDepthM)` — `isochrone.ts:202-220`.
Contract: `null` means the edge is blocked; a number in
`(1 - DEPTH_DERATE_MAX, 1]` means navigable, with that comfort multiplier.
When `comfortDepthM` is absent or `<= gateM` it collapses to
`mask.segmentNavigable(a, b, gateM) ? 1 : null` — the bare-navigability path.
Otherwise it calls `mask.segmentClearanceM`, which returns `null` under
exactly the same condition `segmentNavigable` would, so the blocked/not-blocked
partition is identical on both branches.

There are exactly four call sites, confirmed by grep and independently
re-confirmed in this session:

- `isochrone.ts:435-441` — direct-candidate arrival test (`from` → `destination`)
- `isochrone.ts:487` — the full step (`from` → `end`)
- `isochrone.ts:508` — the substep retry, inside the `[2,4,8]`-divisor loop
- `isochrone.ts:556-562` — the endpoint-capture hop (`end` → `destination`)

Every one passes `settings.safetyDepthM` as `gateM`. No other code in
`solve()` reads `safetyDepthM` at all — not `sailFloorKn`, not `pruneKey`, not
`better()`, not `visitedDominates`.

### 1.2 The gate is a scalar argument, never solver state — that is what makes locality a narrow change

`planRoute.ts:509` builds `relaxedSettings: Settings = { ...s, safetyDepthM:
usedDepthM }` from the single scalar `findRelaxedDepthM` discovers
(`relaxedDepth.ts:34-73`, a binary search over cheap `cellsConnected` BFS
probes — 4 probes at the 3.0 m default, `BOAT_DRAFT_M = 2.1` as the hard
floor). `run()` passes that `Settings` object straight into `solve()`, which
destructures it at `isochrone.ts:287` and reads `settings.safetyDepthM` at the
four sites above. So the gate is never baked into any solver state — it is
re-read as a plain scalar at each of four sites and handed to `edgeFactor` as
an ordinary argument. The narrowest possible local-relaxation cut is to
replace those four `settings.safetyDepthM` expressions with a
position-dependent gate, leaving `edgeFactor`'s own body,
`segmentNavigable`/`segmentClearanceM`, and the whole node/frontier/pruning
machinery untouched. This is the fact that makes all three designs below
technically feasible without a solver rewrite, and it is why a structural
guard over "exactly these four call sites read the gate" is checkable at all
— every design proposes one.

### 1.3 Three consumers outside `solve()` read the same relaxed scalar

A design that localizes `edgeFactor` alone and stops there ships a hole,
because three other things consume the identical `settings.safetyDepthM`
(which, inside the relaxation block, IS the relaxed gate) and would silently
disagree with a localized solver:

- **`postprocess.ts:22`** — `mask.segmentClearanceM(a.start, b.end,
  s.safetyDepthM)`, re-validating the *merged span* of two collinear legs at
  the same relaxed gate the merged solve used. Its own comment (`:24-34`)
  admits a merge can cut a corner neither original leg touched — so a
  straightened dogleg can re-cross relaxed water anywhere the merge pass
  considers, independent of where the solver actually needed the relaxation.
- **`postprocess.ts:35-38`** — the two per-leg clearance comparisons, active
  only when `comfortDepthM` is set, comparing the merged span's clearance
  against the worse of the two original legs'.
- **`mask.cellsConnected(a, b, depthM)`** (`mask.ts:188-229`) via
  `connectedAt` — used both by `planRoute.ts:416-421`'s fast-path classifier
  and by `findRelaxedDepthM`'s own probe loop (`relaxedDepth.ts:47-52`). This
  is the cheap, solver-free reachability oracle every design reuses in some
  form, and it currently has **two textually identical copies** that must be
  changed together or the fast-path classifier and the relaxed-gate search
  will disagree about what "connected" means.

### 1.4 Snapping happens at the requested gate and is not relaxable

`planRoute.ts:281/283/288` — `mask.snapToNavigable(p, s.safetyDepthM)` for
origin, destination, and every via, always at the *requested* depth with a
300 m search radius. A snap failure returns `status: 'error'` before any tier
runs, so relaxation — however it is scoped — can only ever open water
*between* already-snapped waypoints, never the berth cell itself. All three
designs record this as a real limitation; none of them touches the snap. So
"relax the harbour approach" is, structurally, half-delivered by any of the
three: they relax the passage, not the last few hundred metres into the
slip.

---

## 2. The three designs

All three keep the tier structure, the cause vocabulary
(`SolveFailureCause`, never exposed to `types.ts`), and the solve count
(4 tiers × 2 rigs × (waypoints−1) segments) unchanged. All three propose a
comfort-ramp clamp because in-disc/-corridor/-tolled clearance can fall below
the gate, which the current ramp's own comment asserts cannot happen. Judged
fairly, each has a genuine strength the others lack.

### 2.1 P1 — Witness-corridor local relaxation

**Mechanism.** After `findRelaxedDepthM` returns its global gate `g`
unchanged, a 0-1 BFS ("witness pass") finds the chain crossing the *fewest*
sub-requested cells between each waypoint pair. Each maximal run of
sub-requested cells on that chain becomes a *patch*, gated at
`g_i = floor10(min depth over that run)` — provably `>= g`, since `g` is the
minimum over the *whole* chain. Each patch is then dilated (multi-source BFS,
bounded by `DILATE_RADIUS_CELLS` and `MAX_PATCH_CELLS`) to give the solver
lateral room; hitting either bound *refuses* the patch (fails closed —
no route, not a wider licence).

**Invariant, and its proof.** The permitted cell set under P1 is a *provable
subset* of today's globally-relaxed set, for the same plan. The proof is
three lines: every patch member has `depth >= g_i` by the dilation's own
frontier test, and `g_i >= g` by construction — so every permitted cell has
`depth >= g`, i.e. the new set is contained in the old one. P1 is the only
design to state this as a closed proof rather than an argument, and it never
touches `findRelaxedDepthM` at all — the 8 pinned tests in
`relaxedDepth.test.ts` are untouched, and `usedDepthM` can never be *lowered*
by this design (unlike P3 — see §5).

**Constants.** `DILATE_RADIUS_CELLS` and `MAX_PATCH_CELLS` are **explicitly
unmeasured** — the proposing agent's own text: "treat any number I could
write here as a placeholder." This is not a minor gap: with ~46 m cells
against solver steps of hundreds of metres to ~2 km, a cell-connected
corridor can be *geometrically* connected yet *solver-untraversable* — the
same #20 failure class ("step length vs. real channel width") that synthetic
masks missed and a real-data run found in minutes. If the radius has to grow
large enough to be traversable, the corridor approaches the global set and
the localization benefit evaporates; if it stays tight, real routes are lost.

**Test methodology — the strongest of the three, worth grafting regardless of
the primary decision.** P1's battery: a containment property test with the
needle (corridor membership) and haystack (a direct raw-byte scan) drawn from
independent sources, avoiding the #50 equivalence tautology; a deliberate
*refusal* to assert `g_i >= BOAT_DRAFT_M` as a test row, because that is a
theorem given the dilation's own frontier test and would be exactly the #410
unreachable-mutation trap; a merge-pass locality test whose mutation is
"pass no corridor to `mergeCollinearLegs`," without which forgetting
`postprocess.ts:22` is invisible; and a byte-identity row proving the
non-relaxing path (501 of 528 pairs) is structurally, not just hopefully,
unchanged.

### 2.2 P2 — Requested-depth toll

**Mechanism.** No discovery step at all — the design leans on the repo's own
precedent that tack/gybe minimization "emerges from the maneuver time penalty
... don't add a post-hoc reducer," and applies the same argument here. A new
`RELAX_TOLL_MAX = 0.30` prices every cell between the relaxed gate and the
*requested* gate, on top of the existing #243 comfort ramp, inside
`edgeFactor`. `findRelaxedDepthM` stays completely untouched. The toll fires
regardless of whether the comfort preference is active, which is the
mechanism's real point (see the finding below).

**Invariant.** Weak by construction, and the design says so itself: the
*feasible* cell set is bit-identical to today's — nothing becomes
unreachable, nothing becomes newly reachable. The toll only changes what is
*preferred* inside an unchanged feasible set, bounded to at most ~2.04×
cost inflation by its own arithmetic (floor factor `(1-0.30)×(1-0.30) =
0.49`).

**The single most valuable finding in the entire set, independently
re-verified by both judges against the code**: `edgeFactor` short-circuits to
a bare `segmentNavigable(a, b, gateM)` when `comfortDepthM` is undefined
(`isochrone.ts:209-210`), and `postprocess.ts:35-38`'s clearance-worsening
guard is likewise gated on `comfortDepthM !== undefined`. So **tier 4, and
any user running `depthComfortMarginM: 0`, have no pricing and no merge
protection at all — every cell from the relaxed gate upward is identically
free over the whole passage.** That is the #452 complaint in its purest,
completely unguarded form, and P2 found it by asking "which configurations
are actually unpriced today" rather than "how do I localize the water." Both
judges independently graft this finding onto their recommendation regardless
of which design wins (§3.2).

**What sinks it as the primary design (§5.1).**

### 2.3 P3 — Approach-scoped relaxation ("relaxation discs")

**Mechanism.** Replace the route-wide relaxed *scalar* with a per-cell gate
*field*: `gateAtCell(cell)` returns the relaxed gate `g` when the cell's
centre lies within `APPROACH_RADIUS_M` of a snapped waypoint, else the
requested gate. `findRelaxedDepthM`'s binary search is unchanged in shape —
only its internal `connectedAt` is re-parameterized to consult the field
instead of a scalar; monotonicity in the gate still holds (lowering the gate
only lowers *in-disc* gates), so the same probe count and probe sequence
survive. `edgeFactor` and the three consumers in §1.3 all take the field
instead of the scalar. `Settings.safetyDepthM` is never overwritten with a
relaxed value — a correctness improvement over today's `{ ...s, safetyDepthM:
usedDepthM }` copy in its own right, independent of locality.

**Invariant.** *No leg of a returned plan may cross a cell charted below the
requested depth unless that cell lies within `APPROACH_RADIUS_M` of a snapped
waypoint.* Unlike P1's subset proof, this is not a claim that the permitted
set only shrinks — a localized connectivity search is *strictly harder* to
satisfy than a global one, so the discovered gate `g` can come out *lower*
under P3 than under today's global search (a genuine trade, not a free
win — see §5.2's fatal-flaw discussion for why this did not disqualify P3
anyway). What P3 buys instead is *spatial* confinement: relaxed water can
only ever appear near a waypoint the user actually chose.

**Constants — MEASURED, not a placeholder, and this is the decisive
difference from P1.** The proposing agent reports running a numpy/scipy
reimplementation against the committed mask directly (`develop @ 836be3f`,
2200×2400); the feasibility-lens judge independently **re-ran** the same
scripts in `pipeline/.venv` before endorsing the numbers, so these are
doubly-sourced, not merely asserted:

- Region-wide, 194 components at the 3.0 m gate; 27 of 33 harbours sit in the
  giant component, 6 in isolated pockets, and Marstal is the *only* one that
  reconnects under relaxation at all — an independent structural check (the
  safety-lens judge, cross-referencing `pipeline/verify_mask.py`'s
  `KNOWN_DISCONNECTED` list and this repo's own #9/#245 record) confirms the
  other five are exactly `verify_mask.py`'s known-unreconnectable set.
- Marstal's 3.0 m pocket: 66 cells, max extent 697 m from the snap; its
  shallow corridor to the main component: 11 cells, 510 m.
  **Minimum radius that reconnects Flensburg↔Marstal at gate 2.3 m: 1068 m —
  identical to the global search's answer at every radius from there up.**
  So on the one live case, scoping costs nothing in relaxation depth.
- Route-wide, the *global* mechanism today licenses 44,159 cells in the
  [2.3, 3.0) band. An approach-scoped field for a Flensburg↔Marstal plan
  licenses **488 cells at R = 1852 m** or **1,298 at R = 3704 m** — a 90× or
  34× reduction.
- Region-wide sanity: of 193 non-main-component pockets, 103 are rescued by
  relaxation at gate 2.3; **all 103 are covered at R = 1852 m**, worst-case
  extent 1,839 m (a 12 m margin over the chosen 1852 m radius — see §3.3).

**Kill switch, and why it is the strongest of the three.**
`APPROACH_RADIUS_M = Infinity` makes every cell a disc member, so
`gateAtCell` degenerates to the constant relaxed gate — reproducing today's
route-wide behaviour *cell for cell*, not approximately. This repo already
trusts the identical pattern for `--sc-panel-w`'s bare `1fr` CSS fallback
(#355): the neutralized state is a state that has already shipped and been
swept, not a new approximation that itself needs re-verifying.

---

## 3. RECOMMENDATION: P3, with grafts — but NOT YET

Both the feasibility-lens judge and the safety-lens judge, working
independently from the same three designs, chose Proposal 3. Neither
recommends implementing it this session.

### 3.1 Why both judges landed here

**Feasibility.** P3's churn is the *loud* kind: changing `edgeFactor`'s gate
parameter from a number to a field, and `findRelaxedDepthM`'s arity, makes
`tsc -b` enumerate every call site in a `strict` +
`exactOptionalPropertyTypes` repo — the cheapest possible form of blast-radius
control, in contrast to P2's tiny diff whose comfort-ramp re-anchoring
silently moves every tier-3 factor including in deep water. P3's budget
profile is the best of the three: probe count unchanged at 4, per-probe cost
bounded by an O(1) bounding-box reject, per-edge cost near-zero outside two
discs, and — unlike P2 — no interaction with `MAX_FRONTIER`, which the
solver's own recorded measurement shows is *live* on the target route
(Flensburg→Marstal "frontier peaking at MAX_FRONTIER," `isochrone.ts:333-339`
per the ground-truth pass).

**Safety.** On the stated priority order (can it put the boat in shallower
water than believed; can it fail silently; is the invariant enforced in code
or merely intended), P3's invariant is checkable by reading one function
(`gateAtCell`) — a tired reviewer's realistic bar — where P1's requires
following a BFS into a dilation into a bitmap into three consumers, and P3's
central trade (it can lower `usedDepthM` versus P1's provable non-lowering)
was measured, not merely argued, to cost nothing on the only live case
(Marstal: 2.3 m either way, at every radius from 1068 m up).

### 3.2 Required grafts before implementation

Neither judge endorses P3 as originally specified. Both independently name
overlapping grafts:

1. **P1's per-patch gates, not one global relaxed scalar per disc.** P3 as
   specified grants one relaxed gate inside every disc — so a pinch needing
   2.8 m and a pinch needing 2.3 m both get 2.3 m. P1's `g_i` (highest gate
   that connects *that specific* blocking run) is provably `>= g` and should
   replace P3's single scalar; the safety-lens judge calls this "the best
   single idea in the set" and says it recovers most of P1's safety advantage
   at no extra solve cost.
2. **P1's test methodology**, wholesale: the containment/subset property test
   with independently-sourced needle and haystack; the deliberate refusal to
   assert `>= BOAT_DRAFT_M` as a row (the #410 trap); the merge-pass locality
   mutation; the byte-identity-of-the-unrelaxed-path row.
3. **P2's `shallow.minGateDepthM` must-not-fall-below-BASE assertion.** This
   is the one guard against P3's own named trade (§2.3: a localized search
   can return a *lower* connecting gate than the global one) silently
   presenting as an improvement in the sweep's exposure column. Both judges
   call this out specifically for P3's failure mode.
4. **P2's `ShallowInfo.shallowDistanceNm` outcome field** ("0.2 nm below your
   3.0 m setting, minimum 2.4 m") — composes cleanly with P3's own proposed
   `radiusM` field into one honest user-facing sentence, rather than
   explaining the mechanism.
5. **Thread the same gate object into `mergeCollinearLegs`.** Both P1 and P3
   independently propose this (it is required by §1.3); the safety-lens judge
   flags it as the seam a naive `edgeFactor`-only fix would silently miss —
   `postprocess.ts:22` re-validates the merged span at whatever `s` it is
   handed, so a straightened dogleg can re-cross relaxed water outside a disc
   unless the merge pass gets the identical field.
6. **Split the PR.** The safety-lens judge specifically: the disc-gate change
   and the comfort-ramp re-anchor/clamp are two independent behaviour
   changes, and landing them together makes the sweep diff uninterpretable —
   the ramp change perturbs `costMs` in the same `MAX_FRONTIER`-live regime
   the feasibility lens flags. Attribute it deliberately or the sweep readout
   will misattribute a ramp effect to a locality effect.

### 3.3 The radius caution

`APPROACH_RADIUS_M = 3704 m` is presented in the original design as "2×
headroom" over the measured 1,840 m worst case. Licensed area scales as
`R²`, and P3's own numbers show the cost of that headroom directly: 488
cells at R = 1852 m against 1,298 at R = 3704 m — the "free" 2× radius
headroom is a **34×-vs-90×** difference in how much shallow water is
licensed, not a free safety margin. The safety-lens judge's counter-proposal:
**R ≈ 2400–2600 m**, presented explicitly as a *measured margin* over the
1,840 m worst case, not as "2× headroom." At the *smaller* end of the
originally proposed range — R = 1852 m — the margin over the 1,839 m worst
case (§2.3) is **12 metres**, a knife-edge, not a buffer; the original
1852 m/3704 m pairing in the source material should not be read as two
comparably-safe choices.

---

## 4. THE TWO DO-NOT-SHIP CONDITIONS

Both judges independently reached both of these. Together they are the
reason this document ends in a spike rather than a green light, and they are
the part of this document most likely to still matter after an
implementation begins.

### 4(a) The configuration that needs this fix was never identified

At `DEFAULT_SETTINGS`, the #243 comfort ramp **already** localizes
Flensburg→Marstal to a small fraction of the passage. Pinned today by
`exposureNm(legs, 3.0) < 0.6` in `realmask.repro.test.ts:359-386`, with
in-comment measured literals: **1.33 nm** pre-#243, **~0.23 nm** measured
after. `DEFAULT_SETTINGS.depthComfortMarginM = 2.0` (`types.ts:69`) puts the
default path in tier 3, where that ramp is active — so a user on default
settings is not experiencing the unbounded, route-wide licence #452's framing
implies; #243 already did most of the localizing work for that specific
population.

The population that is genuinely and completely unprotected is narrower than
#452's framing suggests: **tier 4**, and **any user running
`depthComfortMarginM: 0`**. There, `edgeFactor` short-circuits to bare
`segmentNavigable` (`isochrone.ts:209-210`) and `postprocess.ts:35-38`'s
clearance-worsening check is inert (`comfortDepthM !== undefined` gates it),
so every cell from the relaxed gate upward really is uniformly free over the
whole route — this is P2's central finding (§2.2), independently confirmed
by both judges reading the same two lines.

**Neither judge could determine, from anything in this repo, which
configuration produced the original #452 complaint.** If it was observed at
`DEFAULT_SETTINGS`, the measurable win from any of these three designs is
under a quarter nautical mile on the 27 pairs that relax at all — which does
not obviously justify a change carrying a full `app/sweep/` acceptance cycle,
a signature change rippling through 8 pinned `relaxedDepth.test.ts` cases and
9 `isochrone.test.ts` cases, and the do-not-ship condition in §4(b) below.
If it was observed at tier 4 or `depthComfortMarginM: 0`, the fix is real,
narrower, and worth doing. **This must be asked and answered before code is
written, and the answer recorded here or in the tracking issue either way.**

### 4(b) The sweep cannot currently discriminate a correct fix from a silently broken one

`app/sweep/sweepArms.ts`'s own header comment (`:60-95`, quoted verbatim)
records: *breeze* — 27 `ok`, and (paired with *no-comfort*) "the source of
the only two plans carrying a #53 shallow warning" across the entire 198-plan
run. The sweep is Flensburg→33-harbours, and every pair that relaxes at all
is Marstal-destination — **27 of 528** plan/setting combinations across all
six arms.

So today, an aggregate byte-identity comparison across the six arms is
dominated by routes this class of change **cannot touch at all** — exactly
the same shape as the sweep's own documented `becalmed`/`deep-becalmed`
vacuity (33/33 errors each, byte-identical to a catastrophic mask change or
to no change at all). **A green six-arm comparison run against the current
sweep would be evidence about routes the change provably cannot reach, not
evidence the change is correct.** Shipping on that evidence would be worse
than shipping with no sweep evidence, because it would read as a passed
acceptance gate.

Both judges: add a relaxation-exercising arm (a Marstal-destination arm, and
a `depthComfortMarginM: 0` arm to reach §4(a)'s genuinely-unprotected
population) and re-record BASE — including the required BASE double-run
control — **before** any BASE-vs-HEAD comparison is quoted for this change.
Per the standing repo rule, `compare.mjs` fails closed on zero arm files but
not on fewer than six (now seven), so the arm-file count must be asserted by
hand.

**Escalation trigger, stated by the safety-lens judge and worth repeating
verbatim as the stop condition**: on the new arm, any `ok → error`
transition, any `shallow.usedDepthM` below BASE's, or any
`shallow.minGateDepthM` below BASE's on HEAD — the last being the signature
of a "safety fix" that silently lowered the number the safety warning prints
— should stop the work and go back to design, not forward into a fix.

---

## 5. CONSIDERED AND REJECTED

| Option | Why it lost |
|---|---|
| **P2 — requested-depth toll, as the primary mechanism** | Two compounding reasons, both verified against the code rather than argued. **First**: it is a *price*, not a *bound* — the permitted cell set is bit-identical to today's, capped at ~2.04× cost by its own arithmetic (floor factor 0.49), so a deep alternative more than ~2× longer in time still loses to the shoal. The boat may still be routed through relaxed-gate water arbitrarily far from the harbour that caused the relaxation — the opposite of the locality the maintainer asked for. **Second, and worse**: the cost composes over the *route*, so the toll optimizes an *integral* of shortfall, not the route's *minimum* clearance. `isochrone.ts:172-185` already documents exactly this residual for the existing #243 ramp with a measured case (Ærøskøbing→Drejø: recommended-rig minimum clearance settles at 3.0 m instead of the pre-#243 3.7 m) and records it as **derate-insensitive** — present identically at every tested ramp value 0.15–0.40, so retuning `RELAX_TOLL_MAX` cannot fix it. P2 steepens the same mechanism, so its most likely outcome is a "safety fix" that silently lowers `ShallowInfo.minGateDepthM`, the exact number the user reads. It names this itself as a failure mode, which is to its credit but does not make it shippable. Additionally: the toll inflates `costMs`, `better()` sorts on `costMs`, and the solver's own recorded measurement shows Flensburg→Marstal's frontier already peaks at `MAX_FRONTIER` — pushing the toll's cost onto exactly the mandatory sub-requested crossing, in exactly the regime where the frontier cap discards candidates by count rather than by geometry. A resulting no-route would surface as `mask-blocked`, a search-capacity fault wearing a water-fact label. |
| **P1 — witness corridors, as the primary mechanism (not as a source of ideas — its per-patch gates and test methodology are grafted into the recommendation, §3.2)** | Its containment proof is the strongest of the three, but its central constant is not: `DILATE_RADIUS_CELLS` is admittedly **unmeasured**, and with ~46 m cells against solver steps of hundreds of metres to ~2 km, a cell-connected corridor can be geometrically connected yet solver-untraversable — the #20 failure class synthetic masks miss and a real-data run finds in minutes. If the radius has to be widened enough to stay traversable on the 27 live Marstal pairs, the corridor approaches the global set and the localization benefit evaporates; kept tight, real routes are lost to a cap-refusal that turns a route into a no-route. A guarantee that may have to be dialled back to near-nothing to keep existing routes alive is not a delivered guarantee — P3's spatial-confinement invariant is measured to hold at its chosen radius; P1's traversability margin is not measured at all. |
| **Any design that stops at `edgeFactor` and does not thread the gate into `mergeCollinearLegs`** | `postprocess.ts:22` re-validates a merged span at whatever gate/settings object it is handed, and a merge can cut a corner neither original leg touched (`postprocess.ts:24-34`'s own comment). A localized `edgeFactor` that forgets this ships exactly the hole it set out to close — named explicitly by both the ground-truth pass and both judges. |
| **Shipping any of the three this session, on the current sweep, at an unidentified configuration** | See §4 in full. Not rejected as designs — rejected as a *this-session* decision. |

---

## 6. What would change this recommendation

Stated so a future reader knows what new evidence matters, rather than
re-litigating the same argument:

1. **The maintainer names the configuration that produced the #452
   complaint.** If it is confirmed to be `DEFAULT_SETTINGS`, the size of this
   effort should be reconsidered against a sub-quarter-nautical-mile
   measured win on 27 of 528 pairs — a much smaller undertaking (or a
   deferral) may be the right call, and that reconsideration should happen
   *before* implementation, not discovered by the sweep afterward. If it is
   confirmed to be tier 4 or `depthComfortMarginM: 0`, the case for
   proceeding is strong and narrower in scope than #452's original framing.
2. **A relaxation-exercising sweep arm exists and BASE is re-recorded.**
   Until then, no BASE-vs-HEAD comparison for this change means anything,
   regardless of which design is chosen.
3. **`DILATE_RADIUS_CELLS` (if P1's mechanism, or a P1-graft, is ever
   reconsidered as primary) gets an actual traversability measurement** on
   the real committed mask and the 27 live Marstal pairs, not an argument
   from cell-connectivity alone. Absent that, P1 stays disqualified as a
   primary mechanism by this document's own reasoning, not merely by
   preference.
4. **`APPROACH_RADIUS_M` is chosen and documented as a measured margin**
   (§3.3's ~2400–2600 m band) rather than inherited as "2× headroom" from the
   original design — and re-derived if the committed mask ever changes (a
   #455-class tolerance change, or a #245-class resolution change, would
   both invalidate the 1,840 m worst-case measurement this radius is based
   on).
5. **Evidence that P3's per-disc gate can genuinely come out lower than the
   global search's answer on some real harbour** — not just Marstal, where
   it measurably does not. If such a harbour exists, the §3.2 grafted
   `minGateDepthM`-regression guard needs to be exercised against it
   specifically before this recommendation should be trusted as safe in
   general, not just safe on the one case that has been checked.

---

## 7. Invariants checked against this recommendation

- **Navigability stays a query-time decision.** Nothing here proposes baking
  a gate into the mask; `safetyDepthM` remains a user setting under all three
  designs, and P3's `Settings.safetyDepthM` no longer even gets silently
  overwritten with a relaxed value during a solve — a correctness
  improvement independent of which design ships.
- **#282 — no-route `reason` is a control input.** All three designs are
  classification changes under #282's rule (`findRelaxedDepthM` can now
  return `null` where it returns a gate today), not labelling changes. Every
  design states this itself; the full `app/sweep/` acceptance sweep is
  therefore mandatory before merge under any of them, which is part of why
  §4(b) is a hard blocker rather than a nice-to-have.
- **Guard asymmetry.** P3's spatial-confinement invariant fails toward *less*
  water licensed, never more, at its dilation/disc boundary; P1's cap-refusal
  fails toward *no route* rather than a silently wider licence. Both are the
  expensive-but-safe direction. P2 is the one design that does not fail this
  way cleanly — its price is bounded, so it is never a hard refusal, which is
  part of why it lost (§5).
- **The app is a planning aid, not a navigation device.** Whatever ships here
  must not let a user believe a relaxed route carries the same clearance
  everywhere the requested-gate route would have — P3's `radiusM` field and
  P2's `shallowDistanceNm` outcome field (grafted, §3.2) both exist to make
  that visible rather than implicit.
- **No backend, offline-first.** All three designs are solver-worker-local
  changes; none introduces a network dependency or changes what is
  precached.
