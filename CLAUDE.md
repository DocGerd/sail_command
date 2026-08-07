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
- `docs/spikes/` — one decision document per investigated-but-not-built
  spike, named `<issue>-<slug>.md` (#245, #244, #296). Each records a
  RECOMMENDATION plus an explicit considered-and-rejected section, so a
  declined option cannot quietly come back as a fresh idea. Deliberately NOT
  under `docs/superpowers/specs/`: that path is guarded by a main-session
  ask-gate hook, and a subagent writing there would slip a spec edit past
  the gate. A spike doc is evidence for a decision, never a spec — promoting
  one to a spec is a main-session act.

## Commands

- App (run from repo root): `npm --prefix app run typecheck` / `lint` / `test` /
  `build` / `dev`. CI runs lint+typecheck BEFORE tests — vitest alone will not
  catch unused imports or type errors.
  **`lint` is literally `eslint src`, so `app/e2e/**` is NEVER linted by CI**
  (#420, open) — including the specs that are the ONLY functional assurance
  for `src/sw.ts` and `src/routing/worker.ts` (both ~0% coverage by design).
  Run `npm --prefix app run lint -- e2e` by hand after touching a spec (this
  lints `src` AND `e2e` in one pass, so it cannot silently diverge from what
  CI runs); a real error sat there unseen until PR #419's review found it.
  Note the `run`, not `exec` — per the next bullet, `exec` does NOT chdir, so
  `npm --prefix app exec eslint e2e` resolves `e2e` against the REPO ROOT and
  exits 2 with "No files matching the pattern" (measured), silently linting
  nothing. The e2e-only spelling that does work is
  `npm --prefix app exec eslint app/e2e`.
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
  test` run: **1207 tests, 103 files** (2026-08-03). Session 24 (2026-08-04)
  merged four PRs (#380/#340 planner progress, #381/#378 route annotation
  layers, #382/#368 banner clearance, #384/#324 second-rig overlay) that
  together added test files (`app/src/lib/useBannerHeight.test.ts` among
  them) and cases to several existing ones — the count is stale again by
  more than a fixed delta this time, so it was re-measured rather than
  hand-added: a real `npm --prefix app run test` run gives **1294 tests, 109
  files** (2026-08-04). The coverage PERCENTAGES above are UNTOUCHED — they
  were not re-measured this session (that needs `test:coverage`, a
  substantially longer run) and a scanning-only or assertion-adding test
  file is coverage-neutral to first order the same way PR #351's was; don't
  infer a new percentage from this count. Meets the OpenSSF
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
  suppressing. PR #374 fixed this with a `MutationObserver` on `.banner-area`
  (`{childList: true}`), disconnected on unmount. **PR #382 (#368) REMOVED
  that observer**, subsumed rather than kept as a second redundant trigger:
  `childList` fires on banner mount/unmount but is BLIND to a banner that
  grows TALLER by wrapping to a second line (a longer German string) with no
  child added or removed at all — exactly the residual `lib/useBannerHeight.ts`'s
  shared `ResizeObserver` on `.banner-area` closes structurally, publishing
  the real rendered height as the `--sc-banner-height` custom property on
  `:root` (the same value `app.css`'s narrow-layout banner-clearance rule
  now reads, replacing an earlier viewport-height CLAMP HEURISTIC that was
  blind to actual banner count/height — see that rule's own comment).
  ScaleBar.tsx now calls that SAME hook (its own call site, alongside
  App.tsx's) purely to get an effect-rerun trigger — the hook's
  `ResizeObserver` callback writes the CSS custom property SYNCHRONOUSLY,
  before the `setState` that would otherwise schedule ScaleBar's re-render,
  so by the time ScaleBar's own `[isWide, bannerHeight]` effect reads
  `.map-stack-tl`'s `offsetTop`/`offsetHeight` the DOM position is already
  correct regardless of which call site's commit lands first. NAMED
  COUPLING now points at `App.tsx:687` (renders `.banner-area`
  unconditionally) and `App.tsx:132` (the App-level `useBannerHeight()`
  call, kept purely for that write side-effect). Any rule that moves
  `.map-stack-tl` still changes `ScaleBar`'s available room — the two remain
  connected only through that runtime-measured layout value, invisible in
  the CSS, in the diff, and to any test that checks the two components
  separately.
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
  **Update (PR #382, #368): the `:has()` half of that combination is GONE**
  — the rule's own `.app-shell:has(.banner-area .banner)` gate was removed
  once a real `ResizeObserver` measurement made it redundant (a genuine 0px
  reading collapses `top`/`max-height` back to their base values on its own,
  no gate needed). The MQ3-vs-MQ4 choice above is UNCHANGED and
  independently justified regardless — app.css's own updated comment: a
  Level 3 parser drops the WHOLE BLOCK silently either way, "reason enough
  on its own" — not merely a residual of the now-gone `:has()` pairing.
- **#355 resizable desktop left panel** (`PanelResizer.tsx`, `lib/panelWidth.ts`,
  `lib/usePersistedNumber.ts`): `role="separator"` WAI-ARIA "Window Splitter"
  primitive, wide-layout only (`isWide` mount-gates it — narrow must not gain
  the affordance even in the accessibility tree). `app.css`'s `.app-shell`
  grid track is `grid-template-columns: minmax(320px, var(--sc-panel-w, 1fr))
  10px 2fr;` — `--sc-panel-w` is written by `App.tsx` as a px length once a
  user drags/keys the resizer, and the bare `1fr` fallback is load-bearing:
  with no stored override the pre-#355 layout is reachable byte-for-byte, not
  merely approximated. `panelWidth.ts`'s `panelMaxWidthPx()` computes
  `max(320, min(0.7·viewportWidth, viewportWidth − 480))` — the `480px` map
  reserve (`PANEL_MAP_RESERVE_PX`) is a maintainer JUDGEMENT call, not a
  measured layout constant, and its own comment says so explicitly so a future
  reader doesn't mistake it for one. Persistence is `usePersistedNumber` —
  localStorage via `lib/storage.ts`'s safe wrappers, NOT IndexedDB (mirrors
  `usePersistedToggle`'s contract); `null` means no override; the returned
  value clamps to the CALLER's current `min`/`max` on every read, but the raw
  stored number is left untouched by a bounds change ALONE — only an explicit
  drag/keyboard-step/reset commit persists a new value, so one narrow-viewport
  visit cannot silently erase a wide-screen preference. `panelWidth.test.ts` is
  the CSS/JS drift guard (this repo's `useBannerHeight.test.ts` pattern): it
  `readFileSync`s `app.css`, regexes out the `320px` literal, and asserts it
  equals `PANEL_MIN_WIDTH_PX`.
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
  not `Camera` (`node_modules/maplibre-gl/src/ui/map.ts:589` vs
  `ui/camera.ts:284`, both read against `maplibre-gl@6.1.0`; they are
  siblings), and the method survives only on the
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
  (`camera.ts:1197-1210`, 6.1.0) deletes `_easeFrameId` and only THEN invokes
  `_onEaseEnd` at `:1210` — and `_afterEase` (`:982`) IS that `_onEaseEnd`,
  bound in `_ease` (`:1232`) — so `isEasing()` was already false at every
  ease-emitted `moveend` even in v5, which is why the absence of
  `originalEvent` discriminates a camera-internal ease termination from a
  handler-gesture settle. ACCEPTED NARROWING: the new
  guard is ease-source-SPECIFIC where `isEasing()` was ease-source-AGNOSTIC —
  a foreign, bearing-changing ease carrying no `originalEvent` would now demote
  where v5 did not. No producer exists in the app today
  (`RouteLayer.tsx:656`'s `fitBounds` passes `duration: 0` and the current
  bearing (line number moved from :458 by today's #378/#324 insertions
  earlier in the file, #380/#381/#382/#384 session — re-check after any
  future edit that adds lines above this call site); keyboard rotation and
  drag inertia always carry `originalEvent`;
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
  (#230). SECOND RESIDUAL, in this same `_stop` mechanism and live for real
  users: a gesture BEGUN while any `easeTo`/`flyTo`/`fitBounds` is in flight
  is swallowed whole, because the ease's own completion calls a bare
  `this.stop()` (no `allowGestures`) → `_stopHandlers()` → `reset()` on every
  handler, disarming the gesture mid-drag (#391, Backlog — fixing it means
  patching maplibre; symptom, measurement and the e2e-side workaround in the
  #383 bullet under Verification lessons).
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
  against `maplibre-gl@6.1.0`, the version `app/package-lock.json` pins,
  re-checked after the #253 v6 upgrade and again after the 6.1.0 bump: still
  `this.sortFeaturesByKey = zOrder !== 'viewport-y' &&
  !sortKey.isConstant();` at the same line; re-check again after any future
  maplibre-gl upgrade),
  disabling the placement priority entirely. Within one symbol layer,
  placement and paint order cannot be set independently — that needs a
  second layer (#200, #232).
- `icon-allow-overlap` and `icon-ignore-placement` sound like the same knob
  and are not: `allow-overlap` ("place me even if I collide") governs
  whether *I* get culled by the collision index; `ignore-placement` ("do not
  enter me into the collision index") governs whether I block OTHERS.
  `sc-wind-barbs` (`RouteLayer.tsx`) had the first without the second —
  `icon-allow-overlap: true` made barbs immune to being culled, but with
  `icon-ignore-placement` unset (defaults false) every dense barb icon
  (~96-110px screen spacing at every zoom, `routeGeoJson.ts`'s
  `adaptiveBarbFeatures`) still INSERTED a collision box that blocked the
  ETA/speed TEXT layers underneath. The visible symptom was on the labels
  (`sc-eta-primary`/`sc-eta-secondary`/`sc-leg-speed` culled to 0 at some
  zooms); the cause was on a layer that looked perfectly healthy (#378,
  MEASURED via `queryRenderedFeatures`: hiding `sc-wind-barbs` alone took
  `sc-eta-primary`'s evicted 'gybe' label at z12 from 0 back to present, and
  `sc-leg-speed` on the same route from 0 to 7). The issue's own
  hypothesis — the z12 `icon-overlap` threshold from #191/#192 — was WRONG
  and refuted directly (these are point/line TEXT symbols with no
  `icon-image`; `icon-overlap` is never set on them at all), as was a
  primary-vs-secondary layer-order theory (hiding `sc-eta-secondary` alone
  left `sc-eta-primary` still at 0). Fix: `'icon-ignore-placement': true` on
  `sc-wind-barbs`. For TEXT symbols the analogue of `icon-padding`'s
  collision-box lever is **`text-padding`** — `icon-padding` itself is
  meaningless on a text-only layer.
- **#378 route annotation layers** (`RouteLayer.tsx`): `sc-eta-primary`/
  `sc-eta-secondary`/`sc-leg-speed`'s `text-size` is now zoom-interpolated —
  `['interpolate', ['linear'], ['zoom'], 9, 12, 12, 13, 15, 15]` — replacing
  a flat `text-size: 11` that was legible at a desk but too small on a phone
  on deck in daylight. Growth is deliberately gated to z12+ (held near
  current size through 9→12, +9%) because MapLibre's collision footprint
  scales 1:1 with text-size and a bigger box culls MORE labels under
  `text-allow-overlap: false` — the same coupling #378 itself found and
  exists to fix. The two ETA layers (not `sc-leg-speed`, which places along
  the line and can't use this) replaced a fixed `text-anchor`/`text-offset`
  (exactly ONE candidate placement per point — any collision there culled
  the label outright with no fallback) with `text-variable-anchor:
  ['left','right','top','bottom']` + `text-radial-offset: 0.9` +
  `text-justify: 'auto'` (up to 4 fallback placements before giving up) —
  these three are MUTUALLY INCOMPATIBLE with `text-anchor`/`text-offset` in
  the MapLibre style spec, never combine them. `text-padding` on all three
  annotation layers trimmed from the 2px default to `1` to partially offset
  the larger collision box the zoom-interpolated text-size introduces.
  `sc-leg-speed`'s culling-by-line-length (`symbol-placement: 'line-center'`
  — short legs stay unlabeled at low zoom, no hand-tuned nm threshold) and
  `sc-maneuver-labels`' `text-allow-overlap`/`text-ignore-placement: true`
  overlap exemption are UNCHANGED by #378 and remain deliberate (per their
  own code comments, not previously written up here).

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
- **Reproducing a settle race needs the write to land INSIDE the window, and
  the window is smaller than it looks** (#412, PR #419). The target here is
  the gap between `boundingBox()` and `elementsFromPoint` — two consecutive
  CDP round-trips, roughly 10 ms. A multi-second delay puts the write BEYOND
  both calls and a pre-loop CSS force puts it BEFORE both: **both sample the
  two CONSISTENT states and can never reach the inconsistent one**, so three
  such constructions "proved" a site was dormant when they had not tested it
  at all. Worse, the supporting evidence (`box.y + box.height <= vp.height`
  "trips first") read the SAME FROZEN BOX the assertion does, so it was blind
  to exactly what it was credited with catching. Treat reachability as
  UNMEASURED unless the construction demonstrably lands inside the window;
  two residual sites are tracked in #422.
- E2E determinism: no fixed `waitForTimeout` as a synchronization wait — gate
  on state signals with `expect.poll`; settle canvas baselines via two
  consecutive byte-equal screenshots before byte-comparing frames against them.
  **The rule governs an assertion's INPUTS, not only its predicate.**
  The `#368` banner-clearance guards in `app/e2e/layout.spec.ts` (a
  parametrized viewport sweep plus three named fix-wave tests) and the
  SIBLING guard in `app/e2e/compass.spec.ts` each USED TO capture
  `depthToggle`'s `boundingBox()` ONCE and then assert against a coordinate
  frozen from that single read — taken before the `ResizeObserver` write of
  `--sc-banner-height`, and the CSS push it causes, had settled. A real
  interception and a stale-coordinate read produce a BYTE-IDENTICAL
  signature, so the race could make a guard PASS with the defect live. The
  two forms differed only in CI signature, which is exactly why recognising
  them as ONE class mattered: `layout.spec.ts` polled a stale point until its
  budget expired (a predicate timeout), while `compass.spec.ts` fed the
  frozen boxes to an IMMEDIATE one-shot `expect(overlap area).toBe(0)` with
  zero settle tolerance and failed an overlap comparison outright — not
  polling is not the same as not needing a gate. FIXED in #412 / PR #419:
  every one of those guards now RE-SAMPLES its geometry INSIDE the poll
  callback, so no box survives across a tick; the specs carry `#412` comments
  at each site saying so. Two residual frozen-geometry sites remain elsewhere
  in the suite, tracked in #422. The durable rule outlives the fix: polling a
  state signal is not enough if the coordinate or handle being polled was
  itself sampled before settle.
- `app/e2e/helpers.ts` exports a named viewport matrix — `STANDARD_VIEWPORTS`
  (desktop4k 3840x2160, desktopHd 1920x1080, tabletLandscape 1180x820,
  tabletPortrait 820x1180, phonePortrait 390x844) and `EDGE_VIEWPORTS` (the
  narrow/short stress cases #368's own residuals were measured against:
  narrowPortrait360, shortLandscape844/740, deepPortrait320,
  partialPushBand375, wrapForcing280). Specs must import and iterate these,
  never inline viewport literals — this repo already paid for the per-file
  version of that mistake once (nine hardcoded `testTimeout` literals,
  patched two at a time across CI rounds before centralizing behind one
  constant, #342). Playwright viewports are CSS px, not device px: a real 4K
  display at common 150%/200% OS scaling presents as ~2560x1440 or exactly
  1920x1080 CSS px, so `desktopHd` already doubles as the scaled-4K case —
  `desktop4k` is deliberately the UNSCALED, very-wide extreme instead of a
  third near-duplicate entry. The tablet pair straddles this app's single
  `1024px` wide-layout breakpoint (`lib/useWideLayout.ts`): at
  `tabletLandscape`, `.banner-area` becomes `position: static; grid-area:
  banner` inside the wide-layout grid (`app.css`, `@media (min-width:
  1024px)`) and cannot collide with map chrome by construction; at
  `tabletPortrait` the narrow banner-clearance rule fires instead.
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
  (`symbol/placement.ts:1268-1277`, 6.1.0) gates re-runs on `commitTime +
  fadeDuration * durationAdjustment > now` with `fadeDuration: 300` defaulted
  at `ui/map.ts:539` (same version). Measured effect: spec runtime ~6.5s -> ~2.3s,
  stabilising after three reads (~820ms) — placement had been settled almost
  immediately all along. Whether any OTHER spec shares this defect is
  UNCONFIRMED — a grep of `annotations.spec.ts` (the spec `labels.spec.ts`'s
  gate was originally modelled on) finds no `once('idle')`/fixed-cap race at
  all, so do not assume it is affected; #376 tracks auditing `app/e2e/**` by
  MEASUREMENT rather than by pattern-matching.
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
- **Deploy — same-SHA no-op (#398), FIXED via a version-aware smoke probe**:
  GitHub Pages keys a deployment by COMMIT SHA — `actions/deploy-pages` logs
  `Created deployment for <sha>, ID: <sha>`. A release tag points at `main`'s
  tip, so the merge-push run and the tag-push run deploy the SAME commit; the
  first deployment of that SHA wins and the second is accepted, reports
  success, and does not replace the served artifact. MEASURED at the v0.9.0
  cut: merge-push run completed 07:04:20Z and deployed `c4e139d`; the tag
  run's Pages deployment reported `success` at 07:07:14Z and changed
  nothing; production kept serving the pre-tag build (`v0.8.1-82-gc4e139d`)
  for ~40 min. Two full attempts of the tag run both went green and both
  no-opped — every existing signal (run conclusion, Pages deployment status,
  and the CDN smoke probe below) read green, because the probed basemap
  archive is byte-identical between the two builds and cannot distinguish
  them. `concurrency: cancel-in-progress` is what normally hides this and it
  is a RACE, not a guarantee — at v0.7.0 the tag run cancelled the merge run
  before it deployed, so only one deployment of that SHA existed. Inverted
  intuition, state it explicitly: a SLOW tag push is the dangerous case,
  i.e. exactly the runbook's human flow (merge the PR, tag at human speed).

  **The fix**: the `build` job discovers the entry-chunk URL assembled into
  each ref's dist (from the built `index.html`'s own `<script
  type="module">` tag, validated for a hashed `assets/<name>-<hash>.js`
  shape under the expected deployment base path — never a hardcoded
  filename, and never an unvalidated one either; same discovery philosophy
  as the basemap archive lookup below) and exposes it as a job output
  (`prod-entry-url`/`uat-entry-url`); `smoke-probe` fetches that URL and
  requires 200. The bundled `__SC_APP_VERSION__` define changes the chunk's
  content hash whenever it changes, so a main-push build and a later
  tag-push build of the IDENTICAL commit produce two DIFFERENT hashes — on
  a same-SHA no-op the live site is still serving the PREVIOUS build's
  chunk, so the resolved URL 404s, decisively (a URL never requested before
  cannot be a stale cache hit, unlike polling `index.html`, which the Pages
  CDN's query-string normalization makes cache-proof against `?cb=` busting
  — curl, a real browser, `cache: 'no-store'` and `cache: 'reload'` are all
  answered from the same edge object).

  **Which half carries signal depends on the trigger** — say precisely what
  is proven, not more: on a MAIN-MODE run (a `main` push, a release-tag
  push, or a dispatch on `main`) BOTH halves are this run's own fresh build
  and both are decisive — exactly the configuration #398 is about, since
  the merge-push run and the tag-push run are each main-mode and deploy the
  identical commit. On a develop-triggered run the PROD half depends on
  which #117a path THIS run took, not on trigger alone: on a cache HIT that
  passes validation, `deploy.yml`'s `build-main` step never fires and the
  prod dist is restored from the `prod-dist-v2-<sha>-<version>` cache — by
  construction the build already live, so its URL returns 200 regardless of
  whether THIS run's own deployment took (that 200 is evidence about the
  PREVIOUS deployment, not this one). On a cache MISS or a FAILED
  validation, `build-main` reruns even in develop mode (`if: mode == 'main'
  || cache-hit != 'true' || valid != 'true'`) and `prod_dist` becomes this
  run's own fresh build — the prod half CAN carry real signal there, most
  notably in the window where "Enforce byte-stability vs last main-mode
  build" finds no retrievable baseline and skips the drift check with only a
  warning: that rebuild is otherwise unverified against any known-good
  reference, so this probe is the one thing standing in for it. The UAT half
  has real teeth on EVERY develop-triggered run regardless of which prod
  path was taken (rebuilt every push, since `git describe --tags --always`
  moves with every commit) and is this run's own build there. The check
  still runs unconditionally on every trigger — cheap, and the uat half
  alone still generalizes to "deployment reported success but did not take"
  beyond this one root cause; do not skip either
  half on the assumption one is redundant.

  Consequence for the release runbook: a same-SHA no-op now REDS the
  `smoke-probe` job instead of reporting a false `success` on a main-mode
  run — `.claude/skills/release/SKILL.md` §5b's remedy for that case is no
  longer "re-run the tag deploy" (provably a no-op against the same SHA,
  measured twice at the v0.9.0 cut) but "proceed to the back-merge" (step
  6), whose push carries a DIFFERENT SHA and rebuilds the site root from
  `main` with the tag now visible.
- **Deploy — `deploy` job timeout, a DIFFERENT failure mode from #398**
  (#415): the Pages `deploy` job (the `actions/deploy-pages` step) aborts a
  deployment that never reaches a terminal state — `build` still succeeds,
  `deploy` fails, and `prod-environment`/`uat-environment`/`smoke-probe` all
  SKIP (`needs: deploy`). Production is unaffected as long as `main` hasn't
  moved past its last successful deploy; `/uat/` goes stale.
  **Describe it by SHAPE, never by one status string**: `deployment_queued`
  AND `deployment_in_progress` are both observed (`fb2481c` logged
  `deployment_in_progress` x118 and `deployment_queued` x0), and upstream
  reports `syncing_files` — a triage grepping for one string concludes it is
  a different defect. The abort is the action's OWN DEFAULT poll ceiling
  (`action.yml`'s `timeout: 600000`, not overridden here); every failure runs
  10m05s-10m09s. **`smoke-probe` structurally cannot catch this**: #398 is a
  deploy that reports success but silently doesn't take; this one reports
  FAILURE outright and its downstream jobs never run — the probe that closed
  #398 has nothing to probe here.
  **Root cause is UPSTREAM and externally CONFIRMED**: `actions/deploy-pages#406`
  (open, independent reporters) plus GitHub's own 2026-08-06 incidents
  *"Pages - Deployment Lag"* (15:03Z) and *"Actions"* (15:22Z), both reaching
  `major_outage`. TRAP worth keeping: the status page read ALL-OPERATIONAL
  for hours first, and the community threads report the same — **absence of a
  published incident is not evidence the fault is yours**.
  **REJECTED — raising the `timeout` input.** Upstream reports it ineffective,
  and on `e303e496` attempt 1 burned the full ceiling while a FRESH attempt 2
  succeeded in **11 SECONDS** on the identical commit and artifact (run
  `31109710670`), with `smoke-probe` PASSING on that rescued deployment. On
  timeout the action CANCELS its own deployment, so a wedge clears by
  RETRYING, never by waiting — the intuitive fix is the evidentially weaker
  one here.
  **FALSIFIED, do not revisit**: `concurrency: cancel-in-progress` did NOT
  orphan a deployment — no deploy.yml run that day was cancelled at all, and
  no non-terminal Pages deployment existed. Artifact size is flat (~70.75 MB
  against a documented 1 GB Pages limit) and not implicated; both
  `actions/deploy-pages` and `upload-pages-artifact` are already at v5.0.0,
  the newest release, so there is nothing to bump.
  The fix — `continue-on-error` on the first `deploy-pages` step, then a
  `steps.deployment.outcome == 'failure'`-gated warn + wait + retry — landed
  in PR #418. NOT YET EXERCISED as of 2026-08-07: on the first deploy after
  that merge, attempt 1 succeeded in 11 s and all three retry steps SKIPPED.
  A green deploy is therefore NOT evidence the retry works, and never will
  be — only the `::warning::` firing marks a genuine rescue. That run also
  cannot discriminate `.outcome` from `.conclusion` (see the next bullet):
  on a SUCCEEDING step both read `success`, so the correct guard and the
  broken one are indistinguishable there.
- **GitHub Actions expression gotchas** (verified 2026-08-06 against the
  documented Contexts grammar AND `actions/runner` source, not from memory):
  a HYPHENATED step id IS valid in dot notation — `steps.deployment-retry
  .outputs.page_url` parses correctly, no `steps['deployment-retry']` index
  syntax needed —
  `src/Sdk/DTExpressions2/Expressions2/Sdk/ExpressionUtility.cs`'s
  `IsLegalKeyword` admits `-` at index >= 1 but NOT as the first character
  (read against `actions/runner` `main` @ 2026-08-06 — a moving branch, so
  re-derive after any upgrade), and `deploy.yml` already relies on this in
  green production runs. And
  `steps.<id>.outcome` is the result BEFORE `continue-on-error` is applied
  while `.conclusion` is the result AFTER — so a retry must gate on
  `.outcome == 'failure'`; `.conclusion` reads `success` on the very step
  whose failure you are trying to detect.
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
  (`node_modules/maplibre-gl/src/style/load_glyph_range.ts:21`, 6.1.0); `font-src`
  governs `@font-face` only, which this app doesn't use for map labels.
  Nothing in the suite yet asserts a label actually renders (#320).
- `app/e2e/csp.spec.ts` closes the structural blind spot the rest of the
  suite has: `annotations.spec.ts:244-247` asserts ZERO Open-Meteo requests
  (the assertion moved from :167 when #378/PR #381 added ~247 lines earlier
  in this file; re-derived session 25, where the previously cited `:246` was
  the message argument rather than the `expect(` itself),
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
  published tag object is something third parties may already have
  fetched — re-creating it does change the tag object's sha (measured
  during #364), which is disruptive even for these unsigned tags with no
  signature to invalidate; the stronger "attestation a third party may
  already have verified" framing applies once the subject is an actually
  signed tag (`v0.8.0` onward). `main` is
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
  origin/main` — fast-forwards to the release commit, zero file diff from the
  merge itself; step 6 of the release runbook (`.claude/skills/release/SKILL.md`)
  adds the `ROADMAP.md` bump on top — then PR →
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
  '(clos(e|es|ed)?|fix(e[sd])?|resolve[sd]?)[[:space:]:(]*#[0-9]+'` — run it
  before merging,
  especially when a PR's scope changed mid-flight, since the stale intent
  lives in an old commit the body/title check never sees. The commit-vs-body
  timeline discriminator above is what identified the culprit here too: the
  `closed` event carried a real `commit_id`, not `null`.
  That pattern REPLACED an earlier `'(clos|fix|resolv)[a-z]*[[:space:]]+#[0-9]+'`
  that was wrong in BOTH directions (measured 2026-08-07 on one probe file):
  `[[:space:]]+` admits no `(`, so a bracket- or colon-separated ref slipped
  through (`fix (#412`, `Closes: #321` — the colon form is a real GitHub
  spelling, which is what the `:` in the class is for), while `fix[a-z]*`
  greedily ate longer words, so `fixture #99` false-POSITIVED. The replacement
  fixes the misses and NARROWS the false positives — it does not close them:
  a word merely CONTAINING or ENDING with a keyword still matches (`postfix
  #12`, `unclose #13`), which is the safe direction for a nudge. It also
  deliberately drops the gerunds (`closing`/`fixing`/`resolving` are not
  GitHub keywords, and the old `[a-z]*` matched them). Whether GitHub itself
  parses the BRACKETED form is UNVERIFIED — widen the grep rather than reason
  about it: the check is free and its failure mode is silent.
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
  fabricating depth; don't attempt without hi-res bathymetry. A finer grid
  is NOT that hi-res bathymetry and has been measured to make things worse
  — see the #245 rule under Domain rules.
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
- **One invocation cannot tell a load-bearing guard from a decorative one
  when the failure it defends against is PROBABILISTIC** (#383, PR #390).
  Reverting that PR's new at-rest settle gate gave 8/8 GREEN on the first
  try — on that evidence the fix was a placebo about to ship. Only
  `--repeat-each=16` exposed it: 25% failure with the gate removed, against
  128/128 green with it (plus a reviewer's independent 16/16).
  At a 25% per-run failure rate, eight consecutive clean runs happen
  ~10% of the time by chance (`0.75^8` = 10.0%) — an 8-run revert is a
  coin-flip-grade experiment, not a mutation check. Size the repeat count
  against the failure rate you are trying to detect, and never read one
  green revert as "the gate does nothing".
- **This session produced THREE distinct vacuity traps in one PR lineage — a
  guard, then its fix, then the fix's data — the documented "a fix inherits
  its bug's blind spot" pattern, one level deeper each time; not one was
  found by reading, all three by constructing the failing input and running
  it.**
- A THIRD mutation-vacuity class, distinct from #50's equivalence-test trap
  and #216/#388's prose-vs-value trap below: **a mutation reddening a test
  does not establish the test guards anything REACHABLE.** Measured on PR
  #410: `legDistanceReconciliation.test.ts`'s epsilon-free sign assertion
  (`total >= Σ chord`) reds under a "halve every stored distance" mutation,
  so the battery looked convincing. But that assertion is a THEOREM given
  the code — every leg's `distanceNm` is exactly its own chord or a sum of
  sub-chords, which is >= the chord by the triangle inequality — so no
  reachable code change can violate it. A reviewer flipped the
  chord/polyline convention in BOTH directions and the sign assertion PASSED
  both times; what actually discriminates is the magnitude bound
  `residual < 1e-3` (reds at 27.5x/10.5x over). The stated roles of the two
  assertions were exactly inverted. Rule: for each assertion, ask whether
  any change the code could actually make would violate it — a mutation the
  codebase cannot produce proves nothing.
- Guards fail open on QUOTE STYLE too. Measured on PR #411:
  `planRoute.reasonDecoupling.test.ts`'s structural guard, which detects a
  gate re-coupling to a solver-derived label, matched only SINGLE-quoted
  string literals — a re-coupling written with backticks
  (``NO_ROUTE_LABEL_OF_CAUSE[cause] === `unreachable` ``) left it **10/10
  GREEN** and passed both lint and typecheck (prettier normalises `"…"` to
  `'…'` but leaves a template literal alone). Any source-scanning guard must
  match `'`, `"` AND backtick. Fixed with a `labelLiteral()` regex over all
  three quote forms, pinned by a row that reds when narrowed back to
  single-quote-only.
- A guard's DATA needs a twin too, not just its detection logic. Same guard,
  same PR: `SOLVER_LABELS`, the array every failing loop iterates, had NO
  twin — stubbing it to `[]` left the whole guard **12/12 GREEN**, silently
  dropping a label disabled the guard while it kept reporting success. Fix:
  tie the list to the test's own hand-written `EXPECTED_LABELS`, NOT to
  production `NO_ROUTE_LABEL_OF_CAUSE` — deriving needle and haystack from
  one source is the worse tautology (#388's shape). Discriminating
  experiment: perturb EACH SIDE ALONE — changing production only reds the
  structural row; changing the test's own table reds two rows. Had the
  needle come from production, that second probe would have been
  unobservable.
- A mutation battery can pass for the WRONG reason when a test row carries
  MORE THAN ONE trigger for the same expected outcome. A near-miss row meant
  to pin allowlist MEMBERSHIP was written as `xargs npm install < pkgs.txt` —
  the `<` redirect alone already disqualifies the command via the exclusion
  set, so membership was never exercised; a real, metachar-free
  `xargs npm install` would have been silently suppressed with no test
  catching it (#216, `.claude/hooks/notices-nudge.sh`). General form: when a
  row's purpose is to isolate ONE condition, strip every other
  character/construct that could independently cause the same pass/fail.
  **A row can also be vacuous by matching PROSE rather than the value under
  test** — the same class, recurring inside the check written to prevent it
  (#388, PR #387). A twin check meant to prove the guard's user-facing
  reason string lists every allowlisted verb substring-matched each verb
  against the WHOLE reason sentence; `ls` was satisfied by the phrase "which
  a**ls**o matches", so that verb passed even with the derived list stubbed
  EMPTY — the mutation reds 13 of 14 rows rather than 14, and a 13/14 red is
  convincing enough that nobody counts. Assert against the parsed VALUE (the extracted list), never against the
  surrounding sentence. Sharper still: the reviewer's suggested fix PASSED
  the vacuity probe while deriving needle and haystack from the SAME array —
  a worse tautology that no longer tested anything. **A fix that passes the
  test written to catch its absence can still be the wrong fix.** The
  discriminating experiment was to break the SPLICE while leaving the
  DERIVATION intact: correct form reds 1, suggested form reds 0.
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
- The sibling question belongs BEFORE the check is demanded, not after: a
  brief asking for evidence a method structurally cannot produce will get it
  — fabricated. #368 (PR #382 review): an implementer was asked to prove a
  sub-frame first-paint timing window was closed; no Playwright assertion in
  this suite can observe one (every gate in this repo polls post-settle —
  the E2E determinism rule above itself forbids anything else), and the e2e
  test written to "prove" it passed even against a manually-reverted
  `useEffect`. A reviewer flagged the demand as unsatisfiable and the test
  was deleted rather than shipped; the guarantee instead rests on a
  source-level argument (`useLayoutEffect`'s synchronous-before-paint
  contract, no SSR in this app — `main.tsx` is a plain
  `createRoot().render()`). Ask *what class of failure can this method not
  detect* before requiring something as proof, not only after a green
  result — the two questions are the same question asked at different
  times, but only one of them prevents the fabricated test from ever being
  written.
- A cross-language invariant (a CSS `var()` fallback that must equal a JS
  constant — no compiler spans CSS and TypeScript) has no automatic keeper;
  the only thing that can catch drift is a test that reads BOTH artifacts
  and compares them — `useBannerHeight.test.ts` reads `app.css` via
  `node:fs`, regexes out the `var(--sc-banner-height, <N>px)` fallback, and
  asserts it equals `BANNER_HEIGHT_UNMEASURABLE_FALLBACK_PX` (#368). It
  fails CLOSED, not merely equal: an explicit `expect(match,
  '...').not.toBeNull()` runs BEFORE the value comparison, so a regex that
  silently stops matching (the CSS rule renamed, reformatted, or removed)
  fails loudly instead of quietly passing — the same shape as the
  STRING-pattern `String.replace` bullet above (a silent no-op that shipped
  a build with zero CSP metas, #223). Mutation-checked both ways: reverting
  the CSS literal to `0px` fails with `Expected: 176, Received: 0`; deleting
  the fallback entirely trips the `not.toBeNull()` guard first.
- A fix INHERITS its bug's blind spot. #233's hook fix drew six Blockers over
  two rounds, and all three of round 2's were the same mention-vs-invocation
  class the fix existed to close, now living inside the fix itself; #228
  produced four cascading z-index regressions, each caused by the previous
  fix. Re-run the ORIGINAL defect class against the new code, and treat a
  passing selftest table as proof only of the shapes it lists.
  Session 28 (2026-08-06/07) produced fresh instances in EVERY ONE of the
  three PRs merged that night — including one inside a **comment-only**
  wording correction, where the entire content of the change was a single
  comment and it still reproduced the class. (Deliberately no count: the
  first write-up said "five" and the enumeration found ~10, one PR alone
  exceeding five — a bare number in a durable instruction reads as an
  enumeration.) The invariant across every one of them: **a claim
  about code, stated from memory instead of re-read from the code**. Prose has
  no compiler, so nothing else catches it. The remedy that worked: make claims
  PER-SITE, which are falsifiable one site at a time — every failure was a
  GENERALISATION ("two tests", "only grows", "not precise hit-tests").
- Documenting a rule fixes nothing already in flight. #412 (the #368-guard
  stale-geometry finding) was filed while `app/e2e/panel-resize.spec.ts` was
  being written in parallel under a brief that predated the finding — the
  new spec acquired the identical single-`boundingBox()`-then-assert defect
  the just-filed issue was about, because a CLAUDE.md/issue update doesn't
  reach code a parallel agent already has open. Caught only because a
  reviewer was told to check for that specific shape (PR #414 review, fixed
  in `3bba82f`). A rule landing mid-session needs an explicit re-check
  against work started before it existed, not an assumption of propagation.
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
  (`app/node_modules/maplibre-gl/src/render/glyph_manager.ts`; every line
  number in this bullet read against `maplibre-gl@6.1.0`) catches EVERY
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
  have run) and must not be deleted as redundant. `sc-maneuver-labels`
  (`app/src/components/RouteLayer.tsx:321-333`) is the one symbol layer that
  sets a `text-field` but no `text-font`, so it requests MapLibre's default
  `Open Sans Regular,Arial Unicode MS Regular` — a fontstack this app does
  not ship — and silently renders via TinySDF. Pre-existing (dates to the
  original route-layers commit, well before #378/#324), audited against all
  nine runtime symbol layers, tracked as #288. `labels.spec.ts` cannot see
  it because that spec never plans a route. The missing-fontstack request
  itself is real in both environments, but its symptom differs: local `vite
  preview` returns the SPA fallback (HTTP 200, body starting `<!do`) for
  that path, so MapLibre's decode fails with `Unimplemented type: 4` — an
  artifact of the preview server, not of production, which returns an
  honest 404 for the same request. That distinction is what made the
  symptom look environmental for two sessions.
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
  **"Read it from the installed artifact" is NOT sufficient on its own
  (#392).** A long-lived checkout's `node_modules` can be STALE against the
  lockfile — this one was, serving `maplibre-gl` 6.0.0 while
  `app/package-lock.json` pinned 6.1.0 — so two people can each `grep -n`
  real source and reach opposite, both-honest conclusions about the same
  line (measured: a reviewer filed a Major finding that a correct citation
  was wrong; the implementer refuted it with the version, #383/PR #390).
  SECOND independent instance (2026-08-06, PR #419): the same checkout served
  `@playwright/test` 1.62.0 while `app/package-lock.json` pinned 1.62.1 — two
  different packages, same trap, so treat this as the normal state of a
  long-lived checkout rather than a one-off.
  **The LOCKFILE is authoritative** — it is what `npm ci`, CI and production
  install. So: `npm ci` first, confirm the version you are about to read
  (`node -p "require('./app/node_modules/<pkg>/package.json').version"`),
  check it against `app/package-lock.json` — never against a warm
  `node_modules`, memory, or CLAUDE.md — and NAME that version next to the
  citation, because these numbers move between releases. Re-derive EVERY
  citation individually after an upgrade: the offset is not uniform even
  within one file (6.0.0 → 6.1.0 left `ui/map.ts:539` untouched while
  `:576` became `:589` — a bulk shift would be a fresh fabrication
  replacing a stale one).
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
- **A fix whose trigger is RARE is not verified by the trigger's absence.**
  Write "NOT YET EXERCISED" in the same breath as "landed" — every later
  healthy run reads as confirmation otherwise. The #415 deploy-retry bullet
  under PWA/E2E/deploy is the worked instance, including why a SUCCEEDING run
  cannot discriminate the correct guard from the broken one.
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
  **Corollary for DELEGATION: enumerate FIRST, then scope the agent's file
  allowlist from the enumeration — never the other way round.** Measured
  2026-08-06 (PR #402): a brief scoped its allowlist from the ISSUE's claim
  about where the stale text lived. #341's issue text located the "6-10x CI
  slower" claim in `CLAUDE.md` — that was backwards: `CLAUDE.md` already
  carried the corrected, measured figures, and the live stale text was
  actually in `CONTRIBUTING.md`. Four `.md`-adjacent locations were in view
  across the fix (`CLAUDE.md`, falsely, per the issue's own claim;
  `CONTRIBUTING.md`, fixed against the original allowlist; then
  `.claude/agents/sail-implementer.md` and `README.md`, found only by a
  follow-up enumeration and both OUTSIDE the allowlist the brief had derived
  from the issue). That follow-up enumeration was itself under-scoped —
  `git grep -n "..." -- '*.md'`, silently Markdown-only — and got reported as
  "repo-wide" with "zero remaining instances." It wasn't: a reviewer's later,
  genuinely unscoped grep found 14 more live instances in source/test
  comments (`app/e2e/*.spec.ts`, `app/src/routing/*.test.ts`,
  `app/src/lib/gpx.parse.test.ts`), of which 6 were fixed and 8 deliberately
  left alone as a different, correctly-cited defect (a real, dated ~30-44x
  solver-CI measurement, not the fabricated 6-10x figure). The
  scoped-grep-reported-as-repo-wide over-claim is the SAME failure this
  file's own "four ways prose rots" bullet documents, one layer further
  out — occurring inside the very PR fixing prose-rot claims. An allowlist
  derived from an unverified claim about the code is the enumerate-don't-patch
  failure relocated one level up, into the brief. Same reason issue texts
  are not ground truth for states they do not describe.
- **A FIFTH way, adjacent to SAME-PR INVALIDATION: SIBLING-MERGE
  invalidation.** #423's CLAUDE.md prose was accurate when authored
  (2026-08-06T22:06:46Z) and was made FALSE by #419 merging 9 h 19 min later
  (2026-08-07T07:26:14Z) — a DIFFERENT PR in the same merge train, so no hunk
  of #423's own diff contains the invalidating change. **What CAUGHT it was
  review time, not merge time**: #423's review ran 40 min after #419 landed,
  against a base that already contained it (`git merge-base --is-ancestor`
  confirms), and re-derived each claim from the CURRENT code rather than from
  the diff — which is exactly how it found the bullet describing an
  already-fixed defect as live. So the remedy is NOT a new merge-time step:
  it is that a docs review must re-derive claims against the base it is
  actually running on, and must be re-run when the base moves (same rule as
  "a review is valid only against the base it ran on" under Working style).
  Recorded because the FIRST write-up of this incident asserted the opposite —
  that both reviews were structurally blind — which was contradicted by this
  repo's own timestamps and would have taught future sessions to distrust the
  control that worked. A claim about the RECORD, stated from memory instead
  of re-read from the record, is the same class as a claim about the code.
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
- **#383 was never a flake — it was a real MapLibre defect, and it is FIXED
  (PR #390).** `compass.spec.ts`'s `rotateThenTapCompassHome` helper reds
  with `Expected: "free" / Received: "north-up"` whenever its right-drag
  begins inside the PREVIOUS iteration's still-running tap-home ease: that
  ease's natural completion calls a BARE `this.stop()` (no `allowGestures`)
  → `_stopHandlers()` → `reset()` on EVERY handler, disarming `mouseRotate`
  mid-gesture, so the ten following `mousemove`s produce a bearing delta of
  exactly zero (MEASURED: max |bearing| = 0 across the whole gesture). The
  camera genuinely never moved, which is why raising the timeout could never
  help and why the mode "never flips" — CompassControl is not involved. The
  fix ADDED an at-rest settle gate to the helper (a state signal, not a
  sleep); PRODUCT CODE IS UNTOUCHED, so **the underlying MapLibre defect is
  still live for real users on any `easeTo`/`flyTo`/`fitBounds` — tracked as
  #391 (Backlog), and fixing it means patching maplibre.** Pinned 128/128
  plus a reviewer's independent 16/16. The maplibre line numbers for the
  whole `stop`→`_stopHandlers`→`reset` chain live in that helper's own
  closing-gate comment, which names the version they were read against — go
  there rather than re-citing them here. #253's lesson is VINDICATED, not
  contradicted: the fix is a gate ADDED, never a readiness wait weakened,
  and calling this "a known flake" for two sessions is exactly the
  write-off that rule exists to prevent — a lone red test contradicting a
  green suite deserves MORE weight than the suite.
- **Five green signals can share one blind spot (#398).** Verifying the
  v0.9.0 tag deploy actually reached production, three green signals missed
  the same-SHA no-op: the run conclusion, the Pages deployment status
  (`success`, with `environment_url` = the prod root), and `smoke-probe` —
  which probes the `.pmtiles` archive, byte-identical between the two
  builds, so it cannot distinguish them. The probe that DOES work compares
  the run's own published `prod-manifest` (it records the entry chunk
  `assets/index-<hash>.js` and `version.txt`) against the live site and
  requests that exact filename: 404 vs 200 is decisive precisely because a
  never-requested URL cannot be a stale cache hit. Do NOT verify by polling
  `index.html` — GitHub Pages' CDN NORMALIZES QUERY STRINGS, so
  `?cb=$RANDOM` is a no-op and curl, a real browser, `cache: 'no-store'` and
  `cache: 'reload'` are all answered from the SAME edge object. Five checks
  agreeing was one check with a shared blind spot, and it nearly triggered an
  unnecessary production re-deploy; the tell was `x-cache: HIT` (with
  `age: 392`, `cache-control: max-age=600`) on a URL never requested before.
  Sibling of the existing "what class of failure can this method not
  detect?" rule — here the answer was "any change at all".
  **The 404 half of that argument is now MEASURED, not assumed** (PR #403
  review, 2026-08-06): a never-deployed `assets/*.js` HEADs a genuine 404 on
  the real production CDN, not an SPA-fallback 200. That was worth checking
  rather than reasoning about, because local `vite preview` returns the SPA
  fallback (HTTP 200) for exactly this shape of request — see the glyph
  bullet above, where that same preview-vs-prod difference made a symptom
  look environmental for two sessions. Had production behaved like preview,
  the whole version-aware probe would have passed forever while proving
  nothing. The shipped probe was then confirmed to actually EXECUTE on a
  real deploy (run `31092871174`, step "Assert this run's own build is
  actually live (#398)") — a green run is not evidence the new step ran.

## Domain rules that are easy to get wrong

- **Navigability is decided at query time** (`cellDepth >= safetyDepth`), not
  baked into the mask — safety depth (default 3.0 m; boat draft 2.1 m) is a
  user setting and must never require regenerating data.
- **The ~46 m mask grid is SOURCE-limited, and refining it is a measurable
  REGRESSION against today's connectivity gate** (#245,
  `docs/spikes/245-depth-mask-resolution.md` — do not re-open without new
  bathymetry). Rebuilt end-to-end at 23 m and 12 m: **0 of the 5 #9
  KNOWN_DISCONNECTED harbours reconnect** at either resolution, while
  `aabenraa` DISCONNECTS at 23 m and `augustenborg` additionally at 12 m.
  Mechanism: each sits exactly ON its gate (`aabenraa` 3.0 ≥ 3.0,
  `augustenborg` 2.8 ≥ 2.8) and a finer cell no longer borrows the decimetre
  the coarse cell averaged in — so `verify_mask.py` fails. State this
  GATE-CONDITIONAL: it is true at the DEFAULT 3.0 m safety depth, never as
  unconditional "finer is harmful" (`aabenraa` reads 2.9 m at 23 m, so it
  stays connected for any user who lowers the gate). Licensed by a fidelity
  control the reviewer reproduced INDEPENDENTLY with their own
  reimplementation: 0 of 5,280,000 bytes differ.
- **Buoyed fairways are DECLINED as a routing input** (#244,
  `docs/spikes/244-buoyed-fairways.md`). `seamark:type=fairway` does not
  exist in-region at all; the 258 `waterway=fairway` ways that do exist
  carry ZERO width/depth/draft tags, and 144 (55.8%) are canoe-scheme
  geometry of which 132 (51.2% of all 258) are explicitly
  `boat=discouraged` — a naive nearest-fairway lookup picks a PADDLING route
  for `maasholm`. The issue's own "depth already confines the boat, so a
  fairway adds little" hypothesis was FALSIFIED, not confirmed: the
  navigable corridor is >1 km wide at 90.8% of navigable-centreline points.
  The decline rests on the data being unusable, not on the corridor being
  narrow.
- **Wind grids are stored with each plan** (IndexedDB). A saved route must
  always render against the forecast it was computed from, never a re-fetched
  one.
- **Tack/gybe minimization is not a separate pass**: it emerges from the
  maneuver time penalty (default 45 s) inside the isochrone cost. Don't add a
  post-hoc "tack reducer" that can violate wind/depth constraints; the only
  allowed post-processing is merging near-collinear legs with re-validation.
- **The router runs twice per plan** (genoa polar, fock polar) and recommends
  the faster rig. Both results are user-visible.
- **Second rig, on the map too, not just in the results panel** (#324): the
  rig NOT currently shown as primary can be overlaid on `RouteLayer.tsx`'s
  map as `sc-route-alt-sail`/`sc-route-alt-motor` — map-only (no
  labels/maneuver points, so it never enters #378's fragile ETA/speed
  collision index), dashed (`[1, 1.5]`) + 0.45 opacity so it reads as "the
  other rig" rather than a duplicate primary, distinguished from the primary
  route purely by dash + opacity since colour already carries
  port/starboard and sail/motor meaning. Anchored with an explicit
  `beforeId: HIGHLIGHT_LAYER` — above `ROUTE_STACK_BOTTOM_LAYER` (the #53
  shallow-depth casing, so the overlay can rarely paint over a safety
  warning where the two tracks coincide — a considered trade; the reverse
  order would instead hide the whole overlay under DataLayers' depth
  shading) and below the primary route's own highlight/sail/motor layers
  (the recommendation stays visually dominant wherever the two cross).
  Toggle persisted in **localStorage** (`usePersistedToggle`,
  `lib/storage.ts`'s safe wrappers — NOT IndexedDB), default OFF. Gated on
  `Boolean(result) && Boolean(altResult)` in BOTH the checkbox's `disabled`
  attribute AND the layer-visibility effect (PR #384 review) — gating only
  the control leaves an overlay already made visible by the persisted flag
  still rendered once a user switches primary-rig tabs to one whose own
  result is null: `!altResult` alone is not enough, since `result` can be
  null while the complement's `altResult` stays truthy, which would draw the
  ONLY real route as the dashed "other rig" track.
- **Planner progress is phase-based, not a percentage** (#340): the old
  readout divided simulated route TIME by the unrelated 6-day/144h forecast
  HORIZON — capped around 5% by construction and reset to 0% at every
  genoa→fock rig switch and every #53 depth-relaxation retry. Replaced with
  a phase readout ("sail N of 2 (Rig)", i18n key `planner.status.routingRig`)
  derived from `rig` alone via `RIG_ORDER` (`types.ts`, `['genoa', 'fock']`).
  `runBoth` in `planRoute.ts` evaluates `genoa: run(...)` then
  `fock: run(...)` as plain, SYNCHRONOUS object-literal properties — no
  interleaving — which is what makes the numbering honest: genoa's solve
  (and every progress message it reports) fully completes before fock's
  starts. The coupling is enforced by `planRoute.test.ts`'s "#340: solve
  order matches RIG_ORDER" guard test, which records the order rigs are
  FIRST seen in via the progress callback into a plain array (deliberately
  NOT a `Set`, which is order-blind) and asserts it equals `RIG_ORDER` —
  mutation-checked: swapping `runBoth`'s two properties turns this red with
  `['fock', 'genoa']` against the expected `RIG_ORDER`.
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
  REOPENED — PR #411's merge auto-closed it via an earlier commit's stray
  keyword even though the PR body itself used `Refs`; do not let it be
  closed again on this evidence). PR #411 NARROWED the coupling, it did not
  remove it: the two retry gates — named predicates `comfortRetryMayHelp` /
  `depthRelaxationMayHelp` — now branch on an INTERNAL `SolveFailureCause`
  (`'mask-blocked' | 'calm-without-motor' | 'horizon-exceeded'`), deliberately
  kept OUT of `types.ts` so it cannot leak into UI code. The public
  `NoRouteReason` is unchanged, derived from the cause at exactly two
  presentation boundaries via `NO_ROUTE_LABEL_OF_CAUSE`. A LABELLING change
  is now safe — free to reword or re-granularise with zero routing effect. A
  CLASSIFICATION change is NOT: the cause is still DERIVED from
  `SolveResult.reason`, the only failure signal `solve()` exposes. Proven,
  not theoretical: PR #279's pre-revert change (`isochrone.ts:530-531`)
  flipped `'unreachable'` → `'calm-motor-off'`, which now maps to cause
  `'calm-without-motor'`, which `comfortRetryMayHelp` still rejects — tier 2
  is still suppressed, and the same slower route (the motivating incident
  behind the reverted, never-merged reclassification patch — Bagenkop,
  Wackerballig, Gelting-Mole all slower — not reproducible from current
  `develop`) recurs unchanged. Reusable asset from #411: a five-arm
  Flensburg→all-33-harbours sweep, **165/165 plans byte-identical**
  (33 harbours × 5 settings arms), run TWICE at BASE before any edit as a
  control (byte-identical both times, licensing the BASE-vs-HEAD comparison
  at all), with MEASURED two-directional gate coverage — both gates
  exercised true AND false, including the calm class (0 occurrences across
  the original 3 arms; 34 across two arms added specifically to reach it).
  NARROWED, NOT CLOSED: any future reason-classification change still needs
  that full sweep, never a labeling-only fix.
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
  CONTRIBUTING.md (#167/#168). **The taxonomy has DRIFTED into space/no-space
  duplicates** (found during the v0.9.0 cut): `priority: high` /
  `priority: medium` / `priority: low` coexist with `priority:medium` /
  `priority:low`, and `area: deploy` / `area: map` / `area: routing` /
  `area: pwa` / `area: ais` / `area: pipeline` / `area: tooling` coexist with
  `area:tooling` / `area:map` / `area:pipeline`. `gh issue create` fails with
  `could not add label: '<name>' not found` on the wrong spelling, and
  filtering by one silently misses issues tagged with the other. Verify with
  `gh label list --repo DocGerd/sail_command --limit 60 --json name --jq
  '.[].name'` before using a label name; a cleanup pass is unscheduled.
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
- **A read-only EXEMPTION must be CONJUNCTIVE, and its allowlist rests on a
  named precondition** (#388, PR #387). `.claude/hooks/artifact-guard.sh`
  used to `ask` on any Bash command merely NAMING a protected path,
  read-only ones included — a deliberate over-fire the maintainer then
  overruled ("too restrictive, i had to approve several stat calls"). It now
  suppresses only when ALL THREE hold: the command's FIRST WORD exactly
  matches a small no-write-capability verb set, AND the whole command
  contains none of `> < | & ; \` $ \ ( ) { } ! #` / newline / CR, AND it
  contains none of a write-capable TOKEN list matched as substrings anywhere.
  A first-word- or prefix-only exemption fails OPEN and is still wrong. Read
  the three arrays off the hook itself (`WRITE_CAPABLE_CHARS`,
  `WRITE_CAPABLE_TOKENS`, `READONLY_VERBS`) rather than from any second copy
  — including this one; the token list in particular is deliberately
  SUBSUMPTION-PRUNED, so `-execdir`, `-okdir` and `"bash -c"` are absent by
  design (each is a strict superstring of an entry that IS there —
  `"bash -c"` is `ba` + `"sh -c"` — so a separate entry could never be the
  reason a command matches, and adding one back makes its own selftest row
  unfalsifiable: deleting `"bash -c"` reds 0 rows, MEASURED).
  **NAMED PRECONDITION:
  no allowlisted verb may be a shell FUNCTION or ALIAS in the guarded
  shell** — `grep` is excluded precisely because in Claude Code's Bash it is
  a function shimming to ugrep, so "the executable is its first word" is
  false for it; `find` is excluded for `-delete`/`-exec`, `file` because
  `file -C -m X` WRITES `X.mgc` (measured — it merely looked read-only), and
  `sed` because sed's `w` command writes with NO flag at all
  (`sed -n '1,5w /tmp/out' file`), so excluding only `-i` would not be
  enough — and a `sed -n` range read is exactly the innocent-looking shape
  that motivates asking for it.
  Before adding a verb, run `type <verb>` **in the real Bash tool**:
  measuring inside `bash script.sh` does not inherit non-exported functions,
  so the shim vanishes and every verb reports a reassuring `file`.
- **Four loosenings of that guard were MEASURED and REJECTED — do not
  re-propose them** (2026-08-06, three-lens audit; full record in #404/#405).
  Narrowing the Bash-arm path `docs/superpowers/` → `docs/superpowers/specs/`
  is the seductive one and the worst: it makes `mv docs/superpowers
  /tmp/stash` a SILENT ALLOW (it moves `specs/` too), reds 13 of the guard's
  own selftest rows (re-measured 2026-08-06 against a scratch copy — an
  earlier auditor's 11 does not reproduce). Method, so this can be re-run
  rather than re-argued: `docs/superpowers/specs` is ALREADY a separate
  `PROTECTED_PATHS` entry alongside the bare `docs/superpowers` ancestor, so
  the two edits a mutation could try — deleting the ancestor entry outright,
  or "narrowing" it by replacing it with `docs/superpowers/specs` — collapse
  to the same array and the same byte-identical script; both were run
  independently in `/tmp` and both gave 13, never 11. It is also
  SUBSUMPTION-INVERTED — `docs/superpowers/specs`
  is a strict superstring of `docs/superpowers`, so the parent subsumes the
  child and removing the parent deletes the entry doing all the work. Adding
  `cd` to `READONLY_VERBS` and segmenting the command on `;`/`&&`/newline
  each removed EXACTLY ZERO prompts from a 165-command corpus of real
  observed commands, and `cd` is actively harmful: the `ask` on `cd
  app/public/data` is the ONLY visible moment of the two-call bypass the
  hook's own design names as its one LIVE hole (Bash cwd persists across
  calls). The general trap, worth more than the specific verdicts: **a
  control that looks broader than its stated justification usually has a
  SECOND justification you have not found** — here the parent-path entry is
  not justified by the spec-edit rule at all, but by containment against
  commands that destroy `specs/` WITHOUT NAMING IT (#309's M4 fix). Look for
  the second reason before narrowing anything. The real remaining gap runs
  the other way: the Edit/Write arm hardcodes `*docs/superpowers/specs/*`,
  so `plans/` has no ask-gate at all (#405) — WIDEN that arm, never narrow
  the Bash one.
- A NEW concrete guard-asymmetry instance (#368, PR #382 review): a value the
  FIRST PAINT depends on must be written in `useLayoutEffect`, not
  `useEffect` — `useEffect` fires AFTER paint, leaving a real window on a
  cold load where `var(--x, fallback)` resolves to its fallback
  (`lib/useBannerHeight.ts`). The fix there is TWO guards, deliberately not
  one duplicated: `useLayoutEffect` closes the pre-paint TIMING window; a
  non-zero CSS fallback (`var(--sc-banner-height, 176px)`, matching
  `BANNER_HEIGHT_UNMEASURABLE_FALLBACK_PX`) is what still protects the
  layout if the custom property is never written AT ALL for some other
  reason (hook not mounted, an error thrown before the write, a future
  refactor) — a failure mode the timing fix does nothing for. Per the
  guard-asymmetry principle above: that CSS fallback must fail toward
  OVER-pushing (a generous non-zero default), never toward zero clearance —
  the same "the absent-measurement path must fail toward the
  expensive-but-safe direction" call as the `String.replace` CSP bullet
  above, one layer lower (a CSS custom-property default instead of a
  build-time string transform).
- **Sharper case of the guard-asymmetry bullet above, same component tree,
  opposite answer** (#355, PR #414 review): `App.tsx`'s `--sc-panel-w` writer
  MUST be `useLayoutEffect` — measured with a rAF sampler under CPU throttle:
  as a plain `useEffect`, first contentful paint on a cold load with a STORED
  900px width rendered the DEFAULT `1fr` width (636.656px) first, then
  snapped. Safe here specifically because `shellRef` is `AppShell`'s OWN ROOT
  element — React's `commitAttachRef` for a component's own returned host
  fiber runs before that component's OWN layout effects, so `shellRef.current`
  is always attached in time. `PanelResizer.tsx`'s sibling `aria-valuenow`
  measurement effect, by contrast, MUST stay `useEffect`: `panelRef` targets a
  SIBLING declared later in the same JSX, and a `useLayoutEffect` version
  there measured `panelRef.current === null` live in Chromium (React attaches
  refs and runs layout effects in fiber/JSX declaration order, so the
  sibling's ref had not yet attached). Rule: "useLayoutEffect for first-paint
  values" is necessary but NOT sufficient — whether the effect's OWN component
  owns the ref (safe) or reads a sibling's (unsafe, ordering-dependent)
  decides which hook is correct.
- The destructive-git guard pattern-matches `-f` anywhere in a compound command:
  never combine `gh api -f …` with `git push` in one Bash call — split them.
  It lives OUTSIDE this repo (`~/.claude/hooks/guard-destructive-git.sh`,
  global/personal, unversioned, shared across concurrent sessions) — NOT
  covered by #216, which is the notices-regen and nudge hooks; #233
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
  thread is still open. Mapping-file gotcha (session 24): when a thread's
  `line` reads `null` because the diff moved under it (GitHub's GraphQL
  `line` field, not `originalLine`), the mapping entry for that finding must
  carry an explicit `"line": null` — `reply_body_for_thread`'s matcher
  compares `.value.line == $line` exactly against the JSON value read
  straight off the thread and does NOT consult `originalLine`. Omitting the
  key (rather than setting it to `null`) makes that entry fail every match;
  the thread is then skipped with a loud `No reply text for thread ... — no
  mapping entry and no default` — correct fail-closed behavior, but the fix
  (add the key) is non-obvious the first time you hit it. Sharper case
  (PR #396): when SEVERAL threads share the same `(path, line)` key —
  routine after a fix wave, since every thread on a file whose diff moved
  reads `line: null` — the mapping matcher cannot disambiguate them and the
  first match wins for all. Measured: six of eight threads were
  `(ROADMAP.md, null)`. Either use a single default reply via `-m`, or drive
  the reply+resolve loop directly off the GraphQL thread IDs (keying
  per-thread text on `originalLine`, which stays unique).
- Completed worktree agents CAN be resumed for fix waves — SendMessage to the
  same agent re-loads its transcript with worktree + branch intact (verified,
  #111 round-1 fixes); a FRESH agent pointed at the surviving worktree is the
  fallback.
- **PIN THE BASE BRANCH in every agent brief**, and require the agent to
  report its merge-base as part of its deliverable — `isolation: worktree`
  does NOT reliably inherit the session's checked-out branch. MEASURED
  (2026-08-06, PR #418): an implementer branched off `main`/v0.9.0
  (`c4e139d`) instead of `develop` and edited a `.github/workflows/deploy.yml`
  177 lines stale that lacked PR #403's entire #398 probe. **Every per-diff
  gate passed clean through it** — diff confined to the one allowlisted file,
  YAML validated, `actionlint` clean, an opus review returning 0 Blockers, and
  an independent 8/8 verification of Actions semantics from `actions/runner`
  source. The ONLY signal was the PR object's `mergeable_state: "behind"`,
  because no per-diff check looks at what a diff is BASED on. Durable rule:
  **a review is valid only against the base it ran on** — when the base moves,
  re-verify the MERGED artifact instead of carrying the review forward.
  Nothing was lost that time only because the `deploy` job happened to be
  byte-identical across both refs; that is luck, not a control.
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
  ask-gate hook must prompt the user) — never through subagents. The hook DOES
  match Bash appends: `bash_hits_protected_path` substring-matches the RAW
  command, so `cat >>` and heredoc forms ASK (MEASURED 2026-08-06 against
  `origin/develop`). `>`/`<` are in `WRITE_CAPABLE_CHARS`, so a redirect
  DISQUALIFIES the narrow read-only exemption rather than bypassing the
  path-presence check — pinned by the hook's own `check ask "> redirect"` and
  `"heredoc redirect"` selftest rows. An earlier claim here that appends
  "silently skip the user prompt" was FALSE, and false in the DANGEROUS
  direction (it advertised a bypass that does not exist, in the one bullet
  about protecting user-approved specs). The real residuals are indirection a
  string-level check cannot see — cwd + bare filename, variable or
  programmatic path construction, quote-splitting — enumerated in the hook's
  own "KNOWN SILENT-ALLOW PATHS" comment; read that, not this, for the
  current list.
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
- `gh pr merge <N>` run on a DETACHED HEAD errors `could not determine current
  branch` while STILL LANDING the merge (OBSERVED ONCE, 2026-08-07, #423) —
  the #94 shape with a new trigger, so it invites the same blind retry.
  Operative advice, independent of mechanism: verify via the merge commit's
  parents (`gh api repos/…/commits/<sha> --jq '.parents[].sha'`), never
  blind-retry. Two things were CORROBORATED — the merge landed, and the
  REMOTE branch was gone (`git ls-remote --heads origin <branch>` empty) —
  and a separate, non-detached run printed `cannot delete branch … used by
  worktree` with the merge equally landed. What was NOT established: which
  internal `gh` step failed (inferred from one error string, never measured),
  or that detachment CAUSES the difference — the two cases were observed
  separately, never as a controlled comparison. Treat the mechanism as
  unproven and the verification step as the durable part.
- `gh run rerun <id> --failed` gives a MISLEADING error when the target run
  hasn't finished: `run <id> cannot be rerun; its workflow file may be
  broken` — the workflow file is fine; the run is simply not `completed`
  yet. Check `gh run view <id> --json status` before trusting the message.
  This command is MUTATING (re-queues a real run) — never issue it during
  read-only diagnostic work; a `completed` run reruns silently with no
  confirmation prompt (measured 2026-08-06: a read-only probe of the message
  above accidentally re-queued a live deploy because the run had completed
  in the interim).
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
