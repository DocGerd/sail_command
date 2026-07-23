# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add a live AIS traffic overlay on the Live view: paste a personal aisstream.io API key in Options to see surrounding vessels (heading/COG, names, tap-for-details), with your own vessel filtered out by MMSI; online-only and fully inert without a key (#25).
- Add a "What's new" view to the About dialog showing this changelog — the release history is baked into the app at build time and readable offline (#131, #139).
- Add a manual "reroute from here" action in the Live view: with an active plan and a GPS fix, route from the current position to the plan's destination using the plan's stored forecast (works fully offline) and save the result as a new plan (#115, #137).
- Add a "Recalculate" action to saved-route cards to re-plan a saved route with a fresh Open-Meteo forecast and an editable departure time, saved as a new plan by default (#114, #136).
- Restore the active plan, selected tab, and rig choice automatically after a reload or PWA relaunch, using only locally stored data (no network re-fetch) (#113, #134).
- Show the departure time on saved-route cards, alongside the existing created and ETA times (#112, #130).
- Show the app's build version in the About dialog, so it's possible to tell which build an installed PWA is actually running (#125, #129).

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

[Unreleased]: https://github.com/DocGerd/sail_command/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/DocGerd/sail_command/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/DocGerd/sail_command/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/DocGerd/sail_command/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/DocGerd/sail_command/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DocGerd/sail_command/releases/tag/v0.1.0
