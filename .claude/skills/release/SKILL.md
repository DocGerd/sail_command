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
dialog, so steps 5–5d below are load-bearing, not bookkeeping.

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
  into a new `## [X.Y.Z] - <date>` section (today's date, ISO). For each
  fragment file, read its category from the filename
  (`<number>.<category>.md`, optionally `<number>-<n>.<category>.md` to
  disambiguate a second fragment about the same issue/PR —
  added/changed/deprecated/removed/fixed/security) and its text from the
  file's content, then write a `- <text>` bullet under the matching
  `### Category` heading (create the heading if this cut's first entry in
  that category; category order is Added, Changed, Deprecated, Removed,
  Fixed, Security, matching `app/src/lib/changelogFragments.ts`'s
  `CATEGORY_ORDER`). Fold only files matching that shape — the build itself
  SKIPS a misnamed file with a console warning rather than failing
  (`README.md` itself is skipped SILENTLY, no warning at all — it's the
  expected always-present file, not an error case), so also check the build
  log / run `ls changelog.d/` against the filename pattern by eye before
  deleting anything: a fragment that got silently skipped at BUILD time (typo'd
  category, missing number) is invisible in the About dialog's preview too,
  and a fold step that only iterates "everything except README.md" would
  fold its raw filename as if it were valid instead of catching the typo.
  **Delete every folded fragment file** — leave only
  `changelog.d/README.md`. Update the two comparison links at the bottom: add
  `[X.Y.Z]: …/compare/vX.Y.(Z-1)...vX.Y.Z` and re-point `[Unreleased]` at
  `…/compare/vX.Y.Z...HEAD`. `CHANGELOG.md`'s `## [Unreleased]` heading itself
  stays — it is what re-fills from the NEXT batch of fragments — it should
  just have no categories under it right after a cut (the fragment directory
  is what carried the pending content, not that section). This fold is a
  human/agent step, same as the rest of this docs sweep: no CI step can
  commit the assembled content back into `CHANGELOG.md` on `develop`
  (protected, PR-only), which is why fragments are assembled only at BUILD
  time (for the About dialog's live preview) and folded into the file only
  HERE, at the cut.

  🛑 **If `changelog.d/` holds no fragments at all (and `[Unreleased]` is
  already empty)**: do **NOT** create an empty `## [X.Y.Z]` section just to
  bump the version — measured (constructed and run, not predicted; see
  #189's PR #352 review): a version heading with nothing under it fails
  `changelog.test.ts`'s *"no release section may parse to zero entries
  except Unreleased"* assertion (a REQUIRED `app` check — the release PR
  itself goes red), fails `release.yml`'s tag-push extraction (`::error::No
  CHANGELOG.md section found for [X.Y.Z]`, exit 1 — arriving AFTER the
  merge and the deploy, the worst point to discover it), and renders as
  nothing in the About dialog (`ChangelogView` filters any all-empty
  release), permanently freezing that version's entry into blankness. So:
  CLAUDE.md's general rule — that rolling a NON-EMPTY set of fragments into a
  release needs no test edits, because `changelog.test.ts` pins only the
  released tail and an ordinary cut can never force an assertion edit —
  simply does not reach this case. The fix is the SECTION, not the tests: it
  must be non-empty. Two ways to make it so, in order:
  1. **Almost always the right one.** Review the milestone's merged PRs
     (`gh pr list --repo DocGerd/sail_command --state merged --base
     develop --search "milestone:vX.Y.Z"`, or the merge log since the
     previous tag) and hand-write the real user-visible changes as
     `### Category` / `- text (#N)` entries — this is exactly what a
     contributor's fragment would have said had they added one; a release
     genuinely shipping zero fragments almost never means zero user-visible
     work, it means the ritual was skipped (e.g. every in-flight PR was
     deliberately told not to add one, as during the fragment mechanism's
     own #189 rollout).
  2. **Only if that review turns up genuinely nothing user-visible** (a
     pure tooling/infra/docs cut) — write ONE honest bullet under
     `### Changed` saying so, e.g. `- No user-visible changes in this
     release.` Still a real, non-empty entry; still passes both checks.
  Verify before opening the release PR: `npm --prefix app run test --
  changelog` must be green, AND manually run `release.yml`'s own awk
  extraction against the local `CHANGELOG.md` to confirm it yields a
  non-empty body before relying on the tag-push workflow to do it live:
  ```bash
  awk -v ver="X.Y.Z" '
    /^## \[/ { if (f) exit; if (index($0, "## [" ver "]") == 1) f = 1; next }
    /^\[[^]]*\]: / { if (f) exit }
    f        { print }
  ' CHANGELOG.md | grep -q '[^[:space:]]' && echo "non-empty, OK" || echo "EMPTY — fix before tagging"
  ```
- **`ROADMAP.md`** — update `Current release:` and promote Now → Next: the
  shipped milestone's section goes away, the next one becomes "Now". Re-check
  every issue number named there against the tracker; this file was wrong
  within a day of being written. **Bump `Current release:` HERE, in the same
  commit — do not defer it to step 6.** The tag not existing yet is not a
  reason to wait: this same commit already writes `## Now — vX.Y.Z` below it
  and `CHANGELOG.md`'s own `## [X.Y.Z] - date` heading, both forward-dated by
  the identical margin, and `34b908e` deferred `CONTRIBUTING.md`'s
  closed-milestone range on that same reasoning — so it was never a property
  of this one field. Deferring it is what makes the sweep commit contradict
  itself: measured at the v0.12.1 cut, where `34b908e` left `Current release:
  **v0.12.0**` in the same commit as its own `## Now — v0.12.1` header (the
  same shape as `4f18383` and `4fe0890` at the v0.10.0 and v0.11.0 cuts),
  caught by a review round before the release PR merged and fixed in
  `79d82c5`. Step 6 verifies this field; it does not set it.
- **`README.md`** — re-verify the known-limitations section actually still
  describes the shipped build.
- **`GOVERNANCE.md`** — it carries a standing release duty and is re-read at
  each cut; confirm roles and release mechanics still match reality.
- **`docs/security-assurance-case.md`** — the OpenSSF Silver assurance
  document; re-check it still describes the shipped security posture (#168).
- **`CONTRIBUTING.md`** — the milestone list names the *next* release; roll it.
- **`SECURITY.md`** — added to this list at the v0.12.0 cut (2026-08-19), where
  it was found to be a FOURTH site of the decaying release-tag enumeration that
  §7/T5/A08 of the assurance case also carry. Prefer a RULE plus a
  reader-runnable `gh api …/git/tags/$(git rev-parse refs/tags/vX.Y.Z) --jq
  .verification` over any list of tags checked so far. Note its pre-`v0.8.0`
  unsigned enumeration is a CLOSED set and correctly does NOT decay — do not
  "fix" it.
- **`docs/acceptance.md`** — added at the same cut, and the sharper case: a
  stale check here does not merely misinform, it makes a tester file a bug
  against correct behaviour. §2.5/§3.4 asserted the faster rig is starred,
  which is false whenever `compareRigs` returns `tie`/`moot` AND for both
  tier-C fleet boats, where `comparisonSuppressed` withholds the ★ entirely.
  Re-check every check whose expected outcome depends on the selected boat.
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
| 5 | Tag, **verify the signature**, then push | After merge (which already triggered `deploy.yml` on the push to `main`), tag `main` with a **signed** semver tag (e.g. `v0.8.0`), run `git tag -v` and confirm it prints `Good "git" signature for <identity>` BEFORE pushing (a failure here means STOP, do not push), then push it. **Assert the ref first, and use the fail-closed `\|\|`-chained commands — see 5a.** That tag push triggers a SECOND deploy run — the one that bakes the clean `vX.Y.Z`, since `git describe` could not see the tag during the merge run (#197) — **and** a `release.yml` run that cuts the GitHub Release object automatically (#175, see 5c). |
| 5b | 🛑 **WAIT for the tag deploy, then verify** | **Do not push or merge anything to `develop` until this passes** — see the cancellation hazard below. |
| 5c | 🛑 **Verify the GitHub Release exists** | Now automated (#175) — the tag push also triggers `release.yml`. A green 5b is not evidence this happened; see 5c below. |
| 5d | 🛑 **Verify GitHub shows the tag/Release as Verified** | The local `git tag -v` in step 5 proves the signature to this machine only — 5d checks the badge a third party actually sees. See 5d below. |
| 6 | BACK-MERGE `main` → `develop` | Open a `chore/backmerge` PR into `develop` so `develop` stays strictly ahead of `main`. Full CI re-runs. This is a develop-merge — the assistant may merge it directly. **Verify `ROADMAP.md`'s `Current release:` line already names the tag just pushed** — §2b bumps it in-sweep, forward-dated by the same margin as the `## Now — vX.Y.Z` header and the `## [X.Y.Z] - date` CHANGELOG heading that same commit already writes. If §2b skipped it, bump it here. Deferring it to this step was the earlier convention (`f422fa1`, `435eb3a`, `70f80da`, `47d189f` each bumped it on a `chore/backmerge` branch and each worked) and is dropped because it left the sweep commit contradicting itself — `34b908e`, v0.12.1. |

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
SIGNING_EMAIL=13460098+DocGerd@users.noreply.github.com   # the noreply identity; see CONTRIBUTING.md "Tagger identity"

git fetch origin main:main                  # ref update, no checkout needed
[ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ] || { echo "local main != origin/main"; exit 1; }
[ "$(git rev-parse main)" = "$MERGE_SHA" ]  || { echo "main is not the release merge commit"; exit 1; }
[ "$(git config --get user.email)" = "$SIGNING_EMAIL" ] \
  || { echo "tagger email is not the registered noreply identity — set it repo-locally (git config user.email $SIGNING_EMAIL), see CONTRIBUTING.md"; exit 1; }

git tag -s "$TAG" -m "$TAG" main            || { echo "tag creation failed"; exit 1; }
git tag -v "$TAG"                           || { echo "SIGNATURE NOT GOOD — do not push"; exit 1; }
git push origin "$TAG"                      || { echo "PUSH FAILED — a GH007 email-privacy rejection means the identity check above passed but GitHub still rejects it; see CONTRIBUTING.md's third failure mode"; exit 1; }
```

`git fetch origin main:main` updates the ref without a checkout; it REFUSES
while `main` is the currently checked-out branch (it will not be here — the
cut runs from `develop`).

**Signed, starting `v0.8.0` (#322).** 7 of the 10 tags shipped before this
cut are lightweight, and a lightweight tag is a bare ref — it cannot carry a
signature at all, which is why annotated (`-a`) was the prerequisite step
(#222) before signed (`-s`) could follow. `-s` implies annotated, so this
replaces `-a` rather than adding to it. `-m "$TAG"` is still required, not
cosmetic: a bare `git tag -a`/`-s` with no message opens `$EDITOR` and hangs
a non-interactive/agent shell. This is **verified safe** against the
About-dialog version string: `vite.config.ts`'s `appVersion()` calls `git
describe --tags --always`, which resolves lightweight, annotated, and signed
tags identically, so switching tag *kind* changes nothing `git describe`
reports.

**`git tag -v "$TAG"` BEFORE the push is the point of #322, and every command
in the block above — including the identity assertion and the push itself —
is `||`-guarded with an early exit, not a bare line.** This is a BLOCKING
guard (it exists to stop an unverified or unattributed tag from reaching
production), so per `CLAUDE.md`'s guard-asymmetry rule it must fail CLOSED:
any failure in the ref/identity assertions, tag creation, verification, or
the push itself must stop the sequence, never fall through silently. The
pre-#322 form (`git tag -a "$TAG" -m "$TAG" main && git push origin "$TAG"`)
was already fail-closed via `&&` for the tag-creation half; the `||`-guarded
lines above extend that same fail-closed property to the identity check, the
verification step, and the push. `git tag -v` must print `Good "git"
signature for <identity> with ED25519 key SHA256:...`; anything else
(`error: no signature found`, `gpg.ssh: unable to find identity referenced
by`, `No principal matched` after an otherwise-`Good` first line, etc.) is a
non-zero exit that the `||` guard catches — do not push the tag — and fix the
local `gpg.format ssh` / `user.signingkey` / `gpg.ssh.allowedSignersFile`
config first (one-time setup: `CONTRIBUTING.md`'s "Release tag signing"
section). The identity assertion catches a stale/wrong `user.email` BEFORE a
signature is even attempted; the push guard catches the one failure mode
that survives a *correct* local signature and a *correct* identity check —
GitHub's email-privacy push rejection (`GH007`), which happens on the wire,
after everything upstream of it already passed. See `SECURITY.md`'s
"Verifying a release" section for the full verification story, including for
third parties who don't have this machine's local config, and
`CONTRIBUTING.md`'s "Tagger identity" section for why all three checks exist.

**Constructed proof the chain is fail-closed** — four cases, run verbatim
against the AMENDED (four-guarded-step) chain in a throwaway local clone
carrying this machine's signing config (push line replaced with a `>>>`
marker so nothing was actually pushed; every throwaway tag was deleted
afterward). Re-run in full for this revision of the doc, not carried over
from the three-command chain the block used to test — the identity
assertion added earlier in this section changes what Case 4 (below) needs
to look like to still be a happy path:

Case 1 — tagger identity is not the registered noreply address (the exact
`v0.8.0` gap: `user.email` resolves to the machine's global
`live@docgerdsoft.de`, with no repo-local override in effect — exercises the
identity assertion added in this revision, which now runs BEFORE tag
creation):

```
$ git config --get user.email
live@docgerdsoft.de
$ SIGNING_EMAIL=13460098+DocGerd@users.noreply.github.com
$ [ "$(git config --get user.email)" = "$SIGNING_EMAIL" ] \
    || { echo "tagger email is not the registered noreply identity — set it repo-locally (git config user.email $SIGNING_EMAIL), see CONTRIBUTING.md"; exit 1; }
tagger email is not the registered noreply identity — set it repo-locally (git config user.email 13460098+DocGerd@users.noreply.github.com), see CONTRIBUTING.md
script exit: 1
```

(No tag object was ever created — `git tag -s` was never reached, confirmed
by `git tag -l 'zzz*'` printing nothing afterward. The chain fails closed
AND early: no tag, signed or not, is at risk of being pushed under the
wrong identity.)

Case 2 — a real unsigned tag already in this repo (the exact failure the
pre-fix chain let through):

```
$ TAG=v0.5.0
$ git tag -v "$TAG"                           || { echo "SIGNATURE NOT GOOD — do not push"; exit 1; }
$ echo ">>> REACHED THE PUSH LINE (would run: git push origin $TAG)"
error: no signature found
SIGNATURE NOT GOOD — do not push
script exit: 1
```

(`>>> REACHED THE PUSH LINE` never printed — `exit 1` inside the `||` block
stopped the script before it. Unaffected by the identity assertion, since
this case verifies a tag that already exists rather than creating one.)

Case 3 — a validly signed tag verified against a BROKEN
`gpg.ssh.allowedSignersFile` (the eyeball trap: the first line still reads
`Good "git" signature`, and only `No principal matched` a few lines later
says it failed):

```
$ TAG=zzz-b1-blocker-test
$ git tag -s "$TAG" -m "$TAG" main            || { echo "tag creation failed"; exit 1; }
$ git -c gpg.ssh.allowedSignersFile=/nonexistent/path tag -v "$TAG" || { echo "SIGNATURE NOT GOOD — do not push"; exit 1; }
$ echo ">>> REACHED THE PUSH LINE (would run: git push origin $TAG)"
Good "git" signature with ED25519 key SHA256:TIoKycz7HSEZF70gp+bJA6dLxK4dhUYWbSkRX+nN8ts
Unable to open allowed keys file "/nonexistent/path": No such file or directory
sig_find_principals: sshsig_find_principal: No such file or directory
No principal matched.
SIGNATURE NOT GOOD — do not push
script exit: 1
```

(again, `>>> REACHED THE PUSH LINE` never printed — the exit-code gate, not
the eyeball, is what caught this one. The signature's own identity string is
absent either way here — an unmatched principal never resolves one — so this
case is also unaffected by which email tagged it.)

Case 4 — a validly signed tag, tagged AND verified under the correct
(adopted) noreply identity, against the correct local config (the happy
path, confirming the amended chain does not block a good, correctly
attributed signature — this replaces the old Case 3, which used to tag
under `live@docgerdsoft.de` and would now fail at the identity assertion
before ever reaching this point):

```
$ git config --get user.email
13460098+DocGerd@users.noreply.github.com
$ TAG=zzz-b1-success-test
$ [ "$(git config --get user.email)" = "$SIGNING_EMAIL" ] \
    || { echo "tagger email is not the registered noreply identity — set it repo-locally (git config user.email $SIGNING_EMAIL), see CONTRIBUTING.md"; exit 1; }
$ git tag -s "$TAG" -m "$TAG" main            || { echo "tag creation failed"; exit 1; }
$ git tag -v "$TAG"                           || { echo "SIGNATURE NOT GOOD — do not push"; exit 1; }
$ echo ">>> REACHED THE PUSH LINE (would run: git push origin $TAG)"
Good "git" signature for 13460098+DocGerd@users.noreply.github.com with ED25519 key SHA256:TIoKycz7HSEZF70gp+bJA6dLxK4dhUYWbSkRX+nN8ts
>>> REACHED THE PUSH LINE (would run: git push origin zzz-b1-success-test)
script exit: 0
```

Exit codes observed: **1, 1, 1, 0** — three failure shapes (wrong tagger
identity, a real unsigned tag, and a validly-signed tag verified against a
broken local config) all stop before the push line and all exit non-zero;
the happy path — correct identity, correct signature, correct local
config — reaches it and exits zero. That is the fail-closed property,
demonstrated rather than read, now against all four guarded steps of the
amended chain rather than the original three.

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

If the tag run was **cancelled**, check whether its own `deploy` job had
already completed before assuming a re-run is safe — `concurrency:
cancel-in-progress` can catch a run at ANY point (the hazard above), including
after `deploy` (and therefore the Pages deployment for that SHA) already
finished, e.g. mid-`smoke-probe`:

```bash
gh api "repos/$REPO/actions/runs/<id>/jobs" --jq '.jobs[] | select(.name=="deploy") | {conclusion}'
```

- `conclusion` is `null` (job never ran), `cancelled`, or `failure`: no
  deployment for this SHA was created by this run — re-running is the correct
  remedy, since there is no earlier deployment of that SHA for it to collide
  with:

  ```bash
  gh api "repos/$REPO/actions/runs/<id>/rerun" --method POST
  ```

- `conclusion` is `success`: this SHA is **already deployed** by this run (it
  was cancelled somewhere after `deploy`, not before) — re-running would
  redeploy the identical SHA and hit the same-SHA no-op below instead of the
  cancelled-run case. Verify check 2 directly rather than re-running; if it
  still fails, treat it as the block immediately below, not as a cancellation.

🛑 **If instead the tag run's `smoke-probe` job itself went RED with a
`#398` error, or (on an older `deploy.yml` predating #398) it reported
`success` while check 2 still shows a suffixed version string — do NOT
re-run it.** Both are the same failure: GitHub Pages keys a deployment by
commit SHA, and the merge-push run and the tag-push run deploy the
IDENTICAL `main` commit, so the first deployment of that SHA wins and the
second silently no-ops. Re-running redeploys the SAME SHA again and
reproduces the SAME no-op — measured twice at the v0.9.0 cut, both attempts
green, neither changed the served bytes (`smoke-probe`'s CDN-Range check
couldn't see it either, since the probed basemap archive is byte-identical
between the two builds). `deploy.yml`'s `smoke-probe` job is now
version-aware (#398 — see the CLAUDE.md deploy-architecture note for the
mechanism) and turns this into a hard job failure instead of a false
`success`, but the FIX is unchanged either way: skip straight to **step 6**
(the back-merge) instead of re-running. That PR's own push carries a
DIFFERENT commit SHA, so its deploy run cannot collide with the stuck one
and republishes prod correctly with the tag now visible. Re-verify check 2
(the About dialog) against production again once that back-merge's deploy
run goes green, before treating the cut as fully shipped.

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
`--verify-tag` aborts if the tag hasn't actually reached the remote yet. It
does **not** check the tag's cryptographic signature — that check is `git
tag -v` in step 5a, a separate, local, and required step; `--verify-tag`
only confirms the ref exists on the remote.
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

## 5d. Verify GitHub shows the tag/release as Verified (#322)

`git tag -v` in step 5 (the fail-closed chain in §5a) proves the signature to THIS machine, using its own
local `gpg.ssh.allowedSignersFile`. It does not prove anything to a third
party browsing GitHub — that is what the green **Verified** badge is for,
and it depends on a *separate* piece of state: the public key registered at
GitHub's SSH **signing**-key endpoint (`github.com/settings/ssh/new`, key
type "Signing Key"). The maintainer's key is registered there as of this
writing, so this is a genuine pass/fail check, not a likely-benign warning —
confirm both:

- The tag's commit page (`github.com/DocGerd/sail_command/commit/<sha>` or
  the tag view) shows **Verified** next to the commit.
- The Release page (created in 5c) shows **Verified** next to its tag.

If either does not show Verified, treat it as a real failure and investigate
before proceeding — do not wave it through as expected.

**If GitHub ever shows Unverified while `git tag -v` was Good** (e.g. after a
key rotation, or for a successor's own key before they've registered it),
don't read that as a bad signature — the tag IS cryptographically signed;
GitHub just doesn't have the public key to check it against yet. The likely
cause is the key being registered only in the *authentication*-key registry
(`github.com/<user>.keys`) and not the separate *signing*-key one, or not
registered at all — see `SECURITY.md`'s "Verifying a release" section for
why the two registries are distinct. Fix the registration, not the signing
config.

**Two further, independent gaps give a similar or worse symptom — both keyed
off the tagger EMAIL, not the key — and `git tag -v` is Good through both.**
The v0.8.0 tag hit the first: key correctly registered, signature good,
badge still Unverified, because the tag was created under the machine's
*global* `user.email` (`live@docgerdsoft.de`), which was not registered on
the GitHub account at all. The first attempted fix — a repo-local override
to `dev@docgerdsoft.de`, an email that *is* registered — hit the second,
worse gap: `dev@` is registered but marked **private**, and GitHub's
push-protection for private emails **rejects the push outright**:
`! [remote rejected] <tag> (push declined due to email privacy
restrictions)` / `GH007: Your push would publish a private email address`.
That one doesn't even reach the attribution check below — the tag never
lands on the remote.

Diagnose which of the three gaps (key registration, email registration,
email privacy) is in play with two checks:

```bash
# Attribution (key or email registration) — only meaningful once the tag is on the remote:
gh api repos/DocGerd/sail_command/git/tags/<tag-object-sha> --jq .verification

# Push-privacy — no API for this; read it straight off the push command's own
# output (a GH007 line), since a privacy-rejected tag never reaches GitHub.
```

(`<tag-object-sha>` is the annotated tag OBJECT's own SHA — `git rev-parse
refs/tags/vX.Y.Z` — not the commit it points at.) `reason: "no_user"` covers
BOTH the key-registration gap above and the email-registration gap — tell
them apart by checking `github.com/settings/keys` (the list of **registered**
Signing Keys — `github.com/settings/ssh/new` is the add-a-key *form*, not the
list, and won't tell you what's already registered) and
`github.com/settings/emails` separately. `no_user`, `unverified_email`,
`bad_email`, `unknown_key` and `not_signing_key` are the attribution/
registration family covered above — the last two are key-registration gaps
too (an unrecognized key, or one registered only for authentication rather
than signing), routed the same way as `no_user`'s key-registration cause.
`bad_signature`, `malformed_signature`, `invalid`, `expired_key` and
`unknown_signature_type` are different: those are real signature or key
problems, not a registration gap — don't send someone to check email/key
registration for one of those; investigate the signature itself instead.

**The adopted fix, in place in THIS clone since the v0.8.1 correction, and
required in every other clone/worktree/machine that tags a release**: a
repo-local `user.email` set to the account's GitHub-provided **noreply**
address (`13460098+DocGerd@users.noreply.github.com`) — registered, and
always public by construction, so it clears all three gaps simultaneously.
Proven end to end: pushes without a `GH007`, `git tag -v` reports `Good "git"
signature for 13460098+DocGerd@users.noreply.github.com`, and the API
confirms `verified: true, reason: "valid"`. **This is per-clone state, not a
repo fact** — repo-local `user.email` lives in `.git/config`, which no diff
or commit can carry; a fresh clone, a worktree that skipped this step, or a
successor's machine still has the *global* `user.email` (`live@docgerdsoft.de`
on the maintainer's machine) and will reproduce case (2) unless it is set
again there. That is why §5a's chain now asserts it before tagging (see
above) rather than relying on this paragraph being read and remembered.

**Run the pre-flight probe below before every real release tag** — it is not
merely a nice-to-have: it is exactly what would have caught v0.8.0's gap
before it shipped, and it touches nothing `deploy.yml` or `release.yml`
react to. Run it **in the same clone that will create the real tag** — a
probe run elsewhere only proves that other clone's identity, which tells you
nothing about the one about to tag `main`:

```bash
TAG=zzz-signing-probe-$(date +%s)          # deliberately NOT v[0-9]*, so no workflow fires
git tag -s "$TAG" -m probe HEAD && git push origin "$TAG"   # tags the current commit; GH007 would surface right here
gh api repos/DocGerd/sail_command/git/tags/"$(git rev-parse "refs/tags/$TAG")" --jq .verification
git push origin ":refs/tags/$TAG" && git tag -d "$TAG"  # clean up either way — proven to work even if the push above failed
```

A valid signature, an attributable signature, and a *pushable* signature are
three different things — re-run the diagnostics above regardless of how
confident you are; only they tell you which of the three you actually have.

## Gotchas

- **PR-only** per the `protect-main` ruleset: review threads resolved, merge
  commits only, no force pushes or deletions (on `main` and `develop` both).
- `gh pr view` / `gh pr edit` / `gh issue view` hit the Projects-classic
  GraphQL deprecation bug — use the REST fallback
  `gh api repos/OWNER/REPO/pulls/N` (`.../issues/N`).
- Update a PR body via `gh api repos/OWNER/REPO/pulls/N --method PATCH --input
  body.json`, **never** `gh pr edit`.
