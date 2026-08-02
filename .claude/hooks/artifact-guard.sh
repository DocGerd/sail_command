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
#   - NO read-only exemptions. An allowlist for grep/cat/head was explicitly
#     considered and REJECTED: each exemption is a fail-open hole (`cat f >
#     protected/path` would match a `cat`-prefix exemption and bypass this
#     guard entirely), and this exact shape relocated its fail-open bug FOUR
#     TIMES inside one PR (#274, recorded in CLAUDE.md). So `grep -n foo
#     <protected>` and a command that merely NAMES a protected path in prose
#     both `ask` — a DELIBERATE, ACCEPTED over-fire, not a bug to tune away.
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
#   - Two of the Edit|Write arm's three extension-only patterns ARE
#     reproduced here as literal substrings (#309 fix-wave M1): `.pmtiles`
#     and `.pmtiles.png`. Measured: neither collides with an ordinary
#     English word or common shell token, so there is no over-fire cost to
#     protecting them directly — and doing so closes a real gap M1 found: a
#     GITIGNORED `app/dist/data/basemap.pmtiles.png` (Vite's default
#     `outDir`, unset in `app/vite.config.ts` -> `app/dist`; `public/` is
#     copied verbatim into it on every build) is covered by the Edit|Write
#     arm's extension pattern but was covered by NOTHING on this arm before
#     this fix.
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
  ".pmtiles.png"
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

# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  fail=0

  # check WANT DESC CMD - drives the pure bash_hits_protected_path() function
  # directly (WANT is "ask" or "allow").
  check() {
    local want="$1" desc="$2" cmd="$3" got
    if bash_hits_protected_path "$cmd" >/dev/null; then got=ask; else got=allow; fi
    if [ "$got" != "$want" ]; then
      echo "SELFTEST FAIL: $desc -> got [$got] want [$want] (cmd: $cmd)"
      fail=1
    fi
  }

  nl=$'\n'

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

  # --- ACCEPTED OVER-FIRE: a provably read-only mention still asks. This is
  # DELIBERATE (see DESIGN above, "no read-only exemptions") - each row says
  # so, so a future reader doesn't mistake it for an untuned false positive.
  check ask "OVER-FIRE (accepted): read-only grep" "grep -n foo app/public/data/mask.bin"
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

  # --- POSITIVE (#309 fix-wave M1): .pmtiles/.pmtiles.png are now protected
  # as bare substrings - no noise source found for either (contrast the .bin
  # residual row below).
  check ask "M1: .pmtiles extension"                    "cp /tmp/f app/dist/data/basemap.pmtiles"
  check ask "M1: .pmtiles.png extension"                 "cp /tmp/f app/dist/data/basemap.pmtiles.png"

  # --- RESIDUAL (documented, not fixed - see DESIGN and the "KNOWN
  # SILENT-ALLOW PATHS" list above): the .bin extension and the app/public
  # and app ancestors are deliberately NOT protected. Pinned as ALLOW here so
  # a future accidental narrowing (or widening) of PROTECTED_PATHS is caught
  # either way, not just silently drifted.
  check allow "RESIDUAL (documented): bare .bin outside protected dirs" "cp /tmp/f app/dist/data/mask.bin"
  check allow "RESIDUAL (documented): bare app/public ancestor"         "find app/public -name *.bin -delete"
  check allow "RESIDUAL (documented): bare app ancestor"                "find app -name mask.bin -delete"

  # --- ACCEPTED OVER-FIRE (#309 fix-wave B1): removing the trailing slash
  # from the directory entries means a sibling directory sharing the same
  # PREFIX now genuinely contains the protected substring and correctly
  # asks - this is the flip side of the B1 fix above, not a separate bug.
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
  # does contain the protected string and correctly asks - not a bug, but
  # worth pinning so it isn't mistaken for one later.
  check ask "OVER-FIRE (accepted): NOTICES.txt.bak" "cat app/public/THIRD-PARTY-NOTICES.txt.bak"

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
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Bash command mentions protected path '"$p"' (#309: app/public/{data,icons,brand}/ are committed pipeline outputs, THIRD-PARTY-NOTICES.txt/.pmtiles/.pmtiles.png are generated artifacts, docs/superpowers/ is the source-of-truth spec dir and its ancestor). This guard only checks whether the path STRING appears anywhere in the Bash command - no shell parsing, no read/write classification - so a read-only mention also asks; this is a deliberate, accepted over-fire (see header). Confirm intent before proceeding."}}'
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
