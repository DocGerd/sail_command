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
  'options.motorSpeed.label': 'Motoring speed (kn)',
  'options.motorThreshold.label': 'Motor threshold (kn)',
  'options.maneuverPenalty.label': 'Maneuver penalty (s)',
  'options.performanceFactor.label': 'Performance factor (×)',
  'options.motorEnabled.label': 'Motor enabled',
  'options.motorEnabled.help':
    'Engine as fallback only: motor legs are planned where predicted sailing speed drops below the threshold, and run at motor speed.',
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
  'route.rig.genoa': 'Genoa',
  'route.rig.fock': 'Fock',
  'route.rigTabs': 'Rig comparison',
  'route.recommended': 'Recommended',
  'route.fasterRig': 'Faster: {rig}',
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
  'plansList.empty': 'No saved plans yet.',
  'plansList.created': 'Created',
  'plansList.delete': 'Delete plan',
  'plansList.confirmDelete': 'Confirm delete',
  'plansList.actionError': 'Action failed. Please try again.',
  'live.toggle': 'Live view',
  'live.noPlan': 'Load or plan a route to use live guidance.',
  'live.hts.label': 'HTS',
  'live.cog.label': 'COG',
  'live.sog.label': 'SOG',
  'live.nextEvent.label': 'Next in {distance}',
  'live.nextEvent.motorStart': 'Motor on',
  'live.nextEvent.none': 'No more maneuvers on this route',
  'live.eta.label': 'Projected ETA',
  'live.gpsHint':
    "Location access isn't available, so the boat position can't be shown on the map. Planning and the saved route still work fully — this is a passage-planning aid, not a navigation device.",
  'live.gpsHint.dismiss': 'Got it',
  'nav.plan': 'Plan',
  'nav.routes': 'Routes',
  'nav.live': 'Live',
  'nav.langToggle': 'Auf Deutsch anzeigen',
  'nav.langToggle.de': 'DE',
  'nav.langToggle.en': 'EN',
  'about.open': 'About SailCommand',
  'about.title': 'About SailCommand',
  'about.close': 'Close',
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
} satisfies Record<MsgKey, string>;
