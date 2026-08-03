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

Python code in `pipeline/` is linted and formatted with ruff
(`pipeline/pyproject.toml`); run `ruff check pipeline/` and `ruff format
pipeline/` before committing. CI enforces this in
`.github/workflows/python-lint.yml` (job `ruff`) — an optional check, not
part of `protect-main`'s required `app` + `e2e`.

## Changelog fragments

A PR that changes user-visible behavior adds ONE small file under
[`changelog.d/`](changelog.d/README.md) instead of editing `CHANGELOG.md`
directly — this repo routinely develops several PRs in parallel, and having
every such PR edit the same `CHANGELOG.md` `[Unreleased]` section caused
conflicts (#189). Two PRs adding two differently-named fragment files can
never conflict.

- Filename: `<issue-or-PR-number>.<category>.md`, e.g. `changelog.d/165.fixed.md`
  (`category` is one of Keep a Changelog 1.1's six, lowercase: `added`,
  `changed`, `deprecated`, `removed`, `fixed`, `security`).
- Content: the entry's text only — no leading `- `, no `### Category`
  heading. Full format and examples in
  [`changelog.d/README.md`](changelog.d/README.md).
- Config/tooling/docs-only PRs still add **no** fragment, same as before.
- Pending fragments show up live in the About dialog's "What's new" preview
  (including on the UAT deploy) — `app/vite.config.ts`'s
  `changelogFragmentsPlugin` reads them at build time. They are folded into
  the real `CHANGELOG.md` by hand at the release cut and deleted; see the
  [release runbook](.claude/skills/release/SKILL.md) §2b.

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
label (and `status: needs-triage` for bug reports) automatically. `area:`
labels on **pull requests** are applied automatically from changed paths by
`actions/labeler` (`.github/workflows/labeler.yml`, path map in
`.github/labeler.yml`) — update the path map alongside any directory move.

**Milestones**

- `v0.9.0` — the next release.
- `Backlog` — accepted, not yet scheduled into a release.
- `Icebox` — deferred / maybe-never; revisit opportunistically.

`v0.4.0`, `v0.5.0`, `v0.5.1`, `v0.6.0`, and `v0.7.0` are closed; `v0.8.0`
ships in this cut and closes as part of the release. The
[milestones page](https://github.com/DocGerd/sail_command/milestones) is
authoritative; this list names the shape, not a live count.

Roll milestones forward at each release cut: the shipped milestone closes, the
`v0.(N+1).0` scope becomes the next `v0.N.0`, and a fresh `v0.(N+2).0` is
opened. A PATCH milestone (`vX.Y.Z`, `Z > 0`) is the exception — it closes at
its own cut and shifts nothing: the pending `vX.(Y+1).0` stays where it is.
`Backlog` and `Icebox` persist across releases.

The same cut refreshes the documentation that describes project state, so it
cannot drift from the tracker: [`ROADMAP.md`](ROADMAP.md) (milestone contents
and themes), [`CHANGELOG.md`](CHANGELOG.md) (fold the pending
[`changelog.d/`](changelog.d/README.md) fragments into the new version and
delete them), [`README.md`](README.md) (known limitations),
[`GOVERNANCE.md`](GOVERNANCE.md), and
[`docs/security-assurance-case.md`](docs/security-assurance-case.md).

## Release tag signing (live, starting `v0.8.0`, #322)

Release tags are cryptographically signed from `v0.8.0` onward, using SSH
signing (`gpg.format = ssh`) rather than GPG — GitHub verifies SSH tag/commit
signatures the same way it verifies GPG ones (the "Verified" badge), and it
needs no separate GPG toolchain. `v0.1.0` through `v0.7.0` remain unsigned
permanently — signing is **not retroactive** (re-tagging a shipped release
would change what a rebuild produces at an unchanged SHA; see
[`CLAUDE.md`](CLAUDE.md)). See [`SECURITY.md`](SECURITY.md#verifying-a-release)
for how a *user* verifies a released tag; this section is the one-time setup
for a *maintainer* machine that needs to be able to sign one.

### One-time local setup

```bash
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519.pub   # path to the PUBLIC half only
```

- **`gpg.format ssh`** — sign with an SSH key instead of GPG. Git shells out
  to `ssh-keygen` to produce the signature; the private key never leaves the
  local `ssh-agent`/keyring. **Requirement, not just an observation about the
  current key**: whichever key is used here must be usable WITHOUT an
  interactive passphrase prompt during the release cut — no passphrase, or
  already loaded into `ssh-agent` for the session. The maintainer's existing
  `~/.ssh/id_ed25519` happens to have no passphrase, which is why this works
  unattended today, but that is a property of that specific key, not of this
  setup in general — a successor's own passphrase-protected key would prompt
  on `git tag -s` and stall the runbook's fail-closed chain (§5a) at exactly
  the step that triggers the production deploy. Load it into `ssh-agent`
  first if it has one.
- **`user.signingkey`** — path to the **public** half of the signing key.
  Reusing an existing authentication key (`~/.ssh/id_ed25519.pub`) is fine —
  SSH signing and SSH authentication are different *uses* of the same
  keypair, not different key material — or point it at a dedicated
  signing-only key if you'd rather keep the two separate.
- **Deliberately no `tag.gpgSign true`.** An earlier draft of this plan
  proposed enabling it globally so every `git tag -a` would be silently
  signed. That was rejected: it would make the FIRST-ever signed tag an
  implicit side effect of an ordinary `-a`, hitting an unset config or key
  problem mid-cut (the tag push is the step that triggers the production
  deploy) instead of failing safely ahead of time. The release runbook
  (`.claude/skills/release/SKILL.md` §5a) instead passes `-s` **explicitly**
  on the one command that tags a release, and verifies the signature locally
  with `git tag -v` *before* pushing — so signing is opt-in per invocation,
  not an ambient git setting that could also sign some unrelated tag
  elsewhere in the repo's history.

### `allowed_signers` — required for local verification (`git tag -v`)

An SSH signature on its own says "signed by whoever holds this key"; it
takes a separate mapping from **identity → public key** for `git tag -v` /
`git verify-tag` to resolve *whose* key that is. Without it, verification
fails even against a perfectly good signature. Point git at that file and
populate it:

```bash
git config gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers
```

The file is plain text, one line per identity, in the format
`ssh-keygen -Y verify` and `git verify-tag`/`git tag -v` both understand:

```
<email-or-identity> <key-type> <public-key-material>
```

e.g. (using the public key already at `~/.ssh/id_ed25519.pub`):

```
maintainer@example.com ssh-ed25519 AAAA...restofthepublickey...
```

Multiple identities may map to the same key on separate lines (useful if
commits/tags are made under more than one email address). This file is
**local-only** — it is not, and should not be, committed to the repository;
see `git help gpg-sign` for the full format.

### GitHub registration — required for the "Verified" badge

Local `git tag -v` proves the signature to your own machine. For GitHub to
show the green **Verified** badge (what a third party sees, without needing
any local config of their own), the **public** key must additionally be
registered at `github.com/settings/ssh/new` as a **Signing Key** — GitHub
keeps SSH signing keys in a registry that is **separate from the
authentication-key registry** an existing `~/.ssh/id_ed25519.pub` may already
be registered in for `git push`/`git clone` over SSH. Registering a key for
authentication does **not** register it for signing, and vice versa — both
registrations are needed if the same key is reused for both purposes. Until
the key is registered as a Signing Key, a tag can be correctly, verifiably
signed (`git tag -v` reports `Good signature`) while GitHub still shows it as
**Unverified** — that is a registration gap, not a signature problem; see
`SECURITY.md`'s "Verifying a release" section.

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
