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
# KNOWN WAYS THIS HOOK CAN PRODUCE NO EXPLICIT DECISION (PR #305 review, B2,
# retitled from "EVERY WAY" on the same PR's follow-up review — CLAUDE.md:
# prefer "narrowed" to "closed" unless the measurement really covers the
# whole space, and "EVERY WAY" is exactly the over-claim that licenses the
# next regression, the same shape as round 1's M1). A blocking guard's
# silent-allow paths are the same defect class #274 was filed over, one
# layer up from the `case` arms — enumerated so a future change can be
# checked against this list, understanding the list is what has been FOUND,
# not a proof of completeness:
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
#   - The Edit|Write arm's extension-only patterns (`*.bin`, `*.pmtiles`,
#     `*.pmtiles.png`) are DELIBERATELY NOT reproduced as bare substrings
#     here — matching a 3-4 character extension as a raw substring anywhere
#     in a shell command (".bin" also occurs inside "robin", "cabin", every
#     English word ending "-bin") would be noise, not signal, at a scale the
#     directory-shaped checks never are. Every file those patterns cover
#     already lives under app/public/data/ today (per the comment above), so
#     a Bash command touching one BY PATH still matches "app/public/data/".
#     This is a scoped decision, not an oversight.
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
set -uo pipefail

# Single source of truth for the Bash path-presence arm (see DESIGN above).
PROTECTED_PATHS=(
  "app/public/data/"
  "app/public/icons/"
  "app/public/brand/"
  "app/public/THIRD-PARTY-NOTICES.txt"
  "docs/superpowers/specs/"
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

  # --- NEGATIVE: a near-miss of a protected path that is genuinely OUTSIDE
  # it - a sibling directory sharing a prefix must NOT match. This is the
  # matching's own false-positive bound, verified, not assumed.
  check allow "sibling dir: database/"      "cat app/public/database/config.json"
  check allow "sibling dir: iconsets/"      "cat app/public/iconsets/foo.svg"
  check allow "sibling dir: specs-old/"     "cat docs/superpowers/specs-old/draft.md"
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
  wrapper_check() { # WANT(ask|deny|allow) DESC JSON
    local want="$1" desc="$2" json="$3" out decision
    out=$(printf '%s' "$json" | "$0" 2>/dev/null)
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
  }
  wrapper_check ask   "Bash cp through the wrapper"        '{"tool_name":"Bash","tool_input":{"command":"cp /tmp/f app/public/data/mask.bin"}}'
  wrapper_check allow "Bash git status through the wrapper" '{"tool_name":"Bash","tool_input":{"command":"git status"}}'
  wrapper_check allow "Bash with no command field"          '{"tool_name":"Bash","tool_input":{}}'
  # Regression guard: the ORIGINAL Edit|Write behavior must be byte-for-byte
  # unchanged now that this script serves a second matcher.
  wrapper_check deny  "Edit deny arm unaffected"            '{"tool_name":"Edit","tool_input":{"file_path":"app/public/data/mask.bin"}}'
  wrapper_check ask   "Edit specs arm unaffected"           '{"tool_name":"Edit","tool_input":{"file_path":"docs/superpowers/specs/foo.md"}}'
  wrapper_check allow "Edit unrelated file unaffected"      '{"tool_name":"Write","tool_input":{"file_path":"app/src/App.tsx"}}'
  wrapper_check allow "Edit icon.svg exception unaffected"  '{"tool_name":"Edit","tool_input":{"file_path":"app/public/icons/icon.svg"}}'
  # Old-shaped payload with no tool_name at all (pre-#309 test shape) must
  # still hit the file_path arm, not silently fall through as "not Bash".
  wrapper_check deny  "no tool_name, file_path present"     '{"tool_input":{"file_path":"app/public/data/mask.bin"}}'

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

  if p=$(bash_hits_protected_path "$cmd"); then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Bash command mentions protected path '"$p"' (#309: app/public/{data,icons,brand}/ are committed pipeline outputs, THIRD-PARTY-NOTICES.txt is a generated dependency manifest, docs/superpowers/specs/ is the source-of-truth spec dir). This guard only checks whether the path STRING appears anywhere in the Bash command - no shell parsing, no read/write classification - so a read-only mention also asks; this is a deliberate, accepted over-fire (see header). Confirm intent before proceeding."}}'
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
