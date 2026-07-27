#!/usr/bin/env bash
# graphify-nudge.sh — PreToolUse Bash hook (#216).
#
# Nudges toward `graphify query "<question>"` before raw-grepping the
# codebase for a codebase question. Previously an inline
# `case "$CMD" in *grep\ *|rg\ *|*\ rg\ *|find\ *|*\ find\ *|...) ...) esac`
# one-liner in settings.json: several alternatives were unanchored (a
# leading `*`), so the pattern was satisfied whenever e.g. " find " or
# " grep " appeared anywhere in the command — including as an ordinary
# English word in prose, a commit message, or a PR comment body (#216: it
# fired on `git status`, `git worktree list`, `gh pr checks`, `gh api`
# calls whenever their surrounding text happened to contain one of those
# words).
#
# Anchoring approach: split the command into top-level segments via
# anchor.sh's sc_segments (quote-, heredoc- and subshell-aware — see
# segment_command.py for the full writeup of three false-positive/negative
# shapes a PR review found in an earlier version of this script that used a
# naive `tr`+`read` splitter), then for each segment check that it literally
# STARTS with one of the trigger programs.
#
# Narrowed, invocation-anchored trigger set: grep, rg, ack, ag (content
# search — a reasonable proxy for "codebase question"). find/fd are
# DELIBERATELY DROPPED, not just anchored: they search file NAMES, not
# contents, so a bare `find . -name x` hunting a stray file is not a
# codebase question either (the #216 verification table requires it to not
# fire). This is a documented coarsening of the trigger set, not an
# oversight.
#
# Known remaining coarseness (command inspection cannot see INTENT):
#   - a grep that is itself answering "did the stray file get committed"
#     still fires — there is no way to distinguish a codebase question from
#     any other use of grep/rg by text alone.
#   - a search tool passed as an argument to another program (e.g.
#     `find . | xargs grep foo`) is not recognized, because it is not the
#     segment's own first word.
# Both are accepted as "coarse but honest" per #216: a narrow, precise nudge
# that is silent on ambiguous cases beats a broad one nobody reads anymore.
#
# If segmentation itself cannot run (e.g. python3 missing/broken), decide()
# fails CLOSED (fires the nudge) rather than silently going quiet, mirroring
# notices-guard.sh's choice for the same reason: "cannot decide" must never
# be silently read as "definitely not an invocation" (#216).
#
# Offline self-test of the pure decision logic:
#   .claude/hooks/graphify-nudge.sh --selftest
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/anchor.sh
source "$DIR/lib/anchor.sh"

# Pure decision logic — no filesystem/graphify state, unit-tested via
# --selftest (the graphify-out/graph.json gating happens in the production
# path below, same as before).
# arg: one command SEGMENT (already split by sc_segments)
_seg_is_search_invocation() {
  local seg="$1" first
  first=$(sc_strip_prefix "$seg")
  first=${first%% *}
  case "$first" in
    grep | rg | ack | ag) return 0 ;;
    *) return 1 ;;
  esac
}

# arg: full tool_input.command string; echoes "fire" or "skip"
decide() {
  local cmd="$1" seg out rc
  out=$(sc_segments "$cmd")
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo fire # fail CLOSED: segmentation is undecidable (#216)
    return
  fi
  while IFS= read -r seg; do
    _seg_is_search_invocation "$seg" && {
      echo fire
      return
    }
  done <<< "$out"
  echo skip
}

# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  fail=0
  expect() { # desc  want  got
    case "$3" in "$2") : ;; *) echo "SELFTEST FAIL: $1 -> got [$3] want [$2]"; fail=1 ;; esac
  }

  expect "bare grep fires" "fire" "$(decide 'grep -rn foo .')"
  expect "bare rg fires" "fire" "$(decide 'rg foo app/src')"
  expect "compound: git status && grep fires" "fire" "$(decide 'git status && grep -rn foo .')"
  expect "git status does not fire" "skip" "$(decide 'git status')"
  expect "git worktree list does not fire" "skip" "$(decide 'git worktree list')"
  expect "gh pr checks does not fire" "skip" "$(decide 'gh pr checks')"
  expect "gh api does not fire" "skip" "$(decide 'gh api repos/DocGerd/sail_command/issues/216')"
  expect "bare find does not fire (dropped trigger)" "skip" "$(decide 'find . -name x')"

  PROSE='gh pr comment 216 --body "we need to find a cleaner fix here"'
  expect "prose mentioning find (as an English word) does not fire" "skip" "$(decide "$PROSE")"

  # --- PR #233 review Blocker regression cases (reproduced against the
  #     earlier tr/read-based sc_segments; must hold under the rewrite) ---

  # Blocker 1: a separator character INSIDE a quoted string must not
  # manufacture a phantom segment.
  expect "Blocker 1: semicolon inside a single-quoted --body does not fire" \
    "skip" "$(decide "gh pr comment 216 --body 'note to self; grep for the culprit later'")"
  expect "Blocker 1: semicolon inside a commit message does not fire" \
    "skip" "$(decide 'git commit -m "fix: tidy grep usage; grep -n foo bar was wrong"')"

  # Blocker 2: a heredoc BODY line that is itself, verbatim, a real-looking
  # invocation must still be treated as data, not a segment.
  HEREDOC_LINE_START='cat > /tmp/notes.md <<EOF
Example:
grep foo .
EOF'
  expect "Blocker 2: heredoc body line starting with 'grep foo .' does not fire" \
    "skip" "$(decide "$HEREDOC_LINE_START")"

  # Blocker 3: a subshell must not defeat the anchor (false negative).
  expect "Blocker 3: subshell (grep foo .) still fires" "fire" "$(decide '(grep foo .)')"

  # Fail-closed: if segmentation cannot run at all (python3 missing/broken),
  # the hook must fire rather than go silent — proven with a command that
  # would otherwise clearly be a "skip" (git status has no search tool), to
  # show this is genuine fail-closed behaviour, not a coincidence.
  NOPY_FIRE=$(PATH="/nonexistent" decide "git status" 2>/dev/null)
  expect "fail-closed: python3 unavailable fires even for an unrelated command" "fire" "$NOPY_FIRE"

  if [ "$fail" -eq 0 ]; then echo "SELFTEST OK"; else echo "SELFTEST FAILURES"; fi
  exit "$fail"
fi

# ---- production path: read the tool input from stdin ----
IN=$(cat)
CMD=$(printf '%s' "$IN" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',d).get('command',''))" 2>/dev/null || true)
[ -n "$CMD" ] || exit 0
[ "$(decide "$CMD")" = "fire" ] || exit 0

GRAPH_JSON="${CLAUDE_PROJECT_DIR:-.}/graphify-out/graph.json"
[ -f "$GRAPH_JSON" ] || exit 0

FAILED_MARKER="${CLAUDE_PROJECT_DIR:-.}/graphify-out/.update-failed"
if [ -f "$FAILED_MARKER" ]; then
  SID=$(printf '%s' "$IN" | python3 -c "import json,sys; print(json.load(sys.stdin).get('session_id') or 'nosess')" 2>/dev/null || echo nosess)
  SENT="${TMPDIR:-/tmp}/claude-graphify-stale-$SID"
  if [ ! -e "$SENT" ]; then
    : > "$SENT" 2>/dev/null || true
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"graphify graph exists but its last auto-update FAILED (see graphify-out/.update-failed) - it may be STALE (shown once per session). Prefer raw files/grep until `graphify update .` succeeds."}}'
  fi
else
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"MANDATORY: graphify-out/graph.json exists. You MUST run `graphify query \"<question>\"` before grepping raw files. Only grep after graphify has oriented you, or to modify/debug specific lines."}}'
fi
exit 0
