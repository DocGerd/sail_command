import type { MsgKey } from './dict.de';

export const en = {
  'app.title': 'SailCommand',
  'app.tagline': 'Time-optimal passage planning — offline, on board.',
  'app.disclaimer':
    'SailCommand is a passage-planning aid, not a navigation device. Chart data is simplified; official charts and your plotter remain authoritative.',
  'plan.eta': 'Arrival {time}',
  'harborPicker.searchLabel': 'Search harbor',
  'harborPicker.searchPlaceholder': 'Search harbor…',
  'harborPicker.resultsLabel': 'Harbors',
  'harborPicker.noResults': 'No harbors match your search.',
  'options.safetyDepth.label': 'Safety depth (m)',
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
  // One-line glance of the collapsed "Advanced" disclosure, joined with " · ".
  'options.summary.motorOn': 'Motor on',
  'options.summary.motorOff': 'Motor off',
  'options.summary.maneuver': 'Maneuver {seconds} s',
  'options.summary.performance': '×{factor}',
  'planner.card.trip': 'Trip',
  'planner.card.advanced': 'Advanced',
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
  'planner.via.replanning': 'Recalculating route with updated waypoints…',
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
  'planner.status.routing': 'Calculating route…',
  'planner.status.routingProgress': 'Calculating route… {progress}%',
  // #53: relaxed-depth probe phase after an unreachable requested-depth solve
  'planner.status.probing': 'No route at the set safety depth — probing reduced depth gates…',
  'error.offline': 'Wind forecast service is unreachable. Check your connection and try again.',
  'error.rateLimited': 'Wind forecast service rate limit reached. Wait a moment and try again.',
  'error.windService': 'Wind forecast could not be loaded. Try again in a moment.',
  'error.internal':
    'Route planning failed unexpectedly. Try again; if it keeps happening, reload the app.',
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
    'A via point is not navigable — pick a point at least 300 m from land or shallow water.',
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
  'route.rigTabs': 'Rig comparison',
  'route.recommended': 'Recommended',
  'route.fasterRig': 'Faster: {rig}',
  // #259: honest copy for the two cases where badging one rig as
  // "recommended" would be misleading — an ETA tie (too close to call) and
  // an all-motor route (the polar never drove a leg, so rig choice is moot).
  'route.rigTie': 'Genoa and Fock are effectively tied for this passage',
  'route.rigMoot': 'Rig does not matter here — this passage runs entirely under engine',
  'route.staleForecast':
    'Forecast is more than 12 hours old relative to departure — wind conditions may have changed since it was fetched.',
  // #53: honest passage-planning-aid copy — charted data may under- OR
  // overstate real depths (dredged channels are exactly where chart data is
  // pessimistic); never claim the route is verified safe.
  'route.shallow.banner':
    'Caution: this route crosses water charted shallower than your safety depth of {requested} m — shallowest charted depth along the route: {minGate} m. Chart data may understate or overstate real depths; dredged channels in particular are often deeper than charted. Verify the highlighted sections against official charts and your depth sounder.',
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
  'route.legs.kind': 'Type',
  'route.legs.heading': 'Heading',
  'route.legs.twa': 'TWA',
  'route.legs.tws': 'TWS',
  'route.legs.speed': 'Speed',
  'route.legs.distance': 'Distance',
  'route.legs.maneuver': 'Maneuver',
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
  'route.legend.via': 'Via waypoint',
  'route.legend.shallow': 'Charted shallower than safety depth',
  'route.exportGpx': 'Export GPX',
  'route.windBarbs.toggle': 'Show wind barbs',
  'route.windBarbs.timeSlider': 'Forecast time',
  'route.annotations.toggle': 'Times & speeds',
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
  'map.depth.toggle': 'Water depths',
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
  'seamark.value.category.leading': 'Leading line',
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
  'live.toggle': 'Live view',
  'live.noPlan': 'Load or plan a route to use live guidance.',
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
  'nav.langToggle': 'Auf Deutsch anzeigen',
  'nav.langToggle.de': 'DE',
  'nav.langToggle.en': 'EN',
  'about.open': 'About SailCommand',
  'about.title': 'About SailCommand',
  'about.close': 'Close',
  'about.version': 'Version {version}',
  'about.changelog.title': "What's new",
  'about.changelog.langNote': 'The changelog is maintained in English.',
  'about.caveats.heading': 'Important notes',
  'about.caveats.polars':
    'Polars are estimates derived from ORC-style VPP data, tunable via the performance factor in options — not race-calibrated.',
  'about.dataSize':
    'First load downloads ~44 MB (basemap and route data); later loads are served from cache and work offline.',
  'about.sources.heading': 'Data sources',
  'about.sources.protomaps': 'Map rendering: Protomaps',
  'about.sources.osm': '© OpenStreetMap contributors (ODbL)',
  'about.sources.osmMask':
    'Land/depth mask: derived from © OpenStreetMap contributors, made available under ODbL',
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
