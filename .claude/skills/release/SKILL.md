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
   (build then `preview` on port `4173`, `--strictPort`) — exact commands in
   the `verify` skill (production-bundle pass).
2. Real-browser walkthrough of the key flows: **plan** → **harbor combobox** →
   the **Ergebnis card**, in BOTH wide and narrow layouts and BOTH light and
   dark.
3. Present screenshots. **Wait for the user to explicitly approve.**

**Why:** `deploy.yml` pushes whatever lands on `main` straight to
`docgerd.github.io/sail_command`. There is no staging between merge and live —
the local walkthrough is the only pre-ship human check.

## 3–6. Release sequence

| # | Step | Detail |
|---|---|---|
| 3 | Open the RELEASE PR `develop` → `main` | Full CI (`app` + `e2e`) re-runs under the strict up-to-date policy of the `protect-main` ruleset. Merges as a **merge commit** — never squash/rebase. |
| 4 | USER merges | Merges to `main` are classifier-gated — **the user runs `gh pr merge`, not the assistant.** Wait for green required checks (`app` + `e2e`) first. `gh pr checks --json` is unsupported here — poll `gh api repos/OWNER/REPO/commits/SHA/check-runs` instead. |
| 5 | Tag + push | After merge (which already triggered `deploy.yml` on the push to `main`), tag `main` with a semver tag (e.g. `v0.5.0`) and push it. That tag push triggers a SECOND deploy run — the one that bakes the clean `vX.Y.Z`, since `git describe` could not see the tag during the merge run (#197). |
| 5b | 🛑 **WAIT for the tag deploy, then verify** | **Do not push or merge anything to `develop` until this passes** — see the cancellation hazard below. |
| 6 | BACK-MERGE `main` → `develop` | Open a `chore/backmerge` PR into `develop` so `develop` stays strictly ahead of `main`. Full CI re-runs. This is a develop-merge — the assistant may merge it directly. |

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

## Gotchas

- **PR-only** per the `protect-main` ruleset: review threads resolved, merge
  commits only, no force pushes or deletions (on `main` and `develop` both).
- `gh pr view` / `gh pr edit` / `gh issue view` hit the Projects-classic
  GraphQL deprecation bug — use the REST fallback
  `gh api repos/OWNER/REPO/pulls/N` (`.../issues/N`).
- Update a PR body via `gh api repos/OWNER/REPO/pulls/N --method PATCH --input
  body.json`, **never** `gh pr edit`.
