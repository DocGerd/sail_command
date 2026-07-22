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
- E2E determinism: no fixed `waitForTimeout` as a synchronization wait — gate
  on state signals with `expect.poll`; settle canvas baselines via two
  consecutive byte-equal screenshots before byte-comparing frames against them.
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
- Deploy (#96): `deploy.yml` fires on push to `main` OR `develop`. Pages
  serves a SINGLE deployment artifact, so every run builds BOTH refs into one
  combined artifact regardless of which branch triggered it — `main` → the
  site root (production, `app/vite.config.ts` `base: '/sail_command/'`,
  unchanged), `develop` → `/uat/` (`SC_DEPLOY_ENV=uat` env var switches
  `base` to `/sail_command/uat/` and, via the config's `subPathMeta()`
  plugin + PWA `manifest` block, adds `<meta name="robots" content=
  "noindex, nofollow">` and a distinct manifest `name`/`id` so the UAT build installs
  as a separate PWA rather than colliding with production's). This
  deliberately couples the two deploys (any push to either branch rebuilds
  both); the existing `concurrency: { group: pages }` still serializes
  overlapping main+develop pushes. Production:
  `https://docgerd.github.io/sail_command/` (unchanged, verified
  byte-for-byte identical to the pre-#96 build). UAT (unreleased develop
  state — noindex, not chart-authoritative, don't link it from anywhere
  production-facing): `https://docgerd.github.io/sail_command/uat/`. `main`
  and `develop` are both guarded by the `protect-main` ruleset (#15 — one
  ruleset covering both branches via literal refs): PR-only merges (merge
  commits, review threads resolved), required checks `app` + `e2e` with
  strict up-to-date policy, no force pushes or deletions.
- **Branching (gitflow-lite, #73)**: `develop` is the protected DEFAULT branch
  where WIP accumulates — feature PRs target `develop`, never `main`. A RELEASE
  is a PR `develop` → `main` (full CI `app`+`e2e` re-runs under the strict
  up-to-date policy), merged as a merge commit, then tagged on `main`; `main` is
  released-state-only. `deploy.yml` (#96) fires on push to either `main` or
  `develop`: production at the Pages site root reflects only released
  (`main`) state as before; `develop`'s unreleased state is additionally
  published to the deliberately-labeled, `noindex`ed `/uat/` sub-path in the
  same run — a UAT preview, not a second production. A HOTFIX branches from `main`, PRs to
  `main`, then `main` is merged back into `develop` to keep it ahead. CI
  (`ci.yml`, `codeql.yml`, `verify-mask.yml`) fires on pushes to both `main`
  and `develop` so required checks keep reporting; the single `protect-main`
  ruleset targets both `main` and `develop` via literal refs (never
  `~DEFAULT_BRANCH` — that follows a default-branch flip and would strand the
  non-default branch) and requires `app`+`e2e` on each.
- Multiple open PRs: develop in parallel, merge strictly serially — after each
  merge, re-sync the next branch from its base (`git merge origin/develop`, or
  `origin/main` for a hotfix/release PR) and let full CI (~10 min) re-run before
  its merge (the strict up-to-date policy applies on `develop` too).

## Verification lessons (hard-won)

- Synthetic-mask tests missed a product-blocking solver bug that the FIRST
  real-data browser run found in minutes (#20: step length vs. real channel
  width). UI tasks should end with a real-browser pass (dev server +
  Playwright); routing changes must keep `app/src/routing/realmask.repro.test.ts`
  green (it uses the real committed mask/polars).
- Flensburg→Marstal routes only at safety depth ≤ 2.3 m — that is correct
  data behavior, not a bug (documented in the realmask test; see #9).
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
  current output re-creates the tautology one level up.
- CodeQL `js/xss-through-dom` fires as a FALSE POSITIVE on
  `DOMParser.parseFromString(x, 'application/xml')` — its DOM-XSS sink model is
  mime-insensitive, but an `application/xml` parse is inert (no script exec, no
  HTML sink) and e.g. `parseGpx` extracts only numeric coords + enum notices. No
  code change removes it (XML parsing needs DOMParser); dismiss the alert as
  false-positive WITH a linked evidence record, not code churn (#3, alert #9 —
  verified by two adversarial passes + live Chromium PoCs).

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
- **Two wind-sampling clocks by design**: map barbs sample the plan's grid at
  the SLIDER hour; the depth profile samples each instant's OWN hour (the map
  is a moment, the profile is a timeline). Don't "unify" them.
- Depth byte 254 is reserved but never emitted (the pipeline folds ≥25.4 m
  into byte 255) — `depthInfoM().capped` is the only honest "≥25 m"
  discriminator; never infer the cap from `depthM === 25.4`.
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
- PR review threads via API: send bodies containing backticks as JSON `--input`
  files (double-quoted shell interpolation mangles them); inline comments 422
  outside diff hunks — anchor to in-diff lines, put out-of-diff findings in a
  PR comment.
- Worktree-isolated agents don't survive completion (branch + node_modules do):
  fix waves need a FRESH agent pointed at the surviving worktree. Parallel
  implementers: assign distinct dev ports; retry e2e on EADDRINUSE; the shared
  Playwright MCP browser is contested — verify the URL before every screenshot.
- When the session's OWN cwd is a worktree, `isolation:worktree` agents and
  un-isolated reviewers can SHARE it rather than get a separate tree — a reviewer
  that checks PR code in for a RED-check leaves those changes for your next
  `git commit` to silently absorb. Always `git show --stat <sha>` before trusting
  a commit's file list (a new-file addendum must be 1 file, insertions-only), and
  stage explicit paths — never `git add -A`.
- Spec edits (`docs/superpowers/specs/`) go through the main session only (the
  ask-gate hook must prompt the user) — never through subagents. Use the
  Edit/Write tools for them: the hook does not match Bash appends (`cat >>`),
  which silently skip the user prompt.
- `.superpowers/` (SDD ledger) is gitignored — append session records
  directly, no PR needed.
- `gh pr edit` hits the Projects-classic GraphQL bug like `gh pr view` —
  update PR bodies via `gh api repos/…/pulls/N --method PATCH --input body.json`.
- A GitHub **504 during `gh pr merge`** can land the merge (base ref updates,
  merge commit created) yet leave the PR marked `open` and skip branch-delete /
  `Closes #` auto-close. VERIFY via the develop tip / merge-commit parents before
  retrying — never blind-retry (you double-merge or get a confusing `behind`);
  reconcile a stuck-but-merged PR by closing the PR + deleting the branch +
  closing the issue manually (#94).
- e2e's preview port is fixed (4173 in helpers.ts): full e2e runs from
  parallel worktrees contend — serialize them; per-agent dev ports are for
  manual browser passes only. The dirty wind fixture (see E2E section) also
  blocks `git worktree remove` — restore before removing; never `--force`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A Stop hook auto-runs `graphify update`. If it fails it writes `graphify-out/.update-failed` and the nudge hooks switch to a staleness warning — while that marker exists, trust raw files over the graph until `graphify update .` succeeds.
