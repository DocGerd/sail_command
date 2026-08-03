---
name: release
description: The develop→main release runbook for SailCommand's gitflow-lite. Cuts a release PR, tags main, and back-merges. Triggers on /release.
disable-model-invocation: true
---

# Cut a gitflow-lite release (`develop` → `main`)

A release ships to production: `deploy.yml` fires on every push to `main` **and
on every `v[0-9]*` tag push** (#197), publishing Pages at
`https://docgerd.github.io/sail_command/`. `main` is released-state-only.
Whatever merges to `main` goes live immediately, so this runbook is
**user-only** and human-gated by design.

A cut therefore produces **two** deploy runs — the merge push, then the tag
push. The tag run is the one that bakes the clean `vX.Y.Z` into the About
dialog, so steps 5–5b below are load-bearing, not bookkeeping.

## 1. Precondition — `develop` is the release candidate

`develop` is the protected DEFAULT branch where WIP accumulates; feature PRs
target it, never `main`. Before releasing, confirm every wanted feature PR is
already merged into `develop` and `develop` is green (CI `app` + `e2e` passing
on the tip).

## 2. 🛑 HARD GATE — LOCAL APPROVAL FIRST 🛑

**Do NOT open the release PR until the user explicitly says go.** This is the
single most important step. Green CI is not enough — the user wants a human
visual check of the actual built state before it ships.

1. Build + serve the current `develop` at the real Pages base `/sail_command/`
   using the `verify` skill's **production-bundle pass** — follow that skill
   for the exact build/serve commands AND the port. Do not restate a port
   number here: the `verify` skill owns that constant (and explicitly
   forbids reusing e2e's fixed `4173`) — a second copy of it in this file is
   exactly how the two drifted apart once already (#287).
2. Real-browser walkthrough of the key flows: **plan** → **harbor combobox** →
   the **Ergebnis card**, in BOTH wide and narrow layouts and BOTH light and
   dark.
3. Present screenshots. **Wait for the user to explicitly approve.**

**Why:** `deploy.yml` pushes whatever lands on `main` straight to
`docgerd.github.io/sail_command`. There is no staging between merge and live —
the local walkthrough is the only pre-ship human check.

## 2b. Docs sweep (the #132 ritual) — before opening the PR

The release cut is the moment the project's self-description is refreshed, so
it cannot drift from the tracker. Do this on a topic branch into `develop`
(or as the last commit before the release PR), never as a `main`-side fixup:

- **`CHANGELOG.md`** — fold the pending `changelog.d/*.md` fragments (#189)
  into a new `## [X.Y.Z] - <date>` section (today's date, ISO): for each
  fragment file (everything under `changelog.d/` except `README.md`), read
  its category from the filename (`<number>.<category>.md` —
  added/changed/deprecated/removed/fixed/security) and its text from the
  file's content, then write a `- <text>` bullet under the matching
  `### Category` heading (create the heading if this cut's first entry in
  that category; category order is Added, Changed, Deprecated, Removed,
  Fixed, Security, matching `app/src/lib/changelogFragments.ts`'s
  `CATEGORY_ORDER`). **Delete every folded fragment file** — leave only
  `changelog.d/README.md`. Update the two comparison links at the bottom: add
  `[X.Y.Z]: …/compare/vX.Y.(Z-1)...vX.Y.Z` and re-point `[Unreleased]` at
  `…/compare/vX.Y.Z...HEAD`. `CHANGELOG.md`'s `## [Unreleased]` heading itself
  stays — it is what re-fills from the NEXT batch of fragments — it should
  just have no categories under it right after a cut (the fragment directory
  is what carried the pending content, not that section). No test edits are
  needed — `ChangelogView` filters the now-empty `[Unreleased]` and
  `changelog.test.ts` pins only the released TAIL (`versions.slice(-5)`).
  This fold is a human/agent step, same as the rest of this docs sweep: no CI
  step can commit the assembled content back into `CHANGELOG.md` on `develop`
  (protected, PR-only), which is why fragments are assembled only at BUILD
  time (for the About dialog's live preview) and folded into the file only
  HERE, at the cut.
- **`ROADMAP.md`** — update `Current release:` and promote Now → Next: the
  shipped milestone's section goes away, the next one becomes "Now". Re-check
  every issue number named there against the tracker; this file was wrong
  within a day of being written.
- **`README.md`** — re-verify the known-limitations section actually still
  describes the shipped build.
- **`GOVERNANCE.md`** — it carries a standing release duty and is re-read at
  each cut; confirm roles and release mechanics still match reality.
- **`docs/security-assurance-case.md`** — the OpenSSF Silver assurance
  document; re-check it still describes the shipped security posture (#168).
- **`CONTRIBUTING.md`** — the milestone list names the *next* release; roll it.
- **Milestone roll-forward** — per the convention already documented in
  CONTRIBUTING.md ("Labels & milestones"): close the shipped milestone BY
  HAND and move anything still open in it to the next one; the pending
  `v0.(N+1).0` milestone's scope becomes the next `v0.N.0`; open a fresh
  `v0.(N+2).0` for what comes after. `Backlog` and `Icebox` persist unchanged
  across the cut. **Exception:** a PATCH release (`vX.Y.Z`, `Z > 0`) closes
  only its own milestone and shifts nothing else — the pending `vX.(Y+1).0`
  stays where it is.

⚠️ **`Closes #N` in a release PR does NOT close the issue.** GitHub auto-closes
only on merge into the DEFAULT branch, which here is `develop`, not `main`
(#132 stayed open after #210 merged for v0.5.0). Close release-scoped issues
manually at the cut, or reference them from a develop-side PR instead.

## 3–6. Release sequence

| # | Step | Detail |
|---|---|---|
| 3 | Open the RELEASE PR `develop` → `main` | Full CI (`app` + `e2e`) re-runs under the strict up-to-date policy of the `protect-main` ruleset. Merges as a **merge commit** — never squash/rebase. |
| 4 | USER merges | Merges to `main` are classifier-gated — **the user runs `gh pr merge`, not the assistant.** Wait for green required checks (`app` + `e2e`) first. `gh pr checks --json` is unsupported here — poll `gh api repos/OWNER/REPO/commits/SHA/check-runs` instead. |
| 5 | Tag + push | After merge (which already triggered `deploy.yml` on the push to `main`), tag `main` with a semver tag (e.g. `v0.5.0`) and push it. **Assert the ref first — see 5a.** That tag push triggers a SECOND deploy run — the one that bakes the clean `vX.Y.Z`, since `git describe` could not see the tag during the merge run (#197) — **and** a `release.yml` run that cuts the GitHub Release object automatically (#175, see 5c). |
| 5b | 🛑 **WAIT for the tag deploy, then verify** | **Do not push or merge anything to `develop` until this passes** — see the cancellation hazard below. |
| 5c | 🛑 **Verify the GitHub Release exists** | Now automated (#175) — the tag push also triggers `release.yml`. A green 5b is not evidence this happened; see 5c below. |
| 6 | BACK-MERGE `main` → `develop` | Open a `chore/backmerge` PR into `develop` so `develop` stays strictly ahead of `main`. Full CI re-runs. This is a develop-merge — the assistant may merge it directly. |

## 5a. Assert the ref BEFORE tagging — local `main` is routinely stale

Step 5 says "tag `main`", and local `main` is almost never `main`. Sessions
work on `develop` and in worktrees, so the local branch can sit hundreds of
commits behind (measured this session: local `main` at `110bb74`, **218
commits behind `origin/main`**). `git switch main && git tag vX.Y.Z` then tags
ancient code and **fails silently**: production bytes are still correct (the
deploy builds from BRANCH TIPS, not the tag's commit), but the tag, `git
describe` on that ref, and the release compare link are all wrong — and the
About-dialog check in 5b can pass anyway, so nothing catches it.

Fetch, then assert both equalities before the tag command:

```bash
REPO=DocGerd/sail_command
TAG=vX.Y.Z
MERGE_SHA=<the release PR's merge commit>   # gh api repos/$REPO/pulls/N --jq .merge_commit_sha

git fetch origin main:main                  # ref update, no checkout needed
[ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ] || { echo "local main != origin/main"; exit 1; }
[ "$(git rev-parse main)" = "$MERGE_SHA" ]  || { echo "main is not the release merge commit"; exit 1; }

git tag -a "$TAG" -m "$TAG" main && git push origin "$TAG"
```

`git fetch origin main:main` updates the ref without a checkout; it REFUSES
while `main` is the currently checked-out branch (it will not be here — the
cut runs from `develop`).

**Annotated, not lightweight (#222).** 7 of the 9 tags shipped to date are
lightweight, and a lightweight tag is a bare ref — it cannot carry a
signature at all, so annotated is the prerequisite for signing later.
`-m "$TAG"` is required, not cosmetic: a bare `git tag -a` with no message
opens `$EDITOR` and hangs a non-interactive/agent shell. This is
**verified safe** against the About-dialog version string: `vite.config.ts`'s
`appVersion()` calls `git describe --tags --always`, and `--tags` resolves
lightweight and annotated tags identically, so switching tag *kind* changes
nothing `git describe` reports. **Signing itself (`-s`) is NOT enabled yet**
— planned starting at `v0.8.0` per #222's decision; do not add `-s` to the
command above before then. See `SECURITY.md`'s "Verifying a release" section
and `CONTRIBUTING.md`'s "Release tag signing" section for the full plan.

## 5b. The tag deploy must go GREEN before the back-merge (#197)

`deploy.yml`'s `concurrency: { group: pages, cancel-in-progress: true }`
**cancel-supersedes**: a newer run in the group cancels the older one, pending
or in-flight. Release tag runs share that group, so a back-merge push to
`develop` landing while the tag run is still going **cancels it** — and since
the tag run had itself cancelled the merge run, *neither* release run deploys.
Production then keeps serving the **previous release's** bytes, and the only
signal is a grey "cancelled" run: **nothing goes red**. (A ref-conditional
concurrency group would fix this structurally; it was evaluated and rejected —
see the comment above `concurrency:` in `deploy.yml`.)

Both checks must pass before step 6:

**1. The tag-triggered run reached `success`** — "not failed" is not enough,
cancelled is the failure mode here. Several runs share the tag commit's SHA, so
select the newest **push** run:

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
TAG=v0.5.0
SHA=$(git rev-parse "$TAG^{commit}")
gh api "repos/$REPO/actions/workflows/deploy.yml/runs?head_sha=$SHA" \
  --jq '[.workflow_runs[] | select(.event == "push")][0]
        | {id, head_branch, event, created_at, status, conclusion}'
# must be: status=completed, conclusion=success — and head_branch == $TAG
```

Why `select(.event == "push")` and not simply the newest run at that SHA:

- the **`--ref main` dispatch below shares this SHA** (main's tip *is* the tag
  commit) and sorts NEWER than the tag run. Reading the newest run would report
  the dispatch's `success` and green-light the back-merge past a **cancelled
  tag run** — precisely the failure this step exists to catch. It is
  `workflow_dispatch`, so the filter excludes it;
- the **merge-push run** shares the SHA and is also `push`, but it was created
  before the tag run, so "newest push" still resolves to the tag run;
- a **re-run** replays the original event, so a re-run tag run stays `push` and
  stays selectable (its `conclusion` reflects the latest attempt).

`head_branch` is printed as a cross-check, not used for selection: if it is not
`$TAG`, something else pushed at this SHA — stop and investigate rather than
back-merging.

**2. Production actually serves the clean tag.** Open
`https://docgerd.github.io/sail_command/` in a real browser (hard-reload — the
SW serves the old bundle otherwise) and confirm the **About dialog shows
`vX.Y.Z`**, not `vX.(Y-1).Z-N-g<sha>`.

If the tag run was cancelled, or the version string still carries a suffix,
re-run it before back-merging:

```bash
gh api "repos/$REPO/actions/runs/<id>/rerun" --method POST
```

**Whenever the drift-baseline format or the prod cache key changes** (as in
#197), a main-mode dispatch is what re-establishes a usable baseline for
develop deploys early — but it is only effective once `main` already contains
that change: `--ref main` resolves the workflow FILE from `main`'s own tip, so
dispatched before the change has reached `main` it runs the OLD workflow and
publishes the OLD baseline shape, changing nothing (measured on #197: a
dispatch run before this release's merge/tag published a baseline with no
`version.txt`). Until the change reaches `main` — i.e. until step 4 or 5 above
completes for the release that carries it — every develop deploy runs a
known-degraded but GREEN cycle instead: full prod rebuild, a `::warning::`,
`baseline-verified=false`, no cache save. Production still gets correct bytes
(the determinism double-build proves that); only the cross-run drift check is
unavailable for that interval, and it ends on its own once the cut lands. From
that point on, dispatching seeds the baseline immediately rather than waiting
for the next develop push to do it:

```bash
gh workflow run deploy.yml --ref main
```

## 5c. Verify the GitHub Release exists (#175)

**Why this step exists.** At the v0.6.0 cut every other signal was green —
tag pushed, deploy `success`, About dialog showing the clean `v0.6.0`,
production verified serving it — and still **no GitHub Release object was
ever created**. Nobody noticed until the maintainer happened to check the
project page; none of the other green signals was evidence a Release
existed, because a git tag and a GitHub Release are different objects.

**The mechanism (as of this runbook).** The tag push in step 5 also triggers
`.github/workflows/release.yml`, which extracts the matching
`## [X.Y.Z]` section from `CHANGELOG.md` and runs:

```bash
gh release create "$TAG" --notes-file <extracted-section> --latest --verify-tag
```

Both flags are load-bearing: without `--latest`, the **previous** version
keeps the "Latest" badge — a silent wrong state, not an error — and
`--verify-tag` aborts if the tag hasn't actually reached the remote yet
(it does **not** check a cryptographic signature; unrelated to #222).
The workflow declares no `concurrency:` group at all, so it cannot cancel or
be cancelled by `deploy.yml`'s `pages` group (see 5b) — the two runs are
fully independent.

**Verify it actually ran** — a green workflow run is not proof either,
per the same lesson as 5b. **`gh release view` has no `isLatest` field**
(measured: `gh release view "$TAG" --json tagName,isLatest` →
`Unknown JSON field: "isLatest"` — `isLatest` exists only on `gh release
list`). Using `view` here would fail on the very first execution of this
step (the v0.7.0 cut) with a message indistinguishable from "no Release was
created" — exactly the defect this step exists to catch. Use `list`,
filtered to the tag, which checks existence and the Latest badge together:

```bash
REPO=DocGerd/sail_command
TAG=vX.Y.Z
: "${TAG:?bind TAG=vX.Y.Z first}"
gh release list --repo "$REPO" --json tagName,isLatest \
  --jq '.[] | select(.tagName == "'"$TAG"'")'
```

Empty output = no Release (fall back below). A line with `"isLatest":false`
means the Release exists but the badge is on the wrong version. Confirm the
release exists **and** `isLatest` is `true`.

The automated title is the bare tag (`--title "$TAG"`); existing releases mix
bare tags (`v0.5.1`, `v0.4.0`) and themed titles (`v0.5.0 — chart orientation
and scale`, `v0.6.0 — depth comfort and honest recommendations`) — retitle by
hand afterward if a theme is wanted: `gh release edit "$TAG" --title '...'`.

**Known bootstrap gap, and the manual fallback.** Exactly like `deploy.yml`
(#197), a `push` on a tag resolves the workflow FILE from the **tag's own
commit** — so `release.yml` only fires if that file is already present on
`main` by the time the tag is pushed. The PR that adds `release.yml` (#175)
must reach `main` (merge + back-merge, or be included in the same release
PR) before its own tag can trigger it; a tag pushed earlier silently gets no
automated Release, same failure class the step exists to close. If the
`gh release list` check above comes back empty, create it by hand instead of
treating the gap as done — read `CHANGELOG.md` from the **tag**, not the
local working tree, so the notes match exactly what shipped even if the
local checkout is on a different branch. `--repo "$REPO"` is bound
explicitly in this block: Bash cwd persists across a session, and this
snippet runs only after something has already gone wrong — a stale scratchpad
cwd turning into a spurious `not a git repository` here costs the operator
the wrong diagnosis mid-incident. The `awk` terminator is anchored to the
link-reference shape (`[label]: url`), matching `release.yml`'s extractor —
the two copies are each other's only cross-check, so they must not diverge:

```bash
TAG=vX.Y.Z
REPO=DocGerd/sail_command
VERSION=${TAG#v}
git show "$TAG:CHANGELOG.md" | awk -v ver="$VERSION" '
  /^## \[/ { if (f) exit; if (index($0, "## [" ver "]") == 1) f = 1; next }
  /^\[[^]]*\]: / { if (f) exit }
  f        { print }
' > /tmp/release-notes.md
gh release create "$TAG" --repo "$REPO" --notes-file /tmp/release-notes.md --latest --verify-tag
```

## Gotchas

- **PR-only** per the `protect-main` ruleset: review threads resolved, merge
  commits only, no force pushes or deletions (on `main` and `develop` both).
- `gh pr view` / `gh pr edit` / `gh issue view` hit the Projects-classic
  GraphQL deprecation bug — use the REST fallback
  `gh api repos/OWNER/REPO/pulls/N` (`.../issues/N`).
- Update a PR body via `gh api repos/OWNER/REPO/pulls/N --method PATCH --input
  body.json`, **never** `gh pr edit`.
