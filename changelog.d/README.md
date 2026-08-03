# Changelog fragments

Conflict-free `CHANGELOG.md` workflow (#189). SailCommand routinely develops
several PRs in parallel (parallel implementer agents). Under the OLD ritual,
every user-visible-behavior PR added an entry to `CHANGELOG.md`'s shared
`## [Unreleased]` section — when 2+ of those PRs ran in parallel, they
collided on the same lines (a merge conflict, or a forced re-sync collision
under `develop`'s strict up-to-date policy).

Under this ritual, a PR that changes user-visible behavior drops ONE small
file here instead and **never edits `CHANGELOG.md` directly**. Two PRs
adding two differently-named files can never conflict — zero merge conflicts,
by construction.

(Config/tooling/docs-only PRs still add **no** fragment at all — same rule
as before, #131.)

## Filename: `<number>.<category>.md`

- **`<number>`** — the issue or PR this entry is about. It only makes the
  filename unique and gives a stable sort order; it is **never** rendered or
  auto-appended to the entry text — put your own `(#165)` reference inside
  the text if you want it shown, exactly like `CHANGELOG.md`'s existing
  entries do.
  If one PR genuinely needs two fragments about the same number (rare —
  usually splitting across categories is the right move instead),
  disambiguate with a `-N` suffix: `165-2.fixed.md`.
- **`<category>`** — one of the six Keep a Changelog 1.1 categories,
  **lowercase**: `added`, `changed`, `deprecated`, `removed`, `fixed`,
  `security`.

Example: `changelog.d/165.fixed.md`

A filename that doesn't match this shape (or this `README.md` itself) is
skipped with a build-time warning rather than failing the build — a
misnamed fragment costs a missing preview line, never a red build.

## Content: the entry text only

The file's entire content is the bullet's text — **no** leading `- ` and
**no** `### Category` heading (the filename already carries the category).
Write it exactly as it should read as a `CHANGELOG.md` bullet:

```
Buoy and beacon symbols no longer merge their topmark into the body below
it (#165).
```

Wrapping across multiple lines is fine for readability in the source file —
blank lines and line breaks collapse into single spaces when the fragment is
assembled (the same join `CHANGELOG.md`'s own parser applies to a wrapped
bullet continuation). A leading `- ` is tolerated (stripped) if you copy the
`CHANGELOG.md` bullet convention by habit, but it isn't needed.

One fragment file = one changelog line. If a PR needs multiple entries, add
multiple files (one per entry), not multiple bullets inside one file — a
second `- ` inside a fragment is NOT parsed as a second entry, it just gets
glued into the first one.

## What happens to a fragment

- **Every build** — the dev server, `vite build`, including the UAT deploy at
  `/sail_command/uat/` — reads every `changelog.d/*.md` file (except this
  `README.md`) and folds them into a synthetic `[Unreleased]` preview in the
  About dialog's "What's new" view (`app/vite.config.ts`'s
  `changelogFragmentsPlugin` + `app/src/lib/changelogFragments.ts`). This is
  *why* assembly happens at build time rather than only at the release cut:
  UAT — `develop`'s unreleased state — should keep showing what's pending,
  not go blank the moment fragments replace direct edits.
- **At the release cut**, the fragments are folded BY HAND into the real
  `CHANGELOG.md`'s new `## [X.Y.Z]` section (grouped under the matching
  `### Category` headings) and the fragment files are deleted — see
  `.claude/skills/release/SKILL.md` §2b. `develop` is protected and PR-only,
  so no CI step can commit assembled content back to it; the fold is a
  human/agent step at the release PR, same as the rest of the #132 docs
  sweep.
