#!/usr/bin/env bash
# notices-guard.sh — PostToolUse Bash hook (#216).
#
# Reminds to run `npm --prefix app run notices` after a REAL npm
# dependency-changing invocation. Previously an inline
# `case "$CMD" in *npm*install*|*npm*uninstall*|*npm*update*) ...) esac`
# one-liner in settings.json: unanchored on both sides, it fired whenever
# "npm" and "install" appeared anywhere in the command, in either order,
# not necessarily adjacent or even both part of the same invocation — e.g.
# a heredoc explaining npm cache behaviour in prose (#216). It also had
# false negatives: `npm ci` and `npm add` were not matched at all.
#
# Anchoring approach: split the command into top-level segments via
# anchor.sh's sc_segments (quote-, heredoc- and subshell-aware — see
# segment_command.py for the full writeup of three false-positive/negative
# shapes a PR review found in an earlier version of this script that used a
# naive `tr`+`read` splitter), then for each segment check that it is
# literally `npm`, optionally followed by flags (--prefix/-w/--workspace
# consume one value token; any other `-*` token is a bare flag),
# immediately followed by one of the dependency-changing subcommands. This
# supports this repo's `npm --prefix app <cmd>` convention (CLAUDE.md's
# directory-aware command reference) without an adjacency-only rule
# breaking it.
#
# If segmentation itself cannot run (e.g. python3 missing/broken), decide()
# fails CLOSED (fires the reminder) rather than silently going quiet — a
# missed real `npm ci` means THIRD-PARTY-NOTICES.txt drifts and CI fails
# ~10 minutes later, which is worse than one spurious reminder (#216).
#
# Offline self-test of the pure decision logic:
#   .claude/hooks/notices-guard.sh --selftest
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/anchor.sh
source "$DIR/lib/anchor.sh"

# Pure decision logic — no network/filesystem beyond python3, unit-tested
# via --selftest.
# arg: one command SEGMENT (already split by sc_segments)
# returns 0 iff this segment is a real npm dependency-changing invocation.
_seg_is_npm_change() {
  local seg="$1" i w
  local -a arr
  IFS=$' \t' read -ra arr <<< "$(sc_strip_prefix "$seg")"
  [ "${arr[0]:-}" = "npm" ] || return 1
  i=1
  while [ "$i" -lt "${#arr[@]}" ]; do
    w="${arr[$i]}"
    case "$w" in
      install | i | uninstall | remove | rm | update | up | ci | add) return 0 ;;
      --prefix | -w | --workspace) i=$((i + 2)) ;; # flag + its value
      -*) i=$((i + 1)) ;;                          # bare flag
      *) return 1 ;;                                # unrecognized token before any subcommand
    esac
  done
  return 1
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
    _seg_is_npm_change "$seg" && {
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

  expect "npm --prefix app install <pkg> fires" "fire" "$(decide 'npm --prefix app install some-pkg')"
  expect "npm ci fires (was a false negative)" "fire" "$(decide 'npm ci')"
  expect "npm add fires (was a false negative)" "fire" "$(decide 'npm add left-pad')"
  expect "npm uninstall fires" "fire" "$(decide 'npm uninstall some-pkg')"
  expect "npm i fires" "fire" "$(decide 'npm i some-pkg')"
  expect "npm rm fires" "fire" "$(decide 'npm rm some-pkg')"
  expect "npm up fires" "fire" "$(decide 'npm up')"
  expect "compound: git status && npm --prefix app update fires" "fire" "$(decide 'git status && npm --prefix app update')"
  expect "npm run build does not fire (not a dependency subcommand)" "skip" "$(decide 'npm run build')"
  expect "npm test does not fire" "skip" "$(decide 'npm test -- --run')"
  expect "gh api call does not fire" "skip" "$(decide "gh api graphql -f query='...' --jq '.'")"

  HEREDOC='cat > /tmp/notes.md <<EOF
Running npm ci performs a clean install by removing node_modules first.
This differs from a regular install in an important way.
EOF'
  expect "heredoc mentioning npm ci / install in prose does not fire" "skip" "$(decide "$HEREDOC")"

  # --- PR #233 review Blocker regression cases (reproduced against the
  #     earlier tr/read-based sc_segments; must hold under the rewrite) ---

  # Blocker 1: a separator character INSIDE a quoted string must not
  # manufacture a phantom segment.
  expect "Blocker 1: semicolon inside a double-quoted echo string does not fire" \
    "skip" "$(decide 'echo "reminder: run before committing; npm ci is required for reproducible deps"')"

  # Blocker 2: a heredoc BODY line that is itself, verbatim, a real-looking
  # invocation must still be treated as data, not a segment.
  HEREDOC_LINE_START='cat > /tmp/notes.md <<EOF
Example:
npm ci
That installs cleanly.
EOF'
  expect "Blocker 2: heredoc body line starting with 'npm ci' does not fire" \
    "skip" "$(decide "$HEREDOC_LINE_START")"

  # Blocker 3: a subshell must not defeat the anchor (false negative — the
  # worse failure direction per #216: a missed real invocation drifts
  # THIRD-PARTY-NOTICES.txt with zero reminder).
  expect "Blocker 3: bare subshell (npm ci) still fires" "fire" "$(decide '(npm ci)')"
  expect "Blocker 3: compound subshell (cd app && npm ci) still fires" "fire" "$(decide '(cd app && npm ci)')"

  # Fail-closed: if segmentation cannot run at all (python3 missing/broken),
  # the hook must fire rather than go silent — proven with a command that
  # would otherwise clearly be a "skip" (git status has no npm invocation),
  # to show this is genuine fail-closed behaviour, not a coincidence.
  NOPY_FIRE=$(PATH="/nonexistent" decide "git status" 2>/dev/null)
  expect "fail-closed: python3 unavailable fires even for an unrelated command" "fire" "$NOPY_FIRE"

  if [ "$fail" -eq 0 ]; then echo "SELFTEST OK"; else echo "SELFTEST FAILURES"; fi
  exit "$fail"
fi

# ---- production path: read the tool input from stdin ----
IN=$(cat)
CMD=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null) || CMD=""
[ -n "$CMD" ] || exit 0

if [ "$(decide "$CMD")" = "fire" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"npm changed dependencies. Regenerate third-party notices: npm --prefix app run notices - CI fails on any drift in app/public/THIRD-PARTY-NOTICES.txt. Run it before committing."}}'
fi
exit 0
