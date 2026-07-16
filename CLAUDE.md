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

## Commands

- App (run from repo root): `npm --prefix app run typecheck` / `lint` / `test` /
  `build` / `dev`. CI runs lint+typecheck BEFORE tests — vitest alone will not
  catch unused imports or type errors.
- Full test suite takes ~4 min (a ~200 s seeded fast-check property suite +
  a ~40 s real-mask solver acceptance file). Use focused filters while
  iterating (`npm --prefix app run test -- <filter>`); give the full run a
  generous timeout. Solver-heavy test files set
  `vi.setConfig({ testTimeout: 120_000 })`; the property test carries 900 s.
  **CI runners are 6–10× slower than dev machines** — never add a per-test
  timeout tighter than the file-level config, and never trust local timing
  margins for CI.
- `npm --prefix app run notices` regenerates `app/public/THIRD-PARTY-NOTICES.txt`;
  CI fails if the committed file drifts — run it after any dependency change.
- Pipeline: `npm --prefix pipeline run polars|harbors|mask|icons` (mask needs
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

## PWA / E2E / deploy (Phase F)

- E2E: `npm --prefix app run e2e` (the `pree2e` hook regenerates
  `app/public/test-fixtures/wind-sw12.json` with fresh timestamps and builds —
  a dirty fixture diff after an e2e run is expected churn, restore it, don't
  commit it). One-time setup: `npm --prefix app exec playwright install chromium`.
- **Honest offline testing**: Playwright's `setOffline(true)` does NOT block
  service-worker fetches (Playwright #2311) — the offline spec kills the
  preview server instead. Never "simplify" that away.
- E2E determinism: never `waitForTimeout` — gate on state signals with
  `expect.poll` (settle canvas baselines via two consecutive byte-equal
  screenshots before pixel comparisons).
- `app/src/sw.ts`: the `.pmtiles` Range→206 route MUST stay registered before
  `precacheAndRoute` (first-registered wins; pmtiles' FetchSource throws on
  full-body 200s), and the SW must never cache the Open-Meteo origin (wind is
  stored per plan in IndexedDB, not in the SW cache).
- Font glyphs (`basemap-assets/fonts/**`) are runtime-cached, never precached
  (#28): a `sailcommand-glyphs-*` CacheFirst route in `app/src/sw.ts` plus an
  app-side background warm-up (`app/src/services/glyphWarmup.ts`) that runs
  only once the SW controls the page. Never extend the SW install/activate to
  fetch them — the small install is the point. Cache version-bump procedure
  lives in `app/src/lib/glyphs.ts`.
- Deploy: `deploy.yml` fires on every push to main. Main is guarded by the
  `protect-main` ruleset (#15): PR-only merges (merge commits, review threads
  resolved), required checks `app` + `e2e` with strict up-to-date policy, no
  force pushes or deletions. Pages serves at
  `https://docgerd.github.io/sail_command/`.
- Multiple open PRs: develop in parallel, merge strictly serially — after each
  merge, `git merge origin/main` into the next branch and let full CI (~10 min)
  re-run before its merge (strict up-to-date policy).

## Verification lessons (hard-won)

- Synthetic-mask tests missed a product-blocking solver bug that the FIRST
  real-data browser run found in minutes (#20: step length vs. real channel
  width). UI tasks should end with a real-browser pass (dev server +
  Playwright); routing changes must keep `app/src/routing/realmask.repro.test.ts`
  green (it uses the real committed mask/polars).
- Flensburg→Marstal routes only at safety depth ≤ 2.3 m — that is correct
  data behavior, not a bug (documented in the realmask test; see #9).

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
- **Motor legs are first-class**: planned when sailing speed < threshold
  (default 2.5 kn) at motor speed (default 6.5 kn), and always flagged as
  motor in the result.
- Angles: wind direction is meteorological (coming FROM, degrees true);
  polars are TWA × TWS → boat speed in knots. Positions are WGS84.
  Distances in nautical miles, speeds in knots.
- Open-Meteo is called directly from the browser (CORS is open, no API key).
  There is deliberately **no backend** — do not introduce one.

## Working style for this repo

- Planning requires network; everything else must keep working offline. Any
  new feature that silently assumes connectivity is a bug.
- The app is a passage-planning aid, not a navigation device — user-facing
  copy must not claim chart authority.
- UI strings always go through the i18n dictionary (de/en), never hardcoded.
- Implementation work goes through the `.claude/agents/` defs: spawn a FRESH
  `sail-implementer` per task (never reuse across tasks); one persistent
  `sail-reviewer` per PR for the fix→re-review loop, retired at merge.
- The destructive-git guard pattern-matches `-f` anywhere in a compound command:
  never combine `gh api -f …` with `git push` in one Bash call — split them.
- PR review threads via API: bodies containing backticks must be sent as JSON
  `--input` files (shell quoting mangles them); inline comments 422 outside diff
  hunks — anchor to in-diff lines, put out-of-diff findings in a PR comment.
- Worktree-isolated agents don't survive completion (branch + node_modules do):
  fix waves need a FRESH agent pointed at the surviving worktree. Parallel
  implementers: assign distinct dev ports; retry e2e on EADDRINUSE; the shared
  Playwright MCP browser is contested — verify the URL before every screenshot.
- Spec edits (`docs/superpowers/specs/`) go through the main session only (the
  ask-gate hook must prompt the user) — never through subagents.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A Stop hook auto-runs `graphify update`. If it fails it writes `graphify-out/.update-failed` and the nudge hooks switch to a staleness warning — while that marker exists, trust raw files over the graph until `graphify update .` succeeds.
