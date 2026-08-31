import type { MsgKey } from './dict.de';

export const en = {
  'app.title': 'SailCommand',
  'app.tagline': 'Time-optimal passage planning — offline, on board.',
  'app.disclaimer':
    'SailCommand is a passage-planning aid, not a navigation device. Chart data is simplified; official charts and your plotter remain authoritative.',
  'panel.resizer.label': 'Resize panel',
  'plan.eta': 'Arrival {time}',
  'harborPicker.searchLabel': 'Search harbor',
  'harborPicker.searchPlaceholder': 'Search harbor…',
  'harborPicker.resultsLabel': 'Harbors',
  'harborPicker.noResults': 'No harbors match your search.',
  'options.safetyDepth.label': 'Safety depth (m)',
  // #699: the allowed range used to hang only off the field's native
  // min/max attributes, with no visible or screen-reader-accessible text —
  // an out-of-range value was silently corrected to the nearest valid one on
  // blur. {min}/{max} come from safetyDepthFieldFor(boat), so they vary per
  // boat.
  // #744: \u00A0 (non-breaking space) before the unit keeps "10.0 m" from
  // wrapping onto its own orphan line when the help paragraph wraps.
  'options.safetyDepth.help': 'Allowed range: {min}–{max}\u00A0m',
  // #731: the sibling, generic notice for the blur-clamp ITSELF (not the
  // disclosure at options.safetyDepth.help above) — shared by all eight
  // NumberInput sites (safety depth here + SettingsPanel's seven
  // NumericField instances), so it deliberately carries NO unit: each
  // field's own label already has one in parentheses ("Safety depth (m)",
  // "Motoring speed (kn)", …).
  'numberInput.corrected': 'Corrected to {value} (allowed range {min}–{max})',
  // #299: safety depth now appears in TWO places — here for quick access
  // and on the Boat tab (SettingsPanel) as its canonical home, one shared
  // source (PR #486 review). The depth comfort margin and the rest of the
  // boat settings still live EXCLUSIVELY there — this link stops anyone
  // concluding the margin was deleted just because it's no longer right
  // beside safety depth. No longer "&": safety depth (visible right next to
  // this link) is no longer exclusive to that tab, so "more" reads better
  // than a list, with the comfort margin kept as the concrete anchor.
  'planner.safetyDepth.boatLink': 'More boat settings (incl. depth comfort margin)',
  'options.depthComfortMargin.label': 'Depth comfort margin (m)',
  'options.depthComfortMargin.help':
    'Beyond the safety depth, the planner also prefers water at least this much deeper when it costs little extra time — 0 disables the preference. It never allows shallower water than the safety depth allows, and the recommended rig can change as a result.',
  'options.motorSpeed.label': 'Motoring speed (kn)',
  'options.motorThreshold.label': 'Motor threshold (kn)',
  'options.sailPreference.label': 'Sail preference (kn)',
  'options.sailPreference.help':
    'How much boat speed the planner will give up to keep sailing. It keeps sailing while sailing speed is within this many knots of motoring speed, and motors otherwise — so a higher value means more sailing and later arrivals. Raise it to motoring speed minus the motor threshold to motor only as a fallback.',
  'options.maneuverPenalty.label': 'Maneuver penalty (s)',
  'options.performanceFactor.label': 'Performance factor (×)',
  'options.motorEnabled.label': 'Motor enabled',
  'options.motorEnabled.help':
    'Allow engine legs: the planner motors where sailing would be slower than motoring by more than the sail preference, and always below the motor threshold. Motor legs run at motoring speed and are marked as motor.',
  'options.showOwnship.label': 'Show my position',
  'options.showOwnship.help':
    'Shows your GPS position and accuracy circle on the map wherever it is open — planning, no plan, or Live view — not just during Live guidance. Consumer-GPS accuracy, not chart-grade positioning; this is a passage-planning aid, not a navigation device. Turning this on will ask for location permission.',
  // #54: boat selection (BoatPicker on the Boat tab).
  'boat.section.title': 'Boat selection',
  'boat.picker.label': 'Select boat',
  'boat.draft': 'Draft {depth} m',
  // Spec G.3 provenance tiers. Deliberately no A/B/C letters in the copy —
  // the letters are spec-internal identifiers and mean nothing to a skipper;
  // the word does.
  'boat.polarTier.certificate': 'Certificate',
  'boat.polarTier.modelled': 'Modelled',
  'boat.polarTier.estimated': 'Estimated',
  'boat.polarTier.aria': 'Polar data: {tier}',
  'boat.polarDetail.summary': 'Polar data & provenance',
  // Spec N.2. "Checked", not "verified": spec N.5 rules the register words
  // accurate/verified/reliable/safe out of any new copy.
  'boat.keel.assumed': "Assumed keel: {keel}. Not checked against this vessel's papers.",
  // Spec C.7: clamped up, persisted — and announced. Up only.
  'boat.clamp.notice': 'Safety depth raised to {depth} m — the minimum for {boat}.',
  // #299: section headings on the Boat tab (SettingsPanel).
  'settings.section.boatSafety': 'Boat & safety',
  'settings.section.propulsion': 'Propulsion',
  'settings.section.liveAis': 'Live & AIS',
  // #353 PR2: map-display controls for seamarks (symbol size + display category).
  'settings.section.mapDisplay': 'Map display',
  'settings.seamarkSize.label': 'Symbol size (seamarks)',
  'settings.seamarkSize.value': '{percent}%',
  'settings.seamarkSize.help':
    'Changes the on-screen size of seamark symbols on the map. Below zoom 12 the collision spacing scales with the symbols; at higher zoom levels larger symbols overlap each other more.',
  'settings.seamarkCategory.label': 'Displayed seamarks',
  'settings.seamarkCategory.base': 'Base',
  'settings.seamarkCategory.standard': 'Standard',
  'settings.seamarkCategory.all': 'All',
  'settings.seamarkCategory.help':
    'Cardinal, lateral, safe-water and isolated-danger marks, and major lights, are always shown, even at "Base". "Standard" (the default) shows everything, including submarine cable and pipeline markers. "All" currently shows the same as "Standard".',
  'planner.card.trip': 'Trip',
  'planner.card.result': 'Result',
  'planner.origin.label': 'Origin',
  'planner.destination.label': 'Destination',
  'planner.pickOnMap': 'Pick on map',
  'planner.change': 'Change',
  'planner.via.label': 'Waypoints',
  'planner.via.add': 'Add waypoint',
  'planner.via.remove': 'Remove waypoint {index}',
  'planner.via.moveUp': 'Move waypoint {index} up',
  'planner.via.moveDown': 'Move waypoint {index} down',
  'planner.via.marker': 'Waypoint {index}',
  'planner.departure.label': 'Departure',
  'planner.plan': 'Plan route',
  // §3.5 empty/first-run: friendly guidance near the primary action while no
  // plan exists yet and an endpoint is still unpicked.
  'planner.onboarding': 'Pick a start and destination to plan a route.',
  // §3.5: terse disabled-button reason when both endpoints aren't set (the
  // gap-fill for the previously reasonless online-but-incomplete state).
  'planner.disabled.pickEndpoints': 'Select a start and destination.',
  'planner.result.details': 'View details',
  // Swapped into the planner's live status region on plan completion — a
  // stable, atomic summary announced once per new plan (never on slider/
  // via-edit re-renders).
  'planner.result.announce':
    'Route calculated — arrival {arrival}, duration {duration}, {distance}.',
  // #301: the form (origin/destination/departure/settings) has drifted from
  // the plan actually displayed above — a re-run right now would produce a
  // different route. Shown as a second Chip in the Ergebnis card AND folded
  // into this panel's one live region (never a second one).
  'planner.result.stale':
    'Showing the previously calculated route — the inputs have changed since.',
  // GPX import (#3): the control, the success confirmation, one message per
  // rejection reason, and the non-blocking notices. "Import/planning" language,
  // never "navigation" — imported geometry is a planning input, not a route.
  'planner.import.button': 'Import GPX',
  'planner.import.success':
    'Route imported — origin, destination and waypoints filled in. Set departure and options, then plan.',
  'planner.import.error.notGpx': 'Not a valid GPX file.',
  'planner.import.error.tooFewPoints':
    'The GPX file has fewer than two usable points (origin and destination).',
  'planner.import.error.badCoord': 'The GPX file contains invalid coordinates.',
  'planner.import.error.outOfBounds':
    'A point lies outside the covered area (Flensburg Fjord / Danish South Sea).',
  'planner.import.error.tooLarge': 'The GPX file is too large to import.',
  'planner.import.error.failed': 'The GPX file could not be read.',
  'planner.import.notice.trackReduced':
    "Track reduced to its start and end point — the track's shape is ignored for planning.",
  'planner.import.notice.viaCapped': '{dropped} extra waypoints dropped (waypoint limit exceeded).',
  'planner.import.notice.multipleRoutes':
    'Multiple routes in the file — only the first was imported.',
  'planner.import.notice.multipleTracks':
    'Multiple tracks in the file — only the first was imported.',
  'planner.status.fetching': 'Fetching wind forecast…',
  // #340/#54: phase readout, not a percentage — the router solves
  // request.sailIds SEQUENTIALLY, so "sail {index} of {total}" is honest and
  // bounded, unlike the removed percentage (capped ~5%, reset to 0 at every
  // sail switch).
  'planner.status.routingSail': 'Calculating route… sail {index} of {total} ({sail})',
  // #53: relaxed-depth probe phase after an unreachable requested-depth solve
  'planner.status.probing': 'No route at the set safety depth — probing reduced depth gates…',
  'error.offline': 'Wind forecast service is unreachable. Check your connection and try again.',
  'error.rateLimited': 'Wind forecast service rate limit reached. Wait a moment and try again.',
  'error.windService': 'Wind forecast could not be loaded. Try again in a moment.',
  'error.internal': 'Route planning failed unexpectedly. If it keeps happening, reload the app.',
  // #662: RouteSummary.tsx's fallback for a SAVED plan whose stored no-route
  // reason cannot be trusted (PR #656 / #614 made `reason` fall back to
  // `null` for a value outside the NoRouteReason union). This render site is
  // reached only when viewing an already-saved plan, never while live-
  // planning — "Try again"/"reload the app" would both be futile here (a
  // retry re-runs planning, which this screen isn't doing; a reload changes
  // nothing about what a stored record contains), so unlike error.internal
  // above this key names the one thing that DOES help: planning the route
  // again. App.tsx's RETRY_MAY_HELP_KEYS mechanism is not involved — this
  // key never reaches the live-planning Retry button.
  'error.savedPlanUnreadable':
    "This saved plan's outcome could not be read. Plan the route again for a current result.",
  // #433: causes that used to collapse onto error.internal above, now
  // distinguishable — each with remedy copy honest about whether "Try
  // again" can actually help (see App.tsx's RETRY_MAY_HELP_KEYS).
  'error.workerInit':
    'The route planner could not be started — required data failed to load. Reload the app and try again.',
  'error.routingTimeout':
    'Routing did not finish within the time limit. Trying again will likely time out the same way — a simpler route or a faster device may help.',
  // #433 review Minor 1: does NOT claim retry is futile — this cause also
  // covers a resource-exhaustion throw, where a retry's fresh worker CAN
  // help (see usePlanFlow.ts's ROUTING_FAILURE_MESSAGE_KEY comment).
  'error.routingFailed':
    'Route planning failed with an internal routing error. A different route or settings are more likely to help than trying again with the same request.',
  'error.routingCrashed': 'The routing engine crashed unexpectedly. Try again — it restarts fresh.',
  'error.routingMessageError':
    'The routing engine sent back a reply that could not be read. Try again — it restarts fresh.',
  'error.routingInterrupted': 'Route planning was interrupted. Try again.',
  // #553 / spec §I.3. Remedy copy true of THIS path specifically: neither a
  // retry (a fresh worker changes nothing — the catalogue is the same) nor a
  // reload (likewise) can help, so neither is offered. What the sentence
  // conveys instead is the narrowness of the loss — §I.3 guarantees the saved
  // plan "still opens, still renders, still exports GPX", and only re-planning
  // is gone — because a bare failure message would read as "this route is
  // broken" and invite the user to delete a record that is entirely intact.
  'error.boatNotInCatalogue':
    'This route was planned for a boat that is no longer available, so it cannot be planned again. The saved route still opens, and you can still view and export it.',
  'error.planSaveFailed':
    'The route was calculated but could not be saved. Try again, or check available storage on this device.',
  'error.windUnknown':
    'Wind forecast could not be loaded due to an unexpected error. Try again in a moment.',
  'error.noRoute.unreachable':
    'No route found — the destination cannot be reached without crossing land or too-shallow water.',
  'error.noRoute.beyondHorizon':
    'No route found within the 6-day forecast horizon. Try a later departure or a closer destination.',
  'error.noRoute.calmMotorOff':
    'Too little wind to sail and the motor is disabled — enable the motor in options or delay departure.',
  'error.noRoute.snapOrigin':
    'The origin is not navigable — pick a point at least 300 m from land or shallow water.',
  'error.noRoute.snapDestination':
    'The destination is not navigable — pick a point at least 300 m from land or shallow water.',
  'error.noRoute.snapVia':
    'A waypoint is not navigable — pick a point at least 300 m from land or shallow water.',
  // #432: the search was cut short BEFORE it finished — unlike every other
  // error.noRoute.* string, this deliberately makes no claim about whether a
  // route exists.
  'error.noRoute.searchBudget':
    'Route planning hit its time limit before finishing — this does not mean no route exists. A nearer destination, fewer waypoints, or a smaller depth-comfort span will help; so will a faster device.',
  'error.replanStaleWind':
    "This plan's stored wind forecast no longer covers its departure time. Plan the route again to load a current forecast.",
  'error.replanInit':
    'The route planner could not be started. Try again; if it keeps happening, reload the app.',
  // #115: manual "reroute from here" (Live view) — honest failures, never a
  // silently truncated or extrapolated route.
  'error.rerouteStaleWind':
    "This plan's stored wind forecast no longer covers the current time — a new route from now cannot be computed from it. Plan the route again to load a current forecast.",
  'error.rerouteFixOutside':
    'The current GPS position is outside the covered sea area or not navigable — no route can be computed from here.',
  'route.rig.genoa': 'Genoa',
  'route.rig.fock': 'Fock',
  // Fallback label for a stored sail id the current catalogue no longer
  // knows (lib/resultSummary.ts's sailLabelKey). Names the sail as unknown
  // rather than rendering an empty string or the literal 'undefined'.
  'route.rig.unknown': 'Unknown sail',
  'route.rigTabs': 'Rig comparison',
  'route.recommended': 'Recommended',
  'route.fasterRig': 'Faster: {rig}',
  // #259: honest copy for the two cases where badging one rig as
  // "recommended" would be misleading — an ETA tie (too close to call) and
  // an all-motor route (the polar never drove a leg, so rig choice is moot).
  // #578: parameterised — the two names used to be hardcoded "Genoa and
  // Fock", correct only because every catalogue boat's foresail happens to
  // use those two ids. lib/resultSummary.ts's renderRigVerdict resolves
  // both slots from the PLAN's own compared sails (solve order), through
  // the same sailLabelKey every other rig-facing string uses.
  'route.rigTie': '{sailA} and {sailB} are effectively tied for this passage',
  'route.rigMoot': 'Rig does not matter here — this passage runs entirely under engine',
  // #553 / spec §N.4: strictly WEAKER than rigTie above, and the distinction
  // is the whole point — 'tie' reports the outcome of a comparison that ran,
  // this reports that no comparison ran at all. Reached when only one sail
  // found a route, when the plan requested a number of sails the capped-at-2
  // comparison has no verdict for, or when the boat's polars are estimated
  // (tier C), where the two tables differ by a documented overlay ramp rather
  // than by anything about the hull. Says no faster rig is CLAIMED rather
  // than that the sails are equal, because that is the honest difference.
  'route.rigNotCompared':
    'The sails were not compared for this passage, so no faster rig is claimed',
  // #540 spec §E.3: a budget-exhausted sail is ALSO a 'not-compared' verdict
  // (rigVerdictKey collapses it onto rigNotCompared above), but a stalled
  // search reads very differently from "nothing to compare" — the
  // ★-suppressed recommendation is still computed over one completed sail
  // only, and without this sentence that reads as a finished two-sail
  // comparison rather than a truncated one. Rendered instead of
  // rigNotCompared exactly when PlanResultOk.comparisonComplete is false
  // (resultVerdictKey in lib/resultSummary.ts derives which key to use).
  // Per the DocGerd comment on #540: comparisonComplete is computed PER
  // TIER, not per plan — a plan that fell back to an earlier tier after a
  // budget-truncated attempt can still report comparisonComplete: true for
  // the tier that actually produced the result. This sentence claims only
  // "the reported comparison did not finish", not "nothing anywhere in this
  // plan's search was cut short".
  'route.comparisonIncomplete':
    'The search ran out of time before comparing both sails, so no faster rig is claimed',
  // #748: label-style age form. This is Option 3 (age-only, no absolute
  // timestamp) — #748's own research established this app has NO model
  // reference/initialisation time to print (Open-Meteo's standard forecast
  // endpoint exposes only `generationtime_ms`, API processing time, not a
  // run time), only `windGrid.fetchedAtMs`, a CLIENT fetch time. A richer
  // Option 1/2 treatment (an honest "fetched HH:MMZ" or a real model run
  // time) is a follow-up, not this fix. {hours} is the real fetch->departure
  // gap, rounded to whole hours (lib/plan.ts's staleForecastGapHours — see
  // its own comment for why round, not floor or ceil) — it replaces the
  // static "> 12 h" threshold label PR #763 shipped, threaded through as a
  // t() variable at both App.tsx's Banner and this key's RouteSummary.tsx
  // use. `isStaleForecast` (lib/plan.ts) still gates display at
  // STALE_THRESHOLD_MS = 12h; only the copy is dynamic now.
  //
  // PR #763 review Major 3: the FIRST cut of this copy ("Forecast > 12 h
  // old") was factually wrong at read time — `isStaleForecast` tests
  // `departureMs - fetchedAtMs > 12h`, a fetch-to-DEPARTURE gap, not the
  // forecast's age (fetch 10:00 today, departure 06:00 tomorrow flags stale
  // while the forecast is 0 h old), and it dropped the "relative to
  // departure" frame #748's own Constraints section requires. "at
  // departure" names the endpoint {hours} is measured to.
  'route.staleForecast': 'Forecast {hours} h old at departure',
  // #504 fix wave 4: restructured from ONE dense paragraph into three parts
  // inside ONE role="alert" region (ShallowWarning, RouteSummary.tsx: a
  // <div> with .lead/.detail/.caveat children) — leads with the most
  // severe, actionable fact (the cautious floor) instead of emphasising
  // everything equally. Re-sequencing a sentence is NOT automatically safe:
  // wave 6 found the lead's original "that same depth data" was an
  // ANAPHORA pointing back at {minGate}, which now lives in .detail BELOW
  // the lead — the headline of a safety warning referred to something the
  // reader had not yet seen. Fixed by naming "the charted depth data"
  // directly instead of pointing at it. Checking every cross-sentence
  // reference is a REQUIRED step of any future re-sequencing here, not an
  // assumption — .detail and .caveat were both checked too (wave 6) and
  // carry no reference into another PART: "this route"/"this warning" are
  // deictic to the whole alert, not position-dependent.
  // lead/leadSevere ALWAYS carry the #493 cautious-floor clause; leadSevere
  // additionally states the boat's-draft clause. "Caution:" moved here from
  // detail, since lead is now the most prominent part.
  'route.shallow.lead':
    'Caution: a more cautious reading of the charted depth data could run as low as {cautious} m.',
  'route.shallow.leadSevere':
    "Caution: a more cautious reading of the charted depth data could run as low as {cautious} m, below this boat's {draft} m draft.",
  // #516 increment 1: presentation-only shallow-EXPOSURE figure (a distance,
  // not a per-leg minimum) — computed at render time in
  // lib/shallowExposure.ts against the CURRENTLY LOADED mask, never stored
  // in PlanResult (see #516's design doc, "Option (a), presentation-only":
  // app/sweep/'s byte-diff acceptance harness stays valid only because
  // PlanResult never grows a field for this). Rendered FIRST in .detail,
  // ahead of the existing "what happened" mechanism sentence below —
  // self-contained (refers to nothing rendered elsewhere), per the #493/
  // #504 anaphora lesson recorded in this file's own comment above.
  // NO "Up to" (PR #523 review, Minor 5): that phrasing asserts a ceiling,
  // and the figure only bounds the CHART — the mask overstates depth on a
  // large fraction of water cells (#455), which is what .lead's cautious
  // floor and .caveat exist to say. The scoping word that must stay is
  // `charted`; the ceil rounding is display precision, not a bound claim.
  'route.shallow.exposure':
    '{dist} of this route crosses water charted shallower than your safety depth of {requested} m.',
  // PR #763 review Blocker 2: the plan's ACTUAL used gate, stated on its own
  // (never bundled with requested/minGate as route.shallow.detail already
  // does) so it can render in the Disclosure's always-visible SUMMARY — the
  // most consequential number in this warning must be visible without
  // opening anything.
  'route.shallow.usedDepth': 'Planned at a safety depth of {used} m.',
  // #516 increment 2 (requires #518): whether the exposure above is entirely
  // inside #452's relaxation discs — MEASURED at render time
  // (lib/shallowExposure.ts's shallowConfinedWithinM), never assumed from the
  // router, since a plan saved before #518 shipped is byte-indistinguishable
  // from one computed after. Rendered right after .exposure (RouteSummary.tsx's
  // `showConfined`), never re-sequenced relative to it, and deliberately
  // SELF-CONTAINED — not "All of it lies within…", which would bind to
  // .exposure's position (the #493/#504 anaphora lesson). false/null both
  // suppress this sentence silently; it is never rendered as a negation.
  'route.shallow.confined':
    'Every stretch below your safety depth lies within {radius} of your origin, destination or waypoints.',
  // #516: the maintainer's own explicit product decision (the #516 design
  // doc had deliberately left this UNRECOMMENDED, "a maintainer product
  // call, flagged rather than designed" — since ruled on). Rendered LAST in
  // .detail, after the mechanism sentence it responds to (PR #523 review,
  // Minor 3 — advice must not precede the fact that the router has already
  // reduced the gate). RouteSummary.tsx's `showRemedy` gates it on three
  // conditions — a positive exposure figure, the wide layout, and usedDepthM
  // exceeding SAFETY_DEPTH_FIELD.min — and that declaration carries the
  // reason for each; it is the single place to read or change them.
  'route.shallow.remedy':
    'A lower safety depth setting might let the planner find a more direct route.',
  // What happened: the requested safety depth was not passable, the depth
  // actually used, the shallowest charted depth crossed. Normal weight (no
  // longer emphasised) — review (PR #461 Minor 5): "shallowest charted
  // depth actually crossed" overclaimed — `flagShallowLegs` (planRoute.ts)
  // folds `minGateDepthM` over BOTH rigs' legs, so on a given rig's tab the
  // number may describe the OTHER rig's leg, not one this route actually
  // sails. "crossed by this plan" is the honest, plan-level framing. `used`
  // < `requested` always holds here (#53's relaxation only runs after the
  // requested gate failed to connect).
  'route.shallow.detail':
    'Your requested safety depth of {requested} m was not passable, so this route was planned at a reduced {used} m instead — shallowest charted depth crossed by this plan: {minGate} m.',
  // #452 gap 3: one-sentence locator appended to .detail above (the "what
  // happened" statement this locates a row against) — names how many legs
  // are individually flagged shallow and when the first one starts.
  // Singular/`.plural` follows the same convention as banner.viaTooClose
  // (.plural): the singular form omits the count entirely ("leg" alone
  // already says "one").
  'route.shallow.locator': 'The affected leg starts at {time}.',
  'route.shallow.locator.plural': '{count} legs are affected — the first starts at {time}.',
  // The chart-accuracy caveat — visually secondary (smaller text) but NEVER
  // hidden behind a click: a safety statement about the limits of the
  // warning above it, in an app with no chart authority of its own. Honest
  // passage-planning-aid copy (#455): never claims an unflagged section IS
  // safe — the mask itself is known to OVERSTATE depth on ~45% of WATER
  // cells, encoded basis (#455), so an unflagged section is merely
  // unflagged, not verified.
  // review (PR #461 Minor 6): the pre-#452 string named the OPTIMISTIC case
  // explicitly ("dredged channels ... often deeper than charted"); this
  // copy deliberately DROPS that reassurance rather than assert something
  // with no supporting measurement — under #455 the direction that matters
  // here is the dangerous one, not the reassuring one, which is why "can
  // both understate and overstate" below states both but reassures on
  // neither. review (PR #461 Major 3): widened from `/\bis
  // (verified|guaranteed)\b/i`, which let "...is safe." through 91/91
  // GREEN, to also catch "is/are safe" and "is/are clear". NARROWED, NOT
  // CLOSED — "poses no risk" still evades it.
  'route.shallow.caveat':
    'Chart data can both understate and overstate real depths, so this warning is not exhaustive: a section without it is not guaranteed to be clear. Verify the highlighted sections against official charts and your depth sounder.',
  // #612 (the implementation half of #455): the ROUTE-SCOPED marginal-depth
  // notice, for a route that did NOT relax. Everything above in this
  // `route.shallow.*` family renders only when #53's relaxation tier fired
  // (planRoute.ts's three flagShallowLegs call sites all sit inside
  // `if (relaxed !== null)`), so before this key an ordinary route disclosed
  // nothing at all about the ~10,746 gate-crossing cells #455 measured.
  //
  // TRIGGER: lib/shallowExposure.ts's marginalExposureNm — cells the shipped
  // mask charts at or above the gate but whose more cautious reading of the
  // same EMODnet product falls below it. NOT the shipped
  // `route.shallow.exposure` threshold, which measures charted-below-gate
  // distance and MEASURES 0.0 nm on 67/67 non-relaxed plans (#455 spike §9).
  // ESCALATION to `.noticeSevere`: `safetyDepthM - MASK_TOLERANCE_M <
  // boat.draftM`, the same pairing ShallowWarning already uses. False at
  // every catalogue boat's own default gate by construction, so it fires only
  // once a user has lowered their safety depth — which is exactly what the
  // severe clause names ("at this setting"), never a general claim.
  //
  // TWO CLAUSES DELIBERATELY ABSENT, each because it would be FALSE or
  // misleading:
  // 1. No claim that the CHARTED reading stays at or above the gate. True of
  //    the mask the plan was routed against, but this walk runs against the
  //    CURRENTLY LOADED mask (lib/shallowExposure.ts's own residual, shared
  //    with #505's exhaustiveMinDepth), so a mask rebuild could falsify it.
  //    The sentence states only what was actually measured.
  // 2. No reassurance in the non-severe branch that the cautious reading
  //    stays above the draft. It is true for a non-relaxed route at a default
  //    gate, but reads as the general claim "below-draft needs a
  //    user-lowered gate" — which the app's own `about.caveats.depthMask`
  //    contradicts: a RELAXED route reaches below the draft at DEFAULT
  //    settings, disclosed by the banner above rather than by this line.
  //
  // Never asserts chart truth: "a more cautious reading of the charted depth
  // data" names WHICH of the two readings of one product the figure bounds,
  // and that wording is lifted verbatim from `route.shallow.lead` above so
  // the same hazard reads the same way wherever it appears.
  'route.marginal.notice':
    '{dist} of this route crosses water that a more cautious reading of the charted depth data puts below your safety depth of {requested} m.',
  'route.marginal.noticeSevere':
    "Caution: {dist} of this route crosses water that a more cautious reading of the charted depth data puts below your safety depth of {requested} m — at this setting that reading can fall below this boat's {draft} m draft.",
  'route.totals.distance': 'Distance',
  'route.totals.duration': 'Duration',
  'route.totals.eta': 'ETA',
  'route.totals.maneuvers': 'Maneuvers',
  'route.totals.motorDistance': 'Motor distance',
  'route.totals.avgSpeed': 'Avg speed',
  // Sail/motor split bar (Ergebnis card).
  'route.split.sail': 'Sailing',
  'route.split.motor': 'Motor',
  'route.split.aria': 'Sail {sailPct}%, motor {motorPct}%',
  'route.legs.time': 'Time',
  'route.legs.duration': 'Duration',
  'route.legs.kind': 'Type',
  'route.legs.cog': 'COG',
  'route.legs.twa': 'TWA',
  'route.legs.tws': 'TWS',
  'route.legs.speed': 'Speed',
  'route.legs.distance': 'Distance',
  'route.legs.maneuver': 'Maneuver',
  // #452 gap 3: per-leg shallow marker column — text, not colour-only (see
  // ShallowLegMarker's own comment in RouteSummary.tsx). The marker's own
  // label repeats "Shallow" so it stays self-explanatory even read out of
  // table context (e.g. by a screen reader in linear mode).
  'route.legs.shallow': 'Shallow',
  'route.legs.shallowMarker': 'Shallow {depth} m',
  // #651: the render-time complement to shallowMarker above, for a leg the
  // router did NOT relax (leg.shallow undefined — every leg on most routes,
  // per CLAUDE.md's "disclosure stack" domain rule). {depth} here is the
  // mask's own charted reading, at or above the plan's requested gate —
  // "Shallow" would be false, since the charted data does not put this cell
  // below the gate at all; only the #493 more-cautious reading of the SAME
  // cell might (isMarginalDepthM, lib/shallowExposure.ts's own #612
  // criterion, applied per leg). "Marginal" names that distinction; the
  // sibling shallowCautious chip below states the actual cautious figure
  // unconditionally, so this label never has to.
  'route.legs.marginalMarker': 'Marginal {depth} m',
  // #493/#504: cautious lower bound for the SAME cell, rendered ALONGSIDE
  // the marker above (never replacing it) — see cautiousDepthLowerBoundM in
  // app/src/lib/mask.ts for the derivation. Worded as a HAZARD, not a
  // comfort floor — "≥ {depth} m cautious" (the original wording) read as
  // reassurance sitting next to the banner's "could run as low as {depth} m"
  // for the same fact; "as low as" names the same hazard consistently.
  'route.legs.shallowCautious': 'cautious: as low as {depth} m',
  'route.legs.motorNote': 'Motor = engine only; no sail contribution modelled.',
  'route.legs.disclosure': 'Legs ({count})',
  'route.kind.motor': 'Motor',
  'route.board.port': 'Port',
  'route.board.starboard': 'Stbd',
  'route.pointOfSail.beat': 'Beat',
  'route.pointOfSail.reach': 'Reach',
  'route.pointOfSail.broadReach': 'Broad reach',
  'route.pointOfSail.run': 'Run',
  'route.maneuver.tack': 'Tack',
  'route.maneuver.gybe': 'Gybe',
  'route.maneuverLetter.tack': 'T',
  'route.maneuverLetter.gybe': 'G',
  'route.legend.title': 'Legend',
  'route.legend.sailStarboard': 'Sail, starboard tack',
  'route.legend.sailPort': 'Sail, port tack',
  'route.legend.motor': 'Motor (engine only)',
  'route.legend.maneuver': 'Tack/gybe',
  'route.legend.headingChange': 'Heading change',
  'route.legend.via': 'Waypoint',
  // #651 fix-wave, MAJOR 1: was 'Charted shallower than safety depth' — that
  // labels the sc-route-shallow swatch, which #651 now ALSO paints for
  // MARGINAL legs (RouteLayer.tsx's ROUTE_STACK_BOTTOM_LAYER), and a
  // marginal leg is BY DEFINITION charted AT OR ABOVE the gate (see
  // route.legs.marginalMarker's own comment below) — so the old string
  // asserted the opposite of what the layer actually paints for that
  // population. The union of both populations (relaxed-shallow: charted min
  // < gate, so cautious = charted - T < gate; marginal: charted min < gate +
  // T, so cautious < gate) is exactly "the cautious reading falls below the
  // gate" — one line covers both, tightly, with no "charted" claim to be
  // wrong about.
  'route.legend.shallow': 'Cautious depth reading below safety depth',
  // #324: map-only overlay of the rig NOT currently shown as the primary
  // route (dashed, reduced opacity — see RouteLayer.tsx's setupLayers).
  'route.legend.altRig': 'Other rig (dashed)',
  'route.exportGpx': 'Export GPX',
  'route.windBarbs.toggle': 'Show wind barbs',
  'route.windBarbs.timeSlider': 'Forecast time',
  'route.annotations.toggle': 'Times & speeds',
  'route.altRig.toggle': 'Show other rig',
  'route.altRig.unavailable': 'Only one rig found a route',
  // #628: summary label for the Disclosure wrapping the whole map-overlay
  // controls cluster (annotation/barb/alt-rig toggles, forecast slider,
  // legend) — collapsible so it stops obstructing the chart on mobile.
  'route.controls.summary': 'Display options',
  'route.motorLetter': 'M',
  // Depth profile (#45)
  'profile.title': 'Depth profile',
  'profile.depthAxis': 'Depth (m)',
  'profile.deepCap': '≥ 25 m',
  'profile.safetyDepth': 'Safety depth',
  'profile.heading': 'Heading',
  'profile.wind': 'Wind',
  // 'min.' with the period: disambiguates from the panel's minutes ('x h yy
  // min', '+12 min') on this time-axis chart.
  'profile.minDepth': 'min.',
  // #512 review F8: the exhaustive minimum is unavailable (defensively, when
  // a leg endpoint falls outside mask coverage) — an em dash plus a word so
  // it can never be mistaken for a measurement or for "0". Rendered INSTEAD
  // OF the number, never alongside it.
  'profile.minDepthUnknown': 'min. — unknown',
  'map.depth.toggle': 'Water depths',
  // #598: collapsible legend for the #492 navigability hatch, default
  // collapsed, rendered inside .data-layer-controls so it's reachable
  // without a plan (the hatch itself has no other toggle/opt-in — it rides
  // depthVisible). Covers the HATCH SYMBOL only, never the absolute
  // depth-ramp colours (out of scope per the maintainer ruling on #598).
  // Deliberately says "cautious reading", never "shallow water" — the hatch
  // is a cautious-reading indicator, not a shallow-water one, and can flag
  // water that is in fact deep enough (depthColor.ts's own doc comment on
  // buildNavigabilityHatchImageData has the full derivation). The basis
  // clause states the CONSERVATIVE mechanism without hardcoding
  // MASK_TOLERANCE_M's 0.9 m literal in prose — see mask.ts for that
  // constant if a numeric citation is ever needed here.
  'map.depth.legend.title': 'Legend',
  'map.depth.legend.hatchLabel': 'Cautious-reading hatch',
  'map.depth.legend.basis':
    'Diagonal hatching flags water where the more cautious of the two depth readings behind the colour overlay could fall below your safety depth — even where the shown colour still looks clear. It can flag water that turns out to be deep enough; that trade-off is deliberate, so the hatching favours over-warning rather than looking clear when it might not be.',
  // #597: the caveat this legend was created to carry — unsurveyed/drying
  // water (mask byte 0) is indistinguishable from land and gets no cue at
  // all, so its ABSENCE must never read as "clear". Kept as its own
  // sentence/key rather than folded into the basis paragraph above so a
  // future edit to one cannot silently drop the other.
  //
  // PR #625 self-review Major 1: the first version of sentence 1 said this
  // water "looks the same as dry land" — false, and false in the DANGEROUS
  // direction. depthColor.ts:82 returns fully transparent for byte 0 and the
  // hatch LUT loop (depthColor.ts:243) starts at b=1, so the app paints
  // NOTHING over byte 0 either way — what a user actually sees there is the
  // basemap alone, i.e. ORDINARY BLUE WATER (OSM land polygons don't cover
  // unsurveyed water or drying flats), not anything land-coloured. The old
  // wording handed the user an inverted detection heuristic ("scan for
  // land-like patches"); #597's own issue text states the correct direction.
  'map.depth.legend.caveat':
    'Unsurveyed and drying water carries no hatching either, and nothing else marks it, so it looks like ordinary water. Absence of hatching is not a guarantee the water is clear — it may simply be a place with no data.',
  // Seamarks / aids-to-navigation overlay (#7) — default OFF, opt-in.
  'map.seamarks.toggle': 'Seamarks',
  'seamark.popover.type': 'Type',
  'seamark.popover.category': 'Category',
  'seamark.popover.colour': 'Colour',
  'seamark.popover.lightCharacter': 'Light character',
  'seamark.popover.lightColour': 'Light colour',
  'seamark.popover.lightPeriod': 'Light period',
  // {value} s — same text in both languages, but still routed through the
  // dict (#300) rather than hardcoded, per repo convention.
  'seamark.popover.lightPeriodUnit': '{value} s',
  // Seamark popover VALUES (#300): translated from the OSM tag values
  // actually present in app/public/data/seamarks.json (not the full IALA
  // tagging scheme) — seamarkPopover.coverage.test.ts pins the coverage.
  // `seamark.popover.lightCharacter` values (Fl, Oc, …) stay deliberately
  // untranslated, see seamarkPopover.ts.
  'seamark.value.type.beacon_cardinal': 'Cardinal beacon',
  'seamark.value.type.beacon_isolated_danger': 'Isolated danger beacon',
  'seamark.value.type.beacon_lateral': 'Lateral beacon',
  'seamark.value.type.beacon_special_purpose': 'Special purpose beacon',
  'seamark.value.type.buoy_cardinal': 'Cardinal buoy',
  'seamark.value.type.buoy_isolated_danger': 'Isolated danger buoy',
  'seamark.value.type.buoy_lateral': 'Lateral buoy',
  'seamark.value.type.buoy_safe_water': 'Safe water buoy',
  'seamark.value.type.buoy_special_purpose': 'Special purpose buoy',
  'seamark.value.type.light_major': 'Major light',
  'seamark.value.type.light_minor': 'Minor light',
  'seamark.value.category.anchorage': 'Anchorage',
  'seamark.value.category.cable': 'Cable',
  'seamark.value.category.clearing': 'Clearing mark',
  'seamark.value.category.degaussing_range': 'Degaussing range',
  'seamark.value.category.east': 'East',
  'seamark.value.category.firing_danger_area': 'Firing danger area',
  'seamark.value.category.foul_ground': 'Foul ground',
  'seamark.value.category.lanby': 'LANBY (large buoy)',
  // #300 F6: "Leading mark" not "Leading line" — this tags the mark/beacon
  // itself (renders under the "Category" label on beacons/buoys), and IALA/
  // S-57 (CATSPM) distinguish the leading MARK (the structure, lit or
  // unlit) from the leading LINE it forms; "Category: Leading line" on a
  // beacon read as a category error.
  'seamark.value.category.leading': 'Leading mark',
  'seamark.value.category.marine_farm': 'Marine farm',
  'seamark.value.category.mooring': 'Mooring',
  'seamark.value.category.no_entry': 'No entry',
  'seamark.value.category.north': 'North',
  'seamark.value.category.notice': 'Notice',
  'seamark.value.category.odas': 'Ocean data buoy (ODAS)',
  'seamark.value.category.pipeline': 'Pipeline',
  'seamark.value.category.port': 'Port',
  'seamark.value.category.preferred_channel_port': 'Preferred channel to port',
  'seamark.value.category.preferred_channel_starboard': 'Preferred channel to starboard',
  'seamark.value.category.recording': 'Recording',
  'seamark.value.category.recreation_zone': 'Recreation zone',
  'seamark.value.category.recreational': 'Recreational',
  'seamark.value.category.south': 'South',
  'seamark.value.category.starboard': 'Starboard',
  'seamark.value.category.target': 'Target',
  'seamark.value.category.unknown_purpose': 'Unknown purpose',
  'seamark.value.category.warning': 'Warning',
  'seamark.value.category.wave_recorder': 'Wave recorder',
  'seamark.value.category.west': 'West',
  'seamark.value.category.yachting': 'Yachting',
  'seamark.value.colour.black': 'Black',
  'seamark.value.colour.green': 'Green',
  'seamark.value.colour.grey': 'Grey',
  'seamark.value.colour.orange': 'Orange',
  'seamark.value.colour.red': 'Red',
  'seamark.value.colour.white': 'White',
  'seamark.value.colour.yellow': 'Yellow',
  'plansList.empty': 'No saved plans yet.',
  'plansList.created': 'Created',
  'plansList.delete': 'Delete plan',
  'plansList.confirmDelete': 'Confirm delete',
  'plansList.actionError': 'Action failed. Please try again.',
  // #54: shown for a stored plan the read-time normaliser cannot handle. Two
  // strings, because the two cases call for different user action, and prod
  // and /uat/ share one origin-scoped database, so a production user can meet
  // the newer-version case without having done anything wrong.
  //
  // Says only what the stored schemaVersion PROVES. It deliberately does not
  // promise the record is undamaged: the classification rests on that one
  // number, so a record both written by a newer build AND corrupted (partial
  // write, foreign tool) lands here too — and the row's only control is an
  // irreversible delete, so the copy must not overstate recoverability.
  'plansList.unreadable.newerVersion':
    'This plan was saved by a newer version of the app. This older version cannot read it. It is kept, not deleted.',
  'plansList.unreadable.damaged':
    'This plan cannot be opened — the saved record is incomplete or damaged. It is kept, not deleted.',
  // #114: recalculate a saved plan with a FRESH forecast (unlike a via-replan,
  // which reuses the stored grid and stays offline-capable).
  'plansList.recalc': 'Recalculate',
  'plansList.recalc.saveNew': 'Recalculate as new plan',
  'plansList.recalc.replace': 'Replace original',
  'plansList.recalc.confirmReplace': 'Confirm replace',
  'plansList.recalc.cancel': 'Cancel',
  'plansList.recalc.offline':
    'Recalculation requires a connection — it fetches a fresh wind forecast.',
  'plansList.recalcName': '{name} (recalculated)',
  // #700: state-dependent action labels for the GPS tracking toggle — was a
  // single neutral 'Live view' that read as a section label, not an action,
  // and gave no SIGHTED indication of on/off state (only aria-pressed did).
  // `live.toggle` itself is reused as the OFF/"start" label (not renamed to
  // a `.start` sibling) so `App.test.tsx`'s `de['live.toggle']` lookup for
  // the tracking-off state keeps resolving without that file's own edit.
  'live.toggle': 'Start live view',
  'live.toggle.stop': 'Stop live view',
  'live.noPlan': 'Load or plan a route to use live guidance.',
  // #713: the visible abbreviation stays 'HTS' (unlike COG/SOG, a near-
  // universal marine pair); this is its screen-reader-only expansion. German
  // needs no twin — 'live.hts.label' is already the full word 'Steuerkurs'.
  'live.hts.expansion': 'Heading to steer',
  'live.hts.label': 'HTS',
  'live.cog.label': 'COG',
  'live.sog.label': 'SOG',
  'live.nextEvent.label': 'Next in {distance}',
  'live.nextEvent.motorStart': 'Motor on',
  'live.nextEvent.none': 'No more maneuvers on this route',
  'live.eta.label': 'Projected ETA',
  // #251: the heading-to-steer is a bearing to the active waypoint, not a
  // depth-validated course. Never claims the course is safe.
  'live.hts.depthCaution':
    'Bearing crosses {depth} m — shallower than your safety depth ({safety} m)',
  // Land is a different hazard from shallow water, and the mask encodes it as
  // depth 0.0 m — reporting "crosses 0.0 m" would dress it up as a sounding.
  'live.hts.landCaution': 'Bearing crosses charted land',
  'live.hts.depthUnchecked': 'Depth not checked',
  'live.gpsHint':
    "Location access isn't available, so the boat position can't be shown on the map. Planning and the saved route still work fully — this is a passage-planning aid, not a navigation device.",
  'live.gpsHint.dismiss': 'Got it',
  // #361: maplibre-gl 6.1.0 stopped supplying a default aria-label/role for
  // markers built with a custom `element` — BoatMarker must set its own,
  // like ViaMarkers already does, independent of library defaults.
  'live.ownship.marker': 'Current vessel position',
  // #115: manual "replan from here" — planning-aid framing, never navigation
  // guidance; uses the plan's STORED wind forecast (offline-capable, unlike
  // the #114 recalculation).
  'live.reroute.action': 'Replan route from here',
  'live.reroute.busy': 'Replanning route from current position…',
  'live.reroute.needFix': 'Needs an active GPS fix — start the live view and wait for a fix.',
  'live.reroute.hint':
    'Creates a new plan from the current position to the destination using the stored wind forecast; the original plan is kept. A planning aid, not navigation guidance.',
  'live.reroute.name': '{name} (replanned from position)',
  'nav.plan': 'Plan',
  'nav.routes': 'Routes',
  'nav.live': 'Live',
  // #299: kept short, shorter even than "Routes" — avoids the 280px squeeze
  // that would have been the tab option's cost with a word like "Settings".
  'nav.boat': 'Boat',
  'nav.langToggle': 'Auf Deutsch anzeigen',
  'nav.langToggle.de': 'DE',
  'nav.langToggle.en': 'EN',
  'about.open': 'About SailCommand',
  'about.title': 'About SailCommand',
  'about.close': 'Close',
  // #696: the icon-only close control beside the title. Distinct from
  // 'about.close' (the bottom text button's label) so the two controls have
  // different accessible names — both mean "close the dialog", but a
  // screen-reader user should be able to tell them apart, and giving them
  // the same name would also make `getByRole('button', { name })` queries
  // ambiguous.
  'about.closeDialog': 'Close dialog',
  'about.version': 'Version {version}',
  'about.changelog.title': "What's new",
  'about.changelog.langNote': 'The changelog is maintained in English.',
  'about.caveats.heading': 'Important notes',
  'about.caveats.polars':
    'Polars are estimates derived from ORC-style VPP data, tunable via the performance factor in options — not race-calibrated.',
  // #539 / #54 spec C.8 R5 + J OQ-2: every number here is now a placeholder
  // filled from the SELECTED boat (lib/depthDisclosure.ts), because the old
  // literals — 2.1 m draft, 3.0 m default, 1.2 m relaxation floor — were the
  // Salona 45's stated as universal facts, and the catalogue now also holds a
  // 1.90 m boat. {gate} is that boat's DERIVED default safety depth, {draft}
  // its own draft, {floor} its #53 relaxation floor's cautious reading
  // (draft − tolerance), never the UI-minimum floor. The gate clause claims
  // only that the floor never falls BELOW the draft — an inequality true for
  // every boat by construction (spec C.3); the two coincide for all three
  // catalogue boats today but a ceiling-rounded draft would separate them.
  'about.caveats.depthMask':
    'Depth values blend two readings of the same EMODnet bathymetry data: the smoothed reading is used only where it agrees with the more cautious one to within {tolerance} m, so the depth value the app uses is never more than {tolerance} m deeper than the cautious reading — that bounds the source data, not the real seabed. A cell the router plans through at safety depth G has a cautious reading of at least G − {tolerance} m. The default safety depth for the {boat} is {gate} m, set so that floor never falls below its {draft} m draft — but it can be as little as {floor} m where a route falls back to a shallower depth to stay connected, flagged on the resulting route.',
  'about.dataSize':
    'First load downloads ~44 MB (basemap and route data); later loads are served from cache and work offline.',
  'about.sources.heading': 'Data sources',
  'about.sources.protomaps': 'Map rendering: Protomaps',
  'about.sources.osm': '© OpenStreetMap contributors (ODbL)',
  'about.sources.openMeteo': 'Wind forecast: Weather data by Open-Meteo.com (CC-BY 4.0)',
  'about.sources.polars':
    'Polars: ORC International 2026 certificate, Salona 45 "Miles Ahead" (AUT 035/26); downwind values corrected to white sails (non-spinnaker) — an estimate, not race-calibrated.',
  'about.sources.seamarks':
    'Seamarks: © OpenStreetMap contributors (ODbL), seamark data as of 22 July 2026 — a point-in-time extract, not continuously verified',
  'banner.offline': 'Offline — planning disabled. Saved routes remain available.',
  'banner.mapError': 'Map data could not be loaded — the display may be incomplete.',
  'banner.persistenceError': 'Settings could not be saved.',
  'banner.dismiss': 'Dismiss',
  // §3.5: retry action shown on network/offline plan errors (re-runs the plan).
  'banner.retry': 'Try again',
  'banner.tapPick': 'Tap the map to set {target}.',
  'banner.tapPick.cancel': 'Cancel',
  // #571 redesign: triggered from App.tsx's handlePlan pre-check now (a
  // dedupeViaPoints call mirroring what usePlanFlow.ts's run() does
  // internally), not from a via-replan — the wording itself is unchanged.
  'banner.viaTooClose': 'Waypoint too close to a neighbor — skipped',
  'banner.viaTooClose.plural': '{count} waypoints too close to a neighbor — skipped',
  'pwa.updateAvailable': 'Update available',
  'pwa.reload': 'Reload',
  'pwa.offlineReady': 'App & maps available offline',
  // #25 AIS overlay — vessel popup + shared disclaimer.
  'ais.popup.name': 'Name',
  'ais.popup.mmsi': 'MMSI',
  'ais.popup.shipType': 'Ship type',
  'ais.popup.sog': 'SOG',
  'ais.popup.cog': 'COG',
  'ais.popup.age': 'Last signal',
  'ais.disclaimer':
    'AIS coverage comes from volunteer shore stations and is not guaranteed or complete. This overlay is an awareness aid, not collision avoidance and not a navigation device.',
  'options.ais.apiKey.label': 'AIS API key (aisstream.io)',
  'options.ais.mmsi.label': 'Your MMSI (optional)',
  'options.ais.mmsi.invalid': 'MMSI must be exactly 9 digits.',
  'options.ais.help':
    'Shows live surrounding vessel traffic in the Live view only (online only). Create a free API key at aisstream.io and paste it here. Your key and MMSI stay on this device; the key is sent only to aisstream.io as part of the subscription, and the MMSI is used only to filter your own vessel out of the display and is never transmitted. An awareness aid, not a navigation device.',
  'ais.status.off': 'AIS off — add a key in Options',
  'ais.status.connecting': 'AIS connecting…',
  'ais.status.live': 'AIS live · {count} vessels',
  'ais.status.offline': 'AIS offline',
  'ais.status.keyError': 'AIS: check your API key',
  'ais.status.liveRoute': 'AIS live · {count} vessels ({routeCount} along route)',
  // #155: north-arrow / track-up compass (see dict.de for the label rationale).
  'map.compass.northUp': 'Map orientation: north up. Activate course-up',
  'map.compass.northUp.noTrack':
    'Map orientation: north up. Course-up unavailable without a GPS course',
  'map.compass.trackUp': 'Map orientation: course up. Switch to north up',
  'map.compass.trackUp.stale':
    'Map orientation: course up (holding last course). Switch to north up',
  'map.compass.free': 'Map rotated by hand. Reset to north up',
  'map.compass.unavailableStatus': 'Course-up unavailable – no GPS course under way',
  // #155: nautical scale bar.
  'map.scale.aria': 'Map scale: {distance} {unit}',
  'map.scale.unit.nm': 'NM',
  'map.scale.unit.cbl': 'cbl',
  'map.scale.unit.m': 'm',
  'map.scale.unit.nm.one': 'nautical mile',
  'map.scale.unit.nm.other': 'nautical miles',
  'map.scale.unit.cbl.one': 'cable',
  'map.scale.unit.cbl.other': 'cables',
  'map.scale.unit.m.one': 'metre',
  'map.scale.unit.m.other': 'metres',
} satisfies Record<MsgKey, string>;
