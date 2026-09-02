# Spike #615 — advisory seamark-proximity notice (#495 option 2)

- **Issue:** #615 (carved out of #495; #495 stays open tracking option 1,
  seamarks as a routing input — NOT resolved by this work)
- **Date:** 2026-09-02
- **Status:** Decision record for the shipped MVP. Four decisions, each
  ratified by the maintainer on 2026-09-02 from the design brief this
  document condenses; the brief itself lived in a session scratchpad and is
  not committed, so THIS file is the durable record.
- **Verdict:** Ship a presentation-only, one-line advisory in the results
  panel: the count of DISTINCT cardinal or isolated-danger marks the active
  rig's route passes closer than **300 m** to, computed at render from the
  plan's own legs and the already-loaded shipped `seamarks.json`. No routing
  change, no `PlanResult` change, no map surface, no chart-authority claim,
  no side-of-passage claim, no sweep owed.

> This is a spike doc under `docs/spikes/`, deliberately not a spec under
> `docs/superpowers/specs/` (that path is main-session-only). It records a
> RECOMMENDATION plus every considered-and-rejected option, so a declined
> option cannot come back as a fresh idea. Promoting it to a spec is a
> main-session act.

---

## 0. Provenance of every figure

Two evidence sources, and each figure below names which one it came from:

- **RESEARCH (2026-09-02):** three independent research packets judged into
  one brief, all measured against the read-only checkout at `develop`
  `84b049a2`. Their scripts ran from a session scratchpad and are NOT
  committed; the method of each figure is stated here so it can be re-run
  rather than trusted. Where two packets disagreed, the disagreement is
  named (§4), never averaged away.
- **THIS PR (2026-09-02):** measurements made while implementing, against
  the same base `84b049a2`: the unit-test positive controls
  (`app/src/lib/seamarkProximity.test.ts`), two mutation batteries (§7), and
  the 33-harbour ratification scan (§4.3), which uses the SHIPPED
  `nearbyHazardMarkCount()` rather than a re-implementation.

Every route-based figure shares one solver configuration — sweepArms.ts's
`breeze` arm verbatim: real committed `mask.bin` / `mask.meta.json` /
Salona-45 polars, `DEFAULT_SETTINGS`, `uniformWindGrid(12, 225)`, departure
`Date.UTC(2026, 6, 15, 6, 0, 0)`, `PlanDeps { polars, boat, mask }` with the
default catalogue boat. Uniform wind is a stated limitation: a real forecast
moves legs, so these are counts on ONE wind field, not a distribution over
weather.

Distance = point-to-segment great-circle distance, endpoint-clamped, built
from `geo.ts`'s own `haversineNm` / `crossTrackNm` / `alongTrackFraction`
(imported, never re-implemented — `geo.ts` is inside the #282 sweep closure,
§6). Two positive controls are pinned in the test file against literals
computed OUTSIDE the codebase (spherical law of cosines, and the closed-form
cross-track from a meridian `R·asin(cos φ · sin Δλ)`): 6409.63 m and
12838.54 m, both matched within 0.05 m. The research packet's own control
(10/10 constructed offsets from 0 to 1852 m, endpoint cases included) is
reproduced by the endpoint-clamping rows in the same file.

---

## 1. What the issue asks, and what was pre-decided

#495 measured a real case: a route passing a `beacon_cardinal` south mark
**37 m** away on a leg carrying `leg.shallow`. It posed two directions and
#615 carves out option 2 only — an honest warning surface: flag when a route
passes within some distance X of a cardinal or isolated-danger mark, make no
navigational claim, leave the judgement with the skipper.

Pre-decided by the issue body: no routing change; no `PlanResult` change; the
solver, `isochrone.ts` and `NavMask` untouched; no `app/sweep/` run owed. Left
open by the issue, and settled here: the threshold, the category scope, the
copy, and (added, because it is answerable by measurement) the population
source. The 2026-08-25 re-triage comment prescribed the MVP shape this
document adopts: cardinal + isolated-danger only, one fixed threshold, one
line in the results panel.

---

## 2. Decision 1 — population source: the shipped `seamarks.json`

**RECOMMENDED (shipped): `loadRoutingAssets().seamarks`, filtered by
`isHazardSeamark()`.** Read on the main thread through a new
`useSeamarks()` hook, a clone of `useNavMask()`.

Why it costs nothing new — verified by reading `app/src/services/assets.ts`
directly during implementation, not taken from the brief: `loadRoutingAssets()`
fetches `data/seamarks.json` UNCONDITIONALLY, inside the same `Promise.all`
that supplies the mask, the polars and `harbors.json`, and it is not gated on
the seamark visibility toggle. Marginal network cost: zero. Marginal parse
cost: zero (already paid). The only new cost is one filter of the 1794
features (RESEARCH: 0.049 ms) plus the geometry (§2.3).

Offline: RESEARCH verified from the BUILT artifact, not the config, that
`app/dist/sw.js` carries a precache entry for `data/seamarks.json`. A saved
plan re-opened offline can compute the notice. No new asset ships.

### 2.1 REJECTED — `queryRenderedFeatures` on the seamark layers

Three independent fatal grounds, each read from shipped code:

1. **Dead by default.** `DataLayers.tsx` mounts the seamark layers behind
   `usePersistedToggle('sc-seamarks-visible', false)` — hidden by default, so
   `queryRenderedFeatures` returns ZERO features for every user who has never
   opened the toggle. The notice would silently not exist for the default
   install. This ground alone disqualifies the option.
2. **Zoom-dependent culling, measured on the committed data.**
   `seamarkGeoJson.ts`'s own #232 STATUS block records 99 culled hazard marks
   (53 at z8, 46 at z9) from diffing `querySourceFeatures` against
   `queryRenderedFeatures` over the real `seamarks.json` — i.e. the rendered
   set under-reports precisely the cardinal + isolated-danger population, at
   exactly the passage-planning zooms (`icon-overlap: 'never'` below z12; the
   app's initial zoom is z9).
3. **Viewport- and device-dependent.** RESEARCH modelled `fitBounds` zoom for
   four real routes (padding 48): desktop 1200x800 gives z10.2-12.1, phone
   390x600 gives z8.3-10.2. The same saved plan would warn differently on a
   phone than on a desktop, and differently again after a pan — while a
   stored plan must render identically forever (the wind-grid rule). It also
   requires the map to be mounted, which a Routes-tab render does not
   guarantee.

`querySourceFeatures` is not a rescue: still tile-bounded, still mount-bound.

### 2.2 REJECTED — compute at plan time and store on `PlanResult`

It changes `PlanResult`, hence `app/src/types.ts` and
`app/src/routing/planRoute.ts`, both `IN_CLOSURE` for the #282 sweep
(§6) — owing a BASE double-run control PLUS a BASE-vs-HEAD comparison over
9 arms x 33 harbours, about 3 arm-sets, roughly 93 min at CLAUDE.md's measured
~31 min per arm-set. It breaks byte-identity on all 297 sweep rows, so
`compare.mjs`'s byte mode (the strong comparator) becomes unusable. It adds
a ~343 KB / 1794-feature structured clone to the worker `InitMessage`, and an
unvalidated `PlanResultOk` field of the class ADR-0002's documented
stored-record crash hazard applies to. What it buys — a figure frozen into
the saved plan — is not needed (legs live in IndexedDB and the seamarks in
the precache, so the render-time computation gives the identical answer
offline) and is arguably a disadvantage: a `seamarks.json` regeneration would
leave stale frozen counts on old plans, where the shipped design tracks the
data.

### 2.3 Compute cost, and why there is no spatial index

RESEARCH (node, 32 cores at load ~1.0): naive O(marks x legs) at MVP scope is
1.0-20 ms for 14-400 legs over the 127-mark population; with a bounding-box
prefilter 0.098-1.7 ms. The shipped implementation uses a per-pair
triangle-inequality early-out instead of a bounding box — exact by
construction (great-circle distance is a metric), with no latitude or
projection assumption — and runs once per plan render behind `useMemo`. The
33-harbour scan records the per-plan cost of the shipped function (§4.3).
No spatial index is warranted at this population size.

---

## 3. Decision 2 — category scope: cardinal + isolated danger, via the existing predicate

**RECOMMENDED (shipped): reuse `isHazardSeamark()` from
`app/src/lib/seamarkGlyphs.ts` unchanged.** `HAZARD_SEAMARK_FAMILIES` is
`new Set(['isolatedDanger', 'cardinal'])` — exactly the maintainer's
2026-08-25 MVP scope — and its own doc comment forbids re-enumerating the
families at a second call site. It already backs #682's `sc-seamarks-hazard`
layer split, so the notice and the map agree BY CONSTRUCTION on what "hazard
mark" means.

Census (RESEARCH, two packets counting `app/public/data/seamarks.json`
independently, 343,466 bytes / 1794 Point features, agreeing exactly once the
buoy/beacon split is summed):

| Family | Count | Hazard (#682) |
|---|---:|---|
| lateral | 828 | no |
| specialPurpose | 703 | no |
| **cardinal** | **121** | **yes** |
| lightMinor | 107 | no |
| safeWater | 23 | no |
| **isolatedDanger** | **6** | **yes** |
| lightMajor | 6 | no |
| **MVP population** | **127 (7.08 %)** | |
| wreck / rock / obstruction | **0** | structurally absent |

Split: `buoy_cardinal` 115 (N 40 / E 27 / S 26 / W 22), `beacon_cardinal` 6
(E 2 / S 3 / W 1); `buoy_isolated_danger` 5, `beacon_isolated_danger` 1.

Dedup by exact coordinate before counting (shipped): one MVP pair shares
identical coordinates (RESEARCH: `(10.053382, 54.514348)`), which the user
sees as ONE symbol — an undeduplicated count would say "2 marks" for it.

### 3.1 REJECTED — widening to wrecks / rocks / obstructions

Not available, not merely unwise: `pipeline/build_seamarks.mjs` filters to
`CORE_PREFIXES = ['buoy_', 'beacon_', 'light_']` and its own comment names
rock, wreck, mooring and seabed_area as deliberately out of scope. Zero such
features ship. Adding them is a pipeline + data change — a separate issue.

### 3.2 REJECTED — adding `lateral`, on measurement

828 marks, and the router routes DOWN the buoyed channel: RESEARCH's nearest
lateral mark was **3 m / 3 m / 5 m / 24 m** from the four solved routes. It
would fire on every plan with 15-50 items. Independently, the hazard :
non-hazard ratio across the four routes was ~1:10 at EVERY threshold tested
(1:10.7 at 50 m, 1:9.7 at 100 m, 1:10.6 at 200 m, 1:10.2 at 300 m, 1:8.3 at
500 m) — no threshold separates them; the CATEGORY FILTER is what separates
signal from noise. At 0.5 nm the all-1794 population produced 51-92 hits on a
38 nm route where the 127-mark population produced 6-11: ~90 cannot be one
line in the results panel, ~5 can.

---

## 4. Decision 3 — threshold: 300 m

**RECOMMENDED (shipped): `SEAMARK_PROXIMITY_M = 300`, labelled in-code as a
maintainer JUDGEMENT CALL** in the style of `panelWidth.ts`'s
`PANEL_MAP_RESERVE_PX` — not derived from any measured layout or data
constant, and written so a future reader does not mistake it for one.

### 4.1 The four-route measurement (RESEARCH)

Four routes, solver configuration per §0, the count of hazard marks whose
distance to any leg of the RECOMMENDED rig fell under each candidate (all four
returned `status: 'ok'`, all four recommended `genoa`; the whole probe was run
twice with identical counts as a determinism control):

| Route | 50 m | 100 m | 200 m | 300 m | 500 m |
|---|---|---|---|---|---|
| flensburg -> soenderborg | 0 | 0 | 0 | **1** | 4 |
| flensburg -> marstal | 1 | 1 | 3 | 3 | 4 |
| flensburg -> bagenkop | 0 | 2 | 3 | 3 | 4 |
| marstal -> svendborg | 2 | 3 | 3 | 5 | 8 |
| **routes firing** | 2/4 | 3/4 | 3/4 | **4/4** | 4/4 |

Nearest hazard mark per route: 269 / 37 / 76 / 20 m.

### 4.2 Why 300 m, and the disagreement it resolves

The two research packets DISAGREED: one recommended 300 m (the smallest value
firing on all four routes, 1-5 items, ~0.16 nm, ~6.5 mask cells above the
~46 m cell); the other 200 m (above 2 mask cells, catches both #495
measurements of 37 m and 174 m, and holds endpoint density at 15.2 % of
harbours rather than the 48.5 % a 1 nm threshold reaches). Resolution:

1. Every criterion stated for 200 m is satisfied BETTER by 300 m, not worse:
   "above N mask cells" is a floor, and a larger threshold makes a weaker,
   safer precision claim (200 m is ~4.3 cells, 300 m ~6.5); both #495
   measurements are below 300 m too. The precision argument rejects 50 m and
   100 m — at or near one mask cell, asserting a positional precision the
   merged isochrone-chord polyline does not have — and does not discriminate
   200 m from 300 m at all.
2. The remaining argument for 200 m is trip rate, and #612's own ruling says
   trip rate is answered by DEMOTING THE SURFACE, not by narrowing the data:
   `MarginalDepthNotice`'s doc comment records a ">50 % of plans makes a bare
   presence notice wallpaper" bar that the measured trip rate (61.5 % on
   shipped defaults) tripped, honoured by demoting the surface and requiring
   the line to state its MAGNITUDE.
3. On the four-route evidence EVERY candidate from 50 m up trips that bar
   (2/4, 3/4, 3/4, 4/4, 4/4), so the wallpaper objection cannot choose
   between thresholds; it can only dictate the surface's shape — a bare `<p>`,
   one tier, never `role="alert"`, the count stated (§5).
4. Silence is the failure direction that matters: at 200 m
   flensburg -> soenderborg is silent while passing five cardinal marks
   within 1 km, nearest at 269 m — a real fjord passage where the surface
   would say nothing.

### 4.3 The 33-harbour ratification scan (THIS PR)

The four-route table is a FOUR-ROUTE aperture, all Flensburg-/Marstal-origin
(marstal -> svendborg is the dense-channel outlier, flensburg -> soenderborg
the sparse case). Before freezing the value, the aperture was widened to
Flensburg -> every harbour in `harbors.json`, the same `breeze` configuration,
running the SHIPPED `nearbyHazardMarkCount()` at 300 m (and, for context, at
200 m and 500 m) over the recommended rig's legs of every `ok` plan, plus the
nearest hazard-mark distance per route. The driver is a throwaway vitest probe
in a session scratchpad (not committed); its method is exactly §0's, so it can
be re-run from this description.

Results: see the implementation PR's body (the scan finished after this
document's first commit; the figures are recorded there and folded into this
section in the same PR). What the scan does NOT measure, so its absence is not
read as a null result: trip rate under real forecasts (one uniform wind field
only), Marstal-origin or other non-Flensburg origins, and any route that is
`no-route` at DEFAULT_SETTINGS.

### 4.4 REJECTED thresholds

- **50 m and 100 m:** silent on 2/4 and 1/4 routes respectively, and at or
  below the ~46 m mask cell — a precision claim the route polyline cannot
  support.
- **200 m:** the precision floor does not separate it from 300 m; it leaves
  flensburg -> soenderborg silent (§4.2 item 4).
- **500 m:** fires on 4/4 with 4-8 items, i.e. a LIST rather than a count; a
  viable alternative only if the product wants identification rather than
  a count, which pushes the surface to a collapsible list — a different
  design, not this MVP.
- **A great-circle-chord proxy** (origin -> destination chord instead of solved
  legs) was deliberately NOT computed: chords cross land — the #264
  infeasible-baseline trap — and one packet's chord table was flagged by its
  own author as order-of-magnitude only. It must not become the basis.

---

## 5. Decision 4 — copy and surface

### 5.1 Surface (shipped)

A bare `<p className="seamark-proximity-notice">`, a sibling of
`MarginalDepthNotice` in `RouteSummary.tsx`, computed against the ACTIVE rig's
legs so the line agrees with the rig tab the user is looking at. ONE severity
tier, the lowest: never `role="alert"`, never a `--severe` modifier, never
dismissible. #612 reserved the assertive role for a severity that is a
MEASURED relation (gate vs this boat's draft); proximity admits no such
measurement — nothing makes a 37 m pass more or less severe than a 174 m one
without a chart the app does not have — and a tier no measurement can
escalate must not be assertive. Dismissal would need per-plan persisted
state, which breaks the presentation-only property that is the whole reason no
sweep is owed.

Three silent states, each rendering NOTHING (never an empty container, never
a "0 marks" sentence): seamarks unresolved or failed to load ("not checked");
no legs for the active rig; a check that ran and found zero. Silence and
"none nearby" are different messages — a zero during the pre-resolve window
would be a false all-clear of the #251/#255 `segmentShallowestBelow` shape.

No accessible name, deliberately: a `<p>` has no role, so it cannot collide
with the five live non-`exact` Playwright locators whose name contains
"Seezeichen" (`layout.spec.ts`, `seamarks.spec.ts` x3, `datalayers.spec.ts`,
counted 2026-09-02 by the research; re-grep before trusting the count).

### 5.2 The strings (shipped, keys `route.seamarks.proximity` / `.plural`)

EN: "This route passes closer than {dist} m to a cardinal or isolated-danger
mark. SailCommand does not use marks when routing and makes no claim about
which side of one to pass — check it against an official chart." (plural:
"... to {count} cardinal or isolated-danger marks ... check them ...")

DE: "Diese Route verläuft näher als {dist} m an einem Kardinal- oder
Einzelgefahrenzeichen. SailCommand bezieht Seezeichen nicht in die
Routenberechnung ein und trifft keine Aussage darüber, auf welcher Seite ein
Zeichen zu passieren ist — mit amtlicher Seekarte prüfen." (plural: "... an
{count} Kardinal- oder Einzelgefahrenzeichen ...")

`{dist}` is interpolated FROM `SEAMARK_PROXIMITY_M`, never typed into the
dict, so copy and threshold cannot drift apart silently. Singular/`.plural`
follows the shipped `route.shallow.locator(.plural)` convention.

Every clause is load-bearing (recorded so a later "tidy the verbose copy"
round cannot silently reopen the boundary):

- **"closer than {dist} m"** — an UPPER BOUND, true by construction of the
  trigger; deliberately NOT the measured minimum, which would assert
  chart-grade positioning that neither the ~46 m mask grid, OSM-sourced mark
  coordinates nor merged isochrone-chord legs support.
- **the count** — #612's bar: a bare presence notice is wallpaper.
- **"does not use marks when routing"** — #495's actual finding, a statement
  about SailCommand, not about the sea.
- **"makes no claim about which side of one to pass"** — the issue's hard
  constraint, an explicit refusal rather than an omission. THIS IS THE
  LOAD-BEARING CLAUSE.
- **"check it against an official chart"** — the same pointer AWAY from the
  app's own authority that the shipped `route.shallow.caveat` carries.

### 5.3 Why "marks", never "hazards"

A cardinal mark's function is to indicate the navigable side of a danger
(the IALA cardinal semantics `seamarkGlyphs.ts` already renders), so copy
phrased as "hazard near your route" would be wrong in the safety-relevant
direction. RESEARCH: 11 of the 12 hits at 300 m across the four routes were
cardinals, so the cardinal wording is the one that ships in practice. Both
dicts are guarded against the word (`RouteSummary.test.tsx`'s shipped-copy
row).

### 5.4 Why the German class noun carries no external citation

"Kardinal- oder Einzelgefahrenzeichen" is COMPOSED from strings the app already
ships and has reviewed: `seamark.value.type.buoy_cardinal` /
`.beacon_cardinal` (Kardinaltonne / Kardinalbake), `.buoy_isolated_danger` /
`.beacon_isolated_danger` (Einzelgefahrentonne / Einzelgefahrenbake) and the
`-zeichen` class suffix of `map.seamarks.toggle` (Seezeichen). It is
deliberately NOT cited to BSH INT-1 or any external source: #300 measured
that a genuine BSH INT-1 pairing re-verifies as a fabrication against the
edition served at the same URL today. If an attestation is wanted it must be
pinned to an EDITION, never a URL. A native-speaker reading of the German was
NOT part of the research and is the specific thing a claim audit should
demand.

### 5.5 REJECTED surfaces

- **A legs-table column / per-leg chip:** the table is already 10 columns and
  #698's own comment records the populated Shallow cell's two chips exceeding
  the phonePortrait viewport — an 11th column is a documented regression on
  the device most likely to be read on deck.
- **A map toggle or highlight layer:** a toggle whose natural German label
  contains "Seezeichen" reds the non-`exact` locators above (the fix would be
  to constrain the new label, never to add `exact: true` at every call
  site), and a ring around one mark is the chart-authority gesture the issue
  exists to avoid.
- **A banner in `.banner-area`:** a second always-present banner above the map
  at narrow viewports re-opens the #368 banner-clearance and #208 stacking
  problems. The results-panel `<p>` avoids `.banner-area` entirely.
- **Dismissal / persisted state:** §5.1.
- **A side-of-passage sentence** ("we know the mark's named side, why not say
  it"): converts the advisory into a chart-authority claim and re-opens #495
  option 1.

---

## 6. Sweep closure

`app/src/lib/geo.ts` is `IN_CLOSURE` (import walk `sweepArms.ts` ->
`lib/mask.ts` -> `lib/geo.ts`). IMPORTING from it costs nothing — the closure
tool intersects the closure with CHANGED files — but adding the segment helper
THERE would flip the verdict to OWED for a purely presentational change, so
`pointToSegmentM` lives in the new `lib/seamarkProximity.ts`. `types.ts`,
`routing/planRoute.ts` and `app/public/data/seamarks.json` are likewise
untouched. Beyond the import walk, the shipped design adds no data asset, no
arm file, no pipeline generator and no runtime-constructed edge — it reads a
shipped, unmodified `seamarks.json` on the main thread, which the sweep
harness never executes. The `closure.mjs diff` verdict on the final file list
is quoted verbatim in the implementation PR's body.

---

## 7. Guards, and the mutations they red on (THIS PR)

`app/src/lib/seamarkProximity.test.ts` (14 rows) and the `#615` block in
`app/src/components/RouteSummary.test.tsx` (9 rows). Every mutation below was
applied to the shipped source, run, and restored byte-identically; the
control runs were 14/14 and 75/75.

| Mutation | Rows that red |
|---|---|
| boundary `<` flipped to `>` | 7 of 14 (every counting row) |
| threshold loosened by +5 m | the 301 m row alone |
| `f >= 1` endpoint clamp deleted | both endpoint controls |
| `isHazardSeamark` replaced by `true` | the lateral-mark row alone |
| coordinate dedupe deleted | the dedupe row alone |
| early-out pruning on start distance alone | 6 of 14, incl. the leg-END row |
| only the first leg walked | the later-leg row alone |
| memo deps drop `legs` | the #114 recalculate-and-replace row alone |
| zero/null branch renders the zero sentence | all four absence rows + the per-rig row |
| `!legs` guard deleted | the no-route-rig row alone (throws) |
| `<SeamarkProximityNotice>` call site deleted | all five positive rows |
| singular/plural lookup swapped | the three copy rows |

Each absence row sits beside a positive row that demonstrably renders, so the
absence assertions carry information (an absence assertion is vacuous until
the evidence-generating process is shown to run).

---

## 8. Invariants checked against this recommendation

- No chart authority: no directive about the sea, no "is safe/clear", no
  clearance figure, no measured minimum distance. The only imperative points
  away from the app ("check it against an official chart").
- No side-of-passage claim (the refusal clause is explicit).
- No routing change; no `PlanResult`, `types.ts`, `routing/**` or worker
  payload change; no ADR-0002 stored-record read hazard.
- No new asset; no new precache entry; the #28 install budget untouched.
- i18n parity and `{dist}`/`{count}` placeholder parity in both dicts (#524
  guard green).
- One severity tier, no accessible name, no e2e touch-point (no role, no
  name, no control, no map layer — nothing an existing locator can resolve).
