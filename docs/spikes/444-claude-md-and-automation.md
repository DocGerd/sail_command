# Spike: is `CLAUDE.md` still serving its purpose at its current size, and is the accumulated Claude Code automation the right set?

- Issue: [#444](https://github.com/DocGerd/sail_command/issues/444)
- Date: 2026-08-09
- Status: Recommendation (no `CLAUDE.md` edit, no `.claude/` edit in this change)
- **Verdict: KEEP the knowledge, MOVE the residency — and leave the automation almost entirely alone. `CLAUDE.md` is not verbose; it is 4.47× over the large-memory threshold Claude Code itself computes for a 200 k-context model, and the `@path` import mechanism CANNOT fix that because imports are inlined at load. The one mechanism that can is the `paths:`-frontmatter / nested-memory path, which Claude Code 2.1.226 loads on a file-access TRIGGER rather than at startup — so the fix is a directory-scoped memory file, not a shorter file. On the automation side all four hooks selftest green, and across all six skills every npm script and every cited path resolves except one placeholder inside an example JSON payload; the single defensible change is that `artifact-guard.sh`'s Bash arm is dominated by noise (measured 74.2 %–93.0 % of its fires, band straddling the ~88 % figure this spike was briefed with) — while being *loose* in the other direction, with seven enumerated silent-allow paths of which two are reachable without contrivance — and its remedy is owned by the open successors #447/#448/#449, **not** by #437, which closed on 2026-08-07. On the shared tooling-budget question this document rules on the composition (the automation surface is not what drives the curve; `CLAUDE.md` maintenance is) and explicitly does not rule on whether the rate is acceptable. Three changes recommended; nine candidates explicitly declined.**

This document answers all 14 questions in #444's "Questions to answer"
section. It creates exactly one file — itself. It changes no line of
`CLAUDE.md`, nothing under `.claude/`, and nothing under
`docs/superpowers/`.

**Base: `develop`@`7195787`.** Every figure and every `file:line` below was
measured or re-derived at that commit **on 2026-08-09**, not copied from
#444's issue body. Where a figure disagrees with the issue, the issue is
quoted and the disagreement is stated.

---

## 0. Provenance, and two live hazards that bound what this document can claim

**Hazard 1 — this checkout's `node_modules` is stale against its lockfile.**

Both commands run from the repo root:

```
$ node -p "require('./app/node_modules/maplibre-gl/package.json').version"
6.0.0
$ grep -m1 -A2 '"node_modules/maplibre-gl"' app/package-lock.json | grep version
      "version": "6.1.0",
```

This is the exact trap `CLAUDE.md` records under "Never source an
integer-exact claim … from a summarizing fetch". Its consequence here is
specific and is **not** hand-waved below: **8 of `CLAUDE.md`'s 17
`file:line` citations point into `node_modules/maplibre-gl` and each one
names `6.1.0` as the version it was read against.** They cannot be
verified in this working tree, and they are therefore reported as
`UNVERIFIABLE HERE` in §A3 — not as correct, and not as stale.

**Hazard 2 — `npm ci` was deliberately NOT run.** Two implementer agents
(`impl-452`, `impl-459`) are working in this same tree; wiping
`node_modules` mid-run would break them. The sibling architecture spike on
#446 declined the same command for the same reason. That is a cost paid
knowingly: it is what leaves Hazard 1 open.

**What was measured but is not exact.** Question 1 says "measure it; do not
estimate". An exact Claude-tokenizer count of `CLAUDE.md` is **not
obtainable in this environment** — there is no `anthropic` SDK, no
`ANTHROPIC_API_KEY`, and Claude Code does not persist its system prompt
into the session transcript (verified: a distinctive `CLAUDE.md` string
appears in **0 of 174** `*.jsonl` files under this project's transcript
directory — `~/.claude/projects/<project-slug>/`, where `<project-slug>`
is Claude Code's own slugification of the checkout's absolute path —
because only conversation messages are written there). §A1 therefore
reports three independent measurements that bracket the answer, and names
the one instrument that would settle it — `/context`, a main-session
action. That is a useful negative result, not a dodge.

---

## 1. Replication of #444's own "Measured current state" — every figure has moved

#444's table is dated 2026-08-07. Two days later, at `7195787`:

| Metric | #444 (2026-08-07) | Measured 2026-08-09 | Method |
|---|---|---|---|
| `CLAUDE.md` lines / words | 2,395 / 24,891 | **2,522 / 26,281** | `wc -l -w CLAUDE.md` |
| Distinct issue references | 154 | **160** | `grep -oE '#[0-9]+' CLAUDE.md \| sort -u \| wc -l` |
| Total issue references | 354 | **365** | same, without `sort -u` |
| Top-level sections | 9 | **9** — reproduces | `grep -n '^## ' CLAUDE.md` |
| Hooks, total lines | 4 scripts, 2,593 | **4 scripts, 2,755** | `wc -l .claude/hooks/*.sh` |
| `artifact-guard.sh` | 1,276 | **1,438** | same |
| `notices-nudge.sh` / `wind-fixture-guard.sh` / `premerge-verify.sh` | 604 / 560 / 153 | **604 / 560 / 153** — all three reproduce exactly | same |
| Subagents / skills / committed workflows | 3 / 6 / 0 | **3 / 6 / 0** — reproduce | `ls .claude/agents .claude/skills; ls -d .claude/workflows` → `No such file or directory` |

The two that moved are the two that this project actively edits: the file
grew by commit `193ac02` ("docs: session 32 CLAUDE.md revision") and its
predecessors; `artifact-guard.sh` grew by `e5eb389` (#437 measurement) and
`bcded44` (PR #445 review).

**Section sizes reproduce in shape but not in value** (`awk` over `^## `
boundaries):

| Section | #444 lines | Measured lines | cl100k tokens (see §A1) |
|---|---|---|---|
| Verification lessons (hard-won) | 572 | **603** | 11,068 |
| PWA / E2E / deploy | 450 | **472** | 8,885 |
| Working style for this repo | 413 | **445** | 8,169 |
| Domain rules that are easy to get wrong | 263 | **291** | 5,563 |
| Code conventions | 268 | **269** | 5,121 |
| Release & branching | 216 | **217** | 4,149 |
| Commands | 157 | **176** | 3,515 |
| Layout | 33 | **34** | 589 |
| Project | 10 | **11** | 133 |

**#444's headline comparison is now slightly weaker than stated, and it
should be restated rather than repeated.** The issue says `CLAUDE.md` is
"**2.6x** the entire human-facing documentation set — `README.md` 226 +
`CONTRIBUTING.md` 403 + `GOVERNANCE.md` 289 = 918 lines". Measured today:
`README.md` **228** + `CONTRIBUTING.md` **403** + `GOVERNANCE.md` **289** =
**920**, and 2,522 / 920 = **2.74×**. The ratio went UP, not down, so the
motivating observation survives — but the specific number in the issue is
already stale, which is itself a small instance of the class §A3
enumerates.

**One figure #444 does not carry, and it matters more than the ratio:**
`CODE_OF_CONDUCT.md` (147) and `SECURITY.md` (332) also exist, so the true
human-facing root-doc set is **1,399 lines** and the ratio is **1.80×**.
The 2.74× framing is the issue's own three-file choice, not a repo fact.
Both are stated so the recommendation does not rest on the flattering one.

---

# Part A — the `CLAUDE.md` structure question

## A1. What does `CLAUDE.md` actually cost per request? (Q1)

Three independent measurements, none of which is a guess, and one negative
result.

### A1.1 Exact size

```
$ wc -l -w -c CLAUDE.md
  2522  26281 180036 CLAUDE.md
$ python3 -c "print(len(open('CLAUDE.md',encoding='utf-8').read()))"
178698
```

180,036 bytes; **178,698 characters** (the two differ because the file
uses non-ASCII punctuation — em dashes, `×`, `→`). The character count is
the one that matters, because Claude Code's own budgeting works in
characters (§A1.3).

### A1.2 Proxy tokenization — measured, but with an OpenAI tokenizer

`tiktoken`'s `cl100k_base` was installed into a throwaway venv and run over
the file. **This is a proxy: it is not Claude's tokenizer**, and the number
is labelled as such everywhere it appears.

| File | cl100k tokens | chars/token |
|---|---|---|
| **`CLAUDE.md`** | **47,219** | 3.78 |
| `CONTRIBUTING.md` | 5,597 | 3.87 |
| `SECURITY.md` | 4,674 | 3.98 |
| `GOVERNANCE.md` | 3,714 | 4.31 |
| `README.md` | 3,224 | 3.80 |
| `CODE_OF_CONDUCT.md` | 1,296 | 4.96 |

An attempt to CALIBRATE this proxy against Claude's real tokenizer, using
`output_tokens` recorded in this project's own transcripts, was made and
**abandoned as unsound** — grouping 9,750 assistant messages by message id
and comparing stored text against recorded `output_tokens` yields an
aggregate 1.87 chars per Claude token, which is implausible for English
prose. The cause is that thinking blocks count toward `output_tokens` but
are not always persisted, so the denominator is systematically short. The
attempt is recorded because the failure is the useful part: **transcript
`output_tokens` cannot be used to calibrate a tokenizer.**

### A1.3 Claude Code's OWN accounting — the load-bearing measurement

Claude Code 2.1.226 (`claude --version`; binary at
`~/.local/bin/2.1.226`) contains its own memory-file budget. Extracted
with `strings` and read directly:

```js
ii_=0.05, sQu=4194304, si_=40000, gi_=5
function $dn(e=ls()){ let t=hT(e,u0()), r=Number.isFinite(t)&&t>0?t:nbr;
  return Math.max(si_, Math.round(r*ii_*pk(e))); }
function Ndn(e){ let t=$dn(); return e.filter((r)=>!tbr(r.path)&&SQu(r.type)&&r.content.length>t); }
function pk(e){ if(!e)return 4; let t=ns(e), r=Aa(wo(t)).replace(/[._]/g,"-");
  return Bby.has(r)?4:3; }
```

and the warning those feed, verbatim from the same binary:

```
Large ${kind} will impact performance (${chars} chars > ${limit})
{id:"large-memory-files", tier:"warning", ... " is over the ", Fd(r), "-char limit ("
```

Decoded: **the memory-file limit is `max(40 000 chars, contextWindow ×
0.05 × charsPerToken)`** — 5 % of the context window, expressed in
characters, with a 40 000-char floor; `pk()` is Claude Code's own
chars-per-token constant (4 or 3 depending on the model). Two further
constants from the same block: `sQu = 4194304` is the per-file byte cap
above which a memory file is **silently skipped**
(`[CLAUDE.md] skipping ${e}: not a regular file or exceeds ${sQu} byte
limit`), and `gi_ = 5` is the recursion depth cap in the import walker
(`if(r.has(s)||o>=gi_)return[]`).

Applying those to this file:

| Context window | `pk` | Limit (chars) | `CLAUDE.md` = 178,698 chars | Verdict |
|---|---|---|---|---|
| 200 k | 4 | 40,000 | **4.47×** | **WARNS** |
| 200 k | 3 | 40,000 | **4.47×** | **WARNS** |
| 1 M | 4 | 200,000 | 0.89× | ok (89 % of the limit) |
| 1 M | 3 | 150,000 | **1.19×** | **WARNS** |

**This is the answer Q1 wanted and it is first-party.** On a 200 k-context
model — the ordinary case — `CLAUDE.md` is **4.47× over the threshold
Claude Code itself uses to raise `large-memory-files`**. On a 1 M-context
model it is under the limit only at `pk = 4`, and at 89 % of it, i.e. one
more session of growth from tripping it there too.

Two derived figures, both using Claude Code's own `pk` divisor rather than
any external tokenizer: **44,674 tokens at `pk = 4`** and **59,566 tokens
at `pk = 3`**. The cl100k proxy's 47,219 sits inside that band, which is
the only cross-check available. So the honest statement of per-request
cost is: **~45 k–60 k tokens, i.e. roughly 22 %–30 % of a 200 k context
window and 4.5 %–6.0 % of a 1 M one.**

### A1.4 What a real session's prompt actually weighs

Measured with Claude's own accounting, from 174 sail_command transcripts
(`input + cache_creation + cache_read` on each session's first assistant
message):

- all 174 sessions: min **30,421**, median **37,930**, max **135,446**
- the 28 sessions since 2026-08-01: min **32,840**, median **81,150**, max **135,446**

The floor is instructive: **30,421 tokens is below `CLAUDE.md`'s own
~45 k**, so the low-tail sessions cannot have had today's file resident —
they are older sessions from when it was smaller. The recent-window median
of 81,150 is the number to reason about, and against it a ~45 k–60 k
`CLAUDE.md` is **the majority of the resident prompt**, not a component of
it.

**Not measured, and named as such:** the exact split between `CLAUDE.md`,
the global `~/.claude/CLAUDE.md`, `MEMORY.md`, tool schemas and skill
listings inside those 81,150 tokens. `/context` in an interactive main
session prints that breakdown. It is a maintainer action and it is listed
in §"What needs a maintainer decision".

## A2. Does `@path` import help? (Q2) — **NO. Definitive negative result.**

`CLAUDE.md` uses **zero** `@path` imports today
(`grep -cE '@[a-zA-Z0-9./_-]+\.md' CLAUDE.md` → `0`), so the question is
purely prospective. The mechanism exists — the import regex is in the
2.1.226 binary as `(?:^|\s)@((?:[^\s\\]|\\ )+)` — and so is its
external-path consent gate:

```
This project's CLAUDE.md imports files outside the current working directory.
Never allow this for third-party repositories.
External imports:
Allow external CLAUDE.md file imports?
```

**But imports are resolved at LOAD and their content is inlined into the
same memory payload.** The loader returns `{info, includePaths}` from
`ci_(...)`, walks `includePaths` recursively up to `gi_ = 5` hops, and the
resulting content is a startup-seeded entry — the binary says so in its own
telemetry field description:

```
Set when the dedup matched a startup-seeded entry (CLAUDE.md / nested memory)
rather than a prior Read tool_result
```

There is no lazy fetch, no on-demand expansion, and no per-import budget.
**Splitting `CLAUDE.md` into a core plus `@`-imported appendices moves
bytes between files and changes the resident cost by approximately zero**
— it would in fact make things marginally worse, since the same content is
then spread across more files each of which is separately size-checked
against `$dn()`.

**This is the negative result #444 asked for, and it kills the obvious
plan.** Do not restructure around `@path`.

## A3. Currency audit — citations, issue references, and self-staling facts (Q5, Q6)

### A3.1 `file:line` citations — EXHAUSTIVE, not sampled

#444 asks for a sample with a stated size. The population turned out small
enough to do exhaustively, which is strictly better, so the sample size is
**17 of 17 — the complete set** of citations in the literal
`file.ext:NNN` form (regex
`([A-Za-z0-9_./-]+\.(ts|tsx|css|md|py|mjs|yml|json|sh)):(\d+)`). Nine point
into this repo; eight point into `node_modules/maplibre-gl`.

**The nine in-repo citations, each checked against `7195787`:**

| # | Citation | Claim | Verdict | Where it actually is now |
|---|---|---|---|---|
| 1 | `RouteLayer.tsx:656` | `fitBounds` passes `duration: 0` and the current bearing | **EXACT** | `:656` is `map.fitBounds(bounds, { padding: 48, duration: 0, bearing: map.getBearing() });` and is the file's only `fitBounds` |
| 2 | `app/src/components/RouteLayer.tsx:321-333` | `sc-maneuver-labels` is the one symbol layer with a `text-field` and no `text-font` | **EXACT** | `:321-333` is that `addLayer` block; `id` at `:322`; no `text-font` present |
| 3 | `annotations.spec.ts:244-247` | asserts ZERO Open-Meteo requests | **EXACT** | `:244-247` is exactly the `expect(openMeteoRequests, …).toEqual([])` block |
| 4 | `App.tsx:687` | "renders `.banner-area` unconditionally" | **STALE** | `:687` is `});`. `.banner-area` is at **`App.tsx:912`** |
| 5 | `App.tsx:132` | "the App-level `useBannerHeight()` call" | **STALE** | `:132` is a comment about #433. The call is at **`App.tsx:163`** |
| 6 | `planRoute.ts:452` | `depthRelaxationMayHelp(cause)` fires here | **STALE** | `:452` is a comment. The call is at **`:506`**; the definition at **`:203`** |
| 7 | `planRoute.ts:271` | `depthComfortMarginM`'s "only production call site" | **STALE** | `:271` is `export function planRoute(`. The only `depthComfortMarginM` use is at **`:302`** |
| 8 | `planRoute.ts:445` | "says so itself (`Unaffected by #243`)" | **STALE** | `:445` is a different comment. That text is at **`:485`** |
| 9 | `isochrone.ts:530-531` | PR #279's pre-revert `'unreachable'`→`'calm-motor-off'` flip | **HISTORICAL / UNRESOLVABLE** | `:530-531` is `board,` / `headingDeg,`; `grep -n "calm-motor-off" src/routing/isochrone.ts` returns **nothing**. The cited state was reverted and never merged, so no line number can be correct — the citation should not carry one |

**Score: 3 exact, 5 stale, 1 structurally unresolvable.** All five stale
ones are stale in the same direction — the file grew above them — and none
of them is *wrong about the code*, only about where it is. That is the
cheapest possible failure mode and it is exactly what `CLAUDE.md`'s own
"prefer the anchor over the number" note (used in
`docs/spikes/435-pwa-logging-diagnostics.md`) exists to avoid.

**The eight maplibre citations are `UNVERIFIABLE HERE`,** per Hazard 1:
`map.ts:589`, `ui/camera.ts:284`, `camera.ts:1197-1210`,
`symbol_bucket.ts:391`, `symbol/placement.ts:1268-1277`, `ui/map.ts:539`,
`load_glyph_range.ts:21`, `glyph_manager.ts:144`. Every one names
`maplibre-gl@6.1.0`; the installed tree serves 6.0.0. They are **not**
reported as defective — `CLAUDE.md` explicitly warns that the offset is
not uniform even within one file, so a bulk re-derivation would be a fresh
fabrication replacing a possibly-correct citation.

### A3.2 Issue references — exhaustive over all 160

All 160 distinct `#N` references were resolved against the repository in
one paginated pass:

| Class | Count | Share |
|---|---|---|
| Closed **issues** | 90 | 56.3 % |
| Closed **PRs** | 57 | 35.6 % |
| **Open** issues | 12 | 7.5 % |
| Not in this repo | 1 | 0.6 % |

The 12 open issues are #9, #232, #265, #288, #376, #391, #406, #420, #422,
#428, #451, #459. The one not-found is **#2311**, which is correct — it is
`Playwright #2311`, an external reference.

**Do not read "92 % closed" as "92 % stale".** `CLAUDE.md`'s own
enumerate-don't-patch rule distinguishes a **TRACKER** claim (asserts where
remaining work lives — must move when the work moves) from a **HISTORICAL**
reference (names the issue some shipped work happened under — stays as-is).
The overwhelming majority of the 147 closed references are historical by
construction: they are the provenance stamps on lessons. The defect class
is narrower and was searched for directly.

**The search: text that asserts an issue is OPEN, cross-checked against
real state. TWO genuine defects, not one** — and the way the second was
missed is the more useful half of this section, so both the corrected
count and the mechanism are recorded.

#### Defect 1 — `CLAUDE.md:236`, and it is wrong twice over

> "`subPathMeta()` in the same file still has the bare-`replace` shape
> (**#318, open** — a silent failure there degrades to an indexable UAT)."

- **#318 is CLOSED** — `closed_at = 2026-08-04T09:55:14Z`.
- **The technical claim is also false.** `subPathMeta()`
  (`app/vite.config.ts:93`) now carries the fail-closed guard: it
  `throw`s when its marker is absent, with the in-code comment
  "`#318: mirrors cspMeta()'s fail-closed guard`", and it is pinned by a
  dedicated test, `app/src/test/subPathMeta.test.ts`, whose header states
  the mutation check.

It is wrong in the **dangerous** direction — advertising a live
security-ish gap closed five days earlier, inside the paragraph whose
whole purpose is the guard-asymmetry rule — and it survived `193ac02`, a
CLAUDE.md-revision commit that landed *after* #318 closed.

#### Defect 2 — `CLAUDE.md:1922`, found by the sibling spike, not by this one

> "**No-route `reason` is a CONTROL INPUT, not just a status label**
> (#282, **REOPENED** — PR #411's merge auto-closed it via an earlier
> commit's stray keyword even though the PR body itself used `Refs`; **do
> not let it be closed again on this evidence**)."

- **#282 is CLOSED** — `gh api repos/DocGerd/sail_command/issues/282 --jq
  '{state,closed_at}'` → `closed`, `2026-08-07T17:26:29Z`. Verified the
  same way as #318, one command each.
- The instruction *"do not let it be closed again"* is an assertion about
  live state, and it is the strongest open-state claim in the file. Whether
  #282 *should* be open is a maintainer question this document does not
  answer; that the text and the tracker disagree is a fact, and only one of
  them can be right.

#### Why an "exhaustive" search found one of two — the mechanism, which is the transferable part

The first pass searched for the literal shape `#N, open` on a single line.
That is **two** narrowings, and #282 escapes through both:

1. **Spelling.** #282's assertion is spelled `REOPENED`, never `open`. A
   guard keyed to one spelling of a property fails open on every other
   spelling — the identical defect PR #411 found in this repo's own
   `planRoute.reasonDecoupling.test.ts`, where a structural guard matched
   only single-quoted literals and a backtick re-coupling left it green.
   The search written to audit `CLAUDE.md` reproduced the bug class
   `CLAUDE.md` documents.
2. **Line scoping.** `CLAUDE.md` is hard-wrapped, and `#282` sits at the
   end of `:1921` while `REOPENED` opens `:1922`. Even a multi-spelling
   regex evaluated line-by-line misses it, because the subject and the
   predicate straddle the wrap. Measured directly: a widened
   keyword set scanned per line returns 16 candidate refs and **#282 is
   not among them**; the same keyword set over a ±1-line window returns 18
   and finds it.

**Re-run, corrected on both axes** — multi-spelling
(`open|OPEN|REOPENED|still live|remains open|Backlog|Icebox|unscheduled|NOT
YET`), evaluated over a ±1-line window, every matched `#N` resolved against
`state=all`:

| Candidate | Line | State | Verdict |
|---|---|---|---|
| #318 | 236 | closed | **DEFECT** — asserts open |
| #282 | 1921–22 | closed | **DEFECT** — asserts REOPENED |
| #132 | 1114 | closed | OK — *"stayed open after #210 merged, v0.5.0"* narrates a past state |
| #216 | 1163 | closed | OK — historical example inside a general rule |
| #245 | 1793 | closed | OK — *"do not re-open"* is about the decision, not the issue |
| #415 | 1584 | closed | OK — *"NOT YET EXERCISED"* is about the retry mechanism, not the issue state |
| #232, #288, #391, #420, #422 | — | open | OK — correctly described as open |

**Corrected claim, stated at the strength the method supports: two known
false open-state assertions, found by two different searches.** Not "exactly
two exist" — the second search is broader than the first on both axes that
hid #282, but a third axis (an assertion spread over three lines, or a
state word this list does not contain) would hide a third the same way. The
count is a floor.

### A3.3 SELF-STALING entries (Q6) — the class the improver structurally cannot find

#444 is right that the improver's Currency criterion asks "is this true
now" and therefore verifies at the instant the text was written. Enumerated
by pattern over all 2,522 lines:

| Class | Sites | Representative | Decays when |
|---|---|---|---|
| **Test/file COUNT** | 2 | `CLAUDE.md:81` — "**1207 tests, 103 files** (2026-08-03)"; `:87` — "**1294 tests, 109 files** (2026-08-04)" | any test file is added |
| **Coverage percentages** | 2 | `:73-74` — 93.92 % statements, 88.99 % branches, 92.28 % functions, 95.52 % lines | any code or test change |
| **Bare commit SHAs** | 8 lines | `:716` `c4e139d`, `:825` `fb2481c`, `:841` `e303e496`, `:1031` `a59236e` | never — but they are unresolvable without the run they came from |
| **"as of" / "NOT YET EXERCISED" snapshots** | 9 lines | `:855` — "**NOT YET EXERCISED as of 2026-08-07**" (#415's deploy retry) | the moment the thing is exercised |
| **Pinned dependency versions** | 6 lines | `:374`, `:440` — `maplibre-gl@6.1.0`; `:1207` — `@playwright/test` 1.62.1 | any upgrade |
| **Timing measurements** | several | `:118` — "~16 min per run was measured 2026-08-07 … WHILE the config was still over-collecting" | the moment #451 lands, and the text says so |

**The measured instance, today:** `CLAUDE.md:87`'s "109 files" is stale by
**+7**. Counted against `app/vite.config.ts:477`'s own include glob
(`src/**/*.test.{ts,tsx}`): **116 files.** The e2e count (12 specs in
`app/e2e/`) still reproduces, and `app/sweep/`'s 6 arm files are correctly
outside that glob.

**How fast does this file actually stale? A series, not one interval.**
An earlier revision quoted "~127 lines per two days", taken from the
single gap between #444's 2026-08-07 snapshot (2,395) and this
document's measurement (2,522). One interval is not a rate. Measured at
every release tag (`git show <tag>:CLAUDE.md | wc -l`, tag dates from
`git log -1 --format=%cs`):

| Tag | Date | Lines | Δ since previous |
|---|---|---|---|
| v0.4.0 | 2026-07-24 | 457 | — |
| v0.5.0 | 2026-07-27 | 565 | +108 |
| v0.6.0 | 2026-07-31 | 918 | +353 |
| v0.7.0 | 2026-08-03 | 1,084 | +166 |
| v0.8.0 | 2026-08-03 | 1,351 | +267 |
| v0.9.0 | 2026-08-06 | 1,781 | +430 |
| v0.10.0 | 2026-08-07 | 2,279 | +498 |
| v0.11.0 | 2026-08-08 | 2,479 | +200 |
| HEAD `7195787` | 2026-08-08 | 2,522 | +43 |

**+2,065 lines in 15 days — the file is 5.5× its v0.4.0 size — but it does
NOT grow at a rate, and that is the load-bearing correction.** The
increments run +43 to +498, and v0.7.0→v0.8.0 adds 267 lines *on the same
calendar day*, so a per-day figure is undefined across that pair. The
process is **bursty**: growth arrives in session-revision and
PR-review-fix commits (of the last 15 commits touching the file, the
subjects are dominated by `docs: record session N learnings` and
`docs: address PR #NNN review`), not continuously. The quoted "~127 lines
per two days" happens to be the **smallest** recent increment, so it
understated; a series average (~138 lines/day) would overstate the quiet
periods just as badly. **Report the series; do not extrapolate a rate from
either end.**

**But three of these six classes are already handled well and must not be
"fixed".** `:118` carries its own expiry condition inline ("stops being
meaningful the moment #451 lands"); `:855` is explicitly labelled NOT YET
EXERCISED, which is the recommended formulation, not a defect; the bare
SHAs are historical run identifiers, and replacing them with anything
"fresher" would destroy the evidence. **The only self-staling class worth
acting on is the COUNT class** — test/file counts and coverage percentages
— because they read as current state, carry no expiry condition, and are
re-measurable by one command. Everything else in the table is either
correctly hedged already or is evidence rather than state.

### A3.4 A false claim about the CODE, carrying no citation at all — the axis both searches above are blind to

§A3.1 audits claims that carry a `file.ext:NNN` citation; §A3.2 audits
claims that assert an issue's state. A claim that describes the code and
cites **neither** falls between them. One such claim in `CLAUDE.md` is
false, and it was found by an outside reader rather than by either search
here — which is the finding, more than the instance is.

> `CLAUDE.md:1683-1686`, on a DOM helper that matched
> `[role="region"][aria-label="Origin"]` and never resolved: *"those
> regions are labelled by their `<h3>` via **`aria-labelledby`**, so
> Playwright's `getByRole('region', { name: 'Origin' })` resolves them and
> the CSS `[aria-label=…]` form silently does not"*.

Measured at `7195787`, per site: `app/src/components/PlannerPanel.tsx:353`
renders `<section aria-label={t('planner.origin.label')} …>` and `:394`
the destination equivalent — **`aria-label` directly, and no `<h3>` is
referenced by id**. `aria-labelledby` has never appeared in that file at
all: `git log -S 'aria-labelledby' -- app/src/components/PlannerPanel.tsx`
returns **zero commits**, and the only site anywhere in `app/src` is
`components/AboutDialog.tsx:107`.

**The bullet's operative advice is right, for a different reason — which
is exactly why the false mechanism survived.** `[role="region"]` is a CSS
attribute selector and needs a **literal** `role` attribute in the markup;
a named `<section>` carries the `region` role **implicitly**, so
`getByRole` resolves it while the attribute selector matches nothing. The
observed behaviour the bullet records (the selector silently matching
nothing, so the probed route never changed) is real, and *"use
`getByRole`, not the CSS `[aria-label=…]` form"* remains correct. Only the
stated mechanism is false.

**Why this is a class and not a typo.** A wrong *mechanism* under a right
*conclusion* is the shape `CLAUDE.md` itself names — *"a false MECHANISM
inside a correction"* — and it is invisible to both audits above: there is
no line number to go stale and no issue state to disagree with a tracker.
Its cost is that a reader who trusts the mechanism fixes the wrong thing,
or hardens the wrong selector.

**Consequence for §A3.2's stated floor.** That section says its count is a
floor because a third *axis* (an assertion spread over three lines, or a
state word outside the keyword list) could hide a third instance. This is
a **fourth** axis, and one no keyword search reaches at all. State the
audit's reach at the strength the method supports: `CLAUDE.md`'s prose was
audited along **two named axes — literal `file:line` citations and
issue-state assertions — and is not audited as a whole.** Correcting this
sentence is R1 item (6).

## A4. What must be resident, and does directory-scoping help? (Q3, Q4)

**Q4's answer is YES, and it is the only mechanism in the toolchain that
actually reduces resident cost.** Claude Code 2.1.226 carries a
nested-memory subsystem keyed on *triggers*, not on startup:

```
nestedMemoryAttachmentTriggers
pendingNestedMemoryTriggers
loadedNestedMemoryPaths
propagateNestedMemory: parent context has no pendingNestedMemoryTriggers; skipping
CLAUDE_CODE_COORDINATOR_PROPAGATE_NESTED_MEMORY
CLAUDE.md   CLAUDE.local.md
```

and a `paths:` frontmatter gate on the memory file itself:

```js
function li_(e){ let {frontmatter:t, content:r}=qp(e);
  if(!t.paths) return {content:r};
  let n=gvo(t.paths).map((o)=>o.endsWith("/**")?o.slice(0,-3):o).filter((o)=>o.length>0);
  if(n.length===0||n.every((o)=>o==="**")) return {content:r};
  return {content:r, paths:n}; }
```

— i.e. a memory file may declare `paths:` globs; the loader then attaches
`globs` to its record, and attachment is deferred to a trigger on a
matching path. There is **no** such directory-scoped file in this repo
today: `find . -name CLAUDE.md` (excluding `node_modules` and
`.claude/worktrees/`) returns exactly **`./CLAUDE.md`**.

**Q3 — which sections are genuinely per-request.** Judged against what a
turn can get wrong before any file is opened:

| Section | Tokens (cl100k) | Needed on every request? | Why |
|---|---|---|---|
| Project | 133 | **Yes** | 11 lines; names the domain and the source-of-truth spec |
| Layout | 589 | **Yes** | tells an agent where things are before it opens anything |
| Working style for this repo | 8,169 | **Yes** | orchestration, agent briefs, `gh` traps, merge safety — all fire before any file is touched |
| Commands | 3,515 | **Yes, mostly** | the `npm --prefix … run` vs `exec` trap and the lint/e2e gap are pre-file facts |
| Release & branching | 4,149 | **No — event-scoped** | binds a release cut, and `.claude/skills/release/SKILL.md` (638 lines) already owns the runbook |
| Code conventions | 5,121 | **No — `app/`-scoped** | every rule is about `app/src/**` or `app/vite.config.ts` |
| PWA / E2E / deploy | 8,885 | **Mixed** | the `sw.ts`/`e2e` half is `app/`-scoped; the deploy half is release-scoped |
| Domain rules | 5,563 | **No — `app/src/routing/` + `pipeline/`-scoped** | mask, polars, isochrone, motor rule, AIS |
| Verification lessons | 11,068 | **Mixed, and this is the hard one** | the general epistemics (mutation-vacuity, twin search, "what class of failure can this method not detect") are needed everywhere; the specific incident records are subsystem-scoped |

Naive arithmetic says moving Release & branching + Code conventions +
Domain rules to scoped files would drop ~14.8 k of ~47.2 k tokens (**31 %**)
and, with the PWA/deploy split, plausibly ~40 %. **That arithmetic is
offered as a bound, not as a plan** — see §"Considered and rejected" for
why the aggressive version of it is declined.

## A5. Duplication, and what belongs in `CONTRIBUTING.md` (Q7, Q8)

#444 states the right frame — duplication in prose is a **correctness
check**, and the second copy is what catches drift. Probed by phrase across
`CLAUDE.md`, the four hooks, the six skills, `CONTRIBUTING.md` and the
three agents:

| Phrase | CLAUDE.md | hooks | skills | CONTRIBUTING | Reading |
|---|---|---|---|---|---|
| `KNOWN SILENT-ALLOW` | 1 | 5 | 0 | 0 | **Deliberate twin** — `CLAUDE.md` points at the hook and says to read the hook's list, not its own |
| `subsumption` | 2 | 8 | 0 | 0 | **Deliberate twin**, same shape |
| `guard-asymmetry` | 5 | 3 | 1 | 0 | **Deliberate** — a principle stated once and applied at each site |
| `fail closed` | 3 | 7 | 1 | 0 | **Deliberate**, same |
| `cancel-in-progress` | 7 | 0 | 2 | 0 | **Deliberate twin** — `CLAUDE.md` reasons, `release/SKILL.md` executes |
| `same-SHA` | 4 | 0 | 1 | 0 | **Deliberate twin** (#398) |
| `stale-SHA` | 1 | 1 | 3 | 0 | **Deliberate** — `merge-train`/`pr-selfreview` mechanise it |
| `Signed-off-by` | 1 | 0 | 0 | 1 | **Correct split** — the CLAUDE.md copy is the agent-facing prohibition, the CONTRIBUTING copy the contributor-facing one |

**Finding: there is no accidental duplication worth removing.** Every
multi-copy fact found is a twin doing the job `CLAUDE.md` itself assigns to
twins, and in the two most-duplicated cases (`KNOWN SILENT-ALLOW`,
`subsumption`) `CLAUDE.md` explicitly delegates authority to the hook
rather than restating it. **Q7's answer is "the duplication is working;
change nothing."**

**Q8 — anything that belongs in `CONTRIBUTING.md`?** One candidate, and it
is a weak one: the `Commands` section's lint gap (`CLAUDE.md:56`, "`lint`
is literally `eslint src`, so `app/e2e/**` is NEVER linted by CI (#420,
open)") binds a human contributor exactly as much as an agent, and #420 is
genuinely open. It is a *copy*, not a *move* — a twin, per the rule above.
No other rule in the file binds humans more than agents; the release
runbook already lives in a skill, and `CONTRIBUTING.md` already carries the
tagger-identity and label-taxonomy material.

---

# Part B — the automation assessment

Judged on **attributable catches — evidence, not intent**, per Q9. The
committed surface (`git ls-files .claude`) is exactly: `agents/` (3),
`hooks/` (4), `skills/` (6), `settings.json`.
`.claude/settings.local.json` is gitignored (`.gitignore:25`), which is the
correct split.

## B1. The four hooks

All four support `--selftest` and **all four pass, run today**:

```
.claude/hooks/artifact-guard.sh       generated: 77 mechanism x protected-path combinations   SELFTEST OK
.claude/hooks/notices-nudge.sh        generated: 504 invocation shapes, 21 near-misses,
                                      4704 differential inputs (legacy-only=0, newly-fired=1680)  SELFTEST OK
.claude/hooks/premerge-verify.sh      SELFTEST OK
.claude/hooks/wind-fixture-guard.sh   SELFTEST OK
```

| Hook | Lines | First committed | Attributable catch | Contributor-recognisable? | **Verdict** |
|---|---|---|---|---|---|
| `artifact-guard.sh` | 1,438 | 2026-08-02 | **Yes** — #274 was filed because the pre-hook deny list omitted `app/public/icons/` and `app/public/brand/`; the hook exists to close a defect that had already happened. Its Bash arm (#309/PR #312) is younger and its attributable catches are less clear | **Yes** — "don't hand-edit a generated artifact" is a rule any contributor would recognise, and the artifacts are committed | **KEEP, one change owned elsewhere** (§B2) |
| `notices-nudge.sh` | 604 | 2026-07-31 | **Yes** — #216; the failure it prevents is a Dependabot bump reddening `app` at `git diff --exit-code public/THIRD-PARTY-NOTICES.txt` ~10 min later. Its own selftest is the largest in the repo (4,704 differential inputs) | **Yes** — CI fails for contributors identically | **KEEP unchanged** |
| `wind-fixture-guard.sh` | 560 | 2026-08-03 | **Yes** — #235; prevents committing the churned `app/public/test-fixtures/wind-sw12.json` that every `pree2e` run rewrites | **Yes** — any contributor running `npm --prefix app run e2e` produces the churn | **KEEP unchanged** |
| `premerge-verify.sh` | 153 | 2026-07-24 | **Yes, and it is the strongest in the set** — #177 mechanises the #119 near-miss, where a dropped `synchronize` webhook left a PR's green checks describing a pre-fix commit. That was a *measured* near-miss on a real PR, not a hypothetical | **Partly — this is the one that fails the open-source bar** | **KEEP, with a documented caveat** |

**The one open-source objection that survives scrutiny is
`premerge-verify.sh`, not `artifact-guard.sh`.** #444 nominates the
1,438-line guard as "the obvious case to examine first, not because it is
wrong but because it is the largest and the most opinionated" — measured,
that framing is backwards. `artifact-guard.sh` protects committed build
outputs and user-approved specs, both of which a contributor would
recognise and neither of which is maintainer-specific. `premerge-verify.sh`
gates `gh pr merge`, an operation **no contributor can perform** —
`develop` and `main` are both PR-only under the `protect-main` ruleset —
and its own header documents that it emits `ask` on "API/auth failure", so
a contributor without `gh` auth would get an unexplained prompt. The cost
is small (one `ask` on a command that would fail anyway) and the benefit to
the maintainer is the highest in the set, so the verdict is keep — but the
issue's premise about *which* hook to examine is corrected here rather than
repeated.

## B2. `artifact-guard.sh`'s Bash arm over-fires — measured, and the remedy is NOT owned by this document

**Say this first: the remedy for this finding is owned elsewhere, and an
earlier revision named the wrong owner — a CLOSED issue.** That revision
said the remedy "belongs to #437, which is an **open**,
adversarially-scoped audit". Measured:
`gh api repos/DocGerd/sail_command/issues/437 --jq '{state,closed_at}'` →
**`closed`, `2026-08-07T16:08:04Z`**, `state_reason: completed`, closed by
`e5eb389`. Handing a remedy to a closed issue is the same
deferral-into-a-void this document criticises in §A3.2 and that the
sibling spike criticises in its own cross-check — committed here, in the
one section whose entire point was to *not* propose a patch.

**Corrected ownership: #437's successors, which are open and are the
three tickets it spawned when it closed** —
[#447](https://github.com/DocGerd/sail_command/issues/447) (admit `grep`
by excluding ugrep's writer *options* rather than the verb — 158 fires,
the largest noise family),
[#448](https://github.com/DocGerd/sail_command/issues/448) (evaluate a
two-word read-only prefix allowlist for `git` — 120 fires), and
[#449](https://github.com/DocGerd/sail_command/issues/449) (`cd` scored a
STRONG zero twice; pursue the two-call bypass instead — 268 fires). All
three verified open on 2026-08-09. The §B2 corpus measurement below is
input to those three; **it is not input to #437, and a comment left on
#437 would land on a closed issue nobody is reading.**

#437's own rejection record survives its closure and still binds: four
loosenings measured and rejected on 2026-08-06 (deleting the
`docs/superpowers` ancestor entry; "narrowing" it to
`docs/superpowers/specs`; adding `cd` to `READONLY_VERBS`; segmenting on
`;`/`&&`/newline). Nothing below re-opens any of that. **This spike
MEASURES the problem and stops.** No patch is proposed here.

### The measurement

A corpus of **real** commands was assembled from this project's own
transcripts — 114 project directories (the main checkout plus every agent
worktree), **4,365 Bash tool calls, 4,158 unique command strings**. Each
was fed to the live hook as `{"tool_name":"Bash","tool_input":{"command":…}}`
with `CLAUDE_PROJECT_DIR` set to the repo root. The hook was not modified.

```
Counter({'allow': 3972, 'ask': 186})
unique commands evaluated: 4158
fired: 186 (4.47% of unique)   ·   186 of 4365 non-deduped calls (4.26%)
```

**Classification.** Two boundaries were computed rather than one, because
the entire disagreement between plausible false-positive rates lives in a
single judgement call:

- **32 fires** name a protected path **only inside a heredoc body** — a
  document being written to `/tmp` or a scratchpad that merely *discusses*
  `app/public/data` or `docs/superpowers`. Unambiguous noise.
- **106 fires** are read-only inspection disqualified by a
  `WRITE_CAPABLE_CHAR` — `ls`, `du`, `wc`, `grep`, `sed -n`,
  `git show/diff/log/status`, `curl` — e.g.
  `wc -l docs/superpowers/specs/…-design.md && grep -n '^#' …`.
  Unambiguous noise.
- **48 fires** reach a protected path with a write-capable construct:
  35 `git add`/`commit`/`rm`/`mv`/`checkout` on a spec, 5 redirects,
  4 file-mutating verbs, 2 pipeline regenerations, 2 interpreter heredocs.

| Where the boundary is drawn | True positives | Noise | **Noise share** |
|---|---|---|---|
| `git add <spec>` counts as a **true** positive (generous to the guard) | 48 | 138 | **74.2 %** |
| `git add <spec>` counts as noise — the Edit/Write arm already gated that spec edit, so re-asking at staging time is redundant | 13 | 173 | **93.0 %** |

**The ~88 % false-positive figure this spike was briefed with falls inside
that band, and the band — not either endpoint — is the honest result.**
The brief's figure was not re-derived here (its corpus and classifier were
not supplied); what is reported is an independent measurement that
corroborates it in direction and magnitude while naming the one
classification choice that moves it by 19 points. Anyone quoting a single
number should quote the boundary with it.

### Severity — and severity is where the intuition is wrong

| Statistic | Value |
|---|---|
| Sessions with ≥ 1 Bash call | 361 |
| Sessions with ≥ 1 guard fire | **36 (10.0 %)** |
| Fires per session — median | **0** |
| Fires per session — mean | 0.52 |
| Fires per session — **max** | **33** |

**The burden is not spread thin; it is concentrated.** Nine sessions in ten
never see this hook at all, which is why "4.47 % fire rate" understates the
problem — the maintainer's two over-restriction rulings (#388, then #437)
both came from sessions in the tail, and one session ate **33** prompts.
That is the severity claim: a P90 of zero and a max of 33 is a *worse*
user experience than a uniform 4 %, because the sessions that trip it are
precisely the spec-editing and artifact-investigating ones where the agent
is already doing careful work.

### The other direction — UNDER-firing, which the measurement above cannot see

**Everything above measures only over-firing, and an earlier revision
assessed only that** — which is half an assessment of a guard, and the
missing half was documented inside the guard itself the whole time. A
corpus of *commands that were actually issued* can only ever count fires
that happened; it is structurally blind to writes that reached a
protected path and were never asked about. The rate below is therefore
**not** measured here, and no figure is invented for it.

What *is* available is the guard's own enumeration.
`.claude/hooks/artifact-guard.sh:509-557` carries a block headed **"KNOWN
SILENT-ALLOW PATHS OF THE BASH ARM"**, with seven entries, each stated by
the author as "measured ALLOW through this script", and each explicitly
"known, not every". Reproduced in summary, because a reader deciding
whether to loosen the guard needs both columns:

| # | Silent-allow path | Reachability |
|---|---|---|
| 1 | `cd` into a protected directory in an **earlier** Bash call, then a bare-filename write (`cp /tmp/f mask.bin`) | **LIVE** — the comment says so outright: *"needs no contrivance, just two ordinary calls"*. Bash cwd persists across calls in this repo |
| 2 | Variable indirection (`D=app/public; cp /tmp/f $D/data/mask.bin`) — the literal substring never appears | Contrived but trivial |
| 3 | Programmatic path construction (`python3 -c "…os.path.join('app','public','data',…)"`) | Contrived |
| 4 | Quote-splitting, escaping, brace expansion, `xargs` reading targets from a file | Contrived |
| 5 | **Ancestor gap** — bare `app/public` and bare `app` are unprotected, so `mv app/public /tmp/stash`, `find app -name mask.bin -delete`, `tar -xf x.tar -C app/public` all allow | **LIVE**, and the most destructive of the set |
| 6 | `.bin` writes outside the protected directories | Latent (no such tracked file today) |
| 7 | The read-only exemption itself | **Intended allow**, not a gap — but the one entry a change to `READONLY_VERBS`/`WRITE_CAPABLE_*` can widen |

**Two consequences that change how §B2's noise band should be read:**

- **The guard is loose in one direction and noisy in the other, and both
  are consequences of the same design choice** — pure literal
  path-presence matching with no shell parsing, which is deliberate and
  settled (parsing is the shape that got PR #233 closed). Any loosening
  proposed to #447/#448/#449 must be argued against entry 7, not against
  the noise rate alone: the noise is the price of the same rule that
  makes entries 2–4 unreachable-by-design rather than bugs.
- **Entry 1 is the reason `cd` was rejected for `READONLY_VERBS`** (one
  of #437's four measured rejections). The `ask` on `cd app/public/data`
  is the *only* visible moment of the live two-call bypass — so the
  single change that would most reduce the prompt count also removes the
  only signal of the guard's most reachable hole. That trade-off belongs
  in #449, which is scoped to exactly it.

**Claim strength: the under-fire RATE is UNMEASURED**, and this section
does not estimate it. What is established is that seven silent-allow
paths exist, that two of them are reachable without contrivance, and that
they were known and recorded rather than discovered here.

## B3. The three subagents (Q11)

| Agent | Lines | Last touched | Still used? | Content still matches the code? | **Verdict** |
|---|---|---|---|---|---|
| `sail-implementer.md` | 61 | 2026-08-06 | **Yes** — two are live in this working tree right now (`impl-452`, `impl-459`) | Yes — its most recent commit is `2145a20` "docs: fix remaining live 6-10x CI-slowdown instances (#341)", i.e. a stale claim inside it was found and corrected. (`CLAUDE.md` attributes that sweep to PR #402; the PR number was **not** verified here, only the commit) | **KEEP** |
| `sail-reviewer.md` | 57 | 2026-07-16 | **Yes** — two live in this tree (`rev-461`, `rev-462`) | **Now checked** — see below | **KEEP** |
| `offline-pwa-reviewer.md` | 74 | 2026-07-22 | **Conditionally** — `CLAUDE.md` gates it to PWA-path changes (#181), so long gaps between invocations are correct behaviour, not disuse | **Now checked** — see below | **KEEP** |

**The other two agents, checked rather than assumed.** An earlier
revision recorded "Not re-derived" against both and still concluded **"No
change"** for all three — a generalisation from checks run on 1 of 3,
which is this document's own recurring defect class committed inside the
section that audits for it. Both have now been read in full against
`7195787`:

- **`sail-reviewer.md`** — its five domain-correctness bullets
  (query-time navigability; wind grids stored per plan; no post-hoc tack
  reducer; motor legs first-class with the router running twice; wind
  direction meteorological, nm/knots/WGS84) each restate a live
  `CLAUDE.md` *Domain rules* entry, and none contradicts it. Its
  conventions list (`Leg` narrowing on `kind`, no enums, i18n key parity,
  buffer-transfer rules, explicit vitest imports, no per-test timeouts
  tighter than file config) likewise matches. Its `git -C` guidance
  matches the current cwd rule. **One narrow staleness, and it is
  inherited rather than its own:** it names
  `docs/superpowers/specs/2026-07-14-sail-command-design.md` as the
  source of truth, which is correct, but the repo has since gained
  additional specs (the motor-decision-rule and UI-modernization
  addenda) that it does not mention. That is an incompleteness of the
  same shape as `pipeline-refresh`'s, not an error. **No change
  required.**
- **`offline-pwa-reviewer.md`** — its gate list
  (`app/src/sw.ts`, `services/glyphWarmup.ts`, `lib/glyphs.ts`,
  `services/basemapSource.ts`, the Vite PWA config, IndexedDB, offline)
  matches `CLAUDE.md`'s #181 gate exactly, and all four cited source
  paths exist. Its three checked invariants (Range route registered
  before `precacheAndRoute`; never cache Open-Meteo; glyphs
  runtime-cached and never precached, with install/activate never
  extended to fetch them) each reproduce a live `CLAUDE.md` PWA rule.
  **One stale cross-reference:** it directs the reader to *"the 'PWA /
  E2E / deploy (Phase F)' … sections"* of `CLAUDE.md`; the section is now
  titled **`PWA / E2E / deploy`** with no "(Phase F)" suffix
  (`grep -n '^## ' CLAUDE.md`). Cosmetic — a human or agent finds the
  section anyway — and it is a `.claude/` edit, which this document is
  not permitted to make. **Recorded, not fixed.**

Total 192 lines. These are cheap, they are invoked, and none is resident
per-request — an agent definition loads when the agent is spawned.
**Corrected verdict: no change required to any of the three; two
cosmetic incompletenesses recorded** (`sail-reviewer`'s single-spec
pointer, `offline-pwa-reviewer`'s "(Phase F)" suffix), neither worth a
`.claude/` edit on its own and both cheap to fold into the next revision
that touches those files for another reason.

## B4. The six skills (Q11)

| Skill | Lines | Last commit | Currency check performed | **Verdict** |
|---|---|---|---|---|
| `release` | 638 | 2026-08-06 | **Checked and CURRENT on the hardest point.** `SKILL.md:406-422` carries the post-#398 correction — that a same-SHA no-op is remedied by proceeding to the back-merge, not by re-running the tag deploy. That is exactly the fact `CLAUDE.md` says changed, and the skill moved with it | **KEEP** |
| `verify` | 210 | 2026-08-02 | Every command it names exists: `npm --prefix app run dev\|build\|preview\|test` are all in `app/package.json`'s scripts; `localhost:5173` is Vite's default | **KEEP** |
| `pr-selfreview` | 171 | 2026-08-03 | Ships `resolve-threads.sh` (#178) | **KEEP** |
| `merge-train` | 116 | 2026-07-24 | Oldest un-touched skill; encodes the #119 stale-SHA and #94 504 recoveries, both of which `CLAUDE.md` still documents as live | **KEEP** |
| `worktree-cleanup` | 87 | 2026-08-03 | Force-free teardown; matches `CLAUDE.md`'s ritual | **KEEP** |
| `pipeline-refresh` | 65 | 2026-07-16 | **One narrow gap, measured.** `pipeline/package.json` defines five scripts (`polars`, `harbors`, `seamarks`, `mask`, `icons`); the skill names only `npm --prefix pipeline run mask`. Nothing it says is *wrong* — `mask` is the one with the `.venv` prerequisite and the `verify_mask.py` gate — but it is the least current artifact in the set | **KEEP, note the gap** |

### The "every skill's cited command still exists" claim — now checked for all six

**An earlier revision made that claim on the strength of checking ONE
skill (`verify`), which is a generalisation from 1 of 6 — this document's
own recurring defect class.** Re-done exhaustively. Method, so it can be
re-run: extract every `npm … run|exec <script>` invocation and every
repo-relative file path from each `SKILL.md`
(`grep -ohE 'npm (--prefix [a-z]+ )?(run|exec) [a-z0-9:_-]+'` and
`grep -ohE '(\.claude|app|pipeline|docs|scripts)/[A-Za-z0-9_./-]+\.(sh|mjs|ts|tsx|py|json|md)'`),
then test each against `app/package.json`'s and `pipeline/package.json`'s
script tables and against the filesystem at `7195787`.

| Skill | npm scripts cited | Paths cited | Result |
|---|---|---|---|
| `verify` | `app run dev\|build\|preview\|test` (4) | 6 | **All exist** |
| `pipeline-refresh` | `app run test\|typecheck`, `pipeline run mask` (3) | 5 | **All exist** — the gap is *coverage*, not correctness (4 of 5 pipeline scripts unnamed) |
| `release` | `app run test` (1) | 2 | **All exist** |
| `pr-selfreview` | none | 2 | **1 exists** (`resolve-threads.sh`); `app/src/routing/solver.ts` does **not** — see below |
| `merge-train` | none | 0 | Vacuously clean — cites `gh`/`git` only |
| `worktree-cleanup` | none | 1 | **Exists** |

**`app/src/routing/solver.ts` is NOT a stale citation** — checked before
reporting it, because reporting it would have been a fabrication of
exactly the kind this repo documents. It appears twice in
`pr-selfreview/SKILL.md` (`:50`, `:95`), both times **inside an example
JSON payload**, alongside `"commit_id": "SHA"` and `"line": 42`. It is a
placeholder illustrating the review-comment API shape, not a claim that
the file exists. (`app/src/routing/` actually holds `isochrone.ts`,
`maneuver.ts`, `planRoute.ts`, `postprocess.ts`, `protocol.ts`,
`relaxedDepth.ts`, `worker.ts`, `workerClient.ts`.) A reader grepping for
drift will hit it, so it is recorded here as checked-and-benign rather
than left to be re-discovered.

**Corrected claim: 8 npm scripts and 16 paths cited across the six skills;
every npm script resolves, and every path resolves except one placeholder
inside an example payload.** The single real weakness is
`pipeline-refresh`'s coverage gap above — an *incompleteness*, not a
staleness.

**One incidental verification worth recording, because it answers a
question the skill-authoring rule raises:**
`.claude/skills/release/SKILL.md:4` sets `disable-model-invocation: true`,
and `release` is **absent** from the skill list this session was given while
the other five are present. That is direct evidence the field works as
intended in Claude Code — the release runbook is reachable only by an
explicit `/release`. It also confirms the known skill-creator false
positive (`quick_validate.py` flags this field) should stay unfixed.

## B5. The in-repo drift guards — the automation `CLAUDE.md` does not count

Nine test files read a repo artifact from disk and compare it against a
constant, which is this repo's cross-language-invariant pattern:

```
app/src/lib/changelogFragmentsFs.test.ts     app/src/lib/gpx.parse.test.ts
app/src/lib/panelWidth.test.ts               app/src/lib/seamarkPopover.coverage.test.ts
app/src/lib/useBannerHeight.test.ts          app/src/routing/legDistanceReconciliation.test.ts
app/src/routing/realmask.repro.test.ts       app/src/test/glyphFallbackWarningGuard.test.ts
app/src/test/timeoutBudgetVsJobCap.test.ts
```

plus the structural guards in `app/src/test/` that scan source rather than
read artifacts (`timeoutGuard.test.ts`, `cameraAnimationCallSites.test.ts`,
`subPathMeta.test.ts`). **These run in CI on every PR, which is more than
any hook can say**, and §A3.2's #318 finding is a live demonstration of one
working: `subPathMeta.test.ts` is why the `CLAUDE.md` claim about
`subPathMeta()` is now false.

**Verdict: KEEP all, and prefer this mechanism over new hooks.** One
caveat inherited from §0: `glyphFallbackWarningGuard.test.ts` reads
maplibre source out of `node_modules`, so it shares Hazard 1's exposure to
a stale install.

## B6. What is missing (Q12), and what should be removed (Q13)

**`.claude/workflows/` does not exist** (`ls -d` → `No such file or
directory`). Is that a gap? **No — it is the correct absence**, for a
reason specific to this repo: dynamic workflows are available without
committing anything, the repeatable multi-agent tasks this project actually
runs are *already* captured (`merge-train`, `release`, `pr-selfreview`,
`worktree-cleanup` are each a serial or fan-out procedure in skill form),
and a committed workflow would execute for contributors who cannot run it.
Adding one would be automation for its own sake, which #444's own non-goals
forbid.

**Q13 — what should be REMOVED.** After the audit above: **nothing in
`.claude/` should be deleted.** Every hook has an attributable catch;
across all six skills every npm script and every cited path resolves
(§B4); all three agents were read in full and are in use (§B3). A
recommendation that only adds is not an assessment — so the honest form of
the removal answer is that the removals belong in `CLAUDE.md`, not in
`.claude/`, and they are *relocations* rather than deletions
(§Recommendation R2). **The genuine deletion candidates are two clauses,
not one** — `CLAUDE.md:236`'s "`#318, open`" and the sentence it governs,
and `:1921-22`'s "#282, REOPENED … do not let it be closed again" — both
simply false (§A3.2). The tooling-budget evidence does not change this
answer; see the verdict section for why deleting automation would not
bend that curve.

---

## Gaps found while answering, that belong to neither Part A nor Part B

**G1 — `workbox-strategies` ships but is not in the notices.**
`app/src/sw.ts:8` imports `CacheFirst` from `workbox-strategies`, and it is
a declared runtime dependency in `app/package.json` (12 entries). But
`app/scripts/gen-third-party-notices.mjs:25-37`'s `PACKAGES` array lists
**11** and omits it, so `app/public/THIRD-PARTY-NOTICES.txt` contains 5
workbox mentions rather than 6 and the deployed service worker ships a
package with no reproduced licence notice. `CLAUDE.md`'s "the 11 runtime
packages listed in … `PACKAGES`" is therefore *correct about the script*
and misleading about the shipped set. This is a licence-compliance defect,
not a docs defect, and it is the one finding in this spike with a
consequence outside the repo. **It overlaps the sibling #446 spike — see
§"Filing" for the assignment.**

**G2 — the label taxonomy drift is live and is now measurable.** Open
non-PR issues carry both spellings: `type: bug` (14) alongside `type:bug`
(1), `priority: medium` (20) alongside `priority:medium` (1),
`area: map` (12) alongside `area:map` (1). `CLAUDE.md` already documents
this; what it lacks is the observation that the *cleanup is now cheap* —
three issues carry the whole unspaced population.

**G3 — the tooling share of the backlog, measured today.** This is the
metric #444's Q14 and #446's E15 share, so it is stated once, with its
command, and both documents should cite this form:

```
$ gh api --paginate 'repos/DocGerd/sail_command/issues?state=open&per_page=100' \
    --jq '[.[] | select(.pull_request==null)] | length'
46
$ gh api --paginate 'repos/DocGerd/sail_command/issues?state=open&per_page=100' \
    --jq '[.[] | select(.pull_request==null)
           | select(any(.labels[].name; test("area: ?tooling")))] | length'
18
```

**18 of 46 open non-PR issues (39.1 %) carry `area: tooling`** — not the
~30 % both issue bodies state. The 18 are #72, #143, #346, #357, #359,
#401, #406, #417, #420, #424, #428, #444, #446, #447, #448, #449, #451,
#459. Four qualifications, all load-bearing:

(a) the regex `area: ?tooling` deliberately spans both label spellings,
because a single-spelling filter silently undercounts (per G2), though the
unspaced `area:tooling` happens to carry zero open issues today
(`test("^area:tooling$")` → 0);

(b) **this spike and its sibling are themselves two of the 18** (#444,
#446), so the de-inflated figure is **16 of 44 = 36.4 %**;

(c) **three more (#447, #448, #449) are one investigation's fan-out** —
the tickets #437 spawned when it closed — so the count overstates the
number of distinct problems;

(d) **the ratio decays, and it has now done so TWICE inside one day.**
Three readings of the same two commands, all on **2026-08-09**:

| Reading | Value | What moved, and in which term |
|---|---|---|
| earliest (sibling spike's first revision) | 18 / **45** = **40.0 %** | — |
| this document's headline above | 18 / **46** = **39.1 %** | **#463** opened `10:15:30Z` (`type: chore`, `priority: low`, **no** `area:` label) → **denominator only**, so the share FELL |
| re-measured at review time | **17 / 45** = **37.8 %** | **#459** closed `11:45:09Z` carrying `area: tooling` → left **both** terms, so the share fell again |

Both later movements were caused by ordinary same-day project activity —
one issue opened, one closed — and neither is an error in the earlier
reading. **The headline figure above is retained with its date rather than
overwritten**, because replacing it with 37.8 % would mint a third
timeless-looking number with the same half-life; what a reader needs is
the two commands and the observation that the denominator moves on a
timescale of hours. **Re-run them; do not quote the ratio.** The enumerated
18 above is likewise a snapshot: #459 has since left it, leaving
#72, #143, #346, #357, #359, #401, #406, #417, #420, #424, #428, #444,
#446, #447, #448, #449, #451.

None of this touches the conclusion, and that is worth stating explicitly
so the decay is not read as instability in the finding: every reading lands
between 37 % and 40 %, all three are far above the ~30 % both issue bodies
assert, and the verdict below rests on the **composition** of the tooling
work, not on any one ratio.

The share is higher than believed either way. What follows from it is
ruled in §*"The tooling-budget verdict (Q14's shared metric)"* below —
not left as an argument gesturing at a decision.

---

## The tooling-budget verdict (Q14's shared metric)

**This section exists because an earlier revision did not contain it.**
#446 measured the tooling curve and explicitly deferred the verdict to
#444; #444 never cited #446's series and had no tooling-budget row. The
named shared metric of the whole two-spike exercise was therefore
measured by one document and ruled on by neither. Mutual deferral reads
as coverage and is absence.

**The measurement is #446's and is cited, not re-derived** — one number,
one owner, per the twin rule. From `docs/spikes/446-architecture-fit.md`
Q15, measured 2026-08-09 at `7195787`:

| Week | Tooling created | Product created | Tooling share |
|---|---|---|---|
| 2026-W29 | 1 | 39 | 2.5 % |
| 2026-W30 | 20 | 39 | 33.9 % |
| 2026-W31 | 21 | 32 | 39.6 % |
| 2026-W32 | 29 | 30 | 49.2 % |

with the backlog snapshot at **18 of 46 open non-PR issues = 39.1 %**
(16 of 44 = 36.4 % excluding the two spikes, which carry the label
themselves) — a figure §G3(d) records decaying **twice on its measurement
day**, to 37.8 % by review time; the verdict below rests on composition,
not on the ratio. #446 narrows the trend claim to the **three post-inception
points** (33.9 % → 39.6 % → 49.2 %), because W29 is the founding week and
its 2.5 % is a base-rate artifact. This document adopts that narrowing
rather than the stronger headline.

### The verdict, on the half this document actually audited

**The automation surface is NOT what is driving the tooling budget, and
shrinking it would not bend the curve. Leave it alone.** Three measured
reasons, each independently checkable:

1. **The committed automation is small and static.** `.claude/` is 4
   hooks (2,755 lines), 6 skills, 3 agents (192 lines), 0 workflows.
   Across the four weeks of the series it gained **one** hook
   (`wind-fixture-guard.sh`, 2026-08-03) and no skills or agents. A
   surface that added one artifact in four weeks cannot explain a curve
   that went from 1 to 29 issues per week.
2. **The tooling issues are overwhelmingly about ONE artifact, and they
   are that artifact's own fan-out.** Of the 18 open tooling issues,
   #447, #448 and #449 are the three follow-ups #437 spawned when it
   closed — one investigation, three tickets. Counting them as three
   independent arrivals overstates the arrival rate; this is a
   fan-out-shaped backlog, not a broad one.
3. **Tooling closes at very nearly the product rate** — 53 of 71 created
   (74.6 %) against 112 of 140 (80.0 %), per #446 Q15. A budget line
   that closes at 75 % is being *worked*, not merely accumulated. It is
   a throughput question, not a debt question.

**What the curve IS driven by, and it is this document's own subject:**
`CLAUDE.md` grew from 457 lines to 2,522 across the same span (§A3.3's
series). Nine of the ten most recent commits touching it are
session-revision or PR-review-fix commits — i.e. the tooling work this
project generates is predominantly **knowledge maintenance on one file**,
not maintenance of hooks, skills or agents. That is exactly what R1 and
R2 address, and it is why the recommendation is *relocate and correct*
rather than *delete automation*.

**Consequence for Q13 ("what should be removed"): nothing in `.claude/`,
and the tooling-budget evidence does not change that** — deleting any of
it would remove an artifact with an attributable catch while leaving the
actual growth term untouched.

**Claim strength, deliberately narrowed.** This is a verdict about
**composition** (what the tooling work is *about*), which the label and
commit data support. It is **not** a claim that the total rate is
acceptable, sustainable, or should be capped — that is a resourcing
judgement about a single-maintainer project, no measurement settles it,
and it is listed under *"Needs a maintainer decision"* rather than
answered here.

---

## RECOMMENDATION

Three changes. Nine declined. **The overall verdict on Q14 is that this is
*mostly* fine as it is** — the automation needs no structural work, the
duplication is doing its job, and the file's length is justified by its
content. What is not fine is *where the content is resident* and *how
current a handful of its claims are*.

| # | Change | Cost | Benefit | Risk if wrong |
|---|---|---|---|---|
| **R1** | **Fix the six measured accuracy defects in `CLAUDE.md`** — five currency, one false mechanism: (1) delete "#318, open" and the false `subPathMeta()` claim at `:236`; (2) **correct #282's "REOPENED … do not let it be closed again" at `:1921-22`, which asserts a live state against a closed issue**; (3) re-anchor the five stale in-repo citations (§A3.1 rows 4–8) to their current lines *and* add a symbol anchor beside each; (4) drop the line number from the `isochrone.ts` historical citation; (5) re-measure the test-file count at `:87` (109 → **116**); (6) **correct the `aria-labelledby` mechanism at `:1683-1686`** to `aria-label` + the implicit-`region`-role reason, keeping the bullet's advice unchanged (§A3.4) | **Low** — one approval-gated main-session edit, ~15 lines. All six are located and the corrected values are in §A3 | **High** — **two** of them (`#318, open` and `#282, REOPENED`) are wrong in the dangerous direction, advertising closed work as live; the #318 one sits inside the guard-asymmetry paragraph itself | Near zero for (1), (3)–(5). **(2) carries a judgement the maintainer owns**: whether #282 *should* be reopened is a separate question from whether the text currently misdescribes the tracker. Fix the description; raise the reopening separately if wanted |
| **R2** | **Move `Domain rules` (5,563 tok) and `Code conventions` (5,121 tok) into a directory-scoped `app/CLAUDE.md`** carrying `paths:` frontmatter, leaving the root file's other seven sections resident. Nothing is deleted; the text moves verbatim | **Medium** — one file creation, one careful cut, and a verification pass (open a file under `app/src/`, confirm the nested memory attaches). Must be done in the main session with approval | **Split into its two halves, which have different evidential status — see below. MEASURED: the 10.7 k of 47.2 k tokens (23 %) that would move. UNVERIFIED: that moving them delivers that saving to a real session** | **This is the recommendation most likely to be wrong**, and the risk is specific: if the trigger does not fire in some path (a subagent that never opens an `app/` file but reasons about one; a `git`-only session), a hard-won rule silently stops being resident. Mitigation: verify empirically before committing, and start with **one** section, not two |
| **R3** | **Add `workbox-strategies` to `PACKAGES`** (`app/scripts/gen-third-party-notices.mjs:25-37`) and regenerate `app/public/THIRD-PARTY-NOTICES.txt` | **Very low** — one array entry plus `npm --prefix app run notices` | **High relative to cost** — closes a real licence-notice omission for a package that provably ships (`app/src/sw.ts:8`) | Near zero; CI's `git diff --exit-code` gate proves the regeneration landed |

**Priority order is R1 → R3 → R2.** R1 and R3 are cheap and unambiguous;
R2 is the one with judgement in it and should not be bundled with them.

### R2's benefit, split — because "High and measured" conflated two claims

An earlier revision described R2's benefit as "High and measured". Half
of that is true and the other half was never measured, and they must not
travel together:

- **MEASURED — the size of the thing that would move.** `Domain rules`
  is 5,563 cl100k tokens and `Code conventions` 5,121, together 10,684 of
  the file's 47,219 (**22.6 %**), by the `awk`-over-`^## ` boundary
  method in §1. That number is a property of the file and is solid.
- **UNVERIFIED — that moving them reduces any real session's resident
  prompt by that amount.** The delivery mechanism is the `paths:`
  frontmatter / nested-memory trigger of §A4. What §A4 establishes is
  that the mechanism *exists* in Claude Code 2.1.226 — the loader
  function `li_`, the `nestedMemoryAttachmentTriggers` /
  `pendingNestedMemoryTriggers` / `loadedNestedMemoryPaths` fields, and
  the `CLAUDE_CODE_COORDINATOR_PROPAGATE_NESTED_MEMORY` env var. What it
  does **not** establish is: which tool calls count as triggers, whether
  a subagent inherits the attachment, what happens on a session that
  reasons about `app/src/**` without opening a file under it, or that a
  non-attached scoped file costs zero rather than being loaded anyway.
  **Not one of those was measured**, because there is no such file in
  this repo to measure against (`find . -name CLAUDE.md` → `./CLAUDE.md`
  alone).

**So R2's honest benefit is a measured upper bound on a saving whose
delivery is unproven**, and the empirical precondition is already listed
under *"What remains open"* item 3. Do not quote "23 %" as a result.

### R2 has no attributable past defect — an explicit exception, not an oversight

#446's decision rule ("**attributable defect, or declined**") is stated
in both spikes as the shared bar, and **R2 does not clear it.** No defect
has ever been traced to `CLAUDE.md`'s residency: no session is known to
have failed, degraded or produced a wrong answer because the file is
large. The `large-memory-files` warning threshold is crossed by 4.47×,
but §"Claim-strength notes" already records that **no degradation was
measured and none should be inferred from the warning**.

Rather than leave that silently exempt, name the scope of the bar — the
same scoping #446's recommendation section applies to its own R1/R3:

> The bar governs **defect-prevention instruments** — refactors, facades,
> branded types, new guards — because prevention with nothing to prevent
> is cost without benefit. It does not govern a **cost reduction**, a
> **defect fix**, or a **correction of a false statement**, each of which
> has its own bar.

**R1 is a correction of false statements** (two of them wrong in the
dangerous direction, §A3.2) and clears that bar. **R3 is a
licence-compliance fix** (§G1) and clears that one. **R2 is a pure cost
reduction**, so the defect bar does not apply and a different one does:

| R2's actual bar | Status |
|---|---|
| The cost is real and measured | **MET** — 10,684 of 47,219 tokens; 4.47× the 200 k-context threshold |
| The saving mechanism is verified to deliver it | **NOT MET** — see the split above; this is the blocker |
| The failure mode is bounded and detectable | **PARTIALLY MET** — a silently non-resident rule is by construction hard to notice, which is why the mitigation is "start with one section" |

**Consequence: R2 stays a recommendation but an explicitly conditional
one**, gated on the trigger verification, and it is correctly the lowest
of the three in priority order. Anyone applying #446's bar mechanically
to all three rows would reject R2 and be right to, on that bar — which is
precisely why the scope is written down instead of assumed.

---

## Considered and rejected

1. **Trim `CLAUDE.md` to hit a line count. REJECTED — this is the answer
   #444 pre-emptively warns against, and the measurement supports the
   warning.** The `Verification lessons` section is 603 lines / 11,068
   tokens and is the largest single block, but §A3.2 shows 90 closed issues
   and 57 closed PRs referenced across the file: those are provenance
   stamps on lessons that each cost CI cycles, a wrong merge, or a
   multi-round debugging session. Deleting one does not save 25 words; it
   re-opens a road already walked. #444's non-goal is explicit and it is
   correct.

2. **Restructure around `@path` imports. REJECTED on measured evidence
   (§A2).** Imports are resolved at load and inlined; the loader's own
   telemetry calls the result a "startup-seeded entry". Resident cost would
   change by approximately zero, and the content would be spread across
   more files each separately size-checked. This was the obvious plan and
   it does not work.

3. **Move the whole `PWA / E2E / deploy` section (8,885 tok) to a scoped
   file. REJECTED as currently shaped.** It is genuinely mixed: the
   `sw.ts`/`e2e` half is `app/`-scoped, but the deploy half describes
   `.github/workflows/deploy.yml`, the #398 same-SHA no-op and the #415
   retry — facts that must be resident during a *release*, when the files
   being touched are `CHANGELOG.md` and `ROADMAP.md`, not `app/`. Splitting
   it correctly requires splitting the section first, which is a bigger
   edit than R2 and should not ride along with it.

4. **Move `Release & branching` (4,149 tok) into
   `.claude/skills/release/SKILL.md`. REJECTED — it would destroy a working
   twin.** §A5 measured `cancel-in-progress` at 7 CLAUDE.md sites and 2
   skill sites, and `same-SHA` at 4 and 1. `CLAUDE.md` carries the
   *reasoning*; the skill carries the *procedure*. Collapsing them removes
   the second copy that catches drift — and §B4 shows the twin working
   (the skill moved with the #398 correction). Duplication here is the
   correctness check, exactly as Q7 anticipates.

5. **Deduplicate `KNOWN SILENT-ALLOW` / `subsumption` between `CLAUDE.md`
   and `artifact-guard.sh`. REJECTED.** Measured 1-vs-5 and 2-vs-8, and
   `CLAUDE.md` already delegates authority to the hook ("read the three
   arrays off the hook itself … rather than from any second copy —
   including this one"). The duplication is a pointer, not a copy.

6. **Delete or shrink any of the four hooks. REJECTED.** All four selftest
   green, all four have an attributable catch (§B1), and all four are
   contributor-recognisable except `premerge-verify.sh`, whose cost to a
   contributor is one `ask` on a command they cannot execute anyway.

7. **Create `.claude/workflows/`. REJECTED (§B6)** — dynamic workflows need
   no committed artifact, the repeatable procedures are already skills, and
   a committed workflow executes for contributors who cannot run it.

8. **Patch `artifact-guard.sh`'s Bash arm here. REJECTED — out of scope by
   ownership, not by merit.** The remedy is owned by the three OPEN
   successors **#447 / #448 / #449**, not by #437, which closed on
   `2026-08-07T16:08:04Z` (§B2). #437's own record survives its closure and
   still binds: an acceptance pair (`ls … | head` suppressed, `node -e`
   still asking) and four measured-and-rejected loosenings. A second
   document proposing a fix would either duplicate that work or contradict
   it. §B2 supplies the corpus measurement those three need and nothing
   more.

   **This item was itself a second instance of the defect §B2 corrects, and
   that is recorded rather than silently fixed.** §B2 named the wrong owner,
   was corrected in place, and the correction was not enumerated across the
   rest of the document — so this item and the *"Needs a maintainer
   decision"* bullet below both kept handing the remedy to a closed issue
   while §B2 and the Filing table said otherwise. One document, three
   ownership claims, two of them stale: this repo's **enumerate,
   don't patch** rule failing inside a document that quotes it. The check
   that finds it is one command — `grep -n '#437'` over this file, then
   classify each hit as an OWNERSHIP claim (must move) or a HISTORICAL
   reference (#437's measurement, its rejections, its fan-out — all stay).

9. **Auto-regenerate the self-staling counts (a CI job that rewrites
   `CLAUDE.md`'s test-file count). REJECTED.** `develop` is protected and
   PR-only, so nothing in CI can commit back to it — the same structural
   reason the changelog-fragment ritual exists. A nightly PR that touches
   `CLAUDE.md` to update one integer would cost more review attention than
   the integer is worth.

---

## What remains open, and what needs a maintainer decision

**Open — measured but not resolved here:**

1. **The exact `CLAUDE.md` share of the resident prompt.** §A1 brackets it
   at ~45 k–60 k tokens by three methods, and §A1.4 measures the whole
   first-turn prompt at a median of 81,150 tokens across the 28 sessions
   since 2026-08-01. The split between `CLAUDE.md`, the global
   `~/.claude/CLAUDE.md`, `MEMORY.md`, tool schemas and skill listings was
   **not** measured. `/context` prints it; that is a main-session action.
2. **Whether the eight maplibre citations are still correct.** Blocked on
   Hazard 1 (`node_modules` at 6.0.0, lockfile at 6.1.0). Needs `npm ci`
   in a tree with no live agents, then per-citation re-derivation — never
   a bulk offset, per `CLAUDE.md`'s own rule.
3. **Whether R2's nested-memory trigger fires reliably enough.** The
   mechanism is established (§A4: `paths:` frontmatter, the trigger fields,
   the propagate-to-subagent env var). What is *not* established is which
   tool calls count as triggers, and in particular whether a subagent that
   reasons about `app/src/**` without opening a file under it gets the
   scoped memory. This is the empirical precondition for R2 and it must be
   verified before the cut, not after.

**Needs a maintainer decision:**

- **R2 at all.** It is the only recommendation that trades a small risk of
  a lesson silently leaving the prompt against a measured 23 % reduction in
  resident cost. A single-maintainer project with a working, deployed
  product may reasonably decline it, and #444 explicitly permits "leave it
  alone" as a verdict. If declined, R1 and R3 still stand and the file
  simply keeps growing — in bursts of +43 to +498 lines per release
  interval, 457 → 2,522 across 15 days (§A3.3's series; no per-day rate
  is claimed) — until it trips the 1 M-context threshold too.
- **Whether `git add <spec>` should ask.** This single boundary moves
  `artifact-guard.sh`'s measured noise share from 74.2 % to 93.0 %
  (§B2). It is a policy question about whether the ask-gate protects the
  *edit* or the *commit*, and only the maintainer can settle it. It is
  input to **#447 / #448 / #449** — #437 is closed — not a decision for
  this document.
- **Whether the label-taxonomy cleanup (G2) is worth scheduling** now that
  it is three issues wide.

---

## Filing

**No follow-up issues were filed by this document** — the task was
report-only and permitted the creation of exactly one file.

**Every row below names exactly ONE owner, and each cross-document
assignment was verified against the other document rather than asserted.**
An earlier revision of this table assigned the `workbox-strategies` fix to
#446 while #446's cross-check assigned it to #444 — each deferring to the
other, so a **licence-compliance defect that ships in production**
(`workbox-strategies` is imported at `app/src/sw.ts:8`, is a declared
runtime dependency, and is absent from
`app/scripts/gen-third-party-notices.mjs`'s `PACKAGES` array, so
`THIRD-PARTY-NOTICES.txt` carries 5 workbox entries where 6 ship) would
have been filed by nobody. Mutual deferral reads as coverage and is
absence.

| Proposed issue | Owner | Verification of the assignment |
|---|---|---|
| Fix the `CLAUDE.md` currency defects (R1) | **#444 (this spike)** | #446's cross-check agrees: it routes citation currency here and does not file it |
| **Add `workbox-strategies` to the notices `PACKAGES`** (R3, G1) | **#444 (this spike)** | **Reassigned.** This document holds the full measurement (§G1) *and* the recommendation (R3); #446 only reproduces the one-line delta in its §0. The sibling's cross-check has been corrected to name #444 as owner — checked, not assumed |
| Directory-scoped `app/CLAUDE.md` (R2) | **#444** | Blocked on the trigger verification in "Open" item 3; no other document mentions it |
| Label-taxonomy spelling cleanup (G2) | **#444** | Three issues; cheap now |
| `CLAUDE.md` describes **#282** as REOPENED while the issue is closed | **#444** | **Newly accepted.** #446 routed this here and this document contained zero mentions of #282 until §A3.2 was corrected — the third instance of the same deferral failure, and the one that had actually gone unowned |
| Corpus measurement handed to the guard audit (§B2) | **#447 / #448 / #449** (open) | **Reassigned from #437, which is CLOSED** (`2026-08-07T16:08:04Z`). A comment on #437 lands on a closed issue; the three successors it spawned are the live owners, and §B2 names which measurement belongs to which |
| `.claude/` cosmetic incompletenesses (`sail-reviewer`'s single-spec pointer; `offline-pwa-reviewer`'s stale "(Phase F)" section title) | **Nobody — deliberately not filed** | Recorded in §B3. Each is one phrase; filing two issues to fix two phrases costs more than the phrases. Fold into the next revision that touches those files anyway |

---

## Claim-strength notes

Recorded so a later reader can see which statements are load-bearing and
which are hedged, per this repo's "prefer narrowed to closed" rule:

- **"Imports are inlined, so `@path` saves nothing"** rests on the 2.1.226
  binary's own loader code and telemetry string. It is a strong claim about
  *this version*. It is version-specific and should be re-derived after any
  Claude Code upgrade — the constants `ii_`, `si_`, `sQu`, `gi_` are the
  things to re-read.
- **"4.47× over the threshold"** is arithmetic over one measured constant
  (`ii_ = 0.05`, `si_ = 40000`) and one measured file size. What is *not*
  established is that tripping `large-memory-files` has any effect beyond
  the warning itself — no degradation was measured, and none should be
  inferred.
- **"74.2 %–93.0 % noise"** is a band, deliberately. Neither endpoint is
  "the" false-positive rate. The classifier is stated in §B2 and can be
  re-run; the corpus is this project's own transcripts, which means it is
  representative of *this maintainer's* command style and of no one
  else's.
- **"All four hooks have an attributable catch"** is per-hook, each with
  its own issue, and is not a generalisation about hooks. The weakest of
  the four is `artifact-guard.sh`'s **Bash arm** specifically — the
  Edit/Write arm's catch (#274) is solid; the Bash arm's is not
  independently established here.
- **"No accidental duplication"** is bounded by the eight phrases probed in
  §A5. It is not a proof over the whole file; a ninth phrase could
  falsify it.
- **"Two false open-state assertions"** (§A3.2) is a **floor, not a
  count.** The corrected search widened two axes that had hidden #282
  (spelling, and line-scoping over hard-wrapped prose); a third axis — an
  assertion spread across three lines, or a state word outside the
  keyword list — would hide a third the same way. The first search
  called itself exhaustive and was not.
- **The artifact-guard UNDER-fire rate is UNMEASURED** and no figure is
  estimated for it (§B2). A corpus of issued commands can only count
  fires that happened. What is established is that seven silent-allow
  paths are enumerated in the hook itself and that two are reachable
  without contrivance.
- **The tooling-budget verdict is about COMPOSITION, not rate.** It says
  the automation surface is not what drives the curve; it does **not**
  say the rate is acceptable or sustainable. That is a resourcing
  judgement listed under *"Needs a maintainer decision"*.
- **R2's "23 %" is a measured upper BOUND on a saving whose delivery is
  unverified.** The section sizes are solid; the nested-memory trigger's
  behaviour was never exercised, because no directory-scoped memory file
  exists in this repo to exercise it against.
- **The `CLAUDE.md` growth figures are a SERIES, and no rate is claimed**
  (§A3.3). Two release tags share a calendar day, so a per-day figure is
  undefined across that pair; growth arrives in bursts at session-end
  revision commits. The earlier "~127 lines per two days" was one
  interval, and the smallest recent one.
- **"Every skill's cited command still exists"** now covers all six
  skills (§B4) rather than the one it was originally asserted from. It
  remains bounded by the extraction method stated there — npm
  invocations and repo-relative paths — and says nothing about `gh` or
  `git` invocations, which are toolchain, not repo, and were not
  checked.
- **The three agent definitions were read in full** (§B3), which the
  earlier "No change" verdict had not been. Two cosmetic
  incompletenesses were found and are recorded rather than fixed; this
  document is not permitted to edit `.claude/`.
