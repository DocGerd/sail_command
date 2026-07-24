# Contributing

SailCommand is a small personal project; issues and PRs are welcome but
review capacity is limited.

## Ground rules

- **`main` is protected**: PR-only merges (merge commits), required checks
  `app` + `e2e` must pass, review threads must be resolved, strict
  up-to-date policy (rebase/merge `main` before merging).
- **No backend.** The app is deliberately client-only; features that need a
  server (proxies, token exchanges, databases) will be declined.
- **Offline first.** Planning a route needs network (wind fetch); everything
  else must keep working offline. A feature that silently assumes
  connectivity is a bug.
- **Not a navigation device.** User-facing copy must never claim chart
  authority.

## Development

See [README → Development](README.md#development). Quick reference:

- `npm --prefix app run lint` / `typecheck` / `test` / `build` / `e2e`
- New or changed functionality should be accompanied by automated tests —
  Vitest unit/property tests, plus Playwright e2e tests where the change
  affects user-facing behavior, map rendering, or offline/PWA flows. PRs
  that add or change behavior without tests will be asked to add them.
- CI runs lint + typecheck before tests — vitest alone will not catch
  unused imports or type errors.
- The full unit/property suite takes ~4 min (a ~200 s seeded fast-check
  property file and a ~40 s real-mask solver acceptance file are expected).
  CI runners are 6–10× slower than dev machines: never add a per-test
  timeout tighter than the file-level `vi.setConfig` values.
- UI strings go through the i18n dictionaries (`de` + `en`); key parity is
  type-enforced — add every key to BOTH dicts.
- TypeScript `strict` + `exactOptionalPropertyTypes` are on; enums are
  forbidden (`erasableSyntaxOnly`).
- **UAT preview:** https://docgerd.github.io/sail_command/uat/ is a real
  deployment of the current `develop` state, auto-refreshed on every push —
  use it to verify unreleased changes beyond local testing. It serves
  whatever `develop` currently holds, so it's explicitly not the productive
  version and may break at any time.

## Data pipeline

`pipeline/` regenerates the committed static assets (mask, polars, harbors,
basemap). It downloads ~900 MB of source data into `pipeline/data-src/`
(gitignored, cached — don't delete it casually). `verify_mask.py` must exit
0 before committing a rebuilt mask. See `pipeline/README.md`.

## Design spec

`docs/superpowers/specs/2026-07-14-sail-command-design.md` is the source of
truth for design-level decisions — PRs that silently deviate from it will
be asked to update the spec discussion first.

## Labels & milestones

Issues use four **prefix-family** labels — the name carries a colon and a
space, e.g. `type: bug` — so agents and the maintainer can self-route and
triage. DocGerd is a user account (no org-level Issue Types), so label
prefixes are the mechanism.

**Families**

- `type:` — exactly one per issue: `type: bug` · `type: feature` ·
  `type: chore` · `type: docs`.
- `priority:` — `priority: high` (do next; blocks a release or agents) ·
  `priority: medium` (planned, not urgent) · `priority: low` (nice-to-have /
  icebox).
- `area:` — where the work lives: `area: routing` · `area: map` · `area: pwa`
  · `area: pipeline` · `area: deploy` · `area: ais` · `area: tooling`.
- `status:` — `status: needs-triage` (not yet assessed; default on new bugs) ·
  `status: blocked` (waiting on an external decision or dependency).

Every open issue should carry a `type:` and, once triaged, an `area:` and a
`priority:`. The issue forms in `.github/ISSUE_TEMPLATE/` apply the `type:`
label (and `status: needs-triage` for bug reports) automatically.

**Milestones**

- `v0.5.0` — the next release.
- `v0.6.0` — the release after next.
- `Backlog` — accepted, not yet scheduled into a release.
- `Icebox` — deferred / maybe-never; revisit opportunistically.

Roll milestones forward at each release cut: the shipped milestone closes, the
`v0.(N+1).0` scope becomes the next `v0.N.0`, and a fresh `v0.(N+2).0` is
opened. `Backlog` and `Icebox` persist across releases.

## Claude Code config placement

Claude Code / agent configuration follows a four-scope convention (shared vs.
personal vs. secret). Put every config change in the scope that matches its
audience and sensitivity:

- **`.mcp.json`** (repo root, **committed**) — MCP servers shared by the whole
  project. Secrets go through `${ENV_VAR}` interpolation, never hardcoded.
- **`.claude/settings.json`** (**committed**) — shared hooks, `enabledPlugins`,
  and permissions that every contributor and agent should get.
- **`.claude/settings.local.json`** (**gitignored**) — personal, secret, or
  machine-specific overrides. Never committed.
- **`~/.claude/`** (global) — personal, cross-project preferences only; never
  project-shared config.

No API keys or tokens are committed anywhere in repo config. In particular the
AIS overlay is **BYOK** (bring-your-own-key): the aisstream.io key is supplied
by the user at runtime and stored in the browser, and there is never a
committed default. This is the standing rule for all future config changes.
