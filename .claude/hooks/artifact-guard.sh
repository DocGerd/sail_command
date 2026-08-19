#!/usr/bin/env bash
# PreToolUse guard for generated pipeline artifacts and the source-of-truth
# spec docs — SailCommand #274 (extracted from the inline one-liner it
# replaces; the specs `ask` branch is unchanged from before).
# Fix wave on PR #305 review (B1/B2/M1/M2+M4/M5): see below for what changed
# and why.
#
# TWO ARMS, dispatched on tool_name (#309):
#   - Edit|Write  -> `deny` on a generated artifact, `ask` on docs/superpowers/
#                    (UNCHANGED by every later revision, including the 2026-08-09
#                    advisory split below, which touches the Bash arm only).
#   - Bash        -> path-presence match on the command string. Three outcomes:
#                    provably read-only -> emit NOTHING; a docs/superpowers
#                    path -> blocking `ask`; any other protected path -> a
#                    NON-BLOCKING `additionalContext` ADVISORY carrying no
#                    permissionDecision at all. See "TWO OUTCOMES FOR A
#                    NON-EXEMPT HIT" in DESIGN below for the ruling, the
#                    measurement and why the two halves differ.
#
# ---------------------------------------------------------------------------
# INTENT (the acceptance criterion #274 asks be stated next to the guard):
#
# app/public/{data,icons,brand}/ are committed BUILD OUTPUTS produced by
# pipeline/ scripts (npm --prefix pipeline run polars|harbors|seamarks|mask|
# icons), and app/public/THIRD-PARTY-NOTICES.txt is a committed build output
# produced by an app-side script (npm --prefix app run notices). This guard's
# job is "don't hand-edit a generated artifact", not "these paths may never
# change" — regenerating via the script and committing the result is
# unaffected, since only Claude's own Edit/Write tool calls hit this hook.
#
# ONE NAMED EXCEPTION (PR #305 review, B1): app/public/icons/icon.svg is not
# a generated output living alongside the pipeline's other files in that
# directory — it is the hand-authored SOURCE `build_icons.mjs` rasterises
# FROM (pipeline/README.md: "edit the SVG directly to change the artwork").
# Denying it would hard-block the repo's documented way to change the app
# icon, and the deny message's "regenerate via the pipeline" instruction is
# circular for this one file (the pipeline READS it, it does not WRITE it).
# It gets its own `case` arm, checked before the directory pattern, so it
# stays writable while every other file under icons/ stays covered. If a
# future pipeline output directory grows its own hand-authored source input,
# it needs the same treatment — the directory-shaped match below covers
# every FILE TYPE in a generated directory automatically, but it cannot by
# itself distinguish an output from an input; that distinction needs an
# explicit allow arm named here.
#
# ---------------------------------------------------------------------------
# ASYMMETRY (CLAUDE.md, "Design a guard around its ASYMMETRY"): this hook is
# BLOCKING (permissionDecision: "deny"), so it must fail CLOSED — an
# under-fire silently lets a generated artifact drift from its generator,
# which is exactly the defect #274 was filed over (the deny list omitted
# app/public/icons/ and app/public/brand/). Accordingly:
#   - the match below is DIRECTORY-shaped (`*app/public/data/*` etc.), not an
#     enumeration of extensions within those directories — a future pipeline
#     OUTPUT of any file type is covered automatically (see the exception
#     note above for the one thing directory-shaping cannot see: a future
#     hand-authored INPUT dropped into one of these directories needs its
#     own allow arm, the same way icon.svg got one);
#   - the original extension patterns (`*.bin`, `*.pmtiles`, `*.pmtiles.png`)
#     are KEPT alongside the directory patterns rather than replaced. Today
#     every file matching them already lives under app/public/data/ (verified
#     via `git ls-files`), which could tempt dropping them as redundant —
#     don't: narrowing a fail-closed guard because of what the CURRENT tree
#     happens to contain is the same reasoning that produced this bug. A
#     future pipeline output of that shape landing OUTSIDE the three known
#     directories stays covered only because these patterns are still here.
#
# KNOWN WAYS THE FILE_PATH (EDIT|WRITE) ARM CAN PRODUCE NO EXPLICIT DECISION
# (PR #305 review, B2, retitled from "EVERY WAY" on the same PR's follow-up
# review — CLAUDE.md: prefer "narrowed" to "closed" unless the measurement
# really covers the whole space, and "EVERY WAY" is exactly the over-claim
# that licenses the next regression, the same shape as round 1's M1).
# RE-SCOPED (#309 fix-wave M2, CLAUDE.md's same-PR-invalidation class): this
# list is entirely `file_path`-framed and was written when this script served
# only the Edit|Write matcher. It now describes ONE of the script's two arms
# — see "KNOWN SILENT-ALLOW PATHS OF THE BASH ARM" further below for the
# other. A blocking guard's silent-allow paths are the same defect class #274
# was filed over, one layer up from the `case` arms — enumerated so a future
# change can be checked against this list, understanding the list is what has
# been FOUND, not a proof of completeness:
#   1. Empty stdin (`printf '' | ...`)              -> ask (checked below,
#      new: `jq -r '... // empty'` exits 0 on empty input, so without this
#      check the `||` fallback chain never fires and the case matches
#      nothing — a silent allow. Unreachable under Claude Code's real
#      dispatch, which always sends a JSON payload, but the comment at the
#      top of this file used to claim "never silently allows" and this was
#      the one path that contradicted it.)
#   2. Malformed JSON, or jq AND python3 both unavailable -> ask (below).
#   3. `settings.json` cannot invoke this script at all (missing file, not
#      executable, `CLAUDE_PROJECT_DIR` unset/wrong) -> this script never
#      runs, so nothing here can catch it. Fixed at the CALL SITE instead:
#      settings.json checks `[ -f "$H" ] && [ -x "$H" ]` before invoking
#      (the `-f` matters: `-x` alone is also true for a DIRECTORY at that
#      path — the search bit, not "is a runnable file" — so `exec` on a
#      directory fails non-blocking-error 126 with no JSON at all; `-f`
#      closes that and narrows the `-x`/`exec` TOCTOU window) and emits its
#      own `ask` JSON if the check fails, rather than depending on this file
#      to exist in order to fail safely.
#   4. Well-formed JSON, `file_path` present and non-empty, but `$f` matches
#      no `case` arm (e.g. app/src/App.tsx) -> no output, tool proceeds.
#      This IS the intended allow path, not a gap — it is what makes every
#      other file in the repo editable.
#   5. Well-formed JSON but `file_path` absent or `null` -> ask (checked
#      below). This is the SAME epistemic state as (1) — no path was ever
#      extracted, as opposed to (4) where a real path is known and simply
#      unguarded — so it gets the same answer, not #4's silent allow.
#   6. The hook's own `timeout: 5` (settings.json) is hit -> no JSON is
#      emitted and the tool proceeds; pre-existing, unchanged by this PR.
#      This script runs in well under 100ms, so the margin is large, but a
#      list of no-decision paths is incomplete without naming it.
#
# ORDERING CONSEQUENCE OF THE B1 ALLOW ARM (informational, not a bug): the
# icon.svg allow arm is checked FIRST, which is required (B1) so that
# `app/public/icons/icon.svg` itself isn't caught by the broader deny arm
# below it. Because `case` stops at the first match, this also means any
# path whose TAIL is literally `app/public/icons/icon.svg` allows, even if
# it is nested somewhere the deny arm would otherwise catch (e.g. a
# fabricated `app/public/data/app/public/icons/icon.svg`). Every realistic
# lookalike denies correctly (`icon.svg.bak`, `evil-icon.svg`, `ICON.SVG`,
# `../icons/icon.svg` all measured deny) — this needs a contrived nested
# path to reach, and the arm order is load-bearing for B1, so it is not
# being restructured to chase this.
#
# ---------------------------------------------------------------------------
# BASH-MEDIATED WRITES (#309): the arms above only see Claude's own Edit/Write
# tool calls (settings.json's `"matcher": "Edit|Write"`). Any Bash-mediated
# write to the same protected paths — `cp`, `sed -i`, `tee`, a `>`/`>>`
# redirect, a heredoc redirect, and every other shell-level write — reached
# these paths completely untouched. This was a KNOWN residual named in this
# file's own header when #274 shipped, not a surprise discovered later, and
# it is a strictly LARGER gap than #274 closed.
#
# DESIGN (settled by the user after reviewing alternatives — do not redesign
# this without a new explicit decision):
#   - PATH-PRESENCE MATCHING ONLY. For each string in PROTECTED_PATHS below,
#     if it appears ANYWHERE in the Bash `command` string, the guard FIRES.
#     That is the entire matching rule — nothing else. (WHAT firing produces,
#     `ask` or a non-blocking advisory, is decided by the 2026-08-09 split
#     bullet further down, and by nothing else in this file.)
#   - NO shell-syntax parsing. No segmentation, no heredoc awareness, no
#     attempt to classify "is this command really a write". Command-string
#     segmentation is the exact shape that got PR #233 closed — a shell
#     segmenter that exits 0 while emitting confidently-wrong segments about
#     which command is really running. Never reintroduce that shape here.
#   - ONE NARROW READ-ONLY EXEMPTION (#309 follow-up, NEW USER RULING: "the
#     protected path hook is for trivial and secure calls too restrictive, i
#     had to approve several stat calls"). The bullet this replaces said "NO
#     read-only exemptions", rejecting a grep/cat/head allowlist because
#     `cat f > protected/path` would match a `cat`-PREFIX exemption and
#     bypass the guard entirely. That counterexample refutes a FIRST-WORD
#     allowlist, and only that: it is a `cat` command that is also a write,
#     and it is a write ONLY because of the `>`. So the exemption here is
#     CONJUNCTIVE, never a verb test alone:
#
#         suppress  <=>  the command is at most MAX_EXEMPTIBLE_CMD_LEN bytes
#                        (a longer one is never exempt - see the bound's own
#                        note for why a length limit and not only a speed
#                        fix)
#                   AND  first word is in READONLY_VERBS (exact match)
#                   AND  the command string, ONCE the inert redirects have
#                        been stripped from it, contains NO write-capable
#                        construct (see WRITE_CAPABLE_* below)
#                   AND  that verb's own disqualifier, if it has one, says
#                        yes (#530: `grep` and `sed` have one; no other
#                        entry does)
#
#     The strip is a fixed list of whitespace-delimited literals that write
#     no file (the fd-dups and the /dev/null discards - see INERT_REDIRECTS,
#     which carries the argument for why removing them cannot create a
#     permission). It narrows nothing else: `cat f > protected` still keeps
#     its `>` after the strip and still fires.
#
#     Every conjunct is load-bearing and none is sufficient. `cat f >
#     protected` fails the second; `statx protected` fails the first; and
#     `sed -i s/x/y/ protected` fails the THIRD — note it used to fail the
#     first, back when `sed` was off the allowlist, and that is exactly the
#     kind of worked example a later change silently falsifies, so it is
#     spelled out rather than left as "sed is not a read-only verb".
#     Everything not PROVABLY safe still fires — an unrecognised verb,
#     an unparseable shape, any doubt at all. This is the guard-asymmetry
#     principle (CLAUDE.md) held to: over-firing costs a stray prompt (spec
#     tree) or a paragraph of advisory context (everything else, since the
#     2026-08-09 split), under-firing costs a silently drifted artifact, so
#     the exemption suppresses only shapes it can prove, and every ambiguity
#     resolves to FIRING. Crucially, this is NOT the shell segmentation that got PR #233
#     closed: there is no attempt to split a command line into commands or
#     to classify which one "really" runs. The predicate is the opposite —
#     it REFUSES to reason about any string that could contain more than one
#     command, and only then reads the single leading word.
#   - WHY THAT CONJUNCTION IS SOUND (the argument the whole exemption rests
#     on, stated so it can be attacked): with `;` `&` `|` newline/CR
#     backtick `$` `\` `(` `)` `{` `}` all disqualifying, the surviving
#     string cannot contain a command separator, a substitution, an
#     expansion, or an escape, nor any redirect BEYOND the fixed inert set
#     stripped beforehand — so it is ONE simple command whose executable is
#     its first word, and no expansion can introduce a second. The stripped
#     redirects do not weaken that conclusion: each discards to /dev/null or
#     dups a file descriptor, so none names a file and none can start a
#     second command (INERT_REDIRECTS carries the full argument).
#     The first word is then compared by EXACT equality against a small set
#     of verbs, and for all but two of them that is the end of it, because
#     they have no write capability at all (not "usually don't" — none of
#     those accepts an output-file option). The two that DO have one, `grep`
#     and `sed` (#530), do not weaken this argument: the same
#     one-simple-command conclusion is what lets a verb-scoped disqualifier
#     decide them from the string, since it means the tokens it scans are
#     that command's own options and operands and nothing else. A
#     path-qualified spelling (`/usr/bin/stat`) deliberately does NOT match:
#     it could be any executable, including a local script named `stat`.
#   - NAMED PRECONDITION OF THAT ARGUMENT — **no allowlisted verb may be a
#     shell FUNCTION or ALIAS in the guarded shell** (#388 review, Finding 1).
#     "The executable is its first word" is a statement about the shell that
#     actually runs the command, and a function or alias breaks it outright:
#     the word resolves to shell code that can run a DIFFERENT program, with
#     a different option surface, inside a subshell — none of which this
#     predicate sees. This is not hypothetical. `grep` in the Claude Code
#     Bash tool (the exact shell this hook guards) is a FUNCTION shimming to
#     ugrep via the `claude` binary:
#         $ type grep
#         grep is a function
#         grep () { ... exec -a ugrep "$_cc_bin" -G --ignore-files ... }
#     ugrep's option surface is not GNU grep's and contains writers and
#     command-executors (`--save-config[=FILE]`, `--filter=COMMANDS`,
#     `--pager`, `--view`), none of which needs a character this guard
#     disqualifies. `grep` was therefore REMOVED - and RE-ADMITTED by #530,
#     not by weakening this precondition but by pairing the verb with a
#     disqualifier that MIRRORS the shim's own intercept list, so the
#     exemption holds whichever of the two programs the word resolves to.
#     The precondition still stands for every other entry: a shimmed verb
#     with no such mirror is still removed, not reasoned about. See VERB
#     SELECTION and GREP_SHIM_INTERCEPTED.
#   - HOW TO CHECK IT, and the trap that makes the obvious check lie: run
#     `type <verb>` in the REAL Claude Code Bash tool and paste what you saw
#     into your PR. Do NOT measure it from inside a script (`bash probe.sh`
#     containing `type -t grep`) — a non-interactive child shell does not
#     inherit non-exported functions, so the shim VANISHES and every verb
#     reports a reassuring `file`. That exact false negative was produced
#     while fixing this (`bash script.sh` said `file`; the same check run
#     directly said `function`). Measured directly, 2026-08-05, the 14
#     entries of the day: `test` and `[` are `builtin` (fine — a bash builtin
#     runs no external program and has no write capability), every other
#     entry is `file`, and NOTHING is a function or alias. RE-MEASURED for
#     the ONE entry added since, `tail` (#437, 2026-08-07, in the real Bash
#     tool): `type tail` -> `tail is /usr/bin/tail`, `type -a tail` ->
#     `/usr/bin/tail`, `/bin/tail` — a file, not a function or alias. That
#     probe has teeth rather than being a formality: run in the same call,
#     `type grep` answered `grep is a function`, so the check does
#     distinguish the two.
#   - DO NOT teach this guard about shims, functions or aliases. DETECTING
#     them at run time is the shell-parsing road PR #233 was closed over, and
#     that half is unchanged: nothing here inspects what a word resolves to.
#     The response to a shimmed verb is either to REMOVE IT FROM THE
#     ALLOWLIST, or - since #530, and only under an explicit maintainer
#     ruling - to admit it beside a STATIC, DATED, RE-VERIFIABLE mirror of
#     the shim's own intercept list, which is a constant this file can be
#     diffed against, not a parser. Never a smarter parser.
#   - VERB SELECTION, and the three the brief for this change asked about:
#       * `find` is EXCLUDED and would be a serious hole: `-delete`,
#         `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint`, `-fprintf` and
#         `-fls` all write or execute, and this repo runs `find
#         app/node_modules -delete` as a documented worktree-cleanup ritual
#         (CLAUDE.md). Disqualifying tokens would have to enumerate that
#         whole surface correctly to make `find` safe — exactly the "deny
#         list fails open by construction" shape CLAUDE.md warns against.
#       * `cat` is INCLUDED, reversing the earlier rejection, because the
#         conjunctive form refutes the counterexample that rejection rested
#         on (see above): it cannot write without a construct that already
#         disqualifies the command — its options are all formatting
#         (-A -b -e -n -s -t -u -v) — and it is NOT shimmed in the guarded
#         shell (`type -a cat` -> `/usr/bin/cat`, `/bin/cat`). If a future
#         reader wants the strictest possible reading of the original "no
#         exemptions" rule, dropping it from READONLY_VERBS is a one-line
#         edit and reds only its own row.
#       * `grep` is INCLUDED as of #530, WITH a disqualifier, reversing
#         #388's exclusion on an explicit maintainer ruling. It is the entry
#         this whole design has now got wrong in BOTH directions, so the
#         history matters. The reasoning that first included it — "GNU grep
#         has no output-file option" — described a program that IS NOT THE
#         ONE RUNNING: `grep` is a Claude Code shell FUNCTION shimming to
#         ugrep (NAMED PRECONDITION above), whose option surface contains
#         writers and command-executors. #388 removed it on the ground that
#         "an exemption whose soundness depends on someone else's unpinned
#         implementation detail is not an exemption this guard can carry" —
#         a real objection, NOT retracted here.
#         WHAT CHANGED is not the objection but who bears it. #530 is the
#         THIRD over-restriction ruling on this hook ("the hook is still
#         firing for sed and grep reads. i want that gone.") and grep is the
#         larger half of it — #437's own corpus below measures the grep
#         family at 158 fires, the single biggest family after `cd`. The
#         dependency is therefore ACCEPTED and made VISIBLE rather than
#         declined: GREP_SHIM_INTERCEPTED mirrors the shim's intercept list
#         verbatim, dated, with a re-verification procedure, so a Claude Code
#         upgrade becomes a diff someone can run instead of a silent widening.
#         Read that array's header for the measurement and the residual; it
#         is deliberately the long comment, not this bullet.
#       * `sed` is INCLUDED as of #530, WITH a disqualifier, and its
#         exclusion had NOTHING to do with shimming — `type sed` is
#         `/usr/bin/sed` (measured directly in the real Bash tool,
#         2026-08-14), not a function, not an alias. It was excluded because
#         of sed's OWN language: the `w` and `W` commands write a file with
#         no command-line flag at all, `e` and `s///e` execute a shell
#         command, and `-f script.sed` hides the whole script from any
#         string-level check — so a blacklist of `-i` is nowhere near
#         sufficient, and this file had never written that reason down.
#         What makes an exemption possible anyway is ORDER, not cleverness:
#         WRITE_CAPABLE_CHARS runs FIRST and has already rejected `;`, `$`,
#         `!`, `\`, `{`, `}` and newline, so a sed call reaching the verb
#         check can hold at most ONE command with at most ONE address. That
#         is a shape a POSITIVE WHITELIST can decide — see sed_readonly_ok,
#         which exempts only `p`/`d`/`q`/`=`/`n`/`N` under an optional
#         numeric or regex address, with only `-n`/`-E`/`-r`-class flags,
#         and fires on everything else. It is prove-it-else-fire, the same
#         shape as bash_is_provably_readonly itself.
#       * `file` is EXCLUDED despite looking as inert as `stat`, and this is
#         the non-obvious one: `file -C -m X` COMPILES the magic file and
#         WRITES `X.mgc`. MEASURED, not reasoned — `file -C -m magic.txt`
#         in an empty temp dir exited 0 and created `magic.txt.mgc` (752
#         bytes). Keeping `file` would need `-C` in the disqualifying token
#         list, an odd token that also over-fires on `ls -C`; excluding the
#         verb is the smaller and more obviously-correct rule.
#       * `tail` is INCLUDED as of #437, on the condition the previous
#         revision of this bullet set for itself: it said "`tail` is absent
#         only because nothing asked for it — it is as safe as `head`; add it
#         with its own rows if it becomes noise", and the #437 corpus below
#         measured it as noise (one real fire). It is the symmetric partner
#         of `head`, which is already here, so it introduces NO new soundness
#         class — that, not the size of the number, is why it is the one
#         addition taken. Its whole GNU option surface is about what goes to
#         stdout (-c/-f/-F/-n/--max-unchanged-stats/--pid/-q/--retry/-s/-v/-z)
#         and contains no output-file option; `tail --help | grep -niE
#         'write|output file'` matches nothing. Not shimmed (see the
#         re-measured NAMED PRECONDITION above).
#   - #437 — the SECOND over-restriction ruling ("please fix the hook, it is
#     still blocking too much", maintainer, 2026-08-07; the first produced the
#     conjunctive exemption above).
#     READ THIS WHOLE BLOCK AS DATED: every "ASK" and "prompts removed" figure
#     in it was measured against the PRE-SPLIT guard, when every non-exempt
#     hit prompted. Since the 2026-08-09 split only the spec tree still
#     prompts, so a "prompt removed" here means "fire removed" — the counts,
#     the ratios and every verdict they support are unaffected (all of them
#     are about which commands FIRE, which the split did not change), but the
#     word no longer describes what a fire costs. The figures are deliberately
#     NOT rewritten: they are a record of a measurement, not a description of
#     current behaviour. Every candidate below was scored on a
#     corpus HARVESTED from this project's own transcripts, never invented:
#     29,009 Bash tool calls under ~/.claude/projects/<flattened-repo-path>,
#     27,040 DISTINCT command strings, each replayed through a byte-identical
#     copy of THIS script (every variant is that copy with exactly one edit,
#     so the production predicate is what answered — the #404 twin trap).
#     BASELINE: 1,075 of the 27,040 name a protected path; 18 are already
#     suppressed by the exemption above; 1,057 ASK.
#     THESE ARE A SNAPSHOT, and the transcript tree only grows — a re-harvest
#     will legitimately report MORE. Independently re-harvested hours later
#     during review: 1,233 transcripts / 29,800 calls / 27,762 distinct /
#     1,092 naming a protected path / 1,074 fires, every delta proportionate
#     and in the growth direction, with the 18 already-suppressed matching to
#     the unit and EVERY prompt-removal count below matching exactly. Compare
#     RATIOS and prompt-removal COUNTS across harvests, never the absolute
#     corpus sizes.
#     WHAT THOSE 1,057 ARE, classified with a quote-aware segmenter (analysis
#     only — this guard still refuses to segment): 799 TRUE POSITIVE (75.6%;
#     a redirect, a writer, a code runner, a heredoc, a mutating git/gh call
#     or a script invocation genuinely reaching a protected path), 246 NOISE
#     (23.3%), 12 unresolved (1.1%).
#     READ THAT SPLIT WITH ONE CAVEAT (PR #445 review, Minor 2): unlike every
#     DECISION-RELEVANT number in this block, it is NOT independently
#     re-derivable from this repo — the classifier is a throwaway analysis
#     script, never committed. Everything a decision rests on WAS reproduced
#     by the reviewer from an independent harvest (the 18 already-suppressed,
#     exact; every candidate's prompt-removal count, exact; the 20/0
#     enabling-shape figure, exact; the shipped script's 1-removed/0-newly-
#     asking delta). The 799/246/12 breakdown is DESCRIPTIVE ONLY, and no
#     decision here turns on it.
#     TWO DIFFERENT COUNTS PER FAMILY — quote the right one. The NOISE is
#     dominated by families this design has already settled and #437 put out
#     of scope, and each has a FAMILY TOTAL (fires whose first word is that
#     verb — a one-line count anyone can re-derive) and a smaller
#     NOISE-CLASSIFIED SUBSET (that family's fires the classifier judged
#     read-only END TO END, so a `grep … && cp …` compound is excluded):
#         grep  family 158, of which 121 noise   (the ugrep shim)
#         git   family 120, of which  40 noise   (read-only git as a WHOLE
#                                                 command, not merely a
#                                                 read-only subcommand)
#         cd    family 268, of which  34 noise
#     The three families are 546 of the 1,057 fires (51.7%); their noise
#     subsets are 195 of the 246 noise commands (79.3%). A future reader
#     counting first words the obvious way gets the FAMILY figures and will
#     not match the noise ones — that is the two definitions disagreeing, not
#     an error. Anything citing these outside this repo should quote the
#     FAMILY totals, which are reproducible.
#     THE MAINTAINER'S OWN REPORTED
#     COMMAND IS IN THE CORPUS AND IS A TRUE POSITIVE — `sed -n '60,100p'
#     ...; ls app/public/data/ | head -20; node -e "...harbors.json..."` is
#     ONE Bash call, and a Bash hook sees the whole command string, never a
#     part of it, so the prompt it drew was correct. Do not read #437 as
#     evidence the guard misfired on the case that prompted it.
#     MEASURED AND REJECTED (prompts removed / 1,057, through the real
#     script):
#       * SPLIT ON `|` ONLY, requiring EVERY pipe segment's first word to be
#         an allowlisted verb — the one candidate #404's rejection record did
#         not cover: **0**. The fail-closed argument was attacked rather than
#         assumed, and it SURVIVED — but only in a form narrower than it
#         first looks, so read the qualifier before reusing it. Naive
#         `|`-split segments REFINE the real pipeline's segments (the real
#         ones split only at UNQUOTED pipes), so each real segment's first
#         word is the first word of its leading naive segment — equal when
#         that segment is non-empty, and an empty or quote-truncated
#         fragment (`'l`, `cat'`) exact-matches no verb and therefore fires.
#         `||` yields an INTERIOR empty segment and fires; `|&` still carries
#         `&`.
#         **THE QUALIFIER, and it is the whole finding: that argument is
#         IMPLEMENTATION-CONDITIONAL, not a property of `|`-splitting.** It
#         holds only for a split that PRESERVES A TRAILING EMPTY SEGMENT,
#         and the most natural bash spelling does not. `IFS='|' read -ra
#         SEGS <<<"ls app/public/data |"` yields ONE element (bash drops the
#         trailing empty field), whose first word is `ls` — so that spelling
#         ALLOWS a command whose second stage it never examined. MEASURED
#         twice independently: the implementer hit it in the measurement
#         harness (a loop that broke before checking the final segment) and
#         the reviewer reproduced it clean-room from the `read -ra` spelling
#         before reading that half of the PR. Reasoning from `||` to the
#         general case is exactly the step that misses it — the interior
#         empty field is preserved and the trailing one is not. Two
#         independently written segmenters got this wrong in one afternoon,
#         which is itself evidence about the candidate.
#         WHY IT IS DECLINED, stated no more strongly than the measurement
#         supports: NOT "the yield is low" — the yield COULD NOT BE
#         RESOLVED. The enabling shape (a pipeline of nothing but
#         allowlisted verbs) occurs 20 times corpus-wide with 0 of those 20
#         naming a protected path, but only ~4% of all commands name one, so
#         the expectation is ~0.8 and observing 0 is uninformative
#         (Poisson(0.79) puts P(0) near 45%). That is a WEAK zero, and the
#         two CONTROLS below are STRONG zeros — do not quote the three as if
#         they were the same result. With the measurement underpowered, what
#         actually decides it is the guard's own default, unrebutted: the
#         SMALLER allowlist, and no segmentation of any kind inside a
#         predicate whose stated value is REFUSING to segment (the PR #233
#         shape this design was closed over). That ground survives a bigger
#         corpus; "the yield is low" would not.
#         Re-propose it only with a corpus large enough to resolve ~0.8, or
#         on a fresh maintainer ruling — and never on the soundness argument
#         alone, which is accepted here ONLY together with the
#         trailing-empty-segment qualifier above.
#       * READONLY_VERBS additions, each scored ALONE: cmp, od, xxd, hexdump,
#         nl, base64, sort, uniq, cut, tr, rev, comm, column, jq — **0** each.
#         `diff` removed **1** and is still declined: same evidence as `tail`,
#         but where `tail` is an existing entry's symmetric partner, `diff`
#         is a new class (a multi-operand comparison tool with a large option
#         surface) bought for 0.09% of the prompts — and this guard's own
#         rule is that doubt resolves to the SMALLER allowlist. All 16
#         together remove 2, i.e. exactly `tail` + `diff` and nothing
#         emergent.
#       * `|`-split AND all 16 verbs together: **2** — the same two, so the
#         two candidates do not compose into anything.
#     CONTROLS, so this corpus's zeros are not believed on their own: #404's
#     two already-rejected loosenings were re-run here and REPRODUCED their
#     published "exactly zero" on a corpus 164x larger — adding `cd` to
#     READONLY_VERBS removes 0, and `;`-segmentation removes 0. Those are
#     STRONG zeros, unlike the `|` one: 268 of the 1,057 fires already start
#     with `cd` and 544 contain a `;`, so the shapes are abundant and the
#     change still buys nothing, because those commands are compounds that
#     genuinely write.
#   - ACCEPTED RESIDUAL OVER-FIRES of the exemption (named so they read as
#     decisions, not oversights): `!` is disqualified, so `test ! -f
#     <protected>` — a legitimate read-only shape — still fires; `#` is
#     disqualified, so a trailing comment still fires; `$` is disqualified
#     wholesale, so `stat "$HOME/<protected>"` still fires. Each is the safe
#     direction and none has a cheap sound alternative (a `#` cannot be told
#     from a filename character without parsing, which is the thing this
#     guard refuses to do).
#   - A command that names a protected path and is NOT provably read-only
#     still fires, including one that merely mentions the path in prose
#     (`echo mentions <protected>`) — `echo` is not on the verb allowlist.
#     That over-fire is unchanged and still deliberate; since the 2026-08-09
#     split it costs a line of advisory context rather than a prompt for
#     every path except the spec tree, which is most of why the over-fire is
#     now cheap enough to keep without argument.
#   - NEVER `deny` on this Bash arm — this is the guard-asymmetry principle
#     (CLAUDE.md) applied in the OTHER direction from the Edit|Write arm
#     above: that arm can `deny` because a file_path IS the write target,
#     unambiguously. A Bash command string cannot reliably be told apart
#     from a read (this guard does not parse shell syntax, by design, above)
#     so `deny` here would routinely HALT legitimate read-only commands.
#     What a NON-EXEMPT hit gets instead is now SPLIT BY WHICH PATH MATCHED
#     — see the next bullet.
#   - **TWO OUTCOMES FOR A NON-EXEMPT HIT, split by matched path** (maintainer
#     ruling, 2026-08-09: "it happens so often that i anyway press yes all the
#     time" / "it was just some git read command as well"). The blanket `ask`
#     this arm used to emit for EVERY hit was eroding itself: a guard that
#     always asks trains the user to click through, the same failure CLAUDE.md
#     records for `premerge-verify`, and that erosion is the defect this split
#     fixes. MEASURED over 28,923 distinct real Bash commands from this
#     project's own transcripts: 1,115 asks, only 53.3% of them genuinely
#     write-capable; first words of the ask population were `cd` 286, `grep`
#     162, `git` 128, `python3` 65, `sed` 59, `ls` 56, `cat` 50, and only
#     10.5% start with an allowlisted verb — so no widening of READONLY_VERBS
#     can fix this (that route was measured and rejected, see #437 above).
#     SUPERSEDED IN PART BY #530 (2026-08-14), and only in part — the
#     measurement stands, its sweeping conclusion does not. #530 added `grep`
#     and `sed`, which are 162 + 59 = 221 of those 1,115 asks, i.e. 19.8% of
#     the ask population, taking the allowlisted-verb share of that SAME
#     population from 10.5% to roughly 30%. That is ARITHMETIC ON THE FIGURES
#     IN THIS BULLET, not a re-measurement: how many of the 221 actually stop
#     firing is UNMEASURED here, because each must still clear the char check
#     AND the new verb-scoped disqualifier — the maintainer's own #437
#     command quoted above is a `sed` that keeps firing on its `;` alone.
#     What survives untouched is the LOAD-BEARING half: `cd` 286, `git` 128
#     and `python3` 65 are still beyond any verb-list widening, so this
#     bullet's argument for the advisory split is unaffected.
#     BOTH SIDES OF THE LEDGER, since the measurement above prices only one of
#     them (PR #478 review, Minor 3): what replaces each of those prompts is
#     518-603 bytes of `additionalContext` (measured per protected path, the
#     603 being `app/public/data`, whose generator hint carries the separate
#     basemap command), injected into the assistant's context on every fire —
#     so roughly the old prompt rate, order 1,000 times over a long working
#     period. The FIRST CUT of that text measured 970-996 bytes and listed
#     every generator on every fire; trimming it to the matched path's own
#     generator is where most of the reduction came from. `bash_advisory`'s
#     own header records what the four remaining sentences are for, and the
#     selftest pins an upper bound so it cannot grow back unnoticed. That is
#     the trade this split makes: context cost, paid continuously, in exchange
#     for not interrupting the maintainer.
#       * `docs/superpowers/specs` and its ancestor `docs/superpowers`
#         (SPEC_GATED_PATHS below) KEEP the blocking `ask`, unchanged. This is
#         load-bearing, not stylistic: CLAUDE.md makes a spec edit a
#         MAIN-SESSION act, and this prompt is the mechanism that stops a
#         subagent slipping one past the maintainer. Nothing regenerates a
#         user-approved decision.
#       * every OTHER protected path (app/public/{data,icons,brand},
#         app/public/THIRD-PARTY-NOTICES.txt, .pmtiles) emits a NON-BLOCKING
#         ADVISORY instead. These are committed BUILD OUTPUTS: the cost of a
#         missed write is an artifact that has drifted from its generator and
#         that `npm --prefix pipeline run ...` / `npm --prefix app run notices`
#         regenerates — recoverable, unlike a silently rewritten spec.
#     THE ADVISORY SHAPE, three points each load-bearing:
#       1. `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
#          "additionalContext":"..."}}`, exit 0. `additionalContext` is the
#          field that REACHES THE ASSISTANT; `permissionDecisionReason` goes
#          to logs only, so an advisory built on that field would be a guard
#          that silently does nothing — strictly worse than the blanket ask it
#          replaces. Contract verified against Claude Code 2.1.226
#          (`claude --version` in the guarded environment).
#       2. `permissionDecision` is OMITTED ENTIRELY — deliberately NOT set to
#          "allow". Omitting falls through to the user's own permission
#          system, which still applies its normal rules; `"allow"` would
#          BYPASS that system and auto-approve commands those rules would
#          still question. The ruling was to drop THIS HOOK's prompt, not to
#          widen the user's permission configuration. A selftest case parses
#          the emitted advisory with jq and asserts the key is ABSENT, so this
#          cannot regress silently.
#       3. The read-only exemption is UNCHANGED and still evaluated FIRST: a
#          provably read-only command emits NOTHING AT ALL — no prompt, and no
#          advisory noise either. The advisory is only for the commands that
#          used to prompt.
#     NAMED ACCEPTED COST, because it is the one place this split genuinely
#     weakens a hole this file already documents as LIVE: silent-allow path 1
#     below (`cd` into a protected directory, then a bare-filename write in a
#     LATER Bash call, since Bash cwd persists across calls) had exactly ONE
#     visible moment — the prompt on the `cd` itself, which #404's rejection
#     record calls out by name. That moment is now an ADVISORY rather than a
#     prompt: still delivered to the assistant, still naming the path and
#     saying not to hand-edit, but no longer stopping anything on its own. The
#     ruling accepted that trade for the build-output paths; it does NOT apply
#     to `cd docs/superpowers/...`, which still prompts.
#     A command naming a spec path AND a build-output path in one string ASKS:
#     the spec check runs FIRST, deliberately independent of PROTECTED_PATHS'
#     first-match ordering, which would otherwise return `app/public/data` for
#     `cp docs/superpowers/specs/x app/public/data/` and silently downgrade a
#     spec edit to an advisory. Pinned by a MIXED selftest row.
#     THAT HOLDS FOR THE LITERAL SPELLING, which is the only thing this arm
#     ever sees (PATH-PRESENCE MATCHING ONLY, above). A spec path OBSCURED so
#     the literal substring is absent - `docs/super*/specs/x`,
#     `docs//superpowers/...`, `docs/superpo''wers/...`,
#     `docs/{superpowers,other}/specs/x` - is not matched as a spec path, and
#     if such a command ALSO names a build-output path it now ADVISES where it
#     previously ASKED. Named because it is a real (small) behaviour change of
#     this split. It is NOT a new hole: measured, all four of those commands
#     with the build-output path REMOVED are SILENT on both sides of the
#     split - they are KNOWN SILENT-ALLOW item 4 below (quote-splitting /
#     escaping / brace expansion; a glob across the directory name is the same
#     class). The old prompt was an incidental match on `app/public/data`,
#     never spec coverage, so what the split removes here is a coincidence,
#     not a control. Everything CONTAINING the literal `docs/superpowers` asks
#     in every position, quoting, `./`/`../` prefix, backslash, `tar -C` and
#     literal-preserving glob a reviewer could construct (19 constructions).
#   - NO TRAILING SLASH on the directory entries (#309 fix-wave B1, reverting
#     the first cut of this file). A trailing slash means a write to the
#     protected directory's bare NAME never matches — measured, real hook
#     JSON through the pre-fix script ALLOWed `cp -r /tmp/d app/public/data`,
#     `rsync -a /tmp/d/ app/public/icons`, `mv app/public/data /tmp/stash`,
#     and `cp /tmp/f docs/superpowers/specs`, all of which are ordinary ways
#     to replace or stash a directory's contents outright. The trailing
#     slash existed only to keep a sibling directory sharing the same prefix
#     (`app/public/database/`, `app/public/iconsets/`,
#     `docs/superpowers/specs-old/`) from over-firing — bounding that
#     over-fire at the price of a real under-fire is the guard's stated
#     asymmetry backwards (over-firing is the accepted cost HERE, precisely
#     so under-firing never has to be). Removing the slash restores catching
#     the directory itself and turns those three siblings into accepted
#     over-fires instead (selftest rows below, same template as the
#     bare-filename `NOTICES.txt.bak` row this file already carried).
#   - ANCESTOR COVERAGE is DELIBERATELY PARTIAL (#309 fix-wave M4) — a
#     friction cliff, not an oversight. `docs/superpowers` (the bare parent
#     of `docs/superpowers/specs`) is added below: no routine command in this
#     repo names it without also naming something under it, so the added
#     over-fire cost is negligible next to the real gap it closes (`find
#     docs/superpowers -delete`, `mv docs/superpowers /tmp/stash`, `tar -xf
#     x.tar -C docs/superpowers`, all measured ALLOW before this entry).
#     `app/public` is DELIBERATELY NOT added, and neither is bare `app`:
#     `app/public` collides with `app/public/test-fixtures/wind-sw12.json`,
#     which CLAUDE.md documents as restored routinely after every e2e run
#     (`git restore app/public/test-fixtures/wind-sw12.json`) and which
#     already has its own dedicated Bash hook (settings.json's other "Bash"
#     PreToolUse entry). RATIONALE RESTATED (2026-08-09 split): this used to
#     read "adding `app/public` here would turn that routine command into a
#     PROMPT on every e2e cycle, which is the exact click-through erosion
#     CLAUDE.md warns about for `premerge-verify`" — and that premise is now
#     false, because `app/public` is not spec-gated, so it would produce an
#     ADVISORY, not a prompt. The DECISION is unchanged and the cost is real
#     but different: it would inject the advisory into the assistant's context
#     on every e2e cycle, for a path whose routine traffic is the wind fixture
#     that a dedicated hook already covers. Judge any future re-proposal
#     against THAT cost — context noise, not click-through erosion; do not
#     revive the old wording, which would overstate the case. Bare `app` is
#     far worse: it is a substring
#     of nearly every command in this repo (`npm --prefix app run test`,
#     `npm --prefix app run build`, ...), so it would fire constantly. The
#     residual this leaves — `find app/public -name '*.bin' -delete`, `tar
#     -xf x.tar -C app/public`, `mv app/public /tmp/stash`, `find app -name
#     mask.bin -delete` all silently allow — is recorded below, not hidden.
#   - One of the Edit|Write arm's three extension-only patterns IS
#     reproduced here as a literal substring (#309 fix-wave M1): `.pmtiles`.
#     Measured: it does not collide with an ordinary English word or common
#     shell token, so there is no over-fire cost to protecting it directly —
#     and doing so closes a real gap M1 found: a GITIGNORED
#     `app/dist/data/basemap.pmtiles.png` (Vite's default `outDir`, unset in
#     `app/vite.config.ts` -> `app/dist`; `public/` is copied verbatim into
#     it on every build) is covered by the Edit|Write arm's extension
#     pattern but was covered by NOTHING on this arm before this fix.
#     `.pmtiles.png` is DELIBERATELY NOT a separate PROTECTED_PATHS entry
#     (#309 fix-wave N2, correcting this bullet's own first cut, which
#     listed both as independently load-bearing): `.pmtiles.png` is a
#     STRICT SUPERSTRING of `.pmtiles` — any command containing the former
#     necessarily contains the latter — so a second entry can never be the
#     reason a command matches something `.pmtiles` alone would have
#     missed. Measured by mutation: deleting only a `.pmtiles.png` entry
#     from a two-entry array left `--selftest` fully green (0 rows red);
#     deleting `.pmtiles` instead reds every row that depends on either
#     extension. The single `.pmtiles` entry subsumes `.pmtiles.png` files
#     for free.
#   - `.bin` is the ONE extension-only pattern DELIBERATELY NOT reproduced as
#     a bare substring, and this is the one place the two arms' extension
#     coverage still diverges. It is 4 characters and collides with ordinary
#     English words used constantly in commands and prose ("robin", "cabin",
#     every word ending "-bin") — noise, not signal, at a scale `.pmtiles`
#     and the directory-shaped checks never are. The residual: a
#     Bash-mediated write to a `*.bin` file OUTSIDE the protected directories
#     (e.g. the same gitignored `app/dist/data/mask.bin`) silently allows on
#     this arm; a TRACKED `.bin` output is still caught, because every one
#     lives under `app/public/data` (protected by that directory entry).
#     PRIOR CLAIM CORRECTED (#309 fix-wave M1(a)): an earlier revision of
#     this bullet said "every file [`.bin`/`.pmtiles`/`.pmtiles.png`] covers
#     already lives under app/public/data/ today" with no qualifier — false
#     as written, since `app/dist/data/mask.bin` exists once built and is
#     covered by neither this arm nor that claim's scope. The Edit|Write
#     arm's OWN comment (above) makes the identical claim but SCOPES it —
#     "verified via `git ls-files`" — and under that scope it is true
#     (re-verified here: exactly two tracked files match, both under
#     `app/public/data/`); restate the qualifier wherever the claim is made,
#     never drop it.
#   - EVERY PROTECTED_PATHS ENTRY NEEDS A BOUNDING NEGATIVE ROW (#309 fix-wave
#     N1): this arm's whole safety argument is "over-firing is cheap, so bias
#     toward it", which only holds while over-firing stays BOUNDED - a
#     must-not-fire selftest row is what proves a given entry is not so broad
#     that it fires on ordinary commands. Found by mutation: the two entries
#     added by the M1/M4 fixes (`docs/superpowers`, `.pmtiles`) were the only
#     ones with no such row, and over-broadening either one by a single
#     character (`docs/superpowers` -> `docs`, `.pmtiles` -> `.p`) left
#     `--selftest` fully green, while the same treatment on every
#     PRE-EXISTING entry reds 1-5 rows. Closed with two new negative rows
#     (below) pinning a real command that names the ancestor/sibling
#     WITHOUT naming the narrower, correct string.
#   - PROTECTED_PATHS deliberately does NOT special-case
#     app/public/icons/icon.svg the way the Edit|Write arm's B1 exception
#     does — "no exemptions" applies uniformly on this arm, so a Bash command
#     touching icon.svg by path still fires (Bash-mediated edits to that file
#     get no free pass here, unlike the Edit/Write tool path). Since the
#     2026-08-09 split that fire is an ADVISORY, `app/public/icons` being a
#     build-output path — so the practical gap between the two arms for this
#     one file is now wider than when this bullet was written: Edit/Write
#     ALLOWS it outright (the B1 exception), Bash advises.
#   - tool_name discriminates the two arms (this same script now serves BOTH
#     the "Edit|Write" and "Bash" settings.json matchers): tool_name=="Bash"
#     takes the path-presence branch below; anything else (Edit, Write, or a
#     missing tool_name from an old-shaped test payload) falls through to the
#     ORIGINAL file_path logic, UNCHANGED. settings.json's matcher list and
#     this script's own tool_name check must name the same two tools — that
#     twin agreement is what makes this additive rather than a silent
#     narrowing of the Edit|Write coverage.
#   - A missing/empty Bash `command` asks, the SAME answer the file_path arm
#     gives a missing/empty `file_path` (#309 fix-wave m2, fixing a real
#     inconsistency: an earlier revision let this arm silently ALLOW on an
#     absent command while the other arm asked on the identical epistemic
#     state — "no input was ever extracted" — residual item 5 above). No
#     practical exposure either way (a Bash call with no command executes
#     nothing), but the two arms now agree.
#
# KNOWN SILENT-ALLOW PATHS OF THE BASH ARM (#309 fix-wave M2, parallel to the
# file_path arm's list above — "known", not "every", same #305 discipline).
# Every one of these is genuinely OUT OF this design's reach: catching them
# needs the shell parsing that got #233 closed, which this arm deliberately
# does not do. None of them is being fixed; they are recorded so a future
# change can be checked against this list, all measured ALLOW through this
# script:
#   1. Directory-indirection: a `cd` into a protected directory (in an
#      EARLIER Bash call, since CLAUDE.md documents that Bash cwd PERSISTS
#      across calls in this repo) followed by a bare-filename write, e.g.
#      `cp /tmp/f mask.bin` with no path in the command string at all. This
#      is the LIVE one — it needs no contrivance, just two ordinary calls.
#   2. Variable indirection: `D=app/public; cp /tmp/f $D/data/mask.bin` — the
#      literal command string never contains the protected substring
#      "app/public/data" (it is split across the assignment and the
#      dereference). CORRECTED (#404): an earlier revision of this example
#      used `D=app/public/data; cp /tmp/f $D/mask.bin` instead, which does
#      NOT demonstrate this hole — that string DOES contain the literal
#      substring "app/public/data" (inside the assignment itself), so
#      bash_hits_protected_path matches it, and the `;` then disqualifies
#      the read-only exemption, so production correctly FIRES (an advisory
#      since the 2026-08-09 split — `app/public/data` is not spec-gated;
#      before it, a prompt). Measured, not inferred: an example that does not
#      demonstrate the hole it documents is worse than none.
#   3. Programmatic path construction: `python3 -c "import os;
#      open(os.path.join('app','public','data','mask.bin'),'w')"` — contrast
#      with the SAME target spelled as a literal string, which is correctly
#      MATCHED; the two differ only in how the path is built. NOTE HOW MUCH
#      SMALLER THAT CONTRAST IS since the 2026-08-09 split: for a build-output
#      path it is now "silently allowed" vs "allowed with an advisory
#      attached", not "allowed" vs "stopped for confirmation". The hole is
#      unchanged; what the literal spelling buys you over it is much less than
#      this bullet used to imply. For a spec path the old contrast still
#      holds in full.
#   4. Quote-splitting / escaping / brace expansion inside the path string
#      itself (`app/public/dat''a/mask.bin`, `app/public/data\/mask.bin`,
#      `app/public/{data,icons}/mask.bin`) and indirection via `xargs`
#      reading targets from a file — all shell-level rewrites of the
#      protected substring that this arm, by design, never resolves.
#   5. The ancestor gap named in the DESIGN block above: bare `app/public`
#      and bare `app` are not protected, so `find app/public -name '*.bin'
#      -delete`, `tar -xf x.tar -C app/public`, `mv app/public /tmp/stash`,
#      and `find app -name mask.bin -delete` all allow.
#   6. The `.bin` extension gap named in the DESIGN block above: a
#      Bash-mediated write to a `*.bin` file outside the protected
#      directories (there are none tracked today, but a future one — or any
#      file under the gitignored `app/dist/`) is not caught by extension
#      alone.
#   7. The read-only exemption (DESIGN above) allows a command that names a
#      protected path when it is PROVABLY a single read-only command. This
#      is an INTENDED allow, the direct analogue of the file_path arm's item
#      4, not a gap — but it is the one entry on this list that a change to
#      READONLY_VERBS, WRITE_CAPABLE_*, or either of the #530 verb-scoped
#      disqualifiers (GREP_SHIM_INTERCEPTED, sed_readonly_ok) can widen, so
#      any such change must
#      be re-argued against the soundness paragraph in DESIGN, never made by
#      adding a verb that "looks read-only" (`file` looked read-only and
#      writes; see there).
set -uo pipefail

# Single source of truth for the Bash path-presence arm (see DESIGN above).
# Order matters for the human-readable reason message only (bash_hits_
# protected_path returns the FIRST match) - more specific entries are listed
# before the ancestor/ambiguous ones they nest under.
PROTECTED_PATHS=(
  "app/public/data"
  "app/public/icons"
  "app/public/brand"
  "app/public/THIRD-PARTY-NOTICES.txt"
  "docs/superpowers/specs"
  "docs/superpowers"
  ".pmtiles"
)

# Pure function: does $1 (a Bash `command` string) contain ANY protected path
# as a literal substring, anywhere? Prints the matched path and returns 0 on a
# hit; prints nothing and returns 1 otherwise. No shell-syntax awareness by
# design (see DESIGN above) — a hit in any position, behind any operator, is
# sufficient and is the entire point.
bash_hits_protected_path() {
  local cmd="$1" p
  for p in "${PROTECTED_PATHS[@]}"; do
    case "$cmd" in
      *"$p"*) printf '%s' "$p"; return 0 ;;
    esac
  done
  return 1
}

# The SUBSET of PROTECTED_PATHS that keeps the BLOCKING `ask` (2026-08-09
# advisory split; see "TWO OUTCOMES FOR A NON-EXEMPT HIT" in DESIGN). Every
# entry here MUST also be a PROTECTED_PATHS entry - an entry only listed here
# would be checked for the ask/advisory split but never matched in the first
# place, i.e. a silent allow. The selftest asserts that containment rather
# than trusting it, and asserts the complement is non-empty too (a
# SPEC_GATED_PATHS that swallowed every protected path would turn the whole
# split back into the blanket ask it replaced, with no row noticing).
SPEC_GATED_PATHS=(
  "docs/superpowers/specs"
  "docs/superpowers"
)

# Pure function: does $1 contain a SPEC-GATED path? Same substring rule as
# bash_hits_protected_path, deliberately a SEPARATE pass rather than a
# classification of that function's first match: PROTECTED_PATHS is ordered
# for the reason message, so `cp docs/superpowers/specs/x app/public/data/`
# returns `app/public/data` there and would downgrade a spec edit to an
# advisory. Checking the spec set independently makes the spec `ask` win
# whenever a spec path appears ANYWHERE in the command.
bash_hits_spec_gated_path() {
  local cmd="$1" p
  for p in "${SPEC_GATED_PATHS[@]}"; do
    case "$cmd" in
      *"$p"*) printf '%s' "$p"; return 0 ;;
    esac
  done
  return 1
}

# --- read-only exemption (#309 follow-up; see DESIGN above for the full
# rationale and the soundness argument). Three data sets, each with its own
# job; the predicate below requires ALL of them to be satisfied.

# Verbs this guard is willing to exempt. For all but two, membership alone is
# the whole story and rests on the original, stronger property - "has no
# option that creates or modifies a file" - which holds unconditionally.
#
# `grep` and `sed` (#530) are the two exceptions and they are NOT covered by
# that property: both DO have a write surface, and neither is decided by
# membership. Each is admitted only jointly with its verb-scoped disqualifier
# below, and for `sed` the resulting "no exempted shape writes" claim carries
# ONE stated third-party dependency (GNU sed's rule that commands are
# separated by `;` or newline, both of which WRITE_CAPABLE_CHARS already
# forbids) - recorded at sed_readonly_ok, not glossed here.
# SCOPED DELIBERATELY (PR #532 review, MINOR 5): the first cut of this header
# said "Verbs whose EVERY REACHABLE SHAPE here is read-only", which was an
# unconditional claim, and it was FALSE as written while that PR's BLOCKER 1
# stood - a quoted `'-i'` operand walked straight past the operand check.
# `find` and `file` remain DELIBERATELY absent (DESIGN explains both, each
# with a measurement).
#
# Compared by EXACT equality against the command's first word.
#
# BEFORE ADDING A VERB: run `type <verb>` in the real Claude Code Bash tool
# and paste the output in your PR - a verb that is a shell FUNCTION or ALIAS
# breaks this predicate's soundness argument outright, and measuring it from
# inside a script silently reports the wrong answer. See the NAMED
# PRECONDITION in DESIGN above. Also confirm the verb has no output-file or
# command-executing option (`file` looked inert and writes `X.mgc`) - or, if
# it has one, that it comes with a disqualifier the way these two do.
READONLY_VERBS=(
  stat ls wc du head tail cat sha256sum md5sum
  test "[" readlink realpath dirname basename
  grep sed
)

# Characters that can introduce a second command, a redirect, a substitution,
# an expansion or an escape. ANY occurrence, in ANY position, disqualifies -
# this is what reduces the string to a single simple command (DESIGN). The
# multi-character operators are covered by their first character on purpose:
# `>>` and `2>&1` by `>`, `<<`/`<<<` by `<`, `||` by `|`, `&&` by `&`, `$(`
# and `${` by `$`. Newline and carriage return are handled separately (they
# cannot be written inside this array's quoting without noise).
# shellcheck disable=SC1003  # '\' IS the literal backslash we match on, not a botched quote escape
WRITE_CAPABLE_CHARS=('>' '<' '|' '&' ';' '`' '$' '\' '(' ')' '{' '}' '!' '#')

# Belt-and-braces token list. Every one of these is ALREADY unreachable as an
# executable once the checks above pass (the first word must be an
# allowlisted verb, and none of those verbs runs its arguments) - they are
# matched as substrings anywhere so that a future widening of READONLY_VERBS
# cannot quietly make one of them reachable. Over-firing on an innocent
# argument (`stat /tmp/committee`) is the accepted direction.
#
# `-execdir`, `-okdir` and `"bash -c"` are DELIBERATELY NOT listed: each is a
# strict SUPERSTRING of an entry that IS here (`-exec`, `-ok`, and `"sh -c"` —
# `"bash -c"` is `ba` + `sh -c`), so any command containing one necessarily
# contains the other and a separate entry can never be the reason a command
# matches. Same reasoning, and the same mutation proof, as the `.pmtiles.png`
# entry in DESIGN (N2) - selftest rows below exercise all three subsumptions.
# `"bash -c"` was listed here until the #388 review measured that deleting it
# reds 0 rows - exactly the `-execdir` result this file already cites as proof
# of subsumption, so keeping it applied the rule inconsistently inside one
# array and made its own selftest row unfalsifiable.
WRITE_CAPABLE_TOKENS=(
  tee xargs -exec -delete -ok sudo eval "sh -c"
)

# --- INERT REDIRECTS (the FOURTH maintainer over-restriction ruling; the
# reported command was `ls -la docs/superpowers/plans/ 2>&1`, MEASURED asking
# on 5e98741). `2>&1` contains BOTH `>` and `&`, so WRITE_CAPABLE_CHARS
# rejected it - correctly by its own rule, and wrongly for the user, because
# a file-descriptor duplication writes no file. Same for a discard to
# /dev/null. CLAUDE.md's own reasoning applies: a guard that always asks
# trains the user to click through, eroding the protection it exists to
# provide, so an over-fire on a PROVABLY read-only shape is a real cost, not
# a free safety margin.
#
# Each entry is stripped - replaced by a single space - BEFORE the character
# check runs, and the EXISTING check then runs on the remainder unchanged.
#
# WHY STRIPPING CANNOT CREATE A PERMISSION, which is the whole safety
# argument and is stated so it can be attacked. Suppose the stripped string
# passes the existing predicate. Then it contains NO shell metacharacter at
# all (WRITE_CAPABLE_CHARS forbids every one), so it is a sequence of plain
# words whose first is an allowlisted verb. The ORIGINAL string is therefore
# exactly that command with some members of this array interspersed, each
# one whitespace-delimited (see the boundary rule below). A whitespace-
# delimited member of this array cannot be part of a word, so in the real
# shell each is a REDIRECTION - and every entry here redirects only to
# /dev/null (a character device that discards; it creates and truncates
# nothing) or duplicates a file descriptor onto another. Neither names a
# file, so neither can reach a protected path. The original is read-only iff
# the remainder is.
#
# THE WHITESPACE BOUNDARY IS LOAD-BEARING, NOT TIDINESS. A bare substring
# strip is UNSOUND here: `ls foo 2>/dev/null2` redirects to a real file
# named `/dev/null2`, and a substring strip of `2>/dev/null` would leave
# `ls foo 2` - metachar-free, verb `ls`, SILENTLY ALLOWED. So a member is
# stripped only when preceded by start-of-string-or-space AND followed by
# space-or-end-of-string; the padding in strip_inert_redirects() is what
# makes the two edge cases fall out of the same test. That same rule is also
# why the entries do not interfere despite `&>/dev/null` and `2>/dev/null`
# each CONTAINING `>/dev/null`: the contained spelling is not space-preceded
# inside either, so it cannot match, and the strip order is therefore
# irrelevant rather than merely chosen well.
#
# ONLY THESE EXACT SPELLINGS, AS LITERALS. Do NOT generalise to "any `2>`
# target" - a `2>docs/superpowers/specs/foo` is a real write to the spec tree
# and must keep asking (its own selftest row pins this). Do NOT replace the
# list with a PATTERN for "any fd-dup" either: the soundness argument rests
# on stripping fixed strings that cannot name a file, and a pattern
# reintroduces exactly the parsing PR #233 was closed over.
#
# FD-CLOSE FORMS (`1>&-`, `2>&-`, `>&-`) ARE DELIBERATELY ABSENT. They are
# not listed as a residual to be swept up later - closing a descriptor is a
# different operation from duplicating one, it is not needed to silence a
# command, and nothing has asked for it. Leave them asking. This ruling is
# ENFORCED, not merely documented: three selftest rows assert those forms
# still fire, so adding them here reds the suite. Before those rows existed,
# adding all three reddened ZERO rows.
#
# THE FD-DUPS NEED THEIR BOUNDARY MORE THAN ANY OTHER ENTRY, and this is
# MEASURED, not inferred from the grammar: `echo hi >&2x` AND `echo hi
# 1>&2x` BOTH CREATE A FILE NAMED `2x` (bash reads `>&word` with a
# non-numeric word as "redirect both streams to the file word", and the
# leading fd makes no difference). So the one-character difference between
# an inert fd-dup and a real file write is invisible without the boundary
# rule below. `>&2x` carries the near-miss row; `1>&2x` is named here
# because the earlier revision of this note enumerated only the first and
# left the set looking smaller than it is.
#
# A NAMED RESIDUAL, left asking deliberately rather than overlooked: a
# spelling with MORE THAN ONE whitespace character between the operator and
# `/dev/null` (`>  /dev/null`). The boundary is whitespace-general per
# character (space or tab, see strip_inert_redirects), but runs are not
# collapsed - that would be a further widening nobody has asked for.
# Longest Bash command, IN BYTES, still eligible for the read-only exemption.
# The unit is load-bearing and is enforced by a scoped `LC_ALL=C` byte count
# at the check site - see the bound's own measurement table in
# bash_is_provably_readonly. Anything longer is not exempt and therefore
# fires.
MAX_EXEMPTIBLE_CMD_LEN=32768

INERT_REDIRECTS=(
  '2>&1' '1>&2' '>&2'
  '2>/dev/null' '2> /dev/null'
  '1>/dev/null' '1> /dev/null'
  '>/dev/null'  '> /dev/null'
  '&>/dev/null' '&> /dev/null'
)

# strip_inert_redirects CMD - sets STRIPPED_CMD to CMD with every
# whitespace-delimited INERT_REDIRECTS member replaced by a single space.
# The result is space-padded at both ends; every consumer downstream is
# whitespace-insensitive (`read`/`read -ra` with an IFS of space+tab discard
# leading, trailing and repeated separators - MEASURED, a padded
# `"   ls   foo   "` yields exactly 2 tokens).
#
# WHY A GLOBAL AND NOT `$( )`, which is the obvious spelling: command
# substitution STRIPS TRAILING NEWLINES (MEASURED - a trailing `\n` is
# removed while an internal one survives). Reading the result back through
# `$( )` would therefore silently defeat the newline/CR check that runs a
# few lines below this function's call site, weakening an existing guard as
# a side effect of a change that is supposed to touch only the character
# check. A global assignment also avoids a fork per call, which matters
# against settings.json's 5 s hook cap.
#
# The loop is required, not defensive: bash's pattern substitution does not
# rescan, so ` cmd 2>&1 2>&1 ` collapses one occurrence per pass (the first
# match consumes the space the second would need). It terminates because
# every replacement strictly shortens the string.
#
# TABS ARE NORMALISED TO SPACES FIRST, so the boundary is whitespace-general
# rather than space-only and a tab-separated `2>&1` behaves exactly like a
# space-separated one. A tab is not a different safety case, and leaving it
# out would make the guard's behaviour depend on invisible characters. The
# normalisation is safe in every OTHER direction too, which is why it is
# applied to the whole string rather than only to the match:
#   * WRITE_CAPABLE_CHARS holds neither space nor tab, so no character
#     changes class.
#   * WRITE_CAPABLE_TOKENS is a substring scan whose only space-bearing
#     entry is "sh -c"; turning tabs into spaces can therefore only CREATE
#     matches (a tab-separated `sh<TAB>-c` now fires where it used to slip
#     past), never destroy one - a tightening, in the fail-closed direction.
#   * The verb read and both verb-scoped disqualifiers already split on an
#     IFS of space+tab, so they see identical tokens either way.
# Runs of whitespace are deliberately NOT collapsed - see the residual note
# on `>  /dev/null` at INERT_REDIRECTS.
STRIPPED_CMD=""
strip_inert_redirects() {
  local s prev lit pat
  local tab=$'\t' sen=$'\001'
  # `tr`, NOT `${1//$tab/ }`: bash's substitution is O(tabs x length) and this
  # runs BEFORE every disqualifying check, so on a big tab-dense input the
  # hook was KILLED at settings.json's 5 s cap - and a killed guard emits the
  # same nothing a satisfied one does, i.e. a SILENT ALLOW of a spec write.
  # MEASURED on a 389 KB / 80,000-tab heredoc naming a spec path: base `ask`
  # in <0.1 s, the bash-substitution form killed at the cap. `tr` does the
  # same job in 0.01 s. This is the identical fail-open that got `;`/`&&`/
  # newline segmentation rejected in #404/#405 (a 343 KB heredoc timing the
  # hook out), so the tab path is fixed the same way it would have been
  # caught; the length bound below is what closes the class.
  #
  # THE SENTINEL IS LOAD-BEARING, not decoration. `$( )` strips TRAILING
  # NEWLINES, and the newline/CR check runs a few lines below this function's
  # call site - so a bare `$(printf %s "$1" | tr ...)` would silently eat a
  # trailing newline and weaken that check, the very trap this function's own
  # header called out when it rejected `$( )` in the first place. Appending a
  # byte that is not a newline means `$( )` has nothing to strip; `%` then
  # removes exactly the one appended byte, so a trailing newline survives the
  # round trip. If the input itself ends in the sentinel byte, `%` still
  # removes only one and the input is preserved.
  #
  # FAILS CLOSED if `tr` is missing or fails: `s` comes back empty, the verb
  # read below yields an empty verb, no READONLY_VERBS entry matches, and the
  # caller fires. Nothing is exempted on an unavailable `tr`.
  s=$(printf '%s' "$1$sen" | tr "$tab" ' ')
  s=" ${s%"$sen"} "
  while :; do
    prev=$s
    for lit in "${INERT_REDIRECTS[@]}"; do
      pat=" $lit "
      s=${s//"$pat"/" "}
    done
    [ "$s" = "$prev" ] && break
  done
  STRIPPED_CMD=$s
}

# --- VERB-SCOPED DISQUALIFIERS (#530, the THIRD maintainer over-restriction
# ruling: "the hook is still firing for sed and grep reads. i want that
# gone."). `grep` and `sed` are the only two READONLY_VERBS entries that DO
# have a write surface, so each carries its own extra condition on top of the
# conjunctive exemption. Everything else in that array still qualifies on the
# array's original "no option that creates or modifies a file" rule alone.
#
# ORDER IS LOAD-BEARING, and it is what makes a string-level check sufficient
# here rather than the shell parsing PR #233 was closed over. Both functions
# run INSIDE bash_is_provably_readonly(), AFTER its WRITE_CAPABLE_CHARS /
# newline / WRITE_CAPABLE_TOKENS checks - so by the time either sees a
# command, that command provably contains no `;` `$` `!` `\` `(` `)` `{` `}`
# backtick `<` `>` `|` `&` `#` and no newline or CR. For `sed` that removes,
# in one step, multi-command scripts (`;`, newline), the last-line address
# (`$`), negation (`!`), escaped delimiters and the `\cREGEXPc` address form
# (`\`), blocks (`{}`) and every substitution - which collapses what can
# still arrive to AT MOST ONE COMMAND WITH AT MOST ONE ADDRESS, a shape a
# pattern can decide. Neither function splits a command line, segments on an
# operator, or decides which of several commands "really" runs; each scans
# the tokens of a string already proven to be one simple command.
#
# STRIPPING QUOTES IS NOT PARSING, and it is required: this hook sees the RAW
# command string, so a shell quote is a literal character in a token.
# `grep '--filter=x' f` tokenises to `'--filter=x'`, which starts with a quote
# rather than a dash and would slip past every dash-anchored pattern below.
#
# THREE SITES, THREE STRENGTHS, DELIBERATELY - do not "tidy" them into one
# without reading this. (CORRECTED, PR #532 re-review MINOR B: this bullet
# used to open "WHEREVER A TOKEN IS CLASSIFIED as flag-vs-operand ... EVERY
# quote is removed", which was FALSE - it named a rule the third site does not
# follow, so a reader checking whether a site was handled got the wrong
# answer from the very comment written to stop a bad "tidy".)
#   * SED'S POST-SCRIPT OPERAND CHECK, and the grep mirror match, strip EVERY
#     `'` and `"` inline (`bare=${tok//\'/}; bare=${bare//\"/}`). Nothing
#     weaker is sound there. The shell removes quotes ENTIRELY before the
#     program sees a word, so `""-i""` and `'-i'` both reach sed as `-i`;
#     one-layer stripping leaves a quote in front of the doubled form and
#     classifies it as an operand. MEASURED both ways. Both sites additionally
#     reject a token whose RAW first character is a glob metachar (MAJOR A).
#   * SED'S PRE-SCRIPT FLAG BRANCH is the third site and is deliberately RAW -
#     it classifies `$tok` itself, with no stripping at all. Safe because it
#     fails toward FIRING: a quoted flag matches neither `--*` nor `-*`, so it
#     falls through and is taken as the SCRIPT, where the whitelist rejects it.
#     `sed '-n' 5p <protected>` therefore advises rather than suppressing -
#     an over-fire, which is the accepted direction. Adding stripping here
#     would be a LOOSENING, not a hardening, so it needs its own argument.
#   * THE SED SCRIPT TOKEN keeps unquote_token()'s ONE layer below. Also the
#     conservative direction and kept on purpose: the script whitelist accepts
#     three narrow shapes that contain no quote character at all, so a
#     residual quote can only make a script FAIL to match, i.e. over-fire.
#     `sed -n ""5p"" f` fires; it does not slip through.
#
# CORRECTED (PR #532 review, MAJOR 2): an earlier revision of this comment
# said the doubled form "stays in the quote-splitting class this file already
# records as KNOWN SILENT-ALLOW item 4, i.e. it is pre-existing and not newly
# opened here." Both halves were wrong, and wrong in the direction that
# licenses the weaker fix. Item 4 is about obscuring the PROTECTED PATH so it
# is never matched at all; this was a matched hit being EXEMPTED, a different
# mechanism. And nothing was pre-existing: before #530 `sed` was off the
# allowlist entirely, so every one of these commands fired. #530 opened it and
# #532 closed it.
unquote_token() {
  local t="$1"
  case "$t" in \'*|\"*) t=${t#?} ;; esac
  case "$t" in *\'|*\") t=${t%?} ;; esac
  printf '%s' "$t"
}

# The option patterns the Claude Code `grep` shim itself intercepts, mirrored
# 1:1 so this exemption holds under EITHER program the word `grep` can
# resolve to.
#
# WHY A MIRROR AT ALL (see the NAMED PRECONDITION in DESIGN): `grep` in the
# guarded shell is a shell FUNCTION, so "the first word is the executable" -
# the soundness argument the whole exemption rests on - is false for it. The
# shim matches a fixed list of options and falls back to `command grep` for
# them, running ugrep otherwise. Rejecting exactly that list means a command
# this function exempts is read-only whether it resolves to GNU grep (which
# has no output-file option at all) or to ugrep with its writers and
# command-executors removed.
#
# MEASURED 2026-08-14 by reading the shim's own body - `type grep` run
# DIRECTLY in the real Claude Code Bash tool, never from inside a script,
# which does not inherit non-exported functions and reports a reassuring
# `file` instead (HOW TO CHECK IT, in DESIGN, records that exact false
# negative). The patterns below are that body's `case` list copied verbatim.
# They are BROADER than the option names they cover - `-*-filter*` also
# catches `--filter-magic-label`, and `-[!-]*[Zz]*` catches a BUNDLED `-nz`
# that `-[Zz]*` alone would miss - and `-*-save-config*` is already subsumed
# by `-*-config*` in the shim itself. It is kept anyway BECAUSE this is a
# mirror, not a minimal rewrite: a future reader diffing this array against
# `type grep` must find the two identical, which a subsumption-pruned copy
# would defeat. (That is the one place this file's usual prune-the-subsumed
# rule is deliberately not applied, and this is why.)
#
# WHAT THE MIRROR IS SOUND AGAINST — and read the SCOPE of this claim, which
# was over-stated in its first cut (PR #532 review, MINOR 4). What was
# actually run, the same day, is a scan of the ugrep help text the Claude Code
# binary itself ships (`exec -a ugrep "$CLAUDE_CODE_EXECPATH" --help`) for
# write/exec WORDING in option headers and descriptions. Within that scan:
# the only file-writing option is `--save-config[=FILE]`; the only
# command-executing ones are `--filter=COMMANDS`, `--pager[=COMMAND]` and
# `--view[=COMMAND]`; and `--config[=FILE]`/`---[FILE]` is the indirection
# that could re-introduce any of them from a file. All five are intercepted.
# A `.ugrep` config does NOT auto-load here either - the help states only the
# `ug` command does that, and the shim execs as `ugrep`.
#
# THAT SCAN IS NOT AN EXHAUSTIVENESS PROOF, and it missed one: `-Q`/`--query`
# opens ugrep's interactive TUI, whose F2 binding invokes `$VISUAL`/`$EDITOR`/
# `$PAGER` — a command-executor reachable with NO `--view` on the line, and
# matching NONE of the twelve mirror patterns. It is not live here (no tty in
# this environment, so ugrep exits 2 — measured), but "not live" is not "not
# there". It is rejected by GREP_EXTRA_REJECTED below rather than by the
# mirror, so the mirror stays element-identical to `type grep`.
#
# THE RESIDUAL, stated rather than hidden, because this IS the dependency
# #388 refused to take ("an exemption whose soundness depends on someone
# else's unpinned implementation detail is not an exemption this guard can
# carry") and the maintainer has now overruled it: the intercept list is an
# UNVERSIONED EXTERNAL implementation detail this repo neither controls nor
# pins, and the help scan above is a snapshot of one day's binary. A Claude
# Code or ugrep upgrade could add a writer on neither list, and nothing here
# would notice on its own.
# RE-VERIFY ON ANY CLAUDE CODE UPGRADE: run `type grep` in the real Bash tool
# and diff its `case` patterns against this array, then re-run the ugrep help
# scan. Mirroring the list instead of trusting it is what makes that a
# visible task rather than a silent hole.
GREP_SHIM_INTERCEPTED=(
  '-*-filter*' '-*-pager*' '-*-view*' '-*-format-open*' '-*-config*'
  '---*' '-@*' '-*-save-config*' '-[Zz]*' '-[!-]*[Zz]*' '--null' '--null-data'
)

# Options THIS GUARD rejects that the shim does NOT intercept - deliberately a
# SECOND array so GREP_SHIM_INTERCEPTED stays element-identical to `type grep`
# and the re-verification procedure above remains a clean diff. Anything added
# here is this repo's own judgement, not the shim's, and needs its own reason.
#   `-Q`/`--query`: ugrep's interactive TUI; its F2 binding invokes
#   `$VISUAL`/`$EDITOR`/`$PAGER`. Not reachable today (no tty here, ugrep
#   exits 2 - measured), rejected anyway because a guard that fails closed on
#   a known executor costs nothing: GNU grep has no `-Q` at all, so no real
#   command in this repo loses its exemption.
GREP_EXTRA_REJECTED=(
  '-Q*' '-[!-]*Q*' '--query'
)

# grep_readonly_ok CMD - 0 when CMD names none of the rejected options.
# Scans EVERY token, including the leading `grep` (which matches no pattern),
# mirroring the shim's own loop over all of "$@".
#
# EVERY quote character is stripped first, in the SAME spelling as
# sed_readonly_ok's operand check (PR #532, BLOCKER 1). This site had the
# identical defect and it was NOT in the review's report - found by running
# the blocker's own probe against the grep half. MEASURED on the unfixed
# build: `grep ""--pager"" <build output>`, `grep ""--filter=x:cat"" <spec>`
# and `grep "'--save-config=x'" <spec>` were all SILENT, i.e. the ugrep
# command-executor and its one file-writer were exempted on the SPEC arm by
# adding two quote characters. The single-quoted spellings were caught, which
# is exactly why one-layer stripping looked sufficient here.
grep_readonly_ok() {
  local cmd="$1" tok p bare nq
  local IFS=$' \t'
  local -a toks
  read -ra toks <<<"$cmd"
  for tok in "${toks[@]}"; do
    # MAJOR A's glob route reaches THIS site too, and was measured silent
    # here as well: `grep [-]-pager <path>`, `grep ?-pager <path>` and
    # `grep [-]Q <spec>` were all exempt on `19de1f5`, because a leading
    # metachar matches none of the dash-anchored patterns while the shell
    # expands it to the real option first (`[-]-pager` -> `--pager`,
    # measured). Same class as BLOCKER 1, third appearance at this site.
    #
    # NOT TESTED ON `bare`, and the difference is load-bearing rather than an
    # inconsistency with sed_readonly_ok's operand check below: a metachar
    # that is itself QUOTED is not a glob at all, so `grep '[0-9]'
    # <protected>` cannot expand to anything and must stay exempt - testing
    # `bare` there would strip the quotes and reject an ordinary
    # bracket-expression PATTERN, a normal way to read a file.
    #
    # WHAT DISCRIMINATES IS WHETHER THE METACHAR IS QUOTED, not whether the
    # token starts with a quote (PR #532 round-2 review, MINOR D - the
    # earlier form of this comment asserted the latter and it is FALSE).
    # MEASURED, since the two look alike and behave differently:
    #     [-]i -> -i      ''[-]i -> -i      ""[-]i -> -i      'a'[-]i -> a[-]i
    # An EMPTY quote pair contributes nothing to the word, so the metachar
    # after it is still a live pattern; only a NON-empty quoted prefix puts a
    # literal character in front and makes a leading `-` unreachable. So the
    # empty pairs are removed first and the leading-metachar test applies to
    # what is left. Measured on `618d691`, before this: `grep ''[-]-pager foo
    # <build output>` and `grep ''[-]Q foo <spec>` were both SILENT.
    nq=${tok//\'\'/}; nq=${nq//\"\"/}
    case "$nq" in '*'*|'?'*|'['*) return 1 ;; esac
    bare=${tok//\'/}; bare=${bare//\"/}
    for p in "${GREP_SHIM_INTERCEPTED[@]}" "${GREP_EXTRA_REJECTED[@]}"; do
      # shellcheck disable=SC2254  # $p IS a glob pattern here, by construction
      case "$bare" in $p) return 1 ;; esac
    done
  done
  return 0
}

# sed_readonly_ok CMD - 0 only for a sed call PROVEN to be a plain read.
#
# This is a POSITIVE WHITELIST, the same prove-it-else-fire shape as
# bash_is_provably_readonly() itself, and NOT a blacklist of sed's write
# surface - a blacklist cannot work here, because sed's `w` and `W` commands
# write with NO command-line flag at all and `e`/`s///e` execute a shell
# command, so the dangerous surface lives inside the script text rather than
# in the options. Anything not matching one of the shapes below is NOT
# exempt, and the fallback direction is therefore "still ask" on the spec
# tree / "still advise" on a build output - never a silent exemption.
#
# WHY ONE SCRIPT IS ALL THERE CAN BE: sed's grammar is `sed [OPTION]...
# {script} [input-file]...`, and only the FIRST non-option operand is the
# script when neither `-e` nor `-f` is given. Both of those are rejected
# below, and the ORDER note above has already removed every way to put a
# second command inside the script, so the whitelist decides the whole
# program, not a fragment of it.
#
# ADDING A LETTER TO THE COMMAND SET IS A SOUNDNESS DECISION, NOT A TYPO FIX.
# `w` and `W` write a file, `e` executes a shell command, `r`/`R` read one
# in, and `s` carries both the `w` and `e` flags - those are precisely the
# surface this whitelist exists to exclude. `p`/`d`/`q`/`=`/`n`/`N` print,
# delete from the pattern space, quit, print a line number, and advance the
# input; none of them touches a file.
#
# BUNDLED SHORT FLAGS ARE PINNED EXPLICITLY because this is a scan, not a
# real getopt parse: the short-flag test requires EVERY character after the
# leading `-` to be one of the safe set, so `-ni` is rejected for its `i`
# exactly as a bare `-i` is (its own selftest row). GNU sed also permutes
# options after operands, so a flag appearing AFTER the script (`sed 5p f
# -i`) is rejected by the operand check as well.
#
# ACCEPTED OVER-FIRES, in the safe direction: a bare `-` or `--` operand is
# rejected, and legal read-only commands outside the three shapes
# (`sed -n '0,/re/p' f`, `sed -n 5l f`) still fire.
#
# A SCRIPT CONTAINING A SPACE IS NOT ALWAYS ONE OF THEM, and the first cut of
# this comment claimed it was — "tokenises into two fragments and matches
# nothing" (PR #532 review, MAJOR 3). Only sometimes: `sed -n '1,5 p' f`
# splits into `'1,5` + `p'`, whose first fragment matches no shape, so that
# one does fire. But `sed -n 'p w /tmp/OUT' f` used to split into `'p` + `w`
# + `/tmp/OUT'`, and the FIRST fragment unquoted to a valid bare `p`, so the
# script was accepted and the remaining fragments were read as file
# operands — the command was EXEMPTED, silently (#535).
#
# #535 FIX: a balanced-quote check now runs on the RAW script-candidate
# token, BEFORE unquote_token() ever sees it — if the token's first
# character is `'` or `"` and it does not CLOSE with that SAME character as
# its own last character (or is only that one character long), the token is
# rejected outright rather than handed to unquote_token(), which would
# otherwise strip the lone leading quote unconditionally and turn `'p` into
# a whitelisted bare `p`. This closes the GNU-sed-specific half of the
# dependency described below WITHOUT relying on it — the check is a
# property of the token text alone, true regardless of what any particular
# sed implementation does with whitespace inside a script.
#
# WHY THIS WAS PREVIOUSLY STILL SAFE, kept for history: it rested on two
# things, only one of which was ours. Ours: `;` and newline are in
# WRITE_CAPABLE_CHARS, so neither can appear at all. NOT ours: GNU sed
# requires one of exactly those two to separate commands, so whitespace alone
# could not start a second command — MEASURED against GNU sed 4.9, `sed -n
# 'p w /tmp/OUT' t.txt` exits 1 with "extra characters after command" and
# creates nothing. Had a sed implementation ever separated commands on
# whitespace, this shape would have become a live write with nothing here to
# notice. The balanced-quote check above removes that third-party dependency
# entirely, so this paragraph is no longer load-bearing — it stays only as
# the record of what the risk was before the fix.
SED_SAFE_SHORT_FLAG_CHARS='nEr'
SED_SAFE_LONG_FLAGS=(--quiet --silent --regexp-extended)
sed_readonly_ok() {
  local cmd="$1" tok f script="" have_script=0 matched bare
  local IFS=$' \t'
  local -a toks
  read -ra toks <<<"$cmd"
  for tok in "${toks[@]:1}"; do
    if [ "$have_script" -eq 0 ]; then
      matched=0
      for f in "${SED_SAFE_LONG_FLAGS[@]}"; do
        [ "$tok" = "$f" ] && { matched=1; break; }
      done
      [ "$matched" -eq 1 ] && continue
      case "$tok" in
        # Any OTHER long flag - `--in-place`, `--file=x`, `--expression=x`,
        # `--separate`, and every one not yet invented - is not provably safe.
        --*) return 1 ;;
        # Short flags, bundled or not: every character must be in the safe
        # set, so `-i`, `-f`, `-e`, `-s` and any bundle containing one of
        # them is rejected. A bare `-` (empty after the dash) is rejected too.
        -*)
          case "${tok#-}" in
            ""|*[!$SED_SAFE_SHORT_FLAG_CHARS]*) return 1 ;;
          esac
          continue
          ;;
      esac
      # #535: balanced-quote check on the RAW token, before unquote_token()
      # strips anything. unquote_token() removes a LEADING quote
      # unconditionally, even when this whitespace-split fragment never
      # closes it — so without this check, a quoted multi-word script like
      # `'p w /tmp/OUT'` (which THIS function's own `read -ra` splits into
      # `'p`, `w`, `/tmp/OUT'` — not a real shell re-tokenisation) would
      # have its first fragment unquoted from `'p` to a bare `p`, matching
      # the whitelist and silently accepting the whole script while `w` and
      # `/tmp/OUT'` pass through unchallenged as file operands. Reject any
      # token that OPENS a quote (first character `'` or `"`) without
      # CLOSING that SAME quote as its own last character.
      case "$tok" in
        \'*) { [ "${#tok}" -gt 1 ] && [ "${tok: -1}" = "'" ]; } || return 1 ;;
        \"*) { [ "${#tok}" -gt 1 ] && [ "${tok: -1}" = '"' ]; } || return 1 ;;
      esac
      script=$(unquote_token "$tok")
      have_script=1
      # numeric address form (`5p`, `1,40p`), regex address form
      # (`/pattern/p`), or a bare command (`p`). Nothing else.
      [[ $script =~ ^[0-9]+(,[0-9]+)?[pdq=nN]$ ]] && continue
      [[ $script =~ ^/[^/]*/[pdq=nN]$ ]] && continue
      [[ $script =~ ^[pdq=nN]$ ]] && continue
      return 1
    fi
    # Past the script, every remaining token is an input-file operand. One
    # that looks like a flag is GNU sed's option permutation (`sed 5p f -i`),
    # which this scan cannot safely account for.
    #
    # EVERY quote character is stripped before this test, not one layer (PR
    # #532 review, BLOCKER 1). This test used the RAW token and was a LIVE
    # FAIL-OPEN: `'-i'` starts with a quote, not a dash, so it walked past
    # the check, and the shell removes the quotes before sed ever sees the
    # word - so sed got a real `-i`. MEASURED end to end on throwaway files:
    # `sed -n 5p target.txt '-i'` truncated a 6-line file to 1 line, and
    # `sed -n 5p t2.txt '-f' evil.sed` with a `w` command in evil.sed created
    # an arbitrary file. Both spellings were SILENT on the SPEC arm.
    # ONE-LAYER STRIPPING IS NOT ENOUGH HERE and that was measured too:
    # routing this through unquote_token() closes `'-i'` but leaves `""-i""`
    # open, because the shell concatenates the empty strings away while one
    # layer leaves a quote in front. Removing every `'` and `"` is what makes
    # the classification survive quoting, which is the condition the flag /
    # operand split silently depended on.
    #
    # A GLOB IS THE OTHER ROUTE TO A LEADING DASH (PR #532 re-review, MAJOR
    # A). `*`, `?`, `[` and `]` are NOT in WRITE_CAPABLE_CHARS, so nothing
    # above touches them and the SHELL expands the token before sed runs.
    # MEASURED: with a file named `-i` in cwd, `[-]i`, `?i` and `*i` each
    # expand to `-i` (`eval "printf '[%s] ' [-]i ?i *i"` -> `[-i] [-i] [-i]`)
    # and `sed -n 5p target.txt [-]i` truncated a 6-line file to 1 line
    # (sha 7f79f17927b4 -> bef8bdde4942). All four spellings were SILENT, the
    # SPEC arm included. It is graded below BLOCKER 1 only because it needs an
    # attacker-placed filename, where the quoted form needed no preconditions.
    # WHY THE FIRST CHARACTER IS THE WHOLE TEST: only a token whose FIRST
    # character is a metachar can expand to something starting with `-`. A
    # token starting with an ordinary character can only match names starting
    # with that character, and every other route to a leading dash (`$`, `\`,
    # backtick, `{`, `}`, `(`, `!`) is already disqualified upstream. That is
    # exactly why `sed -n '1,40p' app/public/data/*.json` stays exempt: it
    # globs, but it cannot glob to a flag - and there is a selftest row
    # holding that, so this cannot later be over-broadened to "any glob".
    #
    # THIS TEST USES `bare`, where grep_readonly_ok's twin uses the token with
    # only EMPTY quote pairs removed, and the asymmetry cuts both ways. Stated
    # rather than fixed (PR #532 round-2 review): here a fully-quoted bracket
    # FILENAME is not a glob at all, yet stripping every quote makes it look
    # like one, so `sed -n 5p <build output> '[0-9].txt'` ADVISES - measured.
    # That is the safe direction and costs nothing real (a file so named is
    # vanishingly rare, and the cost is one advisory, never a block), so it is
    # deliberately left alone; the grep site cannot afford the same over-fire
    # because a quoted bracket expression there is an ordinary PATTERN.
    bare=${tok//\'/}; bare=${bare//\"/}; case "$bare" in -*|'*'*|'?'*|'['*) return 1 ;; esac
  done
  # Fail-closed default for a sed call that never produced a script token
  # (`sed -n`). UNPINNABLE BY CONSTRUCTION, and deliberately kept anyway: a
  # command reaching this function has already been proven to NAME a
  # protected path, and a path never starts with `-`, so it is always taken
  # as the script - which means no selftest row can exist for the
  # script-less shape, and deleting this line reds 0 rows (MEASURED). That
  # is NOT the `"bash -c"` case this file removed for being unfalsifiable:
  # that entry was a redundant MATCHER whose removal changed no decision,
  # whereas deleting this line flips an unreachable case from FIRE to
  # EXEMPT, i.e. toward fail-open. The guard-asymmetry rule (DESIGN) keeps
  # the fail-closed default even where nothing can pin it.
  [ "$have_script" -eq 1 ] || return 1
  return 0
}

# Pure function: is $1 (a Bash `command` string) PROVABLY a single read-only
# command? Returns 0 only when it can be proven so; returns 1 for everything
# else including every shape it does not understand. Never the other way
# round - "I cannot tell" and "this is a write" get the same answer.
bash_is_provably_readonly() {
  local cmd="$1" c t v verb rest
  local nl=$'\n' cr=$'\r'

  # LENGTH BOUND, checked before any work at all. This is what actually
  # closes the timeout-is-a-silent-allow failure above, and the `tr` fix is
  # the optimisation beside it, not the other way round: `tr` removes the tab
  # path's cost but never touches the rescan loop, so with this bound disabled
  # a 500 KB adjacent-`2>&1` payload with no tabs at all is still killed at
  # the cap (MEASURED). Keeping both is deliberate: a performance fix is a
  # moving target (the next contributor adds another pass over the string),
  # while a length bound is a STRUCTURAL guarantee that the exemption cannot
  # be walked past by sheer volume. Over the bound, no command is exempt and
  # the caller fires - the fail-closed direction.
  #
  # THRESHOLD PICKED BY MEASUREMENT, not by guess. Timing the whole hook on
  # tab-dense payloads against the PRE-FIX quadratic substitution (the worst
  # case a future regression could reintroduce): 2 KB 0.01 s, 4 KB 0.01 s,
  # 8 KB 0.02 s, 16 KB 0.05 s, 32 KB 0.14 s, 64 KB 0.49 s, and 389 KB killed
  # at the 5 s cap. 32 KB therefore leaves a wide margin under that cap even
  # if the `tr` fix is undone, while being roughly 10x the largest plausible
  # hand-typed read-only command (a `cat` naming 60 full spec paths measures
  # 3.4 KB). Guard asymmetry decides the direction of the rounding: too small
  # costs a stray prompt, too large costs a silent allow.
  #
  # THE COUNT IS IN BYTES, AND THAT IS THE WHOLE POINT OF THE SUBSHELL.
  # `${#cmd}` counts CHARACTERS under this environment's C.UTF-8 locale, so a
  # 32 768-CHARACTER limit admits up to ~131 KB of UTF-8 - and the table above
  # was measured on single-byte input, so the margin it quotes simply does not
  # apply to multibyte content. MEASURED at exactly 32 768 characters with
  # `tr` undone, i.e. the regression this bound exists to survive: all-ASCII
  # 0.19 s, German umlauts 4.74 s, tab+emoji 4.24 s - against a 5 s cap. The
  # bound was not holding the line it claims to hold. Counting bytes restores
  # it, because the densest thing 32 768 BYTES can encode is the all-ASCII
  # case that measures 0.19 s; any multibyte payload reaching that many bytes
  # has FEWER characters and so costs less.
  #
  # `LC_ALL=C` must be scoped to a SUBSHELL, not set with `local`: a `local
  # LC_ALL=C` would stay in force for the rest of this function and change
  # `case` collation underneath every check below it. The subshell costs one
  # fork (0.001 s on a 400 000-character string) and does not leak - verified
  # both ways.
  local nbytes; nbytes=$( LC_ALL=C; printf '%s' "${#cmd}" )
  [ "$nbytes" -le "$MAX_EXEMPTIBLE_CMD_LEN" ] || return 1

  # Strip the inert redirects FIRST, then run every check below on the
  # remainder unchanged (see INERT_REDIRECTS for the soundness argument and
  # for why a bare substring strip would be a fail-open). Note this runs
  # only INSIDE the exemption predicate: the caller has already tested the
  # ORIGINAL command against bash_hits_protected_path(), so path detection
  # never sees a stripped string and cannot be weakened by this.
  strip_inert_redirects "$cmd"
  cmd=$STRIPPED_CMD

  for c in "${WRITE_CAPABLE_CHARS[@]}"; do
    case "$cmd" in *"$c"*) return 1 ;; esac
  done
  case "$cmd" in *"$nl"*|*"$cr"*) return 1 ;; esac

  for t in "${WRITE_CAPABLE_TOKENS[@]}"; do
    case "$cmd" in *"$t"*) return 1 ;; esac
  done

  # First word only. `read -r` strips leading IFS whitespace and performs no
  # expansion; IFS is pinned locally so a future edit elsewhere cannot change
  # what "first word" means here. An empty command yields an empty verb,
  # which matches nothing below, so nothing is suppressed and the caller
  # fires (ask or advisory, per the split).
  local IFS=$' \t'
  read -r verb rest <<<"$cmd"

  for v in "${READONLY_VERBS[@]}"; do
    if [ "$verb" = "$v" ]; then
      # (#530) VERB-SCOPED DISQUALIFIERS, evaluated LAST - after the char,
      # newline and token checks above, which is what makes a string-level
      # decision sufficient for them (see their own header). Two verbs need
      # one; every other entry qualifies on membership alone, exactly as
      # before. A verb whose disqualifier says no falls through to the same
      # answer as an unrecognised verb: fire.
      case "$verb" in
        grep) grep_readonly_ok "$cmd" || return 1 ;;
        sed)  sed_readonly_ok  "$cmd" || return 1 ;;
      esac
      return 0
    fi
  done
  return 1
}

# The user-facing verb list, DERIVED from READONLY_VERBS rather than typed out
# a second time (#388 review, Finding 2: the hand-maintained string enumerated
# 14 verbs while the array held 15 - it silently omitted `[`). A derived string
# cannot drift from its source; the selftest additionally asserts every array
# entry appears in the emitted reason, so a future refactor that breaks the
# derivation fails closed rather than shipping a wrong list. Safe to splice
# into JSON as-is: every entry is bare ASCII with no quote or backslash.
# regen_hint PATH - the regeneration command for ONE protected path. Split out
# of the advisory so the advisory can name the generator for the path that
# actually matched instead of listing every generator on every fire; that one
# change is most of the trim recorded in bash_advisory's header below.
# Sources, so a future reader can re-verify rather than trust: pipeline/
# package.json's five scripts, build_icons.mjs:45-48 (which writes BOTH
# app/public/icons/ and app/public/brand/social-card.png - one script, two
# protected directories, which is why they share a hint), app/package.json's
# `notices` script, and pipeline/README.md's "basemap.pmtiles.png" section.
#
# The default arm FAILS LOUD rather than silently generic: it names itself, and
# the selftest asserts NO current PROTECTED_PATHS entry reaches it. Adding a
# protected path without recording its generator therefore reds the suite
# instead of shipping an advisory that tells the reader nothing.
regen_hint() {
  case "$1" in
    "app/public/data")                    printf 'npm --prefix pipeline run polars|harbors|seamarks|mask (basemap.pmtiles.png: pipeline/extract_basemap.sh)' ;;
    "app/public/icons"|"app/public/brand") printf 'npm --prefix pipeline run icons' ;;
    "app/public/THIRD-PARTY-NOTICES.txt") printf 'npm --prefix app run notices' ;;
    ".pmtiles")                           printf 'pipeline/extract_basemap.sh' ;;
    *)                                    printf 'see pipeline/README.md - no generator recorded for this path' ;;
  esac
}

# bash_advisory PATH - emits the NON-BLOCKING advisory for a non-exempt hit on
# a build-output path (2026-08-09 split; DESIGN explains why this is not an
# `ask` and why it carries no `permissionDecision`). Kept as its own one-line
# emitter so the mutation check has something to stub: replacing this body
# with `:` must red a selftest row, otherwise "advisory emitted" and "guard
# silently did nothing" would be indistinguishable - the exact failure mode
# that makes `permissionDecisionReason` the wrong field here.
#
# COST, because it is paid on EVERY fire and the DESIGN block measured only the
# other side of the ledger (PR #478 review, Minor 3): this text is injected
# into the assistant's context roughly as often as the old guard prompted -
# order 1,000 times over a long working period. FIRST CUT measured 970-996
# bytes (~250 tokens) per fire; it listed all three generators and closed with
# a sentence about the spec tree that a build-output fire has no use for.
# TRIMMED to the four things that make it ACTIONABLE, and nothing else:
#   (1) which protected path matched, (2) that it is generated output rather
#   than hand-editable source, (3) what to do instead if the command writes -
#   the generator for THAT path, re-run, commit the output, and (4) the honest
#   admission that this guard cannot tell a read from a write.
# Measured after: see the selftest's advisory-size case, which pins an upper
# bound so the text cannot quietly grow back.
#
# JSON-safety: $1 is always a PROTECTED_PATHS entry (bare ASCII, no quote or
# backslash), and both the literal text and every regen_hint arm contain no
# character JSON must escape. Do not splice user input in here.
bash_advisory() {
  local p="$1"
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"artifact-guard ADVISORY (no prompt, nothing to approve): this command names '"$p"', which is committed BUILD OUTPUT, not hand-editable source. Regenerate with: '"$(regen_hint "$p")"'. Reading it is fine; WRITING it is not - change the generator or its input, re-run, and commit the output, because a hand edit drifts from its generator and the next regeneration silently reverts it. This guard matches the path STRING only, never shell syntax, so it cannot tell your read from a write - that judgement is yours."}}'
}

readonly_verbs_sentence() {
  local out="" v
  for v in "${READONLY_VERBS[@]}"; do
    out="${out}${out:+/}$v"
  done
  printf '%s' "$out"
}

# bash_decision() - REMOVED (#404). It used to be a second, hand-maintained
# copy of "hits a protected path AND is not provably read-only", used ONLY
# by --selftest's `decide`/`decide_exempt` helpers below - production never
# called it, it called bash_hits_protected_path/bash_is_provably_readonly
# inline instead (see the production path near the end of this file). The
# two copies could and did drift: patching bash_decision() alone, to
# reimplement the read-only check with `;`-segmentation (checking each
# `;`-separated segment's first word against READONLY_VERBS independently,
# rather than disqualifying on any `;` at all the way the real predicate
# does), still produced "SELFTEST OK" end to end - because no selftest row
# fed a multi-segment command where every segment independently looks
# read-only through the DECISION path (`decide`/`decide_exempt`, as opposed
# to `check`, which only ever tested path coverage). `decide`/`decide_exempt`
# now drive the PRODUCTION entry point itself (through $SELF, the same
# wrapper `wrapper_check` already uses, via the shared
# `hook_decision_from_output` helper) - there is exactly one implementation
# of this decision left in the file, so nothing can diverge from it because
# nothing else computes it.

# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  fail=0
  # Counted so a case that silently disappears (deleted outright, or an
  # `if`/loop precondition that stops holding) cannot leave the suite
  # reporting `SELFTEST OK` having run fewer cases than it claims to (PR
  # #350 review, Finding 3 - the same blind spot that let mutations M2-M4
  # slip through the docs-only classifier's selftest undetected). Every
  # `check`/`wrapper_check` call and every mechanism-matrix iteration
  # increments `total`; the expected value is asserted below.
  total=0
  # NOTE (#388 review): this total includes ONE case per READONLY_VERBS entry
  # (the reason-string twin check at the end), so adding or removing a verb
  # moves it by 2 - the verb's own decision row plus its twin case.
  # (#437) 199 -> 203: +2 for the `tail` addition (its own decision row plus
  # the per-verb reason-string twin case, per the NOTE above) and +2 for the
  # acceptance-pair rows.
  # (2026-08-09 advisory split) 203 -> 212: +5 SPLIT rows (two spec-tree asks,
  # one build-output advisory, one read-only-emits-nothing, one MIXED), +2 for
  # the SPEC_GATED_PATHS containment loop (one case per entry, so this total
  # moves with that array the same way it moves with READONLY_VERBS), +1 for
  # the non-empty-complement case, +1 for the jq-parsed advisory-shape case.
  # (PR #478 review, Minor 3) 212 -> 217: +1 per NON-spec PROTECTED_PATHS entry
  # for the per-path advisory twin, so this total now moves with THAT array's
  # non-spec subset as well.
  # NOTE the 43 pre-existing `decide` rows that flipped ask -> advisory are
  # NOT part of that delta: a row changing its expectation does not change the
  # count, which is exactly why the count alone can never notice a decision
  # regression - that is the rows' job. TWO COUNTS THAT LOOK LIKE ONE, so
  # quote the right one: 43 is how many rows FLIPPED, while
  # `grep -cE '^  decide advisory '` reads 44 - the difference is the one
  # `decide advisory` row the SPLIT block adds new. Same shape as the #437
  # family-vs-noise counts in DESIGN: a future reader counting the obvious way
  # gets 44 and will not match 43, and that is two definitions disagreeing,
  # not an error.
  # (#530) 217 -> 249: +30 rows in the verb-scoped-disqualifier block (10
  # must-suppress, 7 sed must-fire, 13 grep must-fire) and +2 for the two
  # verbs added to READONLY_VERBS, which move this total by their
  # reason-string twin cases per the NOTE above. The two rows #530 REWROTE
  # (the former "MEMBERSHIP: sed is not read-only" and "MEMBERSHIP: grep is
  # EXCLUDED") are NOT part of that delta: one changed its title only and the
  # other changed helper, `decide` -> `decide_exempt`, and both helpers
  # increment `total` by exactly 1 - the same "a row changing its
  # expectation does not change the count" point the note above makes.
  # (PR #532 review, BLOCKER 1) 249 -> 261, +12: five quoted-flag rows for the
  # sed operand fail-open (BOTH quote spellings deliberately - a single-quoted
  # row alone goes green on the weaker one-layer fix, so it would have pinned
  # the wrong thing); three for the SAME defect at the grep site; one bounding
  # row so the quote stripping cannot be over-broadened onto an ordinary
  # quoted FILENAME; and three for GREP_EXTRA_REJECTED (`-Q`, bundled `-nQ`,
  # `--query`) - one per entry in that array, since an entry no row exercises
  # can be deleted with the suite still green.
  # (PR #532 re-review, MAJOR A) 261 -> 270, +9: four sed glob rows (`[-]i`
  # on both arms, `?i`, `*i`), two for the SAME route at the grep site, and
  # three bounding rows - a legitimate glob read per site, plus a quoted
  # bracket-expression pattern - so "reject a leading metachar" cannot be
  # over-broadened into "reject any glob" without a row going red. MINOR C
  # repointed an existing row's path and moved the count by 0.
  # (PR #532 round-2 review) 270 -> 275, +5: TWO for MINOR E (the grep site's
  # `*` and `?` alternatives each reddened 0 rows - unpinned, where the sed
  # site pinned all three of its metachars), and THREE for MINOR D (both
  # `''[-]…` spellings, which an empty quote pair leaves globbing, plus the
  # bounding row proving a NON-empty quoted prefix still suppresses it, so
  # the fix cannot be over-broadened back onto ordinary quoted patterns).
  # (INERT_REDIRECTS) 275 -> 286, +11: SIX must-suppress rows, one per
  # INERT_REDIRECTS entry, so this total now moves with THAT array too (an
  # entry no row exercises could be deleted with the suite still green - the
  # GREP_EXTRA_REJECTED rule above); TWO more must-suppress rows for the
  # multi-literal interactions a single-entry row cannot reach (adjacent
  # repeats, which pin the rescan loop, and the combined `>/dev/null 2>&1`);
  # and THREE near-miss rows that must still ASK - a surviving bare `>`, a
  # `2>` naming a real spec path, and `/dev/null2`, which is what pins the
  # whitespace-boundary rule against a fail-open substring strip.
  # (INERT_REDIRECTS wave 2) 286 -> 294, +8: SIX must-suppress rows - one per
  # entry ADDED to INERT_REDIRECTS (`2> /dev/null`, `1>/dev/null`,
  # `1> /dev/null`, `1>&2`, `>&2`), plus one for the TAB boundary, which is a
  # property of strip_inert_redirects rather than of any single entry; and
  # TWO near-misses - `>&2x`, which bash MEASURABLY turns into a write to a
  # file named `2x`, and the spaced `2> /dev/nullx`.
  # (wave 3) 294 -> 299, +5: ONE row pinning the LEADING boundary (Minor 1 -
  # removing the leading pad reddened zero rows before it); THREE rows
  # pinning that the fd-CLOSE forms stay non-exempt, so the array is now
  # pinned against ADDITION as well as deletion (Minor 2 - adding them
  # reddened zero rows before); and ONE function-level sentinel assertion
  # that cannot be written as a `decide` row, for the measured reason given
  # at its own site.
  # (wave 3, cont.) 299 -> 300, +1: the TIME-BOUNDED row. The Blocker this
  # wave fixed was a timeout-is-a-silent-allow, and nothing in this file
  # could observe a timeout; this row can.
  # (wave 4) 300 -> 301, +1: the bound's UNIT row. `${#cmd}` counts
  # characters under C.UTF-8, so a 32 768-CHARACTER limit admitted ~131 KB of
  # UTF-8; this row fires only if the bound is measured in bytes.
  # (#535) 301 -> 308, +7: the balanced-quote check on the sed script token.
  # THREE must-fire rows (single-quote SPEC, single-quote build-output,
  # double-quote SPEC) for the `sed -n 'p w /tmp/OUT' <path>` shape that was
  # silently exempt before this fix; FOUR must-stay-silent bounding rows
  # (the acceptance criteria's named shapes: quoted numeric range, bare
  # numeric address, quoted regex address, bare command script) proving the
  # check does not regress the #530 read-only ergonomics.
  EXPECTED_CASES=308

  # (#309 fix-wave m1, moved here by #404 so decide()/decide_exempt() below
  # can use it too - they now drive the production entry point through it
  # instead of a parallel bash_decision() twin, see its removal note above):
  # `"$0"` executed verbatim goes through PATH lookup when invoked without a
  # slash (`bash artifact-guard.sh --selftest` from the script's own
  # directory) and is not found there, silently failing every ask/deny row
  # while the allow rows pass by coincidence - the selftest's verdict must
  # not depend on invocation form. Normalise once, before anything below
  # needs it.
  case "$0" in
    */*) SELF=$0 ;;
    *) SELF=./$0 ;;
  esac

  # LIVENESS GATE (#421 review, Major 2) - runs OUTSIDE the battery, before
  # ANY row below executes, per CLAUDE.md's #274 principle: a liveness
  # check must live outside the thing whose liveness is in question, because
  # a script that cannot run cannot report that it cannot run. `-x` ALONE is
  # true for a DIRECTORY (the search bit, not "is a runnable file"), so
  # `[ ! -d "$SELF" ]` is not redundant with it - without this whole check,
  # a directory at $SELF's path passes `-x`, `exec` then dies 126 emitting
  # NO JSON at all, and every row below reads that silence as `allow`.
  # MEASURED on scratch copies under /tmp before this gate existed: $SELF
  # non-executable, $SELF pointed at a directory, and $SELF exiting non-zero
  # with no output all produced the SAME signature - 41 of the want-`ask`
  # rows red, 0 of the 22 want-`allow` rows AMONG THE decide/decide_exempt
  # FAMILY red (that scope is load-bearing, not padding: it is what makes the
  # count 22 rather than the unscoped figure, and 22 was the entire pinning of
  # #388's conjunctive read-only exemption - the single `decide allow` row plus
  # all 21 `decide_exempt` rows of the day) - the suite failed closed only by
  # ACCIDENT of the ask rows outnumbering the allow rows, not on purpose.
  # (Those two counts are from that DATED measurement and are not re-derived
  # here; the row composition has since changed twice over. RE-COUNTED as of
  # the 2026-08-09 split, each figure `grep -cE`-derived rather than hedged:
  # within that same decide/decide_exempt family the want-`allow` set is now
  # 23 - 1 `decide allow` + 22 `decide_exempt`. OUTSIDE it there are 4
  # `wrapper_check allow` rows, so the UNSCOPED want-`allow` set is 27; they
  # were never part of the 22 above and naming both numbers is the point of
  # this note. A dead $SELF additionally reads 44 `decide advisory` + 3
  # `wrapper_check advisory` rows as `allow`, so the accident this gate
  # replaces has grown MORE lopsided in the safe direction - a reason to keep
  # the gate, never to rely on it.)
  # This catches the two STATIC failure shapes ($SELF not executable, $SELF
  # a directory) in one place with one clear diagnosis instead of 41
  # misleading "got [allow] want [ask]" lines that look like a decision
  # regression. It does NOT catch a $SELF that is executable but crashes or
  # exits non-zero on a specific call (or always) - decide()/decide_exempt()/
  # wrapper_check() below each capture $SELF's own exit status per call for
  # that, which is a different failure mode (transient vs. structural).
  if ! { [ -f "$SELF" ] && [ -x "$SELF" ] && [ ! -d "$SELF" ]; }; then
    echo "SELFTEST FAIL [liveness]: \$SELF ($SELF) is not an executable regular file - every row below would read an empty/failed response as 'allow' and pass vacuously. Aborting before running the battery."
    exit 1
  fi

  # json_escape STR - escapes STR for embedding as a JSON string literal, so
  # decide()/decide_exempt() below can build a synthetic tool_input payload
  # for any test command and feed it through the real production script
  # (#404). Backslash MUST be escaped first, before the replacement it
  # introduces would itself be re-escaped. Only \\, \", \n and \r are
  # handled - the only forms any row in this suite's command strings
  # actually contains (CHAR backslash / CHAR newline / CHAR carriage return
  # rows, plus the INERT tab-boundary row). TAB is not cosmetic here: a raw
  # tab is an ILLEGAL character inside a JSON string, so without escaping it
  # the tab row would be answered by production's "could not parse tool
  # input" fallback - reading as `inert`, and testing the JSON parser
  # instead of the whitespace boundary it exists to pin.
  json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
  }

  # hook_decision OUT - given the raw stdout OUT (or an empty string) the
  # production script printed for one call that ALREADY EXITED 0 (the
  # caller checks that BEFORE reaching here - #421 review Major 2, see the
  # per-call invocation check in decide()/decide_exempt()/wrapper_check()
  # below), returns its decision as one of inert|ask|deny|allow|other. ONE
  # interpretation of that output, shared by every selftest helper that
  # talks to the wrapper ($SELF) - #404 exists because two independently
  # maintained copies of the allow/ask DECISION logic drifted; this
  # function is what stops the same shape recurring one level down, in how
  # the selftest reads the answer back.
  #
  # `inert` is checked FIRST (#421 review, Minor 3): production answers a
  # plain `"permissionDecision":"ask"` both for a genuine
  # path-hit-plus-write-construct decision AND for its own six "could not
  # parse tool input" / "could not extract a Bash command" / "could not
  # extract a file path" / "received empty tool input" fallbacks (all
  # sharing the substring "protection is inert") - two different REASONS
  # folded into the same JSON shape a bare ask/deny grep cannot tell apart.
  # A `decide ask` row whose synthetic command is not valid JSON (a raw
  # control character json_escape() does not handle, say) could pass
  # without the predicate under test ever being reached - the
  # `xargs npm install < pkgs.txt` shape #216 recorded, one level up. No
  # row in this suite may legitimately want `inert` (the one row that DOES
  # reach this path - "Bash with no command field" - now asserts it
  # explicitly), so separating it out turns a silent pass into a red row.
  #
  # `advisory` (2026-08-09 split) is recognised by `additionalContext` — but
  # ONLY after a `"permissionDecision"` check that is deliberately BROADER
  # than the two value-specific ones above it. That ordering is the structural
  # half of "the advisory must carry no permissionDecision": an advisory that
  # sprouted `permissionDecision:"allow"` (the tempting spelling, which would
  # BYPASS the user's own permission rules rather than defer to them) reads as
  # `other` here and reds its row, instead of passing as a healthy advisory.
  # The jq-parsed absence assertion further down is the explicit half; keep
  # both — this one covers every advisory row for free, that one names the key.
  hook_decision() {
    local out="$1"
    if printf '%s' "$out" | grep -q 'protection is inert'; then
      printf 'inert'
    elif [ -z "$out" ]; then
      printf 'allow'
    elif printf '%s' "$out" | grep -q '"permissionDecision":"deny"'; then
      printf 'deny'
    elif printf '%s' "$out" | grep -q '"permissionDecision":"ask"'; then
      printf 'ask'
    elif printf '%s' "$out" | grep -q '"permissionDecision"'; then
      printf 'other'
    elif printf '%s' "$out" | grep -q '"additionalContext"'; then
      printf 'advisory'
    else
      printf 'other'
    fi
  }

  # check WANT DESC CMD - drives the pure bash_hits_protected_path() function
  # directly. WANT is "hit" or "miss" - deliberately NOT "ask"/"allow", which
  # is what these rows used to say and which the 2026-08-09 advisory split
  # made actively misleading: a hit on a build-output path now produces an
  # ADVISORY, not an ask, so a row reading `check ask` would name a decision
  # this helper never computes. This tests PATH COVERAGE ONLY, which is
  # deliberate and must stay that way (#309 read-only-exemption review):
  # several rows below use `cat <path>` purely as a carrier to pin a
  # PROTECTED_PATHS decision (the B1 trailing-slash removal, the N1 bounding
  # rows). `cat` is now on READONLY_VERBS, so rebinding `check` to the full
  # decision would flip those rows to `allow` and silently stop them pinning
  # anything a PROTECTED_PATHS mutation could red. New exemption rows use
  # `decide` below instead; no existing row's expectation changed.
  check() {
    local want="$1" desc="$2" cmd="$3" got
    total=$((total + 1))
    if bash_hits_protected_path "$cmd" >/dev/null; then got=hit; else got=miss; fi
    if [ "$got" != "$want" ]; then
      echo "SELFTEST FAIL: $desc -> got [$got] want [$want] (cmd: $cmd)"
      fail=1
    fi
  }

  # decide WANT DESC CMD - drives the Bash arm's COMPLETE decision (path
  # presence AND the read-only exemption) by feeding CMD through the
  # PRODUCTION entry point itself - $SELF, the real script, via a synthetic
  # tool_input JSON payload - rather than a parallel function (#404: this
  # used to call bash_decision(), a second hand-maintained copy of the same
  # logic that only the selftest ever exercised; see its removal note
  # above). Every row for the #309 follow-up exemption uses this.
  decide() {
    local want="$1" desc="$2" cmd="$3" json out rc got
    total=$((total + 1))
    json="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$(json_escape "$cmd")\"}}"
    # (#421 review, Major 2) rc is captured and checked BEFORE the output is
    # read as a decision - a dead/crashing $SELF must not be conflated with
    # an intentional empty-output "allow". stderr is folded into $out
    # (2>&1, was 2>/dev/null) so a non-zero exit's diagnostic (e.g.
    # "Permission denied") is visible in the failure line rather than
    # thrown away; the production script never writes to stderr on a
    # successful (rc=0) run, so this is a no-op for every passing row.
    out=$(printf '%s' "$json" | "$SELF" 2>&1); rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "SELFTEST FAIL [invocation]: $desc -> \$SELF exited $rc, not 0 - this is NOT a decision, it is a dead or crashing invocation (out: $out)"
      fail=1
      return
    fi
    got=$(hook_decision "$out")
    if [ "$got" != "$want" ]; then
      echo "SELFTEST FAIL [decision]: $desc -> got [$got] want [$want] (cmd: $cmd)"
      fail=1
    fi
  }

  # decide_exempt DESC CMD - for a row whose point is that the EXEMPTION
  # suppressed it. Asserts BOTH that the command hits a protected path AND
  # that the decision is allow (#388 re-review, Minor 6, second half: the
  # same vacuity lens applied to my own rows). Without the first assertion a
  # suppress row is satisfiable by a TYPO - misspell the path and the row
  # allows on the path check alone, proving nothing about the exemption,
  # which is precisely the #216 shape. The PR body claimed every such row
  # names a protected path; this makes the claim enforced rather than
  # asserted. Deliberately ONE case, not two, so the count stays row-shaped.
  # The path-coverage check calls bash_hits_protected_path() directly (that
  # IS the single production function, not a twin of it); the decision half
  # goes through the production entry point exactly like decide() (#404).
  decide_exempt() {
    local desc="$1" cmd="$2" json out rc got
    total=$((total + 1))
    if ! bash_hits_protected_path "$cmd" >/dev/null; then
      echo "SELFTEST FAIL [exempt row names no protected path]: $desc -> this row would pass with the exemption deleted (cmd: $cmd)"
      fail=1
      return
    fi
    json="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$(json_escape "$cmd")\"}}"
    # (#421 review, Major 2) - same rc-before-decision discipline as decide()
    # above; this is the helper behind the 21 rows THAT REVIEW found passing
    # vacuously against a dead $SELF. 21 is a DATED count, not a description
    # of the block below: the 2026-08-09 advisory split added a 22nd
    # `decide_exempt` row, so `grep -cE '^  decide_exempt '` reads 22 today
    # and will keep moving. The count is incidental; the discipline is not.
    out=$(printf '%s' "$json" | "$SELF" 2>&1); rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "SELFTEST FAIL [invocation]: $desc -> \$SELF exited $rc, not 0 - this is NOT a decision, it is a dead or crashing invocation (out: $out)"
      fail=1
      return
    fi
    got=$(hook_decision "$out")
    if [ "$got" != "allow" ]; then
      echo "SELFTEST FAIL [decision]: $desc -> got [$got] want [allow] (cmd: $cmd)"
      fail=1
    fi
  }

  nl=$'\n'
  cr=$'\r'
  tab=$'\t'

  # --- POSITIVE: a real Bash-mediated write to a protected path must be
  # MATCHED (what the resulting DECISION is - ask for the spec tree, advisory
  # for a build output - is the `decide` block's job, not this one).
  # Each row isolates exactly ONE shell construct plus the path (#216
  # one-trigger-per-row rule) - no extra characters that could independently
  # explain a pass.
  check hit  "sed -i in place edit"      "sed -i s/x/y/ app/public/data/mask.bin"
  check hit  "cp into protected dir"     "cp /tmp/f app/public/data/mask.bin"
  check hit  "tee into protected dir"    "tee app/public/data/mask.bin"
  check hit  "> redirect"                "echo x > app/public/data/mask.bin"
  check hit  "heredoc redirect"          "cat > app/public/data/mask.bin <<EOF${nl}x${nl}EOF"
  check hit  "path after &&"             "git status && cat app/public/data/mask.bin"
  check hit  "path after ;"              "echo hi; cp /tmp/f app/public/data/mask.bin"
  # shellcheck disable=SC2016  # literal $( ) is the test input, not an expansion
  check hit  'path inside $( )'          'echo "$(cat app/public/data/mask.bin)"'

  # --- PATH MATCHING of a read-only mention. Both rows pin that the PATH is
  # seen; only the second is still an accepted over-fire at the DECISION
  # level. `grep -n foo <path>` SUPPRESSES (#530 admitted `grep` to
  # READONLY_VERBS behind a verb-scoped disqualifier; #388 had removed it, so
  # between those two this row's own comment described a decision the file did
  # not make) - its decision-level twin is in the exemption block below, and
  # this row's job is solely to keep the path match pinned.
  check hit  "path match: read-only grep (decision: allow, see exemption block)" "grep -n foo app/public/data/mask.bin"
  check hit  "OVER-FIRE (accepted): prose mention"  "echo mentions app/public/data/mask.bin in passing"

  # --- NEGATIVE: no protected path named anywhere.
  check miss "git status"              "git status"
  check miss "npm run build"           "npm run build"
  check miss "unrelated source file"   "cat app/src/App.tsx"
  check miss "empty command"           ""

  # --- POSITIVE (#309 fix-wave B1): a write to the protected directory's
  # BARE NAME, not something inside it, must still MATCH. Measured ALLOW
  # before this fix (trailing slash on directory entries meant only a path
  # INSIDE the directory ever matched) - this is the guard's core purpose,
  # not a redesign.
  check hit  "B1: cp -r replaces the directory itself"   "cp -r /tmp/d app/public/data"
  check hit  "B1: rsync -a writes into the bare dir"     "rsync -a /tmp/d/ app/public/icons"
  check hit  "B1: mv stashes the directory itself"       "mv app/public/data /tmp/stash"
  check hit  "B1: write to the bare specs directory"     "cp /tmp/f docs/superpowers/specs"

  # --- POSITIVE (#309 fix-wave M4): ancestor coverage for docs/superpowers -
  # no collision found with any routine command, so added outright (see
  # DESIGN above for why app/public and bare app are NOT given the same
  # treatment).
  check hit  "M4: mv the docs/superpowers ancestor"      "mv docs/superpowers /tmp/stash"
  check hit  "M4: find -delete under the ancestor"       "find docs/superpowers -name *.md -delete"

  # --- NEGATIVE (#309 fix-wave N1): bounding row for the docs/superpowers
  # ancestor entry - a real path OUTSIDE it that shares only the "docs/"
  # prefix must not match. Without this row, over-broadening the entry to
  # bare "docs" (a one-character typo) reds nothing; measured, see DESIGN.
  check miss "N1 near-miss: docs outside superpowers" "cat docs/security-assurance-case.md"

  # --- POSITIVE (#309 fix-wave M1): .pmtiles is now protected as a bare
  # substring - no noise source found (contrast the .bin residual row
  # below). .pmtiles.png files are covered too, via SUBSUMPTION, not a
  # second entry (see DESIGN - N2) - this row exercises that subsumption,
  # not an independent .pmtiles.png entry.
  check hit  "M1: .pmtiles extension"                              "cp /tmp/f app/dist/data/basemap.pmtiles"
  check hit  "M1: .pmtiles.png extension (via .pmtiles subsumption)" "cp /tmp/f app/dist/data/basemap.pmtiles.png"

  # --- NEGATIVE (#309 fix-wave N1): bounding row for the .pmtiles entry - a
  # real command using an unrelated ".py" extension must not match. Without
  # this row, over-broadening the entry to bare ".p" reds nothing; measured,
  # see DESIGN.
  check miss "N1 near-miss: .py is not .pmtiles" "python3 pipeline/verify_mask.py"

  # --- RESIDUAL (documented, not fixed - see DESIGN and the "KNOWN
  # SILENT-ALLOW PATHS" list above): the .bin extension and the app/public
  # and app ancestors are deliberately NOT protected. Pinned as ALLOW here so
  # a future accidental narrowing (or widening) of PROTECTED_PATHS is caught
  # either way, not just silently drifted.
  check miss "RESIDUAL (documented): bare .bin outside protected dirs" "cp /tmp/f app/dist/data/mask.bin"
  check miss "RESIDUAL (documented): bare app/public ancestor"         "find app/public -name *.bin -delete"
  check miss "RESIDUAL (documented): bare app ancestor"                "find app -name mask.bin -delete"

  # --- PATH MATCHING (#309 fix-wave B1): removing the trailing slash from
  # the directory entries means a sibling directory sharing the same PREFIX
  # genuinely contains the protected substring and is MATCHED here - this is
  # the flip side of the B1 fix above, not a separate bug. NOTE these four
  # rows use `cat` purely as a carrier verb, and `cat` is now on
  # READONLY_VERBS, so at the DECISION level all four now suppress rather
  # than ask (one is pinned as such in the exemption block below); they are
  # deliberately still driven through `check`, which tests PATH COVERAGE
  # only, because that coverage is what they exist to pin.
  # The specs-old row ALSO matches via the new docs/superpowers ancestor
  # entry; both are legitimate and there is no way to isolate one from the
  # other for this family, since anything under docs/superpowers/specs-old
  # is definitionally nested under docs/superpowers too.
  check hit  "OVER-FIRE (accepted): sibling database/ shares the data prefix"   "cat app/public/database/config.json"
  check hit  "OVER-FIRE (accepted): sibling iconsets/ shares the icons prefix"  "cat app/public/iconsets/foo.svg"
  check hit  "OVER-FIRE (accepted): sibling specs-old/ (also via ancestor)"    "cat docs/superpowers/specs-old/draft.md"
  check miss "sibling file: NOTICES-OLD.txt" "cat app/public/THIRD-PARTY-NOTICES-OLD.txt"

  # --- ACCEPTED OVER-FIRE (bare filename, no trailing delimiter to bound it):
  # a literal file path has no natural "next char must be /" boundary the way
  # a directory does, so a longer filename sharing the same PREFIX genuinely
  # does contain the protected string and is correctly MATCHED - not a bug,
  # but worth pinning so it isn't mistaken for one later. (Same carrier-verb
  # note as the block above: at the DECISION level this `cat` now suppresses.)
  check hit  "path match: NOTICES.txt.bak" "cat app/public/THIRD-PARTY-NOTICES.txt.bak"

  # ======================================================================
  # #309 FOLLOW-UP: the read-only exemption. Driven through `decide` (the
  # COMPLETE Bash-arm decision), never `check`.
  #
  # EVERY row here names a protected path. That is not decoration: without
  # one the command allows on the path check alone and the row would prove
  # nothing about the exemption - it would pass identically with the whole
  # exemption deleted (#216's near-miss lesson, whose original instance was a
  # membership row that a `<` redirect had already disqualified).
  #
  # Each MUST-FIRE row carries exactly ONE reason to fire beyond the path, so
  # it isolates the clause it pins. (These rows want `advisory`, not `ask` -
  # every one names a build-output path; see the 2026-08-09 split.) Where two conditions cannot be separated
  # (`$(` necessarily contains both `$` and `(`), the row says so and the
  # separable halves get their own rows.

  # --- MUST SUPPRESS: one allowlisted verb, one protected path, nothing else.
  # The first row IS the maintainer's reported case.
  decide_exempt "EXEMPT: stat (the reported case)"   "stat app/public/data/mask.bin"
  decide_exempt "EXEMPT: ls"                         "ls -la app/public/icons"
  decide_exempt "EXEMPT: wc"                         "wc -c app/public/THIRD-PARTY-NOTICES.txt"
  decide_exempt "EXEMPT: du"                         "du -sh app/public/brand"
  decide_exempt "EXEMPT: head"                       "head -n 5 docs/superpowers/specs/foo.md"
  # (#437) head's symmetric partner, added on the condition VERB SELECTION set
  # for itself. Mutation-checked: removing `tail` from READONLY_VERBS reds this
  # row plus its reason-string twin case.
  decide_exempt "EXEMPT: tail (#437)"                "tail -n 5 docs/superpowers/specs/foo.md"
  decide_exempt "EXEMPT: cat"                        "cat app/public/data/mask.bin"
  decide_exempt "EXEMPT: sha256sum"                  "sha256sum app/public/data/mask.bin"
  decide_exempt "EXEMPT: md5sum"                     "md5sum app/public/data/mask.bin"
  decide_exempt "EXEMPT: test"                       "test -f app/public/data/mask.bin"
  decide_exempt "EXEMPT: [ (bracket form of test)"   "[ -f app/public/data/mask.bin ]"
  decide_exempt "EXEMPT: readlink"                   "readlink app/public/data/mask.bin"
  decide_exempt "EXEMPT: realpath"                   "realpath app/public/data/mask.bin"
  decide_exempt "EXEMPT: dirname"                    "dirname app/public/data/mask.bin"
  decide_exempt "EXEMPT: basename"                   "basename app/public/data/mask.bin"
  decide_exempt "EXEMPT: .pmtiles entry, not a dir"  "stat app/dist/data/basemap.pmtiles"
  decide_exempt "EXEMPT: leading whitespace ignored" "  stat app/public/data/mask.bin"
  # Behaviour change stated rather than left to be inferred: the four
  # `cat`-carrier over-fires pinned in the path-matching blocks above no
  # longer reach the user, because the command that produces each is a bare
  # `cat`. All four get a decision-level twin (#388 review, Finding 4 - three
  # of them had none, leaving the user-visible half of the change unpinned:
  # nothing would have failed if one started prompting or advising again,
  # which is the regression this PR exists to prevent).
  decide_exempt "EXEMPT: sibling database/ read no longer prompts"  "cat app/public/database/config.json"
  decide_exempt "EXEMPT: sibling iconsets/ read no longer prompts"  "cat app/public/iconsets/foo.svg"
  decide_exempt "EXEMPT: sibling specs-old/ read no longer prompts" "cat docs/superpowers/specs-old/draft.md"
  decide_exempt "EXEMPT: NOTICES.txt.bak read no longer prompts"    "cat app/public/THIRD-PARTY-NOTICES.txt.bak"

  # --- MUST NOT SUPPRESS (advisory, per the 2026-08-09 split - every row
  # here names a BUILD-OUTPUT path, so a non-exempt hit advises rather than
  # asks; the SPLIT block further down carries the spec-tree twins): verb
  # MEMBERSHIP is what fails. No disqualifying construct
  # in any of these - strip one clause and only these rows can catch it.
  # (#530) RETITLED, not merely kept: `sed` IS on READONLY_VERBS now, so this
  # row no longer pins verb membership at all. Leaving the old title would
  # have described a decision this file stopped making in the same commit.
  # What it pins is the OUTCOME - `sed -i` on a protected path must never be
  # silent - and NOT any single branch: it has TWO independent triggers, the
  # `-i` flag and the `s/x/y/` script, either of which alone makes
  # sed_readonly_ok say no. MEASURED: deleting the short-flag whitelist
  # outright leaves this row GREEN. The isolating twin for that branch is the
  # `-ni 5p` row in the #530 block below, which carries a VALID script so the
  # flag is the only trigger.
  decide advisory "SED: -i must never be silent (outcome row, two triggers)" "sed -i s/x/y/ app/public/data/mask.bin"
  decide advisory "MEMBERSHIP: cp is not read-only"       "cp /tmp/f app/public/data/mask.bin"
  decide advisory "MEMBERSHIP: touch is not read-only"    "touch app/public/data/mask.bin"
  decide advisory "MEMBERSHIP: find is EXCLUDED (-delete/-exec surface)" "find app/public/data -name x"
  decide advisory "MEMBERSHIP: file is EXCLUDED (file -C -m X writes X.mgc)" "file app/public/data/mask.bin"
  # (#530) REWRITTEN, title and reasoning both, because its claim is now
  # false: #388 excluded `grep` outright (a Claude Code shell FUNCTION
  # shimming to ugrep, whose option surface contains writers/executors), so
  # this row wanted `advisory`. #530 re-admitted the verb behind
  # GREP_SHIM_INTERCEPTED, so the SAME command is now EXEMPT and the row
  # moves to decide_exempt - which additionally asserts the command really
  # does name a protected path, so it cannot pass by a typo. It is the
  # decision-level twin the path-matching block above points at.
  decide_exempt "EXEMPT: grep (#530, re-admitted with a shim mirror)" "grep -n foo app/public/data/mask.bin"
  decide advisory "MEMBERSHIP: exact match, not prefix"   "statx app/public/data/mask.bin"
  decide advisory "MEMBERSHIP: exact match, not a path-qualified spelling" "/usr/bin/stat app/public/data/mask.bin"
  decide advisory "MEMBERSHIP: a bare path as the verb"   "app/public/data/mask.bin"

  # --- MUST NOT SUPPRESS (advisory): a WRITE-CAPABLE CHARACTER is what fails. Every row is an
  # allowlisted verb + a protected path, so the named character is the only
  # thing standing between it and suppression. These are the fail-open shapes
  # a first-word-only allowlist would have let through.
  decide advisory "CHAR >: redirect makes cat a write"    "cat app/public/data/mask.bin > /tmp/x"
  decide advisory "CHAR >>: append redirect"              "cat app/public/data/mask.bin >> /tmp/x"
  decide advisory "CHAR <: input redirect"                "wc -l < app/public/data/mask.bin"
  decide advisory "CHAR <<: heredoc"                      "cat app/public/data/mask.bin << EOF"
  decide advisory "CHAR |: pipe (could pipe into tee)"    "cat app/public/data/mask.bin | wc -l"
  decide advisory "CHAR ||: or-list"                      "stat app/public/data/mask.bin || true"
  decide advisory "CHAR &: background"                    "stat app/public/data/mask.bin &"
  decide advisory "CHAR &&: and-list (stat foo && rm bar shape)" "stat app/public/data/mask.bin && true"
  decide advisory "CHAR ;: separator"                     "stat app/public/data/mask.bin ; true"
  # shellcheck disable=SC2016  # the literal backtick IS the test input
  decide advisory 'CHAR backtick: command substitution'   'stat app/public/data/mask.bin `true`'
  # shellcheck disable=SC2016  # literal $ is the test input, not an expansion
  decide advisory 'CHAR $: parameter expansion'           'stat $HOME/app/public/data/mask.bin'
  # shellcheck disable=SC2016
  decide advisory 'CHAR $( ): substitution - inseparable from $ and ( )' 'stat $(echo app/public/data/mask.bin)'
  # shellcheck disable=SC2016
  decide advisory 'CHAR ${ }: inseparable from $ and { }'  'stat ${HOME}/app/public/data/mask.bin'
  decide advisory "CHAR ( ): subshell"                    "stat (app/public/data/mask.bin)"
  decide advisory "CHAR { }: brace expansion"             "stat app/public/data/{mask,x}.bin"
  decide advisory "CHAR backslash: escaping"              'stat app/public/data/mask.bin\x'
  decide advisory "CHAR !: negation/history"              "test ! -f app/public/data/mask.bin"
  decide advisory "CHAR #: comment"                       "stat app/public/data/mask.bin # note"
  decide advisory "CHAR newline: second command"          "stat app/public/data/mask.bin${nl}true"
  decide advisory "CHAR carriage return"                  "stat app/public/data/mask.bin${cr}true"

  # --- MUST NOT SUPPRESS (#404): a multi-segment command where EVERY segment
  # independently looks read-only. This is the exact shape that let the
  # since-removed bash_decision() twin diverge from production undetected:
  # a `;`-segmenter checking each segment's first word against
  # READONLY_VERBS independently would ALLOW this (both `stat` and `ls` are
  # on the allowlist), while the real predicate's "any disqualifying char
  # anywhere" rule (the bare `;`) correctly still fires. This is the
  # maintainer's own reported reproduction command, unchanged.
  decide advisory "MULTI-SEGMENT (#404): every segment individually looks read-only" "stat app/public/data/mask.bin; ls app/public/data"

  # --- #437 ACCEPTANCE PAIR, pinned at the decision the MEASUREMENT reached.
  # Row A is the shape #437 nominated as noise. It still FIRES (as an
  # advisory since the 2026-08-09 split; it ASKED when #437 measured it),
  # because the
  # `|`-split that would suppress it measured 0 prompts removed across 27,040
  # real commands and was rejected on that yield (full record, including why
  # its zero is a WEAKER zero than #404's two, in DESIGN above). This row is
  # therefore the REJECTION's pin, not the fix's: it reds the moment anyone
  # takes `|` out of WRITE_CAPABLE_CHARS without re-running that measurement.
  decide advisory "#437 A: ls | head still fires (|-split measured 0, rejected)" "ls app/public/data/ | head -20"
  # Row B is the half of #437's reported command that MUST keep firing - the
  # issue says so itself ("no predicate short of running the JS can prove
  # otherwise"). Unlike the clause-isolating rows above, this one deliberately
  # carries SEVERAL independent triggers (`node` is not allowlisted, and the
  # string also holds `(`, `)`, `;`, `$`): it is a verbatim acceptance case,
  # not a row isolating one clause, so it must not be read as pinning verb
  # membership - the MEMBERSHIP block above does that job.
  # shellcheck disable=SC2016  # literal $HOME is the test input, not an expansion
  decide advisory "#437 B: node -e naming a protected path must still fire" 'node -e "const h=require($HOME/app/public/data/harbors.json); console.log(h.length)"'

  # --- MUST NOT SUPPRESS (advisory): a WRITE-CAPABLE TOKEN is what fails. Each token appears as
  # an ARGUMENT of an allowlisted verb, which is contrived on purpose: the
  # natural spelling (`xargs stat <path>`) would also fail verb membership
  # and so could not isolate the token (#216). These rows are defence in
  # depth - the token is already unreachable as an executable here.
  decide advisory "TOKEN tee"                             "stat tee app/public/data/mask.bin"
  decide advisory "TOKEN xargs"                           "stat xargs app/public/data/mask.bin"
  decide advisory "TOKEN -exec"                           "stat -exec app/public/data/mask.bin"
  decide advisory "TOKEN -execdir (via -exec subsumption, not its own entry)" "stat -execdir app/public/data/mask.bin"
  decide advisory "TOKEN -delete"                         "stat -delete app/public/data/mask.bin"
  decide advisory "TOKEN -ok"                             "stat -ok app/public/data/mask.bin"
  decide advisory "TOKEN -okdir (via -ok subsumption, not its own entry)"     "stat -okdir app/public/data/mask.bin"
  decide advisory "TOKEN sudo"                            "stat sudo app/public/data/mask.bin"
  decide advisory "TOKEN eval"                            "stat eval app/public/data/mask.bin"
  decide advisory "TOKEN sh -c"                           "stat sh -c app/public/data/mask.bin"
  decide advisory "TOKEN bash -c (via sh -c subsumption, not its own entry)" "stat bash -c app/public/data/mask.bin"

  # ======================================================================
  # #530 VERB-SCOPED DISQUALIFIERS. `grep` and `sed` are the only two
  # READONLY_VERBS entries with a real write surface, so membership alone
  # decides nothing for them and these rows pin BOTH directions: the shapes
  # that must now be silent, and the shapes that must keep firing.
  #
  # The MUST-SUPPRESS rows are the issue's acceptance criteria 1-3 verbatim,
  # plus one row per whitelist entry that would otherwise be unpinned (a
  # whitelist entry no row exercises can be deleted with the suite still
  # green - the same unfalsifiable-row defect that got `"bash -c"` removed
  # from WRITE_CAPABLE_TOKENS).
  #
  # Most MUST-FIRE rows carry ONE trigger each beyond the path (#216), so
  # deleting the single array entry or branch the row names reds that row and
  # not the battery. Where that is NOT so it is said out loud at the row,
  # because a row's title is a claim to be verified, not read. The measured
  # exceptions, all structural rather than sloppy:
  #   * `-*-save-config*` is SUBSUMED by `-*-config*` (any string holding
  #     `-save-config` holds `-config`), so its own mutation reds 0 rows and
  #     NO row can pin it. Kept regardless, because this array's job is to be
  #     a diffable mirror of the shim - stated at the array itself.
  #   * The three sed script-form alternatives share one branch, so deleting
  #     the whole script whitelist reds all of their rows together; deleting
  #     ONE alternative reds only the rows using that form.
  #   * `sed_readonly_ok`'s closing `have_script` default is unpinnable by
  #     construction - see its own note there.
  #   * The `sed -i` and `sed -f` acceptance rows carry two triggers each and
  #     say so; their isolating twins are the `-ni 5p` / `--in-place -n 5p`
  #     rows, which use a VALID script so the flag is the only trigger.

  # --- MUST SUPPRESS: acceptance criteria 1-3. The first three are on the
  # SPEC arm, where the old behaviour was a BLOCKING ask, so they are the
  # sharpest half of the complaint; the exemption is evaluated before the
  # ask/advisory split, which is why a spec path can be silent at all.
  decide_exempt "#530 AC1: grep on a spec path is silent"        "grep -n foo docs/superpowers/specs/x.md"
  decide_exempt "#530 AC2: sed numeric range on a spec path"     "sed -n '20,60p' docs/superpowers/specs/x.md"
  decide_exempt "#530 AC2: sed regex address on a spec path"     "sed -n '/pattern/p' docs/superpowers/specs/x.md"
  decide_exempt "#530 AC3: grep on a build-output path"          "grep -n foo app/public/data/harbors.json"
  decide_exempt "#530 AC3: sed numeric range on a build output"  "sed -n '1,40p' app/public/data/harbors.json"

  # --- MUST SUPPRESS: one row per sed whitelist entry, so no entry can be
  # dropped with the suite still green. Each also exercises a script form.
  decide_exempt "#530 sed -n/-E bundled (safe bundle, unlike -ni)" "sed -nE 5p app/public/data/mask.bin"
  decide_exempt "#530 sed -r"                                     "sed -r -n /foo/p app/public/data/mask.bin"
  decide_exempt "#530 sed --quiet"                                "sed --quiet 1,3p app/public/data/mask.bin"
  decide_exempt "#530 sed --silent + bare command script"         "sed --silent p app/public/data/mask.bin"
  decide_exempt "#530 sed --regexp-extended + d command"          "sed --regexp-extended -n 5d app/public/data/mask.bin"

  # --- MUST FIRE (advisory - every row names a build-output path): the sed
  # whitelist. `w`, `e` and `s///w` need no command-line flag at all, which is
  # why this is a positive whitelist and not a blacklist of `-i`.
  # These two carry a VALID script (`5p`) on purpose, so the rejected FLAG is
  # the ONLY trigger and each isolates the branch it names (#216). Their first
  # cut used `s/x/y/`, which the script whitelist rejects independently - so
  # both rows stayed green with the flag checks deleted outright, i.e. they
  # pinned nothing at all. MEASURED by the mutation battery, then fixed; the
  # PR's table records it. Both are also genuine in-place writes, not
  # contrivances - `sed -ni 5p FILE` and `sed --in-place -n 5p FILE` overwrite
  # FILE with its fifth line.
  decide advisory "#530 sed: bundled -ni contains -i (scan, not getopt)" "sed -ni 5p app/public/data/mask.bin"
  decide advisory "#530 sed: --in-place is not a safe long flag"         "sed --in-place -n 5p app/public/data/mask.bin"
  # ACCEPTANCE row (issue #530 names it). TWO independent triggers - the `-f`
  # AND the fact that `evil.sed` is then read as the script and rejected - so
  # it pins the OUTCOME (this shape must never be silent), not a branch. Its
  # isolating twin for the flag branch is the `-ni 5p` row above. The `sed -i
  # s/x/y/` acceptance shape is already a row in the block further up and is
  # deliberately not duplicated here.
  decide advisory "#530 sed: -f hides the script from any string check"  "sed -f evil.sed app/public/data/mask.bin"
  decide advisory "#530 sed: w command writes with no flag"             "sed -n '1,5w /tmp/out' app/public/data/mask.bin"
  decide advisory "#530 sed: e command executes a shell command"         "sed '1e id' app/public/data/mask.bin"
  decide advisory "#530 sed: s///w flag writes"                          "sed -n 's/a/b/w out' app/public/data/mask.bin"
  decide advisory "#530 sed: flag AFTER the script (GNU permutes options)" "sed -n 5p app/public/data/mask.bin -i"

  # --- MUST FIRE (advisory): the grep shim mirror. One row per
  # GREP_SHIM_INTERCEPTED entry except `-*-save-config*`, which is subsumed
  # (see the block header) - the `--save-config` row below fires through
  # `-*-config*` and is kept because it is an acceptance case, not because it
  # pins that entry.
  decide advisory "#530 grep --filter (ugrep executes COMMANDS)"  "grep --filter='*:cat' app/public/data/mask.bin"
  decide advisory "#530 grep --pager (executes a pager)"          "grep --pager app/public/data/mask.bin"
  # The QUOTED spelling: this hook sees the raw command string, so the token
  # is literally `'--pager'` and starts with a quote, not a dash - every
  # dash-anchored pattern misses it unless unquote_token() runs first. This
  # is the only row pinning that on the grep side (the sed rows pin it via
  # their quoted scripts), and without it stubbing unquote_token to a no-op
  # left the whole grep mirror bypassable by adding two quote characters.
  decide advisory "#530 grep quoted option (pins unquote_token)"   "grep '--pager' app/public/data/mask.bin"
  decide advisory "#530 grep --view (executes a viewer)"          "grep --view app/public/data/mask.bin"
  decide advisory "#530 grep --format-open"                       "grep --format-open=x app/public/data/mask.bin"
  decide advisory "#530 grep --config (loads options from a file)" "grep --config=x app/public/data/mask.bin"
  decide advisory "#530 grep --save-config (the one ugrep writer)" "grep --save-config=x app/public/data/mask.bin"
  decide advisory "#530 grep ---FILE (the --config short spelling)" "grep ---x app/public/data/mask.bin"
  decide advisory "#530 grep -@"                                  "grep -@x app/public/data/mask.bin"
  decide advisory "#530 grep -Z"                                  "grep -Z foo app/public/data/mask.bin"
  decide advisory "#530 grep -nz (BUNDLED, missed by -[Zz]* alone)" "grep -nz foo app/public/data/mask.bin"
  decide advisory "#530 grep --null"                              "grep --null foo app/public/data/mask.bin"
  decide advisory "#530 grep --null-data"                         "grep --null-data foo app/public/data/mask.bin"
  # NOT part of the shim mirror - this guard's own addition (GREP_EXTRA_
  # REJECTED). Not reachable today (no tty), pinned so it cannot be dropped
  # as "unused" by someone who only checks what fires in this environment.
  decide advisory "#532 grep -Q (TUI, F2 runs \$EDITOR)"           "grep -Q foo app/public/data/mask.bin"
  decide advisory "#532 grep -nQ (BUNDLED, missed by -Q* alone)"    "grep -nQ foo app/public/data/mask.bin"
  decide advisory "#532 grep --query (long spelling)"              "grep --query foo app/public/data/mask.bin"

  # ======================================================================
  # PR #532 BLOCKER 1 - QUOTED FLAGS. A shell removes quotes ENTIRELY before
  # the program sees a word, so `'-i'` and `""-i""` both reach sed as `-i`.
  # Classifying the RAW token made every one of these SILENT, on the spec arm
  # included, while the unquoted twin above was correctly caught - which is
  # exactly why the battery was green through a live fail-open. BOTH spellings
  # are pinned deliberately: one-layer stripping closes the single-quoted form
  # alone, so a row for only that spelling would go green on the WEAKER fix.
  #
  # Verified writes, on throwaway files in /tmp, never a protected path:
  # `sed -n 5p target.txt '-i'` truncated a 6-line file to 1 line, and
  # `sed -n 5p t2.txt '-f' evil.sed` carrying a `w` command created a new file.
  decide advisory "#532 sed quoted '-i' operand (build output)"    "sed -n 5p app/public/data/mask.bin '-i'"
  decide ask      "#532 sed quoted '-i' operand (SPEC ARM)"        "sed -n 5p docs/superpowers/specs/x.md '-i'"
  decide ask      '#532 sed DOUBLED-quote ""-i"" operand'          'sed -n 5p docs/superpowers/specs/x.md ""-i""'
  decide ask      "#532 sed quoted '-f' operand"                   "sed -n 5p docs/superpowers/specs/x.md '-f' evil.sed"
  decide ask      "#532 sed quoted '--in-place' operand"           "sed -n 5p docs/superpowers/specs/x.md '--in-place'"
  # The SAME defect at the grep site, which the review did not report and the
  # blocker's own probe found: one-layer stripping caught `'--pager'` and let
  # the doubled and mixed spellings through, exempting ugrep's command
  # executor and its one file-writer on the SPEC arm.
  decide advisory '#532 grep DOUBLED-quote ""--pager""'            'grep ""--pager"" app/public/data/mask.bin'
  decide ask      '#532 grep DOUBLED-quote ""--filter"" (SPEC ARM)' 'grep ""--filter=x:cat"" docs/superpowers/specs/x.md'
  decide ask      "#532 grep mixed-quote '--save-config' (SPEC ARM)" "grep \"'--save-config=x'\" docs/superpowers/specs/x.md"
  # BOUNDING ROW: stripping every quote must not start firing on an ordinary
  # QUOTED FILENAME operand, which is the obvious over-fire the fix could
  # have introduced.
  # PATH REPOINTED (PR #532 re-review, MINOR C): this row used to name
  # `app/public/data/mask.bin`, which contains NO dash - so the very mutation
  # its comment claims to bound, over-broadening the operand test `-*` to
  # `*-*`, reds 0 rows. MEASURED, and re-measured after the repoint: with
  # `THIRD-PARTY-NOTICES.txt` the same mutation reds exactly this row. The
  # row was never useless (it reds on a quote-stripping over-broadening, and
  # on reject-everything) - it was vacuous against the one mutation it named,
  # which is the #216 shape one level up, in a row's own description.
  decide_exempt "#532 quoted filename operand must stay exempt"    "sed -n 5p 'app/public/THIRD-PARTY-NOTICES.txt'"

  # ======================================================================
  # #535 - UNBALANCED-QUOTE sed SCRIPT token. `sed -n 'p w /tmp/OUT' <path>`
  # used to split (this function's own whitespace `read -ra`, not a real
  # shell re-tokenisation) into `'p` + `w` + `/tmp/OUT'`, and
  # unquote_token()'s unconditional one-layer strip turned the FIRST
  # fragment into a bare `p`, matching the script whitelist and silently
  # accepting the whole thing while `w` and `/tmp/OUT'` passed through
  # unchallenged as file operands - a live write shape reachable on the
  # SPEC arm. Both quote spellings are pinned, matching the sed/grep
  # DOUBLED/mixed-quote rows above this block. SPEC and build-output arms
  # both pinned, matching the ask/advisory split used throughout this file.
  decide ask      "#535 sed unbalanced-quote script 'p w /tmp/OUT' (SPEC ARM)"     "sed -n 'p w /tmp/OUT' docs/superpowers/specs/x.md"
  decide advisory "#535 sed unbalanced-quote script 'p w /tmp/OUT' (build output)" "sed -n 'p w /tmp/OUT' app/public/data/mask.bin"
  decide ask      '#535 sed unbalanced DOUBLE-quote script (SPEC ARM)'            'sed -n "p w /tmp/OUT" docs/superpowers/specs/x.md'
  # BOUNDING ROWS - no regression in the read-only ergonomics #530 restored
  # and this fix is not obligated to touch: the balanced-quote check must
  # fire ONLY on a token that opens a quote it does not close, never on a
  # properly closed quoted script or a bare unquoted one. These four are the
  # acceptance criteria's named still-silent shapes.
  decide_exempt "#535 no regression: quoted numeric range stays exempt"  "sed -n '1,40p' app/public/data/harbors.json"
  decide_exempt "#535 no regression: bare numeric address stays exempt"  "sed -n 5p app/public/data/harbors.json"
  decide_exempt "#535 no regression: quoted regex address stays exempt"  "sed -n '/pattern/p' docs/superpowers/specs/x.md"
  decide_exempt "#535 no regression: bare command script stays exempt"   "sed -n p app/public/data/harbors.json"

  # ======================================================================
  # PR #532 re-review, MAJOR A - GLOB operands. `*`, `?`, `[`, `]` are not in
  # WRITE_CAPABLE_CHARS, so quote stripping never touches them and the SHELL
  # expands the token before the program runs. With a file named `-i` in cwd
  # all three spellings below expand to `-i` (measured), and `sed -n 5p
  # target.txt [-]i` truncated a 6-line file to 1 line. All were SILENT.
  decide advisory "#532A sed glob [-]i -> -i (build output)"        "sed -n 5p app/public/data/mask.bin [-]i"
  decide ask      "#532A sed glob [-]i -> -i (SPEC ARM)"            "sed -n 5p docs/superpowers/specs/x.md [-]i"
  decide ask      "#532A sed glob ?i -> -i (SPEC ARM)"              "sed -n 5p docs/superpowers/specs/x.md ?i"
  decide ask      "#532A sed glob *i -> -i (SPEC ARM)"              "sed -n 5p docs/superpowers/specs/x.md *i"
  # The same route at the grep site, measured silent on 19de1f5 too:
  # `[-]-pager` expands to `--pager` (measured), so a leading metachar walked
  # past every dash-anchored mirror pattern. `[-]Q` reaches the TUI entry.
  decide advisory "#532A grep glob [-]-pager -> --pager"            "grep [-]-pager app/public/data/mask.bin"
  decide ask      "#532A grep glob [-]Q -> -Q (SPEC ARM)"           "grep [-]Q docs/superpowers/specs/x.md"
  # (MINOR E) The sed site pins all three of its metachars; this site had rows
  # for `[` only, so its `*` and `?` alternatives could each be deleted with
  # the whole suite still green - MEASURED at 0 rows red apiece. That is the
  # rule this block's own header states, unapplied at one of the two sites.
  decide advisory "#532E grep glob ?-pager (pins the '?' alternative)" "grep ?-pager app/public/data/mask.bin"
  decide advisory "#532E grep glob *-pager (pins the '*' alternative)" "grep *-pager app/public/data/mask.bin"
  # (MINOR D) An EMPTY quote pair does not suppress globbing - `''[-]i`
  # expands to `-i` exactly as `[-]i` does (measured) - so these must fire
  # too. They were SILENT on `618d691`.
  decide advisory "#532D grep ''[-]-pager (empty pair does not quote it)" "grep ''[-]-pager foo app/public/data/mask.bin"
  decide ask      "#532D grep ''[-]Q (SPEC ARM)"                    "grep ''[-]Q foo docs/superpowers/specs/x.md"
  # ... while a NON-empty quoted prefix genuinely does make a leading dash
  # unreachable (`'x'[-]y` -> `x[-]y`), so this stays exempt. Without this row
  # the MINOR D fix could be over-broadened back to "any token containing a
  # metachar" with nothing noticing.
  decide_exempt "#532D quoted PREFIX really does suppress the glob"  "grep 'x'[-]y app/public/data/harbors.json"
  # BOUNDING ROWS, so "reject a leading metachar" cannot later be
  # over-broadened into "reject any glob". A token starting with an ORDINARY
  # character globs only to names starting with that character, so it can
  # never become a flag - these are ordinary reads and must stay silent.
  decide_exempt "#532A legit glob read stays exempt (sed)"          "sed -n '1,40p' app/public/data/*.json"
  decide_exempt "#532A legit glob read stays exempt (grep)"         "grep -n foo app/public/data/*.json"
  # And a QUOTED leading metachar is not a glob at all - the shell will not
  # expand it - so an ordinary bracket-expression PATTERN must stay exempt.
  # This is why the grep site tests the RAW token while sed's operand check
  # tests the stripped one; without this row that distinction is unpinned.
  decide_exempt "#532A quoted bracket pattern is not a glob (grep)"  "grep '[0-9]' app/public/data/harbors.json"

  # --- INERT REDIRECTS (the FOURTH over-restriction ruling). One row per
  # INERT_REDIRECTS entry, so deleting an entry reds a row rather than
  # silently narrowing the exemption back - the `GREP_EXTRA_REJECTED` rule
  # above, applied to this array. The FIRST row is the maintainer's actual
  # reported command, reproduced verbatim; it was MEASURED asking on
  # 5e98741 and is the one row whose failure means the reported defect is
  # back.
  #
  # WHICH OF THESE ROWS ARE UNIQUE DETECTORS, measured rather than assumed,
  # against a TWENTY-EIGHT-mutation battery: strip reverted; each of the
  # eleven array entries dropped singly; rescan loop collapsed to one pass;
  # whitespace boundary dropped, and each of its two halves dropped alone;
  # bare `>` added; generalised to "any 2> target"; `>`/`&` deleted from
  # WRITE_CAPABLE_CHARS; tab normalisation removed; array order reversed;
  # `tr` reverted to the bash substitution; length bound disabled, deleted,
  # and reverted from a BYTE count to a CHARACTER count; leading pad
  # removed; fd-close forms ADDED; sentinel dropped.
  #
  # FOURTEEN of the twenty-six INERT rows are the suite's ONLY detector for
  # some mutation - the NINE single-entry rows whose entry no other row
  # exercises (`2>/dev/null`, `2> /dev/null`, `1>/dev/null`, `1> /dev/null`,
  # `> /dev/null`, `&>/dev/null`, `&> /dev/null`, `1>&2`, `>&2`), plus the
  # adjacent-repeats row (rescan loop), the tab row (tab normalisation), the
  # leading-position row (leading pad), the sentinel assertion (sentinel)
  # and the unit row (byte-vs-character count).
  #
  # THE TIME-BOUNDED ROW IS NO LONGER SOLE, and that is a change from the
  # wave-3 measurement rather than an error in it: the unit row added in
  # wave 4 also reds under both bound mutations, so neither row is now the
  # only detector for either. Both are kept - they fail for different
  # reasons (one on wall clock, one on a decision) and their diagnostics say
  # different things.
  #
  # The OTHER TWELVE are each caught by a sibling too. They are kept for a
  # stated reason rather than for coverage they do not add - do not read
  # them as unique detectors. The verbatim row is REGRESSION IDENTITY (its
  # name is what tells a future reader the reported defect is back); the
  # `>/dev/null` and combined rows cover one array entry from two
  # directions; the three fd-close rows red together, so no one of them is
  # sole; the time-bounded row shares both bound mutations with the unit
  # row; and the five near-misses overlap because the two BROADEST wrong
  # fixes break several at once (deleting `>`/`&` from WRITE_CAPABLE_CHARS
  # reds five; "any 2> target" reds three). A NARROWER wrong fix still
  # separates them: bare-`>`-in-array reds only `bare > survives`, and
  # dropping the whitespace boundary reds exactly the three suffix
  # near-misses (`/dev/null2`, `>&2x`, `2> /dev/nullx`).
  #
  # TWO MUTATIONS RED ZERO ROWS, and both are recorded rather than hidden.
  # Reversing the array order is an EQUIVALENT MUTANT - evidence that the
  # entries cannot interfere, not a coverage hole. Reverting `tr` to the
  # bash substitution is NOT equivalent but IS unpinned: with the length
  # bound in force nothing large enough to expose the cost can reach the
  # strip, so no row can see the difference. `tr` is defence in depth whose
  # justification is the measurement table at MAX_EXEMPTIBLE_CMD_LEN, and
  # saying so is more useful than inventing a row that cannot fail.
  decide_exempt "INERT: the reported command, verbatim"  "ls -la docs/superpowers/plans/ 2>&1"
  decide_exempt "INERT: 2>/dev/null"                     "ls -la docs/superpowers/plans/ 2>/dev/null"
  decide_exempt "INERT: >/dev/null"                      "cat docs/superpowers/specs/x.md >/dev/null"
  decide_exempt "INERT: > /dev/null (spaced)"            "cat docs/superpowers/specs/x.md > /dev/null"
  decide_exempt "INERT: &>/dev/null"                     "ls docs/superpowers &>/dev/null"
  decide_exempt "INERT: &> /dev/null (spaced)"           "ls docs/superpowers &> /dev/null"
  # The loop, not just one pass: bash's substitution does not rescan, so two
  # ADJACENT occurrences need a second pass (the first match eats the space
  # the second needs). Reds if the `while` is collapsed to a single pass.
  decide_exempt "INERT: adjacent repeats need the loop"  "ls docs/superpowers 2>&1 2>&1"
  # The everyday combined spelling, and a stripped literal in front of
  # another one - neither is a duplicate of the single-literal rows above,
  # because each exercises a DIFFERENT pair of array entries interacting.
  decide_exempt "INERT: >/dev/null 2>&1 combined"        "ls docs/superpowers >/dev/null 2>&1"

  # --- INERT REDIRECTS, the NEAR-MISSES. These are the rows that stop the
  # strip from being widened into a fail-open, and each isolates ONE reason
  # (#216 one-trigger-per-row): a bare `>` SURVIVING the strip, and a `2>`
  # naming a real path. Both must still ASK.
  decide ask "INERT near-miss: bare > survives the strip"  "ls docs/superpowers 2>&1 > out.txt"
  decide ask "INERT near-miss: 2> names a real spec path"  "ls docs/superpowers 2>docs/superpowers/specs/x"
  # THE BOUNDARY RULE ITSELF. A bare substring strip would leave `ls
  # docs/superpowers 2` here - metachar-free, verb `ls` - and SILENTLY ALLOW
  # a redirect into a real file named `/dev/null2`. This row reds the moment
  # the space-delimiting is dropped from strip_inert_redirects().
  decide ask "INERT near-miss: /dev/null2 is a real file"  "ls docs/superpowers 2>/dev/null2"

  # --- INERT REDIRECTS, WAVE 2: the spelling gaps. The first wave's list was
  # inconsistent - it carried `>/dev/null` in BOTH spacings but `2>/dev/null`
  # in only one, and omitted the fd-dups to stderr entirely. These are the
  # identical safety class (a /dev/null discard or an fd-dup, neither of
  # which can name a file), so they are added rather than left as residuals.
  # One row per new entry, same per-entry rule as the block above.
  decide_exempt "INERT: 2> /dev/null (spaced)"           "ls -la docs/superpowers/plans/ 2> /dev/null"
  decide_exempt "INERT: 1>/dev/null (explicit fd 1)"     "cat docs/superpowers/specs/x.md 1>/dev/null"
  decide_exempt "INERT: 1> /dev/null (spaced)"           "cat docs/superpowers/specs/x.md 1> /dev/null"
  decide_exempt "INERT: 1>&2 (explicit fd-dup)"          "ls docs/superpowers 1>&2"
  decide_exempt "INERT: >&2 (bare fd-dup)"               "ls docs/superpowers >&2"
  # A TAB, not a space, on either side of the operator - the boundary is a
  # whitespace class, so this must behave exactly like the space-separated
  # rows above. Reds if the tab normalisation in strip_inert_redirects goes.
  decide_exempt "INERT: tab-separated 2>&1"              "ls -la docs/superpowers/plans/${tab}2>&1"

  # --- WAVE 2 NEAR-MISSES. `>&2x` is the sharpest one in this file and it is
  # MEASURED, not reasoned: `echo hi >&2x` CREATES A FILE NAMED `2x`, because
  # bash reads `>&word` with a non-numeric word as "both streams to the file
  # word". So a one-character suffix turns the inert fd-dup just allowlisted
  # into a real write, and only the whitespace boundary tells them apart.
  # The /dev/null row is the same shape for the newly spaced form.
  decide ask "INERT near-miss: >&2x writes a file named 2x"  "ls docs/superpowers >&2x"
  decide ask "INERT near-miss: 2> /dev/nullx (spaced form)"  "ls docs/superpowers 2> /dev/nullx"

  # --- WAVE 3, MINOR 1: the LEADING boundary had no keeper. Removing the
  # leading pad from strip_inert_redirects reds zero rows without this, so
  # the leading-position strip was unpinned (fail-closed, hence not a
  # hazard - but unpinned all the same). A command whose FIRST token is an
  # inert redirect is still one simple command with an inert redirect on it.
  decide_exempt "INERT: leading-position strip"          ">/dev/null ls docs/superpowers"

  # --- WAVE 3, MINOR 2: the array was pinned against DELETION (one row per
  # entry) but not against ADDITION - adding the fd-CLOSE forms reddened
  # zero rows, so the in-file ruling that they are deliberately absent had
  # no keeper and a contributor "completing the set" would pass the whole
  # battery. Same shape as this repo's measured guard-DATA problem: the
  # detection logic was pinned, the data was not. These three rows enforce
  # the ruling instead of merely documenting it.
  decide ask "INERT: fd-close 2>&- stays non-exempt"     "ls docs/superpowers 2>&-"
  decide ask "INERT: fd-close 1>&- stays non-exempt"     "ls docs/superpowers 1>&-"
  decide ask "INERT: fd-close >&- stays non-exempt"      "ls docs/superpowers >&-"

  # --- WAVE 3: the SENTINEL round trip, asserted on the FUNCTION rather
  # than through `decide`. This is deliberate and the reason is measured:
  # the production entry point extracts the command with
  # `cmd=$(printf %s "$IN" | jq -r ...)`, and `$( )` strips trailing
  # newlines BEFORE the predicate ever runs - so at the production level a
  # sentinel-protected strip and a bare `$( )` one are INDISTINGUISHABLE and
  # no `decide` row could tell them apart. Asserting on the function
  # directly is the only construction that can see the difference. It reds
  # if the sentinel is dropped, which is what stops the `tr` rewrite from
  # silently re-introducing the trailing-newline loss that this function's
  # header rejected `$( )` over in the first place.
  # --- WAVE 3: A TIME-BOUNDED ROW, because the Blocker this wave fixes was a
  # TIMEOUT and no assertion in this file could see one. settings.json gives
  # the hook a 5 s cap, and a hook killed at that cap emits nothing - which
  # the harness reads as `allow`. So a big input could walk straight past the
  # guard while every row here stayed green. This row runs the real script on
  # an over-bound payload under a hard 5 s `timeout` and requires a decision.
  # MEASURED: shipped code answers in ~0.09 s (a ~55x margin); with the length
  # bound removed the same payload takes 6.01 s and is KILLED.
  #
  # It pins the LENGTH BOUND specifically. It cannot pin the `tr` fix, and
  # that is stated rather than implied: with the bound in place nothing over
  # 32 KB reaches the strip at all, and under 32 KB even the old quadratic
  # substitution costs at most ~0.14 s. `tr` is defence in depth whose
  # justification is the measurement table at the bound, not a row here.
  total=$((total + 1))
  big_payload=" 2>&1"
  for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17; do
    big_payload="$big_payload$big_payload"
  done
  big_json="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$(json_escape "ls docs/superpowers/specs/x.md$big_payload")\"}}"
  big_out=$(printf '%s' "$big_json" | timeout -k 2 5 "$SELF" 2>&1); big_rc=$?
  if [ "$big_rc" -eq 124 ] || [ "$big_rc" -eq 137 ]; then
    echo "SELFTEST FAIL [timeout bound]: an over-bound payload (${#big_payload} bytes) KILLED the hook at the 5 s cap - a killed guard emits the same nothing a satisfied one does, so this is a silent allow of a spec write."
    fail=1
  elif [ "$(hook_decision "$big_out")" != "ask" ]; then
    echo "SELFTEST FAIL [timeout bound]: over-bound payload got [$(hook_decision "$big_out")] want [ask] - anything past MAX_EXEMPTIBLE_CMD_LEN must fall through to the normal path."
    fail=1
  fi

  # --- WAVE 4: THE UNIT. A payload whose CHARACTER count is comfortably
  # under MAX_EXEMPTIBLE_CMD_LEN but whose BYTE count is over it must still
  # fire. `ls <spec> ` + 20 000 emoji is 20 0xx characters but ~80 KB, so a
  # character-counting bound admits it and a byte-counting bound does not.
  # This is the row that pins the UNIT rather than the threshold: revert the
  # scoped `LC_ALL=C` byte count to a bare `${#cmd}` and it reds.
  #
  # It is a `decide ask` in spirit but is written out here because the
  # payload has to be built rather than typed.
  total=$((total + 1))
  mb_payload=$(printf '\U0001F600%.0s' $(seq 1 20000))
  mb_json="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$(json_escape "ls docs/superpowers/specs/x.md $mb_payload")\"}}"
  mb_out=$(printf '%s' "$mb_json" | timeout -k 2 5 "$SELF" 2>&1); mb_rc=$?
  if [ "$mb_rc" -eq 124 ] || [ "$mb_rc" -eq 137 ]; then
    echo "SELFTEST FAIL [bound unit]: multibyte payload KILLED the hook at the 5 s cap."
    fail=1
  elif [ "$(hook_decision "$mb_out")" != "ask" ]; then
    echo "SELFTEST FAIL [bound unit]: a payload of $(LC_ALL=C; printf '%s' "${#mb_payload}") BYTES / ${#mb_payload} characters got [$(hook_decision "$mb_out")] want [ask] - the length bound is counting CHARACTERS, so multibyte content walks past a limit that is documented in bytes."
    fail=1
  fi

  total=$((total + 1))
  strip_inert_redirects "ls x${nl}"
  case "$STRIPPED_CMD" in
    *"$nl"*) ;;
    *) echo "SELFTEST FAIL [sentinel]: strip_inert_redirects ate a trailing newline - a bare \$( ) with no sentinel silently weakens the newline/CR check in bash_is_provably_readonly"; fail=1 ;;
  esac

  # --- The exemption must not widen the guard either: an allowlisted verb
  # with NO protected path is allowed for the ordinary reason (no hit), and
  # that has to stay independent of the exemption.
  decide allow "no path named: unrelated read" "cat app/src/App.tsx"

  # ======================================================================
  # 2026-08-09 ADVISORY SPLIT. The block above pins the DECISION MACHINERY
  # (which shapes suppress, which do not); these rows pin the SPLIT ITSELF -
  # that a non-exempt hit lands on `ask` or `advisory` according to WHICH path
  # matched. They are deliberately three named rows rather than a note on the
  # rows above, because the whole point of the change is that two commands
  # with identical SHAPE now get different answers, and that difference has to
  # be visible as its own assertion.
  #
  # The spec-tree rows are the load-bearing half: they are what stops a future
  # "simplify the two branches into one" from silently removing the prompt
  # that keeps a spec edit in the main session (CLAUDE.md).
  decide ask "SPLIT: spec write still ASKS (blocking, unchanged)"        "cp /tmp/f docs/superpowers/specs/foo.md"
  decide ask "SPLIT: docs/superpowers ancestor write still ASKS"         "mv docs/superpowers /tmp/stash"
  decide advisory "SPLIT: build-output write ADVISES, does not ask"      "cp /tmp/f app/public/data/mask.bin"
  # The exemption is evaluated BEFORE the split, so a provably read-only
  # command emits NOTHING - not an advisory either. decide_exempt's `allow`
  # is exactly "$SELF printed zero bytes", so this row IS that assertion
  # (deliberately a different verb+path from the EXEMPT block above, so it
  # cannot pass by sharing that row's reasons).
  decide_exempt "SPLIT: provably read-only emits NOTHING, not an advisory" "head -n 1 app/public/data/mask.bin"
  # MIXED: names a spec path AND a build-output path. PROTECTED_PATHS is
  # ordered data-first, so its first match here is `app/public/data` - if the
  # split classified THAT match instead of running its own spec pass, this
  # command would be downgraded to an advisory and a spec write would lose its
  # prompt. Mutation-checked: replacing the bash_hits_spec_gated_path() call
  # with a classification of `$p` reds exactly this row.
  decide ask "SPLIT MIXED: spec path + build-output path in one command ASKS" "cp docs/superpowers/specs/foo.md app/public/data/x"

  # PER-PATH ADVISORY TWIN (PR #478 review, Minor 3). One case per NON-spec
  # protected path, each asserting three things about the real emitted
  # advisory: it NAMES the matched path, it does NOT fall through regen_hint's
  # generic default (so a protected path added without recording its generator
  # reds the suite instead of shipping an advisory that says nothing), and its
  # additionalContext stays within ADVISORY_MAX_BYTES.
  #
  # The bound is the point of the case, not decoration: this text is injected
  # into the assistant's context on EVERY fire - order 1,000 times over a long
  # working period - so it is the one part of this guard whose SIZE is a
  # standing cost. The first cut measured 970-996 bytes per fire; the trimmed
  # text measures well under the bound below, and a revert to anything like
  # that first cut reds here rather than passing quietly. Raising the bound is
  # a deliberate act with a number attached, which is exactly what was missing
  # when the first cut shipped.
  ADVISORY_MAX_BYTES=700
  for p in "${PROTECTED_PATHS[@]}"; do
    bash_hits_spec_gated_path "$p" >/dev/null && continue
    total=$((total + 1))
    adv=$(printf '{"tool_name":"Bash","tool_input":{"command":"cp /tmp/f %s/probe"}}' "$p" | "$SELF" 2>&1)
    advlen=${#adv}
    case "$adv" in
      *"$p"*) ;;
      *) echo "SELFTEST FAIL [advisory per-path]: the advisory for [$p] does not name the matched path (out: $adv)"; fail=1; continue ;;
    esac
    case "$adv" in
      *"no generator recorded"*) echo "SELFTEST FAIL [advisory per-path]: PROTECTED_PATHS entry [$p] has no regen_hint arm - it falls through to the generic default, so its advisory cannot tell a reader what to run."; fail=1; continue ;;
    esac
    if [ "$advlen" -gt "$((ADVISORY_MAX_BYTES + 100))" ]; then
      echo "SELFTEST FAIL [advisory per-path]: the advisory object for [$p] is $advlen bytes, over the ${ADVISORY_MAX_BYTES}-byte additionalContext budget (+100 for the JSON envelope). Trim it, or raise ADVISORY_MAX_BYTES deliberately."
      fail=1
    fi
  done

  # SPEC_GATED_PATHS CONTAINMENT TWIN. Every spec-gated entry must also be a
  # PROTECTED_PATHS entry: an entry present only in SPEC_GATED_PATHS would be
  # classified but never MATCHED, i.e. a silent allow dressed up as the
  # strictest branch. Asserted against the real bash_hits_protected_path(),
  # not against a second copy of the array.
  for p in "${SPEC_GATED_PATHS[@]}"; do
    total=$((total + 1))
    if ! bash_hits_protected_path "$p" >/dev/null; then
      echo "SELFTEST FAIL [spec containment]: SPEC_GATED_PATHS entry [$p] is not covered by PROTECTED_PATHS - it would be classified as spec-gated but never matched at all (a silent allow)."
      fail=1
    fi
  done
  # ... and the complement must be NON-EMPTY. A SPEC_GATED_PATHS that grew to
  # swallow every protected path would turn the split back into the blanket
  # `ask` it replaced, and every row above would still pass: the advisory rows
  # are all `app/public/...`, so this checks the property directly rather than
  # relying on them.
  total=$((total + 1))
  spec_complement=0
  for p in "${PROTECTED_PATHS[@]}"; do
    if ! bash_hits_spec_gated_path "$p" >/dev/null; then spec_complement=$((spec_complement + 1)); fi
  done
  if [ "$spec_complement" -lt 1 ]; then
    echo "SELFTEST FAIL [spec complement]: every PROTECTED_PATHS entry is spec-gated, so nothing can ever reach the advisory branch - the split is inert and the guard is back to prompting on everything."
    fail=1
  fi

  # ---- mechanism enumeration: every Bash-mediated write mechanism named in
  # #309 (plus a few more of the same shape) must be caught against EACH
  # protected path, not just one. Re-running the original defect class
  # against the new code, per CLAUDE.md ("a fix inherits its bug's blind
  # spot").
  targets=(
    "app/public/data/mask.bin" "app/public/icons/x.svg" "app/public/brand/x.png"
    "app/public/THIRD-PARTY-NOTICES.txt" "docs/superpowers/specs/foo.md"
    "docs/superpowers/plans/foo.md" "app/dist/data/basemap.pmtiles.png"
  )
  mech_fmts=(
    "cp /tmp/f %s" "mv /tmp/f %s" "sed -i s/a/b/ %s" "tee %s"
    "echo x >> %s" "printf x > %s" "dd if=/tmp/f of=%s" "rsync /tmp/f %s"
    "install /tmp/f %s" "perl -i -pe s/a/b/ %s" "touch %s"
  )
  gen=0
  for t in "${targets[@]}"; do
    for mf in "${mech_fmts[@]}"; do
      # shellcheck disable=SC2059  # $mf IS the format string, by construction
      cmd=$(printf "$mf" "$t")
      gen=$((gen + 1))
      total=$((total + 1))
      if ! bash_hits_protected_path "$cmd" >/dev/null; then
        echo "SELFTEST FAIL [mechanism]: not caught -> <<$cmd>>"
        fail=1
      fi
    done
  done

  # ---- production WRAPPER: real hook JSON on stdin through the ACTUAL
  # script (not just the pure function), so a bug in the tool_name dispatch
  # or the JSON parsing is not invisible to this table.
  #
  # $SELF is computed once, near the top of --selftest (right after
  # EXPECTED_CASES) - moved there by #404 so decide()/decide_exempt() above
  # can drive the same production entry point this wrapper does, instead of
  # a parallel bash_decision() twin. See that computation's own comment for
  # the "$0" PATH-lookup rationale; nothing here changed except where it
  # lives.
  # (#309 fix-wave M3): a WANT of "ask" is not enough to prove the Bash
  # path-presence arm actually ran - the file_path arm's own "could not
  # extract a file_path" fallback ALSO answers `ask`, so a fully DISABLED
  # Bash dispatch (mutation: `if [ "$tn" = "NEVER" ]`) left the positive row
  # green, having fallen through to that unrelated fallback. REASON_SUBSTR
  # is required whenever WANT is ask/deny/advisory and must appear in the
  # actual permissionDecisionReason (or, for an advisory, its
  # additionalContext), not just match the decision keyword - pass "" only for
  # allow rows, which emit nothing at all and so have no text to check.
  wrapper_check() { # WANT(ask|deny|allow|inert|advisory) REASON_SUBSTR DESC JSON
    local want="$1" reason_substr="$2" desc="$3" json="$4" out rc decision
    total=$((total + 1))
    # (#421 review, Major 2) - same rc-before-decision discipline as
    # decide()/decide_exempt() above.
    out=$(printf '%s' "$json" | "$SELF" 2>&1); rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "SELFTEST FAIL [invocation]: $desc -> \$SELF exited $rc, not 0 - this is NOT a decision, it is a dead or crashing invocation (out: $out)"
      fail=1
      return
    fi
    decision=$(hook_decision "$out")
    if [ "$decision" != "$want" ]; then
      echo "SELFTEST FAIL [wrapper]: $desc -> got [$decision] want [$want] (out: $out)"
      fail=1
    fi
    if [ -n "$reason_substr" ]; then
      case "$out" in
        *"$reason_substr"*) ;;
        *)
          echo "SELFTEST FAIL [wrapper reason]: $desc -> reason missing [$reason_substr] (out: $out)"
          fail=1
          ;;
      esac
    fi
  }
  wrapper_check advisory "artifact-guard ADVISORY" "Bash cp through the wrapper"      '{"tool_name":"Bash","tool_input":{"command":"cp /tmp/f app/public/data/mask.bin"}}'
  wrapper_check allow ""                        "Bash git status through the wrapper" '{"tool_name":"Bash","tool_input":{"command":"git status"}}'
  # (#309 fix-wave m2): a missing/empty Bash command now asks (see DESIGN) -
  # was `allow` before the m2 fix; the reason must be the Bash arm's OWN
  # "could not extract a Bash command" text, not the unrelated file_path
  # arm's "could not extract a file path" (which would indicate the Bash
  # dispatch never ran at all - the same M3 blind spot, checked here too).
  # WANT is `inert`, not `ask` (#421 review, Minor 3): production answers a
  # bare `permissionDecision:"ask"` for this parse-failure fallback too, and
  # hook_decision() now separates that reason out - this row is the one
  # place in the suite that SHOULD land there, so it is the more honest
  # assertion.
  wrapper_check inert "could not extract a Bash command" "Bash with no command field" '{"tool_name":"Bash","tool_input":{}}'
  # Regression guard: the ORIGINAL Edit|Write behavior must be byte-for-byte
  # unchanged now that this script serves a second matcher.
  wrapper_check deny  "Generated artifact"      "Edit deny arm unaffected"            '{"tool_name":"Edit","tool_input":{"file_path":"app/public/data/mask.bin"}}'
  wrapper_check ask   "source of truth"         "Edit specs arm unaffected"           '{"tool_name":"Edit","tool_input":{"file_path":"docs/superpowers/specs/foo.md"}}'
  # (#405) mutation-checkable: deleting the new plans/ arm (or narrowing its
  # pattern) reds this row - drives the REAL production wrapper, not a bare
  # pattern match on the case statement in isolation.
  wrapper_check ask   "tracks implementation plans" "Edit plans arm (#405: was a silent allow)" '{"tool_name":"Edit","tool_input":{"file_path":"docs/superpowers/plans/foo.md"}}'
  # (#421 review, Major 1) mutation-checkable: pins the catch-all arm, which
  # is what actually matches the Bash arm's ANCESTOR coverage - a file under
  # docs/superpowers/ that is in NEITHER named child (specs/, plans/) was
  # still a silent allow before that arm existed. Deleting the catch-all
  # arm (or narrowing its pattern back to only the two named children) must
  # red this row.
  wrapper_check ask   "guarded as a whole" "Edit docs/superpowers/ catch-all (#421: was a silent allow one path over)" '{"tool_name":"Edit","tool_input":{"file_path":"docs/superpowers/notes.md"}}'
  wrapper_check allow ""                        "Edit unrelated file unaffected"      '{"tool_name":"Write","tool_input":{"file_path":"app/src/App.tsx"}}'
  wrapper_check allow ""                        "Edit icon.svg exception unaffected"  '{"tool_name":"Edit","tool_input":{"file_path":"app/public/icons/icon.svg"}}'
  # Old-shaped payload with no tool_name at all (pre-#309 test shape) must
  # still hit the file_path arm, not silently fall through as "not Bash".
  wrapper_check deny  "Generated artifact"      "no tool_name, file_path present"     '{"tool_input":{"file_path":"app/public/data/mask.bin"}}'
  # #309 follow-up: the read-only exemption through REAL hook JSON, so a bug
  # in the production dispatch (rather than in the pure predicate) cannot
  # hide from this table. The first is the maintainer's reported case; the
  # second is the same verb and the same path plus a redirect, i.e. the
  # fail-open shape a first-word-only allowlist would have suppressed.
  wrapper_check allow ""                        "EXEMPT: stat through the wrapper"    '{"tool_name":"Bash","tool_input":{"command":"stat app/public/data/mask.bin"}}'
  wrapper_check advisory "artifact-guard ADVISORY" "stat + redirect still fires"      '{"tool_name":"Bash","tool_input":{"command":"stat app/public/data/mask.bin > /tmp/x"}}'
  # (#530) RETITLED: this row's command is `sed -i`, and `sed` is now ON the
  # allowlist, so "non-allowlisted verb" described the file's pre-#530 reason
  # and would have been left asserting the opposite of what the code does.
  # What it pins through REAL hook JSON is unchanged: a verb-scoped
  # disqualifier's rejection reaches the production dispatch, not merely the
  # pure predicate.
  wrapper_check advisory "artifact-guard ADVISORY" "verb-scoped disqualifier (sed -i) still fires through the wrapper" '{"tool_name":"Bash","tool_input":{"command":"sed -i s/x/y/ app/public/data/mask.bin"}}'

  # TWIN CHECK (#388 review, Finding 2): the user-facing reason string claims
  # to name the exempt set exhaustively. It is DERIVED from READONLY_VERBS,
  # so it cannot drift by hand — but a future refactor could break the
  # derivation, so assert the emitted production JSON really does contain
  # every array entry. Fails CLOSED: an empty/absent reason reds every row
  # rather than passing vacuously (same shape as useBannerHeight.test.ts's
  # CSS<->TS check, CLAUDE.md).
  # The needle must be matched against the emitted VERB LIST ONLY, never
  # against the whole reason (#388 re-review, Minor 6). Matching the whole
  # string made the `ls` case VACUOUS: the reason's own prose contains
  # "which aLSo matches", so `*"ls"*` hit the prose and that case passed even
  # with the derived list empty - measured, 13 of 14 red instead of 14. That
  # is the #216 class living inside the very check written to prevent it.
  #
  # So: extract the parenthesised list out of the PRODUCTION output first,
  # then match each verb slash-delimited within it. Extracting from the
  # emitted JSON (rather than re-deriving the list here) is what keeps this a
  # twin check at all - a needle and a haystack both built from
  # READONLY_VERBS would agree with each other no matter what production
  # actually printed, which is a tautology, not a test.
  # (2026-08-09) the probe command MOVED from app/public/data to the spec
  # tree: the verb list lives in the `ask` reason, and after the advisory
  # split a build-output path no longer produces one - probing the old command
  # would find no "no-write verb (" marker and trip the fail-closed extraction
  # guard below on every run.
  reason_out=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"cp /tmp/f docs/superpowers/specs/foo.md"}}' | "$SELF" 2>/dev/null)
  # Fail CLOSED on extraction: if the marker is gone (reason reworded,
  # renamed, or not emitted at all) say so loudly rather than letting the
  # `#`/`%%` expansions below silently yield a nonsense haystack that might
  # still match something. Same discipline as useBannerHeight.test.ts's
  # explicit not-null assertion before its value comparison.
  total=$((total + 1))
  case "$reason_out" in
    *"no-write verb ("*")"*) ;;
    *)
      echo "SELFTEST FAIL [reason twin]: could not find the 'no-write verb (...)' list in the emitted permissionDecisionReason - extraction is broken, so the per-verb checks below prove nothing (out: $reason_out)"
      fail=1
      ;;
  esac
  emitted_list=${reason_out#*no-write verb (}
  emitted_list=${emitted_list%%)*}
  for v in "${READONLY_VERBS[@]}"; do
    total=$((total + 1))
    case "/$emitted_list/" in
      *"/$v/"*) ;;
      *)
        echo "SELFTEST FAIL [reason twin]: READONLY_VERBS entry [$v] is missing from the emitted verb list [$emitted_list]"
        fail=1
        ;;
    esac
  done

  # ADVISORY SHAPE TWIN (2026-08-09): parse the emitted advisory with a REAL
  # JSON parser and assert `permissionDecision` is ABSENT - not merely that it
  # is not "ask"/"deny". This is the explicit half of the rule hook_decision()
  # enforces structurally; both are kept deliberately. Setting the key to
  # "allow" is the tempting spelling and the wrong one: omitting it defers to
  # the user's own permission system, while "allow" BYPASSES that system and
  # auto-approves commands the user's own rules would still question - a
  # change to their configuration that this hook has no mandate to make.
  # Checked at BOTH nesting levels, since a stray top-level `permissionDecision`
  # is the other way the key could reappear.
  # Fails CLOSED with neither jq nor python3 available: the production script
  # cannot parse its own input in that environment either, so a silent skip
  # here would be a hole, not a convenience.
  total=$((total + 1))
  adv_out=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"cp /tmp/f app/public/data/mask.bin"}}' | "$SELF" 2>/dev/null)
  adv_shape=""
  adv_parser=0
  if command -v jq >/dev/null 2>&1; then
    adv_parser=1
    adv_shape=$(printf '%s' "$adv_out" | jq -r '[(.hookSpecificOutput|has("additionalContext")),(.hookSpecificOutput|has("permissionDecision")),(has("permissionDecision"))]|join(",")' 2>/dev/null)
  elif command -v python3 >/dev/null 2>&1; then
    adv_parser=1
    adv_shape=$(printf '%s' "$adv_out" | python3 -c "import json,sys;d=json.load(sys.stdin);h=d.get('hookSpecificOutput',{});print(','.join('true' if b else 'false' for b in ('additionalContext' in h,'permissionDecision' in h,'permissionDecision' in d)))" 2>/dev/null)
  else
    echo "SELFTEST FAIL [advisory shape]: neither jq nor python3 is available, so the advisory JSON cannot be parsed - this check fails closed rather than skipping."
    fail=1
  fi
  # An EMPTY adv_shape with a parser present means the parse itself failed
  # (unparseable output, or no advisory emitted at all) - that must red too,
  # not slip through as "nothing to compare".
  if [ "$adv_parser" -eq 1 ] && [ "$adv_shape" != "true,false,false" ]; then
    echo "SELFTEST FAIL [advisory shape]: expected [has additionalContext, has nested permissionDecision, has top-level permissionDecision] = true,false,false but parsed [$adv_shape] (out: $adv_out)"
    fail=1
  fi

  # Positive assertion, not `-ne` (PR #350 review round 2, R2-1): see
  # classify-docs-only.sh's matching comment for why `-ne` with an empty or
  # non-numeric RHS fails OPEN (status 2 from `[`, not 1) and this form
  # doesn't.
  if ! [ "$total" -eq "$EXPECTED_CASES" ] 2>/dev/null; then
    echo "SELFTEST FAILURES: ran $total cases, expected ${EXPECTED_CASES:-<unset/empty>} - a case was skipped or silently dropped"
    exit 1
  fi
  if [ "$fail" -eq 0 ]; then
    echo "generated: ${gen} mechanism x protected-path combinations"
    echo "SELFTEST OK"
  fi
  exit "$fail"
fi

# ---- production path ----
IN=$(cat)

[ -n "$IN" ] || {
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"artifact/spec guard received empty tool input - protection is inert."}}'
  exit 0
}

# #309: dispatch on tool_name FIRST. tool_name=="Bash" takes the path-presence
# arm (see DESIGN above); everything else (Edit, Write, or an old-shaped
# payload with no tool_name at all) falls through unchanged to the original
# file_path logic below.
tn=$(printf '%s' "$IN" | jq -r '.tool_name // empty' 2>/dev/null) \
  || tn=$(printf '%s' "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tool_name') or '')" 2>/dev/null) \
  || {
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"artifact/spec guard could not parse tool input (malformed JSON, or jq/python3 unavailable) - protection is inert; install jq."}}'
    exit 0
  }

if [ "$tn" = "Bash" ]; then
  cmd=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null) \
    || cmd=$(printf '%s' "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tool_input',{}).get('command') or '')" 2>/dev/null) \
    || {
      echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"artifact/spec guard could not parse tool input (malformed JSON, or jq/python3 unavailable) - protection is inert; install jq."}}'
      exit 0
    }

  # #309 fix-wave m2: a missing/empty command is the SAME epistemic state as
  # a missing file_path below (no input was ever extracted) - give it the
  # same answer, `ask`, rather than silently falling through to a substring
  # match against an empty string (which can never hit and would allow).
  [ -n "$cmd" ] || {
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"artifact/spec guard could not extract a Bash command from the tool input - protection is inert."}}'
    exit 0
  }

  if p=$(bash_hits_protected_path "$cmd"); then
    # #309 follow-up: suppress ONLY a provably-single read-only command (see
    # DESIGN). Everything else - including anything this predicate cannot
    # prove - falls through to the split below.
    if bash_is_provably_readonly "$cmd"; then
      exit 0
    fi
    # 2026-08-09 split (DESIGN, "TWO OUTCOMES FOR A NON-EXEMPT HIT"): the
    # spec tree keeps the blocking prompt; every other protected path gets a
    # non-blocking advisory. The spec check is its own pass, so a command
    # naming BOTH still asks (PROTECTED_PATHS' order would otherwise decide
    # it).
    if sp=$(bash_hits_spec_gated_path "$cmd"); then
      p=$sp
    else
      bash_advisory "$p"
      exit 0
    fi
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Bash command mentions spec path '"$p"' (docs/superpowers/ is the user-approved source-of-truth spec/plan tree, matched here together with its ancestor; CLAUDE.md makes changing it a MAIN-SESSION act, which is what this prompt enforces). This is the ONLY protected family that still prompts - the committed build outputs (app/public/{data,icons,brand}/, THIRD-PARTY-NOTICES.txt, .pmtiles) now get a non-blocking advisory instead, since a drifted artifact can be regenerated and a rewritten spec cannot. This guard checks whether the path STRING appears anywhere in the Bash command; it does NOT parse shell syntax to work out whether the command is really a write. The one exception is a command PROVEN read-only - a single simple command whose first word is a no-write verb ('"$(readonly_verbs_sentence)"') with no pipe, separator, substitution, expansion or escape anywhere in it, and no redirect other than the inert ones (the fd-dups and the /dev/null discards, which write no file and are stripped before that check) - which is suppressed silently. Two of those verbs, grep and sed, do have a write surface and so carry an ADDITIONAL per-verb condition (#530): grep must name none of the ugrep options the Claude Code shim intercepts, and sed must use only -n/-E/-r-class read-only flags with a single bare p/d/q/=/n/N script command under at most one address. The exemption also applies only up to a length limit, so that a very large input cannot stall this hook past its time budget and have the resulting silence read as approval. This command is not that, so it asks: it uses a verb outside that set, fails one of those two per-verb conditions, contains a write-capable construct, or is longer than that limit. Confirm intent before proceeding."}}'
  fi
  exit 0
fi

f=$(printf '%s' "$IN" | jq -r '.tool_input.file_path // empty' 2>/dev/null) \
  || f=$(printf '%s' "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tool_input',{}).get('file_path') or '')" 2>/dev/null) \
  || {
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"artifact/spec guard could not parse tool input (malformed JSON, or jq/python3 unavailable) - protection is inert; install jq."}}'
    exit 0
  }

[ -n "$f" ] || {
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"artifact/spec guard could not extract a file path from the tool input - protection is inert."}}'
  exit 0
}

case "$f" in
  *app/public/icons/icon.svg)
    # Hand-authored SOURCE, not an output — see the B1 exception note above.
    ;;
  *.bin|*.pmtiles|*.pmtiles.png|*app/public/data/*|*app/public/icons/*|*app/public/brand/*|*app/public/THIRD-PARTY-NOTICES.txt)
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Generated artifact: app/public/{data,icons,brand}/ are committed pipeline outputs (regenerate via npm --prefix pipeline run polars|harbors|seamarks|mask|icons) and app/public/THIRD-PARTY-NOTICES.txt is a generated dependency manifest (regenerate via npm --prefix app run notices) - never hand-edit, always regenerate. Exception: app/public/icons/icon.svg is a hand-authored source, not covered by this deny."}}'
    ;;
  *docs/superpowers/specs/*)
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"docs/superpowers/specs/ is the user-approved source of truth - CLAUDE.md forbids silently deviating from it. Confirm the user wants the spec itself changed before editing."}}'
    ;;
  *docs/superpowers/plans/*)
    # #405: this arm used to not exist at all, so an Edit/Write to a file
    # under docs/superpowers/plans/ fell through to the unguarded default
    # (silent allow) even though the Bash arm's PROTECTED_PATHS ancestor
    # entry ("docs/superpowers") already covers a Bash-mediated write to the
    # same file. Adds a tailored ask arm, same decision as docs/superpowers/
    # specs/ above - the Bash arm and its docs/superpowers PROTECTED_PATHS
    # entries are unchanged. CORRECTED (#421 review, Major 1): an earlier
    # revision of this comment said this arm "WIDENS this arm to match [the
    # Bash arm]" - that overstated it. Two named children (specs/, plans/)
    # still do not match an ANCESTOR entry's coverage of everything under
    # it, present and future; the catch-all arm right below this one is what
    # actually closes that gap, this arm alone does not.
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"docs/superpowers/plans/ tracks implementation plans and is guarded the same way as docs/superpowers/specs/ (#405). Confirm the user wants a plan doc changed before editing."}}'
    ;;
  *docs/superpowers/*)
    # #421 review, Major 1: docs/superpowers/specs/ and .../plans/ above are
    # named children with their own tailored reason text; this catch-all,
    # mirroring the Bash arm's ANCESTOR PROTECTED_PATHS entry
    # ("docs/superpowers"), is what actually matches that arm's coverage -
    # the two named arms alone do not, since they only enumerate today's
    # two subdirectories. `case` takes the first match, so specs/ and
    # plans/ keep their own text and everything else under docs/superpowers/
    # (a future third subdirectory, or a file directly in it) stops being a
    # silent allow instead of moving the #405 gap one path over. Declining
    # to replace all three of these arms with a data-driven loop over
    # PROTECTED_PATHS was considered and explicitly rejected: this arm maps
    # to `ask`, the app/public/{data,icons,brand}/THIRD-PARTY-NOTICES.txt
    # arm above maps to `deny`, plus there is an exception (icon.svg) and
    # two extension-only patterns (*.bin, *.pmtiles.png) with no
    # PROTECTED_PATHS entry at all - a flat loop would need PROTECTED_PATHS
    # restructured into (path, decision) pairs, which changes the Bash arm's
    # own data and is squarely against #405's "the Bash arm is left
    # UNCHANGED".
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"docs/superpowers/ is the user-approved spec/plan tree and is guarded as a whole (#405/#421) - CLAUDE.md forbids silently deviating from docs/superpowers/specs/, and the same caution applies to the rest of the tree. Confirm the user wants this file changed before editing."}}'
    ;;
esac
