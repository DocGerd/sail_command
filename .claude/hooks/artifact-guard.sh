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
# EVERY WAY THIS HOOK CAN PRODUCE NO EXPLICIT DECISION (PR #305 review, B2):
# a blocking guard's silent-allow paths are the same defect class #274 was
# filed over, one layer up from the `case` arms — enumerated so a future
# change can be checked against the full list, not just the arms it touches:
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
#      settings.json now checks `[ -x "$H" ]` before invoking and emits its
#      own `ask` JSON if the script isn't there or isn't executable, rather
#      than depending on this file to exist in order to fail safely.
#   4. Well-formed input, `$f` matches no `case` arm (e.g. app/src/App.tsx)
#      -> no output, tool proceeds. This IS the intended allow path, not a
#      gap — it is what makes every other file in the repo editable.
set -uo pipefail

IN=$(cat)

[ -n "$IN" ] || {
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"artifact/spec guard received empty tool input - protection is inert."}}'
  exit 0
}

f=$(printf '%s' "$IN" | jq -r '.tool_input.file_path // empty' 2>/dev/null) \
  || f=$(printf '%s' "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tool_input',{}).get('file_path') or '')" 2>/dev/null) \
  || {
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"artifact/spec guard could not parse tool input (malformed JSON, or jq/python3 unavailable) - protection is inert; install jq."}}'
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
