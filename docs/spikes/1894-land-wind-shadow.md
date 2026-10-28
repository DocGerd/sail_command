# Spike #1894 — land blocking or disturbing the wind (lee, shadow, channelling)

- **Issue:** #1894
- **Date:** 2026-10-26 to 2026-10-28
- **Status:** Decision / Recommendation. Maintainer decision pending.
- **Verdict:** Not resolvable from these tracks (three of four trips hold
  both groups, five required). Disclose now; defer any routing change
  behind a rerun (§4). The app's default Open-Meteo cell selection goes to
  the maintainer as a separate question (§2).

## 0. Pre-registration (written before any Phase 3 result)

Fixed before the track analysis runs. A later section may report extra
views, but the verdict is decided only by the rules below.

### 0.1 Data

- EASY GO! tracks exported from Navionics: position and time at 1 Hz, no
  wind, no instruments, no sail or engine state. All sailed with the fock;
  only `salona-44-easy-go-fock.json` (tier B, #1660) is used. Reefing is
  unknown.
- Privacy: no raw track, position or time is committed. Scripts and
  intermediate data stay in the session scratchpad; this document carries
  aggregates only.
- Wind: Open-Meteo `icon_seamless` 10 m wind on the app's own 0.1° lattice,
  requested with the app's parameters (`services/openMeteo.ts`, including the
  omitted `cell_selection`), from `api.open-meteo.com` with `past_days`.
  Paired to samples by the same trilinear u/v interpolation as
  `lib/wind.ts`'s `WindField.sample`. This is model wind, not observed wind:
  the comparison is boat against the wind the router would see.

### 0.2 Derived quantities

- SOG and COG from the displacement over a centred 30 s window.
- TWA from COG and the model TWD. TWS and TWA bracket the fock table; samples
  with TWA < 45° or TWS outside 4–25 kn are dropped, never extrapolated.
- Polar ratio `R = SOG / table speed`, with the table bilinear in TWA and TWS
  and performance factor 1.0 (the app's default 0.9 is a level offset,
  reported separately).
- Upwind fetch: distance along the ray toward the model TWD (where the wind
  comes from) to the first land cell (byte 0) of the committed `mask.bin`,
  marched in steps of at most half a cell, capped at 10 nm. Downwind fetch
  and fetch at TWD ± 90° use the same march on the other rays.

### 0.3 Exclusions (each reported with the share of samples it removes)

1. Within 1 nm of any `harbors.json` snap point, and within 1 nm of each
   track's start and end.
2. Within ± 60 s of a COG change > 30° (measured between the 30 s windows
   either side).
3. Waiting or drifting: SOG < 1.0 kn sustained ≥ 60 s.
4. Motoring, any of: TWA < 35° sustained ≥ 120 s (no sailing boat holds
   it); a leg whose median `R` > 1.6 (faster than the sails can drive);
   model TWS < 4 kn with SOG > 3 kn.
5. TWA < 45° or TWS outside 4–25 kn (§0.2).

Sensitivity rerun ("strict"): 1.5 nm harbour radius, ± 90 s turn window,
motoring at median `R` > 1.4 or TWA < 40°.

### 0.4 Legs, bins, aggregation

- Leg: a maximal run of kept samples between exclusions, at least 180 s long.
- Upwind-fetch bins (nm): A < 0.25, B 0.25–0.5, C 0.5–1, D 1–2, E 2–4,
  F ≥ 4. **Short fetch** = A + B (< 0.5 nm). **Open water** = E + F
  (≥ 2 nm).
- One value per leg per bin: the median `R` of that leg's samples in the
  bin, kept if it has ≥ 60 samples. Group values are means of leg-bin
  values. Leg and trip counts are reported with every bin.
- Interval: trip-level bootstrap, 2000 resamples of trips with replacement,
  fixed seed, 95 % percentile interval.
- Reported per TWA band (45–80, 80–120, 120–180°) and TWS band (4–8, 8–14,
  ≥ 14 kn), with each bin's TWA/TWS mix shown. The verdict uses the pooled
  contrast only.

### 0.5 Decision rules

Effect `Δ = R(open water) − R(short fetch)`.

- **Resolvable** only if ≥ 5 distinct trips each contribute at least one
  leg-bin value to both the short-fetch and the open-water group. With fewer
  trips the verdict is **"not resolvable from these tracks"**, not "no
  effect"; per-trip signs of `Δ` are reported descriptively only. Five is a
  judgment: below it, a trip-level bootstrap interval is set mostly by which
  trips are drawn.
- **Justifies option 2** (soft cost away from a lee shore) if resolvable and
  all of: `Δ ≥ 0.10`; its interval excludes 0; the direction placebo does
  not show the same effect (downwind-fetch `Δ` and the ± 90° `Δ` each below
  half the upwind `Δ`, or their intervals include 0); and the strict rerun
  keeps `Δ ≥ 0.10`.
- **Justifies option 1** (a TWS penalty with coefficients) if option 2 is
  justified and, in addition, at least three of bins A–F each have ≥ 5 trips
  and an interval half-width ≤ 0.05, so a curve can be fitted.
- **Credit to option 3** (finer model): if a finer model, on the same sample
  set, shrinks `Δ` by ≥ 50 %, it resolves most of the effect.
- Why 0.10: the fock table's own uncertainty is −5 % to +9 % per cell against
  a sister hull's VPP (its `source` note). A lee effect smaller than that is
  not worth a solver change.

### 0.6 Separate: polar check (report only)

Open-water (≥ 2 nm upwind fetch) sailing legs, per fock-table TWA × TWS
cell: level (median `R`) and shape (cell median ÷ overall median), with leg
and trip counts; cells with < 3 trips are "insufficient". A level offset
cannot be told from model-wind bias or current. A new issue is filed only
for a shape deviation > 15 % in the same direction in ≥ 3 trips
individually. Polars are not edited.

### 0.7 Amendment (2026-10-26, still before any track result)

Prompted by Phase 2 research, not by data. The §0.5 verdict rules are
unchanged; these views are report-only.

1. The app omits `cell_selection`, so Open-Meteo answers in `land` mode
   (server source, `ForecastapiController.swift`), which can return an
   adjacent land cell for a water point. That would pair short-fetch samples
   with lower TWS and inflate `R` there, biasing `Δ` toward zero. The §0.4
   contrast is therefore also reported with wind fetched with
   `cell_selection=sea` and `nearest`, on the §0.3 sample set.
2. Model-only check, no tracks: on the app's full 0.1° lattice, the per-point
   TWS difference between `land`, `sea` and `nearest`; and whether modelled
   TWS at water lattice points rises with their own upwind fetch.
3. `past_days` hours come from the newest runs' first hours, so the pairing
   tests the model's spatial structure, not its multi-day forecast error.
4. All trips fall in one month, so one stability regime; any result is
   scoped to it.

## 1. Findings

§0 stands as committed (`e9dfc95`, amended `0e89f82`). Deviations and
corrections found later are disclosed here, not edited into §0.

### 1.1 Data

Five uploads, three byte-identical (same sha256): three distinct trips, all
October 2026, Als / Flensburg Fjord area, 75,746 fixes at 1 Hz, about
83 nm. The kept fixes fall in 16 distinct clock hours, so the analysis rests
on few model hours as well as few trips. Wind was fetched with `past_days`
(§0.7.3); a first attempt hit Open-Meteo's daily quota on the session's
outbound IP. A fourth trip, supplied later, is reported in §1.9; §1.2–§1.8
cover the first three.

### 1.2 Exclusions (§0.3, sequential, share of all 75,746 fixes)

| Rule | Removed | Standalone |
|---|---|---|
| 1 harbour zone, track start/end | 38.9 % | 38.9 % |
| 2 turn window | 5.6 % | 10.3 % |
| 3 waiting / drifting | 0.0 % | 21.9 % |
| 4 motoring (pinching, light air) | 0.6 % | 1.8 % |
| 5 polar domain, window coverage | 1.9 % | 8.0 % |
| leg shorter than 180 s | 2.1 % | 2.1 % |
| 4 motoring (leg median `R` > 1.6) | 0 legs | 0 legs |

Kept: 38,497 fixes (50.8 %) in 24 legs, every trip contributing. Strict
rerun: 32,085 (42.4 %), 20 legs. No waiting remained after rules 1 and 2.

Implementation choices §0 does not fix. The window guard, the turn-event
displacement and the polar-check convention were varied for effect (§1.6,
§1.7); the "sustained" run rule, the omnidirectional ray set and the
water width were not:

- A window must span ≥ 24 s. A first guard of ≥ 28 s cut runs on
  millisecond timestamp jitter (3–5 % of full windows read just under
  28 s); it was relaxed before any result was read.
- A turn event compares the 30 s windows before and after a fix, each moving
  ≥ 15 m; ± 60 s is excluded around every event.
- "Sustained" means an unbroken per-fix run; legs split at gaps > 2 s (never
  fired: no gap exceeds 1.2 s).
- Omnidirectional distance to land: 36 bearings, capped at 2 nm.
- Water width (§1.4, §4): the minimum over 36 axes of the summed distance
  to land in both directions (72 bearings at 5°, each capped at 2 nm, the
  mask edge counted as land).
- Polar-check cells are the fock table's bracket cells; a leg-cell needs
  ≥ 60 fixes; the level is the median of leg-cell medians.

### 1.3 Result

**Verdict (§0.5): not resolvable from these tracks.** Three trips contribute
to both the short-fetch and the open-water group; five are required.

Descriptive only, `R = SOG / table speed`, one value per leg per bin:

| Upwind fetch | Mean `R` | Legs | Trips |
|---|---|---|---|
| A < 0.25 nm | 0.596 | 6 | 3 |
| B 0.25–0.5 nm | 0.610 | 8 | 3 |
| C 0.5–1 nm | 0.666 | 14 | 3 |
| D 1–2 nm | 0.720 | 15 | 3 |
| E 2–4 nm | 0.724 | 7 | 3 |
| F ≥ 4 nm | 0.791 | 5 | 2 |

`Δ` (open water minus short fetch). Each row re-pairs the app-wind §0.3
sample set with that wind; fixes that leave the polar domain under it drop
out (at most 348, 0.9 % of the kept set, under DMI). The strict and
fast-leg columns are their own sets.

| Wind paired | All legs | Strict rerun | Without the fast leg |
|---|---|---|---|
| App request (`land` cells) | 0.148 | 0.143 | 0.102 |
| `cell_selection=sea` | 0.140 | 0.135 | 0.109 |
| `cell_selection=nearest` | 0.138 | 0.128 | 0.099 |
| ICON-D2, 0.025° lattice, `land` | 0.125 | 0.124 | 0.087 |
| ICON-D2, 0.025° lattice, `sea` | 0.149 | 0.136 | 0.122 |
| DMI HARMONIE, 0.025° lattice | 0.096 | 0.068 | 0.068 |

- Per trip, the app row reads 0.079 / 0.093 / 0.232. Two trips are below
  §0.5's 0.10 on their own; the pooled 0.148 clears it through the third,
  which holds the fast leg. Every per-trip value under every row stays
  positive (0.03–0.26).
- The fast leg: one open-water leg of 1,115 fixes sails at `R` 1.26 (SOG
  about 8.8 kn on a broad reach in about 11 kn of model wind). Engine,
  current or model under-reading; neither cap in rule 4 reaches it. It is a
  gap in the rule, shown as a sensitivity, not excluded after the fact. Its
  removal and the land-mode effect in §1.5 may overlap: every open-water fix
  of that trip is land-answered.
- ICON-D2 requested at 36 points of the app's own lattice equals
  `icon_seamless` there over all 120 past-day hours of the fetch, which
  include every hour the pairing reads, so the 0.025° ICON-D2 rows test
  lattice density, not another model: −15 % in `land` mode, +6 % in `sea`
  mode (all legs, against the `sea` row). DMI HARMONIE is a different 2 km
  model: −35 % on the primary set, −34 % without the fast leg, −52 % on the
  strict set (where its set keeps 32,062 fixes against 32,085, and one trip
  reads 0.026).
- §0.5's option-3 credit (≥ 50 % "on the same sample set") does not name
  the set. This spike reads the primary set as binding, since §0.3 calls the
  strict rerun a sensitivity check; on that reading the credit is not met,
  on the strict set it is. The recommendation does not rest on it (§3).
- With three trips each holding both groups, the bootstrap "95 % interval"
  is the minimum and maximum of the 10 distinct resample values; for the
  app row those are the per-trip values.
- Open-water level: `R` 0.77 against model wind (§1.7); per §0.6 it cannot
  be told apart from model-wind bias or current.

### 1.4 Is the deficit a lee effect?

Not shown. `Δ` compares different legs: 8 legs supply short-fetch values and
8 open-water values, one leg both, so fetch is confounded with each leg's
place, hour and trim. The controls disagree:

- Direction placebo (§0.5): downwind `Δ` 0.067 and +90° `Δ` 0.054 are below
  half the upwind `Δ`. The −90° `Δ` is 0.115 with interval
  [−0.0015, 0.351], so §0.5's clause is met literally, but it is not
  credited: 87 % of its short-fetch fixes are the upwind-short fixes again,
  its interval rests on two trips, and 73 of its 2,000 bootstrap draws are
  undefined (strict: 0.085, [−0.003, 0.218]).
- Between legs, at equal proximity (land within 0.25 nm in any direction),
  land-upwind legs (upwind fetch < 0.5 nm) average `R` 0.607 against 0.731
  for land-downwind legs (downwind fetch < 0.5 nm, upwind ≥ 0.5 nm; each leg
  ≥ 60 fixes in the class; 7 legs each), lower in all three trips
  (−0.126 / −0.090 / −0.191; strict −0.105). At 0.25–0.5 nm the gap is
  −0.013 and mixed in sign by trip (−0.015 / +0.024 / −0.019). This favours
  a lee effect only at the closest range.
- Within legs (leg fixed effects on 120 s block medians; ranges over the
  specifications holding each term, alone or with downwind, any-direction,
  TWA/TWS or water-width terms), land within 0.5 nm upwind costs `R`
  0.035–0.054 and land within 0.5 nm downwind 0.034–0.048, so the
  regression shows no direction dependence; on the strict set the upwind
  cost is 0.011–0.026 with intervals including 0. A paired within-leg
  comparison of nearest land upwind (within ±45° of the wind direction)
  against nearest land in any other direction, each side ≥ 60 fixes per
  leg, reads −0.153 under 0.25 nm (4 legs, 2 trips) and +0.037 at 0.25–0.5 nm
  (8 legs, 3 trips).
- In a paired split by water width, the within-leg deficit appears only in
  narrow water: −0.081 under 0.5 nm
  wide (2 legs, 1 trip), −0.104 at 0.5–1 nm (4 legs, 2 trips), +0.011 at
  ≥ 1 nm (5 legs, 2 trips); 58 % of upwind-short fixes are in water under
  0.5 nm wide. There, current (#18's spike quotes the harbour pilot on up to
  3 kn in Alssund), traffic and caution are alternative causes. Between
  legs the deficit does not vanish outside narrow water: in water ≥ 1 nm
  wide the upwind `Δ` is 0.143, and 0.097 without the fast leg.
- In the TWA and TWS bands where some trip has both groups, the deficit
  stays positive in every trip: 0.068 at 45–80° and 0.133 at 80–120° TWA,
  0.154 at 8–14 kn TWS. No trip has both groups in the other bands. So the
  TWA mix does not explain it.
- Removing it would take a large wind error: true short-fetch wind about a
  third below the model's. Scaling short-fetch model TWS by 0.8 gives a `Δ`
  of 0.076, by 0.7 gives 0.019, and by 0.6 gives −0.061. No sampling variant
  tested removes it: on the 4 × denser lattice the app's own model moves `Δ`
  by −15 % in `land` mode and +6 % in `sea` mode (all legs), and `land`
  against `sea` there moves it by −9 % to −29 % across the three columns
  (§1.3). Every deterministic 10–20° TWD
  rotation tested leaves `Δ` ≥ 0.11; random per-leg errors of 20° give a 5th
  percentile of 0.117 and a minimum of 0.072 over 300 draws. A combined worst
  case was not computed.

### 1.5 The wind the router sees

Model-only check on the app's own 322-point lattice, over the 144 hours of
one fetch in October 2026 (§0.7.2):

- The app omits `cell_selection`, so Open-Meteo answers in `land` mode. At
  water lattice points with land within 2 km (44 points), 75 % are answered
  from a land cell, and the 44 points' TWS is a median 0.861 of the `sea`
  answer (10th percentile 0.771; 0.877 against `nearest`). Far from land the
  ratio is 1.000.
- Correction to §0.7.1, which expected the land mode to bias `Δ` toward
  zero. On the app lattice with all legs it did not: land-answered corners
  sat mostly under open-water fixes (all four corners land-answered for
  61 % of open-water fixes, 2 % of short-fetch fixes), and `land` exceeds
  `sea` by 0.007 (strict 0.008) and `nearest` by 0.009 (strict 0.015).
  Without the fast leg it did against `sea` (−0.007) but not against
  `nearest` (+0.003); on the 0.025° ICON-D2 lattice it did against `sea` in
  every column (−0.012 to −0.035).
- The model already carries a fetch gradient: at water lattice points of
  the app request, TWS divided by that hour's median is 0.68–0.86 with under
  2 nm of upwind fetch (lowest at 0.5–1 nm, not monotone), 0.98 at 4–10 nm
  and 1.09 beyond 10 nm (Spearman ρ ≈ 0.67); `sea` mode shows the same
  shape. 11 % of these fetches are cut short by the mask edge. This is the
  regional, kilometre-scale gradient. Sub-kilometre obstacle lee (§1.6) is
  resolved nowhere in the pipeline.
- Over this area `icon_seamless` serves ICON-D2 (0.02°, 0–48 h) and its
  rapid-update run at the highest priority, ICON-EU (7 km) to 5 days, then
  ICON global. A 6-day plan spans all three; the track analysis saw only
  ICON-D2 hours, while the lattice check's last 24 hours (the fetch's
  forecast day) were not shown to be ICON-D2. Open-Meteo applies no
  downscaling
  to 10 m wind. Answers come from native-grid cells a median 0.8–0.9 km from
  the requested point, and 1.7 km at water points within 2 km of land in
  `land` mode. (Open-Meteo server source, `ForecastapiController.swift` and
  `Icon.swift`.)
- Finer models whose grids reach the area: DMI HARMONIE 2 km and MET Nordic
  1 km; only partly KNMI 2 km (ends at 11.28° E) and AROME France HD 1.5 km
  (ends at 55.4° N); UKMO 2 km, unverified over Denmark. Requested by their
  own id, all stop at 2.5 days or less, against the app's 6-day horizon.

### 1.6 Physics, terrain, verification

- Lee physics, from search summaries only (every literature host was blocked
  by the session's network policy): porous windbreaks shelter to about 10
  obstacle heights (design) and 25–30 (maximum); offshore flow recovers over
  tens of kilometres. Sailing rules of thumb (10–20 × height) have no traced
  source. No channelling figure for a Danish strait was found; candidate
  sources (for example the DTU Sprogø mast data in the Great Belt) were
  unreachable.
- Terrain (Copernicus GLO-30 DSM, 9.4–11.0° E): the highest land within 500 m
  of the coast is 4.3 / 17.1 / 38.8 m at the 10th / 50th / 90th percentile,
  so 10–30 height lee lengths run from about 40 m to 1.2 km (1.4 km at the
  90th percentile of the Flensburg Fjord / Als sub-box, 45.7 m): below the
  0.1° lattice, but 1–30 mask cells. Height varies 4–9 × along the coast,
  so a constant-height rule would be off by that factor.
- Adversarial verification of the app (`land`) pairing: the Python pairing
  matches `WindField.sample` and `Polar.speedKn` to Float32 precision on all
  kept fixes; an independent exact-grid recompute of the upwind fetch moves
  `Δ` from 0.148 to 0.146; an independent kinematics recompute on 1,000
  fixes agrees to 2.5e-10 kn SOG (an alternative window-endpoint convention
  moves SOG by ≤ 0.061 kn); the statistics reproduce exactly. Varying the
  window guard (20–27 s) and the turn-event displacement (0–30 m) leaves `Δ`
  at 0.148; varying §0's harbour radius (0.75–1.25 nm), turn threshold
  (25–40°) and minimum leg (120–300 s) keeps it at 0.140–0.161 (0.098–0.107
  without the fast leg); dropping three motor-suspect steady legs as well as
  the fast leg gives 0.088. Every per-trip value stays positive. Of the
  other wind rows, only the `sea` all-legs value was independently
  recomputed (0.1406).

### 1.7 Polar check (report only, §0.6)

Posted on #1894: open-water level `R` 0.77 (per trip 0.75 / 0.72 / 0.78),
the fast leg included. Every table cell has fewer than three trips, so no
shape finding qualifies for an issue. Other readings of the convention put
the level at 0.73–0.77 and let up to three cells reach three trips (nearest
table node); none shows a qualifying shape deviation (in those cells, largest
single-trip −14.7 %).

### 1.8 Corrections to §0

- §0.5 names option 2 "soft cost away from a lee shore". In this spike
  "lee" means land upwind of the boat, which seamanship calls a weather
  shore; a lee shore is land downwind. Option 2 means a cost away from land
  upwind.
- §0.5 calls −5 % to +9 % "the fock table's own uncertainty". Its `source`
  note says that range compares two sister-hull VPP runs and is not an error
  bound for this boat; 0.10 stays a judgment.
- §0.7.1 expected the land-mode bias to push `Δ` toward zero. On the app
  lattice with all legs it did not; without the fast leg it did against
  `sea` but not against `nearest`, and on the 0.025° ICON-D2 lattice it did
  against `sea` (§1.5).

### 1.9 Fourth trip (added 2026-10-28)

A fourth track arrived after the decision question was first put, and no
further tracks are available. It ran through the unchanged §0 pipeline. Its
wind is a second `past_days` fetch from the same endpoint, made after the
trip, so its hours are past hours there too. Where both fetches cover an
hour (12,576 point-hours over the seven wind variants) they agree exactly,
and the first three trips' samples are identical in all 19 sample sets.

- Kept: 1,505 of 9,610 fixes in 5 legs (strict: 729 in 3 legs). The
  harbour/start/end rule removes 5,898.
- Every kept fix has upwind fetch 0.67–1.63 nm (bins C and D), so the trip
  adds to neither group: `Δ`, its interval and the per-trip values are
  unchanged in every row and column of §1.3, and three trips still hold
  both groups. The verdict stands, and the five trips §0.5 requires cannot
  come from these tracks (§4).
- Polar check (§1.7): the trip has no open-water fix, so nothing changes.
- ICON-D2 equals `icon_seamless` at the trip's lattice points over the
  hours it reads (30 of 30 point-hours), as for the first three (§1.3).
- §0.5's placebo clause now fails on downwind. The trip adds two
  downwind-short leg-bins (`R` 0.48 and 0.69) and no downwind-open one,
  which lifts the downwind `Δ` to 0.0741 against half the upwind `Δ`,
  0.0738, with interval [0.041, 0.295] (strict: 0.0769 against 0.0715,
  [0.045, 0.532]). With three trips it passed (0.067, §1.4).
- Between legs at land within 0.25 nm, land-downwind legs average 0.727
  (8 legs, 4 trips) against 0.607 for land-upwind legs (unchanged). At
  0.25–0.5 nm the gap becomes +0.005 (was −0.013).
- Within legs, the land-downwind cost becomes 0.036–0.051 (was
  0.034–0.048). The land-upwind cost ranges and the paired figures §1.4
  quotes are unchanged.

## 2. Recommendation

**Disclose now; change no routing.**

1. Add a wind caveat: a new `about.caveats.wind` key in both dicts, its
   About list item and test row, a README Known-limitations bullet and a
   `changelog.d/` fragment. None of these is in the #282 closure, so no
   sweep is owed. The copy rests on verified pipeline facts, not on the
   track verdict:
   - the wind is a forecast-model value on a 0.1° lattice, from model cells
     of 2 km or more, with no terrain correction;
   - nothing in the pipeline resolves shelter behind land at sub-kilometre
     scale or channelling in narrow sounds;
   - gusts do not enter routing;
   - real wind near land and in narrow water can differ from the forecast.

   It states no effect size, does not attribute anything to a lee effect
   (§1.4), does not claim the forecast over-reads near every coast (the model
   carries the regional gradient, §1.5), and claims no chart authority. Both
   languages get a claim audit. If the land-cell default stays (question
   below), the caveat may add that near-coast wind can come from an adjacent
   land model cell and then tends to read lower.
2. Defer options 1 and 2 behind the rerun in §4.
3. Separate question for the maintainer: keep Open-Meteo's `land` cell
   default or request `cell_selection=sea`? The default reads near-coast
   water TWS at a median 0.861 of `sea` (§1.5). That is the conservative
   error only for ETAs with the motor off, or while sail speed stays above
   the sail-speed floor; with the motor on, a lower TWS can flip a leg to
   motor at the wind-independent motor speed (6.5 kn by default) and make
   the plan faster. It also feeds
   `leg.twsKn`, which the reef suggestion reads, adding to the
   under-reefing bias the README already states for gusts. A switch needs
   a provenance marker (the stored `model` string would not change) and a
   choice between sending the parameter only and storing the returned cell
   coordinates (the latter changes `WindGrid` and owes a sweep). Either
   way, sending `cell_selection` explicitly would stop an upstream default
   change from silently changing the wind.

## 3. Considered and rejected

- **1a/1b/1c lee TWS penalty** (precomputed layer, per-node ray, lazy
  layer): needs a fetch curve the verdict cannot give; a fetch-keyed
  penalty double-counts the regional gradient the model already carries;
  with the motor on, a cut below the sail-speed floor can make a plan faster.
  1a's full-resolution layer is 9.4 MB per direction bin, over the
  per-file precache cap once combined; 1b adds a mask ray per expanded node
  at unmeasured cost; 1c holds about 9.4 MB per used bin per worker.
- **2 soft cost away from land upwind, now:** the §0.5 gate is unmet, and
  within legs the regression shows no direction dependence (§1.4), so a
  cost keyed on land upwind may target the wrong variable. Deferred, not
  discarded.
- **3 finer model or denser lattice:** finer models requested by their own
  id stop at 2.5 days or less, against the 6-day horizon; `dmi_seamless`
  continues on ECMWF IFS, which would replace ICON-EU for days 3–6, a model
  choice this spike did not evaluate. A 0.05° lattice is 1,215 points, more
  weighted calls in one request than the free tier's 600 per minute, and the
  app has no request splitting. The measured gains do not settle it either:
  the app's own model on a 4 × denser lattice changes `Δ` by −15 % in `land`
  mode and +6 % in `sea` mode; DMI HARMONIE by −35 % (−52 % on the strict
  set, §1.3).
- **5 `cell_selection=sea` inside #1894:** it barely moves `Δ` (by 0.007)
  and changes the wind the router sees near land, against keeping near-coast
  TWS low, which §2 finds conservative only for motor-off ETAs or above the
  sail-speed floor; that is the maintainer's call (§2).
- **6 interpolate only from water lattice points, or move points onto
  water:** unmeasured; in `land` mode water points would still be answered
  from land cells; owes a sweep that uniform-wind arms cannot exercise.
- **Do nothing:** no caveat about near-coast wind exists today (the only
  near-coast caveat is the waves legend's "coarse near coasts"), and one
  costs no sweep, asset or request.
- **Defer alone:** right for 1 and 2, but ships no disclosure meanwhile.
- **A sail-only option-2 factor:** would make motor edges rank cheaper
  wherever land is upwind.
- **A constant-height shelter rule:** coastal barrier height varies 4–9 ×
  (§1.6).
- **Caveat copy naming a lee effect, an effect size, or a near-coast
  over-read:** not supported (§1.4, §1.5).
- **Fitting any coefficient before the wind source is fixed:** the wind
  request (`services/openMeteo.ts`) is outside the #282 closure, so a later
  change of model, lattice or cell selection would stale a coefficient with
  no gate firing.

## 4. What would reopen this

Option 2, then option 1, reopens only if a rerun passes §0.5 as committed,
with these additions committed to this spike before any new track is read:

- a motoring rule that catches a leg like the `R` 1.26 one, and `Δ` ≥ 0.10
  after dropping any single leg (strict, without the fast leg, it is 0.095
  today);
- the strict rerun's interval also excludes 0;
- within legs, land upwind costs more than land downwind, with separate
  intervals, outside water under 1 nm wide (if this fails while the gate
  holds, the follow-up is a narrow-water or current disclosure, not a lee
  model);
- the between-leg equal-proximity control has the same sign in every trip;
- the −90° placebo's overlap with upwind-short fixes is resolved;
- trips span more than one month;
- the wind source (model, lattice, cell selection) is fixed before any fit.

Option 1 must also show an effect beyond the regional gradient the model
carries, and ship with a test that it cannot make a motor-on plan faster
through the sail-speed floor; it must handle the reef suggestion, the
motor-off `calm-without-motor` reclassification (#282) and the polars'
non-monotone 20 → 25 kn columns (the genoa
tables especially). Option 2 must use a geometry-only factor on
all edge kinds, guard against steering toward land downwind, and add a
sweep arm with the setting on.

Option 3 reopens if a model covering the full 6-day horizon shrinks `Δ` by
≥ 50 % on the same sample set. Within 0–48 h `icon_seamless` already serves
ICON-D2, so there option 3 means a denser lattice, which must first fit the
free-tier request budget (one app fetch costs 322 weighted calls).

Data that would help: at least five trips with both near-shore and
open-water legs, outside October, with engine on/off noted per leg. The four
trips here are all the tracks available (§1.9), so these would have to come
from other logs.

## 5. Evidence

- Open-Meteo behaviour: its server source (`open-meteo/open-meteo` at
  `03d62919`, `ForecastapiController.swift`, `Icon.swift`) and website docs
  (`open-meteo/open-meteo-website` at `eae13874`), both read 2026-10-26.
- App pipeline: `services/openMeteo.ts`, `lib/wind.ts`, `lib/polar.ts`,
  `routing/isochrone.ts`, `lib/reefSuggestion.ts`, and the #282 closure
  (`closure.mjs files`, run 2026-10-26).
- Tracks, scripts and per-fix tables stay in the session scratchpad and are
  not committed (§0.1). §0 and §1.2 specify the pipeline, so a rerun
  re-implements it; §1.4 states each view's definitions but not every
  implementation detail.
