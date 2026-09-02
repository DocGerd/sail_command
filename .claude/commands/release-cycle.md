---
description: Run one full SailCommand release cycle — re-triage the milestones (approval-gated), implement the whole release milestone, cut the release, revise CLAUDE.md, housekeep.
argument-hint: "[target milestone, e.g. v0.18.0 — optional; discovered if omitted]"
---

**Target milestone:** $ARGUMENTS — if that is empty, DISCOVER the target in Phase 0 and name it
back to me before proceeding. If it is set, still verify it exists and is open; a milestone name
in an argument is a hint, not a fact.

You are the orchestrator. Use the best-fitted model and effort for each task, and the full toolbox
— subagents, agent teams, dynamic Workflows, ultracode. PLAN THE WHOLE SESSION BEFORE EXECUTING
ANY OF IT. Another Claude instance may share this working tree: never `git add -A`, always
`git show --stat <sha>` before trusting a commit's file list, and re-check shared paths before any
`git restore`/delete.

Repo: SailCommand (`DocGerd/sail_command`), branch `develop`. Read `CLAUDE.md` as binding law —
every trap named there has already cost this project a session.

## Deliverable

One complete release cycle, in six phases (0-5), with ONE human gate in phase 1 and ONE in phase 3.
Do not cross a gate on your own bookkeeping.

---

## Phase 0 — Establish state (delegate; do not trust this prompt's numbers)

Every count, milestone name and issue number below is illustrative only. DISCOVER the real state
first; this prompt goes stale on the next merge.

Dispatch **2 read-only research subagents in parallel** — `general-purpose`, `sonnet`, medium;
NOT the `scout` agent type, whose definition restricts Bash to `graphify` and forbids git and
network outright. They read state and report; only the `git fetch` below writes anything (refs).

1. **GitHub state** — open milestones with open/closed counts
   (`gh api repos/DocGerd/sail_command/milestones`); every open issue in each, with its
   `type:`/`priority:`/`area:` labels; open issues with NO milestone; open PRs (number, title,
   draft?, head ref); `ls changelog.d/`. Verify label spellings with
   `gh label list --repo DocGerd/sail_command --limit 100 --json name --jq '.[].name'` before
   using any of them — `gh issue create` hard-fails on a wrong spelling. Use the REST fallback
   (`gh api repos/DocGerd/sail_command/issues/<n>`) whenever `gh issue view` trips the
   Projects-classic `projectCards` deprecation.
2. **Tree state** — run `git fetch origin --prune --tags` FIRST (remote-tracking refs do not
   move on their own, and `gh pr merge` is server-side, so a stale `origin/develop` answers every
   question below with the PREVIOUS truth and never errors), then: current branch, `origin/develop` tip, `git log --oneline origin/main..origin/develop | wc -l`,
   `git worktree list`, merged-but-undeleted local/remote branches, whether the working tree is
   clean, and the last `deploy.yml` run's `smoke-probe` conclusion.

Then answer these three questions IN WRITING before doing anything else:

- **Is a release already in flight?** An open `develop → main` PR, or a milestone at 0 open /
  N closed, means the previous cut is unfinished — finish or explicitly abandon it before opening
  a new cycle. Do not start a second cut on top of one.
- **Which milestone is the CURRENT release target?** The lowest-numbered OPEN milestone, PATCH
  milestones (`vX.Y.Z`, Z > 0) included — and note that a milestone showing zero open issues may be
  a cut already in flight rather than an empty one. Which is NEXT?
- **Is `develop` shippable right now?** Read the REQUIRED checks off `origin/develop`'s tip first
  — `gh api repos/DocGerd/sail_command/commits/$(git rev-parse origin/develop)/check-runs` — and
  gate on `app` AND `e2e`; a local run cannot see `e2e` at all, and `e2e` is the only functional
  assurance for `src/sw.ts` and `src/routing/worker.ts`. Then corroborate locally with `npm
  --prefix app run typecheck && npm --prefix app run lint && npm --prefix app run test` —
  `lint`/`test` are npm SCRIPT names, not binaries, so each needs its own `run`. Delegate the
  run; do not do it inline.

---

## Phase 1 — Re-triage, then STOP for approval

### The allocation policy (this is new; the repo does not record it yet)

Fill the current release milestone by:

1. **Priority first** — `priority: high` before `medium` before `low`.
2. **Then favour user-facing work** — `type: feature` and user-visible `type: bug` outrank
   `type: chore` and `type: docs` at equal priority. A `chore` that unblocks a `feature` inherits
   the feature's rank; say so explicitly when you promote one.
3. **The 20% bug reserve** — at least 20% of the milestone's target size stays available for bug
   work. Satisfy it EITHER by `type: bug` issues already in the milestone OR by leaving slots
   unfilled; state which. Round UP (a 9-issue milestone reserves 2, not 1.8). The reserve exists
   because bugs are DISCOVERED mid-cycle — if you fill it entirely with today's known bugs, say
   so and say what happens when a new one arrives.

State your reading of the reserve rule explicitly in the proposal — it is ambiguous between
"≥20% of slots are bug-typed" and "≥20% of slots stay empty", and I will confirm which I meant.

### The work

Dispatch a **Workflow** with one agent per milestone bucket (current release, next release,
Backlog, Icebox) plus one cross-cutting agent. Each returns, per issue: current milestone,
labels, a one-line statement of what it actually is, whether it is still LIVE (issue titles go
stale — #452's title still claims relaxation lowers the gate for the WHOLE route, false since
v0.12.0 made it per-cell, and briefing from it produced a false premise (#649)),
and a recommended destination with a reason. Then run an **adversarial verify pass**: every
"close as done / no longer applies" recommendation gets ≥2 independent refuters, and the default
verdict is REFUTED. In a recent triage session every close-recommendation put through that pass
was refuted — treat REFUTED as the prior, and re-derive the ratio from THIS session rather than
quoting one.

Check specifically for:
- issues whose body describes an already-shipped state (verify against CODE, not the title);
- `status: blocked` issues whose blocker has cleared;
- issues that belong in `Backlog`/`Icebox` and are inflating the milestone;
- missing `type:`/`priority:`/`area:` labels (there is no `area:` member for user-facing copy /
  i18n / UI structure — leaving it bare is correct, forcing a wrong one is not);
- anything currently unmilestoned.

### 🛑 GATE 1 — present, then WAIT

Present ONE scannable block: a table of proposed moves (issue → from → to → why), the resulting
milestone composition (count, type mix, computed reserve %), what you are NOT moving and why, and
any close-recommendations that SURVIVED adversarial verify. Use `AskUserQuestion` to consolidate
the decisions. **Make no `gh` mutation until I approve.** If I approve a subset, apply exactly
that subset.

Milestone edits are `gh api repos/O/R/issues/N -X PATCH -F milestone=<number>` — `-F` (typed int),
not `-f`; the `issues/N/milestone` endpoint does not exist. After every mutating `gh` call, read
the new state back and assert it — never trust the exit code.

---

## Phase 2 — Execute the whole milestone

Plan the wave before spawning anything. Produce a written execution plan first: one task per
issue, its file allowlist, its definition of done, and — critically — a **file→PR collision map**.
Two PRs appending to the same file is a SCHEDULED conflict, not a risk; sequence merges by file
surface, disjoint first. No per-PR reviewer can see this; only you hold that view.

**Git conflicts are the cheap half. Map BEHAVIOURAL composition too**: when two PRs touch one
component, require the MERGED TREE to be built and tested, because it is a third artifact
neither PR's CI has ever built. At v0.18.0, PR #827 made a legend render only while
`plan === null` and PR #828 put a control inside it — each diff individually correct and reviewed clean, while the
merged result left that control unreachable once a plan existed, with the flag persisted
and no in-app path back. Merge ORDER can also be a correctness constraint, not just
conflict avoidance: #828 had merged #827's branch into its own history to test the fix, so the
reverse order would have landed #827's changeset under #828's PR.

Per task:
- Spawn a **FRESH `sail-implementer`** (never reuse one across tasks), `isolation: worktree`.
  **PIN THE BASE BRANCH** in the brief (`git fetch` then `git switch -c <branch> origin/develop`)
  and require the merge-base as a reported deliverable — 10 of 10 worktree agents in one session
  landed on the wrong ref, and no per-diff gate can see it.
- **Forbid implementers the full test suite** (~8.3 min); brief a FILTERED FOREGROUND run
  (`npm --prefix app run test -- <filter>`). Budget for the stall anyway: nudge once, and after a
  SECOND stall TAKE the watch yourself. CI is the authority.
- Tell them to **commit, push and open a DRAFT PR at the first push** — work is never local-only.
- **Use `Closes #N` when the PR delivers its issue** — `develop` IS the default branch, so
  the issue closes on merge, which is what I want. Reserve `Refs #N` for a PR that genuinely
  does NOT close it (partial delivery, or a spike informing a larger issue). The v0.18.0 cut
  used `Refs` universally and left the milestone at 9 open after every PR had merged, which I
  had to flag; the earlier wording ("never a closing keyword") is what caused that.
  Either way, grep both copies before creating the PR:
  `git log origin/develop..HEAD | grep -iE '(clos(e|es|ed)?|fix(e[sd])?|resolve[sd]?)[[:space:]:(]*#[0-9]+'`
  and the same over the body. Post-merge, assert each issue's state in BOTH directions.
- Add a `changelog.d/<issue>.<category>.md` fragment for every user-visible change. If an earlier
  fragment for the same issue is still pending, DECIDE whether it is still TRUE — do not
  reflexively leave it alone; both fold into the same section.
- One persistent `sail-reviewer` per PR, reused via `SendMessage` for the fix→re-review loop,
  retired at merge. Add `offline-pwa-reviewer` ONLY if the diff touches a PWA path. Run
  `/pr-selfreview`: one inline thread per finding, fix all, resolve all.
- **For a prose-heavy diff add `claim-auditor` ALONGSIDE the reviewer, spawned FRESH each round**
  (never resumed — it would carry its own prior clean verdict as a prior). Give them disjoint
  scopes: the auditor gets prose, the reviewer keeps code and mechanism. Measured at the v0.18.0
  docs sweep — the auditor found dangling anaphors and a claim contradicted inside its own hunk;
  the reviewer found an acceptance check UNREACHABLE from inside the runbook. Neither could have
  found the other's, and a fresh auditor re-derived 20+ claims its predecessor had passed and
  found a Major among them.
- **Once a PR shows the successor pattern, make the next wave DELETION-ONLY** — "adopt supplied
  text verbatim plus deletions, write no new prose". Measured on two PRs at v0.18.0: waves 1 and
  2 each fixed N findings and introduced 2 NEW prose defects; wave 3 under that constraint
  introduced ZERO on that wave. A wave that cannot add prose has far less room to produce a
  successor — though a deletion can still strand an anaphor. It only works when
  the findings are removable — a fix needing explanation still needs a normal wave.
- **Unresolved review threads are a hard merge blocker** under `protect-main`, and closing one
  has no notification attached, so a fix dispatched is NOT a thread resolved. Check the
  per-PR unresolved count before every merge attempt; `mergeable_state: blocked` collapses
  draft / checks-pending / checks-failed / threads-open into one word and will not tell you which.
- **Brief every reviewer to attack ORCHESTRATOR-authored prose hardest.** At several past cuts the
  MAJORITY of review Majors sat in orchestrator-written text, one of them inside the very bullet
  warning about that class. Brief the FINAL round to re-read reviewer-supplied verbatim text as text of unknown
  provenance — it is the one part of a diff nobody re-attacks.
- If a change touches the #282 sweep closure, run `.claude/skills/sweep-closure/` (#729) — it
  derives the closure mechanically instead of from a prose path list. Treat OWED as
  authoritative and pay it. A NOT-OWED is only as good as the tool's hand-maintained
  universe — `PATH_PREFIXES` / `EXTRA_EDGES` have no CI check (#836) — so before
  accepting one, confirm the changed file is not a RUNTIME input the import walk
  cannot see. Either way, never pay ~31 min per arm-set on a guess, and never run a full
  sweep as a harness background task.
- Spec edits under `docs/superpowers/specs/` are MAIN-SESSION ONLY (the ask-gate hook must prompt).

Merge with `/merge-train`: strictly serial, re-sync each branch from `origin/develop` before its
turn, verify `head.sha` equals what was pushed AND that check-runs exist for that exact SHA
(#119), gate on `app` + `e2e` only (the sole required checks; `ruff`/`verify`/CodeQL/
`hook-selftests` are advisory and yield `unstable`, which still merges — so after ANY `pipeline/**`
change run `./pipeline/.venv/bin/ruff check pipeline/` and `./pipeline/.venv/bin/ruff format --check pipeline/` BY HAND
(if `pipeline/.venv` does not exist, create it with `python3 -m venv pipeline/.venv &&
pipeline/.venv/bin/pip install -r pipeline/requirements.txt` — it is gitignored and absent from a
fresh worktree): a red `ruff` merges silently and no JS-side gate can see Python). After ANY dependency change,
Dependabot bumps included, run `npm --prefix app run notices` and commit the regenerated
`app/public/THIRD-PARTY-NOTICES.txt` — the REQUIRED `app` job regenerates it and fails at
`git diff --exit-code public/THIRD-PARTY-NOTICES.txt`, with `e2e` and CodeQL green beside it.
Never state a check's state from your own table. A 504 or a detached-HEAD error can still LAND the merge — verify via
the merge commit's parents, never blind-retry. `gh pr merge` is server-side, so run
`git merge --ff-only origin/develop` afterwards or keep naming refs explicitly. When the train is
finished, verify the LAST `deploy.yml` run before Phase 3 — `gh run list --workflow=deploy.yml
--limit 6 --json headSha,conclusion`, then that run's `smoke-probe` job. A merge train legitimately
leaves several grey `cancelled` runs; only the final one matters, and a cancelled last run means
nothing deployed and is indistinguishable from nothing happening. A develop push also evicts
production's CDN edge Range objects, so a red probe there is a prod fact, not a UAT one.

Do NOT merge on a green-e2e assumption alone: an e2e run can silently measure a FOREIGN build
(#803) and that yields a false GREEN as readily as a false red. Prefer an assertion that can only
pass on the tree under test.

---

## Phase 3 — Release cut

The `/release` skill is `disable-model-invocation: true` — deliberately, because whatever merges
to `main` goes live immediately, so its own header calls the runbook "user-only and human-gated
by design". I therefore CANNOT invoke it. Ask me to type `/release` yourself, and while you wait
read `.claude/skills/release/SKILL.md` and follow it literally. Its structure:

| Step | What |
|---|---|
| §1 | Precondition — `develop` IS the release candidate |
| §2 | 🛑 HARD GATE — build and run it LOCALLY, show me, wait for approval |
| §2b | Docs sweep (the #132 ritual) BEFORE opening the PR |
| 3 | Open the `develop → main` release PR |
| 4 | **I** merge it |
| 5 | Sign, verify locally, push the tag |
| §5a | Assert the ref before tagging — local `main` is routinely stale |
| §5b | The tag deploy must reach `success` before the back-merge — EXCEPT the #398 no-op below, where `smoke-probe` reds and the back-merge IS the remedy |
| §5c | Verify the GitHub Release object exists and is `Latest` |
| §5d | Verify GitHub shows the tag as Verified |
| 6 | Back-merge `main → develop` via a TOPIC branch |

### 🛑 GATE 2 is §2 — do not open the release PR before I approve the local run.

Non-negotiables at the cut:

- **§2b fold** — hand-fold every `changelog.d/` fragment into `## [X.Y.Z] - <date>` as TOP-LEVEL
  bullets (`ENTRY_RE` is `/^- (.*)$/`, anchored with no leading whitespace, so an INDENTED
  bullet silently glues onto the previous entry),
  update the comparison links, delete the fragments. Then **re-`ls changelog.d/` immediately
  before pushing the tag** — a fragment whose PR merged after the sweep is silently lost and
  nothing reds. Never create an EMPTY release section (it fails a REQUIRED check and
  `release.yml`'s notes guard, after the merge).
- **Docs sweep covers images too.** Regenerate the docs wind fixture
  (`node app/scripts/gen-docs-wind-fixture.mjs`), recapture via `docs/screenshots/capture.mjs`,
  and check the hero shows SAILING, not motoring — freshness is necessary, not sufficient. The
  blank Shallow column in `plan-route.png` was APPROVED by me at the v0.17.0 cut — but that
  approval was about the CAPTURE, not about the feature: `docs/acceptance.md` §2.12 records that a leg
  whose cautious depth reading falls below the safety depth shows its "Shallow …"/"Marginal …" chip
  on an ordinary, non-relaxed route TOO since #651/#698 — not only inside a relaxed one. So confirm
  the captured route genuinely has no sub-gate leg before shipping a blank column; do not "fix" it, and do not
  wave it through unverified either.
- **`Closes #N` does nothing in a release PR** (auto-close fires only on merge to `develop`,
  and a release PR merges to `main`). This is why the closing keyword belongs on the FEATURE
  PRs in phase 2, where it fires. If phase 2 was done right, nothing is left to close by hand
  here — close only the stragglers a `Refs`-only PR deliberately left open, and verify each.
- **#398 same-SHA no-op** — read the merge-push run's `deploy` JOB conclusion **IMMEDIATELY
  before `git push origin <tag>`**, not before the sign-and-verify sequence. The two answers
  differ in durability: `success` is permanent, but *not-yet-created* is a snapshot of a race
  still running. At v0.18.0 it read not-yet-created (the safe signal) and turned `success`
  during the ~2 min of updating the ref, signing, verifying and pushing — everything between
  the read and the push is time the merge run gets to finish in. Concretely, read the
  conclusion: `gh api repos/DocGerd/sail_command/actions/runs/<id>/jobs --jq '.jobs[]|"\(.name): \(.conclusion)"'`.
  `cancelled`/`null` → the tag run will take; `success` → it will no-op and `smoke-probe` will
  red, and the remedy is the BACK-MERGE (step 6), never a re-run. Gate on the JOB CONCLUSION;
  the merge→tag time gap licenses nothing in either direction. Add a row to CLAUDE.md's #398
  table for this cut — the table is what the "COUNT THE TABLE ROWS" instruction counts.
- When the tag run NO-OPPED **and** the back-merge fast-forwards onto the tag commit, expect the
  back-merge PR to display a RED check inherited from the tag run — both conditions are needed,
  and if `develop` moved past the release commit no SHA is shared and any red is this PR's own.
  Attribute every check-run by the run id in its own `details_url`, never by name.
- Verify prod independently: fetch the live entry chunk and confirm the bare `vX.Y.Z` (no
  `-N-g<sha>` suffix). `/uat/` can NEVER show a bare tag — that is correct, not a bug.

---

## Phase 4 — Revise CLAUDE.md (MAIN SESSION ONLY)

Run the `/revise-claude-md` COMMAND — the session transcript is its input, so a subagent CANNOT
do this (its reflection input would be empty). It declares `allowed-tools: Read, Edit, Glob` —
**no Bash** — so:

1. Verify every empirical claim BEFORE invoking it (delegate the verification, not the reflection).
2. Harvest subagent transcripts under the session's `subagents/` directory — most accepted items
   historically came from there and never reached any report.
3. Prefer DELETING a duplicated number over restating it; a twin that drifts is worse than no twin.
4. State facts as past-tense EVENTS ("re-verified against maplibre-gl@6.6.0"), never as
   current-state claims that go false at the next bump.
5. Anchor citations to the SYMBOL or literal string; the line number is a hint only.
6. Then commit + PR afterwards (the command cannot).

Also run one **"when does this become false?"** lens over the diff — the currency check
structurally cannot catch a self-staling fact (an ahead/behind count, a tip SHA, an "as of"
snapshot), and a CLAUDE.md audit needs its own review: one such audit's own 231-line diff was
measured to contain 30 further defects, 9 of them major.

---

## Phase 5 — Housekeeping

- **Milestone roll-forward**, per `CONTRIBUTING.md`: the shipped milestone closes, `v0.(N+1).0`'s
  scope becomes the next `v0.N.0`, and a fresh `v0.(N+2).0` is opened. A PATCH milestone closes at
  its own cut and shifts nothing. `Backlog` and `Icebox` persist.
- Close any issue the release shipped that a `Refs`-only PR left open, and verify state via
  `gh api repos/DocGerd/sail_command/issues/N --jq .state`. **File every residual as its own
  tracked issue at REVIEW time, per-PR — not in a post-hoc audit here.** The v0.18.0 cut ran a
  13-agent disposition audit at this point; it produced 8 real residual issues but should have
  produced them 9 PRs earlier, and it delayed closing. If a reviewer finds something the PR
  will not fix, that is the moment to file it — then closing is mechanical and this step is a
  formality. A residual left in a merged PR body is a residual nobody will find.
- `ROADMAP.md`'s `Current release:` line — §2b bumps it; step 6 VERIFIES it landed and bumps only
  as a fallback.
- Remove finished worktrees via `/worktree-cleanup` (force-free: the agent runs
  `find app/node_modules -delete`, then you run `git worktree remove`; restore the dirty wind
  fixture first). Delete merged local and remote branches.
- Confirm the working tree is clean and `develop` is checked out — an un-isolated agent can leave
  the shared checkout on its own branch.
- **Triage the post-merge CodeQL `push` run on `develop`.** PR-scoped CodeQL analysis is
  DIFF-SCOPED, so a PR's zero-alert result carries no inventory information, and CodeQL is not a
  required check — alerts accumulate silently. A dismissal comment caps at 280 chars, so point it
  at a linked evidence record.
- Run `/remember` to write the handoff.
- **Propose** (do not silently add) a `CONTRIBUTING.md` paragraph recording the milestone
  allocation policy from Phase 1, if I approved it — right now that rule exists nowhere in the
  repo, so it will not survive this session.

---

## Standing rules for the whole session

- **Never state a CI check's state, an issue's state, or a milestone's contents from your own
  tracking table.** Read it back.
- **Ask of every green result: what class of failure can this method not detect?** And before
  reporting a NEGATIVE finding, measure the control.
- **A mutation that cannot reach the code path under test is zero evidence.** Run every mutation
  at BASE as well as HEAD; one already red at BASE proves nothing.
- **Enumerate, don't patch.** When a fact is wrong in one place, `git grep -n` it repo-wide and
  publish the enumeration INCLUDING the hits you left alone — that table is the only evidence
  there is no next instance. Enumerate by CLAIM SHAPE, never by a token list.
- **Prose is where this project's defects live.** Recent cuts shipped zero coding errors and
  multiple prose Majors. If a claim cannot be supported from a file read during the task,
  DELETE it — do not hedge it. Announce a stopping rule for fix waves and honour it: file the
  remaining Minors rather than run another unreviewed wave.
- Keep `-f` out of both the command and the Bash `description` field on any `git push`.
- Report honestly: if a phase is blocked, finish everything else in full and say explicitly what
  you left out and why. Scaling the work down is my call, not yours.
