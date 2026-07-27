#!/usr/bin/env bash
# anchor.sh — shared command-anchoring helpers for SailCommand Bash-matching
# PreToolUse/PostToolUse hooks (#216).
#
# A hook must match the command being INVOKED, not merely mentioned inside
# prose, a commit message, or a heredoc body (#177, #216) — unanchored
# substring globs like `*npm*install*` or `*find\ *` are satisfied by
# unrelated text appearing anywhere in the command. This file factors out
# the two primitives every anchored matcher needs, mirroring
# premerge-verify.sh's existing first-word-extraction style so the technique
# isn't triplicated across hooks:
#
#   sc_segments CMD        — split CMD into top-level segments on &&, ||, ;
#                             and | (one segment per output line)
#   sc_stripped_line SEG   — SEG's own first line, with leading whitespace
#                             and any sudo/command/time/ENV=value prefix
#                             removed, ready to `read -ra` into words
#
# Why "first line only": a real invocation always starts a segment on its
# own first line. A `\`-continued command spanning onto line 2 is a known,
# accepted gap (not a pattern used in this repo — every example in
# CLAUDE.md's directory-aware command reference is single-line). The
# alternative — matching across a segment's full (possibly multi-line) text
# — would re-open the exact defect #216 exists to close: a heredoc body's
# OWN lines would each need `^` anchoring the way grep line-mode delivers
# it, and prose that happens to start a line with a program name (e.g. a
# code-block example) would false-fire again. Stopping at line 1 avoids
# that without giving up compound-command handling, because && / ; / | all
# occur on the segment's own first line, before any heredoc body begins.
#
# Callers still own their own subcommand/flag matching on top of these two
# primitives — anchor.sh only answers "what does this segment start with",
# never "is this a force-push" or "is this an npm install".

# Split a command string into top-level segments on &&, ||, ;, | — mirrors
# premerge-verify.sh's `tr ';&|' '\n\n\n'` chain-splitting. Segments may
# still contain embedded newlines (a heredoc body); sc_stripped_line
# deliberately does not descend into them.
sc_segments() {
  # Trailing \n matters: without it, `while read seg; do ...; done < <(sc_segments ...)`
  # would read the FINAL segment's text into $seg but `read` still returns
  # non-zero (EOF without a newline) — the loop body would silently never run
  # for a single-segment (no &&/;/|) command, which is the common case.
  printf '%s\n' "$1" | tr ';&|' '\n\n\n'
}

# Print one segment's first line, prefix-stripped: leading whitespace, then
# a leading sudo/command/time wrapper and any number of leading ENV=value
# assignments — the same regex premerge-verify.sh uses to find the real
# invocation.
sc_stripped_line() {
  local seg="$1"
  printf '%s' "${seg%%$'\n'*}" \
    | sed -E 's/^[[:space:]]+//' \
    | sed -E 's/^(sudo[[:space:]]+|command[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*//'
}
