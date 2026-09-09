# Spike #1163 — scoping the #295 coverage extension (Kolding/Middelfart/Fehmarn)

- **Issue:** #1163 (scoping spike for #295; refs #296, #1164)
- **Date:** 2026-09-09, measured at `035d662` (this branch's merge-base with
  `develop`)
- **Status:** Decision / Recommendation
- **Verdict:** **The bbox constant is duplicated in far more than four (or
  nine) places, and the enumeration matters more than the count — one of the
  newly-found sites (`app/vite.config.ts`'s `maximumFileSizeToCacheInBytes`)
  can silently drop an asset from precache with only a build warning, the
  same failure shape #245 already demonstrated for the mask.** Payload is
  measured, not extrapolated, for the two data-side assets that can be
  computed from constants (mask, wind lattice); the two that cannot
  (basemap, seamarks) are left honestly unmeasured. #245's own §3.3 finding
  (the real resolution cost is a runtime memory allocation, not an install
  byte count) applies here too, and one of the two size branches makes it
  1.71× worse. #296 already ruled how the basemap half of this should ship
  (per-region archives, not a widened monolith) and that ruling is
  unimplemented (#1164) — so the basemap piece of #295 is genuinely blocked,
  while the mask/harbours/seamarks pieces are not. Recommend: do not
  implement #295 as a single widened-bbox pipeline re-run; sequence the
  basemap growth behind #1164 and ship the rest only once the coupled-site
  list below is closed.

> Companions: [`245-depth-mask-resolution.md`](./245-depth-mask-resolution.md)
> (resolution-vs-payload tradeoffs this spike reuses directly) and
> [`296-lazy-load-map-data.md`](./296-lazy-load-map-data.md) (the basemap
> per-region-archive design this spike leans on for §6).

---

## 0. How this was produced

No pipeline command was run. No asset was rebuilt. Every number below comes
from either (a) a constant already committed to the repo, read directly, or
(b) arithmetic shown in full from those constants. `pipeline/data-src/` is
empty in this worktree (git worktrees do not carry a gitignored cache from
the main checkout), so the cached EMODnet raster's actual extent was **not**
independently inspected here — §4 says so explicitly and cites #1163's own
body for that specific claim instead of re-asserting it as newly measured.

---

## 1. The coupled-site enumeration

Enumerated by **claim shape** — what a site *asserts about* the covered
area — not by grepping for the four literals `54.3`/`55.3`/`9.4`/`11.0`.
A plain grep for those four substrings alone returns a large number of
tracked files, and most of them are incidental: a test picks `54.3` as a
convenient in-domain latitude for an unrelated fixture, not because it
encodes the covered area. §1.4 accounts for a sample of that bucket as one
group rather than as dozens of individual rows, because publishing every
"no-op" row would bury the dozen that matter.

### 1.1 Shape A — production or pipeline constants that must change

| Site | Symbol | What it holds today | Effect of #295 |
|---|---|---|---|
| `pipeline/build_mask.py` | `WEST, SOUTH, EAST, NORTH` | `9.4, 54.3, 11.0, 55.3` | Must move to the proposed box |
| `pipeline/build_mask.py` | `COLS, ROWS` | `2200, 2400` | **Not in #295's own table.** Held fixed → coarsens cells (§2.1); grown → grid changes shape (§2.2) |
| `pipeline/build_mask.py` | `WCS_URL` | Bakes `SOUTH/NORTH/WEST/EAST` into the EMODnet WCS query string | Must move with the bbox — and see §4, the cache trap |
| `pipeline/build_harbors.mjs` | `BBOX` (`build_harbors.mjs:69` at this commit — #295's own table cites line 11, stale) | `{ south: 54.3, north: 55.3, west: 9.4, east: 11.0 }` | Must move |
| `pipeline/build_seamarks.mjs` | `BBOX` + the Overpass `QUERY` string it builds | Same four numbers | Must move |
| `pipeline/extract_basemap.sh` | `BBOX` shell variable | `"9.4,54.3,11.0,55.3"` | Must move — but see §6, this is the one #296 already said should NOT just widen |
| `app/src/lib/gpx.ts` | `DATA_AREA` | `{ west: 9.4, south: 54.3, east: 11.0, north: 55.3 }`, hand-copied from `mask.meta.json` per the file's own comment | Must move; two production consumers (`parseGpx`'s GPX-import rejection, and `PlannerPanel.tsx`'s `isInViaDataArea` since #829) both inherit the new bound automatically once the constant moves |
| `app/src/services/openMeteo.ts` | `LATS`, `LONS` | `Array.from({length:11},...)` from 54.3 step 0.1; `Array.from({length:17},...)` from 9.4 step 0.1 → 187 points | Must grow to 14×22 = 308 points (§3) for a route into the new area to sample real wind there rather than the clamped edge |
| `app/src/components/MapView.tsx` | `MAX_BOUNDS` | `[[8.9, 54.05], [11.5, 55.55]]` | **55.55 < the proposed 55.6.** The camera would need to widen too, or Kolding/Middelfart's approach becomes visible on the basemap but un-pannable to at full zoom |
| `app/public/data/mask.meta.json` | `west/south/east/north/cols/rows` | Mirrors `build_mask.py`'s constants exactly (verified: `{west:9.4,south:54.3,east:11.0,north:55.3,cols:2200,rows:2400}`) | Auto-follows once `build_mask.py` is edited and the pipeline is re-run — not a site to hand-edit. Only one §1.3 twin actually reads this file off disk (`gpx.parse.test.ts`'s drift guard); the other §1.3 twins hardcode matching literals independently, without reading it |
| `app/src/lib/depthColor.ts` | `MASK_CELL_M = 46.67` (comment: `1.6 deg / 2200 cols at ~54.8N`) | A hardcoded cell-size approximation used for hatch-stripe sizing | Falsified outright by branch (a) (§2.1, cell size becomes ~60 m); left approximately true by branch (b) (§2.2) |
| `app/src/lib/depthColor.ts` | `HATCH_BAND_LAT_DEG = 54.8` (comment: `region centre; cos varies <1% over 54.3-55.3`) | A fixed-latitude cos approximation for the same hatch rendering | Measured here: at the CURRENT bounds the true max deviation of `cos(lat)` from `cos(54.8°)` across 54.3–55.3°N is **1.24%**, already over the comment's own "<1%" claim — a pre-existing, unrelated staleness, not something #295 introduces. At the proposed 54.3–55.6°N range (still centred on 54.8, i.e. not recentred), the deviation from 54.8 grows to **1.99%** at the new north edge. Low-severity: `depthColor.ts`'s own hatch-rendering invariant (pure-black RGBA, monotonically non-increasing alpha with depth) means this constant can only ever make the hatch cue MORE conservative, never produce false comfort, so a stale center latitude is a cosmetic banding-width error, not a safety one |
| `app/vite.config.ts` | `maximumFileSizeToCacheInBytes = 40 * 1024 * 1024` | A per-file Workbox precache cap | Not itself a bbox constant, but the site that decides whether ANY of the widened assets can even ship eagerly — see §2.5 |

### 1.2 Shape B — prose that describes the area (documentation-only)

These need a documentation update if #295 ships, but nothing breaks
mechanically if they lag:

- `CLAUDE.md`'s own project-description line (`in the Flensburg Fjord /
  Danish South Sea area (54.3–55.3°N, 9.4–11.0°E)`) — out of scope to touch
  in this spike per the brief, named here only because the enumeration would
  be dishonest without it.
- `docs/superpowers/specs/2026-07-14-sail-command-design.md` — the design
  spec's own Area row (`54.3–55.3°N, 9.4–11.0°E`) and its seamarks-bbox
  sentence. **Out of scope to edit here** (spec edits are a main-session,
  ask-gated act), but worth stating plainly: implementing #295 for real
  needs a spec amendment, not just a pipeline re-run — the design spec is
  this repo's declared source of truth and currently states the OLD area as
  fact.
- `docs/superpowers/specs/2026-07-22-waves-routing-design.md` — same area
  statement, same out-of-scope note.
- `ROADMAP.md` — under a bullet headed **"No open-ended or unbounded
  map-area expansion,"** states the current Sea area and that "growing that
  footprint is a real data-pipeline and app-size cost, not a toggle." The
  same bullet explicitly carves #295 out as the sanctioned bounded case: "A
  specific, bounded extension is already triaged and open in `Backlog`
  (#295) — this bullet declines an unscoped 'just cover more area' request,
  not that one." Direct support for this spike existing at all.
- `pipeline/README.md` — documents the bbox twice: once deriving the ~46 m
  cell size from `mask.meta.json`'s `cols: 2200, rows: 2400` and the bounds,
  and once describing the basemap extract's own bbox.
- `.claude/skills/pipeline-refresh/SKILL.md` — a committed, shared skill
  (not personal/gitignored tooling) documenting the harbour-curation
  constraint "inside bbox 9.4–11.0°E / 54.3–55.3°N".
- `docs/spikes/244-buoyed-fairways.md` and `docs/spikes/245-depth-mask-resolution.md`
  and `docs/spikes/296-lazy-load-map-data.md` each state the bbox as context
  for their own (already-decided) findings — historical record, not live
  coupling; not proposed for edit.

### 1.3 Shape C — test doubles that intentionally twin production

These are written to mirror the real constants for realism, and SHOULD move
in lockstep, but the mechanism differs per site:

- `app/src/lib/gpx.parse.test.ts`'s `'DATA_AREA (mask.meta.json drift
  guard)'` test — reads `mask.meta.json` off disk independently and asserts
  `DATA_AREA` deep-equals it. This is the ONLY structural drift guard found
  for any of these constants. It will fail loudly if `gpx.ts`'s `DATA_AREA`
  is not updated in lockstep with a rebuilt `mask.meta.json` — exactly the
  enforcement its own comment claims.
- `app/src/services/openMeteo.test.ts` — hand-writes literal `LATS`/`LONS`
  arrays (the file's own comment: "not the same `Array.from` formula
  `openMeteo.ts` uses... re-deriving via the identical formula would let a
  bug in the source's own bounds silently pass here too") and asserts the
  real `fetchWindGrid()` output's `lats`/`lons` equal them index-for-index.
  A genuine, load-bearing twin — confirmed non-vacuous by its own
  deliberate-independence comment.
- `app/e2e/seamarks.spec.ts`'s `SEAMARK_REGION = { lonMin: 9.4, lonMax: 11.0,
  latMin: 54.3, latMax: 55.3 }` — asserts every rendered seamark falls
  inside the app's stated data region. Would need updating, or it starts
  failing the moment a seamark inside the new area but outside the old
  literal renders.
- `app/src/lib/mapOrientation.test.ts` — a property test whose range is
  `fc.double({ min: 54.3, max: 55.3 })` with a comment citing "The app's
  chart region is 54.3-55.3 N (CLAUDE.md)". Would keep passing unchanged if
  left stale (it would just under-sample the new area, not fail), but its
  own comment would be wrong.
- `app/scripts/gen-docs-wind-fixture.mjs` is **partially coupled**. Its
  `LAT0 = 54.3` / `LON0 = 9.4`, each commented "must match openMeteo.ts's
  [LATS/LONS] domain start", do NOT need to move for #295 as proposed,
  because the proposal leaves the **south/west** edge unchanged. But the
  same file's `N_POINTS_LAT = 11` / `N_POINTS_LON = 17`, commented "must
  match openMeteo.ts's LATS.length"/"LONS.length" respectively, DO need to
  move — to 14 and 22, the exact lengths §1.1 says `openMeteo.ts`'s `LATS`/
  `LONS` become. Left as a site to revisit, not a site to leave alone.
- `app/src/test/fixtures.ts`'s default mask-builder parameters and
  `app/src/test/fakeMaplibre.ts`'s `getBounds()`/pixel-projection literals —
  both reuse the current bbox as their default synthetic geometry. Neither
  needs to change for #295 to be correct (they are self-consistent test
  doubles, not assertions about the real covered area), but a reviewer
  extending either file for #295-related tests should know they exist.
- `app/src/lib/depthColor.test.ts` — independently hardcodes `46.67` and
  `54.8` (own comment: "Independent re-derivation of screenPxPerCell,
  deliberately NOT importing hatchScreenPxPerCell"). Reds the REQUIRED `app`
  job under branch (a); invisible to the four-literal grep.

### 1.4 Shape D — incidental in-domain coordinates (left alone)

The following 26 files were read individually, from a `git grep -l` for the
four literals `54.3`/`55.3`/`9.4`/`11.0` over tracked files, excluding
`pipeline/data-src/` and `package-lock.json` — this is the set this spike
actually classified, not a claim that it is the grep's entire residual:
`app/src/App.test.tsx`, `app/src/components/AboutDialog.test.tsx`,
`app/src/components/AisTraffic.test.tsx`, `app/src/components/CompassControl.test.tsx`,
`app/src/components/DataLayers.test.tsx`, `app/src/components/DepthProfile.test.tsx`,
`app/src/components/PlannerPanel.marginal.test.tsx`, `app/src/components/RouteSummary.exposure.test.tsx`,
`app/src/components/SettingsPanel.test.tsx`, `app/src/components/layerOrder.test.tsx`,
`app/src/lib/aisGeoJson.test.ts`, `app/src/lib/depthGate.test.ts`, `app/src/lib/mask.test.ts`,
`app/src/lib/planExport.test.ts`, `app/src/lib/routeCorridor.test.ts`, `app/src/lib/routeGeoJson.test.ts`,
`app/src/lib/shallowExposure.test.ts`, `app/src/routing/legDistanceReconciliation.test.ts`,
`app/src/routing/planRoute.depthComfort.test.ts`, `app/src/routing/planRoute.shallow.test.ts`,
`app/src/routing/postprocess.test.ts`, `app/src/services/aisStream.test.ts`,
`app/src/services/db.test.ts`, `app/src/state/useAisTraffic.test.tsx`,
`app/src/state/useMapViewport.test.tsx`, `app/e2e/plan.spec.ts`. Each reuses
`54.3`, `55.3`, `9.4` and/or `11.0` as a convenient literal (a fake mask
bound built locally rather than imported, an arbitrary in-domain lat/lon for
an unrelated waypoint or AIS-target test, a `9.4 nm` distance that happens
to share digits with the longitude). None of them asserts anything about
the real covered area, and none needs to change for #295 to be correct. The
one grep hit worth a specific note: `app/e2e/plan.spec.ts` types the literal
latitude `'60'` to test the DATA_AREA-rejection message — 60°N is well
outside both the current AND the proposed north edge (55.3/55.6), so this
test does not flip under #295.

### 1.5 What #295's own table gets right and wrong

#295's table cites four sites and one stale line number
(`build_harbors.mjs:11`; the constant sits at `:69` at this commit — anchor
on the symbol, not the number). #295's step 5 already asks to re-check
`MAX_BOUNDS`; what it does not notice is that its own numbers already decide
the answer. Its "already wider than the data" is true of today's data.
Against the proposed box the north edge is short (55.55 < 55.6) and the east
edge lands exactly on it (11.5 == 11.5), leaving zero margin where there is
0.5 deg today. #1163's own retriage adds five more sites; this spike's
enumeration finds more still — `MapView.tsx`'s `MAX_BOUNDS`,
`depthColor.ts`'s two constants, `vite.config.ts`'s precache cap, the
`openMeteo.test.ts`/`seamarks.spec.ts` twins, and the documentation sites in
§1.2 are all additions beyond what either issue names. The count is not
stable across retriages; what is stable is the CLAIM-SHAPE method used to
find it.

---

## 2. Payload — measured arithmetic, not extrapolation

Using `app/src/lib/mask.ts`'s own meters-per-degree constant (`111_320`,
`snapToNavigable`) for consistency with the app's own approximation.

### 2.1 Branch (a) — hold `COLS`/`ROWS` fixed at 2200×2400

New extent: 2.1°×1.3° (vs. current 1.6°×1.0°). Cell count is **unchanged**
(5,280,000 — `mask.bin` stays 5,280,000 B), but cell size grows:

```
cell_lon = 2.1° × 111_320 × cos(54.95°) / 2200 ≈ 61.02 m
cell_lat = 1.3° × 111_320 / 2400              ≈ 60.30 m
```
(current: 46.67 m / 46.38 m — matches `depthColor.ts`'s own `MASK_CELL_M`
comment exactly, which is the control that this arithmetic is doing the
same thing the codebase already does.)

### 2.2 Branch (b) — preserve resolution

"Preserve ~46 m" means preserving the DEGREE STEP, not solving for a target
metre size (cell size in metres already varies slightly by axis and
latitude even today). Current steps: `lonStep = 1.6/2200`, `latStep =
1.0/2400`.

```
ROWS_new = 1.3 / (1.0/2400) = 3120                    (exact)
COLS_new = 2.1 / (1.6/2200) = 2887.5                  (NOT an integer)
```

`COLS` must round to an integer — 2888 was used here. At `COLS=2888,
ROWS=3120`:

```
cells = 2888 × 3120 = 9,010,560
mask.bin = 9,010,560 B = 8.593 MiB = 1.7065× today's 5,280,000 B
```

This reproduces #1163's own cited "~9.0M cells / ~8.6 MiB / 1.71×" exactly.
**Consequence #1163 does not mention:** rounding `COLS` to an integer means
the new `lonStep` (2.1/2888 = 0.00072715°) is not bit-identical to the
current one (1.6/2200 = 0.00072727°) — a 0.017% difference. So even branch
(b) does **not** guarantee byte-identical cell values for the pre-existing
54.3–55.3°N/9.4–11.0°E region; it approximately preserves resolution, not
exactly. Two ways to close that gap: let `EAST` float very slightly (to
`9.4 + 2888×0.00072727 ≈ 11.50036°E`, a ~23.2 m overshoot past the requested
11.5, to make `COLS` exact) or accept the drift and re-verify. Either way,
per §2.3 below, a full `verify_mask.py` run against the rebuilt mask is
required regardless — this is not a shortcut around that.

### 2.3 Which branch #245 forbids

#1163's own body reads #245 as having "measured that moving this resolution
disconnects `aabenraa` and `augustenborg`." **That is not quite what #245
measured, and the direction matters.** #245 measured making cells *finer*
(23 m, 12 m) and found the mechanism is that a smaller cell stops
"borrowing" depth from neighbouring deeper water during resampling, so a
knife-edge harbour's blended depth drops by a decimetre or two — `aabenraa`
sits exactly on `3.0 ≥ 3.0`. Branch (a) here moves the OPPOSITE direction —
cells get *coarser* (46 m → ~60 m), which by #245's own mechanism should, if
anything, let a coarse cell borrow MORE from its neighbours, not less.
**#245 did not measure coarsening; the disconnection risk for branch (a) is
a prediction from the stated mechanism, not a finding.** What #245 states,
though, is the general rule that decides both branches regardless of
direction: `TOLERANCE_M` and `CONNECTIVITY_EXCEPTIONS_M` are
"resolution-coupled constants, not properties of the water," derived by
scanning gate depths against the 46 m mask specifically (#245 §2.2). So:

- **Branch (a)** changes resolution for the ENTIRE existing grid (not just
  the new area) and therefore reopens exactly the re-derivation #245's §2.2
  calls for — with an unmeasured, merely-predicted direction of effect.
- **Branch (b)** does not change resolution for the pre-existing region in
  the sense #245 tested (cell size stays ~46–47 m there, modulo the §2.2
  rounding drift above). It is still not free: `verify_mask.py` must be
  re-run regardless, because the new region has its own harbours never
  checked at any resolution, and the rounding drift in §2.2 is a real,
  if tiny, perturbation of the old region's cell boundaries.

Either branch owes a `verify_mask.py` run before shipping. **Branch (b) is
the one this spike recommends, on this basis alone.**

### 2.4 The payload dimension neither #295 nor #1163 name: `cellsConnected()` memory

#245 §3.3 already established that this repo's real resolution-vs-cost
constraint is not install bytes — it's `NavMask.cellsConnected()`'s
per-call allocation (`Uint8Array(rows*cols) + Int32Array(rows*cols)` =
`5×N` bytes), still unfixed at this commit (verified: the queue is still
sized `new Int32Array(rows * cols)` in `app/src/lib/mask.ts`, not the
frontier size #245's recommendation #3 called for). At today's 5,280,000
cells that's 26.40 MB per call, up to 5 calls per solve (#245's own count).

- **Branch (a)** leaves `N` unchanged (still 5,280,000) — this cost is
  UNAFFECTED.
- **Branch (b)** grows `N` to 9,010,560 — **45.05 MB per call, 1.71× worse**,
  compounding an already-known, already-unfixed inefficiency.

This is a real argument FOR branch (a) that §2.3 does not capture — the two
branches trade off resolution-change risk against memory-allocation growth
in opposite directions. Recommendation (§7) resolves this by pairing branch
(b) with #245's own already-recommended, independent `cellsConnected` fix,
rather than picking branch (a) to dodge a problem that already has a
tracked fix.

### 2.5 Basemap and seamarks: unmeasured, and why that's the honest answer

#295's own body says vector-tile volume "tracks coastline and settlement
density, not area," and explicitly declines to extrapolate — this spike
agrees; doing so would need running
`extract_basemap.sh`/`build_seamarks.mjs` against the new bbox, which is
out of scope (no pipeline command was run). One measurable consequence of NOT
knowing the number, though: `app/vite.config.ts`'s
`maximumFileSizeToCacheInBytes = 40 * 1024 * 1024` (41,943,040 B) is a
**per-file** Workbox precache cap. The current basemap archive is
27,201,789 B — headroom of 14,741,251 B (≈14.06 MiB) before a single
archive silently drops out of the precache manifest with only a build
warning (the exact failure #245 §3.2 already demonstrated for a 12 m mask:
"the oversized entry is filtered out of the manifest and a `"… won't be
precached"` string is pushed onto `warnings`... there IS a signal, it
simply is not a failure"). A naive area-ratio projection (27,201,789 B ×
1.7065 ≈ 46.4 MB, using §2.2's precise ratio rather than the rounded 1.71)
would land ABOVE that cap — stated explicitly as a naive,
almost-certainly-wrong projection method (vector density ≠ area density),
not a prediction, but as the reason the basemap number needs to be
MEASURED, not guessed, before this ships: guessing wrong in the direction
of "it'll be fine" produces a silent, warning-only loss of offline basemap
coverage for exactly the newly-added region, discovered only by a user
offline in Fehmarn.

---

## 3. The wind lattice and `bracket()`'s silent clamp

### 3.1 Confirmed: `bracket()` clamps, never throws

Read directly (`app/src/lib/wind.ts`):

```ts
function bracket(xs: number[], x: number): { i: number; f: number } {
  if (x <= xs[0]) return { i: 0, f: 0 };
  ...
  if (x >= xs[n - 1]) return { i: n - 2, f: 1 };
  ...
}
```

An out-of-range latitude or longitude silently resolves to the nearest edge
lattice value. No throw, no `NaN`, no signal.

### 3.2 Is this reachable in production today?

`WindField.sample(p, tMs)` is `bracket()`'s only caller, and has exactly
five production call sites (found by grepping every non-test `WindField(`
construction and `.sample(` call):

- `app/src/routing/planRoute.ts` (via `isochrone.ts`'s `wind.sample(from,
  node.tMs)`) — `from` is a frontier node the isochrone search has already
  accepted, which requires it to have passed the mask's own navigability
  check first. The search cannot advance the frontier to a position outside
  the mask's grid, so this path samples only mask-internal positions.
- `app/src/components/DepthProfile.tsx` — samples along an
  ALREADY-COMPUTED route's leg positions, which are themselves the output
  of the mask-constrained solve above.
- `app/src/lib/routeGeoJson.ts` — same: samples along route-leg geometry
  for barb rendering.
- `app/src/routing/postprocess.ts`'s `tryMerge` (`wind.sample(b.start,
  b.startTimeMs)`, reached from `planRoute.ts`'s `mergeCollinearLegs(res.legs,
  ...)`) — `b` is a leg of `res.legs`, the solver's own already-solved
  output, so `b.start` is the same kind of mask-constrained point as the
  other three.
- `app/src/components/DepartureCompare.tsx` — samples at `plan.request.origin`
  (checked directly: `candidateCard(candidate, rank, windField,
  plan.request.origin, lang, t)`), the RAW requested origin, not
  `plan.snappedOrigin`.

The first four are inert by construction. The fifth is where the clamp is
genuinely reachable, narrowly: `NavMask.snapToNavigable`
searches up to `maxRadiusM = 300` m from the requested point, so a plan can
succeed with a requested origin up to ~300 m outside the mask's grid
boundary (≈0.0027° latitude, ≈0.0047° longitude at this latitude) if a
navigable cell exists within that ring just inside the boundary.
`plan.request.origin` in that case is the raw, unsnapped point — outside
the wind lattice too, since the lattice and mask domains are identical
today (`mask.meta.json` == `DATA_AREA` == `openMeteo.ts`'s `LATS[0]/[-1]`
and `LONS[0]/[-1]`, all verified equal). `DepartureCompare.tsx`'s wind
character badge for that plan would then clamp to the lattice edge rather
than sample ~300 m further out — a bounded, today-live gap, but with
negligible practical effect at the CURRENT domain size (wind fields are
spatially smooth over hundreds of metres, and the badge is descriptive —
"fresh SE breeze" — not routing-critical).

**Framing, precisely:** the clamp is inert by construction for the solver
and route-rendering paths, and reachable but low-consequence for the one
descriptive-badge path, at TODAY's domain. What changes under #295 is not
that this narrow gap gets worse — it's that #295 requires editing the mask
domain (`build_mask.py`) and the wind-lattice domain (`openMeteo.ts`)
**independently, in two files with no shared source constant and (checked:
no test) coupling them** — confirmed by grepping every test file that reads
`mask.meta.json`; `openMeteo.test.ts` is not among them. `gpx.parse.test.ts`
has exactly this drift guard for `DATA_AREA`, and nothing analogous exists
for the wind lattice. A momentary divergence during implementation (mask
widened, wind lattice not yet widened, or vice versa) would silently clamp
every wind sample near the new edge for however long that divergence lasts,
with zero test failure and zero console output (`routing/` and
`usePlanFlow.ts` are documented to carry zero `console.*` calls by design).

### 3.3 Recommendation on the clamp specifically

Two independent, cheap changes, worth doing **regardless of #295's own
disposition**, because the coupling gap they close exists today:

1. **A structural drift guard**, mirroring `gpx.parse.test.ts`'s existing
   `DATA_AREA`-vs-`mask.meta.json` pin: assert `openMeteo.ts`'s
   `LATS[0]/LATS[-1]/LONS[0]/LONS[-1]` equal `mask.meta.json`'s
   `south/north/west/east`. This is the change that would have caught a
   mid-implementation #295 divergence loudly, at test time, for the cost of
   one new test.
2. **A domain-coverage assertion at `WindField` construction** (once, not
   per-sample) checking the grid's `lats`/`lons` bounds cover the mask's
   `meta` bounds, throwing if not. This is the guard-asymmetry-correct
   version of "make the clamp fail loudly": it turns a genuine divergence
   into a loud, single, plan-load-time failure instead of either a crash
   inside the isochrone hot loop (a per-sample throw in `bracket()` itself
   would do that, given the `DepartureCompare.tsx` 300 m case above is not
   a bug worth crashing over) or a silent per-point clamp.

Recommend (1) as an independent, small PR, unconditional on #295's fate.
Recommend (2) as an explicit line item in whatever implements #295, exactly
because that is the moment the two domains are edited by hand in two
different files.

---

## 4. The `data-src` cache trap

Confirmed by reading `pipeline/build_mask.py` directly:

```python
def fetch(url, dest, headers=None):
    # NOTE: cache check is existence-only; delete pipeline/data-src/*
    # to recover from an interrupted download.
    if dest.exists():
        print(f"cached: {dest.name}")
        return
    ...

WCS_URL = (
    "https://ows.emodnet-bathymetry.eu/wcs?...
    f"&subset=Lat({SOUTH},{NORTH})&subset=Long({WEST},{EAST})&format=image/tiff"
)
...
fetch(WCS_URL, SRC / "emodnet_dtm.tif")
```

`fetch()`'s cache check is existence-only (its own comment says so), and
`WCS_URL` bakes the current `SOUTH/NORTH/WEST/EAST` into the query string.
So: if `pipeline/data-src/emodnet_dtm.tif` already exists (as it will on any
machine that has run the pipeline before) and the bbox constants change,
`fetch()` prints `cached: emodnet_dtm.tif` and reuses the file fetched under
the OLD, narrower `WCS_URL` — silently building the new, wider mask from
data that does not cover the new area. #295's own step 2 ("preserve
`pipeline/data-src/`") is correct advice for the ~887 MiB download cache in
general and an active trap for this one file specifically. This spike did
NOT independently inspect the cached file's actual raster extent —
`pipeline/data-src/` is empty in this worktree — so the "confirmed clipped
to exactly the current box" claim is #1163's own retriage finding, cited
here rather than re-verified. **Anyone implementing #295 must delete
`pipeline/data-src/emodnet_dtm.tif` specifically (not the whole cache — the
land-polygon and Schlei-relation downloads are unaffected by the bbox) before
the first `build_mask.py` run against the new bbox.**

---

## 5. Great Belt: in, and largely for free

#295 leaves this as its open question and cites two figures: Kolding
~55.49°N, Middelfart ~55.51°N (driving the proposed north edge to 55.6°N,
North of Middelfart with margin), and Nyborg/Korsør at ~55.33°N as the
figure it associates with "the Great Belt." Using ONLY those figures (this
spike did not independently look up further Great Belt place coordinates):
**the north edge the Kolding/Middelfart requirement already forces (55.6°N)
exceeds #295's own cited Nyborg/Korsør latitude (55.33°N) by 0.27°.** So the
bbox growth needed for Kolding/Middelfart already reaches into the western
mouth of the Great Belt (Nyborg, Middelfart, and — on latitude alone —
Korsør) as a side effect, not as an independently-costed decision. The
"Great Belt in or out" question is therefore mostly a CONTENT question
(which harbours to curate, whether `verify_mask.py`'s connectivity check is
extended through the strait, whether seamarks are pulled for it), not an
AREA question — the water is already inside the bbox Kolding/Middelfart
alone requires. This spike cannot say whether the FULL strait east to
Storebælt Bridge and the Zealand shore beyond it needs MORE east-ward
extension than the proposed 11.5°E, since that would need place coordinates
this spike did not verify. **Recommendation: include the Great Belt's
WESTERN approach (Nyborg/Middelfart/Korsør) in scope, since excluding it
while shipping the Kolding/Middelfart bbox would mean the app shows basemap
and (if `MAX_BOUNDS` also widens per §1.1) lets a user pan and tap into
water it then refuses to curate harbours or route through — a confusing,
inconsistent product experience for no area savings.** Whether to extend
further east into the FULL Great Belt is a separate, genuinely open
question this spike leaves open, to be settled by measurement (harbour
coordinates, not recall) rather than by this document's guesswork.

On #295's other open question — extending south of 54.3°N for Fehmarn's
southern approaches — #295's own text gives Fehmarn's span as
~54.42–54.58°N. 54.3°N already sits 0.12° (≈13 km) south of Fehmarn's own
southern coast, i.e. the current south edge already has margin.
**Recommendation: no, don't move the south edge**, on #295's own cited
figures.

---

## 6. Dependency on #1164 / #296's basemap-split ruling

**#296 already ruled on exactly this scenario, and the ruling is more
specific than "keep everything eager":** its §3 ("Basemap: natively
chunkable, but not for free") states directly — "today's committed
54.3–55.3°N/9.4–11.0°E box stays a 'core' archive, unchanged; the area
extension ships as one or more additional, separately-named archives" —
and separately rules that mask/harbours/seamarks/polars stay eager and
monolithic — a ruling that is size-conditional and quantified, not
area-independent: its §3 mask section concludes "Given the mask is small
even after the extension (quantified in §9, item 2), this cost is not
justified by the savings." Read precisely, this splits #295 into two pieces
with two different answers:

- **Mask, harbours, seamarks growth (branches in §2.2 / #295's steps 1–4):**
  consistent with #296's ruling. Not blocked on #1164.
- **Basemap growth (`extract_basemap.sh`'s `BBOX`):** the OPPOSITE of what
  #296 already decided. Widening the single `extract_basemap.sh` bbox and
  rebuilding one bigger monolithic `basemap.pmtiles.png` is exactly the
  design #296 rejected in favour of a core-archive-plus-region-archives
  split — a split that is unimplemented (#1164, open as of 2026-09-09, "the
  basemap half is not started"). Doing the monolith-widening now would be
  throwaway work the moment #1164 ships, and risks the precache-cap failure
  mode in §2.5 in the meantime.

**Recommendation: #295 is NOT uniformly blocked on #1164.** The mask,
harbours and seamarks pipeline changes can proceed once the §1
coupled-site list is closed and §2's `verify_mask.py` re-run is clean. The
basemap piece specifically should wait for #1164's per-region-archive
mechanism (or, if the maintainer wants Kolding/Middelfart/Fehmarn basemap
tiles sooner than #1164 ships, they should be built as a SEPARATE named
archive using #296's already-designed shape, not by widening
`extract_basemap.sh`'s single `BBOX`) — building that mechanism is #1164's
scope, not this spike's, and not something to duplicate ad hoc inside #295.

---

## 7. RECOMMENDATION

1. **Do not implement #295 as "widen four bbox constants and re-run the
   pipeline."** The coupled-site list in §1 is wider than either issue's own
   count, and two of the newly-found sites (`MAX_BOUNDS`'s north edge,
   `maximumFileSizeToCacheInBytes`'s per-file cap) can silently produce a
   worse product than today's (an unreachable camera edge; a silently
   un-precached archive) if missed.
2. **Choose branch (b) — preserve resolution, grow the grid — over branch
   (a).** It is the branch that does not reopen #245 §2.2's `TOLERANCE_M` /
   `CONNECTIVITY_EXCEPTIONS_M` re-derivation for the entire existing grid
   (§2.3), at the cost of making the already-tracked, already-unfixed
   `cellsConnected()` memory allocation 1.71× worse (§2.4). Pair it with
   implementing #245's own recommendation #3 (size the BFS queue to the
   frontier, not `rows*cols`) as a prerequisite or companion PR, rather than
   accepting branch (a)'s untested resolution change to dodge a cost that
   already has a designed fix sitting unbuilt.
3. **Sequence the basemap growth behind #1164, not behind the rest of
   #295** (§6). Mask/harbours/seamarks are not blocked on it.
4. **Ship the two independent wind-lattice safety improvements from §3.3
   now, regardless of #295's timeline** — a `mask.meta.json`-vs-`openMeteo.ts`
   drift test (cheap, mirrors an existing pattern) and a domain-coverage
   assertion at `WindField` construction. Both close a real, if narrow,
   coupling gap that predates #295 and that #295 would otherwise widen the
   blast radius of.
5. **Measure the basemap and seamarks growth before committing to any
   bbox**, specifically checking the result against
   `maximumFileSizeToCacheInBytes` (§2.5) — do not extrapolate from the
   mask's area ratio.
6. **Widen `MapView.tsx`'s `MAX_BOUNDS` north edge** (55.55 → at least 55.6,
   with margin) as part of the same change.
7. **Include the Great Belt's western approach (Nyborg/Middelfart/Korsør) in
   scope** (§5) as a side effect of the Kolding/Middelfart bbox, and leave
   full eastward Great Belt extension as a separately-measured, still-open
   question.
8. **Do not move the south edge below 54.3°N** — #295's own cited Fehmarn
   figures already leave margin (§5).
9. **Re-run `verify_mask.py` against the rebuilt mask before considering any
   implementation done**, per §2.3 — required either way, and specifically
   watch for the `TOLERANCE_M`/`CONNECTIVITY_EXCEPTIONS_M` re-derivation
   #245 already flagged as owed by any resolution change.
10. **Promote §1.2's design-spec staleness to an explicit follow-up**: a real
    #295 implementation needs a spec amendment (main-session act), not just
    a pipeline re-run — the design spec currently states the old area as
    fact and is this repo's declared source of truth.

## 8. NOT RECOMMENDED — considered and rejected

| Option | Why it lost |
|---|---|
| **Branch (a): hold `COLS`/`ROWS` fixed, coarsen cells to ~60 m** | Changes resolution for the ENTIRE existing grid, reopening #245's `TOLERANCE_M`/`CONNECTIVITY_EXCEPTIONS_M` re-derivation with an unmeasured (only predicted) direction of effect on the existing knife-edge harbours (§2.3), for the sole benefit of leaving `cellsConnected()`'s memory cost unchanged — a cost that already has a designed, unbuilt fix (§2.4) making that benefit avoidable anyway. |
| **Widening `extract_basemap.sh`'s bbox to build one larger monolithic basemap archive now** | Directly contradicts #296's own already-decided per-region-archive design for exactly this scenario (§6); throwaway work once #1164 ships; risks the `maximumFileSizeToCacheInBytes` silent-drop failure mode (§2.5) with no measurement to rule it out. |
| **Treating #295 as uniformly blocked on #1164** | Over-broad — #296's own ruling only constrains the basemap piece; mask/harbours/seamarks are consistent with #296's ruling at #295's proposed 1.7x growth (§6), so blocking those on unrelated basemap-splitting infrastructure delays work that isn't actually coupled to it. |
| **Making `bracket()` throw on out-of-range input directly** | The one reachable production path (`DepartureCompare.tsx`'s raw `plan.request.origin`, §3.2) is a benign, bounded (~300 m) approximation, not a bug — throwing inside the hot per-sample function risks turning that harmless case into a crash. A one-time domain-coverage assertion at `WindField` construction is the guard-asymmetry-correct shape (§3.3). |
| **Extrapolating basemap/seamarks payload from the mask's area ratio** | #295's own body already rejects this (vector-tile volume tracks coastline/settlement density, not area) and this spike agrees; a naive projection is shown in §2.5 only to demonstrate why guessing wrong is dangerous, never adopted as an estimate. |
| **Extending the south edge below 54.3°N for Fehmarn margin** | #295's own cited Fehmarn coordinates (~54.42–54.58°N) already leave 0.12° of margin against the current south edge (§5) — no data supports moving it. |
| **Deciding the full eastward Great Belt extension in this spike** | Would need place coordinates (Storebælt Bridge, the Zealand shore beyond it) this spike did not independently verify — recorded as genuinely open rather than guessed at (§5). |

---

## 9. Invariants checked against this recommendation

- **`verify_mask.py`'s `KNOWN_DISCONNECTED` allowlist may only shrink, never
  grow to absorb a regression** (per #245's own already-established rule,
  reused here, not re-derived) — any new disconnection surfaced by a
  `verify_mask.py` re-run against a widened mask must be fixed or justified
  with a `CONNECTIVITY_EXCEPTIONS_M` entry carrying real evidence, exactly
  as `augustenborg` and `marstal` already do, never allowlisted away.
- **Navigability is decided at query time, not baked into the mask** — this
  spike's recommendation to grow the grid (branch (b)) does not change that;
  a wider mask still serves `cellDepth >= safetyDepthM` at whatever gate the
  user has set.
- **Wind grids are stored per-plan, never re-fetched** — extending the wind
  lattice to 308 points changes what gets fetched and stored at plan time,
  not this invariant.
- **`bracket()`'s clamp recommendation (§3.3) does not change routing
  behaviour for any existing plan** — it adds a construction-time assertion
  and a test, touching no `PlanResult` field, so it owes no `app/sweep/`
  acceptance-harness re-run under this repo's #282 closure rule.
