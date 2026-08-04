# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

SailCommand — an offline-capable PWA that plans time-optimal sailing routes
for a Salona 45 in the Flensburg Fjord / Danish South Sea area
(54.3–55.3°N, 9.4–11.0°E), using hourly Open-Meteo wind forecasts and an
isochrone router that prices tacks/gybes as time penalties.

**Source of truth:** `docs/superpowers/specs/2026-07-14-sail-command-design.md`
(user-approved). Read it before making design-level decisions; do not silently
deviate from it.

## Layout

- `pipeline/` — build-time data preparation (Node/Python scripts). Outputs are
  committed static assets under `app/public/` (`data/`, `icons/`, and `brand/`
  for the social card): land/depth mask (packed binary, ~46 m cells, quantized
  depth per cell), curated harbor list JSON, PMTiles regional basemap, Salona 45
  polar tables (main+genoa, main+fock).
  Pipeline runs on demand, never at app runtime.
- `app/` — the PWA: Vite + React + TypeScript, MapLibre GL + PMTiles,
  routing engine in a Web Worker, IndexedDB persistence, service-worker
  offline caching, de/en i18n. Tests: Vitest (unit/property), Playwright (E2E
  incl. offline reload).
- `app/src/components/` mixes feature components with a small UI **primitive
  layer** (`Button`, `Card`, `Chip`, `Disclosure`, `Field`, `NumberInput`,
  `Skeleton`, added in #64) built on the locked `--sc-*` design tokens defined in
  `app/src/app.css` (see the UI modernization addendum
  `docs/superpowers/specs/2026-07-17-ui-modernization-design.md` §3.2). Reuse the
  primitives and tokens for new UI; don't reinvent buttons/inputs or hardcode
  colors/spacing.
- Root docs beyond README/CHANGELOG/SECURITY: `GOVERNANCE.md` (roles,
  decisions, release duties), `ROADMAP.md`, `CODE_OF_CONDUCT.md`, and
  `docs/security-assurance-case.md` — the OpenSSF Silver document set
  (#217–#219, #224). **#224 deliberately DECLINED a DCO and a CLA** (Apache-2.0
  §5 makes inbound = outbound): never add `Signed-off-by` trailers, and nothing
  checks for them. The #132 release-cut docs sweep covers these four too.

## Commands

- App (run from repo root): `npm --prefix app run typecheck` / `lint` / `test` /
  `build` / `dev`. CI runs lint+typecheck BEFORE tests — vitest alone will not
  catch unused imports or type errors.
- `npm --prefix X run <script>` chdirs into `X` before running; `npm --prefix X
  exec <bin>` does NOT — it resolves the binary from `X`'s `node_modules` but
  executes in the CALLER's cwd. `npm --prefix app exec vitest run -- <flags>`
  from repo root therefore never loads `app/vite.config.ts` (no jsdom, no
  `setupFiles`) and collects Playwright `.spec.ts` under `app/e2e/` as
  "(0 test)" — cost three failed coverage measurements this session. Always
  use `run`, never `exec`, for anything that depends on `app/`'s config.
- Statement coverage baseline: 93.92% (4100/4365 statements; branches 88.99%,
  functions 92.28%, lines 95.52%), measured 2026-08-03 via `npm --prefix app
  run test:coverage`. The trailing test/file COUNT from that same 2026-08-03
  measurement (1206 tests, 102 files) is now stale by exactly PR #351's own
  +1/+1 (`app/src/test/timeoutGuard.test.ts`, #342's structural guard) — the
  percentages above are untouched (a scanning-only test file is
  coverage-neutral) and were correctly left unmeasured-again per that PR;
  only the count needed updating, verified via a real `npm --prefix app run
  test` run: **1207 tests, 103 files** (2026-08-03). Meets the OpenSSF
  `test_statement_coverage80` criterion (≥80%) — it had simply never been
  measured before. `vite.config.ts`'s `coverage` block carries
  `thresholds.statements: 80` (#335) and `.github/workflows/coverage.yml`
  (#342) now evaluates it — but only NIGHTLY (`schedule` +
  `workflow_dispatch`), never per-PR: `app`'s required CI job still runs
  plain `test` (a bare `vitest run`, no coverage). `src/sw.ts` and
  `src/routing/worker.ts` STAY IN coverage scope at ~0% BY DESIGN (jsdom has
  no real ServiceWorker or dedicated-Worker execution model; decided 2026-08-03
  on #319 rather than excluded, since together they are only ~0.57% of
  statements and excluding would raise, not preserve, the published figure)
  — their functional assurance instead comes from `app/e2e/offline.spec.ts`,
  `csp.spec.ts`, `basemap-fallback.spec.ts`, `plan.spec.ts`, `live.spec.ts`
  and `deploy.yml`'s post-deploy CDN smoke probe; do not "fix" the 0% with a
  jsdom-mocked service-worker test — that would be the #50 equivalence-test
  tautology (statements execute without modeling real CacheStorage/Range/CDN
  semantics, the bug class that actually bit in #96 and #118).
- Full test suite takes ~4 min (a ~200 s seeded fast-check property suite +
  a ~40 s real-mask solver acceptance file). Use focused filters while
  iterating (`npm --prefix app run test -- <filter>`); give the full run a
  generous timeout. Solver-heavy test files import `SOLVER_TEST_TIMEOUT_MS`
  (file-level `vi.setConfig`) or call `solverTimeoutMs(baseMs)` (a larger
  per-test override, keyed OR positional, e.g. the property test's 900 s)
  from `app/src/test/timeouts.ts` (#342) rather than hardcoding a literal —
  eleven files previously each hardcoded their own literal (nine via
  `vi.setConfig({ testTimeout: 120_000 })`; `workerClient.test.ts` (x8) and
  `gpx.parse.test.ts` via a bare positional third `it()` argument, found in
  PR #351 review after the first sweep only grepped for the `testTimeout:`
  keyword) — a centralized, coverage-aware constant replaced all eleven.
  `SC_COVERAGE` (read by `timeouts.ts`) is set by `vite.config.ts`'s
  `test.env` whenever the CLI's own `--coverage`/`--coverage.enabled*` flag
  is present — not by a shell-only env-var prefix, so it works identically
  on any shell/OS and for any invocation that requests coverage, not only
  the `test:coverage` npm script — and scales solver budgets **8×**
  (hand-derived from the measured CI-coverage/CI-plain ratio below, doubled
  because that ratio is a lower bound measured on a run that was itself
  killed by a too-tight budget, and because solver-heavy tests are
  documented to pay MORE than the suite-average coverage penalty; full
  derivation in `timeouts.ts`'s `COVERAGE_MULTIPLIER` comment).
  **CI is slower than dev machines, but not by a flat multiplier** — measured
  2026-08-03 (#341, PR #335 work): `npm run test` local 249.8 s vs CI
  ~515–535 s (~2.1×); `npm run test:coverage` local ~983–1029 s vs CI 2558 s
  (~2.5×). Coverage instrumentation is a SEPARATE multiplier from runner
  speed — solver-heavy tests pay a bigger coverage penalty than component
  tests, so no single ratio predicts both. A job's `timeout-minutes` and a
  per-test `vi.setConfig` timeout are DIFFERENT failure surfaces: raising the
  former cannot rescue the latter (cost three red CI runs to learn). Operative
  rule unchanged — never add a per-test timeout tighter than the file-level
  config, and never size a CI timeout from a local measurement's margin; that
  holds at 2× as firmly as at a bigger multiplier. That rule is now
  structurally enforced, not just documented: `timeoutGuard.test.ts` fails
  loudly if `app/src/**/*.test.{ts,tsx}` hardcodes a `testTimeout`/`timeout`
  literal (keyed OR bare-positional form) instead of importing it from
  `app/src/test/timeouts.ts` — Playwright specs under `app/e2e/**` and
  `playwright.config.ts` are a NAMED residual, out of scope by glob (coverage
  never runs e2e, and Playwright's own `timeout: 120_000` is an unrelated
  budget); an `it.each(...)(...)` positional timeout is a separate, latent
  (not live) residual documented in the guard's own header comment.
- vitest's `BaseSequencer` sorts by file SIZE descending when there is no
  cache — and CI never has one (`npm ci` wipes `node_modules`).
  `invariants.property.test.ts` is ~4380 bytes but ~463 s, so the
  smallest-but-slowest file was scheduled LAST and idled ~109 s waiting for
  faster workers to finish. Fixed with a custom `sequence.sequencer` in
  `app/vite.config.ts` that schedules known-slow files first (#214).
  #214 also REMOVED `needs: app` from `ci.yml`'s `e2e` job: the two now run
  concurrently (~120 s saved per run, which compounds under the strict
  up-to-date policy), so a red `app` no longer skips `e2e`, and both jobs race
  the SAME `setup-node` cache key — a lockfile-changing PR may have `e2e`
  restore a miss and pay an uncached `npm ci`. Both accepted knowingly.
- The `e2e` job's own run time is commonly described as "~10 minutes"
  elsewhere in this file and in issue #327 — that figure is the assumed
  planning estimate, not a measurement. Runs captured while building #327's
  PR #330 (`ci.yml`'s docs-only-skip classify step) measured `npm run e2e`
  itself at ~3–4 min (run 30805813518: 10:30:24Z→10:33:40Z, ~3m16s; run
  30805575220: 10:26:31Z→~10:30:26Z). Use this measured range for e2e-alone
  planning; the older ~10 min figure may still describe a full CI *cycle*
  including queueing/startup, not the job's own duration.
- `ci.yml`'s `e2e` job gates its four expensive steps (`setup-node`, `npm ci`,
  `playwright install`, `npm run e2e`) behind a docs-only classify step (#327,
  PR #330). The JOB always runs and always reports — a trigger-level
  `paths`/`paths-ignore` on a REQUIRED check never reports at all, leaving the
  PR blocked forever, so only STEPS may be skipped; `python-lint.yml`/
  `verify-mask.yml` may use trigger filters precisely because neither is
  required. It fails CLOSED: filter error, empty diff, unreachable base,
  non-PR event, or any unmatched path all run e2e. `.claude/**` is
  deliberately NOT allowlisted (it holds executable hooks); `CLAUDE.md`,
  `LICENSE`, `docs/**` and `changelog.d/**` are. Measured on a real
  `CLAUDE.md`-only PR (#343): `e2e` reported success in 6 s with
  `mergeable_state: clean` — so a skipped-but-successful required check does
  satisfy `develop`'s gating.
- `app/package.json`'s `version: 0.1.0` is NOT the app version — but it is not
  dead code either: `vite.config.ts`'s `appVersion()` sets `__SC_APP_VERSION__`
  to `'dev'` on `serve`, else `git describe --tags --always`, and falls back to
  `package.json`'s `version` ONLY when git throws (tarball / git-less build,
  #125). Don't bump it expecting the About dialog to move; don't delete it
  either — that fallback is the only thing it is for.
- `npm --prefix app run notices` regenerates `app/public/THIRD-PARTY-NOTICES.txt`;
  CI fails if the committed file drifts — run it after any dependency change.
  This makes EVERY Dependabot bump of one of the 11 runtime packages listed in
  `app/scripts/gen-third-party-notices.mjs`'s `PACKAGES` array (react,
  react-dom, maplibre-gl, pmtiles, idb, @protomaps/basemaps, workbox-*) red on
  `app` — Dependabot cannot run project
  scripts, so it can never fix this itself. Signature: `app` fails at the
  `git diff --exit-code public/THIRD-PARTY-NOTICES.txt` step while `e2e` and
  CodeQL pass. Fix is mechanical — `npm ci` on the bump branch, run `notices`,
  commit the regenerated file (#248's entire real diff was two version strings).
- Pipeline: `npm --prefix pipeline run polars|harbors|seamarks|mask|icons` (mask needs
  `pipeline/.venv` — `python3 -m venv .venv && .venv/bin/pip install -r
  requirements.txt`). `pipeline/data-src/` is an ~888 MB gitignored download
  cache — NEVER delete it casually (re-downloading costs an hour); preserve it
  when removing worktrees. `verify_mask.py` must exit 0: it flood-fill-checks
  every harbor snap and has a documented KNOWN_DISCONNECTED allowlist (#9).
- Production build uses Vite `base: '/sail_command/'` (GitHub Pages) — local
  static serving must serve at that sub-path (and support HTTP Range for
  pmtiles).

## Code conventions (enforced, will fail review otherwise)

- TypeScript `strict` + `exactOptionalPropertyTypes` are ON; tsconfig
  `erasableSyntaxOnly` forbids enums and constructor parameter properties.
- `String.replace` with a STRING pattern (not a regex/global) silently
  returns the input UNCHANGED when the pattern is absent — no throw, no
  warning. Measured (#223): reformatting `<meta charset="UTF-8" />` to
  `<meta charset="utf-8">` made `vite build` exit 0 with ZERO CSP metas in
  `dist`. `cspMeta()` (`app/vite.config.ts`) now throws if its marker is
  missing; `subPathMeta()` in the same file still has the bare-`replace`
  shape (#318, open — a silent failure there degrades to an indexable UAT).
  Per the guard-asymmetry rule below: an absent security control is the
  expensive failure direction, so the check must fail closed.
- `Leg` is a discriminated union on `kind`: sail legs carry `board` + `twaDeg`;
  motor legs have `board: null` and NO `twaDeg` property. Narrow on `kind`,
  never cast.
- `Plan` is structured-clone-safe (IndexedDB/postMessage) but NOT JSON-safe
  (Float32Array wind grids) — file export needs a dedicated serializer (#3).
- Tests import vitest APIs explicitly (`import { describe, it, expect, vi }
  from 'vitest'`). i18n dicts enforce key parity via
  `satisfies Record<MsgKey, string>` — add every key to BOTH dicts.
- Never transfer the wind grid's buffers to the worker (clone keeps the saved
  plan's forecast intact); only the mask buffer is transferred, always as a
  `.slice(0)` copy of the cached original.
- MapLibre Popup chrome hardcodes `background:#fff` (no dark variant) — any new
  Popup needs a `className` plus app.css overrides theming
  `.maplibregl-popup-content` and BOTH popup-tip borders with `--sc-bg`
  (see `.seamark-popup`, #7).
- Vite `server.fs.allow` REPLACES the default workspace root when set, and the
  dev-server transform check tests BOTH `cleanUrl(id)` AND the `?raw`-suffixed
  id — an out-of-root `?raw` import needs `[APP_DIR, file, file + '?raw']`
  exactly (#131); prove any allowlist change with positive AND negative (403)
  probes.
- Map-layer components use `lib/styleReload.ts`'s `installStyleSetup`
  (idempotent setup + `styledata` re-add + late-install-safe
  `once('load')`+`once('idle')` deferral) and the shared
  `test/fakeMaplibre.ts` — never hand-roll `whenStyleReady`. MapLibre's
  `isStyleLoaded()` means EVERYTHING loaded incl. tiles in flight, never
  "style present"; a mid-session mount deferring on it via `once('load')`
  alone strands forever (#159). The fake's `addLayer` DROPS layers on a
  truthy-but-missing `beforeId` like real MapLibre — keep it strict (#163).
- Cross-component layer z-order is anchored EXPLICITLY (DataLayers inserts
  below `AIS_STACK_BOTTOM_LAYER` whenever the AIS stack exists, #160) —
  never rely on setup timing for ordering; the asset-fetch delay makes
  timing races real.
- Map-chrome stacking is a DECLARED tier order, written out in full above
  `.app-header` in `app/src/app.css` (#208): shell chrome (`.app-header`,
  `.banner-area`, `.app-tabs`) `z-index: 3` > map chrome (`.map-stack-tl`,
  `.route-layer-controls`, `.ais-status`) `2` > untiered
  (`.app-bottom-sheet` content, `.scale-bar`). Principle: A outranks B when a
  user unable to reach or see A is the worse outcome. Place a NEW element by
  tier — never invent a value between tiers, and fix a same-tier overlap by
  MOVING one element, not by bumping it. Scope every height/overflow bound to
  the condition that motivated it: `max-height` defends against the bottom
  sheet, so it is narrow-only (`none` on wide, where the sheet is a static
  side column — unscoped it squeezed both clusters for nothing).
  `.route-layer-controls` bounds the whole cluster with plain `overflow-y`,
  but `.map-stack-tl` lets only `.data-layer-controls` shrink
  (`.compass-control` is `flex-shrink: 0`) — DELIBERATE: the plain bound would
  scroll the compass itself out of reach.
- `ScaleBar` is coupled to `.banner-area` through a RUNTIME-MEASURED value,
  not a CSS rule: it computes its suppression ceiling from `.map-stack-tl`'s
  rendered bottom edge. Before PR #374 nothing observed `.banner-area`
  mounting a banner, so that ceiling went stale and the bar rendered fully
  OVERLAPPING `.map-stack-tl` — 1837.7px² measured — rather than
  suppressing. Fixed with a `MutationObserver` on `.banner-area`
  (`{childList: true}`), disconnected on unmount, with a NAMED COUPLING
  comment pointing at `App.tsx:684` which renders the wrapper unconditionally.
  Any rule that moves `.map-stack-tl` also changes `ScaleBar`'s available
  room — the two are connected only through that runtime-measured layout
  value, invisible in the CSS, in the diff, and to any test that checks the
  two components separately.
- `@media not (min-width: 1024px)` is Media Queries Level 4 syntax (`not`
  applied to a bare condition with no media type) — a Level 3 parser treats
  it as a syntax error and drops the ENTIRE block silently, no console error,
  nothing for CI to see. On WebKit, `:has()` shipped EARLIER than MQ4
  boolean syntax, so for a rule using both there is a real iOS Safari band
  where the selector matches and the query is discarded, losing the rule
  entirely. `app/src/app.css`'s banner-clearance rule therefore uses
  `@media (max-width: 1023.98px)` deliberately, accepting the 0.02px
  hairline — do not "tidy" it to the MQ4 complement. When swapping a syntax,
  check the support floors of the features that must work TOGETHER, not
  each in isolation.
- `maxPitch: 0` is set at Map CONSTRUCTION in `MapView.tsx` — not via a later
  `setMaxPitch`/`setPitch`, which a style reload could undo — and pinned by
  `MapView.mount.test.tsx`'s `'#207: constructs with pitch locked flat'`.
  Pitch is deliberately unreachable; don't re-enable it without re-auditing
  for terrain/sky/3D layers and pitch readers (there are none today, #207).
- GPS-derived per-fix signals (`activeLegIndex` et al.) may only drive CHEAP
  idempotent consumers (RouteLayer's `setFilter`); any network/subscription
  effect keyed on them needs a settle gate (`useSettledValue`, 2 s, with a
  `[plan, rig]` resetKey so plan changes bypass it) — GPS noise flips the
  nearest-leg argmin at fix rate near leg boundaries (#158).
- Camera MODE is DERIVED from the camera, never tracked alongside it (#203,
  #227): every settle re-checks `north` against `map.getBearing()`, and
  MapLibre's `originalEvent` stamp (present only on events a real user gesture
  caused) discriminates a hand rotation from a foreign settle — guarded
  against a settle delivered from inside our OWN `easeTo`. **Post-maplibre-gl-6
  (#253): `map.isEasing()` is GONE from `Map`** — v6's `Map extends Evented`,
  not `Camera` (`node_modules/maplibre-gl/src/ui/map.ts:576` vs
  `ui/camera.ts:284`; they are siblings), and the method survives only on the
  private `_camera` field. `CompassControl.tsx`'s `onMoveEnd` guard is now a
  TWO-TERM derivation: `e.originalEvent !== undefined &&
  commandedBearingRef.current !== null &&
  !bearingReached(map.getBearing(), commandedBearingRef.current)`. Both terms
  are load-bearing: a `commandedBearingRef`-only guard regresses the three
  #203 F1 aborted-ease tests (MEASURED, not predicted), because F1 (aborted
  ease, MUST demote) and F2
  (foreign ease still live, must NOT demote) are bit-identical in
  `(commandedBearingRef, getBearing())` — no predicate over only those two can
  separate them. Term 2 does NOT stand alone — `e.originalEvent !== undefined`
  is true for EVERY handler `moveend` whether or not an ease is live; it is
  only IN CONJUNCTION WITH term 1 that the pair reproduces what `isEasing()`
  gave us on the reachable paths. What makes that conjunction sound: `_stop`
  (`camera.ts:1197-1211`) deletes `_easeFrameId` and only THEN invokes
  `_onEaseEnd` at `:1211` — and `_afterEase` (`:982`) IS that `_onEaseEnd`,
  bound in `_ease` (`:1234`) — so `isEasing()` was already false at every
  ease-emitted `moveend` even in v5, which is why the absence of
  `originalEvent` discriminates a camera-internal ease termination from a
  handler-gesture settle. ACCEPTED NARROWING: the new
  guard is ease-source-SPECIFIC where `isEasing()` was ease-source-AGNOSTIC —
  a foreign, bearing-changing ease carrying no `originalEvent` would now demote
  where v5 did not. No producer exists in the app today
  (`RouteLayer.tsx:458`'s `fitBounds` passes `duration: 0` and the current
  bearing; keyboard rotation and drag inertia always carry `originalEvent`;
  `resetNorth` has no call site; `bearingSnap: 0` makes MapLibre's internal
  snap unsatisfiable), and the gap is pinned by a regression test AND by
  `app/src/test/cameraAnimationCallSites.test.ts` (a structural test that
  fails loudly if a new camera-animating call site appears outside the
  allowlist) — call this "narrowed and pinned", not "closed". The chronology,
  because the dead ends recur: eases
  that can interrupt one another need an `easeId` (5.24 fires the INTERRUPTED
  ease's `moveend` synchronously inside the next `easeTo`,
  `_stop`→`_afterEase`; the guard is skipped without an id), so an "is this my
  own ease" FLAG gets cleared mid-flight and the controller misreads its own
  animation as a user gesture (#155) — and `easeId` is necessary but NOT
  sufficient, since MapLibre suppresses only when ids MATCH, so a FOREIGN ease
  (pan inertia, keyboard rotation, a plan-change `fitBounds`) still clears any
  flag. Residual: a pure PAN can still get rewritten into a rotation-to-north
  by MapLibre's own 7° `bearingSnap` and fires WITH `originalEvent` attached,
  so track-up still drops whenever `0 < |bearing| < 7` — an everyday heading
  (#230).
- `fitBounds` must pass `bearing: map.getBearing()` explicitly —
  `cameraForBounds` defaults bearing to 0, so every new `plan.id` (including a
  Live reroute under way) silently un-rotates the chart and kills track-up
  (#155). That default had previously masked a desync bug; preserving bearing
  is what exposed the #203 north-up dead end above.
- `icon-padding` (default 2 px/side) is part of MapLibre's collision box, not
  decoration — it's the lever for offsetting `icon-size` growth without
  changing the collision footprint (#191).
- `symbol-sort-key` is ONE knob driving TWO opposite behaviours. Below z12
  (`icon-overlap: 'never'`) a lower key wins placement (culled first); at
  z≥12 (`'always'`) a **higher** key paints on top, and
  `queryRenderedFeatures` returns top-to-bottom so the topmost also wins the
  tap. `symbol-z-order: 'viewport-y'` is NOT an escape — it sets
  `sortFeaturesByKey = false` (`symbol_bucket.ts:391` — line verified
  against the exact pinned `maplibre-gl@6.0.0` install, re-checked after the
  #253 v6 upgrade: still `this.sortFeaturesByKey = zOrder !== 'viewport-y' &&
  !sortKey.isConstant();` at the same line; re-check again after any future
  maplibre-gl upgrade),
  disabling the placement priority entirely. Within one symbol layer,
  placement and paint order cannot be set independently — that needs a
  second layer (#200, #232).

## PWA / E2E / deploy

- E2E: `npm --prefix app run e2e` (the `pree2e` hook regenerates
  `app/public/test-fixtures/wind-sw12.json` with fresh timestamps and builds —
  a dirty fixture diff after an e2e run is expected churn, restore it, don't
  commit it). One-time setup: `npm --prefix app exec playwright install chromium`.
  Single-spec runs work: `npm --prefix app run e2e -- plan.spec.ts` — validate a
  failing spec locally before burning a ~10 min CI cycle (pree2e still rebuilds;
  restore the wind fixture afterwards).
- **Honest offline testing**: Playwright's `setOffline(true)` does NOT block
  service-worker fetches (Playwright #2311) — the offline spec kills the
  preview server instead. Never "simplify" that away.
- E2E determinism: no fixed `waitForTimeout` as a synchronization wait — gate
  on state signals with `expect.poll`; settle canvas baselines via two
  consecutive byte-equal screenshots before byte-comparing frames against them.
- `map.once('idle')` settle gates are UNREACHABLE in practice — measured on
  PR #375: instrumenting the real page with a non-`once` `map.on('idle')` for
  8s starting immediately after `mapReady()` resolves produced ZERO idle
  events on an already-loaded static map. `map.loaded()` requires only
  sources loaded; `idle` additionally requires placement settled, so by the
  time `mapReady()`'s poll observes `loaded() === true` the one-shot initial
  `idle` has already fired and the listener attaches after it. A gate of the
  shape `map.once('idle', done)` racing a fixed cap therefore ALWAYS takes
  the cap — an unconditional sleep in a state-signal costume, forbidden by
  the E2E determinism rule above, and self-concealing: a gate that always
  times out and always passes is indistinguishable from one that settles
  fast. Replacement in `labels.spec.ts`: poll sorted `places_locality` label
  arrays (identity compare, not count — a same-count swap must be caught),
  require three consecutive matches at 400ms, fail CLOSED on budget
  exhaustion with the count history and last three label sets. Three-at-400ms
  is chosen to exceed maplibre's placement throttle: `Placement.stillRecent`
  (`symbol/placement.ts:1268-1277`) gates re-runs on `commitTime +
  fadeDuration * durationAdjustment > now` with `fadeDuration: 300` defaulted
  at `ui/map.ts:539`. Measured effect: spec runtime ~6.5s -> ~2.3s,
  stabilising after three reads (~820ms) — placement had been settled almost
  immediately all along. `annotations.spec.ts` carries the same pattern and
  is NOT yet fixed — tracked in #376.
- Dark mode has NO in-app toggle — it is pure `@media (prefers-color-scheme:
  dark)` in `app.css`, so a both-themes verification pass needs Playwright
  `page.emulateMedia({ colorScheme })`, never a UI click.
- Playwright MCP `page.screenshot({ path: './x.png' })` writes relative to the
  REPO ROOT — write captures to /tmp (or move them out immediately) so a later
  `git add` cannot sweep them into a commit.
- GPS dynamics ARE e2e-testable: `app/e2e/live.spec.ts` (#142) drives
  deterministic fix sequences via Playwright `context.setGeolocation` +
  `test.use({ permissions: ['geolocation'] })` against the real solver/mask —
  extend it rather than claiming live behavior is untestable.
- **maplibre-gl 6's worker must be BUNDLED, not copied** (#253): v6 loads its
  worker via `new Worker(url, {type:'module'})` from a URL built dynamically
  inside the library, which Vite cannot see — so nothing is emitted and the
  basemap silently does not render. The fix is `setWorkerUrl` fed by
  `import ... from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'` in
  `MapView.tsx`. The `worker: { format: 'es' }` in `vite.config.ts` that keeps
  the module-type `Worker` construction valid was ALREADY there — it predates
  #253 and is not part of the fix; don't go looking for it in that diff.
  **`?url`
  is the trap**: it copies the file VERBATIM without resolving its imports,
  and maplibre ships the worker split — `maplibre-gl-worker.mjs` opens with
  `import{...}from"./maplibre-gl-shared.mjs"`, whose sibling never gets
  emitted, so the worker 404s on its own dependency. The signature of the
  broken form is a ~19 KB emitted chunk that still contains a
  `from"./maplibre-gl-shared.mjs"`; the correct form emits a ~468 KB
  self-contained chunk with NO import specifiers at all. Verify with
  `grep -o 'from"[^"]*"'` on the emitted chunk — existence, correct name,
  hashing, and a 200 response all look right in the broken case. No
  `globPatterns` change is needed: Vite's worker pipeline emits `.js`, which
  the existing precache token already covers.
- `app/src/sw.ts`: the `.pmtiles` Range→206 route MUST stay registered before
  `precacheAndRoute` (first-registered wins; pmtiles' FetchSource throws on
  full-body 200s), and the SW must never cache the Open-Meteo origin (wind is
  stored per plan in IndexedDB, not in the SW cache).
- The basemap ships as `app/public/data/basemap.pmtiles.png` (#118) — a deliberate
  masquerade, never "clean up" the extension: GitHub Pages' CDN gzips
  `application/octet-stream` at EVERY size and serves Range 206 slices of the
  COMPRESSED body, which breaks PMTiles reads for first-load/no-SW visitors;
  `image/png` is the only probe-proven exempt content-type (a `.bin` rename does
  NOT work). `sw.ts`'s Range route owns BOTH `.pmtiles` and `.pmtiles.png`
  (`isBasemapArchivePath`, transition-safe), and uncontrolled pages run a 16-byte
  magic preflight (`app/src/services/basemapSource.ts`, `cache:'no-store'`) that
  falls back to a full-body Blob-backed source if the CDN ever re-gzips — a
  future CDN flip degrades to a slow map, never an outage.
- Font glyphs (`basemap-assets/fonts/**`) are runtime-cached, never precached
  (#28): a `sailcommand-glyphs-*` CacheFirst route in `app/src/sw.ts` plus an
  app-side background warm-up (`app/src/services/glyphWarmup.ts`) that runs
  only once the SW controls the page. Never extend the SW install/activate to
  fetch them — the small install is the point. Cache version-bump procedure
  lives in `app/src/lib/glyphs.ts`.
- Runtime cache names must be deployment-scoped: prod and `/uat/` are two SWs on
  ONE origin and `sw.ts`'s activate cleanup enumerates ALL origin caches — glyph
  caches use `sailcommand-glyphs-<slug>@<version>` derived from BASE_URL (#96);
  never add a bare shared cache name or an unscoped cleanup matcher.
- **Deploy — one artifact, two refs** (#96, #197): `deploy.yml` fires on push
  to `main`, `develop`, OR a release TAG (`v[0-9]*` — the glob is the
  narrowing gate; the `github-pages` env tag policy is the permissive `v*`).
  Pages serves a SINGLE deployment artifact, so every run builds BOTH refs
  into one combined artifact regardless of which branch triggered it — `main`
  → the site root (production, `app/vite.config.ts` `base: '/sail_command/'`,
  unchanged), `develop` → `/uat/` (`SC_DEPLOY_ENV=uat` env var switches `base`
  to `/sail_command/uat/` and, via the config's `subPathMeta()` plugin + PWA
  `manifest` block, adds `<meta name="robots" content="noindex, nofollow">`
  and a distinct manifest `name`/`id` so the UAT build installs as a separate
  PWA rather than colliding with production's). This deliberately couples the
  two deploys. Production: `https://docgerd.github.io/sail_command/`
  (unchanged, verified byte-for-byte identical to the pre-#96 build). UAT
  (unreleased develop state — noindex, not chart-authoritative, don't link it
  from anywhere production-facing):
  `https://docgerd.github.io/sail_command/uat/`.
- **Deploy — prod-bytes identity and the cached dist** (#117): develop-triggered
  runs REUSE a cached, validated prod dist keyed on the composite `(main SHA,
  git-describe version)` identity instead of rebuilding it (validation BEFORE
  assembly = full sha256 manifest + sanity + PMTiles magic + cross-check
  against the main-authored baseline whenever one is retrievable;
  miss/invalid → loud full rebuild + byte-drift check against that baseline —
  drift fails the run). Main-MODE runs (a `main` push, a release-tag push, or
  a dispatch on `main`) double-build as a determinism proof and publish the
  baseline as the `prod-manifest` artifact. Cache saves happen only on
  BASELINE-VERIFIED develop-triggered rebuilds — cache keys are immutable, so
  caching unverified bytes could permanently shadow a baseline recorded later
  for the same SHA — and on develop-triggered runs only: develop is the
  DEFAULT branch, so its cache scope is visible everywhere, while main-scoped
  saves would be invisible to develop runs — that cache-scope asymmetry is why
  the drift baseline travels as a workflow ARTIFACT, not a cache. Because a
  tag push changes the prod bytes at an UNCHANGED main SHA, prod-bytes
  identity is `(main SHA, git-describe version)` EVERYWHERE — never the SHA
  alone: the cache key carries the version (`prod-dist-v2-<sha>-<version>`;
  keys are immutable, so a SHA-only key would let the pre-tag entry outlive
  the release) and the baseline artifact carries `version.txt`, which the
  develop-side lookup matches alongside `main-sha.txt`. That lookup also has
  NO `branch=main` filter: a tag run's `head_branch` is the TAG name, so the
  filter would hide exactly the release baseline. **Durable rule:** changing
  the baseline FORMAT or the cache key suspends #117a's "a develop push cannot
  alter production bytes" invariant until the change reaches `main` — only
  main-mode runs publish a baseline and a missing one does NOT self-heal. That
  interval is green, not red (the determinism double-build still guarantees
  correct prod bytes; only the cross-run drift CHECK is unavailable) and it
  ends on its own at the next release cut. `gh workflow run deploy.yml --ref
  main` helps only AFTER `main` holds the change — dispatched earlier it
  resolves the workflow FILE from `main`'s old tip and republishes the OLD
  baseline shape, changing nothing (#197).
- **Deploy — the tag trigger** (#197): the `v*` TAG trigger is ADDITIVE — the
  branch triggers stay, or an untagged `main` push (hotfix, docs) would
  silently stop deploying. A release cut thus produces TWO runs: the merge
  push (builds before the tag exists, so `git describe` bakes the untagged
  `vX.(Y-1).Z-N-g<sha>` into `__SC_APP_VERSION__`) and the tag push (rebuilds
  with the tag visible and publishes the clean `vX.Y.Z` — the v0.4.0 cut's
  manual deploy re-run, automated). A tag run is a MAIN-MODE run in every
  respect: it builds both refs from their BRANCH tips (the tag is a timing
  marker, never a content selector — building the tag's commit could roll prod
  back if `main` moved on), double-builds for the determinism proof, and
  publishes the authoritative `prod-manifest` baseline. A `push` on a tag also
  resolves the WORKFLOW FILE from the tag's commit, so a `v[0-9]*` tag on a
  commit predating #197 silently does not deploy.
- **Deploy — concurrency and environments**: `concurrency: { group: pages,
  cancel-in-progress: true }` admits only one deploy run at a time, but it
  CANCEL-SUPERSEDES rather than queues — a newer run cancels the in-flight one
  — and release tag runs share that group (see Release & branching for why
  that matters). Develop-triggered runs additionally record a `uat`
  environment in the Deployments UI, and main- AND tag-triggered runs a `prod`
  one (both bookkeeping only, #106/#127/#197 — a release cut therefore logs
  two `prod` entries, the tag one being authoritative); `github-pages` remains
  the platform-managed mechanical env — never rename it (the Pages OIDC flow
  owns it; rename is a trap, #127 spike) — and still interleaves all three
  refs' entries unchanged. `main` and `develop` are both guarded by the
  `protect-main` ruleset (#15 — one ruleset covering both branches via literal
  refs): PR-only merges (merge commits, review threads resolved), required
  checks `app` + `e2e` with strict up-to-date policy, no force pushes or
  deletions.
- Post-deploy CDN smoke probe (#117, guards the #118 fix class): `deploy.yml`'s
  `smoke-probe` job probes BOTH deployments (prod site root AND `/uat/`) on
  EVERY run — a redeploy evicts prod's CDN edge Range objects even when zero
  prod bytes changed (measured on #117: develop pushes resurfaced the #118
  gzip flip on prod) — at archive filenames discovered from each ref's own
  built dist (`data/basemap.pmtiles*`, never hardcoded; zero matches fails the
  job), requiring 200 with no `content-encoding` plus a `Range: bytes=0-15` →
  206 of exactly 16 bytes starting with the `PMTiles` magic, with retries for
  CDN propagation — a CDN gzip/range flip becomes a red deploy run, not a
  silent user-facing slowdown.
- After a BATCH of develop merges, verify the LAST deploy run before trusting
  either deployment — `gh run list --workflow=deploy.yml --limit 6 --json
  headSha,conclusion` then check that run's `smoke-probe` job. `concurrency:
  pages` CANCEL-supersedes, so a rapid merge train legitimately leaves several
  grey "cancelled" runs and only the final one matters; a cancelled LAST run
  means nothing deployed and looks identical to nothing happening. This is not
  bookkeeping: a develop push redeploys and evicts PRODUCTION's CDN edge Range
  objects even when zero prod bytes changed (measured on #117), and it is also
  the only thing that makes "check the About dialog on UAT" a meaningful request.
- The github-pages ENVIRONMENT deployment policy (repo Settings, not YAML)
  gates deploys by triggering REF — branch entries `main`+`develop` (#96) plus
  a TAG entry `v*` (#197; deliberately permissive — `deploy.yml`'s `v[0-9]*`
  trigger glob is the narrowing gate, so tightening the release shape never
  needs a Settings change). A new deploying branch or tag pattern needs a policy
  entry (`gh api repos/DocGerd/sail_command/environments/github-pages/deployment-branch-policies
  -f name=<name> -f type=branch|tag`) or the deploy job is rejected with "not
  allowed to deploy" — AFTER the build job has already run, so the run reds
  late, not fast.
- UAT-only UI (#107): gate on the `__SC_UAT__` Vite `define` (set by
  `SC_DEPLOY_ENV=uat`) with a fold-exact ternary — a JSX `&&` gate leaves a
  minified residue in the prod bundle — and keep its strings in a
  component-local de/en dict with `satisfies` parity (main-dict keys always
  ship to prod). Required evidence: prod double-build vs. base `diff -r`
  byte-identical. That check is NOT CI-gated — re-verify it whenever the gate
  or badge module area changes.
- UAT regression triage: `/uat/` redeploys on EVERY develop push, so an
  installed UAT PWA is routinely one version behind — "it broke on UAT" can
  simply be the reporter's stale SW (the reporter-confirmed cause of the
  harbor-combobox false alarm, #107 session). Before filing, verify the
  deployed artifact with a cache-busted browser pass (unregister both origin
  SWs, clear caches, hard-reload) and inspect ARIA/DOM, not pixels.
- **CSP (#223)** ships as a build-only `<meta http-equiv>` injected by
  `cspMeta()` in `app/vite.config.ts` (`apply: 'build'`) — GitHub Pages
  cannot set response headers, and the meta is deliberately ABSENT from
  `index.html`'s source and from `vite dev`'s served HTML: Vite's dev client
  injects CSS as inline `<style>` elements, which `style-src 'self'` blocks
  outright (measured, PR #316 review B2 — dev renders fully unstyled, 0
  stylesheets/0 CSS rules, with only a console violation and no visible
  error). A dev-server browser pass is a documented verification step here,
  so a source-HTML CSP would silently break it.
  `worker-src` is `'self'` only — NOT `blob:`. maplibre-gl 6's blob-worker
  fallback (`workerFactory()` in `util/web_worker.ts`) is unreachable here
  (`MapView.tsx` feeds `setWorkerUrl` a same-origin `?worker&url` asset, and
  the factory short-circuits same-origin URLs to the non-blob path), and
  adding `blob:` anyway was measured (PR #316 review B1) to defeat
  `script-src 'self'` outright — a blob-URL `new Worker` ran arbitrary code
  under the policy. `img-src` keeps `data:`/`blob:` legitimately (maplibre's
  `arrayBufferToImage` and the PMTiles raster path use `createObjectURL`).
- Glyph `.pbf` fetches are gated by `connect-src`, not `font-src` — MapLibre
  loads them via `getArrayBuffer`/`fetch`
  (`node_modules/maplibre-gl/src/style/load_glyph_range.ts:21`); `font-src`
  governs `@font-face` only, which this app doesn't use for map labels.
  Nothing in the suite yet asserts a label actually renders (#320).
- `app/e2e/csp.spec.ts` closes the structural blind spot the rest of the
  suite has: `annotations.spec.ts:167` asserts ZERO Open-Meteo requests,
  every planning spec uses `?windFixture=`, AIS is BYOK so opens no sockets,
  and jsdom enforces no CSP at all — so a directive wrong in either direction
  (too tight, blocking startup; too loose, degraded to unrestrictive) would
  pass every other spec. It asserts ALL non-`example.com` violations are
  empty across the whole page lifetime, not an allowlist of expected ones —
  a narrower per-origin filter was tried and would have missed exactly the
  PR's own B2 finding.

## Release & branching

- **Branching (gitflow-lite, #73)**: `develop` is the protected DEFAULT branch
  where WIP accumulates — feature PRs target `develop`, never `main`. A RELEASE
  is a PR `develop` → `main` (full CI `app`+`e2e` re-runs under the strict
  up-to-date policy), merged as a merge commit, then tagged on `main` with a
  SIGNED tag (`git tag -s "$TAG" -m "$TAG" main`, release runbook §5a — `-m`
  is required, not cosmetic: a bare `git tag -s` with no message opens an
  editor and blocks an unattended cut). **Signed from `v0.8.0` onward (#322)**
  — SSH signing (`gpg.format = ssh`), verified locally with `git tag -v`
  BEFORE the push (§5a) and, for anyone else, via GitHub's "Verified" badge
  (from `v0.8.1` onward — the `v0.8.0` tag itself is a documented exception,
  signed under an identity not registered on the maintainer's GitHub
  account, so it stays Unverified permanently; see the `v0.8.1` CHANGELOG
  entry and `CONTRIBUTING.md`'s "Tagger identity" section) or `git tag -v`
  against a locally-built `allowed_signers` file, which is unaffected by
  that gap and works for every signed tag including `v0.8.0` (setup in
  `CONTRIBUTING.md`, verification story in `SECURITY.md`). `v0.1.0` through
  `v0.7.0` remain permanently unsigned — signing is explicitly NOT
  retroactive: moving or re-creating a published tag is avoided, both
  because it needlessly re-fires the tag-triggered workflows (risking a
  `pages`-concurrency cancellation of a genuine in-flight deploy —
  `release.yml`'s own guard against a duplicate Release means the badge
  itself isn't actually at risk for an already-shipped tag) and because a
  published signed tag is an attestation a third party may already have
  verified, which mutating the object would invalidate. `main` is
  released-state-only. Pushing that tag is what puts the clean `vX.Y.Z` in the
  About dialog (#197) — no manual deploy re-run any more — so the runbook's
  step 5b (`.claude/skills/release/SKILL.md`, the MECHANICAL control) must
  pass before the back-merge: the tag-triggered run reached `success` AND prod's
  About dialog shows the clean tag. A green step 5b is not the whole cut,
  though — a git tag and a GitHub Release are different objects, and pushing
  the tag alone does not create one. The v0.6.0 cut (2026-07-31)
  followed this runbook exactly — tag pushed, deploy `success`, About dialog
  showing the clean `v0.6.0`, production verified serving it, every signal
  green — and still shipped with no Release object; none of those signals is
  evidence a Release exists, and it surfaced only when the maintainer noticed
  it missing from the GitHub project page. `.github/workflows/release.yml`
  (#175, shipped v0.7.0) now closes that gap automatically: the tag push ALSO
  triggers `release.yml`, which extracts the matching `## [X.Y.Z]`
  `CHANGELOG.md` section and creates the Release. Because a `push` on a tag
  resolves the workflow FILE from the tag's own commit (same rule as the
  `workflow_dispatch --ref` trap below), `release.yml` must already be on
  `main` BEFORE the tag is pushed — true here only because it merged via the
  release PR itself. Runbook step 5c is now VERIFY, not create: confirm the
  Release exists and `gh release list` shows the
  tag marked `Latest` — `--latest` is load-bearing on creation, since without
  it the previous version keeps the badge, a silent wrong state rather than
  an error. Rationale: `cancel-in-progress`
  cancel-supersedes and tag runs share the `pages` group, so the tag run
  cancels the still-running merge run, and a back-merge push inside that window
  cancels the tag run — then NEITHER release run deployed and production keeps
  serving the PREVIOUS release's bytes, signalled only by a grey "cancelled",
  never a red. (`cancel-in-progress: false` does not fix it — a merely PENDING
  run is cancelled too; a ref-conditional group WOULD, and was evaluated and
  rejected: it lets two runs reach `actions/deploy-pages` concurrently. See the
  comment above `concurrency:` in `deploy.yml`.) At the v0.4.0 cut this
  collision already happened in the other direction — the manual re-run
  cancelled the back-merge run; the v0.7.0 cut (2026-08-03) confirmed the
  standard direction empirically — the merge-push deploy run
  (`main`@`a59236e`, 09:10:51) shows `cancelled`, superseded by the tag-push
  deploy run 31 s later (09:11:22) — expected, not a fluke. `deploy.yml`
  (#96, #197) fires on push to
  `main`, `develop`, or a release tag (`v[0-9]*`):
  production at the Pages site root reflects only released
  (`main`) state as before; `develop`'s unreleased state is additionally
  published to the deliberately-labeled, `noindex`ed `/uat/` sub-path in the
  same run — a UAT preview, not a second production. After a RELEASE, back-merge
  `main` into `develop` via a TOPIC branch (branch off `develop`, `git merge
  origin/main` — fast-forwards to the release commit, zero file diff — then PR →
  `develop`): a DIRECT main→develop PR reads BEHIND under the strict up-to-date
  policy, and its "Update branch" button would merge develop→main, polluting the
  released branch (v0.2.0 lesson, reused for v0.3.0). A HOTFIX branches from `main`, PRs to
  `main`, then `main` is merged back into `develop` to keep it ahead. CI
  (`ci.yml`, `codeql.yml`, `verify-mask.yml`) fires on pushes to both `main`
  and `develop` so required checks keep reporting; the single `protect-main`
  ruleset targets both `main` and `develop` via literal refs (never
  `~DEFAULT_BRANCH` — that follows a default-branch flip and would strand the
  non-default branch) and requires `app`+`e2e` on each.
  Changelog ritual (#131, fragments landed #189): feature PRs that change
  user-visible behavior no longer edit `CHANGELOG.md`'s `[Unreleased]` section
  directly — that was the original #131 ritual, and it conflicted whenever 2+
  such PRs ran in parallel (a routine occurrence with parallel implementer
  agents), either as a merge conflict or a forced re-sync collision under
  `develop`'s strict up-to-date policy. Instead, each such PR drops ONE file
  under the repo-root `changelog.d/` directory, named
  `<issue-or-PR-number>.<category>.md` — or
  `<issue-or-PR-number>-<n>.<category>.md` to disambiguate a second fragment
  about the same number — (category one of Keep a Changelog
  1.1's six: `added`/`changed`/`deprecated`/`removed`/`fixed`/`security`;
  full format in `changelog.d/README.md`) — two PRs adding two differently-
  named files can never conflict. A misnamed fragment (wrong category, no
  number) is never a build error — the build SKIPS it with a console warning
  and keeps going (the guard-asymmetry rule below: a bad fragment costs a
  missing preview line, never a red build). `README.md` itself is skipped
  SILENTLY — `buildFragments` (`app/src/lib/changelogFragments.ts`) `continue`s
  on it before the warning path is even reached, so don't go hunting the
  build log for a line that never appears there; it's the one filename that
  is expected to be present and ignored, not an error case. Either way a
  typo'd filename is invisible in the About dialog's preview, not loudly
  rejected; check the build log or `ls changelog.d/` against the
  filename pattern by eye if a fragment seems to be missing (release runbook
  §2b makes the same check explicit at the fold step). `app/vite.config.ts`'s
  `changelogFragmentsPlugin` reads `changelog.d/*.md` Node-side via `fs` at
  build time (dev server, every `vite build` including the UAT deploy) and
  exposes them through the `virtual:changelog-fragments` module;
  `app/src/lib/changelogFragments.ts`'s `assembleFragments` +
  `withPendingFragments` fold them into a synthetic `[Unreleased]` preview
  `AboutDialog.tsx` merges into the parsed `CHANGELOG.md` release list —
  which is *why* assembly happens at build time rather than only at the
  release cut: UAT (`develop`'s unreleased state) keeps showing pending work.
  Deliberately NOT a `?raw` glob import: that would need widening the
  `server.fs.allow` allowlist (#131's own trap — see the Code-conventions
  bullet on it) on every PR that adds a fragment; a plugin's own
  `fs.readdirSync`/`readFileSync` never goes through the dev-server transform
  middleware that allowlist gates, sidestepping it entirely. A `develop`-side
  CI step CANNOT commit the assembled content back into `CHANGELOG.md` itself
  — `develop` is protected and PR-only — so `CHANGELOG.md` is still only
  ever changed by a human/agent step, now at the RELEASE cut instead of on
  every feature PR: fold each fragment's text by hand into the new
  `## [X.Y.Z] - date` section (grouped under the matching `### Category`
  heading) and update the comparison links at the bottom, then DELETE the
  fragment files (release runbook `.claude/skills/release/SKILL.md` §2b).
  Rolling a NON-empty set of fragments → `[X.Y.Z]` at a cut needs NO test
  edits: `ChangelogView` filters the now-empty `[Unreleased]` and
  `changelog.test.ts` pins only the released TAIL (`versions.slice(-5)`) —
  keep new changelog assertions tail-anchored so a cut can never force an
  assertion edit. **The zero-fragment cut is the one case where that "no
  test edits" claim breaks down** — measured on PR #352's review: an EMPTY
  `## [X.Y.Z]` section (no fragments AND an already-empty `[Unreleased]`,
  the likely v0.8.0 shape) fails `changelog.test.ts`'s "no release section
  may parse to zero entries except Unreleased" assertion (a REQUIRED `app`
  check) and separately fails `release.yml`'s non-empty-notes guard at TAG
  PUSH, after the merge and the deploy. SKILL.md §2b's zero-fragment branch
  is the fix: never create an empty section, hand-derive real entries from
  the milestone's merged PRs (almost always the right call — zero fragments
  usually means the ritual was skipped, not that nothing shipped), or write
  one honest "no user-visible changes" bullet only if that review turns up
  genuinely nothing. Config/tooling/docs-only PRs still add no fragment at
  all (unchanged from the original #131 rule).
  `Closes #N` in a RELEASE PR does NOT close the issue: GitHub auto-closes only
  on merge into the DEFAULT branch, which here is `develop`, not `main` (#132
  stayed open after #210 merged, v0.5.0). Close release-scoped issues by hand at
  the cut, or reference them from a develop-side PR instead.
  The MIRROR trap on the develop side: GitHub's closing-keyword parser has NO
  negation awareness, so a PR-body sentence such as "this PR does NOT close #N"
  auto-closes #N on merge — the disclaimer written to PREVENT the close is what
  triggers it (PR #257 hit this on 2026-07-30 and #211 had to be reopened by
  hand). Keywords are `close/closes/closed`, `fix/fixes/fixed`,
  `resolve/resolves/resolved`; never put one adjacent to an issue reference in a
  PR body or commit message unless you mean it — not negated, not quoted, not
  while explaining what the PR does NOT do (GitHub documents those two places;
  keeping the PR title clean as well costs nothing). Phrase it without a
  keyword ("#N stays open after this PR"); `Refs #N` is the safe reference form.
  VERIFY issue state after every merge (`gh api repos/OWNER/REPO/issues/N --jq
  .state`): the auto-close is silent and nothing in the merge output mentions it. For a
  BODY-triggered close the `issues/N/timeline` `closed` event carried
  `commit_id: null` (measured on the #257 incident), so the timeline did not name
  its cause either; a commit-message-triggered close may instead record a real
  SHA.
  GitHub parses EVERY commit message in the merged range, not just the tip
  commit or the PR body/title — an EARLY commit written before a scope change
  fires just as surely. PR #335 merged with `Refs #319` in its body (both
  body and title were regex-checked, by the implementer and the reviewer,
  and both correctly found zero keywords); #319 auto-closed anyway because
  `c36f865`, the branch's FIRST commit, written hours earlier when the PR
  still intended to
  close #319, ended `Closes #319` and survived a mid-flight descope. The check
  nobody ran: `git log origin/develop..HEAD | grep -iE
  '(clos|fix|resolv)[a-z]*[[:space:]]+#[0-9]+'` — run it before merging,
  especially when a PR's scope changed mid-flight, since the stale intent
  lives in an old commit the body/title check never sees. The commit-vs-body
  timeline discriminator above is what identified the culprit here too: the
  `closed` event carried a real `commit_id`, not `null`.
  Mirror check in the OTHER direction: after a merge that deliberately used
  `Refs #N` rather than a closing keyword because N's specified fix was NOT
  implemented (PR #272, `Refs #216`), verify N STAYED open just as carefully
  as you'd verify the others closed — the auto-close mechanism is silent
  either way, so only an explicit `gh api …/issues/N --jq .state` check
  distinguishes "correctly left open" from "silently closed."
  That check is what caught a further sub-case (#279 → #265): the COMMIT had
  already been corrected to `Refs #265`, but a stale `Closes #265` survived as
  the PR BODY's last line from an earlier revision, and GitHub parses the
  body independently — the merge closed #265 anyway (`commit_id: null` on the
  timeline `closed` event, the same body-triggered signature as above).
  Fixing the commit message does NOT fix the body, or vice versa — an agent
  can truthfully report "changed it to Refs" while the other copy still says
  `Closes`. Before merging, grep the PR BODY ITSELF for a closing keyword
  adjacent to an issue number; never infer its content from the commit
  message or from a report that it was fixed.
- Multiple open PRs: develop in parallel, merge strictly serially — after each
  merge, re-sync the next branch from its base (`git merge origin/develop`, or
  `origin/main` for a hotfix/release PR) and let full CI (~10 min) re-run before
  its merge (the strict up-to-date policy applies on `develop` too).
  `gh api repos/…/pulls/N/update-branch --method PUT` performs that re-sync
  server-side — no local checkout of the branch needed.

## Verification lessons (hard-won)

- A suite that goes green only after its readiness wait is weakened — the
  weakened wait is the finding (#253). While the maplibre-gl 6 worker bundling
  was broken (see the PWA/deploy bullet above), `map.loaded()` could never
  become true, so all 7 `compass.spec.ts` sites had their
  `waitForLoadState('networkidle')` replaced with a bare `installMapHandle`
  check that does NOT require tiles, and the suite reported 15/16 green; the
  single remaining red test (`annotations.spec.ts`'s barb-density test, the
  only one still asserting that anything RENDERS) was written off as
  "structurally unpassable under Playwright Chromium". Both readings were
  wrong — the broken worker was the cause, not the runner. `mapReady()` is
  now a genuinely NEW gate at those sites (there was never a `map.loaded()`
  gate to "restore"), it polls a descriptive string naming the pending
  sources rather than collapsing to a boolean, and it is MUTATION-CHECKED:
  reverting only the one-line `?worker&url` import suffix turns all 7 red
  with `Received: not-loaded (pending sources: protomaps, sc-harbors, …)`,
  so the gate has teeth and the suffix is causally what makes it green.
  Suite is 16/16 in 58.7 s. Durable rule: a lone red test contradicting a
  green suite deserves MORE weight than the suite, not less — and "the test
  runner can't do this" is the conclusion to distrust first. Related:
  `waitForLoadState('networkidle')` was always the wrong
  signal for a map app that streams tiles forever — v6 merely made the latent
  fragility deterministic; a `@playwright/test` bump to 1.62.1 was tested and
  does NOT help.
- Synthetic-mask tests missed a product-blocking solver bug that the FIRST
  real-data browser run found in minutes (#20: step length vs. real channel
  width). UI tasks should end with a real-browser pass (dev server +
  Playwright); routing changes must keep `app/src/routing/realmask.repro.test.ts`
  green (it uses the real committed mask/polars).
- Flensburg→Marstal routes only at safety depth ≤ 2.3 m — that is correct
  data behavior, not a bug (documented in the realmask test; see #9).
- The 5 KNOWN_DISCONNECTED harbors are genuinely unreachable at 46 m cells
  (measured, issue #9: the bridge decks are already deep water; sub-cell
  channels ≤30 m wide are the real barrier) — reconnecting them requires
  fabricating depth; don't attempt without hi-res bathymetry.
- Issue texts are not ground truth for states they don't describe: #31's
  correct wide-float description got misapplied to the narrow layout and
  spread into 5 code sites — verify wording against code before reusing it in
  briefs, comments, or commit messages.
- Review must probe the ISSUE'S GOAL at extremes, not just design compliance:
  the unclipped barb ribbon was implemented and unit-test-pinned exactly as
  designed, yet yielded 0 barbs at harbor-approach zoom on long routes (#36) —
  the design doc itself encoded the bug.
- Mutation-check new tests before trusting them: an "equivalence" test
  deriving expectations from the function under test always passes (#50
  reached reviewer approval with three such false-pass holes, caught pre-merge
  only by a mutation-check lens). Pin literal values recomputed from
  pre-change math; the reviewer re-derives them independently — copying
  current output re-creates the tautology one level up. Corollary: an
  implementer "re-deriving" a pinned literal toward its own implementation in
  a fix wave is the same tautology one step later — the reviewer hand-derives
  the value from the state machine before accepting it (how #145's changed
  backoff literal was validated rather than trusted).
- A mutation battery can pass for the WRONG reason when a test row carries
  MORE THAN ONE trigger for the same expected outcome. A near-miss row meant
  to pin allowlist MEMBERSHIP was written as `xargs npm install < pkgs.txt` —
  the `<` redirect alone already disqualifies the command via the exclusion
  set, so membership was never exercised; a real, metachar-free
  `xargs npm install` would have been silently suppressed with no test
  catching it (#216, `.claude/hooks/notices-nudge.sh`). General form: when a
  row's purpose is to isolate ONE condition, strip every other
  character/construct that could independently cause the same pass/fail.
- CodeQL `js/xss-through-dom` fires as a FALSE POSITIVE on
  `DOMParser.parseFromString(x, 'application/xml')` — its DOM-XSS sink model is
  mime-insensitive, but an `application/xml` parse is inert (no script exec, no
  HTML sink) and e.g. `parseGpx` extracts only numeric coords + enum notices. No
  code change removes it (XML parsing needs DOMParser); dismiss the alert as
  false-positive WITH a linked evidence record, not code churn (#3, alert #9 —
  verified by two adversarial passes + live Chromium PoCs).
- MapView's ATTRIBUTION must keep one anchor per accessible name — a second
  identical `<a>OpenStreetMap</a>` broke plan.spec.ts's strict-mode locator
  (#7); extend the existing anchor's text for new data credits instead of
  adding a link.
- Cross-PR composition bugs are invisible to per-PR review: after the 7-PR
  session-7 train, a 5-lens find → 2-refuter adversarial-verify sweep over
  the CUMULATIVE diff found 3 real bugs (#158/#159/#160) that every
  individual reviewer had correctly approved past. Run such a sweep after
  any multi-PR burst touching shared subsystems; expect refuters to kill
  ~2/3 of candidates — the survivors are load-bearing.
- Enlarging map icons CULLS them below the z12 `icon-overlap` threshold —
  measure BASE vs. HEAD with `idle`-gated `queryRenderedFeatures`, never by
  eye; identical feature counts at z≥12 (`overlap:'always'`) is the signature
  that isolates collision growth from every other explanation (#191, #192,
  fixed by ranking `symbol-sort-key` per R1001 danger content, #200/#225;
  four residuals — z≥12 paint-order inversion, cross-tile ordering, unpinned
  tap wiring, popup anchoring — tracked in #232).
- A green workflow run proves the RUN was healthy, not that the intended
  VERSION of the workflow executed: `workflow_dispatch --ref X` resolves the
  workflow FILE from X's tip. Verify by inspecting the artifact it produced,
  not the run's conclusion (#197 — a post-merge remedy dispatch was a no-op,
  caught only by downloading the baseline and finding `version.txt` absent;
  see the Deploy bullet above for the underlying mechanism).
- Sharper case of the bullet above: a CI poll keyed on the CHECK NAME, not the
  RUN, misreports whenever two workflow runs attach same-named check-runs to
  one commit. Bit TWICE in the v0.6.0 cut. PR #286 (`develop`→`main`) had
  `develop`'s own tip as its head SHA, so the earlier develop-push run's
  finished `app`/`e2e` sat on that commit alongside the PR's own still-running
  ones — a poll matching `name == "app"/"e2e"` + completed declared green
  while the gating run was still in flight. PR #289 (the back-merge) had
  `main`'s tip — also the release tag commit — as its head SHA, so two `e2e`
  successes from two different runs read as "app + e2e" done while both `app`
  jobs were still running. Both times `mergeable_state: blocked` contradicted
  the poll — that disagreement is the cross-check, not a fluke
  (`mergeable_state` is also the merge-time tell in the #119 note under
  Working style). Fix: key the poll on the RUN, not the name — `gh api
  repos/OWNER/REPO/actions/runs/<id>/jobs` — and when a SHA might carry more
  than one run, select it explicitly rather than assume there is only one;
  the release skill's §5b already does this, picking the newest
  `event == "push"` run for the same reason. The v0.7.0 cut hit BOTH
  configurations again and both were caught by keying on explicit run IDs
  rather than check names: the `develop`→`main` release PR carries develop's
  own tip as its head SHA (the last feature merge's push run sits on that
  commit alongside the PR's own); the back-merge PR carries `main`'s tip,
  which is ALSO the tag commit — TEN runs on that one SHA at v0.7.0:
  main-push CI + CodeQL + Python lint + Mask integrity + the CANCELLED
  main-push Deploy, the tag's Deploy + Release, and the back-merge PR's OWN
  CI + CodeQL + Labeler. `CI` and `CodeQL` each appear TWICE, and that
  duplication IS the trap — two `CI` runs attach two sets of `app`/`e2e`
  check-runs, exactly what a name-keyed poll cannot separate. Rule:
  enumerate `gh api
  repos/OWNER/REPO/actions/runs?head_sha=<sha>` and monitor each relevant run
  ID explicitly — never poll by check name alone.
- A test fake that settles eases INSTANTLY makes interruption bugs
  structurally unreachable, not merely unasserted — camera-guard tests need a
  fake modelling `_stop`→`_afterEase`→`_prepareEase` ordering (#155).
- A verification method that structurally cannot see a regression class will
  report green through it. Three separate cases in one day:
  `queryRenderedFeatures` counts are order-independent, so a per-family
  count check is blind to paint-order inversion (#200); jsdom stubs
  `offsetHeight`, so a hidden-element measurement bug is unreachable in unit
  tests (#208); a camera fake that doesn't model `map.resetNorth()` cannot
  show a settle that never arrives (#203). Ask of any green result: *what
  class of failure can this method not detect?*
- A fix INHERITS its bug's blind spot. #233's hook fix drew six Blockers over
  two rounds, and all three of round 2's were the same mention-vs-invocation
  class the fix existed to close, now living inside the fix itself; #228
  produced four cascading z-index regressions, each caused by the previous
  fix. Re-run the ORIGINAL defect class against the new code, and treat a
  passing selftest table as proof only of the shapes it lists.
- `Object.is(-0, 0)` is `false`, and Playwright's `toBe` uses `Object.is`. A
  counter-rotating needle rounds a −0.11° residual to `-0` and fails
  `toBe(0)` intermittently — MapLibre's camera lands 0.04–0.18° short after a
  drag-rotate about half the time. Normalise with `+ 0` (`-0 + 0` is `+0`;
  every other double is bit-identical) (#203).
- CITATION HALO: verifying one citation from source lends borrowed
  confidence to adjacent "tightening" edits made from memory, which then get
  reported as verified too. After correcting any citation, re-check EVERY
  other citation in the block (#200 — §2.7.1.2 was "tightened" into being
  false; §2.7.1.1 was correct all along).
- MapLibre glyph loading has NO observable failure signal by design:
  `GlyphManager._downloadAndCacheRangePromise`
  (`app/node_modules/maplibre-gl/src/render/glyph_manager.ts`) catches EVERY
  glyph-range fetch failure and falls back unconditionally to a
  locally-drawn TinySDF glyph — the symbol is still placed, so
  `queryRenderedFeatures` returns identical counts and names whether glyphs
  are real or 100% broken, and `map.on('error')` never fires because nothing
  re-throws. The only signal is a `console.warn` matching `"Unable to load
  glyph range"` at `glyph_manager.ts:144`. Separately,
  `_getAndCacheGlyphsPromise` (`:104-108`) takes a COMPLETELY silent
  local-font path — no fetch, no warning — whenever the style's `glyphs` URL
  is falsy, and `glyphManager.setURL()` is fed from the style's `glyphs`
  field at two sites in `style.ts` including the style-DIFF path (`:491`)
  that `styleReload.ts` exercises on every `styledata` re-add. `glyphs` is
  documented OPTIONAL in the maplibre style spec, so nothing upstream flags
  it. A label-render test needs THREE signals — a rendered-feature check,
  the zero-warnings check, and a timing-independent assertion that
  `map.getStyle().glyphs` matches the expected template — `app/e2e/labels.spec.ts`
  (#320, PR #375) does this; its header documents that the rendered-feature
  check LICENSES the zero-warnings assertion (an absence assertion carries
  no information until the evidence-generating process is established to
  have run) and must not be deleted as redundant.
- Never source an integer-exact claim (line number, byte count, version
  string) from a summarizing fetch — `WebFetch`/`WebSearch` paraphrase, and
  a paraphrased integer is silently wrong rather than obviously wrong. Read
  it from the installed artifact directly (`grep -n` on
  `app/node_modules/...`). `maplibre-gl` ships its full TS source locally
  under `node_modules/maplibre-gl/src/` — checking only the bundled
  `dist/*.js` and then reaching for the network is the wrong reflex when
  the exact source is already on disk. Same failure as CITATION HALO above,
  one level up: borrowed confidence from a tool that looked authoritative
  instead of from an adjacent verified edit (#234).
- A Playwright `expect.poll` predicate that returns a BOOLEAN discards the
  diagnostic. `return deg >= 330 || deg <= 30` + `.toBe(true)` can only report
  `Expected: true / Received: false` plus a timeout — and a Playwright timeout
  means BOTH "too slow" and "never going to happen". #243's relocated dogleg
  made the readout `045`; the predicate computed that number and threw it away,
  costing a 9-agent root-cause hunt for a value that would have been in the CI
  log. Poll the VALUE, assert the condition on it. Sibling of the blindness rule
  above: a method that structurally cannot SEE a regression reports green
  through it, and a method that cannot DESCRIBE a failure reports it uselessly.
  Ask of any assertion: at 3am in CI, does the message name the actual value?
  (#252 tracks auditing the remaining specs.)
- A metric compared against an INFEASIBLE baseline is worse than no metric —
  it reads as a defect and points every downstream fix the wrong way. #264's
  "32.9% detour vs chord" was real travelled distance measured against a chord
  that crossed LAND (`chordNavigable@3m=false`, printed on the same output
  line and not read). It survived a root-cause writeup, a filed issue, and two
  proposed fixes that would each have made the boat SLOWER; only an ETA
  comparison against a navigable alternative caught it. Sibling of the
  blindness rules above, one level earlier: before asking whether the
  measurement can see the failure, ask whether the thing it measures AGAINST
  is reachable at all. The tell was already in the log.
- **Prose rots in FOUR distinct ways, and a sweep aimed at one misses the
  others** (#298/#300, where 8 findings were prose-accuracy defects):
  OVER-CLAIMING (a header saying "EVERY way this can fail" with three paths
  missing); STALE (true when written — a `1.25` clearance figure after its
  stroke widened 1.5→3); WRONG-FROM-THE-START (`29 category` where the table
  always held 30 — a staleness sweep asks "did the code move under this?", NOT
  "was this ever true?", so it structurally cannot find these); and SAME-PR
  INVALIDATION (a statement reporting a derived measurement whose inputs live in
  a DIFFERENT HUNK of the same diff — invisible to CI, which executes no prose,
  and to hunk-by-hunk review, where each hunk is individually correct and only
  the pair is wrong). **A sweep cannot see a class it is itself an instance
  of**: the sweep ordered for staleness produced two fresh same-PR instances
  (the CHANGELOG moved to 51 while its code-comment twin stayed at ~45). So the
  remedy is NOT "sweep harder" — it is TWIN SEARCH (state each fact in two
  artifacts — test↔source, comment↔CHANGELOG, comment↔PR body — and check they
  agree; redundancy is a smell in code and a CORRECTNESS CHECK in prose, which
  has no compiler, so the second copy is the only thing playing that role) plus
  QUOTE THE METHOD, not only the result (`(w/2)·sin45°` survives a constant
  change and can be run BACKWARDS to find a better fix; a bare number cannot).
  A negative report — "I re-read everything and found nothing" — is
  unfalsifiable from outside: spot-check 2–3 claims naming a NUMBER or COUNT,
  which are the falsifiable ones. CHANGELOG prose gets the SAME evidentiary
  standard as code, never a looser one: it is baked into the About dialog at
  build time, so an overstated figure ships to users and freezes into a
  versioned section at the next cut (a "~45 marks" claim overstated a fix's
  reach by 4×). PATCHING instances a reviewer happens to find does not
  converge: in the v0.7.0 session one fact (where the tag-signing work was
  tracked) was stale across SIX artifacts and took four correction rounds,
  each fix landing while a different artifact stayed wrong. What worked was
  ENUMERATE, not patch — `git grep -n` every reference to the moved fact
  repo-wide, then classify each hit as a TRACKER claim (asserts where the
  remaining work lives — must move) or a HISTORICAL reference (names the
  issue some already-shipped work happened under — stays as-is). Report the
  enumeration as a table INCLUDING the hits left alone; that table is the
  only evidence there is no seventh instance. The same failure has a CODE
  form: nine test files carry `vi.setConfig({ testTimeout: 120_000 })`; PR
  #335 patched only the two that had failed in CI, and the next run failed on
  a third with the identical shape, at ~43 min per round to learn it (#342).
  `git grep` the pattern first, then centralize it behind one constant plus a
  structural guard — a per-file patch converges one CI run at a time.
- A FABRICATED citation is worse than a wrong number — it launders the claim
  as verified and stops the next reader from checking, compounding the
  CITATION HALO risk above. Two shipped in one PR this session: a comment
  invented "CLAUDE.md's documented 6-10x runner-speed ratio" (no such phrase
  exists; the real measured figures are ~2.1x plain / ~2.5x coverage
  documented above, and are separate multipliers for the vitest UNIT suite,
  not Playwright), and a test header misattributed a `symbol_bucket.ts:391`
  claim to CLAUDE.md when it came from that PR's own review. Both were found
  only because the reviewer was asked to ENUMERATE every citation in the diff
  and name where it looked, not to fix the one instance flagged — patching
  flagged instances does not converge; enumerate and report the enumeration
  including hits left alone (same methodology as the prose-rots bullet above).
- Never promote a subagent's COMPARATIVE ADJECTIVE into a durable claim without
  reading the raw numbers it summarises. #264's agent wrote a uniform field
  "weaves IDENTICALLY"; its own cited output showed 5 turns ≥45° vs 2-3, 26 legs
  vs 14, ~9 min of ETA — *differently*. That one word travelled into a CLAUDE.md
  rule and a spec retiring a documented evidential gap with "do not re-open it",
  and was caught only by a review told to audit for OVERSTATEMENT specifically.
  "Not necessary for X" and "irrelevant to X" are different claims and the second
  is far stronger. Cheapest guard: when a finding will become a durable
  instruction, brief the reviewer to check claim STRENGTH against the evidence,
  not just claim correctness — and prefer "narrowed" to "closed" unless the
  measurement really covers the whole space.

## Domain rules that are easy to get wrong

- **Navigability is decided at query time** (`cellDepth >= safetyDepth`), not
  baked into the mask — safety depth (default 3.0 m; boat draft 2.1 m) is a
  user setting and must never require regenerating data.
- **Wind grids are stored with each plan** (IndexedDB). A saved route must
  always render against the forecast it was computed from, never a re-fetched
  one.
- **Tack/gybe minimization is not a separate pass**: it emerges from the
  maneuver time penalty (default 45 s) inside the isochrone cost. Don't add a
  post-hoc "tack reducer" that can violate wind/depth constraints; the only
  allowed post-processing is merging near-collinear legs with re-validation.
- **The router runs twice per plan** (genoa polar, fock polar) and recommends
  the faster rig. Both results are user-visible.
- **Motor legs are first-class**: planned where sailing speed falls below the
  SAIL-SPEED FLOOR `max(motorThresholdKn, motorSpeedKn - sailPreferenceKn)`
  (defaults 2.5 / 6.5 / 2.8 → floor 3.7 kn), run at motor speed, always flagged
  as motor. Computed ONCE per solve in `isochrone.ts`, never per candidate.
  The engine is a term in the time optimisation, not a fallback — that is a
  deliberate product position (#254), and the margin is what bounds it: any
  heading left sail-locked satisfies `sailSpeed >= motorSpeed - margin`, so the
  margin is a hard upper bound on how much boat speed a sail-locked heading can
  be losing. Only `margin = 0` is fully hole-free. `motorThresholdKn` SURVIVES
  underneath the `Math.max` as the seaworthiness floor — without it a
  user-lowered `motorSpeedKn` (settable to 1 kn) would yield motor legs SLOWER
  than sailing; a margin at or above `motorSpeedKn - motorThresholdKn` (4.0 at
  defaults, and it MOVES with `motorSpeedKn` — never hardcode it) collapses the
  floor back and restores the pre-#254 path byte-for-byte.
  3.7 is MEASURED, not chosen: window [3.7, 3.8] is the only band that closes
  the light-air weave on BOTH rigs while leaving TWS 9 entirely under sail, and
  3.8 lost on a 2.5-SECOND rig-recommendation knife-edge (#259). Floor 3.5 is
  the trap — it saves 32 min while making max motor turn 135°, WORSE than the
  100° it was meant to fix: time saved is not weave closed, and the
  discriminating metric is the reversal count, not the turn maximum.
  ACCEPTED COSTS, do not re-litigate: marginal air moves to engine (synthetic
  uniform TWS 6 goes all-sail → 83% motor); the floor has a knife-edge wherever
  it sits (a measured 3.699 kn leg motors against a 3.700 floor). EVIDENTIAL
  GAP — every cell measured on UNIFORM wind fields, so TWS-gradient behaviour
  untested — is NARROWED, NOT CLOSED (#264, one real Open-Meteo forecast).
  What is established: a gradient is NOT NECESSARY for a weave, because a
  uniform TWS-4 field weaves too — so a weave alone does not implicate the
  gradient. What is NOT established: that gradients are harmless. The same
  comparison shows the gradient field weaving DIFFERENTLY — 5 turns ≥45° vs
  2-3, 26 legs vs 14, ~9 min of ETA — so the gradient demonstrably shapes the
  result even though it does not cause it. One route, one forecast; treat
  gradient behaviour as still open. That gap was also
  why the per-TWS "blanket motor" alternative was REJECTED (it is discontinuous
  in TWS, replacing a heading-space hole with a wind-space cliff a real forecast
  crosses hourly, and it preserves today's 309-heading hole rather than the
  sailing). Spec: `docs/superpowers/specs/2026-07-30-motor-decision-rule-design.md`.
- **A reported motor "zigzag" is usually the router MOTOR-TACKING around a
  sail-locked heading band, and it is FASTER — do not fix it** (#264, §8.6 of
  the motor spec). The floor is a hard threshold on sail speed, so one wind cell
  splits the compass into alternating motorable and sail-locked arcs: at
  TWS 3.777 / wdir 30.4°, genoa motors at 60-89°, is SAIL-LOCKED at 3.76-4.01 kn
  across 90-129°, and motors again at 130°+. A course falling inside a
  sail-locked arc is best served by tacking under engine around it — 85.4° and
  141.8° each make 5.728 kn VMG along 113.6°, 44% more than steering it. Measured:
  the weave beats the direct chord by 98-527 s per joint, no heading in a
  0-355° step-5 sweep beats it at any of 10 joints on either rig (a one-ring
  node comparison on progress-to-destination — local optimality, not a full
  path-cost proof), and on the reported route the chord is not even navigable
  at 3.0 m. A motor-turn penalty and a
  heading-continuity tie-break were both evaluated and are COUNTER-PRODUCTIVE
  (each forfeits those seconds by steering the slower sail-locked heading), and
  `better()` cannot arbitrate anyway — prune cells are ~223 x 192 m while a
  motor step is ~2006 m, so the candidates land in different cells and are never
  compared. Before calling any weave a defect, measure its ETA against a
  NAVIGABLE alternative: the 32.9% "detour" that opened #264 was real distance
  measured against a chord that crossed LAND.
- **No-route `reason` is a CONTROL INPUT, not just a status label** (#282,
  open): `needsUnpreferencedRetry` (`planRoute.ts:67-71`) branches on
  `r.reason === 'unreachable' || r.reason === 'beyond-horizon'`, and the #53
  relaxation gate (`planRoute.ts:273`) branches on `reason === 'unreachable'`
  (plus a depth-floor guard). So ANY change to no-route classification —
  including a strictly more accurate one — changes which retry tiers run and
  can return a SLOWER route, not merely a differently-labeled one. Measured
  against a candidate reclassification patch that was REVERTED and never
  merged — these are not reproducible from current `develop` — on a
  Flensburg→all-harbours sweep (uniform TWS 3/dir 0, motor off, real
  mask+polars): Bagenkop +515.2 s, Wackerballig +499.4 s, Gelting-Mole
  +353.2 s, while 11 of 14 plans stayed byte-identical — which is what made it
  easy to miss. Still OPEN; treat any reason-classification change as a
  routing-behavior change needing the same sweep, never a labeling-only fix.
- `NavMask.segmentShallowestBelow` returns `null` for BOTH "no cell below the
  threshold" AND "the walk left the grid / tripped its iteration guard" — it
  cannot distinguish clear water from no coverage. Anything that renders a
  safety state from it must bound-check both endpoints against the public
  `mask.meta` rectangle FIRST; only then is a `null` trustworthy as "clear"
  (#251/#255 — reversing those two steps is a silent false all-clear, and the
  natural-looking implementation is the wrong one).
- Angles: wind direction is meteorological (coming FROM, degrees true);
  polars are TWA × TWS → boat speed in knots. Positions are WGS84.
  Distances in nautical miles, speeds in knots.
- The map scale bar is deliberately THREE-unit (nautical miles ≥1 NM, cables
  0.1–0.5 NM, round metres <0.1 NM) — the nautical-miles-only rule above
  governs route/leg distances, not chart chrome. Rungs are picked in the unit
  being LABELLED — which is what makes every rung an integer by construction
  and keeps bar width in 40–100 px, pinned to `MAP_MAX_ZOOM` (#155).
- **Two wind-sampling clocks by design**: map barbs sample the plan's grid at
  the SLIDER hour; the depth profile samples each instant's OWN hour (the map
  is a moment, the profile is a timeline). Don't "unify" them.
- Depth byte 254 is reserved but never emitted (the pipeline folds ≥25.4 m
  into byte 255) — `depthInfoM().capped` is the only honest "≥25 m"
  discriminator; never infer the cap from `depthM === 25.4`.
- Seamark symbology authority: IALA R1001 Ed 2.0 (2022) §2.2 / Tables 5–6
  (cardinal marks are region-independent). Glyph changes are visually
  verifiable by capturing the REAL `registerSeamarkImages` output through a
  fake `map.addImage` on a dev-server scratch page (4× nearest-neighbor) —
  the #165 evidence technique; hand-derive expected geometry/colours from
  R1001, never from the renderer's own output. The glyphs themselves are fixed
  hand-tuned constants (`ISOLATED_DANGER_SPHERE_CY` et al.) — there is NO
  runtime band search; what enforces topmark/body clearance is the TEST helper
  `separation()` in `seamarkGlyphs.test.ts`, and it takes the LOWEST empty
  band, never the WIDEST (#298): for a multi-part topmark (isolated danger's
  two spheres) the widest band can be INTERNAL to the topmark, so the check
  passes while the topmark merges into the body. The lowest band is always the
  topmark/body boundary because bodies cannot contain an internal gap —
  `bandSegments` tiles the box with zero clearance and `bodyOutline` insets 0.5
  INSIDE — and it also fails closed, where widest-band failed open.
- **German seamark terminology: the REFERENT decides the word, not attestation
  rank** (#300). Check the SHIPPED DATA first — `clearing`/`leading` occur only
  on `beacon_special_purpose`, i.e. S-57 **CATSPM (a MARK)**, never CATNAV (a
  line), so a line noun is definitionally wrong however well attested.
  `Deckpeilung` is better attested than the shipped `Gefahrenpeilung` and was
  rejected anyway: it names the transit METHOD shared by clearing AND leading,
  so it cannot distinguish them. **TRAP — pin the EDITION, not the URL**: BSH's
  INT-1 pairing `Deckpeilung / Clearing line` is genuine on p.1 of the ©2013
  legend but ABSENT from the re-laid-out edition served at the same bsh.de URL
  today, so a correct citation re-verifies as a fabrication (a researcher and a
  reviewer contradicted each other over exactly this and neither had erred).
  The popover renders Typ and Kategorie as SEPARATE ROWS, which is what lets a
  bearing/area noun sit in the category row. Every disputed value carries its
  considered-and-rejected alternatives in-code — read them before changing one.
- Open-Meteo is called directly from the browser (CORS is open, no API key).
  There is deliberately **no backend** — do not introduce one.
- **AIS (#25) is BYOK and must stay inert without a key**: no `aisApiKey` → no
  client, ZERO sockets (the network-free e2e suite depends on this; never add
  a default key or eager connect). aisstream.io signals an invalid key as bare
  1006 closes with NO error frame — `aisStream.ts` promotes 3
  subscribed-but-silent closes to terminal `keyError`, permanently disarmed
  once a connection survives `AIS_AUTH_STABLE_MS` (30 s, `keyProven`); a key
  revoked mid-session degrades to honest capped-backoff "connecting" BY
  DESIGN — don't "simplify" the stability timer away. Per-second AIS data
  follows the `useOwnshipGps` rule (target Map in a ref, ≤1 Hz publish, never
  AppState); the 6-min projection geometry lives only in
  `lib/projectionVector.ts` (`projectionLine`, shared with #141) — never
  inline it.

## Working style for this repo

- Planning requires network; everything else must keep working offline. Any
  new feature that silently assumes connectivity is a bug.
- The app is a passage-planning aid, not a navigation device — user-facing
  copy must not claim chart authority.
- UI strings always go through the i18n dictionary (de/en), never hardcoded.
- Implementation work goes through the `.claude/agents/` defs: spawn a FRESH
  `sail-implementer` per task (never reuse across tasks); one persistent
  `sail-reviewer` per PR for the fix→re-review loop, retired at merge.
- If a session's OWN directives contradict that orchestrate-first mode, NAME the
  conflict in the FIRST response and ask which governs — never silently comply
  with either side. Silently obeying the restriction cost a full docs sweep plus
  a ~15-call browser walkthrough of main-session context (2026-07-27); durable
  enforcement (SessionStart hook or skill) tracked in #211.
  EXCEPTION — one case is SETTLED; do not re-raise it. A session-level "do not
  call the AgentTool / do not use workflows or deep-research unless the user
  requested it" is a hardcoded FALLBACK constant inside the Claude Code binary,
  emitted when a server-side value is empty. It appears in no user file, no
  project config, no shell alias and no environment variable — so there is
  nothing local to change, and the mechanism is Anthropic-side: never patch it
  or engineer around it. Verified against Claude Code 2.1.220 on 2026-07-30 —
  re-check if the harness version changes. This repo's orchestrate-first mode
  governs: delegate normally and spend no turn arbitrating it. Escalate only a
  contradiction from a genuinely NEW source — something a human or a project
  actually wrote.
- **Right-size agent models per task** (reinforces the global fitness rule): PIN
  the model when spawning — `sonnet` for standard/mechanical implement + review +
  docs; reserve `opus`/the heaviest tier for safety-critical or judgment-heavy
  work (design, adversarial correctness/safety verification, hard solver work);
  `haiku` for pure transcription. Do NOT let mechanical implementers/reviewers
  inherit the session's heavy model by default.
- `offline-pwa-reviewer` is CONDITIONAL, not always-on: invoke it ONLY when the
  change set touches a PWA path (`app/src/sw.ts`, glyph cache/warmup,
  `basemapSource.ts`, Vite PWA config, IndexedDB, offline); non-PWA PRs must NOT
  spawn it (#181). When invoked it runs ALONGSIDE `sail-reviewer`, never in
  place of it.
- Issues carry a label taxonomy — `type:` (bug/feature/chore/docs) + `priority:`
  (high/med/low) + `area:` (routing/map/pwa/pipeline/deploy/ais/tooling) +
  optional `status:` — and a milestone (`v0.4.0`/`v0.5.0`/`Backlog`/`Icebox`);
  apply type+area+priority to every new issue. Taxonomy documented in
  CONTRIBUTING.md (#167/#168).
- Design a guard around its ASYMMETRY: a BLOCKING guard should fail closed, a
  NUDGE should fail open. #233's command segmenter exits 0 while emitting
  confidently-wrong segments, so its fail-closed path covers none of its
  actual failure modes — the real risk was wrong output, not a crash. When a
  guard's two failure modes cost very different amounts, make OVER-firing the
  default and suppress only provably-safe shapes; a parser bug then yields
  noise, never silence.
  **A liveness check must live OUTSIDE the thing whose liveness is in
  question** — a script that cannot run cannot report that it cannot run. #274's
  guard therefore tests `[ -f "$H" ] && [ -x "$H" ]` at the `settings.json` call
  site and emits its own `ask`: `-x` ALONE is true for a DIRECTORY, whereupon
  `exec` dies 126 emitting nothing, and a non-blocking hook error lets the write
  proceed. That fail-open class relocated FOUR times inside one PR (deny list →
  extraction → empty stdin → the liveness check itself) and not one instance was
  found by reading — all four by constructing the failing input and running it.
  A guard's deny list also fails open by construction: prefer directory-shaped
  matching with explicit narrow exemptions, and never drop a "redundant" pattern
  because of what today's tree happens to contain.
  `.claude/hooks/wind-fixture-guard.sh` (#235, PR #333) — the wind-fixture
  guard, extracted from `.claude/settings.json` into a standalone script with
  `--selftest`. It fails CLOSED where the old inline form emitted nothing:
  empty/malformed/absent stdin, a missing or failing `jq`, and an unavailable
  or non-repo `git` (verified across 15 constructed failure inputs).
- The destructive-git guard pattern-matches `-f` anywhere in a compound command:
  never combine `gh api -f …` with `git push` in one Bash call — split them.
  It lives OUTSIDE this repo (`~/.claude/hooks/guard-destructive-git.sh`,
  global/personal, unversioned, shared across concurrent sessions) — NOT
  covered by #216, which is the notices-regen/graphify-nudge hooks; #233
  audited this guard specifically and declined to touch it. Observed but
  NOT confirmed as a mechanism: a Bash call was blocked while drafting a
  heredoc whose PROSE merely mentioned the force flags with no git command
  invoked, and separately a command containing `gh api -f` was blocked —
  the precise trigger for the second case is unconfirmed (a reviewer could
  not reproduce it in isolation). `--raw-field` avoided the block in
  practice; treat that as an observed workaround, not a documented fix. A
  recommended fix, and the note that `reset --hard`/`clean -f` share the
  same shape, are recorded in PR #233's body for the maintainer to apply —
  it's their global config, not something a repo PR can change. Two more
  observed false positives (2026-08-03), both on ordinary text rather than
  any force operation: the repo's own new `.claude/hooks/wind-fixture-guard.sh`
  (a literal `-f` at the `wind-`/`fixture` junction) and flags like
  `cut -d= -f2`. Both blocked a read-only agent twice. These are a narrower
  shape than the heredoc-prose case — `-f` inside a longer word or a longer
  flag is not `-f` as a TOKEN, so exact-match on the argument would fix them
  without the parser PR #233 was closed over. Still out of repo scope (#236).
- PR review threads via API: send bodies containing backticks as JSON `--input`
  files (double-quoted shell interpolation mangles them); inline comments 422
  outside diff hunks — anchor to in-diff lines, put out-of-diff findings in a
  PR comment. `.claude/skills/pr-selfreview/resolve-threads.sh` (#178, PR
  #329) batches the reply+resolve loop: it paginates `reviewThreads` on
  `hasNextPage`, re-enumerates fresh at the end, and exits non-zero if any
  thread is still open.
- Completed worktree agents CAN be resumed for fix waves — SendMessage to the
  same agent re-loads its transcript with worktree + branch intact (verified,
  #111 round-1 fixes); a FRESH agent pointed at the surviving worktree is the
  fallback.
- Agent stall patterns (session 7, 6/6 recoveries): an implementer that stops
  "waiting on an armed watcher/monitor" while its notification shows NO live
  background children is asleep forever — nudge it to check the result in the
  FOREGROUND; a reviewer that idles with zero PR activity may have WRITTEN its
  report without SENDING it — check the PR's reviews/threads first, then nudge
  once. A further reviewer variant: several this session POSTED their review
  to the PR correctly and then went idle WITHOUT sending the summary back — a
  clean review leaves nothing new on the PR to read, so that silence is
  indistinguishable from a check that never ran. Read the verdict from the
  PR's reviews/comments artifacts FIRST; nudge only if genuinely absent.
  Worktree cleanup ritual: agent runs `find app/node_modules -delete`
  (`rm -rf` is permission-blocked even in the main session; `find -delete` is
  allowed), then the main session runs `git worktree remove` — force-free. Parallel
  implementers: assign distinct dev ports; retry e2e on EADDRINUSE; the shared
  Playwright MCP browser is contested — verify the URL before every screenshot.
  A poll loop on a known-slow job that keeps reporting "no change" is pure
  overhead — poll for the TRANSITION, not the state.
  2026-08-03 refinement: when an agent reports "waiting on a background task"
  and that report ARRIVES AS an idle notification, the two contradict each
  other — the notification fires only when the agent has no live background
  children. Nudging does not fix it (one implementer stalled four times on
  the same step, rationalising the wait differently each time). After the
  SECOND stall, TAKE the watch: arm the monitor in the main session and hand
  the agent the result. The orchestrator holds the watch; the worker holds
  the code.
- BRIEFS ARE WRONG SOMETIMES — say so in the brief, and reward the pushback.
  In one session an implementer refused to build the shell parser its brief
  asked for (#235 is the false-POSITIVE direction, unreachable by globs, and
  PR #233 was closed for exactly that road) and split the scope instead; another
  measured that a reviewer's suggested `cdp.detach()` tears down the geolocation
  override with the session, and took the alternative the same comment offered.
  Both were right, and neither would have surfaced from a brief demanding
  compliance. Tell agents to report a contradiction with evidence rather than
  implement around it — and verify the pushback yourself against the issue text
  before accepting it, since the brief's author is usually the one who is wrong.
- Every self-review here posts as `COMMENTED`, not `APPROVED` — GitHub rejects
  approving your own PR and the `gh` token owns them all. That is expected, not
  a bypass: `protect-main` requires `app` + `e2e` and RESOLVED THREADS, never a
  second party's approval. Don't let an agent retry it as an approval, and don't
  read a COMMENTED self-review as an unreviewed PR.
- Brief reviewers to POST the review to the PR BEFORE reporting back. Three
  reviewers in one session wrote thorough reviews and reported them without
  publishing, leaving PRs looking unreviewed — which also erases the
  code-review evidence OpenSSF criteria depend on. Check the PR's
  `reviews`/`comments` artifacts, not the agent's claim.
- When relaying a CI failure to an implementer, paste the RAW assertion
  output, never a paraphrase — a paraphrase discards the diagnostic. A `-0`
  root cause was in the log as `Received: -0`, got dropped from a summary,
  and the assertion's wording then pointed at the wrong suspect entirely
  (#203).
- When the session's OWN cwd is a worktree, `isolation:worktree` agents and
  un-isolated reviewers can SHARE it rather than get a separate tree — a reviewer
  that checks PR code in for a RED-check leaves those changes for your next
  `git commit` to silently absorb. Always `git show --stat <sha>` before trusting
  a commit's file list (a new-file addendum must be 1 file, insertions-only), and
  stage explicit paths — never `git add -A`.
- Agents pointed at the MAIN checkout can edit a file BETWEEN your Read and
  your commit (the #140 plan absorbed a half-applied edit exactly that way) —
  diff the content you are about to stage against what you reviewed, and
  stand writers down from shared trees once their deliverable is handed over.
  Reviewer verification worktrees must be cleaned up by their CREATOR
  (untracked `node_modules` blocks `git worktree remove`; `rm -rf` can be
  permission-blocked in the main session) — brief reviewers to remove their
  own worktree or verify without a local install.
- Spec edits (`docs/superpowers/specs/`) go through the main session only (the
  ask-gate hook must prompt the user) — never through subagents. Use the
  Edit/Write tools for them: the hook does not match Bash appends (`cat >>`),
  which silently skip the user prompt.
- `.superpowers/` (SDD ledger) is gitignored — append session records
  directly, no PR needed.
- **Claude Code config placement**: shared config is COMMITTED — `.mcp.json`
  for MCP servers (secrets via `${ENV_VAR}` interpolation, never hardcoded),
  `.claude/settings.json` for shared hooks/plugins/permissions; personal +
  secret + machine-specific config goes in gitignored
  `.claude/settings.local.json`; global `~/.claude/` is personal cross-project
  only. Never commit secrets (AIS BYOK stays runtime-supplied). Full convention
  in CONTRIBUTING.md (#185).
- `gh pr edit` hits the Projects-classic GraphQL bug like `gh pr view` —
  update PR bodies via `gh api repos/…/pulls/N --method PATCH --input body.json`.
- `gh api graphql -F body=@file` posts the FILE as the body of a form field
  named `body` (not the GraphQL `query`), so it fails with "A query attribute
  must be specified" — that half of the old note here was right. But
  **`--input` DOES work for `gh api graphql`**, backticks included — the old
  advice to inline the string instead was wrong and steered straight at the
  shell-quoting hazard the note exists to prevent. Verified directly (PR #329
  fix-wave review, finding #5):
  `gh api graphql --input file.json` → `{"data":{"viewer":{"login":"DocGerd"}}}`
  exit 0, including with a backtick inside a variable value → exit 0; `gh api
  graphql -F body=@file.json` → `"A query attribute must be specified"` exit 1.
  Use a JSON `--input` file for any GraphQL call carrying a body with
  backticks (e.g. a review-thread reply) — `--input` is the PREFERRED form,
  not a REST-only fallback.
- GitHub links a code-scanning alert to an issue only when the alert URL
  appears as a TASK-LIST item (`- [ ] <url>`) in the issue body — a plain
  markdown link does nothing, and the REST alert object exposes no tracking
  field, so the link can't be confirmed via API either; write it as a
  checklist line if the link needs to exist at all.
- Bash cwd PERSISTS across calls — a `cd` into a scratchpad earlier in the
  session makes a later `gh pr merge` fail with "not a git repository", and
  per the #94 rule below that failure could still have landed the merge, so
  verify before retrying rather than assuming the error means nothing
  happened. Prefer `gh pr merge N --repo DocGerd/sail_command` so the command
  doesn't depend on cwd at all. It bites TWO more things that give no hint about
  cwd: spawning an `isolation: worktree` agent fails with "Cannot create agent
  worktree: not in a git repository" (worktree creation resolves from cwd), and
  `git worktree remove <abs-path>` fails "not a git repository" even though the
  path is absolute. `cd /home/pkuhn/sail_command` before any worktree or merge
  operation; a heredoc-heavy `python3 - <<PY` block earlier in the session is
  enough to leave you somewhere else.
  Quieter variant: with `--repo` the MERGE succeeds but the
  `premerge-verify.sh` guard degrades. It resolves the repo with a bare
  `gh repo view` (cwd's git remote) and never parses `--repo` from the command,
  so a stale scratchpad cwd makes it emit `ask` ("could not resolve owner/repo")
  every time — and a guard that always asks trains you to click through,
  eroding the #119 protection it exists to provide. `cd` back to the repo before
  merging; the durable fix is to have the hook parse `--repo`/`-R` or run
  `gh repo view` against `$CLAUDE_PROJECT_DIR`, which it already uses for its
  branch lookup.
- A GitHub **504 during `gh pr merge`** can land the merge (base ref updates,
  merge commit created) yet leave the PR marked `open` and skip branch-delete /
  `Closes #` auto-close. VERIFY via the develop tip / merge-commit parents before
  retrying — never blind-retry (you double-merge or get a confusing `behind`);
  reconcile a stuck-but-merged PR by closing the PR + deleting the branch +
  closing the issue manually (#94).
- Before ANY merge: verify the PR's `head.sha` equals the SHA you pushed AND
  that check-runs exist for that exact SHA — PR #119's head stuck on a stale
  SHA after a push (dropped `synchronize` webhook), so all-green checks +
  `mergeable_state: clean` described the PRE-fix commit; merging would have
  silently dropped the fix. REST close→reopen resyncs the head but fires TWO
  `pull_request` events whose shared concurrency group can cancel the fresh
  run's jobs — cancel the stale-SHA run first (verify `.head_sha`), then
  `POST …/actions/runs/<id>/rerun` (#119). `mergeable_state: unstable` = only
  OPTIONAL checks red — mergeable (required checks are `app`+`e2e` only);
  scorecard's `analysis` job reds EVERY push to `main` by design
  (default-branch-only action, #124), so release commits carry one cosmetic
  red check-run — don't chase it.
- e2e's preview port is fixed (4173 in helpers.ts): full e2e runs from
  parallel worktrees contend — serialize them; per-agent dev ports are for
  manual browser passes only. The dirty wind fixture (see E2E section) also
  blocks `git worktree remove` — restore before removing; never `--force`.
- IDE/LSP diagnostics emit bogus cannot-find-module bursts when worktrees
  churn — trust `npm --prefix app run typecheck` (`tsc -b`), never the
  diagnostics stream.
- A committed change to the always-dirty `.claude/settings.json` blocks `git
  switch` between branches until both sides hold the same blob — `git fetch
  origin develop:develop` (ref update without checkout), then switch. That
  ref-update trick REFUSES while `develop` is itself the checked-out branch —
  branch straight off the remote instead (`git switch -c <b> origin/develop`).
