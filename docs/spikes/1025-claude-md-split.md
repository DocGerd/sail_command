# Spike #1025 — what belongs in tracked `CLAUDE.md` vs the maintainer's own setup (folds in #471)

- **Issue:** [#1025](https://github.com/DocGerd/sail_command/issues/1025) "work out what should
  live in the tracked, contributor-facing `CLAUDE.md` versus what is specific to the maintainer's
  own machine and working style" — open, milestone v0.25.0 triage. Folds in
  [#471](https://github.com/DocGerd/sail_command/issues/471) (verify the nested-memory trigger
  before relying on it) and touches [#417](https://github.com/DocGerd/sail_command/issues/417)
  (Backlog, explicitly deferred behind this document).
- **Date:** 2026-09-07
- **Status:** Decision / Recommendation. **This document ships the decision, not the execution** —
  per the triage-gate ruling, splitting 4,608 lines with its own review is a follow-up, not this
  cycle's deliverable. No line of `CLAUDE.md` moves in this PR.
- **Verdict:** **The criterion is a three-part test — reproducibility, then reach, then residency
  — applied in that order, and it settles #471 as a mixed answer rather than a flat yes/no.** Part 1
  (is the described artifact tracked in this repo?) correctly separates the three examples the issue
  names as genuinely non-reproducible, but the blast radius is small: **~6.2 KB / 341 KB (≈1.8%)**,
  not the double-digit percentages this issue's cost framing might suggest. Part 2 (which resolves
  where non-tracked content should live) is answered empirically this session: the maintainer's
  global `~/.claude/CLAUDE.md` **is** delivered to a worktree-isolated subagent (this document's own
  authoring agent is proof), and a project-root `CLAUDE.local.md` **is** loaded and **does** survive
  a forced compaction — both confirmed live against the installed Claude Code 2.1.263, not assumed.
  Part 3 (residency, i.e. #471's actual question) gets a **conditional** answer: the nested,
  directory-scoped `paths:`-frontmatter mechanism is real and loads on trigger exactly as the #444
  spike found — **and it still does not survive compaction**, reconfirmed today. That is fatal for
  *hard prohibitions* (most of `Domain rules` and `Code conventions`) and fine for *evidence* (measured
  figures, historical citations) — so **#471's original proposal (move both sections wholesale) is
  DECLINED on sharper grounds than the #444 spike had**, while the mechanism itself is confirmed
  viable for a narrower slice. #417's 9 `#368` references are unaffected by the tracked/personal
  axis at all (they are unambiguous codebase fact) and depend only on the residency question this
  document also answers.

> Companions: [`444-claude-md-and-automation.md`](./444-claude-md-and-automation.md) (source of the
> nested-memory mechanism and the original R2 proposal this document narrows), and the memory
> records `nested-claudemd-lazy-but-not-compaction-safe`,
> `claude-md-compression-is-net-negative`, `claude-md-retirement-criterion`, and
> `personal-tooling-not-in-tracked-config` (all outside this repo, in the maintainer's own
> `~/.claude/`) — read as prior art, never restated wholesale here.

---

## 0. Provenance

- **Measurement base:** `origin/develop @ 8138f511` (this branch's merge-base). `CLAUDE.md` there is
  **4,608 lines / 341,196 bytes** — both re-derived with `wc -l`/`wc -c` at that commit, not copied
  from #1025's body (whose 4,534/~334 KB figures are from an earlier point in this same cycle and
  are already stale, per #1025's own body admitting the file "moved under the issue").
- **The nested-memory and `CLAUDE.local.md` measurements in §5 were run live this session**
  (2026-09-07, Claude Code **2.1.263** — the version actually installed and running this agent,
  confirmed via `claude --version`), inside a disposable scratch project outside this repo's
  worktree (`/tmp/claude-1000/.../scratchpad/local-md-test/`), using the same method the
  `nested-claudemd-lazy-but-not-compaction-safe` memory record used at 2.1.246: a marker string per
  memory tier, a forced `/compact` (confirmed via the session's own `.jsonl`,
  `"subtype":"compact_boundary"`), and a post-compaction re-query for which markers remain resident
  **without re-reading anything**. Every reported result below is a positive or negative control
  from that transcript, not an inference.
- **The "global `~/.claude/CLAUDE.md` reaches a worktree-isolated subagent" finding is not a
  constructed test — it is a direct observation of this very session.** This document's authoring
  agent runs inside `<repo>/.claude/worktrees/<agent-id>` (a real git
  worktree) and received the full content of `~/.claude/CLAUDE.md` verbatim in its system
  prompt, in the harness's own "Contents of `<path>` (user's private global instructions for all
  projects)" injection format — the identical format used for the tracked project `CLAUDE.md` and
  for nested memory. It was not typed into the brief by the orchestrator. That makes it a real
  instance of the harness's global-memory delivery to a subagent, observed under the actual
  deployment condition this repo's orchestration relies on, rather than a synthetic replica.
- **Section byte counts in §9** are measured fresh at `8138f511` with `awk` splitting on `^## `
  headers, in bytes — **not** the #444 spike's `cl100k` token counts, which were measured against a
  file version that has since roughly doubled. The two figures are never combined or compared
  directly (this repo's own rule: a measurement's basis must be stated, and two bases must not be
  mixed into one number).

---

## 1. RECOMMENDATION

| # | Action | This cycle? |
|---|---|---|
| **D1** | **Adopt the three-part criterion below** (reproducibility → reach → residency) as the standing test for any future CLAUDE.md placement decision. | Yes — this document |
| **D2** | **Decline #471's original proposal** (move all of `Domain rules` + `Code conventions` into a directory-scoped `app/CLAUDE.md`) **on the compaction evidence**, not merely "unverified" as the #444 spike left it. Close #471 with this finding rather than leaving it open. A narrower, non-prohibition-only version remains a legitimate future candidate — not ruled out, just not this one. | Yes — decision only |
| **D3** | **File a small, separately-scoped execution issue** for the ~6.2 KB of genuinely non-reproducible passages identified in §4 (the `git checkout` deny pair, `guard-destructive-git.sh`, the SessionStart hook) — relocate to the maintainer's own `~/.claude/CLAUDE.md` (two of the three, already largely duplicated there — see §4.4) and a new gitignored, project-root `CLAUDE.local.md` (the third, confirmed to load and survive compaction). | No — follow-up |
| **D4** | **Leave #417 deferred, but for a different reason than its own body states.** #417's 9 `#368` references are not maintainer-personal at all (Part 1 = tracked/codebase, unambiguously) — they depend on the *residency* question (#471), not the *tracked-vs-personal* question (#1025). Since D2 declines wholesale relocation, #417 can proceed on `CLAUDE.md` as it stands whenever it is picked up; it does not need to wait on any further split decision. | No — informs #417, doesn't execute it |
| **D5** | **Do not treat this split as a meaningful size lever.** §9 shows the reproducibility axis moves ~1.8% of the file. The real levers are #1029 (retirement — nearly exhausted) and #1044 (restatement — the one still producing bytes). Say this explicitly so a future session doesn't re-propose #1025 as a fix for file size. | Yes — this document |

---

## 2. Why the issue's own cost framing needs one correction

#1025's body is right that `CLAUDE.md` is a floor paid per session, per subagent, and per
compaction. But it frames the split as if removing "the maintainer's own machine" content pays that
cost down. §4 and §9 below show that specific content is **small** — the three examples the issue
names, plus an exhaustive grep for the same signature phrases elsewhere in the file, total ~53 lines
/ ~6.2 KB of 4,608 lines / 341,196 bytes. Executing the obvious reading of #1025 would save under
2%. The two mechanisms that actually move the needle are already filed and already understood
(#1029: retirement, exhausted at one candidate over three passes; #1044: explanatory restatement,
the still-active lever). This document's job is the criterion, not a size result — and the honest
size result is that the criterion, applied narrowly and correctly, is not where the bytes are.

---

## 3. The criterion — three parts, applied in order

Naive candidates from the issue body, tested and found individually insufficient:

- *"Can a fresh contributor act on this?"* — correct for content whose **underlying artifact**
  cannot be reproduced (a personal hook, a personal permission rule), but it wrongly clears content
  that is *about* driving an agent yet is entirely reproducible because the artifact IS tracked
  (`.claude/agents/sail-implementer.md`, committed skills, committed hooks) — see §4.6.
- *"Would this survive the maintainer leaving?"* — true of almost everything in the file, including
  the parts that are genuinely non-reproducible today (a successor would still benefit from knowing
  *that* a personal `deny` pair once existed, just not from the file being the thing they load every
  turn). This candidate answers "is it worth recording anywhere", not "does it belong HERE, loaded
  every turn". It is a real design value (GOVERNANCE.md's successor-readability framing) but it does
  not discriminate placement.
- *"Is it a fact about the codebase, or about how one person drives an agent?"* — the sharpest of
  the three, but "about how to drive an agent" is not itself disqualifying: the model-routing and
  agent-delegation bullets in `Working style` name **tracked** agent definitions and are exactly as
  reproducible as a code-convention rule (§4.6). And several *general* tool gotchas (`gh api` flag
  composition, `jq --arg` size limits, `Object.is(-0,0)`) are not "about the codebase" at all yet are
  squarely contributor-actionable (§4.7) — this candidate would wrongly want them gone.

**The working criterion, in order — each part only runs if the previous one didn't decide it:**

### Part 1 — Reproducibility (decides tracked vs. not-tracked-at-all)
> Does the artifact this passage *describes* exist in this repository's own tracked tree — a
> committed hook, skill, agent definition, workflow file, CI config, source file, or domain data —
> such that a fresh clone gives **any** agent, contributor's or maintainer's, the identical thing?

- **YES** → this is project documentation. It belongs in a tracked file (which one is Part 3).
- **NO** → the artifact is the maintainer's own machine (`~/.claude/`, or this repo's gitignored
  `.claude/settings.local.json`). Go to Part 2 — this is *not* an automatic "delete", because the
  underlying incident it records may still be worth keeping, just not resident to everyone.

### Part 2 — Reach (for content that fails Part 1: where should it actually live?)
> On the maintainer's own machine, is the thing being described scoped to *every* agent that could
> run there — including a worktree-isolated subagent — or only to the interactive/orchestrating
> session?

- **Every agent, any repo** (a Bash-tool permission rule, a hook wired on every `git`-shaped
  command) → the maintainer's **global** `~/.claude/CLAUDE.md`. Confirmed this session (§0, §5) to
  reach a worktree-isolated subagent — so this is not a downgrade in coverage, it is the *correct*
  scope for a fact that is true regardless of which repo the agent is in.
- **Every agent, but specific to working in *this* repo** (not a general Claude Code fact, but also
  not something a contributor's clone has) → a gitignored, project-root **`CLAUDE.local.md`**.
  Confirmed this session to load and to survive a forced compaction, identically to the tracked root
  `CLAUDE.md` — see §5.2. This is a real, previously-undocumented-in-this-repo mechanism; using it
  requires one `.gitignore` line (not done in this PR — see §1 D3).
- **Interactive session only** (a `SessionStart` hook that fires once per interactive terminal
  launch) → same two homes are still correct; which one depends on whether the hook's *purpose* is
  repo-specific or general (§4.3's SessionStart example turns out to already be a near-duplicate of
  content already living in the global file — see §4.4).

### Part 3 — Residency (for content that passes Part 1: root, nested, or `CONTRIBUTING.md`?)
> Is this needed on every turn regardless of which file is open — a hard prohibition, a safety
> invariant, or a fact needed before any file is touched — or is it scoped to one subtree and
> tolerable to lose if the session compacts before re-entering that subtree?

- **Hard prohibition / safety invariant / pre-file fact** → stays in **root** `CLAUDE.md`,
  regardless of byte cost. The #921 retirement lever (pin the failure to a structural guard, shrink
  to one line) is the correct size tool here — relocation is not, because §5.1 reconfirms nested
  memory does not survive compaction.
- **Directory-scoped evidence, tolerant of a mid-session miss** (measured figures, a citation, a
  walkthrough specific to `app/src/**` or `pipeline/**`) → eligible for a nested `<dir>/CLAUDE.md`.
  This is #471's actual question, and this document narrows rather than answers it in full — see §6.
- **Binds a human contributor at least as much as an agent** (a label taxonomy, a signing procedure,
  a release runbook step) → `CONTRIBUTING.md` (already the convention; #444's §A5 found the existing
  duplication between `CLAUDE.md` and `CONTRIBUTING.md`/`.claude/skills/release/` deliberate and
  correctly working, and this document found no reason to revisit that).

This is a **test with three exits**, not a single question, because the issue's own named examples
and the hard cases in §4 need different amounts of scrutiny to place correctly — a one-line test
collapses distinctions that matter (§4.5, §4.6).

---

## 4. Applying the criterion to real passages

### 4.1 `~/.claude/settings.json`'s `git checkout` `deny` pair (named in #1025)
`CLAUDE.md:4075-4093`. Part 1: the pair lives in the maintainer's personal global settings file —
**not tracked anywhere in this repo** (the bullet says so itself: "unversioned and per-machine, and
a contributor's checkout has none of it"). **NO** → Part 2. It is a Bash-tool **permission** rule,
which the harness evaluates for every Bash call from every session on this machine, subagents
included. **Global, every agent** → belongs in `~/.claude/CLAUDE.md`. Verdict: **move** (§1 D3).

### 4.2 `guard-destructive-git.sh` (named in #1025)
`CLAUDE.md:4094-4139`, the largest of the three (46 lines / 3,468 B). Part 1: "It lives OUTSIDE this
repo (`~/.claude/hooks/guard-destructive-git.sh`, global/personal, unversioned, shared across
concurrent sessions)" — **NO**. Part 2: it is a `PreToolUse` hook gated on `Bash(git *)`-shaped
commands, firing for **any** session, including a worktree-isolated implementer running `git
push`/`gh api` from its own worktree — exactly the audience the bullet's own remedies address ("keep
`-f` out of the description field", "use the Write tool, which does not route through the Bash
guard"). This looked like a genuine tension on first read — the content is about non-reproducible
personal infrastructure, yet the remedy is safety-critical for exactly the agents least able to
verify it (worktree subagents) — but §0/§5's finding resolves it: the global file **does** reach
those agents, so relocating there loses nothing. Verdict: **move**, and the move is *safe* because
of an empirical fact this document establishes, not merely assumed (§1 D3).

### 4.3 The SessionStart orchestration hook (named in #1025)
`CLAUDE.md:3939-3956`. Part 1: "durable enforcement shipped 2026-08-03 as a personal global
SessionStart hook... deliberately outside this repo's tracked config" — **NO**. Part 2: described as
**global**, not repo-specific, in the bullet's own words. → global file. Verdict: **move**, subject
to §4.4's finding that most of the substance is already there.

### 4.4 A concrete duplication this session found while classifying 4.3
The repo's `CLAUDE.md` bullet (4.3) spends most of its length restating a fact that is **already
present, near-verbatim, in the maintainer's own global `~/.claude/CLAUDE.md`** — visible in this very
session's system prompt, section "The Claude Code default that contradicts this policy — EXPECTED,
ignore it": both describe the same hardcoded fallback constant inside the Claude Code binary
("hardcoded FALLBACK constant... emitted/applied... when a server-side value is empty"), both cite
`2.1.220`/`2026-07-30`, both state the same ruling. **This is the #1044 restatement pattern (explain
a fact twice) occurring across the tracked/untracked boundary, not just within one file.** What is
NOT a duplicate and should not be silently dropped: the repo bullet's own incident record ("cost a
full docs sweep plus a ~15-call browser walkthrough of main-session context, 2026-07-27") — a
repo-specific attributable cost, exactly the kind of evidence the #921 retirement criterion says must
survive any shrink. **Recommendation for the follow-up (§1 D3): retire the duplicated mechanism
description to a one-line pointer at the global file, keep the incident record.** Not executed here —
touching `CLAUDE.md` is out of this cycle's scope, and a careful partial-retirement edit is exactly
the kind of small, separately-reviewed change #921 succeeded at and #1044/#1029 both warn a bundled
edit would not.

### 4.5 A pure domain fact — `TOLERANCE_M = 0.9` (a hard case for Part 3, not Part 1)
`CLAUDE.md`'s Domain-rules bullet on the mask-optimism structural bound. Part 1: **YES** — describes
`pipeline/build_mask.py`, a tracked source file, and is pinned by a tracked test
(`app/src/test/maskTolerance.test.ts`). Not personal at all; the issue's own candidate (c) would
correctly clear it as "a fact about the codebase". Part 3 is where the real question lives: it reads
as a **hard invariant** ("a STRUCTURAL bound, not a tuning knob") that other code and tests actively
depend on being remembered correctly — exactly the shape §3's Part 3 says must stay root-resident
regardless of size, and exactly the shape the compaction finding (§5.1) says is unsafe to push into a
nested, lazily-triggered file. This is the passage type #471's original proposal would have moved.

### 4.6 Model routing / agent delegation — the naive candidate (c) failure case
`CLAUDE.md`'s "Right-size agent models per task" bullet (`Working style`, ~3957-3962) reads, on a
surface pass, as exactly what candidate (c) — "about how one person drives an agent" — would exile.
Part 1 says otherwise: it names `sail-implementer`, `sail-reviewer`, `offline-pwa-reviewer`,
`claim-auditor` — **all tracked** `.claude/agents/*.md` definitions any contributor's clone also has.
It is explicitly framed as reinforcing (not duplicating from scratch) the global "fitness rule" —
a legitimate, deliberate twin per the pattern #444's §A5 already validated for `cancel-in-progress`/
`same-SHA`. Verdict: **stays**, and stands as the sharpest refutation of candidate (c) taken alone —
a passage about "driving an agent" is project documentation whenever the agents it names are
themselves tracked artifacts.

### 4.7 General tool gotchas embedded in Verification lessons — a second failure case for (c)
Bullets like "`gh api` rejects `--repo`", "`jq --arg` cannot carry a base64 image payload", and
"`Object.is(-0, 0)` is `false`" are not facts about *this codebase* at all — they are true of `gh`,
`jq`, and JavaScript everywhere, and were merely discovered while working on this repo. A literal
reading of candidate (c) would want them gone as "not a fact about the codebase". Part 1 says
otherwise: nothing about them requires the maintainer's personal setup — any contributor with the
same CLI tools hits the identical bug, so they are fully reproducible and fully actionable. Verdict:
**stays** — general-but-reproducible is not the same axis as project-specific-but-personal, and
conflating them (as a naive reading of (c) does) would delete real, checkable value.

### 4.8 A CI/`app`-scoped fact that IS a legitimate #471 candidate
"CI's `lint` covers `app/e2e/**` AND `app/sweep/**`" (`Commands` section). Part 1: **YES**, describes
`.github/workflows/ci.yml`, tracked. Part 3: it is **evidentiary** (a measured fact about what a
tracked script does), not a prohibition an agent must obey on every turn regardless of context, and
it is naturally `app/`-scoped. This is the shape that #471's mechanism *is* appropriate for — unlike
§4.5 — subject to the caveat in §6 that a miss mid-session costs a wrong assumption about CI scope,
not a safety violation.

### 4.9 The `#398` same-SHA deploy chronology — tracked, but scoped to neither `app/` nor a hard rule
Part 1: **YES** (describes `.github/workflows/deploy.yml`, tracked, and the table is itself the
artifact the "COUNT THE TABLE ROWS" instruction tells readers to grow at every cut — retiring it
would break the thing it is). Part 3 is the interesting miss: it is release-event-scoped, not
`app/`-scoped, so a single `app/CLAUDE.md` (#471's proposed shape) would never capture it — #444's
§A4 table already noted `PWA / E2E / deploy` and `Release & branching` are "mixed"/"event-scoped" for
exactly this reason. Worth restating because it shows the residency question is not "one nested file
or none" — a real execution of #471 would need per-audience scoping (`app/`, `pipeline/`, and
something release-event-scoped that a directory-`paths:` glob cannot express), which is more than
this cycle's brief permits and more than #471's own body proposed.

### 4.10 Exhaustiveness of the grep
Beyond the three named examples, an exhaustive grep for the same signature phrases ("lives OUTSIDE
this repo", "personal global", "unversioned and per-machine", "it's their global config", "personal
tooling", "contributor's checkout has none of it") over the current `CLAUDE.md` returns **zero**
additional hits outside §4.1-4.3's three bullets. This is an enumeration, not a sample — reported so
a later reader does not have to re-run it to trust the §9 sizing.

---

## 5. What was actually verified this session (the #471 empirical precondition)

### 5.1 Nested, directory-scoped memory: lazy load reconfirmed, compaction loss reconfirmed
Reconfirms the `nested-claudemd-lazy-but-not-compaction-safe` memory record, now measured against
**2.1.263** (the prior measurement was 2.1.246) rather than assumed to still hold:
- A fresh session with **no** file read inside a `paths:`-scoped subtree does **not** see that
  subtree's memory (negative control, matches prior finding).
- A `Read` of a file inside the scoped subtree attaches the subtree's `CLAUDE.md` as a system
  message immediately (positive control) — root `CLAUDE.md` and the maintainer's `CLAUDE.local.md`
  (§5.2) were both present from turn 1, unconditionally.
- After three filler turns and a forced `/compact` (confirmed via `"subtype":"compact_boundary"` in
  the session's own `.jsonl`), a query for what is **currently** resident — without re-reading
  anything — returns the root and Local markers but **not** the nested one. The model's own
  explanation in that transcript names the mechanism precisely: "compaction replays the tool
  *result* but does not re-run the attachment side effect."

### 5.2 `CLAUDE.local.md`: confirmed to exist, load, and survive compaction — new to this repo's record
#1025's body flagged this as unverified ("does the harness merge it? verify — do not assume"). It
does. Evidence, in order:
- `strings` over the installed Claude Code binary (2.1.263) shows `CLAUDE.local.md` as a first-class
  memory **scope** (`case "Local": return Ke(t,"CLAUDE.local.md")`), loaded through the **same**
  function (`Q0`) as the root "Project" scope — a structurally different code path from the nested,
  lazy-trigger mechanism in §5.1 (`nestedMemoryAttachmentTriggers`).
- Empirically: a project-root `CLAUDE.local.md` with a marker string was present in a fresh session's
  context from turn 1 (alongside `CLAUDE.md`, before any tool call), and — unlike the nested case —
  the marker was **still present** after the same forced-compaction procedure, with no re-read.
- The `/init` command's own bundled prompts (found via the same `strings` pass) independently confirm
  `CLAUDE.local.md` as a recognised "Personal" project-scope memory file distinct from the tracked
  project `CLAUDE.md`, gitignored by convention.
- **Not verified this session, and flagged rather than assumed:** whether `CLAUDE.local.md` is
  copied into an `isolation: worktree` agent's worktree. It is gitignored, and `git worktree add`
  only materialises tracked content, so — by the same mechanism the `personal-tooling-not-in-tracked-
  config` memory already recorded for `.claude/settings.local.json` — the working assumption should
  be **no**, but this was not independently measured here. Consequence for §1 D3: a
  `CLAUDE.local.md` fact is a safe home for something the **interactive main session** needs, but not
  a substitute for the global file when a **worktree-isolated subagent** also needs it (§4.1, §4.2).

---

## 6. Consequence for #471

#471 asked whether the nested-memory trigger fires as R2 assumed, with an explicit instruction to
close it rather than implement if it doesn't. The mechanism **does** fire (§5.1, reconfirmed) — but
the compaction loss, also reconfirmed, is fatal for the specific proposal R2 made (move the whole of
`Domain rules` and `Code conventions`, which §4.5 shows are dominated by hard prohibitions and
invariants other code depends on being remembered correctly for the *entire* session, not just until
the next compaction). **Recommendation: close #471 with this finding — "verified, and the answer is
no for the proposal as scoped" — rather than leave it open as still-conditional.** The mechanism
itself is not discredited; §4.8-4.9 show real candidates exist (evidentiary, `app/`-scoped facts).
A future issue proposing a **narrower** move — naming specific non-prohibition bullets, one at a
time, the way #921's retirement worked — would be a legitimate, differently-scoped successor, not a
reopening of #471.

## 7. Consequence for #417

#417's own body already establishes that the 9 remaining `#368` references are ordinary `app/`-scoped
CSS/JS coupling facts (banner clearance, `useBannerHeight.ts`, media-query syntax) — this document's
Part 1 test agrees without qualification: **tracked, codebase, not personal**. #417's deferral
reasoning ("if the split moves `#368` material out of the tracked file, consolidating it first is
wasted work") was really a bet on **#471's** answer, not #1025's — and #471 is now answered: nothing
in §4.5's shape (hard-prohibition-adjacent, subtree-scoped) should move to a nested file, and the
`#368` material reads the same way (it includes at least one explicit hard prohibition — "no fixed
`waitForTimeout`" — that the file's own compression write-up already named as unsafe to relocate).
**#417 can proceed on `CLAUDE.md` as it stands, whenever picked up; it is not blocked by anything
this document decided**, and should be read as unblocked by this document rather than "still waiting
on #1025".

## 8. How this relates to #1029 and #1044

Three levers on one number, and this document's job was to characterise the smallest of them:

| Lever | What it moves | Size found |
|---|---|---|
| #1029 — retirement (pin to a structural guard) | Bullets whose failure is now caught by a test/hook/CI step | **Nearly exhausted**: 3 passes over 4,593 lines found 1 retirable bullet, 26 rejected as partial-coverage traps |
| #1044 — restatement (say it once, point at the rest) | Explanatory paraphrase of a fact the file already states elsewhere or points at as authoritative | **Still active**: one correction wave alone added +1,491 B, roughly half restatement |
| #1025 — tracked vs. personal (this document) | Content whose underlying artifact is not in this repo at all | **Small**: ~6.2 KB / 341,196 B ≈ 1.8% (§4.10 is exhaustive over the current file) |

None of the three is a substitute for the others, and none should be sold as "the" fix for file size.
#1025 is worth doing for a **governance** reason stated correctly in the issue body (a contributor
should never be pointed at an artifact they cannot reproduce) — not a size reason.

---

## 9. Sizing for the follow-up (D3)

- **Move now-identified (§4.1-4.3):** 3 bullets, 63 lines total (3,939-3,956 + 4,075-4,093 +
  4,094-4,139 by current line numbers — re-derive at execution time, these will drift), 6,164 bytes.
  Destination: global `~/.claude/CLAUDE.md` for §4.1/§4.2 (reach: every agent, any repo), a new
  gitignored `CLAUDE.local.md` for whatever residual of §4.3 is not already duplicated there once
  §4.4's retirement is done first.
- **Do §4.4's retirement before the move**, not after — moving a passage that partially duplicates
  the destination just relocates the duplication instead of removing it.
- **One `.gitignore` line** (`CLAUDE.local.md`) if that mechanism is adopted.
- **Not sized here, deliberately:** any further Part-3/residency work (a real `app/CLAUDE.md`, per
  §4.8-4.9's narrower candidates) — that is #471's own follow-up, now unblocked by §6's decision but
  not scoped by this document, and should be sized separately once specific candidate bullets are
  named (the way #921 named specific bullets before touching any of them).
- **Review shape:** per this repo's own measured history (a 9-fix `CLAUDE.md` diff produced 9 new
  defects, #1044/#1029), any of the above should be its own small, separately reviewed PR — not
  bundled with unrelated corrections, and not attempted as one large cut.

---

## 10. Considered and rejected

1. **A single yes/no test ("is this personal?"). REJECTED.** §4.6 and §4.7 show a one-question test
   collapses distinctions that change the answer: content that is *about* driving an agent but
   describes tracked artifacts (§4.6), and content that is not about the codebase at all but is
   fully reproducible (§4.7). The three-part ordered test is what separates these correctly.
2. **Treating "is it in the repo's own README/CONTRIBUTING.md space" as the same question as
   "is it personal". REJECTED.** `CONTRIBUTING.md` already carries contributor-facing material that
   overlaps `CLAUDE.md` deliberately (#444 §A5); the tracked/personal axis is orthogonal to the
   root/`CONTRIBUTING.md`/nested-file axis, which is why Part 3 is a separate step from Part 1.
3. **Selling this split as a size fix. REJECTED (§2, §8).** The measured blast radius is ~1.8%.
   Framing it as a size lever would set up the next session to be disappointed the way #724's
   compression pass was, for a different reason (there, the target was too aggressive; here, the
   target is simply too small to matter for size).
4. **Deleting the three non-reproducible bullets outright instead of relocating them. REJECTED.**
   §4.4 shows one of them carries a real, repo-specific incident record (the 2026-07-27 cost) that
   the #921 retirement criterion says must survive any shrink. Relocate, do not delete, except for
   the specific duplicated mechanism-description text §4.4 identifies.
5. **Re-opening #471 as "still conditional" rather than deciding it. REJECTED.** The brief that
   produced this document explicitly asked for a decision, not a further deferral, and the
   compaction evidence (§5.1, reconfirmed today) is decisive for the proposal as originally scoped —
   leaving it open would just repeat the #444 spike's own unresolved item without adding anything.
6. **Assuming `CLAUDE.local.md` propagates to worktree-isolated subagents, on the strength of it
   using the same root-scope loader as `CLAUDE.md`. REJECTED — flagged as unverified instead
   (§5.2).** The loader mechanism being structurally similar is not the same claim as `git worktree
   add` materialising a gitignored file, and this repo has already been burned by the analogous
   assumption for `.claude/settings.local.json`. Stating it as verified would have been exactly the
   kind of unearned confidence this repo's Verification-lessons section exists to catch.

---

## 11. Documentation-currency constraint (from #1025's body)

`GOVERNANCE.md`'s release-cut sweep and `.claude/skills/release/SKILL.md` §2b both name an explicit
document set — `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `CONTRIBUTING.md`, `SECURITY.md`,
`docs/security-assurance-case.md`, `docs/acceptance.md`, and `GOVERNANCE.md` itself — re-read at
every release cut. **`CLAUDE.md` is not, and has never been, a member of that set** (re-derived by
reading `GOVERNANCE.md`'s "Documentation currency" bullet and `SKILL.md` §2b directly at this
commit). This settles the constraint the issue raises without needing a new decision: this document
creates no new tracked file, and the one gitignored file it recommends (`CLAUDE.local.md`) is
untracked by definition and therefore outside any sweep that only walks tracked paths — no explicit
exemption needs writing down because the file the sweep would need to skip does not exist in the
tracked tree at all. If a future execution PR instead created a new **tracked** document (say, moving
material into a dedicated `docs/agent-conventions.md`), that document would need one of: joining the
§2b list explicitly, or an explicit exemption with a stated reason — this document does not create
that case, so it does not decide it, but flags it for whoever executes D3/D4 with a tracked
destination in mind.

---

## 12. What needs a maintainer decision

- **Whether to adopt D3's relocation at all**, or accept the ~6.2 KB / 1.8% as a cost worth paying to
  keep the file self-contained. The governance argument (a contributor should never be pointed at an
  unreproducible artifact) stands regardless of the byte count — this is a judgement call about
  whether that argument alone justifies the relocation work and its own review risk.
- **Whether `CLAUDE.local.md` is worth adopting as a standing mechanism** for future maintainer-only
  notes about this specific repo, now that it is confirmed to work, or whether the maintainer's
  existing global `~/.claude/CLAUDE.md` is sufficient for everything that currently exists (§4.1-4.3
  all resolve to the global file once §4.4's duplication is retired, so the concrete backlog for D3
  may turn out to need zero uses of `CLAUDE.local.md` — it is confirmed *available*, not confirmed
  *needed* by anything on record today).
- **Whether to close #471 outright per §6**, or keep it open scoped to the narrower candidates named
  in §4.8-4.9. Both are legitimate; this document recommends the former but the choice affects issue
  bookkeeping the maintainer may want to make themselves.
