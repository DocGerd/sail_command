#!/usr/bin/env bash
# anchor.sh — shared command-anchoring helpers for SailCommand Bash-matching
# PreToolUse/PostToolUse hooks (#216).
#
# A hook must match the command being INVOKED, not merely mentioned inside
# prose, a commit message, or a heredoc body (#177, #216). An earlier version
# of this file did the segmentation itself with `tr ';&|' '\n\n\n'` plus a
# bash `while read` loop; a PR review found that still reproduced the
# mention-vs-invocation defect on three shapes — a separator character
# INSIDE a quoted string, a heredoc BODY line that looks exactly like a real
# invocation, and a subshell's `(`/`)` defeating the anchor entirely (a
# silent FALSE NEGATIVE, the worse failure direction: the original unanchored
# hooks over-fired but never missed a real invocation). Getting quote-
# tracking and heredoc-body detection right in pure POSIX shell means
# hand-rolling a chunk of a shell lexer, so the actual scanning now lives in
# segment_command.py (full writeup + repro cases in its header) — python3 is
# already a hard dependency of these hooks (premerge-verify.sh, the graphify
# nudge) — and this file is a thin bash wrapper around it plus the
# sudo/env-prefix stripping that's unrelated to any of the three defects.
#
#   sc_segments CMD       — one top-level segment per output line
#                            (quote-, heredoc- and subshell-aware; see
#                            segment_command.py). RETURNS NON-ZERO if
#                            segmentation could not run at all (e.g. python3
#                            missing/broken) — callers must treat that as
#                            UNDECIDABLE and fail CLOSED, never silently
#                            read "no output" as "no invocation".
#   sc_strip_prefix SEG   — SEG with leading whitespace and any sudo/
#                            command/time/ENV=value prefix removed, ready to
#                            `read -ra` into words. SEG is always a single,
#                            newline-free line by construction
#                            (segment_command.py guarantees no segment
#                            crosses a newline).
#
# Callers still own their own subcommand/flag matching on top of these two
# primitives — anchor.sh only answers "what does this segment start with",
# never "is this a force-push" or "is this an npm install".

_SC_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sc_segments() {
  # -B: this hook runs on every Bash tool call, so without it a
  # segment_command.cpython-*.pyc would keep reappearing as an untracked
  # file under .claude/hooks/lib/__pycache__/ in every session's git status.
  printf '%s' "$1" | python3 -B "$_SC_LIB_DIR/segment_command.py"
  return "${PIPESTATUS[1]}"
}

# Strip leading whitespace, then a leading sudo/command/time wrapper and any
# number of leading ENV=value assignments — the same regex premerge-verify.sh
# uses to find the real invocation.
sc_strip_prefix() {
  local seg="$1"
  printf '%s' "$seg" \
    | sed -E 's/^[[:space:]]+//' \
    | sed -E 's/^(sudo[[:space:]]+|command[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*//'
}
