---
name: merge-train
description: The main-session serial merge loop for SailCommand develop PRs — arm a check-runs Monitor, verify head.sha before merging, merge, re-sync the next PR, and recover from #119 stale-SHA and #94 504 near-misses. Use when merging one or more feature/chore PRs into develop. Triggers on /merge-train.
---

# Merge-train: the develop serial merge loop

Drives feature/chore PRs into `develop` from the **main session** — the loop is
hand-driven on purpose: the watcher *agent* oversleeps (#176), so **you** arm
the Monitor and merge on green. This skill is the develop loop only. A RELEASE
(`develop` → `main`) is user-gated and lives in the `release` skill — never
merge to `main` from here.

## Preconditions

- Merges are **PR-only** under the `protect-main` ruleset (covers `main` AND
  `develop`): merge **commits** only (never squash/rebase), all review threads
  resolved, required checks `app` + `e2e` green, no force pushes/deletions.
- **Merge strictly serially.** Develop PRs in parallel, merge one at a time —
  the strict up-to-date policy applies on `develop` too, so each merge staleifies
  every other open PR's base.

## The loop (repeat per PR, serially)

1. **Pick the next PR** and confirm its review threads are resolved.
2. **Arm a check-runs Monitor** on the PR head SHA (see below) — don't delegate
   this to a watcher agent (it oversleeps). Nudge yourself on green.
3. **On green: run the pre-merge verification LAW** (below) — head.sha ==
   pushed SHA AND check-runs exist for that exact SHA.
4. **Merge** with `gh pr merge <N> --merge --delete-branch` (merge commit).
5. **Reconcile** if the merge call errored — apply the #94 504 procedure before
   any retry.
6. **Re-sync the next PR** server-side: `gh api repos/OWNER/REPO/pulls/<next>/update-branch --method PUT`,
   then go to step 2 for it (full ~10-min CI re-runs under the strict policy).

## Pre-merge verification LAW (#119) — mechanised, still confirm

Before ANY merge, verify both:

- **head.sha == the SHA you pushed.** The proxy: the PR object's `head.sha`
  equals the live branch-ref tip. A mismatch means GitHub dropped a
  `synchronize` webhook, so the PR's green checks describe a **stale** commit and
  merging would silently drop the fix pushed after them.
- **check-runs EXIST for that exact head SHA** (checks ran for this commit, not a
  predecessor).

The `premerge-verify.sh` PreToolUse hook (#177) now enforces this mechanically:
it **denies** `gh pr merge` on a stale head or zero check-runs, and **asks**
(never hard-blocks) when it cannot verify (fork/deleted branch, API/auth
failure). The hook is a backstop, not a substitute — read its reason string and
resolve the actual cause; do not `ask`-approve past a `deny` without fixing it.

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
SHA=$(gh api "repos/$REPO/pulls/<N>" --jq .head.sha)          # PR object head
TIP=$(gh api "repos/$REPO/git/ref/heads/<branch>" --jq .object.sha)  # live tip
gh api "repos/$REPO/commits/$SHA/check-runs" --jq '.total_count'     # must be > 0
# SHA == TIP AND count > 0  ->  safe to merge
```

## Arming the check-runs Monitor

`gh pr checks` has **no** `--json` on this build — poll the API instead. Exit
codes for `gh pr checks`: `0` all pass, `8` pending, anything else failing.
**Foreground-test the poll command ONCE before arming** (CLAUDE.md poll-loop
gotcha — a `cmd 2>/dev/null || retry` that always fails reads as eternal
silence):

```bash
gh api "repos/$REPO/commits/$SHA/check-runs" \
  --jq '[.check_runs[] | {name, status, conclusion}]'
```

- `mergeable_state: unstable` = only **optional** checks red → still mergeable
  (required checks are `app` + `e2e` only).
- Scorecard's `analysis` job reds **every** push to `main` by design
  (default-branch-only action, #124) — a release commit carries one cosmetic red
  check-run; don't chase it.

## #119 stale-SHA rerun (PR head stuck on an old SHA)

Symptom: all-green checks + `mergeable_state: clean` but `head.sha` != the SHA
you pushed (dropped `synchronize` webhook). **Do not merge** — you would drop the
fix.

1. **REST close → reopen** the PR to resync `head.sha` to the branch tip.
2. This fires **two** `pull_request` events whose shared concurrency group can
   cancel the fresh run's jobs. **Cancel the stale-SHA workflow run first**
   (verify its `.head_sha` matches the OLD sha), then
   `POST repos/OWNER/REPO/actions/runs/<id>/rerun` for the fresh SHA.
3. Re-verify head.sha == pushed SHA and check-runs exist, then merge.

## #94 504-reconcile (merge call errored)

A GitHub **504 during `gh pr merge`** can **land** the merge (base ref updates,
merge commit created) yet leave the PR marked `open`, skipping branch-delete and
`Closes #` auto-close. **Never blind-retry** — a double-merge or a confusing
`behind` follows.

1. **Check whether it merged**: is the PR's head SHA a parent of the current
   `develop` tip? (`git fetch origin develop`; inspect merge-commit parents.)
2. **If merged**: reconcile manually — close the PR, delete the branch, close
   the `Closes #<n>` issue.
3. **If not merged**: it is safe to retry the merge.

## Gotchas

- `gh pr view` / `gh pr edit` / `gh issue view` hit the **Projects-classic**
  GraphQL deprecation bug — use REST: `gh api repos/OWNER/REPO/pulls/N`
  (`.../issues/N`). Update a PR body via
  `gh api repos/OWNER/REPO/pulls/N --method PATCH --input body.json`, never
  `gh pr edit`.
- PR review threads live under the `pullRequest.reviewThreads` GraphQL path
  (unaffected by the classic bug); resolve each with `resolveReviewThread`.
- The destructive-git guard pattern-matches `-f` anywhere in a compound Bash
  call — never combine `gh api -f …` with `git push` in one command; split them.
