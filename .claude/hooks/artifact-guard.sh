#!/usr/bin/env bash
# PreToolUse Edit|Write guard for generated pipeline artifacts and the
# source-of-truth spec docs — SailCommand #274 (extracted from the inline
# one-liner it replaces; the specs `ask` branch is unchanged from before).
# Fix wave on PR #305 review (B1/B2/M1/M2+M4/M5): see below for what changed
# and why.
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
#     if it appears ANYWHERE in the Bash `command` string, emit `ask`. That
#     is the entire rule — nothing else.
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
#         suppress  <=>  first word is in READONLY_VERBS (exact match)
#                   AND  the command string contains NO write-capable
#                        construct (see WRITE_CAPABLE_* below)
#
#     Both halves are load-bearing and neither is sufficient. `cat f >
#     protected` fails the second half; `sed -i s/x/y/ protected` fails the
#     first. Everything not PROVABLY safe still asks — an unrecognised verb,
#     an unparseable shape, any doubt at all. This is the guard-asymmetry
#     principle (CLAUDE.md) held to: over-firing costs a stray prompt,
#     under-firing costs a silently drifted artifact, so the exemption
#     suppresses only shapes it can prove, and every ambiguity resolves to
#     ask. Crucially, this is NOT the shell segmentation that got PR #233
#     closed: there is no attempt to split a command line into commands or
#     to classify which one "really" runs. The predicate is the opposite —
#     it REFUSES to reason about any string that could contain more than one
#     command, and only then reads the single leading word.
#   - WHY THAT CONJUNCTION IS SOUND (the argument the whole exemption rests
#     on, stated so it can be attacked): with `;` `&` `|` newline/CR
#     backtick `$` `\` `(` `)` `{` `}` all disqualifying, the surviving
#     string cannot contain a command separator, a redirect, a substitution,
#     an expansion, or an escape — so it is ONE simple command whose
#     executable is its first word, and no expansion can introduce a second.
#     The first word is then compared by EXACT equality against a small set
#     of verbs that have no write capability at all (not "usually don't" —
#     none of them accepts an output-file option). A path-qualified spelling
#     (`/usr/bin/stat`) deliberately does NOT match: it could be any
#     executable, including a local script named `stat`.
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
#     disqualifies. `grep` was therefore REMOVED (see VERB SELECTION).
#   - HOW TO CHECK IT, and the trap that makes the obvious check lie: run
#     `type <verb>` in the REAL Claude Code Bash tool and paste what you saw
#     into your PR. Do NOT measure it from inside a script (`bash probe.sh`
#     containing `type -t grep`) — a non-interactive child shell does not
#     inherit non-exported functions, so the shim VANISHES and every verb
#     reports a reassuring `file`. That exact false negative was produced
#     while fixing this (`bash script.sh` said `file`; the same check run
#     directly said `function`). Measured directly, 2026-08-05, all 14
#     current entries: `test` and `[` are `builtin` (fine — a bash builtin
#     runs no external program and has no write capability), every other
#     entry is `file`, and NOTHING is a function or alias.
#   - DO NOT teach this guard about shims, functions or aliases. Detecting
#     them is the shell-parsing road PR #233 was closed over. The correct
#     response to a shimmed verb is to REMOVE IT FROM THE ALLOWLIST — a
#     smaller allowlist and an honest comment, never a smarter parser.
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
#       * `grep` is EXCLUDED, and it is the entry this whole design nearly
#         got wrong (#388 review, Finding 1). The reasoning that first
#         included it — "GNU grep has no output-file option" — described a
#         program that IS NOT THE ONE RUNNING: `grep` is a Claude Code shell
#         FUNCTION shimming to ugrep (see the NAMED PRECONDITION above).
#         No write is reachable through it TODAY — the shim intercepts
#         `--filter`/`--pager`/`--view`/`--save-config` and falls back to
#         `command grep`, ugrep refuses long-option abbreviations, `--index`
#         is read-only, and no `.ugrep` auto-loads under the `ugrep` exec
#         name — but that safety would rest entirely on an UNVERSIONED
#         EXTERNAL shim's intercept list that this repo neither controls,
#         pins, nor tests. A Claude Code upgrade could widen a security
#         guard with nothing here noticing. An exemption whose soundness
#         depends on someone else's unpinned implementation detail is not an
#         exemption this guard can carry.
#       * `file` is EXCLUDED despite looking as inert as `stat`, and this is
#         the non-obvious one: `file -C -m X` COMPILES the magic file and
#         WRITES `X.mgc`. MEASURED, not reasoned — `file -C -m magic.txt`
#         in an empty temp dir exited 0 and created `magic.txt.mgc` (752
#         bytes). Keeping `file` would need `-C` in the disqualifying token
#         list, an odd token that also over-fires on `ls -C`; excluding the
#         verb is the smaller and more obviously-correct rule.
#     `tail` is absent only because nothing asked for it — it is as safe as
#     `head`; add it with its own rows if it becomes noise.
#   - ACCEPTED RESIDUAL OVER-FIRES of the exemption (named so they read as
#     decisions, not oversights): `!` is disqualified, so `test ! -f
#     <protected>` — a legitimate read-only shape — still asks; `#` is
#     disqualified, so a trailing comment still asks; `$` is disqualified
#     wholesale, so `stat "$HOME/<protected>"` still asks. Each is the safe
#     direction and none has a cheap sound alternative (a `#` cannot be told
#     from a filename character without parsing, which is the thing this
#     guard refuses to do).
#   - A command that names a protected path and is NOT provably read-only
#     still asks, including one that merely mentions the path in prose
#     (`echo mentions <protected>`) — `echo` is not on the verb allowlist.
#     That over-fire is unchanged and still deliberate.
#   - `ask`, NEVER `deny`, on this Bash arm — this is the guard-asymmetry
#     principle (CLAUDE.md) applied in the OTHER direction from the Edit|
#     Write arm above: that arm can `deny` because a file_path IS the write
#     target, unambiguously. A Bash command string cannot reliably be told
#     apart from a read (this guard does not parse shell syntax, by design,
#     above) so `deny` here would routinely HALT legitimate read-only
#     commands — the wrong failure mode for a guard whose over-firing costs
#     one stray prompt and whose under-firing costs a silently drifted
#     artifact. Accepted cost, stated here on purpose: any Bash command
#     merely mentioning a protected path's string prompts for confirmation,
#     even when the command is provably read-only.
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
#     PreToolUse entry) — adding `app/public` here would turn that routine
#     command into a prompt on every e2e cycle, which is the exact "a guard
#     that always asks trains you to click through" erosion CLAUDE.md warns
#     about for `premerge-verify`. Bare `app` is far worse: it is a substring
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
#     touching icon.svg by path still asks (Bash-mediated edits to that file
#     get no free pass here, unlike the Edit/Write tool path).
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
#   2. Variable indirection: `D=app/public/data; cp /tmp/f $D/mask.bin` — the
#      literal command string never contains the protected substring.
#   3. Programmatic path construction: `python3 -c "import os;
#      open(os.path.join('app','public','data','mask.bin'),'w')"` — contrast
#      with the SAME target spelled as a literal string, which correctly
#      asks; the two differ only in how the path is built.
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
#      READONLY_VERBS or WRITE_CAPABLE_* can widen, so any such change must
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

# --- read-only exemption (#309 follow-up; see DESIGN above for the full
# rationale and the soundness argument). Three data sets, each with its own
# job; the predicate below requires ALL of them to be satisfied.

# Verbs with NO write capability whatsoever - not "usually read-only", but
# "has no option that creates or modifies a file". Compared by EXACT equality
# against the command's first word. `find`, `file` and `grep` are DELIBERATELY
# absent (DESIGN explains all three, each with a measurement).
#
# BEFORE ADDING A VERB: run `type <verb>` in the real Claude Code Bash tool
# and paste the output in your PR - a verb that is a shell FUNCTION or ALIAS
# breaks this predicate's soundness argument outright, and measuring it from
# inside a script silently reports the wrong answer. See the NAMED
# PRECONDITION in DESIGN above. Also confirm the verb has no output-file or
# command-executing option (`file` looked inert and writes `X.mgc`).
READONLY_VERBS=(
  stat ls wc du head cat sha256sum md5sum
  test "[" readlink realpath dirname basename
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

# Pure function: is $1 (a Bash `command` string) PROVABLY a single read-only
# command? Returns 0 only when it can be proven so; returns 1 for everything
# else including every shape it does not understand. Never the other way
# round - "I cannot tell" and "this is a write" get the same answer.
bash_is_provably_readonly() {
  local cmd="$1" c t v verb rest
  local nl=$'\n' cr=$'\r'

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
  # which matches nothing below and therefore asks.
  local IFS=$' \t'
  read -r verb rest <<<"$cmd"

  for v in "${READONLY_VERBS[@]}"; do
    [ "$verb" = "$v" ] && return 0
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
readonly_verbs_sentence() {
  local out="" v
  for v in "${READONLY_VERBS[@]}"; do
    out="${out}${out:+/}$v"
  done
  printf '%s' "$out"
}

# The Bash arm's COMPLETE decision, as one pure function so the selftest can
# drive exactly what production does. Prints "ask" or "allow".
bash_decision() {
  local cmd="$1"
  bash_hits_protected_path "$cmd" >/dev/null || { printf 'allow'; return 0; }
  if bash_is_provably_readonly "$cmd"; then printf 'allow'; return 0; fi
  printf 'ask'
}

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
  EXPECTED_CASES=195

  # check WANT DESC CMD - drives the pure bash_hits_protected_path() function
  # directly (WANT is "ask" or "allow"). This tests PATH COVERAGE ONLY, which
  # is deliberate and must stay that way (#309 read-only-exemption review):
  # several rows below use `cat <path>` purely as a carrier to pin a
  # PROTECTED_PATHS decision (the B1 trailing-slash removal, the N1 bounding
  # rows). `cat` is now on READONLY_VERBS, so rebinding `check` to the full
  # decision would flip those rows to `allow` and silently stop them pinning
  # anything a PROTECTED_PATHS mutation could red. New exemption rows use
  # `decide` below instead; no existing row's expectation changed.
  check() {
    local want="$1" desc="$2" cmd="$3" got
    total=$((total + 1))
    if bash_hits_protected_path "$cmd" >/dev/null; then got=ask; else got=allow; fi
    if [ "$got" != "$want" ]; then
      echo "SELFTEST FAIL: $desc -> got [$got] want [$want] (cmd: $cmd)"
      fail=1
    fi
  }

  # decide WANT DESC CMD - drives bash_decision(), i.e. the Bash arm's
  # COMPLETE decision (path presence AND the read-only exemption), which is
  # exactly what the production path computes. Every row for the #309
  # follow-up exemption uses this.
  decide() {
    local want="$1" desc="$2" cmd="$3" got
    total=$((total + 1))
    got=$(bash_decision "$cmd")
    if [ "$got" != "$want" ]; then
      echo "SELFTEST FAIL [decision]: $desc -> got [$got] want [$want] (cmd: $cmd)"
      fail=1
    fi
  }

  nl=$'\n'
  cr=$'\r'

  # --- POSITIVE: a real Bash-mediated write to a protected path must ask.
  # Each row isolates exactly ONE shell construct plus the path (#216
  # one-trigger-per-row rule) - no extra characters that could independently
  # explain a pass.
  check ask "sed -i in place edit"      "sed -i s/x/y/ app/public/data/mask.bin"
  check ask "cp into protected dir"     "cp /tmp/f app/public/data/mask.bin"
  check ask "tee into protected dir"    "tee app/public/data/mask.bin"
  check ask "> redirect"                "echo x > app/public/data/mask.bin"
  check ask "heredoc redirect"          "cat > app/public/data/mask.bin <<EOF${nl}x${nl}EOF"
  check ask "path after &&"             "git status && cat app/public/data/mask.bin"
  check ask "path after ;"              "echo hi; cp /tmp/f app/public/data/mask.bin"
  # shellcheck disable=SC2016  # literal $( ) is the test input, not an expansion
  check ask 'path inside $( )'          'echo "$(cat app/public/data/mask.bin)"'

  # --- PATH MATCHING of a read-only mention. Both rows pin that the PATH is
  # seen; only the second is still an accepted over-fire at the DECISION
  # level. `grep -n foo <path>` now SUPPRESSES (#309 follow-up read-only
  # exemption) - its decision-level twin is in the exemption block below,
  # and this row's job is now solely to keep the path match pinned.
  check ask "path match: read-only grep (decision: allow, see exemption block)" "grep -n foo app/public/data/mask.bin"
  check ask "OVER-FIRE (accepted): prose mention"  "echo mentions app/public/data/mask.bin in passing"

  # --- NEGATIVE: no protected path named anywhere.
  check allow "git status"              "git status"
  check allow "npm run build"           "npm run build"
  check allow "unrelated source file"   "cat app/src/App.tsx"
  check allow "empty command"           ""

  # --- POSITIVE (#309 fix-wave B1): a write to the protected directory's
  # BARE NAME, not something inside it, must still ask. Measured ALLOW
  # before this fix (trailing slash on directory entries meant only a path
  # INSIDE the directory ever matched) - this is the guard's core purpose,
  # not a redesign.
  check ask "B1: cp -r replaces the directory itself"   "cp -r /tmp/d app/public/data"
  check ask "B1: rsync -a writes into the bare dir"     "rsync -a /tmp/d/ app/public/icons"
  check ask "B1: mv stashes the directory itself"       "mv app/public/data /tmp/stash"
  check ask "B1: write to the bare specs directory"     "cp /tmp/f docs/superpowers/specs"

  # --- POSITIVE (#309 fix-wave M4): ancestor coverage for docs/superpowers -
  # no collision found with any routine command, so added outright (see
  # DESIGN above for why app/public and bare app are NOT given the same
  # treatment).
  check ask "M4: mv the docs/superpowers ancestor"      "mv docs/superpowers /tmp/stash"
  check ask "M4: find -delete under the ancestor"       "find docs/superpowers -name *.md -delete"

  # --- NEGATIVE (#309 fix-wave N1): bounding row for the docs/superpowers
  # ancestor entry - a real path OUTSIDE it that shares only the "docs/"
  # prefix must not match. Without this row, over-broadening the entry to
  # bare "docs" (a one-character typo) reds nothing; measured, see DESIGN.
  check allow "N1 near-miss: docs outside superpowers" "cat docs/security-assurance-case.md"

  # --- POSITIVE (#309 fix-wave M1): .pmtiles is now protected as a bare
  # substring - no noise source found (contrast the .bin residual row
  # below). .pmtiles.png files are covered too, via SUBSUMPTION, not a
  # second entry (see DESIGN - N2) - this row exercises that subsumption,
  # not an independent .pmtiles.png entry.
  check ask "M1: .pmtiles extension"                              "cp /tmp/f app/dist/data/basemap.pmtiles"
  check ask "M1: .pmtiles.png extension (via .pmtiles subsumption)" "cp /tmp/f app/dist/data/basemap.pmtiles.png"

  # --- NEGATIVE (#309 fix-wave N1): bounding row for the .pmtiles entry - a
  # real command using an unrelated ".py" extension must not match. Without
  # this row, over-broadening the entry to bare ".p" reds nothing; measured,
  # see DESIGN.
  check allow "N1 near-miss: .py is not .pmtiles" "python3 pipeline/verify_mask.py"

  # --- RESIDUAL (documented, not fixed - see DESIGN and the "KNOWN
  # SILENT-ALLOW PATHS" list above): the .bin extension and the app/public
  # and app ancestors are deliberately NOT protected. Pinned as ALLOW here so
  # a future accidental narrowing (or widening) of PROTECTED_PATHS is caught
  # either way, not just silently drifted.
  check allow "RESIDUAL (documented): bare .bin outside protected dirs" "cp /tmp/f app/dist/data/mask.bin"
  check allow "RESIDUAL (documented): bare app/public ancestor"         "find app/public -name *.bin -delete"
  check allow "RESIDUAL (documented): bare app ancestor"                "find app -name mask.bin -delete"

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
  check ask "OVER-FIRE (accepted): sibling database/ shares the data prefix"   "cat app/public/database/config.json"
  check ask "OVER-FIRE (accepted): sibling iconsets/ shares the icons prefix"  "cat app/public/iconsets/foo.svg"
  check ask "OVER-FIRE (accepted): sibling specs-old/ (also via ancestor)"    "cat docs/superpowers/specs-old/draft.md"
  check allow "sibling file: NOTICES-OLD.txt" "cat app/public/THIRD-PARTY-NOTICES-OLD.txt"

  # --- ACCEPTED OVER-FIRE (bare filename, no trailing delimiter to bound it):
  # a literal file path has no natural "next char must be /" boundary the way
  # a directory does, so a longer filename sharing the same PREFIX genuinely
  # does contain the protected string and is correctly MATCHED - not a bug,
  # but worth pinning so it isn't mistaken for one later. (Same carrier-verb
  # note as the block above: at the DECISION level this `cat` now suppresses.)
  check ask "path match: NOTICES.txt.bak" "cat app/public/THIRD-PARTY-NOTICES.txt.bak"

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
  # Each MUST-ASK row carries exactly ONE reason to ask beyond the path, so
  # it isolates the clause it pins. Where two conditions cannot be separated
  # (`$(` necessarily contains both `$` and `(`), the row says so and the
  # separable halves get their own rows.

  # --- MUST SUPPRESS: one allowlisted verb, one protected path, nothing else.
  # The first row IS the maintainer's reported case.
  decide allow "EXEMPT: stat (the reported case)"   "stat app/public/data/mask.bin"
  decide allow "EXEMPT: ls"                         "ls -la app/public/icons"
  decide allow "EXEMPT: wc"                         "wc -c app/public/THIRD-PARTY-NOTICES.txt"
  decide allow "EXEMPT: du"                         "du -sh app/public/brand"
  decide allow "EXEMPT: head"                       "head -n 5 docs/superpowers/specs/foo.md"
  decide allow "EXEMPT: cat"                        "cat app/public/data/mask.bin"
  decide allow "EXEMPT: sha256sum"                  "sha256sum app/public/data/mask.bin"
  decide allow "EXEMPT: md5sum"                     "md5sum app/public/data/mask.bin"
  decide allow "EXEMPT: test"                       "test -f app/public/data/mask.bin"
  decide allow "EXEMPT: [ (bracket form of test)"   "[ -f app/public/data/mask.bin ]"
  decide allow "EXEMPT: readlink"                   "readlink app/public/data/mask.bin"
  decide allow "EXEMPT: realpath"                   "realpath app/public/data/mask.bin"
  decide allow "EXEMPT: dirname"                    "dirname app/public/data/mask.bin"
  decide allow "EXEMPT: basename"                   "basename app/public/data/mask.bin"
  decide allow "EXEMPT: .pmtiles entry, not a dir"  "stat app/dist/data/basemap.pmtiles"
  decide allow "EXEMPT: leading whitespace ignored" "  stat app/public/data/mask.bin"
  # Behaviour change stated rather than left to be inferred: the four
  # `cat`-carrier over-fires pinned in the path-matching blocks above no
  # longer reach the user, because the command that produces each is a bare
  # `cat`. All four get a decision-level twin (#388 review, Finding 4 - three
  # of them had none, leaving the user-visible half of the change unpinned:
  # nothing would have failed if one started prompting again, which is the
  # regression this PR exists to prevent).
  decide allow "EXEMPT: sibling database/ read no longer prompts"  "cat app/public/database/config.json"
  decide allow "EXEMPT: sibling iconsets/ read no longer prompts"  "cat app/public/iconsets/foo.svg"
  decide allow "EXEMPT: sibling specs-old/ read no longer prompts" "cat docs/superpowers/specs-old/draft.md"
  decide allow "EXEMPT: NOTICES.txt.bak read no longer prompts"    "cat app/public/THIRD-PARTY-NOTICES.txt.bak"

  # --- MUST ASK: verb MEMBERSHIP is what fails. No disqualifying construct
  # in any of these - strip one clause and only these rows can catch it.
  decide ask "MEMBERSHIP: sed is not read-only"      "sed -i s/x/y/ app/public/data/mask.bin"
  decide ask "MEMBERSHIP: cp is not read-only"       "cp /tmp/f app/public/data/mask.bin"
  decide ask "MEMBERSHIP: touch is not read-only"    "touch app/public/data/mask.bin"
  decide ask "MEMBERSHIP: find is EXCLUDED (-delete/-exec surface)" "find app/public/data -name x"
  decide ask "MEMBERSHIP: file is EXCLUDED (file -C -m X writes X.mgc)" "file app/public/data/mask.bin"
  # #388 review Finding 1: `grep` is a Claude Code shell FUNCTION shimming to
  # ugrep, whose option surface contains writers/executors - so it is NOT on
  # the allowlist and a bare read-only grep correctly asks. Removing it flips
  # exactly this row's former `allow` twin; nothing else moved.
  decide ask "MEMBERSHIP: grep is EXCLUDED (shell function shimming to ugrep)" "grep -n foo app/public/data/mask.bin"
  decide ask "MEMBERSHIP: exact match, not prefix"   "statx app/public/data/mask.bin"
  decide ask "MEMBERSHIP: exact match, not a path-qualified spelling" "/usr/bin/stat app/public/data/mask.bin"
  decide ask "MEMBERSHIP: a bare path as the verb"   "app/public/data/mask.bin"

  # --- MUST ASK: a WRITE-CAPABLE CHARACTER is what fails. Every row is an
  # allowlisted verb + a protected path, so the named character is the only
  # thing standing between it and suppression. These are the fail-open shapes
  # a first-word-only allowlist would have let through.
  decide ask "CHAR >: redirect makes cat a write"    "cat app/public/data/mask.bin > /tmp/x"
  decide ask "CHAR >>: append redirect"              "cat app/public/data/mask.bin >> /tmp/x"
  decide ask "CHAR <: input redirect"                "wc -l < app/public/data/mask.bin"
  decide ask "CHAR <<: heredoc"                      "cat app/public/data/mask.bin << EOF"
  decide ask "CHAR |: pipe (could pipe into tee)"    "cat app/public/data/mask.bin | wc -l"
  decide ask "CHAR ||: or-list"                      "stat app/public/data/mask.bin || true"
  decide ask "CHAR &: background"                    "stat app/public/data/mask.bin &"
  decide ask "CHAR &&: and-list (stat foo && rm bar shape)" "stat app/public/data/mask.bin && true"
  decide ask "CHAR ;: separator"                     "stat app/public/data/mask.bin ; true"
  # shellcheck disable=SC2016  # the literal backtick IS the test input
  decide ask 'CHAR backtick: command substitution'   'stat app/public/data/mask.bin `true`'
  # shellcheck disable=SC2016  # literal $ is the test input, not an expansion
  decide ask 'CHAR $: parameter expansion'           'stat $HOME/app/public/data/mask.bin'
  # shellcheck disable=SC2016
  decide ask 'CHAR $( ): substitution - inseparable from $ and ( )' 'stat $(echo app/public/data/mask.bin)'
  # shellcheck disable=SC2016
  decide ask 'CHAR ${ }: inseparable from $ and { }'  'stat ${HOME}/app/public/data/mask.bin'
  decide ask "CHAR ( ): subshell"                    "stat (app/public/data/mask.bin)"
  decide ask "CHAR { }: brace expansion"             "stat app/public/data/{mask,x}.bin"
  decide ask "CHAR backslash: escaping"              'stat app/public/data/mask.bin\x'
  decide ask "CHAR !: negation/history"              "test ! -f app/public/data/mask.bin"
  decide ask "CHAR #: comment"                       "stat app/public/data/mask.bin # note"
  decide ask "CHAR newline: second command"          "stat app/public/data/mask.bin${nl}true"
  decide ask "CHAR carriage return"                  "stat app/public/data/mask.bin${cr}true"

  # --- MUST ASK: a WRITE-CAPABLE TOKEN is what fails. Each token appears as
  # an ARGUMENT of an allowlisted verb, which is contrived on purpose: the
  # natural spelling (`xargs stat <path>`) would also fail verb membership
  # and so could not isolate the token (#216). These rows are defence in
  # depth - the token is already unreachable as an executable here.
  decide ask "TOKEN tee"                             "stat tee app/public/data/mask.bin"
  decide ask "TOKEN xargs"                           "stat xargs app/public/data/mask.bin"
  decide ask "TOKEN -exec"                           "stat -exec app/public/data/mask.bin"
  decide ask "TOKEN -execdir (via -exec subsumption, not its own entry)" "stat -execdir app/public/data/mask.bin"
  decide ask "TOKEN -delete"                         "stat -delete app/public/data/mask.bin"
  decide ask "TOKEN -ok"                             "stat -ok app/public/data/mask.bin"
  decide ask "TOKEN -okdir (via -ok subsumption, not its own entry)"     "stat -okdir app/public/data/mask.bin"
  decide ask "TOKEN sudo"                            "stat sudo app/public/data/mask.bin"
  decide ask "TOKEN eval"                            "stat eval app/public/data/mask.bin"
  decide ask "TOKEN sh -c"                           "stat sh -c app/public/data/mask.bin"
  decide ask "TOKEN bash -c (via sh -c subsumption, not its own entry)" "stat bash -c app/public/data/mask.bin"

  # --- The exemption must not widen the guard either: an allowlisted verb
  # with NO protected path is allowed for the ordinary reason (no hit), and
  # that has to stay independent of the exemption.
  decide allow "no path named: unrelated read" "cat app/src/App.tsx"

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
  # (#309 fix-wave m1): `"$0"` executed verbatim goes through PATH lookup
  # when invoked without a slash (`bash artifact-guard.sh --selftest` from
  # the script's own directory) and is not found there, silently failing
  # every ask/deny row while the allow rows pass by coincidence - the
  # selftest's verdict must not depend on invocation form. Normalise once.
  case "$0" in
    */*) SELF=$0 ;;
    *) SELF=./$0 ;;
  esac
  # (#309 fix-wave M3): a WANT of "ask" is not enough to prove the Bash
  # path-presence arm actually ran - the file_path arm's own "could not
  # extract a file_path" fallback ALSO answers `ask`, so a fully DISABLED
  # Bash dispatch (mutation: `if [ "$tn" = "NEVER" ]`) left the positive row
  # green, having fallen through to that unrelated fallback. REASON_SUBSTR
  # is required whenever WANT is ask/deny and must appear in the actual
  # permissionDecisionReason, not just match the decision keyword - pass ""
  # only for allow rows, which have no reason to check.
  wrapper_check() { # WANT(ask|deny|allow) REASON_SUBSTR DESC JSON
    local want="$1" reason_substr="$2" desc="$3" json="$4" out decision
    total=$((total + 1))
    out=$(printf '%s' "$json" | "$SELF" 2>/dev/null)
    if [ -z "$out" ]; then
      decision=allow
    elif printf '%s' "$out" | grep -q '"permissionDecision":"deny"'; then
      decision=deny
    elif printf '%s' "$out" | grep -q '"permissionDecision":"ask"'; then
      decision=ask
    else
      decision=other
    fi
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
  wrapper_check ask   "mentions protected path" "Bash cp through the wrapper"         '{"tool_name":"Bash","tool_input":{"command":"cp /tmp/f app/public/data/mask.bin"}}'
  wrapper_check allow ""                        "Bash git status through the wrapper" '{"tool_name":"Bash","tool_input":{"command":"git status"}}'
  # (#309 fix-wave m2): a missing/empty Bash command now asks (see DESIGN) -
  # was `allow` before the m2 fix; the reason must be the Bash arm's OWN
  # "could not extract a Bash command" text, not the unrelated file_path
  # arm's "could not extract a file path" (which would indicate the Bash
  # dispatch never ran at all - the same M3 blind spot, checked here too).
  wrapper_check ask   "could not extract a Bash command" "Bash with no command field" '{"tool_name":"Bash","tool_input":{}}'
  # Regression guard: the ORIGINAL Edit|Write behavior must be byte-for-byte
  # unchanged now that this script serves a second matcher.
  wrapper_check deny  "Generated artifact"      "Edit deny arm unaffected"            '{"tool_name":"Edit","tool_input":{"file_path":"app/public/data/mask.bin"}}'
  wrapper_check ask   "source of truth"         "Edit specs arm unaffected"           '{"tool_name":"Edit","tool_input":{"file_path":"docs/superpowers/specs/foo.md"}}'
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
  wrapper_check ask   "mentions protected path" "stat + redirect still asks"          '{"tool_name":"Bash","tool_input":{"command":"stat app/public/data/mask.bin > /tmp/x"}}'
  wrapper_check ask   "mentions protected path" "non-allowlisted verb still asks"     '{"tool_name":"Bash","tool_input":{"command":"sed -i s/x/y/ app/public/data/mask.bin"}}'

  # TWIN CHECK (#388 review, Finding 2): the user-facing reason string claims
  # to name the exempt set exhaustively. It is DERIVED from READONLY_VERBS,
  # so it cannot drift by hand — but a future refactor could break the
  # derivation, so assert the emitted production JSON really does contain
  # every array entry. Fails CLOSED: an empty/absent reason reds every row
  # rather than passing vacuously (same shape as useBannerHeight.test.ts's
  # CSS<->TS check, CLAUDE.md).
  reason_out=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"cp /tmp/f app/public/data/mask.bin"}}' | "$SELF" 2>/dev/null)
  for v in "${READONLY_VERBS[@]}"; do
    total=$((total + 1))
    case "$reason_out" in
      *"$v"*) ;;
      *)
        echo "SELFTEST FAIL [reason twin]: READONLY_VERBS entry [$v] is missing from the emitted permissionDecisionReason (out: $reason_out)"
        fail=1
        ;;
    esac
  done

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
    # prove - falls through to `ask` below.
    if bash_is_provably_readonly "$cmd"; then
      exit 0
    fi
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Bash command mentions protected path '"$p"' (#309: app/public/{data,icons,brand}/ are committed pipeline outputs, THIRD-PARTY-NOTICES.txt/.pmtiles (which also matches .pmtiles.png files) are generated artifacts, docs/superpowers/ is the source-of-truth spec dir and its ancestor). This guard checks whether the path STRING appears anywhere in the Bash command; it does NOT parse shell syntax to work out whether the command is really a write. The one exception is a command PROVEN read-only - a single simple command whose first word is a no-write verb ('"$(readonly_verbs_sentence)"') with no redirect, pipe, separator, substitution, expansion or escape anywhere in it - which is suppressed silently. This command is not that, so it asks: it either uses a verb outside that set or contains a write-capable construct. Confirm intent before proceeding."}}'
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
esac
