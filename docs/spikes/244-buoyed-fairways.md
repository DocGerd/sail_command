# Spike #244 — when must routing honour buoyed fairways?

- **Issue:** #244 (paired with #245)
- **Date:** 2026-08-05
- **Status:** Decision / Recommendation
- **Verdict:** **Decline to make fairways a routing input.** The data cannot
  support it: `seamark:type=fairway` does not exist in this bbox at all, the
  258 `waterway=fairway` ways that *do* exist carry **zero** width, depth or
  draft tags, and **55.8% of them are OSM canoe-route geometry tagged
  `boat=discouraged`** — following it would steer a 2.1 m draft yacht along
  shoreline paddling routes. Ship the mandatory-class objects as an **advisory
  display overlay** instead.

> Companion: [`245-depth-mask-resolution.md`](./245-depth-mask-resolution.md).
> The two spikes are alternative answers to the same question — how to
> represent a corridor the 46 m raster cannot resolve — and were decided
> together.

---

## 0. Provenance of every figure

All OSM figures come from raw Overpass JSON fetched and parsed locally — never
from a summarising web fetch. Three queries, each pinned by the server's own
`timestamp_osm_base` (the OSM database cut the answer reflects), not merely by
date:

| Query | Elements | `timestamp_osm_base` | Generator |
|---|---|---|---|
| `way\|relation["seamark:type"]` in bbox | 643 | `2026-08-05T15:33:06Z` | Overpass API 0.7.62.11 87bfad18 |
| `way\|relation["waterway"="fairway"]` in bbox | 258 | `2026-08-05T15:43:15Z` | Overpass API 0.7.62.11 87bfad18 |
| `node\|way\|relation["seamark:type"="fairway"]` in bbox | **0** | `2026-08-05T15:44:18Z` | Overpass API 0.7.62.11 87bfad18 |

Bbox throughout: 54.3–55.3 N, 9.4–11.0 E (the `build_mask.py` /
`build_seamarks.mjs` operating area). Depth figures read from the committed
`app/public/data/mask.bin` + `mask.meta.json`. Harbour snaps from
`app/public/data/harbors.json`.

OSM data is ODbL, already handled by the app's existing attribution — licensing
is **not** a blocker for any option below, so it is not what decides this spike.

---

## 1. Premise check — #244's primary object does not exist here

### 1.1 `seamark:type=fairway`: zero features

#244 Q1 leads with `seamark:type=fairway`. Queried across **nodes, ways and
relations**: **0 elements**. Not sparse, not fragmentary — absent.

Also absent or near-absent from the seamark scheme in this bbox: `FAIRWY`-style
area geometry of any kind. The seamark-tagged ways that do exist are:

| `seamark:type` | Ways | Rel | What it actually is |
|---|---|---|---|
| `restricted_area` | 129 | 1 | closed areas (fishing/military/nature) — §4 |
| `harbour` | 115 | 1 | harbour areas |
| `cable_submarine` | 59 | — | cables |
| `navigation_line` | 57 | — | **lines of bearing** — §3 |
| `recommended_track` | 21 | — | **lines of bearing** — §3 |
| `separation_lane` | 2 | — | the one real TSS — §4 |
| `separation_zone` / `separation_boundary` | 1 / 2 | — | same TSS |
| `dredged_area` | 1 | — | one polygon, **no depth tag** — §5 |

### 1.2 The correction to my own first pass — `waterway=fairway` *does* exist

A first reading of the table above would conclude "fairways are absent". That
would have been **wrong**, and it is worth recording how it was caught: the two
`separation_lane` ways carry `waterway=fairway` *alongside* their seamark tag,
which revealed a second tagging scheme the seamark-only query never saw.

Re-queried directly: **258 `waterway=fairway` ways, 1,799.2 km total.** So
fairway *centrelines* exist in quantity — under a different key than the issue
names.

The honest claim is therefore **not** "there is no fairway data". It is:
**there is fairway centreline geometry, and it lacks every attribute a router
would need to use it** (§2), while being **more than half contaminated with a
different mode of transport** (§2.2).

### 1.3 What the issue got right

The seamark extraction gap is real. `pipeline/build_seamarks.mjs` queries
`node["seamark:type"]` **only** — nodes, never ways or relations — so the
committed `app/public/data/seamarks.json` (1,794 features, all `Point`) contains
no corridor geometry of any kind by construction. Nothing in `app/src/routing/`
reads seamarks. Both statements in #244 check out.

---

## 2. What the fairway centrelines actually are

### 2.1 Not one of the 258 carries a width, depth or draft tag

Scanned every tag key on all 258 features for `/width|depth|draft|maintained/`:

```
ANY width/depth/draft/maintained tag key: NONE — not one feature in 258
```

Tag keys present on ≥ 5 features: `waterway` (258), `boat` (155), `canoe` (145),
`open_water` (135), `navigation` (130), `name` (17), `seamark:type` (6).

This single measurement disposes of two of #244's four candidate
discriminators:

- **"Fairway width vs. boat"** (Q2, bullet 4) — a 30 m dredged channel and a
  400 m approach fairway really are different objects with the same tag, exactly
  as the issue says. **The data cannot tell them apart.** There is no width
  anywhere to read.
- **Maintained-depth overlay** (Q3, option 2) — there is no maintained depth to
  overlay. See §5.

Geometry shape: 6,273 nodes over 1,799.2 km, mean vertex spacing **299 m**,
quantiles p10 = 54 m / p50 = 180 m / p90 = 2,703 m / max = 22,615 m. **Zero of
the 258 are closed ways** — these are polylines, not corridor polygons. A
22.6 km straight segment is a route line, not a channel.

### 2.2 The trap: 55.8% is canoe-route geometry

| Subset | Ways | Length |
|---|---|---|
| All `waterway=fairway` | 258 | 1,799.2 km |
| **Canoe/paddling scheme** | **144 (55.8%)** | **461.7 km (25.7%)** |
| Marine-plausible remainder | 114 | 1,337.5 km |

Classified as canoe-scheme when tagged `canoe=yes`, `boat=discouraged`,
`boat=no`, `navigation=shoreline`, or `open_water=partial|no`. Raw value counts
across the 258:

```
boat=        discouraged 132, yes 13, no 9, mo 1
canoe=       yes 144, no 1
navigation=  shoreline 93, traverse 37
open_water=  partial 114, yes 21
```

**132 ways are explicitly tagged `boat=discouraged`.** These are shoreline
paddling routes along the shallow margins of the Schlei and the fjords — the
precise water a 2.1 m draft, 4.2 m beam keelboat must stay out of.

This is not hypothetical. Taking the nearest `waterway=fairway` to each of the
five #9 harbour snaps — the obvious naive implementation:

| Harbour | Naive nearest | Marine-only nearest |
|---|---|---|
| `arnis` | 70 m — "Schlei" (`canoe=no`) ✔ | 70 m — same |
| `kappeln` | 48 m — "Schlei" (`canoe=no`) ✔ | 48 m — same |
| **`maasholm`** | **48 m — way 1338800035, `boat=discouraged`, `canoe=yes`, `navigation=shoreline`** ✘ | 74 m — way 1205243478 |
| `dyvig` | 65 m — way 1204303022 ✔ | 65 m — same |
| `graasten` | 43 m — way 1203967130 ✔ | 43 m — same |

**One of five test harbours already mis-picks a paddling route**, at a 26 m
margin over the correct way. A filter on `boat`/`canoe`/`navigation`/
`open_water` fixes these five — but those keys are *optional free-form OSM
tagging*, not a schema, and 13 of the 258 carry `boat=yes` while 114 carry
`open_water=partial`. There is no authoritative field that says "this is a
marine fairway", so the filter is a heuristic over a heuristic.

### 2.3 The one genuine long centreline

Way `1205243476`, `name=Schlei`, `canoe=no`: **38.00 km, 87 nodes, mean spacing
442 m**. This *is* the Schlei fairway, and it is the single most useful object
found by this spike. It still carries no width and no depth, and at 442 m mean
vertex spacing it is a schematic centreline, not surveyed channel geometry.

---

## 3. `navigation_line` and `recommended_track` are bearings, not corridors

#244 Q1 lists both as candidate corridor sources. Measured:

| | `navigation_line` | `recommended_track` |
|---|---|---|
| Features | 57 | 21 |
| Nodes per way | 2 (×36), 3 (×21) | **2 (×21) — all** |
| Carrying an `:orientation` tag | **56 / 57** | **21 / 21** |
| Category | `leading` 45, `transit` 1 | `fixed_marks` 20, `leading` 1 |
| Length median / max | 1.53 km / 7.15 km | 1.18 km / 4.95 km |

A two-node way carrying an `orientation` of `279.2` is a **transit bearing** —
S-57 `NAVLNE`/`RECTRC` semantics: a line you *align on*, typically extended well
beyond the navigable water to a shore mark. It is not the edge or centre of a
navigable corridor and has no width by definition. `recommended_track` is
sourced `Dansk Fyrliste 2022` (the Danish List of Lights) on 20 of 21 ways —
a light list, which is what a transit bearing belongs to.

Concretely, the four `navigation_line` ways inside the Schlei are named
`Lotseninsel` (bearing 94), `Schleimünde` (107.5), `Grimsnis` (266) and
`Kappeln` (213) — four leading lines for specific turns, **not** the 38 km
Schlei channel. **Zero `recommended_track` ways lie in the Schlei at all.**

Treating either as a corridor would be a category error, and one that fails
dangerously: a leading line extended shoreward runs *onto the land it points at*.

---

## 4. Mandatory vs. advisory — the discriminator exists, but barely

#244 Q2's strongest candidate is legal class: a TSS lane binds under COLREG
Rule 10 regardless of draft; a recommended track is advisory. **Where the
source carries the object class, this is a lookup rather than a heuristic** —
and that part of the issue is correct.

The problem is population size.

**Traffic Separation Scheme — exactly one, at the southern edge.**
`separation_lane` ×2 (2.7 km each), `separation_zone` ×1 (6.0 km),
`separation_boundary` ×2 (2.8 km each), all centred **54.477–54.500 N,
10.279–10.307 E**. That is geometrically coherent — two lanes flanking a zone
between two boundaries — so it is a *real* TSS (the Kiel approach), not random
fragments. It sits at the extreme south of the bbox, ~30 km from the nearest
planning harbour, and covers **five ways in a 1.6° × 1.0° area**.

**Restricted areas — 130 features, but mostly not about entry.**

```
restriction tokens: restricted_fishing 42, no_entry 35, no_fishing 22,
                    no_anchoring 13, restricted_entry 8, entry_prohibited 5,
                    no_dredging 2, restricted_anchoring 1, no_boating 1,
                    no_diving 1, look_at_NfS 1
categories:         military 23, fish_sanctuary 20, nature_reserve 17,
                    swimming 6, safety 2, kite_surfing 1, ...
```

116 of 130 carry a `:restriction`; 74 carry a `:category`; none carry neither.
**40 of 130 are entry-restricted** (`no_entry` or `entry_prohibited` as a
token). The remaining 90 restrict fishing, anchoring or diving — irrelevant to
a passage-planning router.

So the mandatory-class inventory for the whole operating area is **one TSS plus
40 entry-restricted polygons**. That is small enough to be worth *showing* and
too small to justify a solver subsystem — and, critically, **none of it is a
fairway**. The mandatory objects and the corridor objects are disjoint sets.

---

## 5. Depth-derived necessity — #244's leading hypothesis, measured and falsified

#244 Q2 bullet 1 proposes the cheapest discriminator: *the fairway only matters
where leaving it costs depth, which the existing mask already knows* — and
instructs the spike to try to falsify it first. So it was tested rather than
argued.

**Method.** Walk the 114 marine-scheme `waterway=fairway` centrelines, sampling
every 100 m. At each sample, probe **perpendicular** to the centreline in 20 m
steps until the shipped 46 m mask reports a cell below the 3.0 m default gate.
Sum both sides to get the width of the navigable corridor the depth gate alone
imposes. 13,070 sample points.

**Result.**

| Corridor width at gate 3.0 m | Value |
|---|---|
| p5 | 440 m |
| p10 | 1,100 m |
| p25 | 3,440 m |
| p50 / p75 / p90 / p95 | ≥ 6,000 m (probe cap) |
| mean | 4,630 m |
| wider than 100 m | 99.7% of points |
| wider than 400 m | 95.4% of points |
| wider than 1,000 m | **90.8% of points** |

**The hypothesis is falsified.** At ~91% of sampled points the boat can leave
the fairway by more than a kilometre without the depth gate objecting. Depth
does *not* already confine the boat to the marked channel, so a fairway rule
would not be redundant — it would be genuinely new behaviour.

**And that is an argument against adding it.** The reason the corridor is so
wide is that this fairway network is dominated by long open-water route lines
(Little Belt, Kiel–Fehmarnsund) where a 2.1 m draft yacht *legitimately sails
anywhere* — exactly #244's own opening observation that channels are dredged
and marked for far deeper commercial traffic. A corridor cost term would
manufacture detours across 91% of the network to no benefit.

**Two honest limits on this measurement.** The probe caps at 3,000 m per side,
so p50–p95 are lower bounds, reported as "≥ 6,000 m" rather than a value. And
the sample is dominated by open-water route lines — which is a property of the
data as tagged, not a sampling artifact, but it means the result says little
about the handful of genuinely narrow channels. It is a falsification of the
*general* claim, not a proof that depth never confines.

**One finding points the other way, and it matters:** at **13.2% of sample
points (1,719 of 13,070) the fairway centreline itself lies on a mask cell
below 3.0 m.** Where the fairway and the mask disagree, it is usually the
raster that is wrong (#245 §2: the source is 67 × 116 m and cannot resolve a
30 m channel). This is the honest kernel of #244's "data-substitute necessity"
argument — and it is also precisely the set of places where a depth overlay
would be *fabricating* depth (§6.2).

---

## 6. How would it enter the solver? Three options, each with its failure mode

Constraint throughout (CLAUDE.md): no post-hoc pass that can violate wind or
depth constraints. Whatever is chosen lives in the cost or the gate, never in
cleanup.

### 6.1 Option A — corridor as a cost term

Penalty for being outside a corridor flagged mandatory; depth stays the hard
gate.

- **Invariants:** respects query-time navigability and never overstates depth.
  Structurally the cleanest option.
- **Blocked by data, not by design.** A cost term needs a corridor, and §2.1
  shows there is no width on any of the 258 ways. Buffering a centreline by a
  guessed constant invents the very number the object lacks — and §2.3 shows
  the vertex spacing (442 m on the Schlei way) is too coarse for a tight buffer
  to track the real channel.
- **Failure mode:** absurd detours. §5 measures a ≥ 1 km navigable corridor at
  90.8% of points, so a penalty applied across this network would push the boat
  toward schematic route lines in open water where sailing anywhere is correct.
  **Who it hurts:** every user on every open-water leg — the common case.
- **Under incomplete/stale data:** the Schlei has one centreline and Dyvig's
  ~30 m channel has none; coverage is uneven, so the penalty would apply
  arbitrarily in some places and not others, which is worse than applying
  nowhere.
- **Test that could observe it:** an ETA + track comparison over the
  Flensburg→all-harbours sweep, base vs. head, asserting no plan gets slower.
  Cheap and decisive.

### 6.2 Option B — mask overlay raising effective depth inside a charted fairway

#244 asks directly whether the pipeline's refusal to fabricate depth still
holds when the source is a *charted maintained depth* rather than an
interpolation. Answering precisely, because the two invariants are different
claims:

- **It does NOT violate "navigability is a query-time decision."** An overlaid
  depth value is still compared against the user's `safetyDepthM` at query
  time; safety depth stays a user setting and still needs no data regeneration.
  That objection would be the wrong one to raise.
- **It DOES violate "never overstate depth"** — and that is the invariant that
  disqualifies it.
- **But it fails on data first, which is more decisive than the principle.**
  The bbox contains **one** `dredged_area` polygon (`Højestene Løb`, 54.983 N /
  10.481 E, 5.48 km perimeter) and it carries **no depth tag**. Across all 258
  `waterway=fairway` ways: no depth tag either. **There is no charted
  maintained depth in this data to promote.** The hypothetical the issue poses
  — "what if the source were a charted maintained depth?" — does not arise,
  because no such source is in hand.
- **Failure mode:** the worst available. It would open exactly the 13.2% of
  points where the centreline reads below the gate (§5) — i.e. it silently
  converts every fairway/mask disagreement into "deep enough", including the
  disagreements caused by genuinely shallow water rather than by raster
  coarseness. A user who lowered `safetyDepthM` would be routed through
  water nothing ever surveyed as adequate. **Who it hurts:** the user
  most exposed — shallow draft, narrow channel, trusting the plan.
- **Interaction with #282:** an overlay changes which cells are navigable,
  therefore which routes are `unreachable`, therefore which retry tiers fire.
  Any such change needs #282's full harbour sweep, not a labelling review.
- **Test:** the `verify_mask.py` connectivity table plus a land→water flip
  count crossing 3.0 m and 5.0 m — the same instrument #6 used for the
  `TOLERANCE_M` blend.

### 6.3 Option C — implicit via-point generator

Insert vias along a fairway centreline when origin/destination lie beyond it.

- **Invariants:** the solver still validates every leg against depth and wind,
  so it cannot produce an unnavigable route. Genuinely the safest of the three.
- **Failure mode:** silent slowdown. Vias are *hard* constraints on the path,
  so a stale or schematic centreline (442 m vertex spacing) forces the boat
  through points that may be neither optimal nor where the channel now runs.
  Unlike Option A this cannot be tuned down by lowering a weight — a via is
  binding or absent. **Who it hurts:** users on exactly the routes the feature
  is meant to help, and invisibly, because the plan still looks valid.
- **Under incomplete data:** the failure is asymmetric and bad — the ~4 harbours
  with a nearby centreline get vias, the rest do not, so the feature helps
  precisely where §5 shows depth already permits free movement, and is absent at
  Dyvig where no centreline exists.
- **Interaction with #282:** via-points change waypoint pairs, so they change
  `connectedAt` results and no-route classification. Same sweep requirement.
- **Test:** ETA regression sweep as in Option A, plus a check that every
  generated via lies on a cell navigable at the requested gate.

---

## 7. RECOMMENDATION

1. **Do not make fairways a routing input.** Not as a cost term, not as a mask
   overlay, not as a via generator. The decisive reason is data, not design:
   zero width, zero depth, zero draft tags across all 258 fairway ways (§2.1);
   55.8% canoe-scheme contamination tagged `boat=discouraged` (§2.2); and
   the mandatory-class inventory (one TSS, 40 entry-restricted polygons)
   contains no fairway at all (§4).
2. **Record that depth-derived necessity was tested and does not hold** (§5).
   #244 asks for this hypothesis to be falsified first; it was, at 90.8% of
   sampled points. Future work should not re-assume "the mask already handles
   it" — but should also not read that as a reason to add a corridor rule,
   since the same measurement shows why a corridor rule would misfire.
3. **Ship the mandatory-class objects as an ADVISORY DISPLAY overlay**
   (follow-up issue, map-only, no solver involvement): the one Kiel TSS
   (5 ways) and the 40 entry-restricted areas. This is small, honest, cheap,
   needs no new discriminator, and is the correct response to "advisory by
   default" for a planning aid that must not claim chart authority. It also
   requires extending `build_seamarks.mjs` to query ways/relations, which is
   the prerequisite for anything else in this area.
4. **Keep the Schlei centreline (way `1205243476`) on file** as the single
   genuinely useful corridor object found (§2.3), for a future
   display-only channel hint. Not a routing input.
5. **Treat the 13.2% centreline-below-gate finding as evidence for #245's
   source question**, not as a licence to overlay depth (§5, §6.2). It
   quantifies where the raster and the buoyage disagree, which is exactly the
   region a genuinely higher-resolution source would fix.
6. **If any of this is ever revisited, the entry condition is a source that
   carries width or maintained depth** — an official ENC `FAIRWY`/`DRGARE`
   product with those attributes populated. Licence first, attributes second;
   OSM will not acquire these fields on its own.

## 8. NOT RECOMMENDED — considered and rejected

| Option | Why it lost |
|---|---|
| **Corridor as a cost term** (§6.1) | No width on any of 258 ways, so the corridor must be invented; §5 measures a ≥ 1 km navigable corridor at 90.8% of points, so the penalty would manufacture detours across most of the network. Cleanest design, no data to run it on. |
| **Mask overlay raising depth in a fairway** (§6.2) | Fails on data before principle: **one** `dredged_area` in the bbox, no depth tag, and no depth tag on any fairway way — there is no charted maintained depth to promote. On principle it violates *never overstate depth* (**not** the query-time navigability invariant, which it would actually respect). Worst failure mode of the three. |
| **Implicit via-point generator** (§6.3) | Safest of the three and still rejected: a via is a hard constraint that cannot be tuned down, driven by a 442 m-spacing schematic centreline, present at ~4 harbours and absent at Dyvig — so it binds hardest exactly where the geometry is weakest. |
| **Using `navigation_line` / `recommended_track` as corridors** (§3) | Category error. 56/57 and 21/21 carry an `:orientation` bearing; all `recommended_track` ways are 2-node. These are transit bearings extended toward shore marks — following one runs onto the land it points at. |
| **Naive nearest-`waterway=fairway` lookup** (§2.2) | Already mis-picks a `boat=discouraged` canoe shoreline route for `maasholm` at a 26 m margin. The mode filter that fixes it is a heuristic over optional free-form tags, not a schema. |
| **Fairway centreline to recover #9 connectivity** | The geometry is close enough (43–70 m from all five snaps) that this looks promising, and it is the tempting cross-over from #245. But recovering connectivity from a centreline with no depth *is* fabricating depth by another name — the thing #9 explicitly refused — and at `maasholm` the nearest geometry is a paddling route. Rejected. |
| **Honouring the TSS as a routing constraint** | COLREG Rule 10 is genuinely binding, so this is the one legally-clear case. Rejected on scope and size: five ways at the extreme southern edge, ~30 km from the nearest planning harbour, and #244 puts traffic/right-of-way modelling out of scope for an offline solo-boat planner. Display it (§7.3), do not route on it. |
| **Extracting fairways into `seamarks.json` now** | `build_seamarks.mjs` would need ways/relations (worth doing for §7.3), but shipping 1,799 km of mixed-mode centrelines with no width or depth would add ~ hundreds of KB to a precached asset to render geometry the router must ignore and the user could misread as a channel. Only the §7.3 subset earns its bytes. |

## 9. Invariants checked against this recommendation

- **Navigability stays a query-time decision** — nothing recommended touches the
  mask or `safetyDepthM`.
- **Never overstate depth** — the only option that would have is Option B,
  rejected (§6.2).
- **No post-hoc tack/route reducer** — no option survives into the
  recommendation, so nothing is added to cleanup.
- **No backend, offline-first** — the §7.3 overlay is a build-time asset like
  today's `seamarks.json`; Overpass is never called at runtime.
- **Not a navigation device** — the advisory overlay must carry caution copy and
  must not be presented as chart-authoritative; this is why it is display-only.
- **#282** — no recommended change alters no-route classification, so no
  routing-behaviour sweep is triggered. Both rejected solver options would have
  needed one (§6.2, §6.3).
