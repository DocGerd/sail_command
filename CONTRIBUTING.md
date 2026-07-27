# Contributing

SailCommand is a small personal project; issues and PRs are welcome but
review capacity is limited.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). How
decisions get made, who holds which role, and how a change is accepted are
described in [GOVERNANCE.md](GOVERNANCE.md); where the project is headed is in
[ROADMAP.md](ROADMAP.md).

## Ground rules

- **`develop` and `main` are both protected** (one ruleset covers both):
  PR-only merges (merge commits only), required checks `app` + `e2e` must
  pass, review threads must be resolved, strict up-to-date policy (merge the
  base branch before merging), no force pushes, no branch deletion.
- **Feature PRs target `develop`**, the default branch, never `main`. `main`
  holds released state only: a release is a `develop` → `main` PR, tagged
  `vX.Y.Z` after merge. See [GOVERNANCE.md](GOVERNANCE.md#releases).
- **No backend.** The app is deliberately client-only; features that need a
  server (proxies, token exchanges, databases) will be declined.
- **Offline first.** Planning a route needs network (wind fetch); everything
  else must keep working offline. A feature that silently assumes
  connectivity is a bug.
- **Not a navigation device.** User-facing copy must never claim chart
  authority.

## Contribution licensing

The project is [Apache-2.0](LICENSE). Under its §5 ("Submission of
Contributions"), anything you intentionally submit for inclusion — a pull
request against this repository — is submitted under that same license unless
you explicitly say otherwise. Inbound equals outbound; there is nothing extra
to sign.

**There is deliberately no DCO sign-off and no CLA.** The reasoning, and the
conditions under which that would be revisited, are recorded in
[GOVERNANCE.md](GOVERNANCE.md#contribution-licensing--no-dco-or-cla-deliberate).
Do not add `Signed-off-by:` trailers; no commit in this repository carries one
and nothing checks for them.

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

- `v0.5.1` — the next release (a patch release closing out v0.5.0's map chrome).
- `v0.6.0` — the release after next.
- `Backlog` — accepted, not yet scheduled into a release.
- `Icebox` — deferred / maybe-never; revisit opportunistically.

`v0.4.0` and `v0.5.0` are closed. The
[milestones page](https://github.com/DocGerd/sail_command/milestones) is
authoritative; this list names the shape, not a live count.

Roll milestones forward at each release cut: the shipped milestone closes, the
`v0.(N+1).0` scope becomes the next `v0.N.0`, and a fresh `v0.(N+2).0` is
opened. A PATCH milestone (`vX.Y.Z`, `Z > 0`) is the exception — it closes at
its own cut and shifts nothing: the pending `vX.(Y+1).0` stays where it is.
`Backlog` and `Icebox` persist across releases.

The same cut refreshes the documentation that describes project state, so it
cannot drift from the tracker: [`ROADMAP.md`](ROADMAP.md) (milestone contents
and themes), [`CHANGELOG.md`](CHANGELOG.md) (roll `[Unreleased]` into the new
version), [`README.md`](README.md) (known limitations),
[`GOVERNANCE.md`](GOVERNANCE.md), and
[`docs/security-assurance-case.md`](docs/security-assurance-case.md).

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
