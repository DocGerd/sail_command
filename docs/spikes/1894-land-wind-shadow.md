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

## 1. Findings

Pending.

## 2. Recommendation

Pending.

## 3. Considered and rejected

Pending.
