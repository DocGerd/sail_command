# Spike #455 — the depth mask reads deeper than its own conservative option

- **Issue:** #455 (`type: bug`, `priority: high`, `area: routing`, `area: pipeline`, milestone v0.12.0)
- **Date:** 2026-08-09
- **Status:** Decision / Recommendation
- **Verdict:** **The defect is real and the issue's own headline number is
  measuring the wrong artefact. Fix it in the pipeline by tightening
  `TOLERANCE_M` from 2.0 m to 0.9 m — the largest reduction that leaves
  `verify_mask.py`'s connectivity gate bit-for-bit unchanged, and the value at
  which "the app calls a cell navigable while the cautious reading of the same
  source puts it under the 2.1 m keel" becomes impossible BY CONSTRUCTION
  (measured: 924 such cells today → 0). Zero payload cost, no new invariant, no
  second channel. The issue's stated blocker — that removing the optimism
  strands Aabenraa — does NOT reproduce and is an artefact of a snapping
  convention the app does not use; the harbour that actually breaks under a
  fully conservative build is Marstal, which already carries an exception.**

> Companions: [`245-depth-mask-resolution.md`](./245-depth-mask-resolution.md)
> (why the 46 m grid is source-limited) and
> [`244-buoyed-fairways.md`](./244-buoyed-fairways.md). #245 and this spike both
> land on the same Aabenraa knife edge from opposite directions — §3.4.

---

## 0. How to reproduce every number in this document

Every figure below was computed in this session from files already on disk: the
gitignored `pipeline/data-src/` cache (`emodnet_dtm.tif`,
`land-polygons-split-4326.zip`, `schlei_relation.geojson.json`) and verified
copies of the committed `mask.bin` / `harbors.json`, read with
`pipeline/.venv` (numpy 2.5.1, rasterio 1.5.0, geopandas 1.1.4). Nothing is
carried over from the issue body, and nothing came from a summarising fetch.
Scripts live in `/tmp/s455/` (`recompute.py`, `runB`–`runI`); the repo was not
written to except for this file.

**Artifact identity, checked rather than assumed.** `git hash-object` on the
`/tmp` copies returns `736710f5…` (`mask.bin`) and `00fd2f3f…`
(`harbors.json`), matching the index entries exactly — so every byte-level
claim below is about the committed blobs.

**Fidelity control.** A scratch re-implementation of `build_mask.py`'s exact
`max`/`bilinear`/`TOLERANCE_M = 2.0` blend, land raster and Schlei carve
reproduces the committed `mask.bin` **byte-identical — 0 differing bytes of
5,280,000**. Everything this document says about a conservative or
differently-tuned mask was produced by that same code path with only the
resampling or the tolerance changed, so the comparisons are like-for-like.

**Distinctness, and a disagreement that had to be resolved first.** Three runs
in three separate processes: run A (2-D float arrays), run B (flat 1-D,
integer decimetres, a fresh rasterio session per resampling), run C (encoder
parameterised by arithmetic precision). Runs A and B **disagreed** — B
reproduced the committed mask on all but **330 bytes** and put the headline
count 1,295 cells higher. Run C isolated the cause: **B cast the elevation
field to float64 before the `*10` / `floor`, and `build_mask.py` quantises in
float32.** Float64 quantisation differs from the shipped encoder on 330 of
5,280,000 bytes (0.0063%), and on **2,049 bytes** of the conservative
encoding. Run A's float32 path is the pipeline's path; run C reproduces run
A's arrays exactly. **Agreement between A and C is therefore convergence
across distinct formulations, not one reading taken twice** — which is exactly
what had to be established before any figure could be quoted.

That accident is worth keeping: a depth encoder that `floor()`s at decimetre
boundaries is sensitive to the precision it floors in, and two honest people
recomputing "the same" conservative mask can differ by ~2,000 cells for no
other reason.

---

## 1. The question

#455 reports that `pipeline/build_mask.py` prefers a **bilinear** reprojection
of the EMODnet source over a **`Resampling.max`** one wherever the two agree
within `TOLERANCE_M = 2.0` m, and that this makes the shipped mask read
*deeper* than the conservative option over a large fraction of the water area —
so a route can cross water the cautious reading puts below the user's safety
depth while `PlanResult.shallow` is absent and zero legs carry a `shallow`
field. The issue is explicit that this is **not** #452: #452 is the #53
relaxation applying `usedDepthM` globally, which at least *tells* you; this one
needs no relaxation, fires at `DEFAULT_SETTINGS`, and is **silent**. The spike
was asked to reconcile a headline figure that failed an independent recount
(48.35% vs 45.08%), decide whether the optimism can be removed at all, and pick
a direction.

---

## 2. What is actually true

### 2.1 The mechanism, confirmed

`build_mask.py:156-163` blends: `use_bilinear = both_valid & (|bilinear − max|
≤ TOLERANCE_M)`. Measured: **`use_bilinear` is true on 93.93% of the grid and
99.09% of shipped-water cells** — reproducing the issue's 93.9% / 99.1%
exactly. `Resampling.max` on LAT-referenced *elevation* picks the shallowest
contributing source cell, so preferring bilinear is what introduces the
optimism. The encoder at `:241` then floors: `np.floor(depth_m * 10.0)`, with
the comment *"floor: never overstate depth"*.

### 2.2 The authoritative numbers — basis stated, never bare

**Basis for everything in this table:** the **encoded byte**, decoded the way
the app decodes it (`app/src/lib/mask.ts:34` — `0 → 0 m`, `255 → 25.4 m`, else
`b/10`), shipped-blended vs a pure-`Resampling.max` build of the same source
through the same encoder. "Water" is the app's own test (`b !== LAND`), i.e.
shipped byte ≠ 0. Gaps are computed in **integer decimetres** so no float
subtraction can inflate a bucket boundary.

| Quantity | Measured |
|---|---|
| Water cells (shipped byte ≠ 0) | **2,646,047** |
| Cells the shipped mask reads **deeper** than conservative | **1,192,923 = 45.0832%** |
| Cells the shipped mask reads **shallower** than conservative | **259,861 = 9.8207%** |
| Overstatement: max / mean / median / p99 | **2.0 m** / 0.3053 m / 0.2 m / 1.6 m |
| ≤ 0.5 m / ≤ 1.0 m / > 1.5 m | 84.9124% / 95.2863% / **15,806 cells** (0.5973% of water) |
| Byte 254 occurrences (shipped / conservative) | 0 / 0 |
| Byte 255 occurrences (shipped / conservative) | 309,021 / 301,875 |

The `2.0 m` maximum is not an empirical curiosity — it is exactly
`TOLERANCE_M`, which is the hard bound the blend's own comment at `:149-151`
predicts. That agreement is an independent confirmation that the mechanism in
§2.1 is the whole mechanism.

**Quote the 9.82% alongside the 45.08%.** The mask is not uniformly optimistic:
on 259,861 water cells it is *more* cautious than pure `max`. A write-up that
omits this paints a distorted picture of the artefact.

### 2.3 The safety figures — the ones that decide anything

Against `DEFAULT_SETTINGS.safetyDepthM = 3.0` (`app/src/types.ts:68`) and
`BOAT_DRAFT_M = 2.1` (`app/src/routing/relaxedDepth.ts:9`):

| Quantity | Measured |
|---|---|
| Cells navigable at 3.0 m on the shipped mask | **2,473,845** |
| …whose conservative reading is below **3.0 m** | **14,715 (0.5948%)** |
| …below the **2.1 m boat draft** | **924 (0.0374%)** |
| …below 1.5 m | **76** |
| …that a pure-`max` build would encode as LAND | **0** |
| Shallowest conservative reading among them | **1.0 m** at 55.1240 N 10.8949 E, where the shipped mask reads exactly 3.0 m |
| Largest overstatement among them | **2.0 m** |
| Cells reading exactly 3.0 m (byte 30) — zero margin | **6,579** |

The `0` in row five matters: none of this depends on the OSM land raster or the
Schlei carve, so the land-data half of the pipeline is not implicated.

Locality, so this is not read as spread evenly: inside a Flensburg Fjord window
(54.72–54.92 N, 9.4–10.05 E) there are **1,521** such cells — reproducing the
issue's figure exactly — the shallowest being **54.8490 N 9.7051 E, shipped
3.0 m, conservative 1.1 m**. The densest 0.05° bin is 54.85–54.90 N /
10.50–10.55 E with **301 cells**, minimum conservative **1.3 m**.

### 2.4 Why the issue's 48.35% differs — and why it is the wrong number here

The issue's headline (1,279,478 cells, 48.35%) **reproduces exactly**, so it is
not a slip. It measures a different thing:

| Predicate | Cells | % of water |
|---|---|---|
| Encoded byte: shipped decodes deeper than conservative — **authoritative** | **1,192,923** | 45.0832% |
| Raw metres: any difference at all, unthresholded | 1,999,435 | 75.5631% |
| Raw metres: difference > 0.05 m — **the issue's figure** | 1,279,478 | 48.3543% |
| Raw metres: difference ≥ 0.05 m | 1,279,478 | 48.3543% |
| Raw metres: `round(diff, 1) ≥ 0.1` | 1,279,478 | 48.3543% |
| Raw metres: `round(diff × 10) ≥ 1` | 1,279,478 | 48.3543% |
| Raw metres: `floor(diff × 10) ≥ 1` — the pipeline's own quantiser | 932,695 | 35.2485% |

Five mathematically distinct spellings of "rounds to at least one decimetre"
give the identical 1,279,478 (the `>` and `≥` forms agree because **exactly 0**
cells sit at a raw difference of precisely 0.05 m — measured, not assumed). The
threshold is sharp rather than fitted: `> 0.049` gives 1,289,119 and `> 0.051`
gives 1,270,182, about 9,600 cells per millimetre.

**So the issue's number applies round-to-nearest semantics to a pipeline built
on round-down semantics.** It is a statement about the intermediate float32
field, which the app never sees — the router only ever reads a uint8 byte and
decodes it.

**The compounding error, and the one that matters: the two sets are not
nested.** Measured over the 2,646,047 water cells:

| | in the issue's raw-0.05 set | not in it |
|---|---|---|
| **overstated on the encoded byte** | 1,055,062 | **137,861** |
| **not overstated** | 224,416 | 1,228,708 |

(Sums check: 1,055,062 + 137,861 = 1,192,923 and 1,055,062 + 224,416 =
1,279,478.) The *higher* headline therefore **misses 137,861 cells (11.6% of
the real overstated set)** that the app genuinely reads as deeper. Mechanism:
`floor()` at a decimetre boundary turns a sub-millimetre raw difference into a
full 0.1 m difference in the shipped bytes. Worked instance at
**55.2935 N 9.8222 E** — raw blend 3.0128 m vs raw max 2.9936 m, a raw
difference of **0.0192 m** the issue's predicate discards, yet the app reads
**3.0 m** (navigable at the default gate) where the conservative encoding reads
**2.9 m** (not navigable). **195 of the 14,715 gate-crossing cells (1.33%) are
invisible to the issue's predicate for exactly this reason.**

Reading 48.35% as a cautious upper bound on 45.08% is therefore wrong in the
dangerous direction. Do not swap one percentage for the other and move on:
**quote a figure with its basis clause or not at all**, because the next person
will re-derive it differently and disagree again — which is what happened here.

### 2.5 Basis-invariance: real, narrow, and not generalisable

The two safety counts in §2.3 are basis-invariant, and that was verified rather
than assumed: the raw-metre gate gives **14,715** as well. The reason is exact —
3.0 m is a whole decimetre and `floor(d × 10) ≥ 30 ⟺ d ≥ 3.0`.

It is **not** a general property, and it is not even fully clean at 2.1 m:

- Probed at 2.15 m, 2.75 m and 3.05 m the two bases **diverge** (e.g.
  2,467,266 vs 2,470,558 navigable at 3.05 m). A user-set `safetyDepthM` that
  is not a whole decimetre has no such invariance.
- At the draft the counts differ by **one cell**: encoded gives **924**, raw
  gives **925**. Cause, isolated: in float32, `2.0999999 × 10.0` rounds to
  exactly `21.0`, so `floor` yields byte 21 = 2.1 m while the same value
  compared in float64 metres is still below 2.1. Quote **924** with its basis;
  do not present the pair as identical.

### 2.6 Three further corrections to the issue body

Not material to the decision, recorded so the numbers are not re-inherited:

| Issue says | Measured (encoded basis) | Cause |
|---|---|---|
| `55.0343, 9.4276` conservative **2.5 m** | **2.4 m** (raw 2.4838) | raw metre rounded, not floored |
| `54.8490, 9.7051` conservative **1.2 m** | **1.1 m** (raw 1.1700) | same |
| shallowest conservative among navigable-at-3.0: **1.1 m**; largest overstatement **1.99 m** | **1.0 m** and **2.00 m** (raw: 1.0656 m and 1.9999 m) | table mixes raw-metre values into a row set that is otherwise encoded-consistent |

The `54.8780, 10.0752` cell (**3.5 m / 2.3 m**) reproduces exactly. The densest
cluster reproduces at 301 cells; the two neighbouring bins differ (issue
267 + 258, measured 260 + 265) with an **identical total of 525**, i.e. seven
cells assigned across the 10.50 °E bin edge — a binning convention difference.
A float32-vs-float64 quantisation hypothesis for that discrepancy was tested
and **refuted** (both precisions give 301 / 265 / 260). Cause unresolved,
immaterial.

---

## 3. The conflict — and it does not survive measurement

The issue's reason for not simply removing the optimism is that it is
load-bearing for connectivity: *"removing the optimistic cells disconnects 26
harbour pairs, all Aabenraa."* Everything downstream of that claim (including
the whole rationale for shipping a second channel rather than fixing the data)
rests on it.

### 3.1 The comparison target is reachable — checked first

Before measuring what a change *removes*, the baseline was confirmed to be
something. On the shipped mask, 4-connected, at each harbour's own gate
(`CONNECTIVITY_EXCEPTIONS_M` honoured — `augustenborg` 2.8 m, `marstal`
2.0 m): **28 of 33 harbours connect**, the five not connecting being exactly
`verify_mask.py`'s `KNOWN_DISCONNECTED` set (`arnis`, `dyvig`, `graasten`,
`kappeln`, `maasholm`), seed component **2,460,910 cells**. That is the
documented status quo, and `verify_mask.py` exits 0 on it. Re-derived from
three different seeds — `verify_mask.py`'s own (54.8455, 9.5216), a Kiel Bight
edge (54.55, 10.30) and a southern Little Belt point (55.10, 9.85) — all three
give the identical component size and the identical exclusion list.

At uniform gates, 351 of 528 harbour pairs connect at 3.0 m with **zero snap
failures**, so pair counts below are measured against a live baseline.

### 3.2 The 26 pairs reproduce — under a convention the app does not use

Counterfactual: navigable = shipped-navigable **and** conservative ≥ gate.

| Gate | Baseline pairs | Lost, **fixed-snap** | Lost, **re-snap** |
|---|---|---|---|
| 3.0 m | 351 | **26** (all Aabenraa) | **0** |
| 2.5 m | 351 | 26 (all Aabenraa) | **0** |
| 2.1 m | 378 | 27 (all Marstal) | 27 (all Marstal) |

The issue's 26 reproduces **exactly**, including that every one involves
Aabenraa — but only if you keep the shipped snap cell and ask whether it
survives the cut. `planRoute` does not do that: it re-runs
`snapToNavigable` (`planRoute.ts:281-289`) against whatever mask it holds.
Under re-snapping, Aabenraa's snap moves from cell (1762, 37) to (1762, 38) —
**46.3 m, one cell east, well inside the 300 m budget** — onto a cell reading
shipped 3.5 m / conservative 3.0 m, navigable under both. Both figures are
correct about their own convention; only the re-snap one describes the app.

### 3.3 A fully conservative build breaks Marstal, not Aabenraa

Stronger, and independent of the snapping question: rebuild the mask
end-to-end with pure `Resampling.max` and put it through `verify_mask.py`'s own
gate. **Aabenraa connects. Marstal does not.**

- Under a pure-max build, **Aabenraa reconnects at any gate ≤ 3.0 m** — i.e. at
  the default, unchanged.
- **Marstal reconnects only at ≤ 1.8 m**, against its current
  `CONNECTIVITY_EXCEPTIONS_M` entry of **2.0 m** — a 0.2 m shortfall, on a
  harbour whose own source text (quoted in `verify_mask.py`) says *"parts of
  the yacht basin only approx 2 m"*.
- `Augustenborg` reconnects at ≤ 3.0 m, comfortably inside its 2.8 m exception.
- None of the five `KNOWN_DISCONNECTED` harbours reconnects, so no entry goes
  stale.

Three independent measurements — the re-snap counterfactual, the pure-max
rebuild, and the per-harbour gate scan — agree that Aabenraa is not the
blocker. **The issue's crux argument is refuted, not merely doubted.**

### 3.4 The Aabenraa knife edge is real, and it is #245's — same cell, different mechanism

What *is* true is the fragility #245 §2.3 already recorded and nobody has
closed. Measured on the shipped mask: **Aabenraa's snap cell reads exactly
3.0 m against a 3.0 m gate — margin 0.0 m — and its conservative reading is
2.4 m, a 0.6 m gap.** `Augustenborg` sits at margin 0.0 m too (2.8 m against
its 2.8 m exception, gap 0.0 m). No other harbour is inside 0.25 m of its gate.

**Is it the same mechanism as #245? No — same cell, same missing decimetre, two
different causes, and they are independent.** #245 measured that *refining the
grid* drops Aabenraa's snap cell from 3.0 m to 2.9 m at 23 m and 2.8 m at 12 m,
because a finer cell stops borrowing depth from a larger footprint. This spike
measures that *the blend* is contributing 0.6 m at that same cell, because
bilinear smoothing is trusted there. One is a resampling **footprint** effect,
the other a resampling **method** effect. Either alone is enough to move the
harbour across its gate. That is the honest reading of why this cell keeps
appearing: it has no margin at all, so every data decision in the pipeline
resolves through it.

**Consequence for the recommendation:** any change to the blend re-opens
`CONNECTIVITY_EXCEPTIONS_M`, exactly as #245 established for a resolution
change. Those thresholds were derived by scanning gate depths *against the
2.0 m-tolerance 46 m mask*; they are tolerance-coupled constants, not
properties of the water.

---

## 4. Directions considered

**Provenance note, stated because it changes how much weight each section
carries.** Directions 1 and 2 were costed by a separate costing pass and put
through an adversarial refuter; Direction 1's refuter returned **REFINED** and
that verdict is reported as given. **Direction 2's refuter verdict did not
reach this write-up** (the input was truncated mid-sentence in its residual-risk
list) — it is reported as *verdict not transmitted*, and is **not** upgraded to
a pass on that account. Directions 3 and 4 had no refuter pass at all; their
costs were measured here directly, and they are flagged as such.

### 4.1 Direction 1 — disclose only

No data change, no routing change. Add the bound to the About dialog's
`about.caveats` list, a depth-profile caption, README, `SECURITY.md` and the
assurance case. Nine files, effort **M**, zero bytes under `app/public/data`,
~1.3 KB of new i18n string literals shipping to every user.

Zero harbours stranded and zero route change, both **by construction** rather
than by sweep: `mask.bin` is bit-identical, no `DEFAULT_SETTINGS` value moves,
and `app/src/routing/*.ts` imports no i18n or dictionary at all (verified: a
grep for `i18n|dict\.` over `app/src/routing/` returns zero files), so a copy
change cannot reach the solver.

**Refuter verdict: REFINED.** Its cost/no-change half survives; its *drafted
copy* does not. Three findings, all of which stand:

1. The draft paired "about 45% of water cells" (encoded basis) with "0.31 m on
   average" — and 0.31 m belongs to neither the encoded set (**0.3053 m**) nor
   the raw set (**0.2056 m**) cleanly. Measured here: the mean raw difference
   *over the encoded overstated set* is **0.2954 m**; the mean encoded gap over
   the *issue's* set is **0.2739 m**. Four defensible means, none
   interchangeable. A safety disclosure that mixes bases inside one sentence
   reproduces, in the copy meant to prevent it, the exact defect the spike is
   about — and it freezes into a released CHANGELOG.
2. It omitted the only figure that would change a reader's behaviour: **924
   cells the app calls navigable at default settings read below the hull.**
3. "Up to 2.0 m optimistic" bounds the gap *between two readings of one
   EMODnet product*. A user can read it as a margin against the real seabed,
   which it is not — the seabed may be shallower than either reading. Copy that
   attaches a precise number to the wrong quantity manufactures false
   confidence.

The refuter's own claim that the encoded basis "makes the defect look ~40%
smaller" is itself worth a caveat: at 75.56% the unthresholded raw figure is
larger, but it counts sub-millimetre differences the app cannot represent. The
right response is a stated basis, not the largest number.

### 4.2 Direction 2 — ship a second conservative channel and warn where they disagree

Emit `mask.cons.bin` (a pure-`max` encoding, same grid) beside `mask.bin`;
navigability stays decided by the blended channel; warn where
`conservative < requestedDepthM ≤ shipped`. Effort **L**: ~15 pipeline lines,
but five `NavMask` construction sites, a second transferred buffer in the
worker init path, a new accessor that must bound-check `mask.meta` first, and a
divergence pass that has to run on **every** plan (today `flagShallowLegs` runs
only inside the #53 relaxation tiers — `planRoute.ts:521/531/543`, which is
precisely why the defect is silent).

The costing pass's central design finding is confirmed by my own region-wide
measurement: **only the gate-crossing predicate is usable.** A magnitude
threshold fires on 1,192,923 water cells at ≥ 0.1 m (45.08%), 234,091 at
≥ 0.5 m (8.85%) and 70,664 at ≥ 1.0 m (2.67%) — a warning on most of the chart.
The gate-crossing predicate is 14,715 cells (0.5948% of navigable) and is
**stable across gates**: 0.5191% at 2.1 m, 0.5948% at 3.0 m, 0.6140% at 3.5 m,
0.7375% at 10.0 m, so raising your safety depth does not produce a wall of
warnings.

Payload, measured (GNU `gzip` CLI, the convention #245 uses):

| Encoding | Raw | gzip-9 | Verdict |
|---|---|---|---|
| `mask.bin` today | 5,280,000 | 1,346,789 | baseline |
| **Conservative channel** | **+5,280,000** | **+688,655** (gzip-6: +697,611) | viable |
| Delta channel (dm, +128 offset, range −20..+20) | +5,280,000 | +906,172 (zlib-9) | **worse** than shipping the channel outright |
| 1-bit "divergence ≥ 0.1 m" bitmap | +660,000 | +258,378 (zlib-9) | encodes the noisy predicate |
| 1-bit "crosses the 3.0 m gate" bitmap | +660,000 | **+18,917** (zlib-9) | 36× cheaper — and architecturally excluded |

The conservative channel compresses to roughly half of `mask.bin` because
max-resampling is piecewise-constant over source pixels and therefore blockier.
Against the 32,840,586 B of `app/public/data` it is **+16.08% raw** — taking
the SW precache past the "~33 MB expected" that `app/vite.config.ts:384`
documents. The gate bitmap is by far the cheapest thing that would work and is
**refused for a stated reason**: it bakes one gate into the data, and
navigability is decided at query time from a user setting.

**Refuter verdict: not transmitted** (see §4 preamble). Two costing-pass
residual risks are independently confirmed here and are decisive on their own:
this direction **does not fix anything** — the router still plans through the
optimistic cells and still prefers them via the #243 comfort preference — and
its rationale over Direction 3/4 rests on the Aabenraa claim that §3 refutes.

### 4.3 Direction 3 — rebuild the mask conservatively (pure `Resampling.max`)

Measured here directly; no refuter pass.

| | Shipped (T = 2.0) | Pure max |
|---|---|---|
| Water cells | 2,646,047 | 2,630,134 |
| Overstated vs `max` | 1,192,923 (45.08%) | **0** |
| Navigable at 3.0 m | 2,473,845 | 2,461,522 (−12,323) |
| Gate-crossing cells | 14,715 | **0** |
| Harbours connected (own gates) | 28/33 | **27/33** |
| `verify_mask.py` | exit 0 | **NON-ZERO — `marstal`** |

It is the only direction that removes the defect completely, at **zero payload
cost** (same dims, same encoding; the artifact is a drop-in replacement). It
fails on one harbour: Marstal reconnects only at ≤ 1.8 m against its 2.0 m
exception (§3.3). An "intersect at the gate" variant —
`min(shipped, conservative)`, the strictly-safe pointwise combination — behaves
identically on connectivity (**27/33, Marstal**) while additionally needing
Direction 2's second channel to be shipped at all, so it is dominated.

### 4.4 Direction 4 — tighten `TOLERANCE_M`

Measured here directly; no refuter pass. Rebuild end-to-end at a range of
tolerances and put each through `verify_mask.py`'s own gate (4-connected flood
fill from the fixed seed, each harbour at its own gate, checking **both** new
disconnections and stale `KNOWN_DISCONNECTED` entries):

| `TOLERANCE_M` | Water | Overstated | Navigable @3.0 | Gate-crossers | **Below 2.1 m draft** | `verify_mask.py` |
|---|---|---|---|---|---|---|
| **2.0 (shipped)** | 2,646,047 | 1,192,923 (45.08%) | 2,473,845 | 14,715 | **924** | exit 0 |
| 1.8 | 2,645,314 | 1,186,499 (44.85%) | 2,473,571 | 14,419 | 794 | exit 0 |
| 1.6 | 2,644,499 | 1,177,949 (44.54%) | 2,473,218 | 14,025 | 642 | exit 0 |
| 1.5 | 2,644,006 | 1,172,557 (44.35%) | 2,472,943 | 13,724 | 534 | exit 0 |
| 1.4 | 2,643,495 | 1,166,377 (44.12%) | 2,472,642 | 13,398 | 421 | exit 0 |
| 1.2 | 2,642,181 | 1,149,901 (43.52%) | 2,471,939 | 12,613 | 214 | exit 0 |
| 1.0 | 2,640,738 | 1,125,867 (42.63%) | 2,471,014 | 11,529 | 37 | exit 0 |
| **0.9** | **2,639,957** | **1,109,507 (42.03%)** | **2,470,330** | **10,746** | **0** | **exit 0** |
| 0.8 | 2,639,084 | 1,089,103 (41.27%) | 2,469,569 | 9,904 | 0 | **NON-ZERO — `marstal`** |
| 0.7 | 2,638,168 | 1,062,941 (40.29%) | 2,468,645 | 8,891 | 0 | NON-ZERO — `marstal` |
| 0.6 | 2,637,200 | 1,029,189 (39.03%) | 2,467,670 | 7,840 | 0 | NON-ZERO — `marstal` |
| 0.5 | 2,636,142 | 983,894 (37.32%) | 2,466,563 | 6,628 | 0 | NON-ZERO — `marstal` |

**The 0.1 m row spacing above understates how tight the margin actually is.**
The wall between the 0.9 and 0.8 rows was located by bisection during
implementation, not left as an interval: `marstal` disconnects at its 2.0 m
`CONNECTIVITY_EXCEPTIONS_M` gate for **T ≤ 0.87** and reconnects from **0.88**.
So `T = 0.9` clears the wall by **0.03 m, not by the 0.1 m the row spacing
suggests**. An intermediate value such as 0.85 reads as safe from this table
and is not — it strands `marstal` exactly as 0.8 does. Do not tighten below
0.9 without re-running that bisection.

**The knee is at 0.9 m and it is not a coincidence.** Quote the method, not
just the number: depth is `max(−elev, 0)`, which is 1-Lipschitz in elevation,
and bilinear is only used where `|bilinear − max| ≤ T` — so

```
depth_blend  ≤  depth_max + T
⇒  a cell navigable at gate G has conservative depth ≥ G − T
```

At `G = 3.0` and `T = 0.9` that floor is **exactly 2.1 m = `BOAT_DRAFT_M`**.
The prediction was checked against measurement at nine (T, gate) combinations
and the measured minimum equals the predicted floor `G − T` in **every** one
(e.g. T = 0.9 / G = 2.5 → predicted 1.6, measured 1.6; T = 2.0 / G = 2.1 →
predicted 0.1, measured 0.1). The elimination of the below-draft class at
T = 0.9 is therefore a **structural guarantee** confirmed by measurement, not a
threshold fitted to this dataset.

Deltas at T = 0.9 against the shipped mask:

- Artifact: **5,280,000 B, unchanged**; gzip-9 1,340,357 B vs 1,338,886 B
  (python zlib, +1,471 B).
- **91,877 of 5,280,000 bytes change (1.74%)** — 6,723 water→land, 633
  land→water, 84,521 depth-only.
- Navigable at 3.0 m: 2,473,845 → 2,470,330 (**−3,515 cells, −0.14%**);
  3,969 cells lose navigability, 454 gain it.
- Connectivity: **28/33, no new disconnections, no stale `KNOWN_DISCONNECTED`
  entry, `verify_mask.py` exits 0** — bit-for-bit the same table as today,
  including both 0.0 m-margin harbours (Aabenraa, Augustenborg) still passing.

---

## 5. RECOMMENDATION

1. **Tighten `TOLERANCE_M` from 2.0 to 0.9 in `pipeline/build_mask.py` and
   regenerate `mask.bin`** (§4.4). This is the decision. It eliminates the
   entire below-draft exposure — 924 cells → **0**, by construction at any
   `safetyDepthM ≥ 3.0`, not by luck — cuts gate-crossing cells by 27%
   (14,715 → 10,746), costs **zero bytes**, adds **no** new channel, invariant,
   or fail-open surface, and leaves `verify_mask.py`'s connectivity table
   unchanged. Write the derivation `T ≤ safetyDepthM_default − BOAT_DRAFT_M`
   into the constant's comment so a future reader can run it backwards rather
   than re-tune it.
2. **Gate the regeneration on the #282 route sweep** (`app/sweep/`), BASE
   double-run control first, per this repo's standing rule that any change to
   mask bytes changes which cells are navigable, therefore which routes are
   `unreachable`, therefore which retry tiers fire. Honour #451's two known
   defects: assert six arm files per output directory before quoting a verdict.
   **This sweep has NOT been run here** and is the one thing standing between
   this recommendation and a merge.
3. **Also re-derive `CONNECTIVITY_EXCEPTIONS_M` and re-run `verify_mask.py`
   for real.** §3.4: those thresholds are tolerance-coupled constants. The
   scan above says they do not move at T = 0.9, but it is a re-implementation
   of the gate, not the gate itself.
4. **Ship Direction 1's disclosure alongside it, re-drafted** (§4.1), for the
   residual **10,746** gate-crossing cells — which after the fix are all
   between the draft and the requested depth, a materially different risk class
   from "below the hull". The copy must: name one basis; say the bound is
   between two readings of *the same source*, never a bound on truth; and
   carry a cross-artifact test in the `useBannerHeight.test.ts` /
   `panelWidth.test.ts` pattern that reads `TOLERANCE_M` out of
   `build_mask.py` and fails closed if the dict string drifts from it.
5. **Correct #455's headline in the issue itself**, with the basis clause, and
   record that 48.35% is not a cautious version of 45.08% but a set that misses
   137,861 genuinely overstated cells (§2.4).
6. **File the Aabenraa/Augustenborg zero-margin finding as its own issue**
   (§3.4), reviving #245 §2.3's unbuilt recommendation: have `verify_mask.py`
   report each harbour's snap-cell margin above its gate and flag anything
   under 0.2 m. Two harbours currently pass at **0.0 m** and the gate is
   binary, so it cannot see them.

**What would change my mind**, stated so it is falsifiable:

- **The #282 sweep showing real route regressions at T = 0.9.** −0.14% of
  navigable cells is small, but component connectivity is *necessary, not
  sufficient*: the isochrone solver steps ~2 km per ring where the flood fill
  walks 46 m cells (the #20 mechanism). If plans break, the fallback is
  T = 1.0 — still `verify_mask.py`-clean, still 37 below-draft cells rather
  than 924, and honest about not closing the class.
- **Evidence that Marstal's 2.0 m exception should hold at 1.8 m anyway.** If
  so, Direction 3 (pure max, zero gate-crossers, zero payload) becomes
  available and dominates this recommendation outright. That is a harbour-data
  question, not a raster question, and it is worth asking.
- **A maintainer decision that the 10,746 residual gate-crossers are
  unacceptable at all.** Then the answer is Direction 3 plus a Marstal
  exception change, not Direction 2 — the second channel annotates rather than
  fixes.

---

## 6. NOT RECOMMENDED — considered and rejected

| Option | Why it lost |
|---|---|
| **Direction 1 alone — disclose and change nothing** (§4.1) | The defect stays fully live: 924 cells the app calls navigable read below the hull, and the disclosure never reaches the user at the moment of exposure (the About dialog is opt-in; `route.shallow.banner` — the app's only depth-uncertainty sentence — renders *only* when `shallow` is set, i.e. is structurally withheld on exactly the silent case). Transfers the burden to the user for a defect that §4.4 shows is removable for zero bytes. Kept as a **component** of the recommendation, rejected as the whole of it. |
| **Direction 2 — second conservative channel + gate-crossing warning** (§4.2) | Pays +5,280,000 B raw / +688,655 B gzip (+16.08% of the precached data payload) to **annotate** a mask that §4.4 shows can be **corrected** for nothing. Its entire rationale over a data fix is the Aabenraa claim that §3 refutes three ways. Adds a fail-open surface (an absent channel degrades silently to today's defect), a second transferred buffer across five `NavMask` construction sites, and a semantic collision with #53/#452 (on Flensburg→Marstal both banners fire at once). Rejected on cost-for-nothing, not on feasibility — the design is sound. |
| **Direction 2's magnitude-threshold variant** ("warn where they differ by more than X") | Measured dead at every X: ≥ 0.1 m fires on 1,192,923 water cells (45.08%), ≥ 0.5 m on 234,091 (8.85%), ≥ 1.0 m on 70,664 (2.67%). A warning on most of the chart is not a warning. |
| **Precomputed 1-bit "crosses the gate" bitmap** (+18,917 B gzip-9) | By far the cheapest encoding that would work, and refused on principle: it bakes a single 3.0 m gate into a shipped artifact, while navigability is decided at query time from a user setting that must never require regenerating data. It would also silently mislead every user who moves their safety depth. Named explicitly because it is the obvious cheap idea. |
| **Delta channel instead of a full second channel** | Counter-intuitive and measured: +906,172 B gzip-9, **~218 KB worse** than shipping the conservative channel outright. The delta of two correlated fields has higher entropy than the blockier of the two. |
| **Direction 3 — pure `Resampling.max` rebuild** (§4.3) | The only option that removes the class completely, and rejected *for now* on one harbour: `verify_mask.py` exits non-zero because Marstal reconnects only at ≤ 1.8 m against its 2.0 m exception. It also costs 12,323 navigable cells against 3,515 for T = 0.9 — 3.5× the connectivity loss to close a residual that is entirely above the draft. Explicitly **re-openable**: if Marstal's exception is revisited on harbour-source grounds (§5), this becomes the better answer. |
| **`min(shipped, conservative)` intersection at the gate** | Dominated. Identical connectivity outcome to Direction 3 (27/33, Marstal) while *additionally* requiring Direction 2's second channel to exist. Strictly more cost for the same result. |
| **Quoting the issue's 48.35% (or the raw 75.56%) as the headline** | 48.35% is an exactly reproducible measurement of the wrong artefact — the intermediate float32 field, under round-to-nearest semantics, where the encoder floors — and it **misses 137,861 cells (11.6%)** that the app genuinely reads as deeper, including **195 of the 14,715 gate crossers**. 75.56% counts sub-millimetre differences no byte can represent. Use 45.08% with its basis clause. |
| **Reasoning about connectivity with a fixed snap cell** | Reproduces the issue's 26 lost pairs exactly and describes a program that does not exist: `planRoute` re-snaps against whatever mask it holds (`planRoute.ts:281-289`), and Aabenraa's snap moves 46.3 m — one cell — onto navigable water. Any future connectivity claim here must state which convention it used. |
| **Refining the grid to escape the trade-off** | Already decided in [#245](./245-depth-mask-resolution.md): 0 of 5 `KNOWN_DISCONNECTED` harbours reconnect at 23 m or 12 m, while Aabenraa disconnects at 23 m and Augustenborg additionally at 12 m. It attacks the same Aabenraa knife edge (§3.4) from the other side and makes it worse. Do not re-open without new bathymetry. |
| **Treating the conservative reading as chart truth** | It is not, and no option here should be described as if it were. `Resampling.max` over the `emodnet__mean` coverage is a max *of means* per ~116 m × 67 m native pixel, upsampled to 46 m. The real seabed may be shallower than either channel. |

---

## 7. What remains open — narrowed, not closed

1. **The #282 route sweep has not been run.** Everything above is measured on
   cells and components. Component connectivity is necessary, not sufficient:
   the solver steps ~2 km per isochrone ring where the flood fill walks 46 m
   cells. **No plan was computed against any modified mask in this spike.**
   That sweep (`app/sweep/`, BASE double-run control, six arms asserted) is a
   hard prerequisite, not a follow-up.
2. **The issue's route-level figures were not re-derived here.** Its
   Flensburg→Fynshav (0.105 nm below 3.0 m; worst point 54.8780 10.0752,
   shipped 3.5 m / conservative 2.3 m) and Flensburg→Aabenraa samples come from
   its own `planRoute` runs. The **cells** they name reproduce exactly
   (§2.6) — the along-track distances do not, because no route was planned in
   this session. Treat the per-route distances as unverified.
3. **How much of the residual 10,746 gate-crossers a real route actually
   touches is unmeasured.** The costing pass reported 0–3 legs and 0.00–0.43%
   of distance on five uniform-wind routes at T = 2.0; that is not re-derived
   here and it is not the post-fix figure.
4. **The guarantee is gate-conditional and must not be stated flat.** "Never
   navigable below the draft" holds only while the router plans at
   `safetyDepthM ≥ 3.0`, because the floor is `G − T` for whichever gate `G`
   is actually used, not the gate the user requested. At 2.5 m it degrades
   to 1.6 m (1,722 cells below draft) and at 2.1 m to 1.2 m (10,081).
   `build_mask.py`'s own comment already notes the settings UI should clamp
   `safetyDepthM` above draft; that clamp is BUILT — `SAFETY_DEPTH_FIELD.min
   = 2.2` in `app/src/components/OptionsPanel.tsx`, enforced by
   `NumberInput` on blur — correcting this spike's earlier claim that it was
   still unbuilt (verified against current code on `develop`). **But the
   clamp is NOT what holds this guarantee up** (PR #481 review, F4): it
   bounds only what a user can TYPE into `safetyDepthM`. `relaxedDepth.ts`'s
   `findRelaxedDepthM` (#53) probes an internal gate down to `BOAT_DRAFT_M`
   itself (2.1 m) whenever the requested depth is unreachable, entirely
   independent of that clamp, and it fires at DEFAULT settings with no user
   input at all — `realmask.repro.test.ts` pins `usedDepthM ≈ 2.3` for
   Flensburg→Marstal at `DEFAULT_SETTINGS`. So the 2.1 m / 1.2 m row above is
   reachable at default settings via relaxation, not only via a directly-typed
   low `safetyDepthM` the clamp would block — nothing holds this guarantee up
   at that floor, which is the honest statement and the reason the About
   dialog's disclosure copy (`about.caveats.depthMask`) now names the
   relaxation floor explicitly instead of stating an unconditional one.
5. **`CONNECTIVITY_EXCEPTIONS_M` is tolerance-coupled**, and the scan in §4.4
   is a re-implementation of `verify_mask.py`'s gate, not that script itself.
   Run the real thing on the real regenerated artifact.
6. **Aabenraa and Augustenborg pass at 0.0 m margin.** #245 §2.3 recommended
   margin reporting; it was never built. Until it is, this class of fragility
   is invisible to CI in both directions.
7. **The float32/float64 quantisation sensitivity (§0)** — 330 bytes on the
   blend, 2,049 on the conservative encoding — is documented nowhere in the
   pipeline. Anyone recomputing this mask can land on different numbers for no
   substantive reason.
8. **Two cluster bins in the issue's table (267/258 vs measured 260/265, same
   total 525)** are unexplained; the float-precision hypothesis was tested and
   refuted. Immaterial to the decision, recorded so a future reader does not
   mistake it for a data disagreement.
9. **Direction 2's refuter verdict never reached this document** (§4 preamble).
   Direction 2 is rejected here on independently measured cost, not on that
   missing verdict; if the verdict surfaces and contradicts §4.2, re-read the
   payload table rather than the refutation.

---

## 8. Invariants checked against this recommendation

- **Navigability stays a query-time decision.** Nothing recommended precomputes
  a gate; the rejected 1-bit bitmap is refused for exactly this reason (§6).
- **Never overstate depth.** The recommendation moves the artifact *toward*
  that rule — the encoder's `floor` comment at `build_mask.py:241` and the
  blend's 2.0 m tolerance currently pull in opposite directions, and T = 0.9
  narrows the gap without pretending to close it.
- **Guard asymmetry.** The uncertain path fails toward the
  expensive-but-safe direction: 3,515 cells lose navigability, none gains
  unearned depth.
- **The app is a planning aid, not a navigation device.** §5.4's disclosure is
  required precisely because the residual is real, and must not describe the
  conservative channel as a survey.
- **#282** — the recommendation changes mask bytes, therefore changes which
  routes are `unreachable`, therefore requires the full sweep. Named as a
  blocking prerequisite in §5.2, not as a follow-up.
- **No backend, offline-first** — a pipeline constant change; nothing moves to
  runtime.

---

## 9. ADDENDUM (2026-08-20) — the route-level trip rate

- **Issue:** #455, rescoped by the maintainer on 2026-08-20 to the
  **measurement + threshold-ruling half**. The implementation half — mounting
  the disclosure stack on routes that never relax — is **#612**, explicitly
  gated on #455: on the measurement below **and** on the maintainer's answer to
  §9.8, which this document does not supply.
- **Status:** measurement complete; **decision open** (§9.8). This addendum
  contains no ruling and no recommendation.
- **Appended, not merged.** §§0–8 above were written on 2026-08-09 against the
  **pre-#476** mask and are left byte-unchanged. §9.2 says which of their
  figures no longer describe the committed artifact.

### 9.1 The question, and why the existing number could not answer it

#455's blocker was one unmeasured precondition. The figure on record —
**2.47% of navigable cells** — is a **CELL** rate. Whether a route-level notice
keyed on those cells would be a *warning* or *wallpaper* is a property of
**ROUTES**, and routes are not random samples of cells: they are the solver's
own shortest paths through them, so the two rates are free to differ in either
direction by any amount.

**These two rates are never differenced anywhere in this document, and must
not be.** They measure different subjects over different populations. A ratio
between them would be meaningless arithmetic.

The criterion measured here is the one the issue's 2026-08-18 comment named as
sound — the T-bound one, using the existing shipped helper:

```
shallowExposureNm(legs, mask, settings.safetyDepthM + MASK_TOLERANCE_M) > 0
```

**Why `gate + T` and not `gate`.** `cellNavigable` requires `depth >= gate`, so
`segmentShallowestBelow(a, b, gate)` finds nothing on any solver-validated
segment — the naive repair is *vacuous by construction*. This addendum measures
that vacuity rather than asserting it: see the control in §9.4.

**What the number is a bound between.** Because `build_mask.py` takes bilinear
over the conservative `Resampling.max` reading only where the two agree within
`T`, every cell satisfies `depth_blend <= depth_max + T`, hence
`depth_max >= depth_blend - T`. So `shipped < gate + T` is exactly the set
whose **cautious lower bound** can sit under the gate. It is a bound between
**two readings of one EMODnet product** — never a bound on chart truth, and
never a clearance. The real seabed may be shallower than either reading.

### 9.2 SUPERSESSION — figures in this file and in #455 that are stale

The issue title, the issue body and parts of §§2.2–2.4 above predate **PR #476**
(`TOLERANCE_M` 2.0 → 0.9). They are **not** descriptions of the committed mask.

| Stale claim | Where | Status |
|---|---|---|
| `TOLERANCE_M = 2.0` | issue body, §2.1 | **Superseded** — `pipeline/build_mask.py` ships **0.9** |
| "up to **2.0 m** on **48%** of water cells" | issue **title** | **Superseded twice**: the 2.0 m bound is now 0.9 m, and §2.4 already ruled 48.35% the wrong *basis* |
| **924** cells below the 2.1 m draft | issue body, §2.3 | **Superseded** — **0** after #476 |
| **14,715** gate-crossers | issue body, §2.3 | **Superseded** — **10,746** after #476 |
| "routes cross sub-safety-depth water with **NO warning at all**" | issue **title** | **Superseded** — see §9.3; #492 shipped a per-cell cue, default on |
| Water **2,646,047** / navigable-at-3.0 **2,473,845** | §2.2, §2.3 | **Superseded** — re-derived below as **2,639,957** / **2,470,330** |
| Overstated fraction **45.08%** (1,192,923 / 2,646,047) | §2.4 | **Basis-correct but pre-#476.** It describes the T=2.0 artifact. NOT re-derived here — see the honesty note below |

**Re-derived here from the committed `mask.bin`** (`node app/sweep/tripRate.mjs
--mask-cells`; basis: the encoded byte decoded as `src/lib/mask.ts` decodes it —
`0` = land/unsurveyed/drying, `255` = 25.4 m, else `byte/10`; "water" = byte ≠ 0):

| Quantity | Measured on the committed mask |
|---|---|
| Grid | 2400 × 2200 = **5,280,000** cells |
| Byte 0 (land **or** unsurveyed **or** drying — indistinguishable) | **2,640,043** |
| Water (byte ≠ 0) | **2,639,957** (49.9992% of grid) |
| Byte 254 / byte 255 | **0** / **306,766** |
| Navigable at 3.0 m (`d >= 3.0`) | **2,470,330** |
| T-bound cells at 3.0 m (`3.0 <= d < 3.9`) | **61,088** = **2.4729%** of navigable |

**Internal corroboration that this is the post-#476 artifact:** §8 above
predicted the tightening would cost **3,515** cells their navigability.
Measured: 2,473,845 − 2,470,330 = **3,515 exactly**. The prediction and the
shipped artifact agree to the cell.

**The 2.47% figure reproduces exactly** (61,088 / 2,470,330), so the issue's
2026-08-18 comment is confirmed rather than merely carried forward.

**Honesty note on what was NOT re-derived.** The **10,746** true
conservative-vs-shipped crossers and the post-#476 overstatement fraction both
require recomputing a pure-`Resampling.max` build from
`pipeline/data-src/emodnet_dtm.tif` with rasterio — that cache is gitignored and
is not present in the worktree this addendum was written in. Those two figures
are therefore **cited, not re-derived**, and are quoted from #455's 2026-08-18
comment. Note their relationship: the **61,088-cell set is a strict SUPERSET of
the 10,746-cell set** — every true crosser has `shipped < gate + T`, but a cell
in that band whose cautious reading happens not to be lower is counted by the
shipped-byte predicate and not by the conservative one. The ~5.7× ratio between
the two counts is consistent with that containment and is not evidence of a
discrepancy.

### 9.3 NARROWING — #492 already ships a per-cell cue at this exact criterion

**The issue title's "with NO warning at all" is out of date, and the maintainer
should not rule on that description.**

`app/src/lib/depthColor.ts`'s `buildNavigabilityHatchImageData` builds its LUT as

```
marginal[b] = cautiousDepthLowerBoundM(byteToDepthM(b)) < safetyDepthM
```

and `cautiousDepthLowerBoundM(d)` is `d - MASK_TOLERANCE_M`, quantised **down**
to a 0.1 m step (`Math.floor(bound * 10 + 1e-9) / 10`) and clamped at 0.

So the hatch tests `floor₁₀(d - T) < gate`, while this addendum measures
`d < gate + T`. **On the domain the mask actually carries these are the same
predicate**, and the quantisation is why that needs saying rather than
assuming: every shipped depth is a decimetre multiple (`byte/10`, or 25.4 m for
byte 255), so `d - T` is already an exact decimetre multiple and `floor₁₀`
returns it unchanged — the `1e-9` epsilon exists precisely to stop an IEEE754
residue costing an unearned decimetre. The `Math.max(0, …)` clamp does not break
it either: it only engages for `d < 0.9 m`, where both predicates are true for
any positive gate.

So the shipped per-cell cue and the route-level criterion measured here are the
**same test**, evaluated per cell instead of per route.

It renders as the `sc-depth-hatch` MapLibre layer (`DataLayers.tsx`) and is
**ON by default**: it has **no independent toggle** and rides `depthVisible`,
which is `usePersistedToggle('sc-depth-visible', true)`. The code says so at the
call site — *"no independent toggle for the hazard-hatch layer — it rides the
SAME depthVisible state as the absolute ramp"*.

**So the accurate statement of the remaining gap is narrower than the issue
title:** every T-bound cell a route crosses is **already hatched on the map**;
what is missing is a **ROUTE-SCOPED** signal — a per-plan statement in the
results panel that *this route* crosses such water, and how far.

Two known limits of the shipped cue, both already tracked, both relevant to
whether a route-scoped signal is still wanted:

- **No legend explains the symbol** — #598, open, and named in
  `DataLayers.tsx`'s own comment.
- **At overview zoom the pattern is a sparse speckle, not a readable hatch** —
  measured and documented in `depthColor.ts` (the period is expressed in mask
  cells, so on-screen size scales with zoom; #599). Its residual failure mode is
  structurally **under**-signalling, never false comfort: `HATCH_RGBA` is pure
  black, so compositing can only darken.

### 9.4 The corpus — stated in full, because a bare percentage is not a finding

Everything in §9.5 comes from **one** `app/sweep/` arm-set run. Quoting any
figure below without this clause makes it unfalsifiable.

| Parameter | Value |
|---|---|
| Harness | `app/sweep/` (#282/#450/#488), arm-set run `base1`, detached |
| BASE | merge-base **`00a33ab`** — `origin/develop` tip at run time |
| Run window | started 2026-08-20T12:58:50+02:00, **`=== base1 exit=0 ===`** at 13:25:02+02:00 |
| Arms | **9**, as committed in `sweepArms.ts` — parameters read from `ARMS`, never hand-copied |
| Destinations | all **33** entries of the committed `app/public/data/harbors.json`, the origin included (self-pair) |
| Plans | 9 × 33 = **297** |
| Origins | **Flensburg** (6 arms), **Marstal** (3 arms: `margin-zero`, `relaxation-dense`, `margin-extreme`) |
| Departure | `T0` = **2026-07-15T06:00:00Z**, fixed |
| Wind | **uniform synthetic** fields — 12 kn/225° (`breeze`, `no-comfort`, `short-horizon` at a 3 h grid, all three Marstal arms); 3 kn/0° (`light-motorless`); 0.15 kn/0° (`becalmed`, `deep-becalmed`) |
| Gate (`safetyDepthM`) | **3.0 m** on seven arms; **4.0 m** `deep-becalmed`; **2.9 m** `margin-extreme` |
| Threshold | per-arm `gate + 0.9` — **3.9 / 4.9 / 3.8 m** |
| Boat | catalogue default — Salona 45, draft **2.1 m**, both sails (`genoa`, `fock`) |
| Data | the **real committed** `mask.bin` + polars |
| Legs basis | the **RECOMMENDED** sail's legs — what `RouteSummary` actually renders |

**`becalmed` and `deep-becalmed` are VACUOUS and are excluded from every
denominator below.** Measured on this run: **33/33 error rows each** (`becalmed`
28 `calm-motor-off` + 5 `unreachable`; `deep-becalmed` 27 `calm-motor-off` +
3 `unreachable` + 3 `snap-failed-destination`). They contain zero routes, so
their byte-identity would survive any mask change including a catastrophic one.
They are named here so a future reader cannot quietly re-admit them.

**Outcome distribution of the arm files actually consumed** (all 297 rows, so
the baseline's quality is visible rather than assumed):

| Outcome | Rows |
|---|---|
| `ok` (no `shallow` block) | **74** |
| `ok+shallow` (a #53 relaxation fired) | **83** |
| `error: unreachable` | **54** |
| `error: calm-motor-off` | **55** |
| `error: beyond-horizon` | **28** |
| `error: snap-failed-destination` | **3** |
| **Total** | **297** |

Of the 74 `ok` rows, **7** are **self-pairs** — one for each of the **seven
non-vacuous arms**, whose own origin also appears in its destination list. They
are zero-distance and structurally incapable of tripping. (`becalmed` and
`deep-becalmed` have self-pair rows too, but both are error rows and both arms
are excluded anyway, which is why this is 7 and not 9.) They are reported
separately and excluded from the headline denominator, giving **67**
non-relaxed plans.

**THE CONTROL, and it is load-bearing.** For every one of the 67 non-relaxed
plans the same walk was also run at the **bare gate**:
`shallowExposureNm(legs, mask, gate)` returned **0.0 nm on 67 of 67**. Two
things follow.

1. It confirms **by measurement** that the naive repair (`flagShallowLegs` at
   the requested gate on tier1/tier2) is **vacuous** — exactly as the issue's
   2026-08-18 comment predicted, now measured rather than argued.
2. It is a **differential test** of two independently-written DDA walks over 67
   real routes' legs: `shallowExposureNm`'s walk and the solver's own
   `segmentNavigable`. Had they disagreed anywhere, this would have read
   non-zero and no figure in §9.5 would have been safe to quote.

Consequently **every nautical mile reported in §9.5 lies in `[gate, gate + T)`** —
T-bound exposure, never a gate violation.

`unknown (null)` — the #251/#255 out-of-mask/iteration-guard result, which must
never be folded into "clear" — occurred on **0 of 67**.

### 9.5 THE MEASUREMENT

Reproduce with:

```
node app/sweep/tripRate.mjs <armDir>          # <armDir> = a sweep run's SC_SWEEP_OUT
node app/sweep/tripRate.mjs <armDir> --json   # machine-readable
node app/sweep/tripRate.mjs --mask-cells      # §9.2's cell figures
```

`app/sweep/tripRate.mjs` is committed by this change specifically so this
measurement does not repeat #455's original fate: its `/tmp/shallow-probe/`
scripts are lost and its route-level figures are now unreproducible.

#### Headline — NON-RELAXED population (`PlanResult.shallow` absent, self-pairs excluded)

| | |
|---|---|
| Plans | **67** |
| **Trips (`exposure > 0`)** | **55 — 82.1%** |
| Clear (`exposure == 0`) | 12 — 17.9% |
| Unknown (`null`) | **0** |
| Any-sail basis (either rig's own track trips) | 55 — identical to the recommended-sail basis |

Exposure over the 55 tripping plans:

| | min | p25 | median | p75 | p90 | max | mean |
|---|---|---|---|---|---|---|---|
| **nm** | 0.0029 | 0.4116 | **0.9072** | 1.3782 | 2.0765 | 3.6298 | 1.0114 |
| **% of that route** | 0.01 | 0.90 | **2.41** | 3.62 | 5.26 | 7.38 | 2.58 |

#### The pooled figure is NOT a user-frequency estimate — read the per-arm split

The arms are **settings probes, not a usage distribution**. Pooling weights each
arm by how many `ok` rows it happens to produce, which has nothing to do with
how often a real user is in that configuration. The per-arm split is the
decision-relevant view:

| Arm | Settings | n | Trips | Rate | median nm | median % | max nm |
|---|---|---|---|---|---|---|---|
| **`breeze`** | **`DEFAULT_SETTINGS`** | 26 | 16 | **61.5%** | **0.3068** | **0.73%** | 1.2137 |
| `no-comfort` | `depthComfortMarginM: 0` | 26 | 25 | **96.2%** | 1.2000 | 3.28% | 3.6298 |
| `light-motorless` | TWS 3, engine off | 14 | 14 | **100%** | 0.9485 | 2.85% | 2.1276 |
| `short-horizon` | 3 h wind grid | 1 | 0 | 0% | — | — | — |
| `margin-zero` / `relaxation-dense` / `margin-extreme` | Marstal origin | **0** | — | — | — | — | — |

What this split shows that the pooled number hides:

- **`breeze` is the closest arm to ordinary use, and it trips on 61.5%, not
  82.1%** — median exposure **0.31 nm (0.73% of the route)**, **maximum**
  1.21 nm (1.99%), p25 0.14 nm, and smallest trips of **0.0029 nm (~5.4 m)**,
  0.0170 nm and 0.0426 nm. Stated precisely, because three arms use
  `DEFAULT_SETTINGS` and it would be easy to over-claim here: `short-horizon`
  and `relaxation-dense` use it too, but the first contributes a single
  non-relaxed plan (its wind grid is only 3 h, so 26 of its rows die
  `beyond-horizon`) and the second contributes none (Marstal origin — every
  route relaxes). `breeze` is therefore the only arm supplying a **substantial**
  non-relaxed population at shipped defaults over a full-horizon wind field.
- **The #243 comfort margin is doing measurable work.** `breeze` and
  `no-comfort` share the same origin, wind field, gate and departure and differ
  only in `depthComfortMarginM` (2.0 vs 0): **61.5% vs 96.2%**, median exposure
  **0.31 nm vs 1.20 nm**. The shipped default already steers routes away from
  T-bound water; turning it off roughly quadruples the median exposure.
- **The three Marstal arms contribute ZERO non-relaxed plans.** Every one of
  their 27 `ok` rows carries a `shallow` block, and their only non-relaxed row
  is the self-pair. The non-relaxed population is therefore entirely
  Flensburg-origin — a real narrowing of this corpus, stated so it is not
  mistaken for region-wide coverage.

#### RELAXED population — reported separately, never merged

| | |
|---|---|
| Plans | **83** |
| Trips | **83 — 100%** |
| Exposure nm | min 0.5499, p25 0.7613, **median 1.0196**, p75 1.4925, max 3.5581 |
| Exposure % of route | min 1.30, **median 3.43**, max 8.18 |

These plans **already disclose** — `flagShallowLegs` ran, `PlanResult.shallow`
is set, and the #504/#509/#518/#523 stack renders. That every one of them also
trips the T-bound criterion is expected, not a finding: a relaxed route solved
*below* the requested gate, so it necessarily crosses water under `gate + T`.
Their `exposure@gate` is non-zero on 83 of 83 — which is the relaxation itself,
**not** a control failure. The two populations are kept apart throughout
precisely so this cannot be read as one number.

#### Self-pairs

7 plans, zero distance, **0 trips**, 0 unknown — reported so the 74 `ok` rows
reconcile as 67 + 7 rather than appearing to go missing.

### 9.6 What the disclosure stack does today — verified, not assumed

Re-read on 2026-08-20 against `00a33ab`:

- `flagShallowLegs` — the **only** producer of `Leg.shallow` / `ShallowInfo` —
  has exactly **three** call sites in `app/src/routing/planRoute.ts` (~:713,
  ~:723, ~:738) and **all three sit inside `if (relaxed !== null)`** (~:696).
- Every non-relaxed success returns `assemble(tierN, null)` (~:603, ~:614,
  ~:630).

So on the **67** non-relaxed plans measured above, the banner, the cautious chip
and the exposure sentence do not mount at all.

**Why no test could have caught it — enumerated rather than asserted.**
`ShallowWarning` is declared in `RouteSummary.tsx` (~:59) with
`shallow: ShallowInfo` (~:64) — **required and non-nullable**. Exactly three
test files reference it (`RouteSummary.test.tsx`,
`RouteSummary.exposure.test.tsx`, `PlannerPanel.test.tsx`), and every one
constructs a literal `shallow: { … }` fixture; **none** passes `null` or
`undefined` (checked, zero occurrences). So the suite exercises the
**component** and never the **mount decision**, which is the layer the defect
lives in.

### 9.7 SAFETY FRAMING — two branches, and the one-branch version is false

Any copy written from this measurement must keep these apart. Collapsing them
in either direction produces a false statement.

**Branch 1 — DISCLOSED, and it is real at DEFAULT settings.**
`defaultSafetyDepthM(b) = ceilToDecimetre(b.draftM + MASK_TOLERANCE_M)` while
`relaxationFloorM(b) = ceilToDecimetre(b.draftM)` — **no tolerance added**. So
at a boat's own default gate, #53 relaxation searches
`[relaxationFloorM(boat), requestedDepthM)`, and the mask floor at a relaxed
gate `G'` is `G' - T`, reaching `draft - T` (**1.2 m under the Salona 45's
2.1 m hull**) **with no user action at all**. `realmask.repro.test.ts` pins
Flensburg→Marstal at `requestedDepthM 3.0` / `usedDepthM ≈ 2.3`. These cases
**are disclosed** — `shallow` is set, `isSevere` fires, and the app's own
`about.caveats.depthMask` string already says so: *"it can be as little as
{floor} m where a route falls back to a shallower depth to stay connected,
flagged on the resulting route."*

**Never write "below-draft requires a user-lowered gate."** The app's own
shipped copy contradicts it.

**Branch 2 — the UNDISCLOSED residual, which is what #612 would cover.** On a
**non-relaxed** route the gate is never lowered, so the cautious floor is
`gate - T`. Because `defaultSafetyDepthM` is `ceilToDecimetre(draft + T)`, that
is **exactly the draft** for all three catalogue boats (2.1 → 3.0 → 2.1;
1.9 → 2.8 → 1.9), zero margin. **The undisclosed residual therefore bottoms out
AT the hull and never below it.** That is what makes this a disclosure-
**completeness** gap rather than a silent below-draft hazard — and it is also
why option (B) in §9.8 cannot fire at any catalogue default.

**Both branches are bounds between two readings of the SAME EMODnet product.**
Neither is chart truth. Nothing here has been checked against a nautical chart,
and the real seabed may be shallower than either reading.

### 9.8 DECISION REQUIRED — options, not a recommendation

This section deliberately contains **no ruling**. The measurement is above; the
trade-offs are below; the call is the maintainer's.

#### D1. Which trigger, if any

**(A) Per-leg mask walk at `gate + MASK_TOLERANCE_M`**, via the existing
`shallowExposureNm` / `segmentShallowestBelow` (both already take an arbitrary
threshold).

- *Measured firing rate:* **61.5%** on `breeze` (shipped defaults, full-horizon
  wind — see §9.5 for why it is the representative arm and not simply "the
  `DEFAULT_SETTINGS` arm"), **82.1%** pooled across the non-relaxed corpus,
  **96.2%** with the comfort margin at 0, **100%** with the engine off in light
  air.
- *Measured magnitude on `breeze`:* median **0.31 nm (0.73% of route)**, max
  **1.21 nm (1.99%)**, p25 **0.14 nm**, smallest **0.0029 nm (~5.4 m)**.
- *Reading:* on the shipped default settings this is closer to "most routes,
  small distances" than to a rare, sharp alarm. Whether ~3 routes in 5 carrying
  a sub-nautical-mile notice reads as informative or as chrome is a **product
  judgement**, and it is the judgement this measurement exists to inform. A
  distance threshold or a percentage-of-route threshold would move the rate;
  neither is proposed here, because picking one is the ruling.

**(B) Per-plan severity `gate - MASK_TOLERANCE_M < boat.draftM`.** No mask walk
at all.

- *Measured:* fires on **0 of 67** non-relaxed plans in this corpus.
- *Why, structurally:* `defaultSafetyDepthM = ceilToDecimetre(draft + T)` makes
  `gate - T == draft` **exactly** at every catalogue boat's default, so the
  strict `<` is **false by construction** — verified for all three boats
  (2.1/2.1/1.9 m). It becomes true only once a user lowers the gate below the
  default, and how far they *can* is itself per-boat: `OptionsPanel.tsx`'s
  `SAFETY_DEPTH_FIELD.min` is `minSafetyDepthM(boatById(DEFAULT_BOAT_ID))`, a
  derived value rather than a literal, which evaluates to **2.2 m** for the
  Salona 45 — do not quote 2.2 as a flat UI floor. In this corpus only
  `margin-extreme` runs a
  lowered gate (2.9 m → `gate - T = 2.0 < 2.1` **true**), and that arm
  contributes **zero** non-relaxed plans, which is why the corpus figure is 0
  rather than merely small.
- *Reading:* as a **trigger** it is silent for every default-settings user. As
  an **escalation** it is precise: it fires exactly when the cautious floor
  really does drop under the hull.

**(C) (A) as trigger, (B) as the `isSevere` escalation** — the pairing
`ShallowWarning` already implements.

- *Measured:* trigger fires as (A); escalation fires on **0 of 67** here, and
  would fire only for a user who lowered the gate.
- *Reading:* preserves the shipped two-level shape and adds no new UX concept.
  Its cost is that the common case is the un-escalated one, so the escalation
  is a rarely-exercised path — the class this repo's own rule flags as "not
  verified by the trigger's absence".

#### D2. Is a route-level notice still wanted at all, given #492?

Genuinely open, and the reason §9.3 exists. Every T-bound cell is **already
hatched on the map by default**. The remaining gap is scope, not detection: the
map answers *"is there such water here?"* and nothing answers *"does my route
cross it, and for how far?"*. Weighing against a route-level notice: it would
duplicate an already-shipped cue at the measured 61.5%/82.1% rate. Weighing for
it: the hatch has no legend (**#598**, open), and at the app's own initial z9 it
renders as a sparse speckle rather than a readable pattern (**#599** — the
period is expressed in mask cells, so on-screen size scales with zoom).
`depthColor.ts`'s own measurement is worth stating exactly rather than
overstating: the touched pixels really are dark (mean luminance shift 62, max
160, 28% dropping >100), they are simply too small and too sparse to *read as a
pattern* — so the honest concern is legibility at planning zoom, not absence.
And a **distance** is information the map cannot convey at any zoom.

#### D3. Should the map casing and the legend swatch participate?

**They should not be reused unchanged, and this is a copy-correctness problem,
not a styling one.** Verified in both dictionaries:

- `routeGeoJson.ts` sets `shallow: leg.shallow !== undefined`, which drives
  `RouteLayer`'s `sc-route-shallow` casing — so today it is relaxation-only,
  like the rest of the stack.
- `route.legend.shallow` reads **"Charted shallower than safety depth"** /
  **"Flacher als Sicherheitstiefe kartiert"**.
- `route.shallow.exposure` reads **"{dist} of this route crosses water charted
  shallower than your safety depth of {requested} m"** / **"…, das flacher als
  die eingestellte Sicherheitstiefe von {requested} m kartiert ist"**.

Both assert the **charted (shipped)** reading is below the gate. For a T-bound
crosser the shipped reading is **at or above** the gate by construction — so
both strings would be **false** if reused for option (A), in both languages.

By contrast `route.shallow.lead` — *"a more cautious reading of the charted
depth data could run as low as {cautious} m"* — is **basis-correct** for a
T-bound crosser and could be reused as-is.

So D3 is really: extend the shipped semantics (new copy in de **and** en, in
which case the casing and swatch can participate), or leave casing and swatch
relaxation-only and give the T-bound case its own distinct treatment. Either is
defensible; silently reusing the existing strings is not.

#### D4. Which of spike item 4's disclosure surfaces should ship

Re-verified on 2026-08-20 against `00a33ab`:

| Surface | State |
|---|---|
| About dialog (`about.caveats.depthMask`) | **Shipped** — names the tolerance, the `G − T` floor and the relaxation case |
| `README.md` | **Shipped** — describes the hatch (*"hatches water whose cautious, worst-case reading falls below your safety depth"*) and the 0.9 m tolerance in the safety-depth default |
| `SECURITY.md` | **Absent** — zero occurrences of "depth" |
| `docs/security-assurance-case.md` | **Absent** — mentions the depth gate and `verify_mask.py`, but nothing on the tolerance, the cautious reading or the overstatement |
| `DepthProfile` caption | **Absent** — the component's whole i18n surface is the eight `profile.*` keys (`title`, `depthAxis`, `deepCap`, `safetyDepth`, `heading`, `wind`, `minDepth`, `minDepthUnknown`); none mentions the tolerance or the cautious reading |

Item 4 originally called for five surfaces; **two shipped, three did not**. Each
is independent of D1–D3 and costs nothing in routing.

### 9.9 Limits of this measurement — stated so it is not over-read

- **One wind regime per arm, all synthetic and uniform.** No real Open-Meteo
  forecast was used. Route geometry drives everything measured here, so a
  different wind field gives different routes and a different rate.
- **One departure instant** (`T0`), one boat (Salona 45), one origin per arm.
- **The non-relaxed population is entirely Flensburg-origin** (§9.5) — 67 plans
  over only **26 distinct destinations** (the same harbours recur across arms),
  not a region-wide sample.
- **A trip rate is not a hazard rate.** It counts routes crossing cells whose
  *cautious reading* is under the gate. Per §9.7 branch 2, on these non-relaxed
  routes that cautious floor is the hull itself, never below it.
- **Not chart truth.** Every figure is a bound between two readings of one
  EMODnet product.
- **`becalmed` / `deep-becalmed` excluded** as vacuous (§9.4) — do not re-admit
  them to raise an `n`.
- **`PlanResult` is untouched.** This addendum measures; it changes no routing
  and adds no field, so no #282 sweep is owed by it. #612's implementation, if
  it changes which plans carry a `shallow` block, **would** owe one.
