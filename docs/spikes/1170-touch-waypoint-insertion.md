# Design decision — #1170: touch cannot insert a waypoint at a chosen position

- **Issue:** #1170 (`type: feature`, `priority: medium`, `area: map`, milestone v0.33.0 (deferred at the v0.32.0 cut; the design shipped, the build did not))
- **Status:** Decision — recommendation only. No `app/` code changes accompany
  this document.
- **Verdict:** Ship **candidate 2, an explicit edit mode — by extending the
  arming that already exists** (`tapTarget === 'via'`). While the "Add
  waypoint" pick is armed, a tap within a >=22 px tolerance of the displayed
  route line inserts a waypoint at the projected point on the line, at the
  correct ordinal. Reject long-press (candidate 1) and persistent handles
  (candidate 3).

---

## 0. Method

Every code claim below was re-derived by reading the named file on
`develop` @ `831db11`, not from the issue text or from memory. Library claims
were read from `app/node_modules/maplibre-gl@6.7.0`, confirmed equal to
`app/package-lock.json`'s pin (`node -p "require('./app/node_modules/maplibre-gl/package.json').version"`
-> `6.7.0`; lockfile `"version": "6.7.0"`).

Survey sources were fetched with `curl` and the quoted sentences extracted
from the fetched bytes, **not** through a summarising fetch tool — the two
attempts that went through `WebFetch`/`WebSearch` are labelled as such and no
integer or quotation is sourced from them.

MEASURED = read from a file or from fetched page bytes in this task.
INFERRED = a judgement drawn from those readings.

---

## 1. Survey: how marine software inserts a waypoint into an existing route

#850's design question 1 asked for this and it had not been done. Four
products, each quoted verbatim from bytes fetched in this task.

### 1.1 savvy navvy (touch-first sailing app, weather routing — the closest analogue)

Source: <https://www.savvy-navvy.com/user-guide/planning-a-route-2> (fetched
2026-09-10). Verbatim:

> Modify button allows you to edit the route by adding, moving or deleting
> waypoints.

> You can insert a waypoint into an existing leg by long pressing on the
> dotted outline route until a waypoint is inserted, this will relabel all the
> waypoints in sequence.

> You can move any waypoint by dragging it.

MEASURED and load-bearing: the long-press is available **only inside the
Modify mode**, and it acts on the **"dotted outline route"** — savvy navvy's
straight waypoint chain — not on the calculated weather route drawn beside
it. Both details map directly onto choices SailCommand has to make.

### 1.2 Aqua Map (touch-first marine app)

Source: <https://www.aquamap.app/support/16-main-features/220-route-planner>
(fetched 2026-09-10). Verbatim:

> To add a new waypoint not at the end of the route but somewhere in between
> you should tap on the route itself to split it , a pop-up will ask if you
> would split the route on that position and then you will be able to move the
> new created waypoint in the desired position.

> If you use the map to add a new waypoint, it is enough you long-press in the
> desired position or tap on the same position and select the left icon in the
> pop-up. In this way you will add a waypoint at the end of the editing route.

MEASURED: Aqua Map splits the two gestures deliberately — **long-press
appends at the end**, **tap on the line inserts in between**. So in this
product long-press is *not* the insert gesture; it is the append gesture, and
the insert gesture is a plain tap on the line plus a confirmation popup. Both
sit inside an editing route.

### 1.3 OpenCPN (open-source, desktop/pointer)

Source: <https://opencpn.org/wiki/dokuwiki/doku.php?id=opencpn:manual_basic:create_routes:modify_route>
(fetched 2026-09-10). Verbatim:

> To modify, add to, append a route point, insert waypoints, remove or delete
> waypoints in a Route, Right Click on the Route Segment or at the Waypoint
> (dependent on intent), and select the appropriate command.

and under the heading `Right Click on a Route Leg`, the menu item
`Insert Waypoint`.

MEASURED: a contextual action invoked **on the leg**, not a hover-reveal drag.

### 1.4 Garmin ECHOMAP UHD (marine chartplotter hardware, touchscreen models)

Source: <https://www8.garmin.com/manuals/webhelp/echomapuhd/EN-US/GUID-73E01CF8-6D53-4777-86AF-6FB7C91873B9.html>
(fetched 2026-09-10), topic "Editing a Saved Route". Verbatim:

> Select Nav Info > Routes.
> Select a route.
> Select Review > Edit Route.
> Select an option:
> To edit a turn from a list, select Edit Turns > Use Turn List, and select a
> turn from the list.
> To select a turn using the chart, select Edit Turns > Use Chart, and select a
> location on the chart.

MEASURED: an explicit, named **Edit Route** mode, entered from a route list —
and inside it, a chart path *and* a list path side by side.

### 1.5 What the survey establishes, and what it does not

MEASURED, across all four: **every one of them makes the user enter an
editing state first**, and only inside that state does the route line (or the
turn list) become interactive. The gesture inside the mode varies — long-press
(savvy navvy), tap-plus-confirm (Aqua Map), right-click context menu
(OpenCPN), list-or-chart picker (Garmin).

MEASURED, across all four: **none of them documents a hover-reveal-then-drag
handle**, which is the web-routing pattern (Google Maps, Mapbox Directions)
that #850 shipped. #850's own hypothesis — that marine conventions differ from
the web-routing pattern — is supported by this sample.

INFERRED, and stated as an inference: four products are a sample, not a
census. "No marine product uses hover-drag" is **not** a claim this document
makes; "none of the four surveyed does, and all four are mode-first" is.

MEASURED, also worth recording: Garmin's manual pairs a chart path with a
**turn list** path for the same operation. That is #1171's shape, and it is
the marine convention too, not merely an accessibility concession.

### 1.6 Long-press timing, from platform primary sources

Needed only to size candidate 1's rejection. Both read from source bytes, not
from a summary:

| Platform | Constant | Value | Source |
|---|---|---|---|
| iOS/UIKit | `UILongPressGestureRecognizer.minimumPressDuration` default | 0.5 s | developer.apple.com documentation JSON, fetched 2026-09-10 |
| Android | `ViewConfiguration.DEFAULT_LONG_PRESS_TIMEOUT` | 400 ms | AOSP `frameworks/base` `main`, `core/java/android/view/ViewConfiguration.java`, fetched 2026-09-10 |

The AOSP figure is read against a **moving branch** (`main`) on that date, not
a pinned release — it is an observation of that day, not a durable constant.
The commonly-repeated "500 ms" for Android did not match what the file said.

---

## 2. Source facts that change the shape of the problem

Four readings the issue text does not contain.

### 2.1 The DRAG half already works on touch — only the REVEAL is hover-gated

MEASURED, `app/node_modules/maplibre-gl/src/ui/marker.ts`:

- `setDraggable` registers `this._map.on('mousedown', this._addDragHandler)`
  **and** `this._map.on('touchstart', this._addDragHandler)`.
- `_addDragHandler` binds `touchmove` -> `_onMove` and `once('touchend')` ->
  `_onUp` alongside their mouse counterparts.

So a MapLibre `Marker` drag is touch-capable today. #1170 is therefore purely
a **reveal/discoverability** problem, not a drag-mechanics problem. That
shrinks every candidate.

MEASURED, same function, and this is the trap for candidate 1: the handler is
gated on

```
if (this._element.contains(e.originalEvent.target as any)) {
```

The `touchstart` must originate **inside the marker's own element**. Under a
long-press design the finger is already down on the *canvas* when the handle
materialises, so that touchstart never targeted the handle and no drag starts.
The user must lift and re-press on a handle that appeared under their finger.
That is a real, mechanical cost of candidate 1, not a polish concern.

### 2.2 The armed "Add waypoint" mode is candidate 2, already built

MEASURED, `app/src/App.tsx`:

- `tapTarget` state (`:598`), a `TapTarget | null`, with `'via'` as a member.
- `PlannerPanel.tsx` (`:1039-1042`) renders the arming button with
  `aria-pressed={tapTarget === 'via'}`, toggling between `planner.via.add` and
  `planner.via.add.cancel`.
- An arm banner renders while `tapTarget` is set (`App.tsx:1638-1644`).
- Every disarm path already covers `'via'` (the state's own comment at `:596`
  says so: "'via' extends the same machinery (E8)").
- `SavedWaypointsLayer` receives `armed={tapTarget === 'via'}` (`:1396`) and
  joins `interactiveLayerIds` only while armed (`:910-916`, #924).

So the issue's own objection to candidate 2 — "costs a control in an
already-budgeted chrome cluster", citing the `.map-stack-tl` shrink rules — is
**already paid**. The control exists and it lives in the planner panel, not in
the map chrome at all.

**Scope that claim honestly.** What is measured is the arming, the banner and
the disarm paths, all of which are modality-independent. Whether a map tap
actually fires on a real touch device is **not measured** — MEASURED:
`app/playwright.config.ts` declares a single project,
`{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }`, and a repo-wide
grep for `hasTouch`/`isMobile` over `app/e2e` and that config returns nothing.
No touch interaction in this app has ever been exercised by a test. That is
the honest reason the `hasTouch` e2e variant in §6 is **required, not
optional**.

### 2.3 The free map tap APPENDS; only picked waypoints insert at the right ordinal

MEASURED, the full enumeration of via-point producers in `App.tsx`:

| Producer | Site | Placement |
|---|---|---|
| `handleMapTap` 'via' branch | `:772` | **appends** — `handleViaPointsChange([...viaPoints, p])` |
| `handleAddViaByCoord` (#829 coordinate entry) | `:806-811` | **appends** |
| `handleAddViaFromSeamark` (#845) | `:853-856` | `insertViaNearestOrAppend` |
| `handleSelectSavedWaypoint` (#848) | `:863-866` | `insertViaNearestOrAppend` |
| `handleRouteLineInsert` (#850) | `:882-885` | `insertViaNearestOrAppend` |

`insertViaNearestOrAppend` (`:839-851`) splices at
`nearestViaInsertIndex(...)` (`app/src/lib/viaInsertion.ts`) when both
endpoints exist, and appends otherwise.

MEASURED consequence for #1170's framing: on touch **today** a user can
already add a waypoint — arm "Add waypoint", tap the map — but it lands at the
**end** of the sequence and must be walked into place with
`planner.via.moveUp`/`moveDown`. So the touch gap is not "cannot add a
waypoint"; it is "cannot add one **at the right position on the route**". That
is a narrower and more tractable statement of #1170 than the issue's.

MEASURED about provenance: `git log -S'[...viaPoints, p]' -- app/src/App.tsx`
returns `0a286e2 feat: draggable via-waypoints with stored-wind re-route` and
`2dfce6e feat(#829): keyboard-reachable via-point coordinate entry` — the
append predates #845's nearest rule.

MEASURED about the spec: `docs/superpowers/specs/2026-09-04-named-waypoints-design.md`
§2.6 is titled "**A seamark** is inserted at its nearest point along the
route". Its scope is picked waypoints. The free map tap is **not addressed**
by it either way.

INFERRED, and deliberately weak: no artifact found in this task records a
decision that a free tap should append while a picked waypoint inserts. That
is not the same as establishing it was an oversight, and this document does
not claim that.

### 2.4 Two geometries are in play, and they are not interchangeable

MEASURED:

- `nearestPointOnRoute` (`RouteLayer.tsx`, used by #850's hover-reveal) walks
  `result.legs` — the **solved polyline**, with a vertex at every tack and
  gybe. This is the line the user sees drawn.
- `nearestViaInsertIndex` (`lib/viaInsertion.ts`) walks the **draft chain**,
  `[origin, ...viaPoints, destination]` — `viaPoints.length + 1` straight
  great-circle segments. Its own doc comment states why: "The solved route has
  extra tack/gybe vertices with no via-index of their own".

INFERRED: the two must stay in their current division of labour — hit-test
against the drawn (solved) line, because that is what the user is aiming at;
resolve the ordinal against the draft chain, because that is the only
structure that has ordinals. #850 already does exactly this and it works. Any
candidate that puts a *drawn* affordance at *chain* midpoints puts it on a
straight line the solved route deviates from — possibly over land, and
visibly off the line the user is looking at.

Corroboration from the survey, MEASURED: savvy navvy long-presses the "dotted
outline route" — its chain — and *draws* that chain for the user to press.
SailCommand does not draw its chain, so that resolution is not available here
without adding a second visible line.

---

## 3. The three candidates against the four criteria

The 44 px floor applies to all three. MEASURED: the UI-modernization addendum
(`docs/superpowers/specs/2026-07-17-ui-modernization-design.md`) states
"Touch targets stay `>=44px` for gloved use" (:42) and, for the disclosure
chevron, "a `>=44px` touch target" (:90). MEASURED: the shipped ghost handle
(`routeDragHandleElement`, `RouteLayer.tsx`) is **24 px**, and
`ROUTE_DRAG_HOVER_TOLERANCE_PX` is **12**. Neither is a touch target today.

### Candidate 1 — long-press on the route line

- **Discoverability:** poor without a mode. Nothing on screen says the route
  line is pressable. Of the surveyed products, the one that uses long-press to
  insert (savvy navvy) only exposes it *inside* Modify; the one that uses
  long-press on the bare chart (Aqua Map) uses it to **append**, not insert —
  so adopting long-press-to-insert on an unarmed map would contradict Aqua
  Map's meaning for the same gesture.
- **Collision with existing gestures:** direct, with map pan. Disambiguation
  requires a timing threshold (0.5 s iOS / 400 ms Android per §1.6) plus a
  movement-slop bound, hand-rolled — MapLibre exposes no long-press gesture.
- **The mechanical trap (§2.1):** the handle materialises under a finger that
  is already down, and `_addDragHandler` requires the `touchstart` target to
  be inside the handle element. The user must lift and re-press. That converts
  a one-gesture design into a three-step one and is invisible until built.
- **#391 exposure:** a hand-rolled long-press built on map-level touch
  handlers is a HandlerManager-adjacent gesture begun on the canvas; the
  window right after a plan lands and `fitBounds` runs is exactly #391's
  window (accepted-not-fixed). #850's existing `Marker`-based drag is
  **immune** (MEASURED §2.1 mechanism, and `RouteLayer.tsx`'s own #391
  comment). Choosing long-press would give up an immunity the current design
  has.
- **Accessibility:** a timed gesture is a WCAG 2.5.1 (Pointer Gestures) and
  2.1.1 concern in its own right; nothing about it helps #1171.
- **Cost:** highest of the three. New gesture recogniser, threshold tuning,
  slop bound, pan suppression, plus the lift-and-re-press problem.

### Candidate 2 — an explicit edit mode

- **Discoverability:** best available, and it is the **only** structure all
  four surveyed products share (§1.5). The mode already exists, is already
  labelled in both languages, and already renders a banner telling the user
  the next tap is a pick.
- **Collision with existing gestures:** none. While armed, a tap is already
  claimed as a pick — that is what the mode means. Pan and zoom are
  untouched, because the gesture is a plain tap, not a timed press.
- **44 px:** satisfied by the **hit tolerance**, not by a drawn disc — a
  line hit-tested at >=22 px each side *is* a >=44 px target. No new
  element needs sizing, and `VIA_MARKER_HALF_WIDTH_PX`'s 8 px suppression
  does not have to grow to fence off a 44 px disc.
- **Collision index:** zero. No symbol-layer feature is added. (The brief's
  warning applies to candidate 3 built as a symbol layer — see §3, candidate 3.)
- **#391 exposure: none, VERIFIED — but by a different mechanism than
  #850's, and the difference matters.** A map `click` is *not* a plain
  `Evented` listener the way `Marker`'s `_addDragHandler` is: it is relayed
  by `MapEventHandler` (`ui/handler/map_event.ts`), which IS registered in
  `_handlers` and IS reset by `_stopHandlers()`. MEASURED against the
  installed 6.7.0: `reset()` is exactly `delete this._mousedownPos;` (:19-20),
  and `click()` is
  `if (this._mousedownPos && this._mousedownPos.dist(point) >= this._clickTolerance) return;`
  (:43-44). So after an ease's `_stopHandlers()` the guard's FIRST term is
  falsy, the early return never fires, and the click is relayed — the reset
  makes the click *more* likely to reach us, not less, because it skips the
  movement-tolerance check. Repositioning afterwards uses the existing
  `Marker` drag, immune by the §2.1 mechanism. Do not restate this as "clicks
  are immune the way marker drags are"; they are immune for the opposite
  reason.
- **Accessibility:** the mode is entered from a real `<button>` with
  `aria-pressed`, already keyboard-reachable. It does not deliver #1171 (no
  keyboard way to choose the *point*), but it does not widen that gap either.
- **Cost:** lowest, because the arming, the banner, the disarm paths, the
  hit-test helper and the insertion primitive all exist.

### Candidate 3 — persistent midpoint handles

- **Discoverability:** highest at a glance, and worst in every other respect.
- **The geometry problem (§2.4) is the decisive objection, and it is sharper
  than "clutter":** handles at *solved-leg* midpoints means one per tack — many
  handles on a beat, moving on every replan. Handles at *chain-segment*
  midpoints means few handles, but they sit on straight segments the solved
  route deviates from, so a handle can render over land or visibly off the
  drawn line. Neither geometry is clean.
- **44 px:** `viaPoints.length + 1` permanent 44 px discs on the route at all
  times — larger than the 16 px via markers they sit between, which inverts
  the visual hierarchy (a not-yet-a-waypoint outranks a real one).
- **Collision index:** STRUCTURAL distinction (not measured in this task)
  that the brief's framing needs scoping to — DOM `Marker`s (what `ViaMarkers` and the #850 ghost use) do
  **not** enter MapLibre's collision index; only symbol-layer features do. So
  built as `Marker`s this costs visual occlusion but does **not** cull #378's
  ETA/speed labels; built as a symbol layer it does. The #378 hazard is real
  for one implementation of this candidate, not for the candidate as such.
- **Cost:** medium, plus a permanent maintenance surface (handles must track
  every replan, every rig switch, every draft edit).

---

## 4. RECOMMENDATION

**Candidate 2, implemented as: while the existing "Add waypoint" pick is
armed, a tap within a >=22 px tolerance of the displayed route line inserts a
waypoint at the projected point on that line, at the ordinal
`nearestViaInsertIndex` resolves.** A tap elsewhere on the map keeps its
current meaning. Repositioning afterwards uses the existing, already
touch-capable `Marker` drag.

Two strongest reasons:

1. **It is the convention, measured.** All four surveyed products make the
   user enter an editing state before the route line becomes interactive
   (§1.5), and two of the four — Aqua Map explicitly, OpenCPN by right-click —
   use a *tap/click on the line* rather than a timed press as the insert
   gesture. Aqua Map's flow is this recommendation almost exactly: tap the
   line to place a point in between, then drag it where you want it.
2. **The mode it needs is already shipped.** §2.2:
   the button, the `aria-pressed` state, the banner, every disarm path, and
   the armed-layer precedent (#924) all exist. The issue's stated cost for
   this candidate — a new control in a budgeted chrome cluster — does not
   apply.

Supporting: it satisfies the 44 px floor through hit tolerance rather than a
drawn disc; it adds nothing to the collision index; and it keeps #391
immunity, which candidate 1 forfeits.

**Discoverability addition, required not optional:** while armed *and* a route
is displayed, the banner copy must say the route line is tappable, and the
route line should be visually emphasised (a widened casing while armed). Both
languages, and enumerate the new accessible name in **both** — `getByRole`
matches `name` by substring unless `exact: true`, and German's
`planner.via.add.cancel` ("Wegpunkt hinzufügen abbrechen") already makes
`planner.via.add` a prefix of it.

---

## 5. Considered and rejected

So a rejected option cannot return later as a fresh idea.

1. **Long-press on the route line (candidate 1).** Rejected on three
   independent grounds, any one of which suffices: it competes with map pan
   and needs a hand-rolled timing threshold; `_addDragHandler`'s
   `_element.contains(target)` gate means the finger already down on the
   canvas cannot drag the handle that appears under it, forcing a
   lift-and-re-press (§2.1); and a canvas-level hand-rolled touch gesture
   re-enters #391's swallow window that the current `Marker`-based design is
   measurably immune to. Note also that in Aqua Map long-press *appends*, so
   adopting it for insert would contradict a surveyed product's meaning for
   the same gesture. **Not rejected for being unconventional** — savvy navvy
   does use it — but savvy navvy uses it *inside* a mode, on a chain line it
   draws for the purpose, neither of which SailCommand has.

2. **Persistent midpoint handles (candidate 3).** Rejected primarily on the
   geometry fork (§2.4): solved-leg midpoints give one handle per tack that
   churn on every replan, chain-segment midpoints put handles off the drawn
   line and possibly over land. Secondarily on the 44 px floor, which would
   put permanent 44 px discs between 16 px real waypoints.

3. **Enlarging the #850 ghost handle to 44 px and revealing it on
   `touchstart`.** Rejected: `touchstart` on the canvas is the first event of
   a pan, so revealing on it either steals every pan or requires the same
   timing threshold candidate 1 was rejected for. It also hits the
   `_element.contains` trap identically.

4. **Changing the free map tap (`handleMapTap` 'via', App.tsx:772) from
   append to `insertViaNearestOrAppend`.** This is a **fourth option, not one
   of the three**, and it is *not* part of this recommendation. It would fix
   the ordinal for the existing touch-reachable path with a one-line change —
   but it changes the semantics of a shipped gesture, and §2.6 of the
   approved named-waypoints spec scopes the nearest rule to picked waypoints
   and does not address the free tap either way (§2.3). **It needs a
   maintainer ruling before anyone implements it**, and it should be filed
   separately rather than folded into #1170. Recorded here so it is not
   silently adopted as an implementation detail of the recommendation, and not
   silently forgotten either. The same question applies to
   `handleAddViaByCoord` (#829), which appends for the same historical reason.

5. **Aqua Map's confirmation pop-up before the split.** Aqua Map asks "would
   you split the route on that position" before inserting; this
   recommendation drops that step deliberately. Under the #571 ruling a via
   edit is a plain synchronous draft write with no replan and no network
   call, reversible by the existing remove control and not applied until the
   next Plan-route press — so a confirmation would cost a tap and buy
   nothing. Recorded so the omission reads as a decision rather than an
   oversight against the surveyed source.

6. **Deferring #1170 to #1171.** Rejected. #1171 (in flight) gives a
   panel-row insert control, which *is* touch-operable — so it will deliver
   insert-at-ordinal on touch without any map interaction. What it cannot
   deliver is **choosing the geometric point on the route**: a list insert has
   no release point and must default to a midpoint or open coordinate entry
   (#1171's own text says so). #1170's remaining value after #1171 ships is
   precisely the on-map point selection. That is real, and Garmin's manual
   (§1.4) offers both paths side by side for the same reason.

---

## 6. What implementing it touches, and how big

Files, an allowlist a brief can use as-is:

| File | Change |
|---|---|
| `app/src/components/RouteLayer.tsx` | New `viaArmed` prop. While armed, register a `click` hit-test reusing the existing `nearestPointOnRoute` at a >=22 px tolerance and call a new `onRouteLineInsert`-shaped callback; widen the route casing while armed. Keep the existing hover-reveal path unchanged for pointer. |
| `app/src/App.tsx` | Pass `viaArmed={tapTarget === 'via'}`; route the line-hit insert through the existing `insertViaNearestOrAppend`; disarm on insert (same shape as `handleMapTap`'s 'via' branch returning `null`). |
| `app/src/i18n/dict.de.ts`, `dict.en.ts` | Armed-banner copy naming the route-line tap. Key parity is compiler-enforced (`satisfies Record<MsgKey, string>`). |
| `app/src/components/RouteLayer.test.tsx` | Armed/unarmed hit-test rows; a mutation must red them. |
| `app/src/App.test.tsx` | Armed line-tap inserts at the right ordinal, not appended. |
| `app/e2e/route-line-drag.spec.ts` (or a sibling) | A touch-context variant (`hasTouch`), at `tabletPortrait` 820x1180 — the device this issue exists for. |

Size: **one PR, medium-small.** INFERRED from the above: roughly 150-250
lines including tests. No new gesture recogniser, no new geometry, no new
insertion primitive — the three expensive parts all exist.

Two notes for whoever implements:

- **The load-bearing design detail: exactly ONE claimant per tap.** The naive
  shape — route layers join `interactiveLayerIds` while armed, plus a
  `nearestPointOnRoute` hit-test at >=22 px — has a double-insert hole.
  `interactiveLayerIds` resolves by point `queryRenderedFeatures`, which hits a
  line only within its RENDERED width (a few px). In the annulus between the
  line's rendered width and 22 px the generic tap does **not** bail (it
  appends) while RouteLayer's own hit-test **does** fire (it inserts) — two
  draft writes for one tap. Fix, which also turns the 44 px floor into a
  rendered fact rather than a code constant: add an **invisible hit layer**
  over the route (`line-width: 44`, `line-opacity: 0`), its `visibility`
  toggled with `viaArmed`. It joins `interactiveLayerIds` while armed so the
  generic tap bails cleanly, and RouteLayer's click handler queries that same
  layer — one geometry, one tolerance, one claimant. Declare the precedence
  explicitly, because three claimants exist while armed: **saved-waypoint ring
  > route hit-line > raw tap.** Follow the #924 precedent for the armed-only
  membership; the route layers are **not** in `INTERACTIVE_MAP_LAYER_IDS`
  today and must not be added unconditionally.
- The #850 hover effect's deps are `[map, result, onRouteLineInsert,
  draftViaPoints]`, so **every insert tears down and rebuilds the effect** —
  an insert is a `draftViaPoints` write. Harmless here (the insert disarms
  anyway), but do not re-discover it as a bug.

**Named residual, not folded in:** the via marker itself is 16 px
(`ViaMarkers.tsx`'s `viaElement()`), so the reposition-after-insert step lands
on a sub-44 px drag target. Pre-existing and independent of #1170, but this
flow depends on it, so it likely deserves its own issue rather than silent
inclusion.

**Merge sequencing:** #1171 is in flight concurrently and touches `App.tsx`
and both i18n dicts, as does this. That is a scheduled conflict, not a risk —
sequence the two merges by file surface.

---

## 7. Spec amendment

**Not required for the recommendation.** The affordance adds a producer that
uses the existing `insertViaNearestOrAppend` primitive; #850's own route-line
drag already does exactly that, and shipped without a spec amendment (recorded
as a deviation in its PR body). No spec statement is contradicted.

**Required, or at least a recorded maintainer ruling, for rejected option 4**
(free map tap append -> nearest-insert): that changes a shipped behaviour, and
§2.6's scope covers picked waypoints only. Spec edits under
`docs/superpowers/specs/` are **main-session only** — this document does not
attempt one and no subagent should.
