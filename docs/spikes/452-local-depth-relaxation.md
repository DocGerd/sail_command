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
- **Both of those two clauses have MOVED since this verdict was written —
  read [Measured 2026-08-10](#measured-2026-08-10) before acting on it.** The
  configuration is now identified, and the same answer argues *against*
  proceeding rather than for it (`Refs #492`, §4(a)); PR #488 has added the
  three relaxation-exercising sweep arms the second clause asked for, while
  the BASE re-record it equally requires is still outstanding (§4(b)).

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
pre-/post-#243 literals in `realmask.repro.test.ts`'s "the relaxed gate is
localized to the pinch, not the whole passage" test (~:359-386); the
six-arm role comment above `sweepArms.ts`'s `export const ARMS` (~:60-95),
including the "only two plans carrying a #53 shallow warning" line; and the
`MAX_FRONTIER` / `DEPTH_DERATE_MAX` comment block in `isochrone.ts`
(~:157-186), including the Ærøskøbing→Drejø "derate-insensitive" residual P2
and the safety judge both cite. All matched the workflow's citations
exactly. The repo moved one
docs-only commit past the workflow's `836be3f` reference point before this
branch was cut (`4f0c786`, CLAUDE.md citation anchoring only, verified via
`git show --stat` to touch no `app/` file) — nothing below is stale on that
account.

**A conflation this document made and then corrected, recorded so it is not
repeated**: an earlier draft described "27 of 528" as a figure produced by
the six-arm sweep. It is not. `sweepArms.ts`'s own six-arm role comment
(~:60-95) and `app/sweep/README.md:3` both state the harness is **6 arms ×
33 harbours = 198 plans** — 528 is not a number the sweep produces at all.
528 = C(33,2), all harbour *pairs* (verified: `math.comb(33, 2) == 528`),
and the "27 of 528" figure comes from a maintainer comment on issue #452
itself (`gh api repos/DocGerd/sail_command/issues/452/comments`,
2026-08-07T21:04:54Z — read directly in this session, not paraphrased):
*"Component-labelling all 33 harbour snaps at every gate from 2.1 to 3.0 m,
528 pairs: 351 connect at 3.0 m and never relax ... relaxation succeeds in
exactly 27 — every one of them involving Marstal."* That is a harbour×gate
component-connectivity analysis run directly against the mask, independent
of the sweep's arm structure. §4(b) and §6 cite it with that provenance now;
do not re-attach it to the sweep, and do not read "528" as anything other
than harbour pairs.

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

- `isochrone.ts`'s `directFactor = edgeFactor(...)` call (~:435) — direct-candidate arrival test (`from` → `destination`)
- `isochrone.ts`'s `fullFactor = edgeFactor(...)` call (~:487) — the full step (`from` → `end`)
- `isochrone.ts`'s `subFactor = edgeFactor(...)` call, inside the `[2,4,8]`-divisor loop (~:508) — the substep retry
- `isochrone.ts`'s `captureFactor = edgeFactor(...)` call (~:556) — the endpoint-capture hop (`end` → `destination`)

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
non-relaxing path (P1's own figure: 501 of the 528 harbour pairs — see §0's
note on that count's real source, a maintainer issue-comment analysis, not
the sweep) is structurally, not just hopefully, unchanged.

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
  **CONTRADICTED, UNRESOLVED — do not quote this 1068 m minimum on its own.**
  The 2026-08-10 sweep ([Measured 2026-08-10](#measured-2026-08-10)) reads
  0/55 pinch at **1060 m**, i.e. no plan in that population loses
  connectivity 8 m *below* this stated minimum. Both cannot be "the smallest
  radius at which scoped relaxation still works" under one definition; which
  definition each measured was not established. That section lists the
  candidate differences and marks the conflict open.
- Route-wide, the *global* mechanism today licenses 44,159 cells in the
  [2.3, 3.0) band. An approach-scoped field for a Flensburg↔Marstal plan
  licenses **488 cells at R = 1852 m** or **1,298 at R = 3704 m** — a 90× or
  34× reduction.
- Region-wide sanity: of 193 non-main-component pockets, 103 are rescued by
  relaxation at gate 2.3; **all 103 are covered at R = 1852 m**, worst-case
  extent 1,839 m (a 13 m margin over the chosen 1852 m radius — see §3.3).

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
(Marstal: 2.3 m either way, at every radius from 1068 m up — a figure the
2026-08-10 sweep contradicts without resolving; see §2.3's marker on it).

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

Figures in this section are the same §2.3 numbers re-quoted, so the same
provenance applies: **MEASURED-BY-THE-SOURCE** (P3's own numpy/scipy
reimplementation, independently re-run by the feasibility-lens judge against
the committed mask — doubly-sourced, not independently re-derived by this
document).

`APPROACH_RADIUS_M = 3704 m` is presented in the original design as "2×
headroom" over the measured 1,839 m worst case. Licensed area scales as
`R²`, and P3's own numbers show the cost of that headroom directly: 488
cells at R = 1852 m against 1,298 at R = 3704 m — the "free" 2× radius
headroom is a **34×-vs-90×** difference in how much shallow water is
licensed, not a free safety margin. The safety-lens judge's counter-proposal:
**R ≈ 2400–2600 m**, presented explicitly as a *measured margin* over the
1,839 m worst case, not as "2× headroom."

> **~~R ≈ 2400–2600 m~~ IS SUPERSEDED — 2026-08-10 recommends R = 1852 m
> (1 nm)**, see [Measured 2026-08-10](#measured-2026-08-10). The band is left
> in place above because the *reasoning* that produced it — margin against a
> measured worst case rather than a round multiple — is what the replacement
> also rests on. Do not carry the number forward.

At the *smaller* end of the
originally proposed range — R = 1852 m — the margin over the 1,839 m worst
case (§2.3) is **13 metres** (1852 − 1839), a knife-edge, not a buffer; the
original 1852 m/3704 m pairing in the source material should not be read as
two comparably-safe choices.

> **RESOLVED (`Refs #502`): the worst-case pocket extent is 1,839 m.** This
> section states its own figures are "the same §2.3 numbers re-quoted"
> (above); §2.3's own "Region-wide sanity" bullet records 1,839 m, so the
> two instances above that read 1,840 m did not match the source they claim
> to re-quote — corrected in place. The margin over R = 1852 m is **13 m**
> throughout, never 12 m.

**The knife-edge SURVIVES that supersession — it is not the margin the
2026-08-10 section quotes.** That section margins R = 1852 m against the
1050→1060 m pinch cliff and gets ~790 m. These are two *different*
constraints at the same radius, and the pocket-coverage one above is the
larger, so it is the one that binds: nothing measured on 2026-08-10 retires
the requirement that a disc reach the 1,839 m worst-case pocket extent. Read
"R = 1852 m" as clearing the cliff comfortably and the pocket extent by
13 m — never as having ~790 m of margin outright.

---

## 4. THE TWO DO-NOT-SHIP CONDITIONS

Both judges independently reached both of these. Together they are the
reason this document ends in a spike rather than a green light, and they are
the part of this document most likely to still matter after an
implementation begins.

### 4(a) The configuration that needs this fix was never identified

At `DEFAULT_SETTINGS`, the #243 comfort ramp **already** localizes
Flensburg→Marstal to a small fraction of the passage. Pinned today by
`exposureNm(legs, 3.0) < 0.6` in `realmask.repro.test.ts`'s "the relaxed gate
is localized to the pinch, not the whole passage" test (~:359-386), with
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

**ANSWERED 2026-08-10 — and the answer argues AGAINST proceeding, not for
it.** See [Measured 2026-08-10](#measured-2026-08-10) below for the full
record. The maintainer confirmed the reported route was Flensburg→Marstal at
`DEFAULT_SETTINGS` — the *first* branch of the question above, i.e. the one
this section's own text says does "not obviously justify a change carrying a
full `app/sweep/` acceptance cycle". The same response went further and
reproduced that route: minimum charted depth on the delivered track
**4.10 m**, **zero** cells below the requested gate — no routing defect at
all, the shallow appearance being an artifact of the absolute-depth colour
ramp rather than of where the router put the boat (a separate, live concern,
`Refs #492`). **So condition 4(a) is answered, not cleared**: the
configuration is identified AND the incident that motivated #452's framing
did not reproduce as a relaxation-locality problem. Reading this block as a
green light inverts its evidence.

Separately, 29 of the 55 shallow-bearing plans in the
current re-solve population have a sub-requested-gate cell beyond 2400 m
from every waypoint.

**Per-ARM breakdown of the 55 — NOT a tier split of the 29** (an earlier
revision of this paragraph labelled it as one): `no-comfort` 1 (tier 3),
`margin-zero` 27 (all tier 3), `relaxation-dense` 16 tier 3 + 11 tier 4.
These are each arm's *total* shallow-bearing row count, and they sum to
1 + 27 + 27 = **55**, which is why they cannot be a split of a 29-plan
subset. Twin-checked against `app/sweep/`'s own committed sources, written
from a separate instrumented run: `README.md` records `margin-zero` 27/33
and `relaxation-dense` 27/33 rows carrying a `shallow` block, and
`sweepArms.ts`'s arm-role comment records that `margin-zero` "can NEVER
produce a tier2/tier4 row by construction" while `relaxation-dense` resolves
11 of its 27 via tier 4 under its documented TIER-REACH METHOD — leaving the
16. (That 16 is arithmetic on the tier-4 count. It is *not*
`app/sweep/README.md`'s unrelated `margin-zero`-vs-`relaxation-dense`
"16 / 33 plans differing" figure — two different 16s, do not twin them.)
**The tier split of the 29-plan >2400 m subset is stated nowhere in this
document and was not measured.** It is a subset selected by a distance
criterion that cuts across arms, so it cannot be derived from the per-arm
numbers above — leave it as the gap it is.

### 4(b) The sweep cannot currently discriminate a correct fix from a silently broken one

**The load-bearing figure, verifiable in-repo**: `sweepArms.ts`'s own
six-arm role comment (~:60-95, quoted verbatim) records *breeze* — 27 `ok`,
and (paired with *no-comfort*) "the source of the only two plans carrying a
#53 shallow warning" — across the entire **198-plan** run (`app/sweep/README.md:3`:
6 arms × 33 harbours). So today, an aggregate byte-identity comparison
across the six arms is dominated by routes this class of change **cannot
touch at all** — exactly the same shape as the sweep's own documented
`becalmed`/`deep-becalmed` vacuity (33/33 errors each, byte-identical to a
catastrophic mask change or to no change at all). **A green six-arm
comparison run against the current sweep would be evidence about routes the
change provably cannot reach, not evidence the change is correct.** Shipping
on that evidence would be worse than shipping with no sweep evidence,
because it would read as a passed acceptance gate.

**A separate, broader fact about the same population, from a different
source** — do not conflate the two. A maintainer comment on issue #452
itself (2026-08-07T21:04:54Z, *not* the sweep) reports a direct
harbour×gate component-connectivity analysis run against the committed
mask: of all **528** harbour *pairs* (C(33,2), every one of the 33 curated
harbours against every other), 351 connect at the 3.0 m gate and never
relax, and relaxation succeeds in exactly **27** — every one involving
Marstal. This is independent evidence that the reachable population is
narrow (27 of 528 *pairs*, not plans or sweep arms), and it corroborates the
sweep's own "only two plans" figure without being the same measurement —
INHERITED from that comment, re-read verbatim in this session but not
independently re-run against the mask here. Cite each figure to its own
source: the sweep's is a fact about `app/sweep/`'s current fixture, checkable
by reading `sweepArms.ts`; the 528/27 figure is a fact about the mask itself,
checkable only by re-running the component-labelling analysis the issue
comment describes.

Both judges: add a relaxation-exercising arm (a Marstal-destination arm, and
a `depthComfortMarginM: 0` arm to reach §4(a)'s genuinely-unprotected
population) and re-record BASE — including the required BASE double-run
control — **before** any BASE-vs-HEAD comparison is quoted for this change.

**PARTIALLY SATISFIED 2026-08-10 — the ARM half only; condition (b) is
NARROWED, not discharged.** PR #488 added three arms, taking the harness to
**nine arms × 33 harbours = 297 plans** (`app/sweep/armNames.ts` lists the
nine; `README.md` states the 297). What shipped is Marstal-**origin**, not
the Marstal-*destination* shape asked for above; `sweepArms.ts`'s
`Arm.originId` doc comment carries the substitution argument — all three
designs scope relaxation on the unordered *snapped-waypoint set*, so
`{marstal_snap, X_snap}` is the identical set whichever end Marstal sits at
— read that argument rather than assuming the two are equivalent.
`margin-zero` supplies the `depthComfortMarginM: 0` arm, deliberately at
Marstal origin because a Flensburg-origin one would have been byte-identical
to the existing `no-comfort`. Measured discriminating power, from
`README.md`'s own 2026-08-10 run: each of the three carries a `shallow`
block on **27 of 33** rows, against the 2-of-198 the paragraph above
records for the original six. That contrast is primarily a consequence of
ARM DESIGN, not the mask: `sweepArms.ts`'s own arm-role comment states that
at Flensburg origin only ONE of a per-arm's 33 rows — the Marstal leg — can
ever carry a successful relaxation (every one of the 27 pairs, of all 528
harbour pairs, that are mask-connected at a relaxed gate involves Marstal),
so a Flensburg-origin arm's discriminating power is capped **at most 1/33**;
Marstal-origin instead pairs Marstal with all 32 other harbours directly.
The two counts were also measured across the
`c359a5c` mask-tolerance rebuild (#455/PR #476, between the 2026-08-07
six-arm baseline and the 2026-08-10 three-arm run) — whether and how much
that also contributed is **not established** from evidence read this wave.

**The BASE half is still outstanding.** Nothing in this document records a
re-recorded BASE, and the repo's standing rule is that the double-run
control must be taken against the **merge-base of the branch it will
certify** — one taken against a `develop` that then moves certifies
nothing. Until that exists, no BASE-vs-HEAD comparison for this change may
be quoted, three good arms notwithstanding.

The hand-count caveat this section used to carry — that `compare.mjs` fails
closed on zero arm files but not on a short arm set — is **superseded**
(#451): `compare.mjs` now derives its expected set from `armNames.ts` and
fails closed on an INCOMPLETE one, printing the missing and unexpected arm
names. The arm-file count no longer has to be asserted by hand.

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
   measured win on the 27 of 528 harbour *pairs* that relax at all (§4b's
   issue-comment figure, not a sweep-arm count) — a much smaller undertaking
   (or a deferral) may be the right call, and that reconsideration should happen
   *before* implementation, not discovered by the sweep afterward. If it is
   confirmed to be tier 4 or `depthComfortMarginM: 0`, the case for
   proceeding is strong and narrower in scope than #452's original framing.
   **ANSWERED 2026-08-10, on the branch that calls for reconsideration** —
   see [Measured 2026-08-10](#measured-2026-08-10) below and §4(a): the
   maintainer confirmed `DEFAULT_SETTINGS`, *and* reproduced the reported
   route as not a routing defect (minimum charted 4.10 m, zero sub-gate
   cells; a colour-ramp artifact, `Refs #492`). Both halves point at this
   item's first branch — "a much smaller undertaking (or a deferral)" — so
   this is an answer to act on, not a box to tick.
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
   both invalidate the 1,839 m worst-case measurement this radius is based
   on).
   **ANSWERED 2026-08-10** — see [Measured 2026-08-10](#measured-2026-08-10)
   below: R = 1852 m (1 nm) is now recommended, superseding §3.3's
   2400–2600 m band (marked superseded in place there too, so a top-down
   reader of §3 cannot meet the stale figure first). The 1,839 m worst-case
   pocket extent this item names is **not** superseded with it: R = 1852 m
   still clears it by only 13 m (1852 − 1839; `Refs #502`), and
   re-deriving it after a mask change remains required.
   **ACCEPTANCE RULE for that re-derivation, so the outcome is decided
   before the number is known.** Pocket coverage is a floor, so:
   a re-derived worst case **ABOVE 1852 m INVALIDATES this radius** — R must
   be raised to clear the new figure, and "1 nm is a natural constant" is
   explicitly *not* a reason to keep it (roundness is a tie-break among radii
   that already clear the floor, per the recommendation's own bullets). A
   figure landing **exactly at 1852 m** leaves zero margin, and whether an
   extent equal to R counts as covered is a boundary convention this
   document nowhere states — a maintainer call, not a silent pass. A
   re-derived figure
   anywhere **below** 1852 m keeps R valid and only moves the margin, in
   which case §3.3's knife-edge wording must be restated at the new
   difference rather than left at 13 m — and R should then be reset to the
   smallest radius that clears the new floor, proposing a new candidate if
   none of this document's existing three is that radius.
   What this rule deliberately does
   NOT settle: whether a knife-edge is an acceptable place to sit at all —
   that is the judgement recorded in the recommendation, and it is an
   argument from documented pressures, not a measurement.
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

---

## Measured 2026-08-10

Driven off the shallow-bearing plans in the current `app/sweep/` fixture
rather than the single Flensburg↔Marstal case §2.3/§3.3 measured, this
section answers two of §6's open items and adds three further findings.

**The fixture, stated exactly**: **nine arms × 33 harbours = 297 plans**
since PR #488. **Three arms were run here** — `no-comfort`, `margin-zero`,
`relaxation-dense`, i.e. **99 plans** — of which **55** carry a `shallow`
block. `breeze`, `short-horizon`, `light-motorless`, `becalmed`,
`deep-becalmed` and `margin-extreme` were not run for this section.

**PROVENANCE DIFFERS BY SUBSECTION, and is stated per subsection rather
than once here** — an earlier revision of this preamble attributed the whole
section to one tool and was wrong about its largest part. In summary: the P3
re-solve and ETA figures come from an **uncommitted TypeScript driver
calling the app's own real solver**, not from a Python mask model (see that
subsection for the mechanism and for why the figures are not re-runnable
from this repo as it stands); the conservative-depth cross-check under
"The cliff-driving cell" *is* the design workflow's `pipeline/.venv`
numpy/scipy mask reimplementation, which is where that attribution belongs
and stays. The radius/pinch sweep's own driver was **not re-verified in this
correction pass** — its method is recorded below as the classifier describes
itself, not as a confirmed provenance; re-derive it before building on it.

Figures below are measured for this section **except where they explicitly
cite §0–§7**: the 27-of-528 harbour-pair figure quoted under "Scope limits"
is INHERITED from a maintainer issue comment (§0, §4(b)) and was not re-run
here.

### Positive control

Before trusting any "0 pinch" reading below, the classifier that reports
pinch (mask-level connectivity loss under a candidate `APPROACH_RADIUS_M`)
was checked for a true positive first: swept over all 55 shallow-bearing
plans, radii 0 / 100 / 250 / 500 / 1000 / 1050 m all read **55/55 pinch**.

Those readings do not all carry the same weight, and the distinction matters
because only some of them are evidence. **At R = 0 the 55/55 is a theorem,
not a measurement**, and the derivation is short: snapping happens at the
*requested* gate (§1.4), so no snapped waypoint can sit on a sub-requested
cell; a disc of radius 0 therefore contains no sub-requested cell at all,
licenses no relaxed water anywhere, and every plan that routes only because
relaxation fired — which is what carrying a `shallow` block means, so all 55
— must lose connectivity. **At 100–1050 m it is empirical**: nothing in the
mechanism forces a plan to pinch at those radii, and those readings are
informative precisely because they could have come out otherwise. (An
earlier revision wrote "as it must" across the whole row; that holds only of
the R = 0 column.) It is the empirical columns that license every 0-pinch
row below as informative rather than a classifier that never fires — the
R = 0 column alone could not, because at R = 0 the answer is forced by
construction (the derivation just above), so a classifier correct *only* on
the forced case would still read 55/55 there. The 100–1050 m columns are
what show it firing where the answer was NOT forced. (An earlier revision
named the wrong null hypothesis here — "a classifier hardwired to report
pinch" — which the 0/55 rows at 1060–3704 m already exclude on their own;
the failure a positive control exists to exclude is the opposite one, a
classifier that never fires, and against that the R = 0 column is
insufficient rather than irrelevant.)

### The `APPROACH_RADIUS_M` cliff (§6 item 4, ANSWERED)

Same sweep, continued: 1060 / 1852 / 2400 / 3704 m all read **0/55 pinch**.
The transition sits inside a single **10 m band, 1050→1060 m** — finer than
the ~46 m mask cell size — and lands at the identical band across all three
arms run here (`no-comfort`, `margin-zero`, `relaxation-dense`; per-arm
breakdown below).

**UNRESOLVED CONTRADICTION with §2.3 / §3.1 — flagged, not reconciled.**
§2.3 records **1068 m** as the minimum radius that reconnects
Flensburg↔Marstal at gate 2.3 m, "identical to the global search's answer at
every radius from there up". But 1060 m reads 0/55 pinch here — no plan in
this population loses connectivity 8 m *below* that stated minimum.

**The two figures describe the SAME ROUTE, so a POPULATION difference cannot
explain the gap.** An earlier revision of this paragraph offered one as a
candidate ("the 1068 m route may simply not be among the 55"); it is refuted
by this document's own per-arm split plus two committed files, each link
checkable on its own:

- the 55 split 1 + 27 + 27 across `no-comfort`, `margin-zero` and
  `relaxation-dense` (per-ARM breakdown below), so 54 of the 55 do come from
  the two Marstal-*origin* arms — but the 55th is `no-comfort`'s;
- `app/sweep/sweepArms.ts`'s `no-comfort` arm sets no `originId`, and
  `runArm` reads `arm.originId ?? 'flensburg'`, so that arm is
  Flensburg-origin;
- this section's OWN 2026-08-10 three-arm run settles the identity with no
  cross-run argument needed: of `no-comfort`'s 33 rows, exactly ONE carries
  a `shallow` block — **`marstal`**, at `requestedDepthM 3.0` /
  `usedDepthM 2.3` / `minGateDepthM 2.3`. It is the same run the 55 comes
  from (its three arms give 1 + 27 + 27), so the row and the population are
  read off one run.
  **Why not `app/sweep/README.md`, which names the same row.** Its recorded
  outcome mix does list a `no-comfort/marstal` `ok+shallow` row, but that
  baseline is the 2026-08-07 six-arm run (`dbcd519`), and commit `c359a5c`
  (2026-08-09, #455 / PR #476, `TOLERANCE_M 0.9`) rewrote `mask.bin` and
  `mask.meta.json` BETWEEN the two runs. `sweepArms.ts` reads both files off
  disk and hands the resulting `NavMask` to every `planRoute()` call, so the
  committed mask is an input to each arm just as its settings, wind field,
  `T0` and origin are — and it is the one such input the "never edit an
  existing arm" rule does not govern. Read that README row as corroboration
  from the far side of the rebuild, never as this identity's source.

So `no-comfort`'s 1 IS Flensburg→Marstal, and it is one of the 55; the
0/55 reading at 1060 m therefore includes it reading 0-pinch. The GATE lines
up too: `no-comfort` is `DEFAULT_SETTINGS` with `depthComfortMarginM: 0`, so
its `safetyDepthM` is the 3.0 m default, and 2.3 m is the mask's own
reconnection gate for that pair — `realmask.repro.test.ts`'s
`'Flensburg -> Marstal at DEFAULT_SETTINGS degrades gracefully with shallow
warnings (#53)'` case pins, in one test, the independent oracle
(`cellsConnected(…, 2.3)` **true** and `cellsConnected(…, 2.4)` **false**,
so 2.3 is the flip, not merely a value that works) alongside the solver's
own `requestedDepthM === 3.0` / `usedDepthM ≈ 2.3`. Same route, same
requested gate, and the two radius figures 8 m apart on it.

**Of the two candidates this document enumerated, that leaves ONE standing,
and this pass established it no better than it established the other: the
CRITERIA differ** — reconnection of one named harbour pair at a fixed 2.3 m
gate, against plan-level connectivity loss at each plan's own gate. Say
"of the two enumerated" rather than "the only one": the enumeration was
never shown to be complete, and this section's own preamble records that the
radius/pinch sweep's driver was not re-verified, so a METHOD difference is a
third possibility nobody has excluded. Narrowing the candidate set is not
resolving the conflict, and this one stays **OPEN**. A
third difference is worth recording but is **not** a candidate explanation:
this sweep takes no sample between 1060 m and 1852 m, which limits its
resolution above the cliff but cannot explain a 0-pinch reading *at* 1060 m.
Until both figures are re-derived under one definition, neither should be
the sole basis for choosing R.

**Recommendation: R = 1852 m (1 nm)** — unchanged, and superseding §3.3's
2400–2600 m counter-proposal (marked in place there). Reasons, each with
what it does and does not rest on:

- **~790 m of margin over the 1050→1060 m cliff** — and name that baseline
  explicitly, because it is *not* §3.3's. §3.3 margins against the 1,839 m
  worst-case pocket extent, a **larger and still-live constraint**, against
  which R = 1852 m retains only the **13 m** (1852 − 1839) knife-edge §3.3
  named. Two margins, two constraints, one radius: the larger constraint
  binds, so "~790 m of margin" must never be quoted as this radius's margin
  outright.
- **Why sit at the BOTTOM of the feasible range rather than above it — the
  reconciliation the other three reasons in this list do not supply.** None
  of those three addresses the constraint the bullet above declares binding,
  and without this step a reader is told the pocket-coverage requirement
  binds, told R = 1852 m clears it by 13 m, and given no reason to prefer
  that knife-edge over §3.3's 2400–2600 m band, which was chosen
  *explicitly* as a measured margin over the same worst case and clears the
  same 1,839 m figure by ~561–761 m.
  The two pressures run in opposite directions and both are documented here:
  pocket coverage is a **floor** (R must reach the 1,839 m worst-case
  extent, or a rescued pocket falls outside every disc), while licensing
  restriction pushes **down**, because licensed area scales as R² and a
  larger disc licenses more *distant* sub-gate water — §3.3's 488 cells at
  1852 m against 1,298 at 3704 m, and the measured 1025-vs-996 forbidden-cell
  comparison in the LAST bullet of this list. Of the three radii this
  document has ever PROPOSED as `APPROACH_RADIUS_M` (1852 m, §3.3's
  2400–2600 m band, the original design's 3704 m — the other radii it names
  are sweep samples, not candidates), 1852 m is the smallest that is above
  the floor at all, so it is the one that buys no slack it has to pay for in
  licensing. **State the status of that step
  honestly: it is an ARGUMENT from two documented pressures, not a
  measurement.** Nothing here measures a safety cost of the 561–761 m of
  extra licensing §3.3's band would carry; what is measured is only the
  direction (a larger disc forbids fewer cells, including fewer sub-draft
  ones). The 13 m is thin ON PURPOSE under that argument — which is exactly
  why §6 item 4's acceptance rule, not the roundness of 1 nm, is what holds
  the choice together if the floor ever moves.
- A natural constant (one nautical mile) rather than a fitted
  cliff-plus-delta. This is a TIE-BREAK among radii that already clear the
  floor, never a reason of its own — see the acceptance rule in §6 item 4.
- **On the axes measured at BOTH radii, 1852 m is at least as strict as
  2400 m**: both read 0/55 pinch, and 1852 m forbids more cells from
  relaxation licensing — **1025 against 996** — including more of the
  sub-draft cells (**11 against 9**; denominators in the re-solve
  subsection). An earlier revision claimed it "dominates 2400 m on every
  axis measured here", which over-reaches: the re-solve and the ETA deltas
  below were both measured at **R = 2400 m only**, and since 1852 m forbids
  **29 more cells** than 2400 m does (1025 − 996 — a numerical coincidence
  with the 29-plan subset below, not a relation to it), a clean re-solve at
  2400 m is evidence about the *more permissive* of the two radii and does
  not transfer to 1852 m.

### §4(a), the configuration question (ANSWERED for the DEFAULT and comfort-0 populations)

The maintainer confirmed the route that produced the original #452 complaint
was Flensburg→Marstal at `DEFAULT_SETTINGS` — the first branch of §4(a)'s
open question, and the branch both §4(a) and §6 item 1 say should trigger a
reconsideration of scope rather than an implementation.

**The same response also answers the question AGAINST the premise, and that
half must travel with the first.** The maintainer reproduced the reported
route and found no routing defect: minimum charted depth on the delivered
track **4.10 m**, **zero** cells below the requested gate. The shallow
appearance came from the absolute-depth colour ramp, not from where the
router put the boat — a real but separate concern (`Refs #492`). So the
configuration is now identified *and* the motivating incident did not
reproduce as a relaxation-locality problem. §4(a) is **answered, not
cleared**.

Separately, of the 55 shallow-bearing plans, **29** have a
sub-requested-gate cell lying beyond 2400 m from every waypoint — i.e.
outside even §3.3's rejected, more generous radius.

**Per-ARM breakdown of the 55 — not a tier split of the 29.**
`no-comfort` 1 plan (tier 3), `margin-zero` 27 plans (all tier 3),
`relaxation-dense` 16 plans tier 3 + 11 plans tier 4. Each figure is that
arm's *total* shallow-bearing row count; they sum to 1 + 27 + 27 = **55**,
so they cannot be a split of the 29-plan subset (an earlier revision of this
paragraph presented them as one). Corroborated against `app/sweep/`'s own
committed sources, which were written from a separate instrumented run:
`README.md`'s 2026-08-10 figures (`margin-zero` 27/33, `relaxation-dense`
27/33 rows with a `shallow` block) and `sweepArms.ts`'s arm-role comment
(`margin-zero` "can NEVER produce a tier2/tier4 row by construction";
`relaxation-dense` resolves 11 of its 27 via tier 4 under its TIER-REACH
METHOD, leaving 16). **The 29-plan subset's own tier split is stated nowhere
in this document and was not measured** — it is selected by a distance
criterion that cuts across arms, so it is not derivable from the numbers
above. Left as a gap on purpose.

### P3 safety re-solve — hygiene, not sub-draft mitigation

**METHOD — and it is not what an earlier revision of this document said.**
These figures did not come from the numpy/scipy mask reimplementation. They
come from an untracked TypeScript driver (`run.analyze.ts`) that lived only
in an ephemeral scratchpad and **is not committed**, so **they are not
re-runnable from this repo as it stands** — treat them as a recorded
observation and rebuild the driver before relying on them. What it did: call
the app's own real `planRoute()` (`app/src/routing/planRoute.ts`) against the
real `NavMask` (`app/src/lib/mask.ts`) and the real `polar-genoa.json` /
`polar-fock.json`, reusing `app/sweep/sweepArms.ts`'s own `ARMS` and `T0` so
that wind, settings and departure instant match the sweep's BASE exactly.

**This is a SIMULATION of P3, not P3 — P3 is unimplemented.** The disc was
imposed at the MASK level: for each plan, every cell BOTH farther than
**R = 2400 m** from every snapped waypoint AND below `requestedDepthM` was
forced to LAND in a clone of `mask.bin`, and the real solver was then run
against that modified mask. **That construction bounds what the rows below
prove.** Forbidding cells outright is a different mechanism from P3's
per-cell gate *field*: `findRelaxedDepthM` still searched against a single
scalar gate here, merely over a mask with cells removed, so the run never
exercises §2.3's named P3 trade — a localized `connectedAt` returning a
*lower* connecting gate than the global search would. "0/29 worse
`usedDepthM`" is therefore evidence that removing distant sub-gate water did
not force a deeper relaxation on these plans; it is **not** evidence about
that trade, and §3.2's grafted `minGateDepthM`-regression guard remains
unexercised against the failure mode it was grafted in for.

With that scope stated: re-solving all 29 of the plans above under the
simulated disc, **29/29**
return `status: ok`; **0/29** show a worse (lower) `usedDepthM`; **0/29** show
a worse (lower) `minGateDepthM` — the specific regression §3.2's grafted
guard exists to catch, subject to the bound just stated.

Sub-draft exposure, **with its denominator named**: across these 55 plans
there are **2,044** deduped cells below the requested gate, of which **171**
also read below `BOAT_DRAFT_M` on the conservative mask. 171 is of those
2,044 plan-touched sub-gate cells — it is *not* a count of sub-draft cells
on the mask as a whole, a much larger and different population. (This
cell-set geometry is a distance computation over the same plan set; this
correction pass verified the provenance of the re-solve and ETA figures
above and below, not separately of these counts.) Of those 171 cells,
93.6% lie within 1852 m of a waypoint (inside any
workable disc), so a 1852 m P3 disc excludes 11/171 = 6.4% of them from
relaxation licensing — protection, not elimination. This is structural, not
a tuning accident: at R = 500 m the disc forbids 170/171 of those same
sub-draft cells **and** breaks all 55 plans (the positive-control pinch
above), because the sub-draft cells are the connectivity-critical ones — a
radius small enough to exclude nearly all of them is also small enough to
disconnect nearly every route.

### The cliff-driving cell

The cell pair at lat 54.8502–54.8506, lon 10.5378–10.5385 (conservative
depth 1.8–2.1 m) is Marstal's own approach, and is **the plausible driver of
the 1050→1060 m cliff above — not established as its cause.** An earlier
revision said it "sets" the cliff; nothing measured supports that verb. The
classifier behind the cliff reports whether a PLAN pinches at a candidate
radius — it does not report WHICH cell caused the pinch, so no output of
that sweep attributes the transition to any cell at all. Attributing it
needs exactly one number this pass does not have: **this cell's distance to
the nearest snapped waypoint, which was not measured.** A distance landing
inside the 1050–1060 m band would be a real explanation; any other distance
would refute it. Measure it before repeating the stronger claim.

What *is* independently established about this cell, by a genuinely
different method — the design workflow's `pipeline/.venv` numpy/scipy mask
reimplementation, re-run here as a conservative-depth cross-check — is that
it is the shallowest conservative reading (**1.80 m**) on the delivered
Flensburg→Marstal track. That makes it the most dangerous water in the set
whether or not it also drives the radius transition.

### New residual — South Funen archipelago ETA cost

Re-solving under the simulated disc (same uncommitted driver, same
R = 2400 m, same "this is not P3 itself" bound as the subsection above) is
not free even where it returns `ok` with no depth regression. ETA cost,
worst cases first: Svendborg +6527 s (+108.8 min, recommended rig flips
fock→genoa), Rudkøbing +1691 s, Troense +1567 s, Svendborg +1360 s,
Rudkøbing +1297 s. Those five are the South Funen archipelago tail; the
**median delta is +23 s across all 29 re-solved plans**, not across the
archipelago subset — an earlier revision put "the archipelago population"
and "the population" one clause apart while meaning two different sets, so
state which set each number describes.

Read the deltas for what they are: **the cost of withdrawing relaxation
OUTSIDE the disc, not a regression per se** — the scoped run declines
distant water the user's `safetyDepthM` never asked to be given, and pays
for the detour. Say that precisely rather than as "the cost of honouring the
user's own depth setting", which an earlier revision did and which
overstates it: the simulation forces to LAND only cells that are BOTH
sub-gate AND farther than R = 2400 m from every snapped waypoint, so
sub-gate water INSIDE the disc stays licensed exactly as today. These
deltas are therefore a LOWER BOUND on what honouring `safetyDepthM` outright
would cost — and a loose one, since the honour-it-outright case is R = 0,
where this section's own positive control reads 55/55 pinch: those plans
lose connectivity rather than paying a delta at all. That does not make the
cost small, and it is the honest argument against the scoping premise: P3's
"relax only near the waypoint" does not hold where the whole channel, not
just the approach, is thin water.

### Scope limits of this measurement

Stable across the settings arms exercised (`no-comfort`, `margin-zero`,
`relaxation-dense` — three of the harness's nine) — UNTESTED across
geography and mask rebuilds, since Marstal is the only harbour in this
33-harbour curated set that relaxes at all (§0/§4(b)'s 27-of-528 figure,
INHERITED from a maintainer issue comment and not re-run here; it is the one
place this section quotes §0–§7 rather than measuring). The re-solve
population above is the 2400 m population only (the 29 plans with a cell
beyond that radius): it does not cover the full 55, and it was run at
**R = 2400 m only — never at the recommended 1852 m**, which forbids 29 more
cells. And its driver is uncommitted, so no re-solve or ETA figure here is
reproducible from this repo without first rebuilding that driver.
