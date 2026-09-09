# Spike #1092 — would splitting `CLAUDE.md` into lazily-loaded files pay?

- **Issue:** [#1092](https://github.com/DocGerd/sail_command/issues/1092) "Spike: would
  splitting CLAUDE.md into lazily-loaded files pay, given nested files are not re-injected
  after compaction?"
- **Date:** 2026-09-09.
- **Status:** Decision / Recommendation. No line of `CLAUDE.md` moves in this PR — per the
  issue's own definition of done, this document records a decision; execution (if any) is a
  separate issue.
- **Companions:** [`1025-claude-md-split.md`](./1025-claude-md-split.md) — the
  reproducibility/reach/residency criterion for tracked-vs-personal content, whose §5.1
  compaction measurement this document leans on directly and does **not** re-derive. Read that
  document first; this one narrows its unresolved "residency" question (§6 there: "not scoped
  by this document") rather than re-covering its ground.
- **Verdict:** **Splitting into automatically-loaded nested `CLAUDE.md` files is DECLINED for
  everything currently in the root file**, for the same reason #1025 already declined it for
  `Domain rules`/`Code conventions`: nested memory does not survive a context compaction, and
  every root section audited here (§1) is either a hard rule or so tightly interleaved with
  argument-plus-evidence prose that losing it mid-session would be a correctness regression, not
  a performance trade-off. A **different, narrower mechanism is recommended instead**: extracting
  one self-contained, append-only evidence block — the `#398` same-SHA-no-op per-release-cut
  table — to a referenced file that a session reads **on demand** via an ordinary Read call,
  never via automatic memory injection. That mechanism is compaction-safe **by construction** (it
  never depends on the harness's nested-memory attachment behaviour at all) and is already this
  repo's own pattern for `app/sweep/README.md` and `.claude/skills/release/SKILL.md`. Measured
  saving: **~25,375 bytes, ≈7.1% of the file** (§3), a one-time gain smaller than the issue's
  framing might suggest, and the only clean candidate found.

---

## 0. Provenance

- **Measurement base:** `origin/develop @ e4c0de7a41c76b88deefd0bf3cfed61fa0198352` (this
  branch's merge-base, confirmed via `git merge-base --is-ancestor` at the start of this task).
  `CLAUDE.md` there is **357,789 bytes**, measured with `wc -c CLAUDE.md` at that commit — not
  copied from the issue body, which cites 353,233 B (a figure from an earlier point in the same
  day's session, already 4,556 B stale by the time this document was written).
- **Section byte counts** (§1) were measured fresh with `awk` splitting on `^## ` headers, in
  bytes, at the same commit.
- **Harness version:** `claude --version` in this session reports **2.1.266**. The compaction
  finding this document leans on (§2) was measured in `1025-claude-md-split.md` against
  **2.1.263**, three patch releases and roughly two days earlier (that document is dated
  2026-09-07). **This document did NOT independently re-run the live nested-memory
  compaction test this session** — reproducing it needs a disposable scratch project, a marker
  string per memory tier, and a forced `/compact` confirmed via a session's own
  `.jsonl` (`"subtype":"compact_boundary"`), which was judged out of scope for a task whose
  brief is to write a decision document, not to re-run a harness-behaviour experiment that was
  itself run rigorously two days prior. This is stated here explicitly, per the brief's own
  instruction to say plainly when a claim is not independently established rather than assert
  it — the compaction-loss finding below is **cited from #1025**, not **re-verified** by this
  document, and the version gap is real even if small.
- **Non-`v*` git tags:** none found in this worktree (`git tag -l | grep -v '^v[0-9]'` returned
  nothing), so the "stray local tag hijacks `git describe`" hazard `CLAUDE.md` documents does not
  apply to any measurement in this document.

---

## 1. The measured problem

`CLAUDE.md`'s byte size by top-level section, measured 2026-09-09 at the commit above:

| Section | Bytes | % of file |
|---|---:|---:|
| Project | 962 | 0.3% |
| Layout | 7,954 | 2.2% |
| Commands | 29,064 | 8.1% |
| Code conventions | 35,626 | 10.0% |
| PWA / E2E / deploy | 67,110 | 18.8% |
| Release & branching | 22,899 | 6.4% |
| Verification lessons | 108,434 | 30.3% |
| Domain rules | 30,358 | 8.5% |
| Working style | 52,610 | 14.7% |
| **Total** | **357,789** | 100% |

`Verification lessons` alone is 30% of the file — consistent with #1025's independent finding
(measured against an earlier, smaller revision of the file) that this section carries the
highest density of cross-references in the document and functions as a reference hub, not a
self-contained module.

**The floor-cost claim is not abstract for this task.** This very spike-writing task is a
first-party demonstration of it: the system prompt for this subagent carried the complete
357,789-byte `CLAUDE.md`, unconditionally, before any tool call was made — the harness attaches
the tracked root file to every session and every subagent regardless of what the task actually
needs. Writing one ~10 KB decision document about `docs/spikes/` conventions required none of
the 67 KB `PWA / E2e / deploy` section or the 108 KB `Verification lessons` section, and received
both anyway. This is the mechanism the issue's "floor cost, paid per compaction and per subagent"
framing describes, observed directly rather than assumed.

---

## 2. The decisive constraint: nested `CLAUDE.md` and compaction

**This document relies on #1025's measurement rather than re-deriving it (see §0 for why).**
Quoting `1025-claude-md-split.md` §5.1 verbatim, established there against Claude Code 2.1.263 on
2026-09-07, method: a marker string per memory tier in a disposable scratch project outside this
repo, a forced `/compact` confirmed via that session's own `.jsonl` carrying
`"subtype":"compact_boundary"`, and a post-compaction query for what remains resident without
re-reading anything:

> - A fresh session with **no** file read inside a `paths:`-scoped subtree does **not** see that
>   subtree's memory (negative control, matches prior finding).
> - A `Read` of a file inside the scoped subtree attaches the subtree's `CLAUDE.md` as a system
>   message immediately (positive control) — root `CLAUDE.md` … [was] present from turn 1,
>   unconditionally.
> - After three filler turns and a forced `/compact` …, a query for what is **currently**
>   resident … returns the root … marker[] but **not** the nested one.

That finding itself reconfirmed an earlier one (`nested-claudemd-lazy-but-not-compaction-safe`,
originally measured at 2.1.246), so it has now held across at least three harness versions
spanning 2.1.246 through 2.1.263. Nothing in the 2.1.263→2.1.266 gap is known to touch context
management (this is an inference from the absence of a signal, not a verified negative), but the
gap is real and this document does not close it. **Treat the finding as standing, not as
re-verified at the current version.**

**Consequence for #1092's specific question:** any content moved into an automatically-loaded
nested `CLAUDE.md` file is silently absent from a session's context the moment that session
compacts, with no error and no signal that it happened. For a hard prohibition, a safety
invariant, or a domain fact other code depends on being remembered correctly — the shape #1025's
§4.5 worked example (`TOLERANCE_M = 0.9`) and this document's own §1 breakdown both show
dominates `Domain rules`, `Code conventions`, most of `Verification lessons`, and the
prohibition-bearing parts of `PWA / E2E / deploy` — that is a correctness regression, not a
performance trade-off, for exactly the reason #1025 declined the wholesale #471 proposal.

---

## 3. Options

### Option A — Do nothing (the null option)

Cost: the status quo ratchet continues. `#1029` (retirement — pin a bullet to a structural
guard, shrink to one line) is, per #1025 §8, "nearly exhausted" (three passes over the file found
one retirable bullet against 26 rejected as partial-coverage traps); `#1044` (restatement — the
file re-explaining a fact it already states elsewhere) is, per the same source, "still active"
and was measured adding +1,491 B in one correction wave alone. Doing nothing means the file keeps
growing under `#1044` with no lever currently closing the gap.

### Option B — Automatic nested `CLAUDE.md` split (the mechanism the issue names)

Move entire sections into directory-scoped `<dir>/CLAUDE.md` files that load only when a file in
that subtree is read.

**REJECTED**, on the compaction evidence in §2, for every candidate section this document
examined:

- `Domain rules`, `Code conventions` — already declined by #1025 D2 on this exact evidence, for
  the same reason: dominated by hard prohibitions and structural invariants (§1's `TOLERANCE_M`
  example is one of many).
- `Verification lessons` — the single largest section (30.3% of the file) and, per #1025, the
  most cross-referenced. A guard-asymmetry or mutation-vacuity lesson forgotten mid-session is
  exactly the failure mode this section exists to prevent; nesting it does not reduce that risk,
  it reintroduces it on a schedule (whenever a long session compacts) that the file's own
  Verification-lessons content would call a "silent, correctness-affecting regression" if found
  anywhere else in the codebase.
- `PWA / E2E / deploy` — mixed: it contains both hard rules (e.g. the `.pmtiles` Range-route
  ordering requirement) and pure evidence (the `#398` table, §3 Option D below). A directory
  `paths:` glob cannot separate the two inside one section, and #1025 §4.9 already found this
  section resists directory-scoping because it is release-EVENT-scoped, not path-scoped — a
  `deploy.yml` change and an `app/` change are not the same trigger.

### Option C — Compress the prose in place (the #724 approach)

Rewrite bullets to be shorter without moving anything to another file.

**REJECTED**, on prior-art evidence from this repo's own history. Issue
[#724](https://github.com/DocGerd/sail_command/issues/724) (`state: closed`, `state_reason:
completed`, retrieved via `gh api repos/DocGerd/sail_command/issues/724` this session) targeted
a −8–12% reduction via three phases (compress `Commands`' pipeline/sweep detail to pointers,
compress `Release & branching` to pointers at the runbook, and a conditional subdirectory split)
and closed having **ended +442 bytes**, because review found the compression diff itself
introduced 27 defects — more cost than the bytes it saved. Rewriting prose is precisely the
activity `CLAUDE.md`'s own `Verification lessons` section documents as hazardous under four named
failure modes (over-claiming, staleness, wrong-from-the-start, same-PR invalidation) — a
compression pass necessarily rewords sentences, which is exactly the operation those failure
modes attach to. This document does not propose compression of any surviving prose.

### Option D — Extract self-contained evidence blocks to a referenced file, on demand

Move a structurally separable, append-only block to another tracked file, leaving a one-line
pointer in root. The moved file is read via an ordinary Read tool call **when a task actually
needs it** — never via the harness's automatic nested-`CLAUDE.md` attachment. This sidesteps §2's
compaction hazard entirely: nothing about it depends on the nested-memory mechanism, so there is
no "silently forgotten after compaction" failure mode to worry about. If a session forgets to
re-read the pointer target after compaction, the pointer sentence itself (which lives in root,
and root DOES survive compaction per #1025 §5.1) is still there to remind it — the failure mode
degrades from "silently missing a rule" to "has to make one more Read call," which is the
benign direction.

This is not a new mechanism for this repo — it is the same pattern already used successfully for
`app/sweep/README.md` (the full sweep rebuild spec, pointed at rather than inlined) and
`.claude/skills/release/SKILL.md` (the release runbook, pointed at from `Release & branching`).
The question is only whether a further candidate exists inside the CURRENT `CLAUDE.md` body that
is structurally separable enough to extract without disturbing the surrounding argument, the way
compression cannot avoid doing.

**One clean candidate was found and measured**: the `#398` same-SHA-no-op per-release-cut
evidence table under `PWA / E2E / deploy` (the row for every release cut since v0.10.0). Measured
with a targeted `awk` scan bounded by that bullet's own heading and the next bullet's opening
line: **25,375 bytes, 7.1% of the current 357,789-byte file.** It qualifies as a good extraction
candidate for three independent reasons:

1. **It is already self-contained by construction.** It is literally a table — one row per
   release cut, each row carrying its own run IDs, timestamps and conclusion — and the file's own
   instruction ("COUNT THE TABLE ROWS instead … a pointer at an incomplete list is WORSE than the
   ordinal it replaced") already treats it as an artifact to be read and appended to, not prose to
   be read start-to-finish.
2. **The bullets that CROSS-REFERENCE this material already point at the surrounding mechanism
   prose, not at the table rows themselves** — confirmed by grep: three cross-references (at the
   `#803`, `PWA/deploy`, and "404 half" points inside `Verification lessons`) all read "the #398
   bullet under PWA/deploy" or "under PWA / E2E / deploy," never "the #398 table's row N." So the
   mechanism narrative that those cross-references depend on (which SHA wins the same-SHA race,
   why the entry-chunk probe discriminates, the deploy-collision timing) can stay in root
   untouched, while only the append-only row log moves.
3. **It is release-cut-scoped, not implementation-task-scoped.** The set of subagents that need
   this table (a release-cut agent verifying the `smoke-probe` gate reading, per the table's own
   "NEVER GATE ON THE GAP" instruction) is a small, well-defined subset of every subagent this
   repo dispatches. A routine implementer or reviewer subagent — the majority of dispatches per
   this repo's own `Working style` conventions — never needs it.

Net saving: the table (25,375 B) minus a one-to-two-sentence pointer replacing it (roughly
150–250 B) ≈ **~25.1–25.2 KB, ~7.0% of the current file.**

**What this option does NOT solve**: the other 93% of the file, and in particular the 30.3% in
`Verification lessons`, is argumentative prose with evidence woven into the argument (a mutation
result cited mid-sentence to support a claim about vacuity, say), not an append-only log. Trying
to extract "the evidence half" of one of those bullets would re-create exactly the anaphora
hazard `CLAUDE.md`'s own "MOVING text is not a no-op" lesson documents (a referring expression —
"that same," "the mechanism above" — left pointing at content that used to be adjacent and is now
in a different file a session may not have open). Option D is narrow on purpose: it is a lever
for STRUCTURALLY SEPARABLE material, not a general compression technique.

---

## 4. What this costs subagents (issue's Q4)

**Measured directly this session, not inferred**: this task's subagent received the complete
357,789-byte root `CLAUDE.md` in its system prompt from turn 1, per §1. Any split needs to be
judged against that baseline, not against an assumption that subagents already get a trimmed
view.

- **Option B (automatic nested split) does not help subagents the way it might appear to.** Per
  #1025 §5.1's positive control, a nested `CLAUDE.md` attaches "immediately" the first time a file
  in its scope is read — not lazily in the sense of "only if genuinely needed," but "on first
  touch." Most implementer and reviewer subagents in this repo's own dispatch convention are
  briefed with an explicit file allowlist inside `app/` or `pipeline/`, and read a file in that
  subtree within their first few tool calls. So a hypothetical `app/CLAUDE.md` would attach to
  nearly every implementer subagent almost as early as the root file does today — the saving for
  that population approaches nil, and the correctness cost from §2 is paid in full the moment
  such a session runs long enough to compact once.
- **Option D (referenced-but-not-auto-loaded evidence) is the one form of "lazy loading" that
  actually reduces subagent floor cost uniformly.** The extracted content is never injected
  unless a task's own brief tells it to read the pointer target — a release-cut agent would, an
  ordinary feature-implementation agent would not. Every subagent that does not need the #398
  table stops paying for it, unconditionally, the moment it is extracted; no subagent's behaviour
  needs to change to realize that saving, because the pointer sentence that stays in root is
  strictly shorter than the table it replaces.

---

## 5. Recommendation

1. **Decline Option B (automatic nested-`CLAUDE.md` split) for the entire current file**,
   reaffirming and extending #1025's finding: it is not merely that `Domain rules`/`Code
   conventions` are unsuitable — every section audited in §3 either carries hard-prohibition
   content or is too interleaved with cross-referenced argument to survive the compaction-loss
   property in §2 without a correctness regression.
2. **Decline Option C (in-place compression)**, on #724's own closed-out evidence: this repo has
   already run this experiment once and it produced a net INCREASE in file size plus 27 defects.
3. **Adopt Option D narrowly**: extract the `#398` per-release-cut evidence table (only) to a new
   referenced file (a natural name would sit beside the pattern `docs/spikes/` already uses, e.g.
   `docs/release-history/398-deploy-noop-log.md`), leaving the mechanism prose, the "NEVER GATE ON
   THE GAP" rule, and a pointer sentence ("read the current row count and history at
   `<file>`; add a row at every cut") in root. Expected saving: **~7% of the current file, one
   time**, achieved by moving an already-self-contained block rather than rewriting any surviving
   sentence — so it does not carry #724's rewrite risk.
4. **State the size of this lever honestly and do not oversell it.** Per #1025 §8's table (updated
   here with this document's own finding), there are now three known levers on this file's size,
   and none of them is "the fix":

   | Lever | What it moves | Size found |
   |---|---|---|
   | `#1029` — retirement (pin to a structural guard) | Bullets whose failure is now caught by a test/hook/CI step | Nearly exhausted (1 retirable bullet found over 3 passes, per #1025) |
   | `#1044` — restatement (say it once, point at the rest) | Explanatory paraphrase of a fact stated elsewhere | Still active and growing the file (+1,491 B in one wave, per #1025) |
   | `#1025` — tracked vs. personal | Content whose underlying artifact is not in this repo | ~1.8% of the (smaller) file measured there |
   | **`#1092` (this document) — evidence extraction** | An append-only table separable from its surrounding rule prose | **~7.0% of the current file, a ONE-TIME gain, and the ONLY clean candidate found** |

5. **This cycle: decision only**, matching #1025's own precedent — no line of `CLAUDE.md` moves in
   this PR. The extraction itself (a follow-up issue, if approved) is small enough to be its own
   separately-reviewed change, per this repo's own measured rule that a CLAUDE.md diff earns
   exactly the review scrutiny a code diff does (the `#852` five-review-round successor-defect
   chain applies to prose edits as much as to code).

---

## 6. Considered and rejected

1. **Splitting `Verification lessons` by topic area into nested files. REJECTED.** It is the
   single largest section (30.3%) and, per #1025, the most cross-referenced — moving it would
   both trip the compaction hazard (§2) and require repairing an unknown number of "the bullet
   above" / "same class as Y" references that #1025 already found are not fully caught by any
   grep pattern.
2. **Treating this split as a meaningful fix for the file's overall size. REJECTED.** The single
   clean candidate found is ~7% of the current file. Selling it as more than that would set up
   the next session for the same disappointment #1025 flagged for its own, smaller finding
   (~1.8%) — framing a narrow lever as a general size fix invites exactly the kind of
   over-claiming this file's own `Verification lessons` section warns against.
3. **Generalizing Option D immediately to other candidate tables/logs without naming them.
   REJECTED — deferred instead.** No second table of comparable size and separability was found
   in the time available for this document; naming a speculative future candidate here would be
   an unsupported claim per this document's own prose rules. If a similar append-only structure
   emerges later (for instance, if `app/sweep/`'s BASE-double-run control history grows into a
   table the way `#398`'s did), it should be evaluated against the same three criteria in §3
   Option D, not assumed to qualify.
4. **Re-running the nested-memory compaction test live, this session, against 2.1.266, before
   writing this document. REJECTED as out of scope for THIS document, and said so explicitly
   (§0, §2) rather than silently reusing #1025's number as if freshly verified.** The two-day,
   three-patch-version gap is real; the brief for this task is to write a decision document, and
   a decision document that borrows a two-day-old, rigorously-established finding while flagging
   the gap honestly is preferable to either re-running an expensive experiment out of scope or
   silently asserting currency it did not check. A future session revisiting this question after
   a larger version gap should re-run #1025's own method rather than trust this document's
   citation indefinitely.
5. **Proposing a project-root, gitignored `CLAUDE.local.md` for any of the extracted content.
   REJECTED for this candidate.** #1025 §5.2 confirmed that mechanism loads and survives
   compaction, but it is gitignored and therefore invisible to a fresh contributor clone and to
   any subagent whose worktree only materializes tracked content (per that same document's own
   flag) — the `#398` table is genuinely project history that belongs in the tracked tree, not
   maintainer-private state, so `CLAUDE.local.md` is the wrong home for it regardless of its
   compaction behaviour.

---

## 7. What needs a maintainer decision

- **Whether the ~7% one-time saving from extracting the `#398` table justifies the review risk of
  touching `CLAUDE.md` at all.** Every prior CLAUDE.md-editing session this repo has run has
  produced at least one successor defect inside its own fix wave (the `#852` five-round chain is
  the most recent, full-length example) — that risk applies to a pure extraction just as it does
  to a rewrite, even though extraction carries none of compression's content-rewriting hazard.
- **Whether to adopt Option D as a STANDING convention** for any future append-only table that
  grows large enough to be a comparable candidate, or to treat this document's finding as a
  one-off decision about the `#398` table specifically. This document recommends the narrower
  reading — decide this table, not a policy — because no second candidate was found to test the
  policy against.
