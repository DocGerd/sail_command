---
name: worktree-cleanup
description: Use when a git worktree created for an agent (implementer, reviewer, or otherwise) is finished with and needs to be removed — before running `git worktree remove`, or whenever asked to clean up / tear down / remove a worktree. Codifies the force-free teardown so `--force` and `rm -rf` are never needed. Triggers on /worktree-cleanup.
---

# Worktree cleanup (force-free teardown)

Removing a finished worktree most often fails for three predictable,
avoidable reasons: an untracked `node_modules`, a dirty wind-fixture diff, and
a wrong cwd (other causes exist — see step 3). Fix these three and
`git worktree remove` succeeds with **no** `--force`.

**Responsibility sits with the CREATOR of the worktree** — the agent that
made it, not the main session. `rm -rf` is permission-blocked even in the
main session, so a reviewer or implementer must clean its own tree before
handing back; a fresh agent pointed at the surviving worktree is the fallback
if the creator is gone.

## Steps (run from inside the worktree first, steps 1–2)

1. **Remove `node_modules` with `find`, never `rm -rf`.** `rm -rf` is
   permission-blocked in this environment; `find -delete` is not:

   ```bash
   find app/node_modules -delete
   ```

   An untracked `node_modules` is exactly what makes the worktree "dirty" and
   blocks removal — this step is why the rest of cleanup is needed at all. If
   the worktree never ran an install (e.g. a reviewer-only tree), `find` errors
   because `app/node_modules` doesn't exist — that's expected and harmless;
   nothing chains off its exit code.

2. **Restore the wind fixture if it's dirty.** Any worktree that ran e2e has
   regenerated `app/public/test-fixtures/wind-sw12.json` with fresh
   timestamps (the `pree2e` hook does this). Never commit it, never `--force`
   past it — restore it:

   ```bash
   git status --short -- app/public/test-fixtures/wind-sw12.json
   git checkout -- app/public/test-fixtures/wind-sw12.json   # if it shows dirty
   ```

3. **Confirm the tree is clean** before leaving it:

   ```bash
   git status --short
   ```

   Anything else showing here needs a real decision (commit, stash, or
   discard) — don't paper over it with `--force` in step 5.

## Steps (run from the main session / repo root, steps 4–5)

4. **`cd` to the repo root first.** `git worktree remove <path>` fails with
   "not a git repository" if the shell's cwd is somewhere else (a scratchpad,
   for instance) — and Bash cwd persists across calls in a session, so a cwd
   change several calls ago can silently still be in effect. This is the same
   trap that breaks `gh pr merge` and spawning worktree-isolated agents.

   ```bash
   cd <repo>
   ```

5. **Remove the worktree — no `--force`:**

   ```bash
   git worktree remove <absolute-path-to-worktree>
   ```

   If this still fails, go back to step 1–3 and find what's still dirty or
   untracked — don't reach for `--force`. Forcing can silently discard
   uncommitted work.

## Never touch

- `pipeline/data-src/` — an ~888 MB gitignored download cache. Re-downloading
  costs about an hour. Never delete it during any cleanup, worktree removal
  included.

## Gotcha reference

| Symptom | Cause | Fix |
|---|---|---|
| `git worktree remove` refuses without `--force` | untracked `app/node_modules` | step 1 |
| same, dirty `wind-sw12.json` diff | `pree2e` hook regenerated it | step 2 |
| "not a git repository" on an absolute path | cwd is elsewhere (persists across Bash calls) | step 4 |
