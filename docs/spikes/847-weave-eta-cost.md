# Spike #847 — slight course corrections every 2-3 minutes: ETA cost

- **Issue:** #847 "Some routes make slight course corrections every 2-3
  minutes" — Backlog at filing time, `type: bug` / `priority: medium` /
  `area: routing`.
- **Date:** 2026-09-07.
- **Status:** Decision / Recommendation (measurement task only — the issue's
  own triage comment scoped any pickup this cycle to reproduce-and-measure,
  with no solver change authorised).
- **Verdict: on the reproducing case found here, the weave costs
  approximately ZERO ETA (+0.7% of the affected span's duration) against a
  chord VERIFIED navigable at the plan's requested safety depth. This is a
  presentation matter (more waypoints than the passage needs to show), not a
  routing defect.** That verdict is scoped to the ONE reproducing case
  measured below — see "Aperture" (§5) for exactly how far it generalises.
  **#1079 (2026-09-09) WIDENED this measurement** — see §7. The near-zero
  finding held across three route/wind combinations (0.7%, 0.7%, 1.5%, all
  well below #264's large-swing regime), including the FIRST sail-mode
  weave span measured here. The gradient-wind question is NARROWED, not
  closed: the same phenomenon reproduces under a non-uniform (route-scoped
  gradient) field, but that case's own chord is not navigable, so no
  ETA-cost percentage could be honestly computed for it — see §7 for
  exactly what is and is not established.

> Harness: `app/src/routing/realmask.repro.weaveEta847.test.ts` (new file,
> named to match the `realmask.repro*.test.ts` glob so it lands in
> `tsconfig.test.json`'s Node-builtins program without editing any tsconfig
> — see §6 for why that was necessary). Runs against the real committed
> `app/public/data/mask.bin`/`mask.meta.json` and Salona 45 polars via
> `../test/realmaskFixtures`, `planRoute()` as the only entry point, exactly
> the `realmask.repro.*` sibling shape. It is now the sixth file the
> `realmask.repro` filter and CI's regression-bar rule cover (see §6's note
> on CLAUDE.md's "five files since #878" line).

---

## 1. What #847 asks, and what it explicitly forbids

The issue's own body pre-empts the obvious "fix": **"do NOT fix this before
measuring — read #264 first."** #264 already ruled that an apparent zigzag
is often the router motor-tacking around a sail-locked heading band, and is
*faster* — a motor-turn penalty and a heading-continuity tie-break were both
tried and found counter-productive. The issue also names the trap that
produced #264's own opening "32.9% detour" claim: a metric compared against
an INFEASIBLE baseline (a chord crossing land) reads as a defect and points
every downstream fix the wrong way.

So the task is exactly what the triage comment on the issue restates:
**reproduce a specific case, then measure its ETA cost against a
verified-navigable alternative — no solver edit.** `app/src/routing/
postprocess.ts` (`tryMerge`'s collinearity re-validation) and `isochrone.ts`
(the `backtrack` collinear-hop bookkeeping) are both out of scope for this
pickup — named explicitly in the issue and the triage comment as sitting
inside the #282 sweep's transitive input closure, so a change there would
owe a ~31-min-per-arm-set sweep this milestone has not budgeted.

## 2. Reproducing case

**Route:** Ærøskøbing → Søby (`aeroeskoebing` → `soeby`), genoa rig only.
**Wind:** uniform TWS 5.5 kn / wdir 120° (`uniformWindGrid(5.5, 120)`).
**Departure:** `T0 = Date.UTC(2026, 6, 15, 6, 0, 0)` — the `realmaskFixtures`
module's own departure constant, shared with every `realmask.repro.*` file.
**Settings:** `DEFAULT_SETTINGS` (safety depth 3.0 m, `depthComfortMarginM`
2.0, `motorSpeedKn` 6.5, `maneuverPenaltyS` 45).
**Result:** `status: 'ok'`, no `shallow` key (#53 relaxation never fires —
the plan routes entirely at the REQUESTED 3.0 m gate, so nothing here is an
artefact of the relaxed-gate approach-disc mechanism), 13 legs, 7.16 nm,
67.6 min.

Both harbours' committed `approachNote`s name exactly the geometry this
reproduces: Ærøskøbing's is "buoyed approach channel through flats; keep
strictly to the channel, shoals close on both sides" (this is the ORIGIN of
this route). Søby carries no note in the shipped harbour list, but the
destination-end weave measured below sits inside a locally irregular
patch of the real mask nonetheless (§4's positive control shows the DIRECT
chord between the two harbours is blocked by land/shoal, so the boat is
genuinely threading something, not just being indecisive in open water).

Full leg table (from the harness's own run output):

| # | kind/board | heading° | duration | distance (nm) | speed (kn) |
|---|---|---|---|---|---|
| 0 | sail/starboard | 15.0 | 150 s | 0.197 | 4.74 |
| 1 | motor | 345.0 | 75 s | 0.135 | 6.50 |
| 2 | sail/starboard | 355.0 | 75 s | 0.083 | 4.00 |
| 3 | sail/starboard | 65.0 | 75 s | 0.102 | 4.90 |
| 4 | motor | 335.0 | 38 s | 0.068 | 6.50 |
| 5 | motor | 85.0 | 75 s | 0.135 | 6.50 |
| 6 | motor | 325.0 | 300 s | 0.542 | 6.50 |
| 7 | motor | 305.0 | 300 s | 0.542 | 6.50 |
| 8 | motor | 297.5 | 300 s | 0.541 | 6.49 |
| 9 | motor | 293.4 | 2100 s | 3.786 | 6.49 |
| 10 | motor | 274.3 | 150 s | 0.271 | 6.50 |
| 11 | motor | 285.0 | 150 s | 0.271 | 6.50 |
| 12 | motor | 268.4 | 269 s | 0.486 | 6.50 |

Mode sequence: `S(stbd) -> M -> S(stbd) -> S(stbd) -> M -> M -> M -> M -> M
-> M -> M -> M -> M`.

## 3. Heading, mode, or both? — BOTH, at opposite ends of the SAME route

The issue asks explicitly whether the phenomenon is a heading change, a mode
change, or both. On this one reproducing route it is **both, in two
DISJOINT locations**:

- **Near the ORIGIN** (legs 0-4, 0-413 s into the passage): the mode
  sequence sail → motor → sail → sail → motor, each leg 38-150 s. This is
  #354's OWN shape (a motor-sail-motor sandwich, "cost nothing" per
  `isochrone.ts`'s cost function) — #354 is already spiked and deferred
  (`docs/spikes/354-mode-churn.md`, "spike doc + defer", 2026-09-02), so
  this reproduction is not treated as a NEW finding; it is simply this
  route's own instance of an already-triaged, already-deferred phenomenon.
  No ETA measurement is run on this span here — #354's own spike already
  has a measurement methodology for mode churn (its `scratch354.test.ts`
  driver classifies `msmTriples`/`shortSailRuns`), and re-deriving it would
  duplicate that work rather than answer #847's own question.
- **Near the DESTINATION** (legs 10-12, the final 568.9 s before arrival):
  every leg is `kind: 'motor'`, so there is **no mode change at all** here —
  this is a pure HEADING phenomenon: three consecutive motor legs turning
  274.3° → 285.0° → 268.4°, each running 150-269 s. **This is the span
  measured in §4** — it is the cleanest isolation of a heading-only weave
  this route offers, and it is the shape closest to the issue's own
  screenshot description ("the leg from 16:19 onward... slight heading
  change... on what visually reads as one straight passage").

Neither span matches #264's own archetype (large ≥45° swings alternating
motorable/sail-locked arcs with zero mode change) — the origin span changes
MODE, and the destination span's two INTERNAL heading deltas (274.3°→285.0°
= 10.7°, 285.0°→268.4° = 16.6°) are smaller than #264's ≥45° signature,
though larger than the "slight" the issue's prose suggests (that prose gives
no degree figure — the harness's own `findWeaveSpans` detector, described
below, brackets it at 1-45° to stay strictly narrower than #264's regime
while still being non-trivial). A three-leg span has only two internal
transitions; the 19.1° step from the preceding (excluded) leg's 293.4°
heading into the span is the entry into it, not a transition within it, and
is not counted here.

## 4. Measurement: does the destination-end weave cost ETA?

**Method** (reusing #264's own, per the issue's explicit instruction):
compare the weave's actual travel time against a chord from the span's
FIRST waypoint to its LAST, at the span's own average speed, and — before
trusting the comparison at all — verify that chord is navigable at the
plan's REQUESTED safety depth (never the relaxed gate). The harness's
`measureWeaveSpan()` function does exactly this using
`mask.segmentClearanceM()`, the same navigability primitive
`postprocess.ts`'s own `tryMerge` re-validation uses.

**Weave span:** legs 10-12 (headings 274.3° → 285.0° → 268.4°, all
`motor`).

| Quantity | Value |
|---|---|
| Actual duration (span) | 568.9 s |
| Chord distance (span start → span end) | 1.0199 nm |
| Chord navigable at requested depth (3.0 m)? | **YES** — clearance 4.60 m |
| Average speed across the span | 6.500 kn |
| Chord-implied ETA at that speed | 564.9 s |
| **ETA delta (actual − chord)** | **+4.0 s (0.7% of span duration)** |

**Positive control on the navigability check itself** (so a `true` reading
here is not read as "the function always returns true"): the SAME
`mask.segmentClearanceM()` call, run on the WHOLE route's direct chord
(Ærøskøbing → Søby, the two harbour snap points, no intermediate
waypoints), returns **BLOCKED** (`null`) — the direct line between these
two harbours is not navigable, so the boat genuinely has to route around
something, and the function is demonstrably capable of reporting both
outcomes on inputs from this exact scenario.

**Negative control on the weave DETECTOR** (`findWeaveSpans()`, so a
"weave span found" reading is not read as "the detector fires on every
route"): the same detector, run on `docs/spikes/354-mode-churn.md`'s own
R6-control route (Flensburg → Gelting-Mole, TWS 12/wdir 225, chosen there
specifically because "every heading clears the 3.7 kn floor by a wide
margin, so the correct output is all-sail with zero mode changes") reports
**0 weave spans** across its 18 legs.

**Reading the number:** a +0.7% ETA delta over a ~9.5-minute span is, for
practical purposes, zero — well inside the kind of rounding/discretization
noise the isochrone's own ring stepping (300 s full step, substeps down to
37.5 s) would produce even on a route with no real weave. The three
heading corrections here are not costing the passage meaningfully more
time than sailing (well, motoring) the straight line the passage's own
geometry allows; the router is finding a near-time-optimal path and simply
reporting it as more waypoints than a human would draw by hand.

## 5. Aperture — what this measurement can and cannot say

- **One route, one wind cell, one rig — WIDENED by #1079, see §7.** This
  originally mirrored #354's own spike's honesty about its aperture: a
  single reproducing case establishes that the phenomenon EXISTS and CAN be
  near-zero-cost, not that it always is. §7 measured two further
  route/wind combinations (one motor-mode, one sail-mode) and found the
  same near-zero-cost result each time — so the finding is now established
  across three route/wind/rig combinations, not one, but see §7 for what
  is still NOT covered (departure time, both rigs, sail-locked-arc
  motor-tacking specifically).
- **Uniform wind only — NARROWED (not closed) by #1079, see §7.** The
  issue's own screenshot almost certainly comes from a real
  (spatially/temporally varying) Open-Meteo forecast, which this harness
  does not reproduce — the same "narrowed, not closed" evidential gap
  CLAUDE.md's motor-decision-rule bullet already records for #264 (a
  uniform field is not NECESSARY to produce a weave — this reproduction
  shows that again — but is not established to behave IDENTICALLY to a
  gradient field either).
  Gradient wind was tried during this session's exploration (a synthetic
  smooth direction gradient built with `makeWindGrid`, not a real
  Open-Meteo pull) on three other route/wind combinations; it reliably
  produced LARGER heading swings (10-55° between adjacent legs, matching
  #264's shape more than #847's), not the "slight" pattern — so a gradient
  was not what reproduced #847's own reported shape here. That is a
  negative result about those three combinations, not a general claim about
  gradients. **#1079 tried a DIFFERENT gradient construction — a
  route-scoped one, holding the ORIGINAL reproducing route/rig/departure
  fixed and varying only the wind field — and it DID reproduce the same
  destination-approach, all-motor weave shape.** But that case's own chord
  is not navigable at the requested depth, so no ETA-cost percentage could
  be computed for it without repeating #264's own infeasible-baseline
  mistake. See §7 for the full measurement and what it does and does not
  establish — the gradient-vs-uniform ETA-cost question remains OPEN.
- **The reporter's own route was never obtained** (identical caveat to
  #354's spike) — the screenshot's timestamps (16:26, 16:29, 16:31, 16:34,
  16:39) do not correspond to any specific route/wind cell tested here, and
  this reproduction was found by sweeping real harbour pairs against
  several wind cells until a matching SHAPE (short legs, moderate heading
  deltas, near a harbour approach) appeared, not by reconstructing the
  reporter's actual passage.
- **The measured span's 19.1°/16.6° heading deltas are larger than "slight"
  read literally** — the issue's prose gives no numeric bound, and this is
  the largest-delta candidate this session's sweep found that was still
  clearly BELOW #264's regime and occurred with no mode change. A future
  session with the reporter's actual route could find a tighter (single-
  digit-degree) case; this spike does not claim to have found the smallest
  possible instance, only a genuine, representative, measured one.
- **The ETA-cost verdict is per-span, not per-route.** The origin-end
  #354-shaped span was not ETA-measured here (§3) — it is #354's territory,
  already spiked and deferred separately.

## 6. Recommendation

1. **No solver change.** The measured instance costs ~0% extra ETA against
   a verified-navigable baseline — exactly the outcome the issue's own text
   flags as an acceptable, complete finding ("If the ETA cost is
   approximately zero, this is a presentation problem"). Given that #264
   already rejected a motor-turn penalty and a heading-continuity tie-break
   as counter-productive fixes for the SAME general shape (small-swing
   heading noise near a floor/geometry boundary), and #354 already
   deferred every considered mode-churn fix at this milestone's one owned
   constant (45 s), reopening either direction here would need a NEW
   argument this spike does not supply.
2. **If #847 is picked up again for a PRESENTATION fix** (the shape the
   issue itself anticipates as the likely outcome — "the plan is correct
   but rendered as more waypoints than the passage meaningfully has"), that
   is a `postprocess.ts`/`isochrone.ts`-touching change and inherits the
   #282 sweep obligation the issue's triage comment already names. This
   spike does not evaluate any specific presentation-layer fix (e.g.
   loosening `MAX_MERGE_DEG` or the internal `0.5°` collinear-hop anchor) —
   that is future work, not something this measurement-only pickup is
   scoped to recommend.
3. **Keep #847 in Backlog** pending either the reporter's actual route (to
   test whether the destination-approach shape generalises) or a decision
   to fold it into #354's already-open mode-churn ticket for the origin-end
   half of what this spike found.

### Considered and rejected (this session)

- **Treating the weave as proven costly and filing a fix brief anyway** —
  rejected: the measured delta is +0.7%, and the issue's own text names
  exactly this outcome as a complete, acceptable answer. Filing a fix brief
  against a ~0-cost finding would repeat the mistake #264's own history
  warns against (a metric read as a defect that then points every
  downstream fix the wrong way — here the "metric" would be the waypoint
  COUNT rather than a mismeasured distance, but the shape of the mistake is
  the same: treating a rendering artefact as a routing one).
- **Reproducing via a real (non-uniform) Open-Meteo forecast** — not
  attempted: this harness runs offline against committed fixtures only, and
  fetching a live forecast is out of scope for a routing-package test file
  (CLAUDE.md: "Planning requires network; everything else must keep working
  offline"). A synthetic gradient (see §5) was tried as a substitute and
  did not reproduce the reported shape as cleanly as the uniform-wind case
  above did.
- **Measuring the origin-end #354-shaped span's ETA cost too** — deferred,
  not rejected outright: #354 already has its own spike, its own
  measurement methodology, and its own maintainer ruling (defer). Building
  a second, independent ETA measurement for the same phenomenon in this
  document would duplicate that effort rather than extend it; if #847 and
  #354 are ever merged, that measurement belongs in whichever spike survives
  the merge.

### A structural note on how this harness had to be built (§6, referenced above)

The new test file could not be typechecked under `tsconfig.app.json` (the
browser-safe project every ordinary `src/**` file belongs to by default) —
it imports `../test/realmaskFixtures`, which reads the real mask/polars via
`node:fs`, and `tsconfig.app.json` has no `"node"` types. Every existing
file with this same need (`realmask.repro.*.test.ts`,
`legDistanceReconciliation.test.ts`, `polarProvenance.test.ts`, and roughly
twenty more, per `tsconfig.app.json`'s own exclude-list comment) is
individually named in BOTH `tsconfig.app.json`'s `exclude` and
`tsconfig.test.json`'s `include`. Editing either tsconfig file was outside
this task's file allowlist (new files only), so this harness is instead
NAMED to already match the existing `src/**/realmask.repro*.test.ts` glob
(`realmask.repro.weaveEta847.test.ts`) — a zero-config-edit way to land in
the Node-builtins program, at the cost of also joining the population
CLAUDE.md's Verification-lessons section calls "five files since #878" for
the `realmask.repro.*` regression-bar rule. That sentence is now stale by
one — this is reported here rather than silently fixed in CLAUDE.md, which
is outside this task's allowlist and, per CLAUDE.md's own convention, a
main-session act.

## 7. Widening (#1079, 2026-09-09)

#1079 was filed on closing #847 as ANSWERED specifically to widen this
measurement beyond the single Aeroeskoebing -> Soeby / uniform-TWS-5.5 case
above, along the two axes #1079's own body names: more routes, and a
non-uniform (gradient) wind field. Per #1079's explicit scoping, no solver
file (`isochrone.ts`, `planRoute.ts`, `relaxedDepth.ts`, `depthGate.ts`,
`types.ts`, `boats.ts`, anything under `app/public/data/`) was touched;
this is a measurement-only extension of the existing harness
(`app/src/routing/realmask.repro.weaveEta847.test.ts`), same file, three
new `it()` blocks plus the existing negative control. §282's sweep-closure
walk runs OUTWARD from `app/sweep/sweepArms.ts`/`vitest.config.ts` — a new
TEST file that imports closure members does not thereby join the closure,
and this widening added no new file at all, so no #282 sweep is owed.

### 7a. More routes (axis "b")

Two further route/wind/rig combinations were added to the SAME harness,
using the SAME method as §4 (chord ETA vs actual, navigability-gated,
against `mask.segmentClearanceM` at the plan's REQUESTED depth, never the
relaxed gate):

| Route | Wind | Span (kind/board) | Headings | Actual dur | Chord | Navigable? | ETA delta |
|---|---|---|---|---|---|---|---|
| Aeroeskoebing -> Soeby (§4, unchanged) | TWS 5.5/120 | motor, legs[10..12] | 274.3->285.0->268.4 | 568.9 s | 1.0199 nm | YES, 4.60 m | +4.0 s (0.7%) |
| Flensburg -> Glücksburg | TWS 8/60 | motor, legs[2..4] of 8 | 40.0->54.5->40.0 | 525.0 s | 0.9417 nm | YES, 4.90 m | +3.4 s (0.7%) |
| Glücksburg -> Aeroeskoebing | TWS 5/100 | sail/port, legs[31..33] of 35 | 175.0->195.0->175.0 | 337.5 s | 0.4493 nm | YES, 4.10 m | +5.0 s (1.5%) |

Each row's whole-route chord (harbour to harbour, no waypoints) was checked
as a POSITIVE CONTROL on the navigability primitive and reads BLOCKED in
all three cases — the same control §4 already ran, repeated here so a
`chordNavigable: true` reading on the SPAN cannot be dismissed as "the
function always returns true for this data".

The Flensburg -> Glücksburg case widens the STRUCTURAL shape too: its span
sits at legs[2..4] of 8, not the route's final legs — this is a MID-ROUTE
weave, not a harbour-approach one, which rules out "the phenomenon is
specific to harbour-approach geometry" as a necessary condition. The
Glücksburg -> Aeroeskoebing case is the first SAIL-mode (not motor) weave
span measured in this file — `kind: 'sail'`, `board: 'port'` throughout,
so the near-zero-cost finding is not specific to motor legs either.

**What this establishes**: across three route/wind/rig combinations (one
of which is a repeat rig — all three are genoa; see "still open" below),
spanning both `kind: 'motor'` and `kind: 'sail'` weave spans and both
harbour-approach and mid-route positions, the ETA cost measured this way
stayed in a 0.7%-1.5% band — an order of magnitude below anything that
would read as a routing defect, and consistent with §4's original verdict
generalising rather than being a one-off.

**What this does NOT establish** (still open, unchanged by this widening):
the reporter's own route/departure was never obtained (§5's caveat stands);
only the genoa rig was exercised (the fock rig's polar could in principle
produce a differently-shaped weave at the same wind cell); only ONE
departure time (`T0`) was used per case; and §3's origin-end #354-shaped
mode-churn span was again not ETA-measured (still #354's own territory, by
the same reasoning §6 already gave).

### 7b. Non-uniform wind (axis "a")

§5's own aperture note already recorded that a synthetic gradient built
with `makeWindGrid`, scaled over the WHOLE forecast domain, had been tried
on three OTHER route/wind combinations and reproduced #264's large-swing
shape rather than #847's slight one — a negative result about a
domain-scale gradient, not about gradients generally. #1079 tried a
DIFFERENT gradient construction instead: the SAME `makeWindGrid` primitive,
but scaled to the REPRODUCING route's OWN ~13 km bounding box (lat
54.85-54.98, lon 10.20-10.45 — padded slightly beyond the two harbours),
centred on the ORIGINAL reproducing wind cell (TWS 5.5/wdir 120) with a
modest, physically-plausible spread across that span (speed 5.0-6.0 kn,
direction 110-130 deg) — the same route-scoping technique
`app/scripts/gen-docs-wind-fixture.mjs` already uses to make a gradient
visible across a route this short (`docs/spikes/847-weave-eta-cost.md`
itself is not that script's target; the technique is reused, not the
script). This isolates the wind-field-construction variable by
CONSTRUCTION: same origin, same destination, same rig, same departure —
ONLY the wind grid changes from `uniformWindGrid(5.5, 120)` to this
gradient.

**Result** (`app/src/routing/realmask.repro.weaveEta847.test.ts`, the
"ROUTE-SCOPED GRADIENT" case, run 2026-09-09): the plan still resolves
`status: 'ok'` with no `shallow` key (§53 relaxation still does not fire),
now 9 legs / 7.10 nm / 67.0 min (vs the uniform case's 13 legs / 7.16 nm /
67.6 min — a materially different path, as expected once the wind field
changes). A weave span is STILL found, ending at the route's final leg,
STILL entirely `kind: 'motor'`:

```
legs[5..8]: headings 287.9 -> 268.1 -> 288.1 -> 270.4, all motor
  actual duration:  721.7 s
  chord distance:   1.2866 nm
  chord navigable (requested depth): FALSE (BLOCKED)
  avg speed in span: 6.500 kn
  chord-implied ETA (if it were trustworthy): 712.6 s
  (uncomputed) ETA delta: +9.1 s (1.3% of span duration)
```

**The span's own chord is NOT navigable at the plan's requested depth.**
This is exactly the infeasible-baseline shape CLAUDE.md's Verification
lessons warn about (the same class that opened #264's own "32.9% detour"
mistake): treating the 712.6 s chord-implied ETA as a trustworthy baseline
and reporting "+1.3%" would be using a straight line that the mask itself
says is not navigable — the boat cannot actually travel that chord at 3.0
m, so the comparison would be meaningless even though the arithmetic is
correct. The harness therefore does NOT assert or report an ETA-cost
percentage for this case; it asserts the STRUCTURAL reproduction (weave
span present, ends at the last leg, all-motor) and asserts
`chordNavigable === false` explicitly, so a future mask or solver change
that makes the chord navigable would be caught (the assertion would then
need updating to compute and check a real percentage), rather than the gap
staying silently unnoticed.

**What this establishes**: the destination-approach, all-motor weave shape
§4 measured under uniform wind is NOT an artefact of the uniform field —
the same shape reproduces under a route-scoped, physically-modest spatial
gradient, holding everything else fixed. This directly answers the
"reproducible under non-uniform wind?" half of #1079's question: yes.

**What this does NOT establish, and must not be read as establishing**:
whether the weave costs MORE, LESS, or the SAME ETA under gradient wind as
under uniform wind. The one honest number this case produced (+9.1 s /
1.3%, computed but never asserted) is HIGHER than any of the three uniform
cases in §7a (0.7%, 0.7%, 1.5%) — but that comparison is not licensed: the
gradient case's own chord is infeasible, so its "1.3%" is measured against
a baseline the boat cannot actually sail, exactly the comparison this
whole methodology exists to refuse. Stating "gradient costs more" from
this one uncomputed number would be the SAME mistake #264 opened with, one
level removed. CLAUDE.md's motor-decision-rule bullet already records the
broader gradient-vs-uniform evidential gap as "narrowed, not closed" (one
real Open-Meteo forecast measured a differently-shaped weave under a
gradient — more turns, more legs, more total ETA — without establishing
that the gradient CAUSED any of it). This session's result is consistent
with that framing and narrows it further in one respect (the SAME
phenomenon, not just weaving in general, reproduces under a gradient) while
leaving the ETA-cost comparison exactly as open as it was.

### 7c. Summary: what #1079 widened, precisely

- Route/wind/rig axis: widened from 1 to 3 combinations, spanning both
  motor and sail weave spans and both mid-route and destination-approach
  positions; near-zero ETA cost held in all three (0.7%-1.5%).
- Wind-field-construction axis: the SAME reproducing route/rig/departure
  was re-run under a route-scoped gradient instead of a uniform field; the
  weave phenomenon reproduces, but the resulting span's chord is not
  navigable, so the ETA-cost question for THIS axis remains open — narrowed
  (phenomenon confirmed gradient-reproducible) but not closed (cost
  comparison unavailable).
- Still not attempted: a live Open-Meteo forecast (this harness runs
  offline against committed fixtures by design — CLAUDE.md: "Planning
  requires network; everything else must keep working offline" — a
  routing-package `*.test.ts` fetching a live forecast would violate that);
  the fock rig; more than one departure time; and a gradient construction
  whose span DOES yield a navigable chord (which would need either a
  different bounding box or a different weave span to isolate — not
  attempted here, since constructing one specifically to get a navigable
  chord risks selecting for the answer rather than measuring it).
- No solver file was touched, and no #282 sweep is owed (no production
  module and no `DEFAULT_SETTINGS` field were edited; only the existing
  measurement-only test file grew three new `it()` blocks).
