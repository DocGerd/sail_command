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
cancelled is the failure mode here. Both release runs share the tag commit's
SHA, so list them and read the NEWEST one (it is the tag run):

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
TAG=v0.5.0
SHA=$(git rev-parse "$TAG^{commit}")
gh api "repos/$REPO/actions/workflows/deploy.yml/runs?head_sha=$SHA" \
  --jq '.workflow_runs[] | {id, head_branch, event, created_at, status, conclusion}'
# newest entry must be: status=completed, conclusion=success
```

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
#197), also dispatch a main-mode run right after the merge so develop deploys
regain a usable baseline — otherwise *every* develop deploy rebuilds and
republishes prod unverified until the next release:

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
