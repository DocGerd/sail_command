# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.20.0] - 2026-09-03

### Added

- The Live tab now carries an "AIS vessels in view" list next to the AIS status chip — each nearby vessel is a keyboard-focusable button that reads its name and details and, when activated, opens the same identification popup a map click opens — so AIS vessel identification no longer needs a pointer click on a map symbol (#831).
- Each sail leg in the results table now carries an advisory mainsail reef suggestion (Full main/1st/2nd/3rd reef), computed from apparent wind speed — it is a presentational heuristic shown alongside the route, not part of the time optimisation (#325).

## [0.19.0] - 2026-09-02

### Added

- The results panel now shows an advisory line when the active rig's route passes closer than 300 m to a cardinal or isolated-danger mark, naming how many when there is more than one — SailCommand does not use marks when routing and makes no claim about which side of one to pass; check against an official chart (#615).
- Via points can now be added and repositioned by typing latitude/longitude coordinates in the planner panel, not just by tapping the map — a keyboard-only way to place and edit waypoints (#829).
- The Plan tab now carries a collapsed "Seamarks in view" / "Schifffahrtszeichen im Kartenausschnitt" list of the seamarks inside the current map view — each row is a keyboard-focusable button that reads as the map popover would and, when activated, opens that popover on the map at the mark — so seamark identification no longer needs a pointer click on a map symbol (#830).

### Fixed

- The known-disconnected harbour disclosure no longer disappears after you select the harbour, and a plan that fails as unreachable against one now names that same limit instead of the generic "the destination cannot be reached" message (#834).
- The depth-hatch legend no longer describes the hatch cue while the hatch overlay itself is off, on both the pre-plan and route-legend surfaces (#839).

## [0.18.0] - 2026-09-01

### Added

- The harbor search now flags Arnis, Kappeln, Maasholm, Dyvig, and Gråsten as not reachable by the router at any depth setting, before you plan a route, instead of only after a failed solve (#652).
- The shallow-water hazard hatch can now be switched off independently of the water-depths overlay, from a checkbox in the map legend, and defaults on (#681).

### Fixed

- Consolidated the map's two separate "Legende"/"Legend" disclosures into one: the depth-hatch legend now folds into the route legend once a route is planned, instead of a second free-floating panel overlapping the chart (#813).

## [0.17.0] - 2026-09-01

### Changed

- **Breaking:** the own-vessel MMSI is now stored per boat instead of once for the whole app, and moves from the Live & AIS card to the Boat selection card. An MMSI identifies a vessel, so a single shared value filtered the wrong boat out of the AIS traffic display after switching boats. The previously stored global MMSI is not carried over — enter it again for each boat that needs one. The AIS API key is unaffected and stays where it was: it identifies your aisstream.io account, not a vessel (#746).

### Fixed

- Dragging the desktop panel resizer no longer leaves a stale width behind when the drag is interrupted (a browser `pointercancel`, or the resizer unmounting mid-drag) — an interrupted drag now reverts to the width it started from instead of silently persisting one the user never chose (#468).
- The depth-navigability hatching no longer renders as large hard-edged squares in a diagonal staircase when zoomed in close (roughly z14 and beyond, e.g. a harbour approach). At those zooms one mask cell is already wider than the stripe pattern can express, so the raster now marks every cell whose cautious depth reading falls below the safety depth instead of one cell in four — the marked area is strictly larger and never lighter than before, and its edges follow the depth data's own ~46 m cell grid rather than an artificial diagonal. This is a graceful degradation, not a resolution of the underlying per-cell raster limit: over marked water the absolute depth colours are now largely covered at these zooms, and rendering a truly zoom-invariant hatch still needs the screen-space approach tracked in #792. Zoom levels 13 and below are unchanged (#648).
- The "Plan route" button now stays pinned to the bottom of the planner on phones and other narrow screens, so it is always in reach instead of sitting below a long scroll. It keeps clear of the map's attribution control, which stays on top and clickable (#702).
- The origin marker in the trip planner now uses the same accent colour as the destination marker, instead of an unrelated map colour that never matched the destination pin or changed with the app's dark theme (#715).
- The safety-depth field's German label ("Sicherheitstiefe") no longer overflows its column on the wide-layout side panel (tablet landscape and similar widths) — it now wraps instead of spilling past the field's edge (#762).
- The map's OpenStreetMap attribution link is clickable again on phones and other narrow screens: scrolling the planner down to the "Plan route" button used to cover the credit control and swallow taps on it (#771).
- The route legs table scrolls sideways when its ten columns do not fit, and that scroll can now be reached and operated from the keyboard: the table takes a tab stop of its own, announces what it is and that the arrow keys scroll it, and shows a focus ring while it holds keyboard focus (#774).
- About dialog: fixed a missing word in the English depth-mask safety caveat that made it misparse on first read (#776).
- GPX import now classifies a point exactly on the data-area's edge the same way the router's own bounds check does: a point sitting exactly on the northern or eastern boundary of the covered area is now rejected at import with "A point lies outside the covered area (Flensburg Fjord / Danish South Sea)." — previously such a point was accepted by the importer even though the router treats that same boundary as outside the routable area (#779).
- The About dialog's keyboard focus trap now skips elements that are present in the DOM but not actually visible/focusable (e.g. `display: none`), so a future conditionally-rendered control inside the dialog can't silently become an unreachable Tab stop; no currently-shipped dialog content was affected (#780).
- The shallow-water warning's collapsible explanation now starts closed on every route, instead of opening automatically whenever the cautious depth reading falls below the boat's draft — a condition that is met on every relaxed route at each boat's own default safety depth, so at default settings the explanation always opened. The warning itself is unchanged and no quieter: the cautious depth reading, the safety depth the route was planned at, how much of the route crosses shallow water where that has been measured, the below-draft wording where it applies, and the caveat about the depth data all stay visible without interaction (#788).
- Messages that told you to change something "in Options" now name a place that exists. The AIS status chip, the no-wind-with-motor-off message and the polar-data caveat all pointed at an "Options" screen the app has never had; they now name the Boat tab and the card the relevant setting is actually in (#804).

## [0.16.0] - 2026-08-31

### Changed

- Moved the legs table's Shallow column to the first position and stacked its two depth chips vertically, so the populated column now fits within the visible table at phone width in both languages and both rigs instead of overflowing behind the horizontal scroll; the table also gained a CSS-only scroll-shadow cue so it is always visible when there is more to scroll (#698).
- Blocking and safety-relevant alerts (GPX import errors, the plan-disabled reason, plan/recalculation failures, the offline recalculation notice, an invalid AIS MMSI, the stale-forecast and no-route lines) now render with a visually distinct treatment — a coloured wash, left border and bold weight — instead of the same muted grey used for plain FYI hints (#703).
- The About dialog's close button, Live view's GPS-hint dismiss, and the Plans list's recalculate/delete row actions now render through the app's shared button style — accent focus ring and consistent chrome instead of bare browser-default buttons (#705).
- Out-of-range numeric settings (safety depth, depth comfort margin, maneuver penalty, performance factor, motor speed, motor threshold, sail preference) now show a visible "corrected to …" notice when a typed value is pulled back inside its allowed range on blur, instead of silently rewriting it (#731).
- The shallow-depth warning now collapses its explanation behind a disclosure, expanded by default only when the route's cautious reading falls below the boat's own draft — the depth figure and severity always stay visible without interaction (#747).
- The stale-forecast notice is now a short label showing the actual fetch-to-departure gap in whole hours ("Forecast 14 h old at departure") instead of a full explanatory sentence (#748).

### Fixed

- The About dialog now traps keyboard focus (Tab/Shift+Tab cycle within it instead of escaping into the map behind the backdrop) and adds a close button beside the title, reachable without scrolling past the whole dialog (#696).
- The rest of the app shell (map, header, banners, resizer, bottom panel) is now marked `inert` while the About dialog is open, so a screen reader's virtual cursor or browse mode can no longer reach live map or routing controls behind the modal (#696).
- Boat tab: the draft-provenance citation is now reachable by screen readers on every boat (not just ones with an unverified keel) and is visually separated from the keel caveat with a left border, instead of reading as one run-on paragraph (#701).
- Fixed the AIS popup's "last signal" row reading as broken German ("Letztes Signal vor: 2 min") by building the age value per-language instead of a bare literal — German now reads "Letztes Signal: vor 2 min", English "Last signal: 2 min ago" (#709).
- Fixed inconsistent waypoint terminology (three keys said "via point"/"Zwischenpunkt" while the rest of the app said "waypoint"/"Wegpunkt") and reworded the generic routing-error message so it no longer advises retrying when the app's own logic says a retry will not help (#712).
- Reopening the origin or destination picker via "Change" now moves keyboard focus into its search box instead of dropping it to the page background (#737).
- Fixed the safety-depth compact row misaligning the departure and safety-depth inputs, and the allowed-range help text sometimes wrapping its unit onto its own orphan line (#744).

## [0.15.0] - 2026-08-27

### Added

- The safety-depth field now shows its allowed range as visible help text, and switching to a shallower-draft boat scrolls the resulting clamp notice into view (#699).

### Changed

- The Live view heading-to-steer caution now gets a background wash and left border matching the route-level shallow-water warning, instead of a colour-only text change, since it is the only depth/land hazard shown while actually steering (#697).
- The Live view GPS tracking toggle now shows a state-dependent label and a filled/outline visual distinction between tracking on and off, rather than relying solely on the non-visible aria-pressed state (#700).
- Keyboard focus rings and the app's accent colour now cover the tab strip, the map-chrome checkboxes and time slider, the boat radio group, and the depth/route legend disclosures, and boat picker rows show a hover state (#706).
- Text, number and departure date/time fields now draw the same bordered card box as the rest of the planner panel instead of bare native chrome (#710).

### Fixed

- Hazard seamarks (cardinal and isolated-danger buoys) now paint above routine marks where they overlap at the closest map zooms, instead of sometimes being hidden underneath one (#682).
- Re-picking or cancelling an origin or destination search now returns keyboard focus to the corresponding "Change" button instead of dropping it to the page body (#695).
- The app-shell and rig-comparison tab strips now complete the standard keyboard tabs pattern — arrow keys move between tabs, only the active tab sits in the normal Tab order, and each tab's content is programmatically linked to it for screen readers (#704).
- Banner dismiss buttons now meet the app's 44px touch-target floor, the planner panel resists rubber-banding the map on overscroll, and a via-point coordinate no longer risks overflowing its row on narrow screens (#708).
- Live view's HTS/COG/SOG/ETA readout no longer shifts label-value spacing from an unreset browser default, digits use tabular figures so they don't jitter on every GPS update, and the English "HTS" abbreviation now has a screen-reader expansion (#713).
- The map attribution control's "i" toggle button now inverts to a white disc with a dark icon in dark mode instead of always keeping its fixed light-mode colours (#718).

## [0.14.0] - 2026-08-25

### Changed

- Submarine cable and pipeline seamarks are now shown at the default
  "Standard" map-display setting instead of only at "All" (#521).
- The route-overlay toggles, forecast-time slider and route legend now
  collapse behind one "Display options" control instead of always covering
  part of the chart, starting collapsed on mobile-width screens and open on
  wide screens (#628).

### Fixed

- Tapping an overlapping pair of seamark symbols now anchors the info
  popover on the mark it actually describes instead of always on the tap
  point (#232).
- The saved-plans list now tells you a plan saved by a newer app version is
  kept, not deleted, matching the wording already used for a damaged record
  (#561).
- The "sails are effectively tied" message now names the two sails actually
  being compared, instead of a hardcoded "Genoa and Fock" that would have
  named the wrong sails for a future boat with different sail names (#578).
- Depth figures in German now use a decimal comma, matching the distances
  and speeds beside them, instead of mixing a comma-formatted distance with
  a point-formatted depth in the same sentence (#596).
- The legs-table depth marker and the map's shallow-water highlight now
  also appear on an ordinary route that crosses water whose more cautious
  depth reading falls below your safety depth, even when the route itself
  was never depth-relaxed — previously only a relaxed route showed either
  signal (#651).
- Fixed a crash when opening a saved route whose waypoint data was
  corrupted; such a route now shows as unable to open instead of crashing
  the app (#654).
- Editing the origin, destination, departure, or a via point on the Plan
  form while a restored plan is still loading harbor data no longer gets
  silently discarded once that data finishes loading (#660).
- Fixed a saved route whose stored rig-comparison verdict was corrupted or
  unrecognised rendering a blank recommendation chip; it now shows the
  honest "no faster rig claimed" message instead (#661).
- A saved plan whose stored routing outcome can no longer be read now tells
  you to plan the route again, instead of showing generic "try again or
  reload the app" copy that could never help on that screen (#662).
- Improved screen-reader support: the app now exposes a single "main
  content" landmark, the route legs table announces its column headers and a
  name, and the boat catalogue's English source citations are marked as
  English so they aren't read with German pronunciation (#707).
- Fixed the map's attribution ("i") card showing a stark white background in
  dark mode — both collapsed, as it appears on load, and when opened; it now
  matches the app's dark theme (#711).

## [0.13.1] - 2026-08-24

### Fixed

- Reworded three boat-catalogue notes on the Boat tab into plain language,
  removing an internal spec section id, an issue number, and three raw
  catalogue ids (two boat ids, one sail id) that had leaked into user-facing
  copy (#595).
- An unrecognised stored no-route reason no longer renders an empty alert
  and now falls back to the generic error message (#614).
- Opening the Live tab with a previously saved route that is missing its
  safety-depth setting no longer crashes the app; the depth check now
  honestly reports "not checked" instead (#632).
- The depth-hatch legend now renders on its own panel background in both
  light and dark mode, and its text no longer breaks mid-word on wider
  screens (#638).

## [0.13.0] - 2026-08-20

### Added

- The map's depth-overlay controls now include a legend (collapsed by
  default, reachable without an active plan) explaining the cautious-reading
  hatch: it flags water where the more cautious of two depth readings could
  fall below your safety depth, even where the depth color itself still
  looks clear (#598).

### Fixed

- A route whose sail comparison was cut short by the search budget now says
  so: the rig-comparison chip on the Routes tab and the compact planning
  result now show a dedicated "search ran out of time" message instead of
  the generic no-comparison text, so a one-sail recommendation is never
  mistaken for a finished two-sail comparison. A legacy stored plan from a
  narrow pre-fix window that had wrongly kept its faster-rig star despite an
  incomplete comparison now loses it on re-open (#540).
- The depth profile chart on the Routes tab now reads the safety depth the
  active plan was actually solved with, instead of the Boat tab's current
  safety-depth setting — lowering or raising the setting after planning no
  longer changes what the chart's safety line shows for an already-computed
  route (#551).
- The new depth-hatch legend (#598) states plainly that unsurveyed and
  drying water carries no hatching at all and looks like ordinary water on
  the map, so its absence must never be read as "the water is clear" (#597).
- The depth-navigability hatch now picks its stripe width per zoom band
  instead of using one fixed cell-space pattern at every zoom, so the
  stripes stay legible instead of washing out to a faint haze when zoomed
  out. Measured in a real browser, the on-screen stripe at the app's
  starting zoom goes from about 1 px to about 8 px, and the wide bands at
  harbour-approach zoom are halved. Which water the hatch marks is
  unchanged — this affects only how that marking is drawn (#599).
- A route that stays within your safety depth now says so when it still
  crosses water a more cautious reading of the chart puts below that depth,
  and states how far. Until now only routes the planner had to re-plan at a
  reduced depth carried any per-route depth warning at all (#612).

## [0.12.1] - 2026-08-19

### Added

- The depth overlay now shows sparse hazard hatching over water whose
  cautious, worst-case reading falls below your safety depth, so a spot the
  absolute depth colors alone might show as comfortably clear can still be
  flagged as marginal at the safety depth you've set (#492).

### Changed

- The Boat tab now shows the source note behind each boat's stated draft
  (where the figure came from, and what it does and does not establish),
  alongside the existing keel-assumption caveat — for every boat, including
  the hull-verified reference boat (#566).

### Fixed

- The legs table's per-leg distance now renders to two decimal places
  instead of one, so two distinct short legs (e.g. 0.50 nm and 0.55 nm) no
  longer round together to the same displayed value. The plan-level total
  distance and per-leg speed keep their existing one-decimal precision
  (#439).
- The map's scale bar no longer disappears on short landscape phones (e.g.
  740x360) when a single-line banner (offline, plan-error, or app update
  available) is shown — it previously reclaimed less headroom than one
  banner line costs. Two or more banners stacked at once, or a banner that
  wraps to two lines, can still hide it. The "update available" banner also
  now has a dismiss (x) button of its own, cleared for the rest of the
  current session; it reappears the next time a newer update becomes
  available (#441).
- Distances and speeds now render with the correct decimal separator for
  the active language instead of always using a point: German shows a comma
  ("21,5 nm"), English keeps the point ("21.5 nm"). Covers the results
  panel's totals and legs table, the sail/motor split, the planner's
  compact result strip and its live-region "plan ready" announcement, Live
  View, AIS popups and route map labels (#525).
- Adding, removing, reordering, or dragging a waypoint no longer
  recalculates the route in the background: previously, every planner
  control locked up for the whole recalculation with no stated reason. A
  waypoint edit is now a plain, instant change to the plan — press "Plan
  route" to apply it, exactly like any other trip change — and the app
  shows a clear "not yet applied" indicator, both in the planner panel and
  on the map, until you do (#571).

## [0.12.0] - 2026-08-19

### Added

- Settings now has a Map display group for seamark symbols: a size slider
  (50-150%) and a Base/Standard/All display-category selector, whose
  three-tier ladder is modelled on the ECDIS Display Base / Standard Display
  / All Other Information split (IMO MSC.232(82)). Cardinal, lateral,
  safe-water and isolated-danger marks, and major lights, are never hidden by
  the category selector. Standard (the default) hides only submarine cable
  and pipeline markers — this app's own decluttering choice rather than part
  of that convention (#521); select All to show those too (#353).
- Route legs flagged as shallow now also show a cautious lower bound
  alongside the charted depth, and the plan-level shallow-water warning leads
  with that cautious floor, escalating to a stronger wording and styling when
  it could fall below the boat's draft (#493).
- The plan-level shallow-water warning now also states, when true, that every
  stretch of water charted below your safety depth lies close to your origin,
  destination or waypoints (e.g. "Every stretch below your safety depth lies
  within 1.0 nm of your origin, destination or waypoints") — reassurance that
  only ever renders when it can be measured, and is silently omitted
  otherwise (#516).
- The plan-level shallow-water warning now states how much of the route
  actually crosses charted-shallow water (e.g. "0.3 nm of this route crosses
  water charted shallower than your safety depth of 3.0 m"), computed against
  the currently loaded depth mask, plus a one-line suggestion that lowering
  the safety depth setting may find a more direct route. Both sentences are
  omitted when the measured exposure is zero (#516).
- Boat selection on the Boat tab: pick the boat you are planning for, with
  its draft and the provenance of its polar data shown per boat and per sail.
  The choice is remembered on this device, and a boat whose entry has been
  withdrawn falls back to the default rather than failing to load. Switching
  to a deeper-drafted boat now raises the safety depth to that boat's minimum
  and says so; it never lowers a depth you chose yourself. The safety-depth
  field's own minimum follows the selected boat on both the Plan and Boat
  tabs. Where a boat's draft is the model's standard keel rather than that
  hull's own papers, the picker says so.
- Two Flensburg fleet boats gain polar tables in the shipped data: the Salona
  44 (SPEEDY GO!) and the Elan Impression 444 (PIRANJA). Both are
  **estimated**, not measured — no ORC/IRC certificate or published VPP was
  obtainable for either hull, so each table is the Salona 45’s
  certificate-anchored jib table scaled by one uniform hull scalar — the
  square root of the two hulls’ sail-area/displacement ratios — and each
  inherits the Salona 45’s pointing angles rather than deriving its own.
  Speeds are typically within a few percent, up to about ten percent in
  individual conditions; on the Elan’s fock that error is called out as
  large enough in light air to flip a leg between sail and motor. Every
  table carries its own source note.

### Changed

- Boat/skipper settings (depth comfort margin, motor/sail preference, AIS)
  moved off the Plan tab's collapsed "Advanced" disclosure into a dedicated
  **Boat** tab, so they stay visible alongside the map and the current route
  instead of hiding behind a modal or an accordion. Safety depth itself stays
  inline on the Plan tab (still the two most-changed inputs' quick-access
  row), with a discoverable link over to the Boat tab for the rest. A
  settings change that invalidates the displayed route now shows a
  stale-route banner on every tab, not only the Plan tab (#299).
- Shallow-water relaxation is now confined to harbour approaches. When a
  route cannot be planned at your safety depth, SailCommand may still relax
  the depth gate to reach the destination (#53) — but that relaxation now
  applies only within 1 nm of a waypoint you actually chose, instead of along
  the whole passage. A shallow pinch far from every waypoint is reported
  honestly as unreachable rather than routed through. Each waypoint's
  approach also gets its own gate, so an approach that needs no relaxation is
  tightened back to within 0.1 m of your safety depth instead of inheriting
  the shallowest gate the passage needed anywhere.

### Fixed

- The Plan tab's screen-reader status region stopped announcing a stale route
  in one case: editing only the origin, destination, or departure time (no
  setting touched) left the region silent, because a previous fix scoped its
  fold to the settings-only staleness banner shown on every tab. The status
  region now announces staleness whenever it isn't already covered by that
  banner, so every case is announced exactly once, with no gap and no double
  announcement (#299).
- The shallow-water warning now says where the shallow section actually is:
  flagged legs carry a "Shallow" marker with their charted depth in the legs
  table, and the warning itself gains a sentence naming how many legs are
  affected and when the first one starts (#452).
- The shallow-water warning now also appears on the compact result strip
  right after planning, not only on the Routes tab — and it now names the
  reduced depth the route was actually computed at, alongside the depth you
  requested, whenever the planner had to relax below it to find a route
  (#452).
- The About dialog now discloses a bound on the depth mask's remaining
  uncertainty: the depth value the app uses is never more than 0.9 m deeper
  than a more cautious reading of the same EMODnet bathymetry data. At the
  default 3.0 m safety depth, a cell the router plans through has a cautious
  reading of at least 2.1 m, the boat's draft — but as little as 1.2 m where
  a route falls back to a shallower depth gate to stay connected, flagged on
  the resulting route (#455).
- The depth mask no longer lets a smoothed depth reading run far ahead of the
  most conservative reading of the source bathymetry. At the default 3.0 m
  safety depth, every cell navigable at that requested depth has a
  conservative depth of at least the boat's 2.1 m draft; previously 924 cells
  were navigable at that setting despite reading below draft. Lowering the
  safety depth below the default lowers that floor by the same amount, as
  does a route falling back to a shallower depth to stay connected — which
  can take it as low as 1.2 m even at the default setting, flagged on the
  resulting route. Some planned routes change as a result — a few become
  shorter, where the mask had been reading water shallower than the source
  supports (#455).
- The About dialog's data-source list no longer shows the land/depth mask's
  OpenStreetMap ODbL statement twice: the regenerated mask carries it in
  its own metadata, which that list already renders, so the separate static
  entry has been removed (#455).
- The bundled third-party license notices were missing an entry for
  `workbox-strategies`, one of the service worker's runtime dependencies —
  the notices file now lists all shipped packages (#466).
- The depth profile's "min." figure could understate how shallow a route
  actually gets: it was sampled uniformly in time (up to 240 points across
  the whole trip), so a leg shorter than the sample interval could fall
  between two ticks and be skipped entirely — on one observed route the
  profile read 2.9 m while the shallow-water banner correctly reported 2.3 m
  for the same route. The headline figure is now computed by walking every
  leg's actual charted cells, the same exhaustive method the banner uses, so
  a short leg can no longer be missed. In the rare case that walk cannot be
  completed, the figure now shows "min. — unknown" instead of silently
  falling back to the old, potentially-optimistic reading (#505).
- The per-leg shallow-water chip's amber hazard fill now actually renders — a
  CSS source-order cascade bug meant it always resolved to the same neutral
  grey fill as every other chip (#506).
- Depth safety copy now describes the boat it is actually about. The
  shallow-water warning states the draft of the boat the plan was computed
  for (not the Salona 45's 2.1 m for every boat), decides its severe wording
  against that same draft, and offers the "choose a lower safety depth"
  advice whenever that boat's own minimum leaves room for it — on the Elan
  Impression 444 that advice had been suppressed exactly where it was
  actionable. The About dialog's depth-mask note is likewise written for the
  selected boat, naming it and stating its own default safety depth, draft
  and worst-case cautious reading.
- A saved plan the app could not read no longer disappears from the Routes
  list. Such a plan was previously skipped, so from where a sailor sits it
  was indistinguishable from having been deleted, while its data was still on
  the device. It is now listed with its name and creation date where the
  stored record still carries them, saying either that a newer version of the
  app wrote it or that the saved record is incomplete, and it is never
  deleted automatically (#54).
- A route is now always calculated for the boat the plan itself names,
  instead of always for the Salona 45. Because the boat determines both the
  speed tables and how far the depth limit may be relaxed, a second boat's
  route would have been calculated against the wrong hull while the app
  displayed the correct boat name. If a saved route names a boat that is no
  longer available, the app now says so plainly and states that only
  recalculating is unavailable — the route still opens, and can still be
  viewed and exported (#553).
- The app no longer names a faster sail when it did not actually compare
  two. Previously a passage on which only one sail found a route was still
  reported as `Faster: <that sail>`, which read as the outcome of a
  comparison that never happened; it now says the sails were not compared
  (#553).
- Planning a route now uses the boat you selected. Every new plan was
  previously solved with the Salona 45's polars and its depth-relaxation
  floor whatever the boat picker showed, while the picker, the polar-tier
  chip, the keel note and the safety-depth field all correctly described the
  boat you had chosen. Saved plans are unaffected and still re-plan against
  the boat they were planned for.

## [0.11.0] - 2026-08-08

### Changed

- Re-planning from the Plan view now prefills the form (start, destination,
  waypoints, departure) from the currently displayed route, and flags it as
  outdated with a chip in the results card whenever an input has changed
  since that route was calculated (#301). Re-running always saves a new
  plan — it never overwrites the one shown, so both stay available under
  Routen for comparison.

### Fixed

- The nautical scale bar now renders on short landscape phones (e.g. 740x360)
  instead of being suppressed on every tab: the top-left map controls
  (water-depth and seamark toggles, compass) lay out as a compact row
  instead of a stacked column there, freeing the vertical room the scale
  bar needs. The scale bar can still be suppressed while an app banner
  (e.g. an available-update notice) is showing, since a banner pushes this
  control cluster down further (#441) (#231).
- The About button no longer bets on font coverage for its icon — the
  bare U+24D8 CIRCLED LATIN SMALL LETTER I character (measured to render
  as tofu on some Linux font sets) is replaced with an inline SVG, matching
  the map compass control's existing pattern (#427).
- A route calculation that runs out of time now says so. The solver is
  given a wall-clock budget for the whole plan and stops honestly when
  it is spent, reporting that the search was cut short — explicitly not
  that no route exists — instead of the previous "Route planning failed
  unexpectedly. Try again; if it keeps happening, reload the app.", which
  named neither the cause nor anything the skipper could act on. Adding
  a via point to an existing route, and "reroute from here" in Live view,
  now report the real cause of a routing failure too (a timeout, a crashed
  engine, a failed save) rather than collapsing every one of them onto that
  same generic message, and they release the abandoned routing worker so
  a retry starts from a clean engine instead of stacking onto a busy one
  (#432).
- A route-planning failure that used to show the same generic "unexpected
  failure" message and advice for seven unrelated causes — a crashed
  routing engine, a routing timeout, an internal routing error, a save
  failure after routing already succeeded, and more — now shows a distinct
  message per cause, each with honest advice about whether "Try again"
  can actually help (#433).

## [0.10.0] - 2026-08-07

### Added

- The desktop left panel is now resizable — drag the handle between the panel
  and the map, or focus it and use the arrow keys (Shift for a larger step,
  Home/End for the bounds, Enter or a double-click to reset). The chosen width
  survives a reload; narrow (phone/tablet-portrait) layouts are unaffected
  (#355).
- Added a Duration column to the legs table, alongside the existing Distance
  and Speed — a per-leg elapsed time so a route's pacing is readable at a
  glance without doing arithmetic (#379).

### Fixed

- Corrected the legs table's "Heading" column label to "COG" — the value it
  shows is course over ground, and this app models no leeway (#379).

## [0.9.0] - 2026-08-05

### Added

- The map can now show both foresail routes at once, so a genoa/fock
  recommendation can be compared visually rather than only through their
  ETAs. A new "Anderes Rigg anzeigen" ("Show other rig") toggle in the
  route-layer controls (off by default) overlays the rig NOT currently
  displayed, as a dashed, lower-opacity track — the active route stays solid
  and unchanged, and the recommendation badge still says which rig is faster
  and by how much. Nothing else re-keys: the depth profile, leg list and
  wind-barb slider all stay bound to the active route as before. Pure
  presentation over data the plan already computes — no extra solver run, no
  extra wind forecast fetch (#324).

### Fixed

- The wind-barb forecast-time slider now shows which day it refers to
  instead of a bare clock time: a passage running past midnight gets a short
  weekday prefix, and an older saved plan gets a short date once it's more
  than a few days old — so "03:00" can no longer be misread as tonight when
  it's actually three days ago. The slider's accessible value always carries
  the full date and time for screen readers, independent of the abbreviated
  visible label (#292).

- Spar-shaped lateral marks (the majority silhouette — 524 of 828 in-area
  lateral marks) now render a can or cone topmark, matching pillar marks.
  They previously carried none, leaving the port/starboard side conveyed by
  colour alone (#307).

- Black-tagged special-purpose marks now get a near-white keyline around
  their body, fixing a contrast gap where they were nearly invisible against
  the dark-theme basemap (#308).

- The build-time plugin that adds the UAT `noindex` robots meta and rewrites
  `og:url`/`og:image` for the deploy sub-path now fails the build loudly if
  one of its `index.html` markers ever drifts, instead of silently shipping
  without the injection — matching the guard `cspMeta()` already had (#318).

- The route-planning status now shows an honest, bounded phase readout
  ("Calculating route… sail 1 of 2 (Genoa)") instead of a percentage that
  capped around 5% and reset to 0% when the router switched from the genoa
  to the fock rig solve, or when a depth-relaxation retry restarted the
  solve — both were the readout doing exactly what its formula said, not a
  glitch, but neither was a meaningful measure of progress (#340).

- The boat-position marker on the map now has an accessible name again
  ("Current vessel position" / "Aktuelle Bootsposition"). The maplibre-gl
  6.1.0 bump stopped supplying a default one for markers built with a custom
  element, leaving the ownship indicator with none at all (#361).

- On taller narrow-portrait phone viewports (390x844, 360x740), the offline
  status banner no longer overlaps the top-left map chrome, where it used to
  make the "Wassertiefen" (depth) toggle unclickable underneath it. The
  map-chrome cluster now moves clear of a rendered banner's footprint
  instead of relying on a z-index bump, which would only have decided which
  element painted on top and left the hit test wrong either way. At some of
  these heights (measured: 375x667, 360x740) the passive scale bar now
  suppresses itself while a banner is shown, an accepted trade rather than
  an oversight — it stays out of the way of the now-clickable toggles
  instead of overlapping them. Shorter viewports (narrow landscape, and
  narrow portrait below roughly 636px tall with two banners shown) are not
  covered by this change and keep the existing overlap (#368).

- Closes the remaining #368 gaps: the offline/status banner area no longer
  overlaps the top-left map chrome (compass, "Wassertiefen"/"Seezeichen"
  toggles) at every narrow viewport and banner combination this fix was
  tested against — short landscape (844x390, 740x360), deep portrait (down
  to 320x568 with two banners shown), three or more stacked banners, and a
  banner that wraps to two lines, not just the two portrait sizes and
  single-banner case the first pass closed. The map chrome is now pushed
  clear by the banner area's REAL measured height rather than a
  viewport-height estimate, so it clears whatever is actually on screen
  instead of only the cases that estimate happened to cover — including a
  banner already visible on a cold load, since the measurement now lands
  before the browser's first paint rather than after.

- The nautical scale bar could render fully on top of the top-left
  map-chrome column (the depth/seamark toggles and compass) instead of
  hiding itself out of the way, on narrow phone viewports whenever a status
  banner appeared after the map had already loaded. It now updates
  immediately when a banner appears or disappears, so it reliably clears the
  toggles or hides itself instead of sitting on top of them (measured on
  375x667 and 360x740, #368).

- Waypoint ETA labels could vanish outright at some zoom levels, and the
  ETA/track-speed text was too small to read on deck in daylight. The
  disappearance turned out to be the dense wind-barb layer: it was already
  protected from being culled itself, but wasn't marked to stay out of the
  way of the ETA/speed labels underneath it, so it blocked them from being
  placed. ETA/speed text now scales up at higher zoom, and MapLibre is given
  several fallback positions per label before giving up on it, instead of
  one fixed spot with no fallback (#378).

## [0.8.1] - 2026-08-04

### Fixed

- Corrected v0.8.0's Security note, which overstated GitHub "Verified" badge
  coverage: the v0.8.0 tag was signed under an email address not registered
  on the maintainer's GitHub account, so GitHub cannot attribute the
  signature (`verified: false, reason: "no_user"`) even though the signature
  itself is cryptographically good (`git tag -v` reports `Good` signature).
  This is an attribution gap, not a signature problem, and it is permanent
  for the v0.8.0 tag specifically — re-tagging was considered and rejected:
  a published tag is treated as immutable here, since it is an attestation
  third parties may already have verified, and moving or re-creating it
  would invalidate that. The fix is forward-only, not a retag. The
  maintainer's signing identity is now fixed going forward via a repo-local
  `git config user.email`; the badge is expected to show correctly from this
  release onward. `git tag -v` / `git verify-tag` verification was, and
  remains, unaffected for every signed tag including v0.8.0 (#322).

## [0.8.0] - 2026-08-03

### Changed

- Upgraded maplibre-gl 6.0.0 -> 6.1.0. The one change this app exercises:
  draggable via-point markers (added when inserting a stop mid-route) now
  show a grab cursor on hover — a small drag-affordance fix, not a new
  feature (#347).

### Security

- Release tags are now cryptographically signed starting at v0.8.0 (SSH
  signing), independently verifiable with `git tag -v`/`git verify-tag`. The
  v0.8.0 tag itself does not show GitHub's "Verified" badge — it was signed
  under an identity not registered on the maintainer's GitHub account, so
  GitHub cannot attribute the signature; see the v0.8.1 entry above for the
  cause and current status. A signed tag attests that the tagged commit is
  authentic; it does not, on its own, prove the bytes your browser downloads
  match it — see SECURITY.md for the full picture. Tags through v0.7.0
  remain permanently unsigned — signing is not retroactive (#322).

## [0.7.0] - 2026-08-03

### Changed

- Upgraded maplibre-gl 5.24.0 -> 6.0.0. `Map` no longer exposes `isEasing()`
  (it moved onto the internal `Camera` object `Map` now holds instead of
  extends); the compass control's camera-settle guard was rewritten to derive
  the same "our own ease is still in flight" signal from state the app
  already owns, narrower than before but with no reachable behavioral change
  in this app today (#253). The upgrade also broke the vector basemap in
  production: v6 loads its worker via an internal `new URL(...,
  import.meta.url)` Vite cannot see through, so the worker chunk was never
  emitted into the build and the map never loaded outside `vite preview`'s
  SPA-fallback masking. Fixed via maplibre's own `setWorkerUrl` escape hatch,
  fed a Vite `?worker&url` import so the worker ships as a hashed, precached
  asset. The `worker` half of that suffix is load-bearing: v6 splits its
  worker across two files, and a plain `?url` copies only the entry file
  verbatim, leaving an unresolved `./maplibre-gl-shared.mjs` import that 404s
  at runtime — `?worker&url` bundles the pair into one self-contained chunk
  (#253).

### Fixed

- Buoy and beacon symbols no longer merge their topmark into the body below
  it. A pillar-shaped port-hand mark used to render as a single red box with a
  barely visible bump on top; it now carries a clearly separated topmark, and
  the topmark is the shape IALA R1001 actually specifies for that side of the
  channel — a can for port-hand marks, a cone for starboard-hand ones,
  instead of the ball both used to get (a ball is the safe-water mark's
  topmark). Which side a mark belongs to is now read from its category rather
  than guessed from its colour: 51 lateral marks in the chart area carry a
  colour that contradicts their category, and the 11 of those drawn as pillars
  — the only shape this change gives a topmark — now show the correct side.
  The other 40 are drawn as spars or cans, still carry no topmark, and are
  unchanged for now (#307). A mark with no category shows no topmark at all
  rather than a guessed one. Isolated danger marks again read as the two
  separate spheres that distinguish them, where before the pair merged into
  one blob against a black body, and the safe-water sphere and special mark's
  cross now stand clear of the bodies they sit on and stay legible in dark
  mode (#298).
- Seamark detail popovers are now fully localized: field values such as the
  mark's type, category and colours appear in the selected language instead
  of staying raw English data words, so a German UI no longer shows
  `Kategorie: port` or `Farbe: green`. Any value not covered by the
  translation falls back to the previous readable form, so unusual tags still
  display sensibly (#300).

### Security

- Added a Content-Security-Policy and an explicit referrer policy to the app
  shell. Background network requests — fetch, XHR, WebSocket, `sendBeacon` —
  are now limited to the app's own origin plus the two services it already
  talks to (the Open-Meteo wind forecast and, if you've entered a key,
  aisstream.io's AIS feed), so a compromised dependency could no longer
  quietly send your data to some other server over those channels. It is not
  a complete seal: page navigation, opening a new tab or window,
  prefetch/preconnect hints and WebRTC stay unrestricted, and the full list
  of accepted gaps is in `docs/security-assurance-case.md`. The referrer
  policy limits how much of the current page's URL is sent to other origins
  (#223).
- Resolved a known vulnerability (GHSA-mh99-v99m-4gvg) in a transitive
  dependency (`brace-expansion`) via a lockfile update. This package is used
  only by build tooling, not shipped in the app itself, so users of the app
  were never exposed; no application behavior changed (#281).

## [0.6.0] - 2026-07-31

### Added

- Depth comfort preference: beyond the hard safety-depth gate, the router now
  also prices every candidate segment on its minimum charted clearance —
  free at/above safety depth + a new "depth comfort margin" setting
  (default 2.0 m, 0 = off), up to ~1.43× the crossing time right at the gate,
  linear in between. Routes now prefer deeper water when it costs little
  extra time, instead of hugging the safety-depth line whenever that saved
  any time at all. The charge lands on the search's ranking clock, never on
  route geometry or the displayed ETA/timestamps, and a #53 relaxed-depth
  solve keeps the preference anchored to the *requested* safety depth, so a
  relaxed gate no longer makes sub-requested water equally attractive along
  the whole passage — only where the mask actually forces it. A plan's
  **recommended rig can change** from before this change as a result (#243).
  The preference minimizes total shallow-water exposure along a route, not
  its single shallowest point — in rare cases a route's minimum charted
  clearance can decrease even as its overall exposure to shallow water falls
  (#243).

- Live view: the heading-to-steer readout now says when the bearing to the
  active waypoint crosses water charted shallower than the plan's safety
  depth, naming the shallowest charted depth along that bearing. The heading
  is a straight bearing to the next waypoint, not a depth-validated course,
  and it was previously shown with nothing to indicate that. A bearing that
  crosses charted *land* is called out as land, not as a 0.0 m depth reading.
  When the depth data cannot be checked at all — no mask yet, a position
  outside chart coverage, or the plan having just changed — the readout says
  so explicitly ("Depth not checked") rather than staying silent: an absent
  warning never means "checked and clear" (#251).

### Changed

- About dialog: the "Data sources" section now starts collapsed, tapping it
  open like the "What's new" changelog section above it, instead of always
  showing its full text (#187).

- Rig recommendation: an ETA difference between genoa and fock under one
  minute is now reported as a tie rather than silently badging one rig as
  "recommended." A route that motors the whole way now says the rig choice
  doesn't matter for that passage, since the polar never came into play. This
  changes what the app's own demo route shows: Langballigau → Sønderborg
  (genoa and fock about 14 seconds apart over an 81-minute passage) now
  reports a tie instead of a recommended rig (#259).

- The planner now uses the engine wherever motoring would be meaningfully
  faster than sailing, instead of only where sailing speed fell below the motor
  threshold. A new **Sail preference** setting (default 2.8 kn) controls how
  much boat speed the planner will give up in order to keep sailing: it keeps
  sailing while sailing speed is within that many knots of motoring speed.
  Raising it to motoring speed minus the motor threshold restores the previous
  behaviour exactly. This removes the light-air zigzag in which a route wove
  under engine as if beating to windward — the old rule left most of the
  compass locked to sail even where motoring was nearly twice as fast, so the
  route had to weave between the few headings it was allowed to motor. The
  trade is deliberate: in marginal wind the planner will now start the engine
  where that is faster, so passages in light-to-moderate air may show
  substantially more motoring than before, and arrive earlier. Raise the sail
  preference if you would rather sail and arrive later (#254).

- A preferenced solve that fails to find a route is automatically retried
  without the depth comfort preference before the plan degrades further, so
  no passage that routed before this change can fail to route now (#243).

- The chart no longer straightens itself to north when you let go of a
  rotation within 7° of north. That automatic straightening came from the map
  library's own default and was what caused the course-up bug fixed below; the
  app has always had its own, deliberately tighter version of the same
  affordance — ease a rotation to a stop within **1°** of north and the chart
  still settles the rest of the way home — which the wider default had been
  pre-empting. Let go with a flick instead and the chart keeps turning a
  little, so it can come to rest a couple of degrees off north: the spin of
  the flick outlasts the snap. Tapping the compass still returns the chart to
  exactly north from any bearing, and is the reliable way to get there (#230).

### Fixed

- Map chrome: at the narrowest phone widths (around 320 px), the route-layer
  controls card (route legend, time slider, legs) no longer overlaps the
  data-layer toggles (wind barbs, water depth) in the top-left corner of the
  map. A second, unrelated narrow-width overlap reported alongside this one
  had already been fixed earlier; short landscape viewports remain a known
  issue, tracked separately (#231) (#205).

- Course-up orientation no longer drops to manual on an ordinary pan. While
  the chart was rotated to a bearing within 7° of north — an everyday
  northerly course in the Flensburg Fjord — flicking the map to pan it was
  rewritten by the map library into a rotation back to north, which the
  compass read as a hand rotation and answered by handing the bearing back to
  you. The chart then quietly stopped following the course for the rest of the
  passage, and only two taps on the compass brought it back. A real hand
  rotation still hands the bearing over, as before (#230).

## [0.5.1] - 2026-07-27

### Added

- Publish project governance, a forward-looking roadmap, a Code of Conduct,
  and a security assurance case as new root-level documents (GOVERNANCE.md,
  ROADMAP.md, CODE_OF_CONDUCT.md, docs/security-assurance-case.md) (#217,
  #218, #219, #224).

### Changed

- Map scale bar: at short/narrow viewports where the bottom sheet and the
  top-left control stack (compass + layer toggles) leave no vertical band
  that clears both — every tab at 740×360; the Plan tab at 844×390, 932×430,
  and 667×375; and the Plan tab in portrait at 320×568 — the bar is now
  hidden rather than drawn overlapping that chrome, as it was in v0.5.0.
  Tracked for improvement in #231 (#208, #228).

### Fixed

- Seamarks: hazard-bearing marks (isolated-danger and cardinal buoys/beacons)
  now win collision placement below zoom 12 and win taps where icons overlap
  at zoom 12 and above, instead of surviving or being picked at random.
  Priority order follows IALA R1001 Ed 2.0. Measured on the Kappeln fairway:
  isolated-danger retention improved from 50% to 83% at zoom 8 and 50% to
  100% at zoom 9; safe-water retention improved from 0% to 100% at zoom 10
  (#200, #225).
- Compass: track-up no longer drops to free orientation when a foreign
  camera animation (pan inertia, keyboard rotation, a plan-change
  fit-to-bounds) interrupts a compass ease; tapping north-up now always
  reaches north instead of leaving the compass stuck showing an orientation
  the chart no longer has (#203, #227).
- Map pitch (tilt) is now locked: it can no longer be reached by a two-finger
  drag, right-click drag, or Shift+arrow gesture, so the chart can no longer
  be left tilted with no way to reset it short of a reload (#207, #228).
- Map chrome (compass, route-layer controls) is no longer hidden or
  unreachable under the bottom sheet at narrow viewports; the scale bar is
  lifted clear of the sheet where there is room, and suppressed rather than
  drawn overlapping it where there is not (see Changed, above) (#208, #228).

## [0.5.0] - 2026-07-27

### Added

- Map north arrow showing the current chart orientation; tapping it toggles
  north-up / course-up, holds the last course when the GPS fix drops out, and
  returns to manual control after a rotation gesture (#155).
- Nautical scale bar on the map, labelled in nautical miles, cables or metres
  depending on zoom (#155).

### Fixed

- Seamark/buoy and AIS other-traffic markers were too small and blurry at
  planning zooms — they now render at higher raster resolution with a matching
  pixel ratio, with AIS markers sized comparably to the seamarks beside them
  (#191, #192).

## [0.4.0] - 2026-07-24

### Added

- Extend the live AIS overlay to cover a ±5 nm corridor along the active route, so vessels crossing the track ahead show up without panning there; the status chip splits the count into total and along-route while a plan is active (#146).
- Show a 6-minute COG/SOG projection vector on the ownship (GPS) boat marker — same length convention as the AIS target vectors but in the ownship color; hidden while stationary (below 0.5 kn) or when the device reports no course (#141).
- Add a live AIS traffic overlay on the Live view: paste a personal aisstream.io API key in Options to see surrounding vessels (heading/COG, names, tap-for-details), with your own vessel filtered out by MMSI; online-only and fully inert without a key (#25).
- Add a "What's new" view to the About dialog showing this changelog — the release history is baked into the app at build time and readable offline (#131, #139).
- Add a manual "reroute from here" action in the Live view: with an active plan and a GPS fix, route from the current position to the plan's destination using the plan's stored forecast (works fully offline) and save the result as a new plan (#115, #137).
- Add a "Recalculate" action to saved-route cards to re-plan a saved route with a fresh Open-Meteo forecast and an editable departure time, saved as a new plan by default (#114, #136).
- Restore the active plan, selected tab, and rig choice automatically after a reload or PWA relaunch, using only locally stored data (no network re-fetch) (#113, #134).
- Show the departure time on saved-route cards, alongside the existing created and ETA times (#112, #130).
- Show the app's build version in the About dialog, so it's possible to tell which build an installed PWA is actually running (#125, #129).

### Fixed

- Fix cardinal-mark seamark icons rendering incorrectly: they now show the correct IALA colour bands (black/yellow) and topmark cones per direction — North two cones up, South two down, East base-to-base diamond, West point-to-point hourglass — so a West mark can no longer be mistaken for a North mark, cones are no longer clipped, and an untagged cardinal shows a neutral marker instead of masquerading as North (#165).
- Fix unreadable overlapping seamark icons at medium zoom (e.g. Flensburger Förde): dense aids to navigation now thin out by navigational priority (lights before cardinals before laterals, lit before unlit) with zoom-tapered icon sizes, and from zoom 12 on every mark is shown and tappable (#144).

## [0.3.0] - 2026-07-23

### Added

- Add a seamarks / aids-to-navigation overlay showing buoys, beacons, and lights on the chart (#7, #105).
- Add a standalone ownship (GPS boat position) marker toggle in settings, independent of Live View (#25, #104).
- Support importing a route from a GPX file (chartplotter export) to prefill origin, destination, and via points before planning (#3, #95).
- Show a UAT badge in the app header when running the unreleased preview deployment, so it's never mistaken for production (#107, #111).

### Fixed

- Fix the vector basemap failing to load (blank map) for first-time visitors and visitors without an active service worker, caused by GitHub Pages' CDN gzip-compressing ranged basemap requests (#118, #119).
- Fix a routing bug where a reachable destination could be incorrectly reported as unreachable when the isochrone frontier was large enough to trigger frontier-cap truncation (#67, #94).

### Security

- Pin the transitive fast-uri dependency to a patched version, closing a known vulnerability (GHSA-v2hh-gcrm-f6hx) (#90, #91).

## [0.2.0] - 2026-07-22

### Added

- Redesigned planner and results views: a single "Reise" card with new Card/Field/Button/Chip/Disclosure UI primitives on shared design tokens (#64).
- The harbor picker is now a searchable, accessible combobox with prefix-before-substring ranking, recently-used harbors listed first, and each harbor's depth caveat shown inline (#64).
- The results view ("Ergebnis") shows a clean stat grid (arrival, distance, duration, average speed), a faster-rig recommendation (Genoa vs. Fock), a sail/motor split bar, and the legs table tucked into a disclosure (#64).
- When a route is unreachable purely due to insufficient charted depth, the router now relaxes the safety-depth gate and returns a route with an explicit shallow-water warning banner, orange shallow-leg highlighting on the map, and emphasized bands on the depth profile, instead of failing outright (#53, #68).
- Wind-barb and water-depth map overlays are now shown by default for new users; the toggle state a user explicitly sets is remembered across reloads (#63, #76).

### Fixed

- Fixed three edge cases in the isochrone router's solver: clock-aware pruning that could previously discard a faster route, missing substep retry for blocked direct-arrival candidates near the destination, and an unvalidated final capture hop that could produce a route crossing land (#21, #66).

### Security

- Documented branch-protection and code-review policy, and pinned the mask-verification workflow's pip install by hash to harden the CI supply chain (#71, #74).

## [0.1.2] - 2026-07-17

### Added

- Route ETAs, per-leg speed labels, and heading-change markers now appear directly on the map, plus a route legend explaining the layer colors (#35, #36, #37, #46).
- A new depth-over-time route profile shows water depth under the boat across the trip, with wind barbs, heading arrows, a safety-depth overlay, and an honest "≥25 m" cap band (#45).
- Wind barbs on the map now render at an adaptive, route-aware density so wind is readable along the whole route at any zoom (#36).
- Motor-leg semantics are now explicit in the UI: help text on the motor option, rig-prefixed propulsion on each route leg, and a motor-only footnote clarifying the engine model (#46).

### Changed

- On wide screens, the Live tab's readout now renders in the side panel instead of floating over the map, while the boat marker stays on the map (#31).

### Security

- Added CodeQL code scanning (JavaScript/TypeScript and Python) on every push/PR to main and weekly, currently at zero alerts (#12).
- Enabled Dependabot with weekly grouped dependency updates and immediate, ungrouped security updates (#13).
- Enabled private vulnerability reporting and published a SECURITY.md describing scope and the reporting channel (#10).
- Hardened CI workflows with least-privilege permissions, full commit-SHA pinning for actions, and a new mask-integrity check that validates the navigation data on every relevant change (#14).

## [0.1.1] - 2026-07-16

### Added

- Wide-screen side panel: at ≥ 1024 px the planner sits as a left column beside a full-height map; phones and cockpit-portrait layouts keep the existing bottom sheet (#24, #32).
- Harbor markers on the map: the 33 curated harbors render on the map with localized labels, and clicking one fills the origin/destination with its curated snap point (#38, #43).
- Water-depths overlay: a user-toggleable bathymetry layer rendered client-side from the committed depth mask, showing absolute depth only (independent of the safety-depth setting) (#39, #43).
- DocGerdSoft corporate identity "Datum → Waterline": new app icon and mark, chart-navy/azure color palette, theme-aware banners, About dialog tagline, and a social-media preview card (#34).

### Changed

- Map attribution now starts collapsed on every viewport width instead of overlapping the route-planning sheet on phones; one tap expands it (#33, #42).
- Corrected v0.1.0 release notes: SailCommand is licensed under Apache-2.0, not "all rights reserved" (#11, #30).
- Attribution now credits OSM, Protomaps, EMODnet, and Open-Meteo with proper links, and the land/depth mask is declared an ODbL derivative database; shipped fonts and basemap sprites carry their correct OFL/MIT license notices; a generated third-party notices file ships with the site (#11, #40).

### Fixed

- First install now downloads far less data (about 33 MB instead of 44 MB): font glyphs load on demand in the background instead of blocking install, reducing the risk of the browser killing a slow-connection install (#27, #28, #41).

### Security

- A React scheduling race that could let a raw map tap override a harbor's curated snap point when picking origin/destination has been fixed (#43).
- Repository now enforces PR-only merges with required checks and no force pushes to protected branches (#15, #32).

## [0.1.0] - 2026-07-16

### Added

- Initial release of SailCommand, an offline-capable PWA that plans time-optimal sailing routes for a Salona 45 in the Flensburg Fjord / Danish South Sea area using hourly Open-Meteo wind forecasts (#1, #26).
- Isochrone router over a real land/depth mask (~46 m cells) with query-time safety depth (default 3.0 m, boat draft 2.1 m), so changing safety depth never requires regenerating data (#2, #5, #8, #22).
- Router runs twice per plan (main+genoa, main+fock polars) and recommends the faster rig, with both results shown (#5, #17).
- Motor legs are planned automatically below the sailing-speed threshold (default 2.5 kn) at motor speed (default 6.5 kn) and are always flagged as motor (#5, #17).
- Tack/gybe minimization emerges from a maneuver time penalty (default 45 s) built into the routing cost, with no post-hoc route surgery (#5, #22).
- Wind grids are stored with each saved plan (IndexedDB), so a saved route always renders against the forecast it was computed from (#17).
- Curated harbor list with pilotage notes on the map (#17, #23).
- German/English (de/en) UI localization (#23).
- Full offline operation after first load via a service worker precache, including the regional PMTiles basemap with Range/206 support (#26).

[Unreleased]: https://github.com/DocGerd/sail_command/compare/v0.20.0...HEAD
[0.20.0]: https://github.com/DocGerd/sail_command/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/DocGerd/sail_command/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/DocGerd/sail_command/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/DocGerd/sail_command/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/DocGerd/sail_command/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/DocGerd/sail_command/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/DocGerd/sail_command/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/DocGerd/sail_command/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/DocGerd/sail_command/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/DocGerd/sail_command/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/DocGerd/sail_command/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/DocGerd/sail_command/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/DocGerd/sail_command/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/DocGerd/sail_command/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/DocGerd/sail_command/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/DocGerd/sail_command/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/DocGerd/sail_command/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/DocGerd/sail_command/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/DocGerd/sail_command/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/DocGerd/sail_command/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/DocGerd/sail_command/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/DocGerd/sail_command/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/DocGerd/sail_command/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/DocGerd/sail_command/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/DocGerd/sail_command/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DocGerd/sail_command/releases/tag/v0.1.0
