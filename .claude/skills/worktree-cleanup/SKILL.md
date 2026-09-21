---
name: worktree-cleanup
description: Use when a git worktree created for an agent (implementer, reviewer, or otherwise) is finished with and needs to be removed — before running `git worktree remove`, or whenever asked to clean up / tear down / remove a worktree. Codifies the force-free teardown so `--force` and `rm -rf` are never needed. Triggers on /worktree-cleanup.
---

# Worktree cleanup (force-free teardown)

Removing a finished worktree most often fails for three predictable,
avoidable reasons: an untracked `node_modules`, a dirty wind-fixture diff, and
a wrong cwd (other causes exist — see step 3). Fix these three and
`git worktree remove` succeeds with **no** `--force`. Three more shapes are
NOT reasons to force: a **detached HEAD** worktree (no branch tied to it —
`git branch --show-current` inside it returns empty; nothing extra to clean
up, remove it exactly like a branch worktree), an **out-of-tree** worktree
(anywhere outside `.claude/worktrees/` — a session scratchpad, `/tmp`,
another agent's chosen path — `git worktree remove` doesn't care about
location, only that you `cd` to the repo root first and pass its absolute
path), and a **locked** worktree (fails with a specific, fixable error —
step 6 below).

**Responsibility sits with the CREATOR of the worktree** — the agent that
made it, not the main session. `rm -rf` is permission-blocked even in the
main session, so a reviewer or implementer must clean its own tree before
handing back; a fresh agent pointed at the surviving worktree is the fallback
if the creator is gone.

**Run each step below as a separate plain command** — see CLAUDE.md's
worktree-isolated-agent harness-refusal bullet for why.

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
   git restore -- app/public/test-fixtures/wind-sw12.json    # if it shows dirty
   ```

3. **Confirm the tree is clean** before leaving it:

   ```bash
   git status --short
   ```

   Anything else showing here needs a real decision (commit, stash, or
   discard) — don't paper over it with `--force` in step 7.

## Steps (run from the main session / repo root, steps 4–8)

4. **`cd` to the repo root first.** `git worktree remove <path>` fails with
   "not a git repository" if the shell's cwd is somewhere else (a scratchpad,
   for instance) — and Bash cwd persists across calls in a session, so a cwd
   change several calls ago can silently still be in effect. This is the same
   trap that breaks `gh pr merge` and spawning worktree-isolated agents.

   ```bash
   cd <repo>
   ```

5. **Find the worktree with `git worktree list`, don't assume it's under
   `.claude/worktrees/`.** An out-of-tree worktree (session scratchpad,
   `/tmp`, a reviewer's own path) doesn't show up in a `.claude/worktrees/*`
   glob — it's still registered and still needs cleanup. The listing also
   shows whether an entry is `locked`, which you need before step 7:

   ```bash
   git worktree list
   ```

6. **Unlock if locked.** A locked worktree refuses removal with a specific
   error naming the reason — `fatal: cannot remove a locked working tree,
   lock reason: <reason>` / `use 'remove -f -f' to override or unlock first`.
   Don't take the `-f -f` suggestion; unlock instead:

   ```bash
   git worktree unlock <absolute-path-to-worktree>
   ```

7. **Remove the worktree — no `--force`:**

   ```bash
   git worktree remove <absolute-path-to-worktree>
   ```

   If this still fails, go back to step 1–3 and find what's still dirty or
   untracked — don't reach for `--force`. Forcing can silently discard
   uncommitted work. A detached worktree removes exactly the same way — there
   is no separate branch to delete.

8. **Prune as a final sweep.** `git worktree remove` also succeeds cleanly on
   an entry whose directory is already gone by other means (a scratchpad that
   expired, a manual `find -delete` on the whole tree) — but if that path was
   never explicitly removed, its administrative entry lingers as `prunable`
   in `git worktree list`. Clear any such strays in one pass, force-free:

   ```bash
   git worktree prune -v
   ```

## Never touch

- `pipeline/data-src/` — an ~888 MB gitignored download cache. Re-downloading
  costs about an hour. Never delete it during any cleanup, worktree removal
  included.
- Any worktree you did not create or were not explicitly asked to remove —
  `git worktree list` shows every worktree in the repo, including other
  agents' live sessions. Only act on the one(s) named in your task.

## Gotcha reference

| Symptom | Cause | Fix |
|---|---|---|
| `git worktree remove` refuses without `--force` | untracked `app/node_modules` | step 1 |
| same, dirty `wind-sw12.json` diff | `pree2e` hook regenerated it | step 2 |
| `git checkout -- <path>` is DENIED by the permission system | a `deny` entry in the personal global `~/.claude/settings.json` — NOT the destructive-git hook, which has no `checkout` logic | use `git restore -- <path>`; step 2 |
| untracked throwaway files survive `git restore` | `restore` only touches TRACKED files | `find <dir> -name '<pattern>' -delete`, never `rm -rf` |
| "not a git repository" on an absolute path | cwd is elsewhere (persists across Bash calls) | step 4 |
| worktree isn't under `.claude/worktrees/` at all | it was created out-of-tree (scratchpad, `/tmp`, a reviewer's own path) | `git worktree list` finds it regardless of location; step 5 |
| `git branch --show-current` inside the worktree is empty | worktree is on a detached HEAD, not a branch | nothing extra to do — step 7 removes it the same way, no branch to delete |
| `fatal: cannot remove a locked working tree` | worktree was `git worktree lock`ed | step 6, then step 7 |
| an old worktree still lists as `prunable` after its directory is already gone | directory was deleted without `git worktree remove` (e.g. scratchpad expiry) | step 8 |
