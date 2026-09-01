# Spike #714 — keyboard equivalents for map-only interactions

- **Issue:** #714 (`priority: high`, `area: map`, milestone v0.18.0)
- **Status:** Decision — recommendation only, per the issue's own Definition
  of Done ("a written recommendation with the rejected alternatives, sized,
  in `docs/spikes/`" plus follow-up issues). No `app/` code changes accompany
  this document.
- **Verdict:** Ship a **lat/lon coordinate-entry row** for via-point placement
  (reusing `Field`/`NumberInput` and the region bounds already enforced for
  GPX import) and a **keyboard-reachable "seamarks in view" list**
  (`Disclosure`, in the existing `.data-layer-controls` cluster) for seamark
  identification. Both are scoped presentation additions that reuse existing
  primitives and existing data plumbing; neither touches routing, the mask,
  or `PlanResult`. A third, structurally identical gap — AIS vessel
  identification — was found while enumerating this issue's own scope and is
  **not** folded into #714; it is proposed as a separate follow-up (§8) so
  this spike does not grow into an epic.

---

## 0. Method and scope

Every code claim below was re-derived from `app/src/**` on this branch
(merge-base `origin/develop` = `d4cf7d601e87cceb17fd0f8e63214eed2adff0f5`) by
reading the named file, not from the issue text or from memory. Citations are
anchored to symbols/exports, not bare line numbers, per this repo's own
citation-rot rule.

One fact recorded rather than left open: MapLibre's `Map` constructor
defaults `keyboard: true` and `interactive: true`
(`node_modules/maplibre-gl/src/ui/map.ts`, `keyboard` ~:519, `interactive`
~:494, giving the canvas `tabindex="0"` ~:4049), and `MapView.tsx`'s own `new
MaplibreMap({...})` call (~:239) sets neither option, so MapLibre's default
keyboard camera controls (arrow-key pan, +/- zoom, Shift+Left/Right rotate;
`ui/handler/keyboard.ts`'s keydown switch) are reachable today once the
canvas has focus — verified against the installed
`maplibre-gl@6.6.0` (matching `app/package-lock.json`'s pin) on 2026-09-01,
via the primary checkout's `app/node_modules` (this worktree's own copy is
absent, since this is a docs-only task with no `npm ci`). This remains out
of this document's enumeration scope regardless — the scope statement below
covers **app-authored** interactions only, features SailCommand itself wires
to a map click or a `Marker` drag, not MapLibre's own default camera
bindings.

**Scope statement**, per the issue's own request to scope rather than hedge
an enumeration: this document enumerates interactions reachable from the
Plan tab whose **only** trigger, in the current code, is a pointer event on
the MapLibre canvas or on a MapLibre-rendered feature (a `map.on('click', …)`
handler or a `Marker`'s native drag), and for which no already-existing
DOM-based keyboard path reaches the same outcome. It does not cover the Boat
or Live tabs, and it does not cover MapLibre's own UI controls (the compass
button, the zoom buttons if any are added later) — those are real DOM
elements with their own tab order already.

---

## 1. The WCAG criterion, and why "just add a button" isn't free here

**WCAG 2.1.1 (Keyboard), Level A:** "All functionality of the content is
operable through a keyboard interface without requiring specific timings for
individual keystrokes." A function reachable ONLY by a pointer gesture fails
this criterion outright — not "degrades," fails, because there is no keyboard
path to the same functionality at all.

The reason this isn't a trivial fix in a MapLibre app, stated once so it
isn't re-litigated per option below: **a MapLibre-rendered map feature has no
DOM node.** Every seamark glyph, every AIS vessel triangle, every depth-hatch
pixel is painted into one shared WebGL canvas by MapLibre's symbol/render
pipeline — there is no per-feature element for the browser's native tab
order, `:focus-visible`, or a screen reader's accessibility tree to see (this
repo's own verification-lessons note: "an MCP `browser_click` or locator
aimed at one fails with a CSS-selector parse error rather than clicking").
`ViaMarkers.tsx`'s `viaElement()` (`app/src/components/ViaMarkers.tsx`,
~:63-79) sets `role="button"` and `tabIndex = 0` on each via marker
specifically **because** it is a real `Marker` DOM element (MapLibre's
`Marker` API renders an actual positioned `<div>`), not a symbol-layer glyph
— that pattern is available to via markers precisely because they already
opt out of the shared-canvas rendering path, and it is NOT available to
seamark or AIS symbols, which render through `SEAMARKS_LAYER`/
`AIS_VESSEL_LAYER` symbol layers with no DOM counterpart at all. Any fix for
seamark/AIS identification therefore has to be a **separate, DOM-based UI
surface** that duplicates the relevant data — not a focus ring drawn around
the existing glyph.

---

## 2. Enumeration of map-only interactions

| # | Interaction | Trigger (file : symbol) | Keyboard equivalent today? | In #714's stated scope |
|---|---|---|---|---|
| 1 | Via-point **placement** (add) | `PlannerPanel.tsx`'s `onRequestMapTap('via')` (~:620) → `App.tsx`'s `tapTarget` arm → `MapView.tsx`'s `instance.on('click', handleClick)` (~:351) → `App.tsx`'s `handleMapTap`'s `'via'` branch (~:578-586) | **No.** No text/coordinate entry exists anywhere in the app (searched; see §2.1). | Yes — named explicitly |
| 2 | Via-point **repositioning** (drag) | `ViaMarkers.tsx`'s `marker.on('dragend', …)` (~:105) | **No.** Same gap as #1: there is no way to set a via point's coordinates without a pointer drag. Deleting and re-placing doesn't help, because placement (#1) is itself gapped. | Yes — implied by #1 |
| 3 | Via-point **remove / reorder** | `PlannerPanel.tsx`'s `onRemoveVia`/`onReorderVia` buttons (~:596-613) | **Yes**, already. Real `<Button>` elements with `aria-label`s (`planner.via.remove`/`moveUp`/`moveDown`). Not a gap — cited as the existing precedent for what "already fixed" looks like in this same feature. | N/A — not a gap |
| 4 | **Seamark identification** (popover) | `DataLayers.tsx`'s `map.on('click', SEAMARK_LAYER_IDS, handleClick)` (~:877), building a `Popup` from `seamarkPopoverRows()` | **No.** `lib/seamarkPopover.ts`'s exports have exactly one consumer (`DataLayers.tsx`), confirming the issue's own grep claim. | Yes — named explicitly |
| 5 | Seamark **visibility** toggle | `DataLayers.tsx`'s `.data-layer-controls` checkbox (~:1079-1086), backed by `seamarksVisible` | **Yes**, already — a real `<input type="checkbox">`. Not a gap; the toggle for *whether marks render* is fine, only *what a rendered mark means* is unreachable. | N/A — not a gap |
| 6 | **AIS vessel identification** (popover) | `AisLayer.tsx`'s `map.on('click', AIS_VESSEL_LAYER, handleClick)` (~:274), building a `Popup` from `aisPopupRows()` | **No.** Structurally identical defect to #4 — same pattern (`Popup` + `setDOMContent` + a rows-builder function), same absence of any DOM-reachable path. | **No** — not named by #714, found during this enumeration |
| 7 | Harbor-marker **click-to-pick** (origin/destination shortcut) | `DataLayers.tsx`'s `map.on('click', HARBOR_CIRCLE_LAYER, handleClick)` (~:897-908) → `App.tsx`'s `handleHarborPick` | **Yes**, already — this is a pointer-only *shortcut* for something fully reachable another way: `HarborPicker.tsx`'s WAI-ARIA combobox (role="combobox" + listbox, arrow-key navigable, ~:117-121) plus the `planner.pickOnMap` button pattern already offers keyboard-operable harbor search. Losing the map shortcut costs nothing a keyboard user needs. | N/A — not a gap |
| 8 | Origin/destination pick of an **arbitrary non-harbor point** | Same `onRequestMapTap('origin'/'destination')` → `handleMapTap` path as via placement | **Partial.** `HarborPicker` only searches the curated harbor list — there is no coordinate-entry fallback for origin/destination either, same as via points. The issue itself treats this as adequately covered ("Unlike origin/destination, which have a fully keyboard-operable HarborPicker combobox... vias have no text or coordinate entry fallback at all") because the dominant real use case is starting/ending at a harbor. This spike does not dispute that framing, but flags it explicitly (§7) since the fix in §5.1 would trivially extend to closing it too. | Named by the issue as the *contrast case*, not as a gap to fix |

### 2.1 Confirming "no text or coordinate entry fallback at all"

Searched for any coordinate-entry component or pattern anywhere in the app
(`grep -rln 'CoordinateInput\|LatLonInput\|coordinate.*entry' app/src`):
zero hits. `lib/format.ts`'s `formatLatLon` is display-only (used at
`PlannerPanel.tsx` ~:592 to show an already-placed via point's coordinates,
and in `App.tsx`'s tap-to-pick label); nothing in the app **parses** a
typed lat/lon back into a point. The issue's claim is confirmed, not assumed.

---

## 3. Options for via-point placement and repositioning

### 3.1 Option A — lat/lon coordinate-entry row (RECOMMENDED)

Add a small `Field`-wrapped pair of `NumberInput`s (lat, lon) beside the
existing `planner.via.add` button in `PlannerPanel.tsx`'s via section
(~:586-622), with its own "Add" action that calls the same
`onRequestMapTap`-adjacent path — concretely, a new callback that does what
`App.tsx`'s `handleMapTap`'s `'via'` branch already does
(`handleViaPointsChange([...viaPoints, p])`), fed a `LatLon` built from the
two `NumberInput` values instead of from a map click. No new via-point data
path is invented; this is a second **producer** of the same `LatLon` the map
tap already produces.

**Validation, reusing an existing constant rather than inventing a new
bound:** `lib/gpx.ts`'s `DATA_AREA` (`{ west: 9.4, south: 54.3, east: 11.0,
north: 55.3 }`) already exists for exactly this purpose — GPX import rejects
an out-of-region point with the same half-open-interval check
(`lon < DATA_AREA.west || lon >= DATA_AREA.east || lat < DATA_AREA.south ||
lat >= DATA_AREA.north`, `gpx.ts` ~:172-178). A manually-typed via point can
reuse the identical constant and the identical check — this is not a new
design decision, it is applying an existing one to a second entry point.
`NumberInput`'s own `min`/`max`/`onCommit(n, wasClamped)` contract already
signals a corrected value.

**Cost:** genuinely small. `Field`, `NumberInput`, and `Button` all already
exist; `DATA_AREA` already exists; `handleViaPointsChange` already exists.
The new surface is two `NumberInput`s, one `Button`, one new callback wiring
two numbers into the existing `LatLon` append, and new i18n keys for the
field labels (see §5.3). No new persistence, no new routing input, no
`PlanResult` change — `viaPoints: LatLon[]` is unaffected by how a `LatLon`
was produced.

**Also closes §2's row 2 (repositioning) as a side effect, if extended
slightly:** the same coordinate pair, rendered per already-placed via point
(next to its existing reorder/remove buttons in the `<ol className=
"planner-via-list">` at `PlannerPanel.tsx` ~:589-616) with an "Update"
commit instead of "Add," gives a keyboard-only sailor a way to *correct* a
placed via point's position without a drag — closing row 2 with the same
component, not a second one.

### 3.2 Option B — reuse `HarborPicker`'s nearest-harbour search for via points (REJECTED)

Considered because it is the closest existing keyboard-operable input, and
rejected because it answers the wrong question: via points exist to route
*around* a hazard or *via* a preferred open-water waypoint (per the issue's
own "Why it matters to a sailor" section) — they are almost never harbors.
Constraining via-point entry to the curated harbor list would serve only a
narrow subset of legitimate uses and would not give a keyboard user anything
close to parity with a mouse user's ability to tap anywhere on open water.

### 3.3 Option C — arrow-key nudging of an already-focused via marker

The issue's own second candidate: once a `ViaMarkers.tsx` marker has
`role="button"`/`tabIndex=0` focus, `onKeyDown` could nudge its `LatLon` by a
small step per arrow press, calling the same `onDragEnd` path
(`ViaMarkers.tsx` ~:105-123) a real drag already uses. This is a real,
cheap, additive refinement — but the issue's own framing is correct that it
"does not solve initial placement" on its own. It is not adopted as the
*primary* fix here because it cannot place a via point that doesn't exist
yet; Option A (§3.1) is necessary regardless, and once Option A exists,
nudging becomes a nice-to-have on top of it (a keyboard user can already
retype an updated coordinate via §3.1's "Update" form; nudging would be a
faster/more tactile alternative for a *small* correction, not a *necessary*
one). Recorded as a legitimate future enhancement, not required for #714's
DoD, and NOT rejected outright — just not load-bearing.

### 3.4 Option D — keyboard-pan-then-drop-a-crosshair model (CONSIDERED, REJECTED)

A "focus the map, pan with arrow keys, press Enter to drop a via point at
the crosshair" pattern, modeled on some accessible-map tools. Rejected on
cost/risk, not on principle:

- It needs a **new**, persistent on-canvas focus indicator (a crosshair or
  reticle) with no existing analogue anywhere in this codebase's map chrome.
- It needs new keydown handling scoped to the map container, which has to be
  reconciled against MapLibre's own live keyboard camera bindings (confirmed
  reachable, §0) so that "arrow key" doesn't ambiguously mean both "pan the
  camera" and "move the crosshair."
- It reuses none of the existing primitive layer (`Field`/`NumberInput`/
  `Button`) — it is a bespoke interaction model that would need its own
  design pass, its own e2e coverage strategy (this repo's own rule that "a
  MapLibre-rendered map feature has no DOM node" means testing a crosshair's
  on-canvas position needs `queryRenderedFeatures`-style verification, not a
  locator), and its own accessibility review for what a screen reader
  announces as the crosshair moves.
- It solves the SAME problem Option A solves, at materially higher
  engineering and review cost, for a passage-planning aid where a sailor
  already has to know or read off a lat/lon from a paper chart or a GPS
  receiver to use a via point meaningfully — i.e., a coordinate IS the
  domain-native way to specify this, not a compromise forced by the fix.

---

## 4. Options for seamark (and AIS) identification

### 4.1 Option A — "seamarks in view" keyboard-reachable list (RECOMMENDED)

A `Disclosure` (reusing the existing primitive, `app/src/components/
Disclosure.tsx`) placed inside `DataLayers.tsx`'s existing `.data-layer-
controls` cluster (~:1070-1086, where the seamark-visibility checkbox
already lives, so it is co-located with the feature it complements rather
than added as an unrelated new cluster), containing an `<ol>` of the seamark
features currently rendered on-screen. Each row renders the SAME
`seamarkPopoverRows(props)` data the map-click popover already builds
(`lib/seamarkPopover.ts`, already unit-tested and DOM-free per its own
header comment) — no new data-shaping logic, only a second **renderer** for
data that already has one.

**Population source:** the feature set has to be viewport-bounded, not the
full regional catalogue — the committed `app/public/data/seamarks.json`
carries **1,794 features** region-wide (measured: `python3 -c "import json;
print(len(json.load(open('app/public/data/seamarks.json'))['features']))"`
→ 1794), which is both too large for a flat list and not what a sighted
mouse user experiences (a mouse user only ever sees, and clicks, whatever is
currently rendered on their screen). The natural source is `map.
queryRenderedFeatures({ layers: SEAMARK_LAYER_IDS })` with no geometry
filter (the default `queryRenderedFeatures()` signature already scopes to
the current viewport when no geometry argument is given), re-read on
map `moveend`/zoom settle. This repo has an explicit, hard-won rule against
naively gating on `map.once('idle')` (CLAUDE.md's verification-lessons
section: it "always takes the cap" and is "an unconditional sleep in a
state-signal costume") — an implementation of this option must gate the
re-query on a real settle signal (`moveend`, or the same kind of polling
`labels.spec.ts` already uses for map-derived state), not a naive `idle`
listener.

**Cost:** moderate, and honestly stated as such rather than minimized. This
is the one piece of real new engineering in this document — a new
viewport-synced state surface that has to stay correct across pan/zoom/style
reload, in a codebase whose own CLAUDE.md documents several past defects in
exactly this class of code (map-orientation/z-order/collision-index
surprises). It needs: a `moveend`-gated re-query effect (following `lib/
styleReload.ts`'s `installStyleSetup` conventions, per this repo's rule to
"never hand-roll `whenStyleReady`"), a cap or empty-state for zero features
in view (common at low zoom or over open water), and i18n for the heading
and empty state (no new content for the rows themselves — those already
render via `resolveSeamarkPopoverValue`/`t()`). It does **not** touch
routing, the mask, or any `PlanResult` field.

**Placement, per the declared map-chrome tier order:** Tier 2 (map chrome),
inside the existing `.map-stack-tl` → `.data-layer-controls` cluster, which
`app.css`'s own comment already documents as the one Tier-2 member allowed
to shrink/scroll under the column's height bound — the new list must
respect that same `overflow-y` behaviour rather than growing the cluster
without bound. No new tier value is proposed.

### 4.2 Option B — an unbounded list of all seamarks region-wide (REJECTED)

Rejected on two independent grounds: **scale** (1,794 rows in one flat list
is not a usable UI on any viewport this app targets — see the viewport
matrix down to 280px wide), and **fidelity** (it wouldn't mirror what a
mouse user actually experiences, which is always scoped to what's currently
rendered — an unbounded list would show a sailor marks on the far side of
the fjord that have nothing to do with what they're currently looking at).

### 4.3 Option C — focus-cycling over rendered map symbols (REJECTED)

The issue's own second candidate. Rejected because it is not achievable
without a fundamentally different rendering approach: per §1, a symbol-layer
glyph has **no DOM node** at all — `ViaMarkers.tsx`'s `role="button"` pattern
works only because via markers are real `Marker`-API DOM elements, not
symbol-layer output. Making seamark glyphs individually focus-cycleable
would require either (a) a parallel, invisible, in-DOM proxy element per
rendered feature, repositioned on every pan/zoom/style-reload frame — a
duplicate of MapLibre's own placement/collision engine, maintained by hand,
with no existing precedent anywhere in this codebase — or (b) `Marker`-based
rendering for seamarks instead of a symbol layer: this repo's own
`#191`/`#200`/`#232`/`#682` history shows a substantial, symbol-layer-specific
investment in collision/z-order tuning that a switch to Marker-based
rendering would forfeit. Either route is a materially larger and more
fragile undertaking than Option A for the same user-facing outcome
("what is this thing on the map"), and Option A already gives a keyboard
user the FULL content the popover would have shown, not a degraded subset.

---

## 5. RECOMMENDATION (consolidated)

### 5.1 Via points

Ship §3.1 (a lat/lon coordinate-entry row, `Field` + two `NumberInput`s +
`Button`, validated against `lib/gpx.ts`'s `DATA_AREA`) as the primary fix
for both placement (§2 row 1) and, extended to render per placed via point,
repositioning (§2 row 2). §3.3 (arrow-key nudging) is recorded as a
legitimate but non-required follow-on enhancement, not part of this
recommendation's minimum scope.

### 5.2 Seamark identification

Ship §4.1 (a `Disclosure`-based "seamarks in view" list inside `.data-layer-
controls`, sourced from a `moveend`-gated `queryRenderedFeatures` query,
rendering the existing `seamarkPopoverRows()` data). No change to the
seamark data pipeline, the popover itself, or `SEAMARKS_LAYOUT`.

### 5.3 i18n — illustrative keys only (not created by this document)

Per this repo's convention, every new string needs BOTH `dict.de.ts` and
`dict.en.ts` entries satisfying `Record<MsgKey, string>`. Illustrative keys
a follow-up implementation would need (exact naming is an implementation
decision, not this spike's):

- `planner.via.coord.latLabel` / `.lonLabel` — the two `NumberInput` labels.
- `planner.via.coord.add` — the coordinate-row's own "Add" action (distinct
  from the existing `planner.via.add`, which arms the map-tap mode).
- `planner.via.coord.outOfRegion` — shown when a typed value fails the
  `DATA_AREA` check (mirrors `gpx.ts`'s `too-far` / out-of-region rejection
  message shape, reworded for manual entry rather than file import).
- `seamarks.listInView.summary` — the `Disclosure`'s summary row text.
- `seamarks.listInView.empty` — shown when the current viewport query
  returns zero features.

**Checked against the `getByRole` substring-collision hazard** (CLAUDE.md:
eleven live specs already match `getByRole('checkbox', { name: 'Wassertiefen'
})` with no `exact: true`): none of the above illustrative labels contains
"Wassertiefen" (German for "water depths") in either language, so this
recommendation does not create a new instance of that hazard on its own —
but an implementer must re-check the FINAL chosen German strings against a
live `grep -rn "Wassertiefen" app/e2e` before shipping, since the hazard is
about the actual shipped string, not this document's placeholder.

### 5.4 What is deliberately NOT touched

- `types.ts` / `PlanRequest` / `PlanResult` — unaffected; both fixes add a
  second **producer** or a second **renderer** of data that already exists
  in the same shape.
- `app/sweep/`'s transitive closure — neither fix is in it (no
  `app/src/routing/`, `lib/mask.ts`, `lib/depthGate.ts`, `boats.ts`, or
  `boatDepth.ts` touched), so no #282 acceptance sweep is owed.
- The seamark data pipeline (`pipeline/seamarks.mjs` and the committed
  `seamarks.json`) — Option A renders existing rendered features, it does
  not change what data ships.

---

## 6. Considered and rejected — index

(Full reasoning lives inline at each option above; this section is the
convention's required index so a declined option cannot quietly resurface.)

- **§3.2** Reusing `HarborPicker`'s harbor search for via points — rejected,
  wrong domain (via points are open-water waypoints, not harbors).
- **§3.4** A keyboard-pan-then-drop-crosshair interaction model — rejected,
  disproportionate engineering/review cost against Option A for the same
  outcome, and no existing precedent to build on.
- **§4.2** An unbounded list of all 1,794 region-wide seamarks — rejected,
  wrong scale and wrong fidelity to the sighted experience.
- **§4.3** Focus-cycling over rendered symbol-layer glyphs directly —
  rejected, structurally unavailable (no DOM node) without either a
  hand-maintained shadow DOM layer or abandoning symbol-layer rendering for
  seamarks, both materially larger than Option A for the same result.

---

## 7. Residual named but explicitly out of this recommendation's scope

**Origin/destination arbitrary (non-harbor) point entry (§2 row 8)** has the
same underlying gap as via points — no coordinate fallback exists — but the
issue itself frames `HarborPicker` as an adequate keyboard equivalent for
these two fields, because the dominant real use case is starting or ending
at a harbor. This spike does not dispute that framing or propose reopening
it. It is worth naming only because §5.1's coordinate-entry component, once
built for via points, would be a small additional step to reuse for
origin/destination too — that is left as a maintainer call for the
follow-up implementation issue (§8), not decided here.

---

## 8. Follow-up issues — proposed text (NOT created; awaiting approval)

**Issue A — "Keyboard-reachable via-point coordinate entry" (implements
§5.1)**
> Add a lat/lon `NumberInput` pair to `PlannerPanel.tsx`'s via section as a
> keyboard-operable alternative to `onRequestMapTap('via')`, validated
> against `lib/gpx.ts`'s `DATA_AREA` bounds, feeding the same
> `handleViaPointsChange` append path a map tap already uses. Extend to an
> inline "update coordinates" form per already-placed via point so an
> existing via point can be corrected without a drag. New i18n keys in both
> `dict.de.ts`/`dict.en.ts`. Refs #714.

**Issue B — "Keyboard-reachable seamarks-in-view list" (implements §5.2)**
> Add a `Disclosure` inside `DataLayers.tsx`'s `.data-layer-controls`
> cluster listing the seamark features currently rendered in the viewport
> (via a `moveend`-gated `queryRenderedFeatures` query against
> `SEAMARK_LAYER_IDS`), rendering each via the existing
> `seamarkPopoverRows()`/`resolveSeamarkPopoverValue()` functions. Empty
> state when zero features are in view. New i18n keys in both dicts. Refs
> #714.

**Issue C — "AIS vessel identification has no keyboard equivalent" (NOT
part of #714's scope; found during this spike's enumeration, §2 row 6)**
> `AisLayer.tsx`'s vessel-identification popover (`map.on('click',
> AIS_VESSEL_LAYER, handleClick)`) is click-only, structurally identical to
> the seamark-identification gap in #714. Once Issue B ships a
> viewport-list pattern for seamarks, the same pattern (a `Disclosure` list,
> `aisPopupRows()` already exists as the data source) closes this gap too.
> Filed separately because AIS is an opt-in, BYOK feature (#25) outside
> #714's stated scope, and folding it in here would make #714 the epic its
> own Definition of Done says it must not become.

---

## 9. What this document does not establish

- Exact component names, prop shapes, or file locations for the new UI
  beyond "reuse `Field`/`NumberInput`/`Button`/`Disclosure`, place in the
  cited existing sections" — those are implementation decisions for the
  follow-up issues, not this spike's.
- Any product decision about MapLibre's own default keyboard camera bindings
  (pan/zoom/rotate) — confirmed reachable today (§0), but out of this
  document's scope regardless (app-authored interactions only).
- Whether Option A's "update coordinates" extension for existing via points
  (§3.1) should ship in the same PR as initial placement, or as a fast
  follow — left to the implementation issue.
- A visual/interaction design for the seamark list beyond its primitive and
  tier placement (exact row layout, whether a row offers a "show on map"
  jump action) — a reasonable enhancement, not required by #714's DoD.
