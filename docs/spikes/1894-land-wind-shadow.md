# Spike #1894 — land blocking or disturbing the wind (lee, shadow, channelling)

- **Issue:** #1894
- **Date:** 2026-10-26
- **Status:** In progress. §0 is the pre-registration, committed before any
  track result was computed; the rest is filled in later commits.

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

Five uploads, three byte-identical: three distinct trips, all October 2026,
Als / Flensburg Fjord area, 75,746 fixes at 1 Hz, about 83 nm. Wind was
fetched on 2026-10-27 with `past_days`; the 2026-10-26 attempt hit
Open-Meteo's daily quota on the session's outbound IP.

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
rerun: 32,085 (42.4 %), 20 legs. All waiting fell inside harbour zones.

Implementation choices §0 does not fix, all checked for effect (§1.6):

- A window must span ≥ 24 s. A first guard of ≥ 28 s cut runs on
  millisecond timestamp jitter (3–5 % of full windows read 27.98 s); it was
  relaxed before any result was read.
- A turn event compares the 30 s windows before and after a fix, each moving
  ≥ 15 m; ± 60 s is excluded around every event.
- "Sustained" means an unbroken per-fix run; legs split at gaps > 2 s (never
  fired: no gap exceeds 1.1 s).
- Omnidirectional distance to land: 36 bearings, capped at 2 nm.
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

`Δ` (open water minus short fetch), on the same §0.3 sample set:

| Wind paired | All legs | Without the fast leg |
|---|---|---|
| App request (`land` cells) | 0.148 | 0.102 |
| App request, strict rerun | 0.143 | 0.095 |
| `cell_selection=sea` | 0.140 | 0.109 |
| `cell_selection=nearest` | PENDING | PENDING |
| ICON-D2 on a 0.025° lattice | 0.125 | 0.087 |
| DMI HARMONIE on a 0.025° lattice | PENDING | PENDING |

- `Δ` is positive in every trip under every pairing (per trip 0.05–0.23).
- The fast leg: one open-water leg of 1,115 fixes sails at `R` 1.26 (SOG
  about 8.8 kn on a broad reach in about 11 kn of model wind). Engine,
  current or model under-reading; neither cap in rule 4 reaches it. It is a
  gap in the rule, shown as a sensitivity, not excluded after the fact.
- With three trips the bootstrap "95 % interval" is just the per-trip
  minimum and maximum (10 distinct resamples).
- Open-water level: the boat sails at 0.77 of the table (§1.7).

### 1.4 Is the deficit a lee effect?

Not shown. The controls disagree:

- Direction placebo (§0.5): downwind fetch `Δ` 0.067 and +90° `Δ` 0.054 are
  below half the upwind `Δ`; −90° `Δ` is 0.115, but 87 % of its short-fetch
  fixes are the same fixes as upwind-short, and 73 of its 2,000 bootstrap
  draws are undefined (one trip has no −90° short-fetch value).
- Between legs, at equal proximity (land within 0.25 nm in any direction),
  land-upwind fixes average `R` 0.607 against 0.731 with land downwind,
  lower in all three trips. This favours a lee effect.
- Within legs (leg fixed effects, 120 s blocks), land within 0.5 nm upwind
  costs `R` 0.035–0.054 and land within 0.5 nm downwind costs 0.034–0.048:
  no direction dependence. On the strict set the upwind cost is 0.015–0.020
  with intervals including 0. The within-leg deficit appears only in water
  under 1 nm wide (58 % of upwind-short fixes are in water under 0.5 nm
  wide), where current (#18's spike quotes the harbour pilot on up to 3 kn in
  Alssund), traffic and caution are alternative causes.
- Within TWA bands the deficit stays positive in every trip: 0.068 at
  45–80°, 0.133 at 80–120°, so the TWA mix does not explain it.
- Wind-sampling artefacts cannot create it: zeroing `Δ` would need
  near-shore model TWS 25–30 % too high, and every variant tested moves the
  other way. A 10–20° TWD error leaves `Δ` ≥ 0.11.

### 1.5 The wind the router sees

Model-only check on the app's own 322-point lattice, 144 hours, 22–27
October 2026 (§0.7.2):

- The app omits `cell_selection`, so Open-Meteo answers in `land` mode. At
  water lattice points with land within 2 km (44 points), 75 % are answered
  from a land cell, and their TWS is a median 0.861 of the `sea` answer
  (10th percentile 0.771). Far from land the ratio is 1.000.
- Correction to §0.7.1: the expected bias toward zero did not occur. On these
  tracks the land-answered corners sat mostly under open-water fixes (all
  four corners land-answered for 61 % of open-water fixes, 2 % of
  short-fetch fixes), so the land mode raised `Δ` by 0 to 0.015.
- The model already carries a fetch gradient: at water lattice points,
  TWS divided by that hour's median is 0.68–0.85 with under 2 nm of upwind
  fetch, 0.98 at 4–10 nm and 1.07–1.09 beyond 10 nm (Spearman ρ ≈ 0.67);
  `sea` mode shows the same shape. This is the regional, kilometre-scale
  gradient. Sub-kilometre obstacle lee (§1.6) is resolved nowhere in the
  pipeline.
- Over this area `icon_seamless` serves ICON-D2 (0.02°, 0–48 h) and its
  rapid-update run at the highest priority; ICON-EU (7 km) takes over beyond
  48 h. Open-Meteo applies no downscaling to 10 m wind. Answers come from
  native-grid cells a median 0.8–0.9 km from the requested point. (Open-Meteo
  server source, `ForecastapiController.swift` and `Icon.swift`.)
- Finer models covering the area (DMI HARMONIE 2 km, MET Nordic 1 km, KNMI 2
  km, AROME France HD 1.5 km, UKMO 2 km) all stop at 2.5 days or less,
  against the app's 6-day horizon.

### 1.6 Physics, terrain, verification

- Lee physics, from search summaries only (every literature host was blocked
  by the session's network policy): porous windbreaks shelter to about 10
  obstacle heights (design) and 25–30 (maximum); offshore flow recovers over
  tens of kilometres. Sailing rules of thumb (10–20 × height) have no traced
  source. No measured channelling figure exists for any Danish strait.
- Terrain (Copernicus GLO-30 DSM, 9.4–11.0° E): the highest land within 500 m
  of the coast is 4.3 / 17.1 / 38.8 m at the 10th / 50th / 90th percentile,
  so 10–30 height lee lengths run from about 40 m to 1.4 km: below the
  0.1° lattice, but 1–30 mask cells. Height varies 4–9 × along the coast,
  so a constant-height rule would be off by that factor.
- Verification (adversarial, Phase 3): the Python pairing matches
  `WindField.sample` and `Polar.speedKn` to Float32 precision on all kept
  fixes; an independent exact-grid fetch moves `Δ` from 0.148 to 0.147; an
  independent kinematics recompute differs by ≤ 0.06 kn SOG; the statistics
  reproduce exactly. A mutation battery of implementation choices keeps `Δ`
  at 0.140–0.161 with all per-trip signs positive.

### 1.7 Polar check (report only, §0.6)

Posted on #1894. Every table cell has fewer than three trips, so no shape
finding qualifies for an issue.

## 2. Recommendation

Pending.

## 3. Considered and rejected

Pending.
