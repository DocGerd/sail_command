---
name: release
description: The develop→main release runbook for SailCommand's gitflow-lite. Cuts a release PR, tags main, and back-merges. Triggers on /release.
disable-model-invocation: true
---

# Cut a gitflow-lite release (`develop` → `main`)

A release ships to production: `deploy.yml` fires on every push to `main` and
publishes Pages at `https://docgerd.github.io/sail_command/`. `main` is
released-state-only. Whatever merges to `main` goes live immediately, so this
runbook is **user-only** and human-gated by design.

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
| 5 | Tag + push | After merge (which already triggered `deploy.yml` on the push to `main`, publishing Pages), tag `main` with a semver tag (e.g. `v0.3.0`) and push the tag as the release marker. |
| 6 | BACK-MERGE `main` → `develop` | Open a `chore/backmerge` PR into `develop` so `develop` stays strictly ahead of `main`. Full CI re-runs. This is a develop-merge — the assistant may merge it directly. |

## Gotchas

- **PR-only** per the `protect-main` ruleset: review threads resolved, merge
  commits only, no force pushes or deletions (on `main` and `develop` both).
- `gh pr view` / `gh pr edit` / `gh issue view` hit the Projects-classic
  GraphQL deprecation bug — use the REST fallback
  `gh api repos/OWNER/REPO/pulls/N` (`.../issues/N`).
- Update a PR body via `gh api repos/OWNER/REPO/pulls/N --method PATCH --input
  body.json`, **never** `gh pr edit`.
