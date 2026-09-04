# Departure-time comparison — design

Status: **approved** (maintainer, 2026-09-04)
Covers: #356
Milestone: v0.21.0

#356's own body is unusually complete — it carries measured solve costs, a
five-product prior-art survey, and a proposed shape. This document does not
restate it. It records the decisions that body left open, and the one
measurement taken to settle the largest of them.

**Already split out:** the "restrict the motor to maneuvering only" companion
request is now **#923** (Backlog, `status: blocked`). Nothing here depends on it.

## 1. The blocker is cleared

#356 calls itself "Blocked-ish on #340" — the planner progress bar capping
around 5% and resetting mid-plan. **#340 is closed and the fix is verifiable in
code**: `usePlanFlow.ts`'s `PlanningState` is now a phase union
(`idle` / `fetching-wind` / `routing{sailId,index,total}` / `probing-depth` /
`error`), not a percentage, and its own comment names the removed
`simulatedToMs`/`FORECAST_HORIZON_MS` percentage as the #340 defect.

This matters because #356 states that "progress and cancel are mandatory at
these runtimes", and that "a 5-minute operation behind a broken progress bar is
worse than no progress bar". That objection no longer applies.

## 2. Decisions

### 2.1 Explicit invocation. Never an automatic scan.

The router already runs twice per plan (one solve per rig), and #356's own
measurement puts a 43 NM passage at ~23.5 s median per solve. So a naive
N-window scan costs `N x 2 x ~23.5 s` — about **4.7 minutes at N=6**, on a dev
machine, inside a browser Worker.

An operation with that cost must be something the user asks for, with visible
progress and a working cancel. This is also what every product in #356's survey
does: all of them use a small number of discrete solves, and both qtVlm and
PredictWind deliberately cap N.

### 2.2 Scan a SINGLE rig — and it must be the genoa. This was measured.

#356 proposes halving the cost by scanning one rig, then running the normal
two-rig solve only for the window the user picks. It flags the risk itself:
*"scanning on one rig risks ranking windows by the wrong rig. Worth measuring
whether the rig recommendation actually flips across departure hours before
assuming it is safe."*

**Measured 2026-09-04**, real solver against the real committed mask and polars,
`planRoute()` called directly, with a deliberately **time-varying** wind field
(hour-indexed sin waves, 3-25 kn, direction swinging +/-40 deg). A uniform field
was rejected for this purpose: it would make departure hour irrelevant by
construction, so a clean "no flips" result would have been an artifact of the
fixture rather than a fact about the router.

| Route | Hours probed | Decided flips to fock |
|---|---|---|
| Flensburg->Gluecksburg (~4 NM) | 8 + 12 | **0** |
| Langballigau->Sonderborg (~8 NM) | 8 | **0** |
| Flensburg->Bagenkop (~43 NM) | 3 | **0** |

Findings, in the order they matter:

1. **Ranking is what counts, and it was identical.** Ranking the departure
   windows by a **genoa-only** scan produced a **byte-identical ordering, at
   every position**, to ranking by the true two-rig best — on both moderate-wind
   routes at the full N=8. This is the decision-relevant result: flipping is not
   the hazard, *mis-ranking* is.
2. **Fock-only is NOT equivalent.** It matched the top pick on both routes but
   differed in adjacent-position swaps lower down. The asymmetry is real and is
   why this decision names a rig instead of saying "either".
3. **No decided flip occurred at all.** The raw minimum changes label often, but
   no comparison clearing `RIG_TIE_BAND_MS` (60_000 ms, pinned at
   `planRoute.test.ts:333`) ever favoured fock across 23 hour-probes up to
   TWS 25 kn. Genoa's polar edge at TWS <=10 is up to +0.25 kn; fock's appears
   only at TWS >=25 and is <=0.2 kn — smaller, so it never clears the band.
   Decided genoa wins ran 0.90x-2.87x the band; everything else 0.00x-0.97x,
   i.e. genuine noise.

**Aperture — state it wherever this decision is cited.** Two routes, synthetic
(not live Open-Meteo) wind, no via points, the Salona 45 polar pair only, and
the 43 NM route got only 3 hours of which one errored. That is narrow enough
that a real forecast could still surface a case this missed. The decision is
**safe on the evidence available**, not proven in general.

**Consequence for implementation:** the scan is genoa-only, and that is a
correctness constraint carrying a measurement behind it — not a performance
shortcut a future refactor may quietly generalise to "whichever rig". If the
scan is ever changed to fock, or to "the boat's default rig", this measurement
must be re-run first. Say so at the call site.

### 2.3 Small N, user-chosen step, bounded by the real horizon

N of 4-8 at a step of 1 h / 3 h / 6 h. The upper bound is not a preference: the
forecast horizon is `FORECAST_DAYS = 6` (`services/openMeteo.ts`) from **fetch**
time, and a candidate departure that outruns the grid is a legitimate per-window
outcome, not an error.

**One fetch covers the whole search space.** #356 establishes this and it is the
single most encouraging fact about the feature: a `WindGrid` is three
`Float32Array`s totalling roughly 320 KB, so evaluating N departure times means
**one grid re-sliced at N offsets** — never N fetches and never N grids.

### 2.4 Output is a ranked list of cards, not a matrix

Prior art is unanimous where it is relevant: the mobile-first products chose a
list. Savvy Navvy — the closest analogue, being mobile and small-screen — uses a
scrollable list of route bars rather than a heatmap. A ranked list of departure
cards also fits this app's bottom sheet, which a matrix does not.

Each card carries: departure time, ETA and duration, **motor %**, and wind
character. Motoring is a first-class column, not an afterthought — that is what
the request asked for, and it is what qtVlm's Comparator and Savvy Navvy's
line-styling both do. `motorFraction` / `motorPct` already exist in
`lib/resultSummary.ts`; this is a rollup of data the app already computes, not
new solver work.

**Show `no-route` and `beyond-horizon` outcomes honestly, per window.** Hiding a
failed candidate would misrepresent the search as having considered fewer
options than it did.

### 2.5 What is NOT decided here

The **forecast-confidence decay** question. #356 notes that de-emphasising
windows beyond ~72 h is defensible but is thin as prior art — only LuckGrib
engineers for it explicitly. If it is done, it must be labelled as this
project's own choice, not an industry practice. This design does not include it.

## 3. Build order

Three PRs, sequentially dependent. The spec itself is a main-session step, not a
PR — spec edits under `docs/superpowers/specs/` are gated main-session-only.

| # | Scope | Independently shippable? |
|---|---|---|
| a | Scan orchestration + cancel; genoa-only; a button and a plain list | **Yes** — this is the honest minimum. **v0.21.0.** |
| b | Ranked-card UI: wind character, no-route / beyond-horizon presentation | Yes, on top of (a). Deferred to **v0.22.0 as #936.** |
| c | Two-rig confirm solve for the window the user picks | Yes, on top of (a). Deferred to **v0.22.0 as #937.** |

**v0.21.0 ships (a) only** — maintainer ruling, 2026-09-04. (b) and (c) are filed as
#936 and #937 against v0.22.0.

**(a) is the one to land first**, and it is a real product on its own. #356's
own survey makes that argument: OpenCPN has no native sweep at all — the user
reruns manually per Grib Time and compares saved routes — which proves a manual
floor is legitimate rather than a stub.

**The router needs no changes.** `PlanRequest.departureMs` already exists and is
already threaded to the solver; the wind grid already covers the window; the
ranking metric already exists. Principal files are
`app/src/state/usePlanFlow.ts` (orchestration and cancel), a new
`DepartureCompare` component, `app/src/components/PlannerPanel.tsx` (entry
point), `app/src/lib/resultSummary.ts` (reuse), and both i18n dicts.

`app/src/routing/isochrone.ts` and `app/src/routing/planRoute.ts` are **not** in
scope. If an implementation finds itself editing either, that is a signal the
design was wrong, not a step to take quietly — both are `IN_CLOSURE` for
`app/sweep/`, so touching them converts this from a UI feature into a change
owing three arm-sets of sweep (~90 min).

## 4. Open residuals

- **Cancel semantics mid-solve.** A solve in flight cannot be interrupted
  between rings today. (a) must define whether cancel abandons the current
  window's solve or waits for it to finish — and the honest answer may be "waits
  for the current one, skips the rest", which is still a working cancel.
- **The browser Worker is a third, unmeasured environment.** #356 says so
  explicitly: its figures are Node, and neither the CI multiplier nor a tight
  solve microbenchmark predicts a Worker's JIT warm-up, which a repeated scan
  would keep hot in ways a fresh Node process does not capture.
- **A candidate needing #53's relaxed-depth retry costs substantially more**
  than the measured figures, which came from routes that solved `ok` first try.
  N x 23.5 s is a floor, not an estimate.
- **The confidence-decay question** (§2.5).
- **Ranking correctly and recommending correctly are different claims.** §2.2's
  measurement establishes that a genoa-only scan picks the right WINDOW; it says
  nothing about which rig is faster ON that window once chosen. #937 closes that
  gap, and is also where a persistent disagreement would signal that §2.2's
  aperture was too narrow.
