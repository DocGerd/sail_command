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

## Data pipeline

`pipeline/` regenerates the committed static assets (mask, polars, harbors,
basemap). It downloads ~900 MB of source data into `pipeline/data-src/`
(gitignored, cached — don't delete it casually). `verify_mask.py` must exit
0 before committing a rebuilt mask. See `pipeline/README.md`.

## Design spec

`docs/superpowers/specs/2026-07-14-sail-command-design.md` is the source of
truth for design-level decisions — PRs that silently deviate from it will
be asked to update the spec discussion first.
