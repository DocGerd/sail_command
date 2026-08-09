#!/usr/bin/env bash
# CI guard: fail the build if any TRACKED file introduces an absolute
# per-user home-directory path into this public repository.
#
# BACKGROUND: commit e5358d4 (chore/redact-home-paths) found and replaced 20
# occurrences of the maintainer's home directory name across 11 tracked
# files with repo-relative placeholders (`<repo>`, `<scratchpad>`,
# `<flattened-repo-path>`, etc). That was a one-off cleanup; this script is
# the durable half - it stops the shape recurring, since docs are exactly
# where it leaked (an agent transcript or a copy-pasted command is the usual
# vector, not application code).
#
# THIS SCRIPT MUST NOT CONTAIN ANY REAL USERNAME (guard-asymmetry corollary:
# a guard hardcoding the string it exists to remove IS the leak). It matches
# a GENERIC SHAPE instead - any absolute path naming a per-user home
# directory, on any of the three OSes a contributor might run under, plus
# this repo's own two Claude-Code-specific spellings (the raw per-session
# scratchpad path and the flattened `~/.claude/projects/` directory name -
# both of which happen to be exactly the shapes e5358d4 found).
#
# Deriving the pattern from `$HOME` at run time is NOT sufficient on its own:
# CI always runs as `runner`, so a `$HOME`-derived pattern would never match
# a CONTRIBUTOR's leaked path - the one case this guard exists to catch. The
# patterns below are therefore fully generic; ALLOWED_PLACEHOLDERS below is
# the small set of spellings this repo already uses legitimately (`/home/
# user/...`, `C:\Users\USER\...`) so the guard does not fire on its own
# documentation.
#
# FAIL-CLOSED (CLAUDE.md's guard-asymmetry rule): this is a BLOCKING check
# wired into ci.yml's `app` job, a REQUIRED status check. A broken `git`, an
# unreadable/missing tracked file, an empty tracked-file list, or any
# internal error must FAIL the check, never pass it silently - a false
# positive costs one line of explanation; a false negative publishes
# someone's identity. Concretely: `git rev-parse --is-inside-work-tree`
# gates every run, an empty (or unobtainable) `git ls-files` list is treated
# as an error rather than "nothing to check", and a tracked path that is not
# a readable regular file - deleted-but-still-indexed, a FIFO, permission-
# denied - fails the whole run rather than being silently skipped.
#
# THE SCRIPT EXCLUDES ITSELF (its own repo-relative path, computed from `$0`
# rather than hardcoded so a future rename/move keeps it correct) - it
# necessarily contains the patterns it matches against, both in this header
# and in --selftest's constructed violating examples.
#
# Production usage (from the repo root, or any cwd inside the work tree -
# `git ls-files` resolves relative to the work tree regardless of cwd):
#   .github/scripts/check-no-home-paths.sh
# Offline self-test (constructs real violating/clean scratch git repos and
# exercises every fail-closed path; touches nothing under this repo):
#   .github/scripts/check-no-home-paths.sh --selftest
set -uo pipefail

# ---------------------------------------------------------------------------
# Pattern classes. Parallel arrays (bash has no records): for each index i,
# CLASS_GREP_ERE[i] is what `grep -E` scans tracked file contents with;
# CLASS_BASH_ERE[i] is the SAME shape restated as a bash `=~` pattern with a
# capturing group, used only to pull the "username" token back out of a
# grep match so it can be checked against ALLOWED_PLACEHOLDERS.
# CLASS_APPLY_ALLOWLIST[i]=1 means the allowlist can excuse a match in that
# class; =0 means it never can (see the tmp-scratchpad/flattened-projects
# note below).
CLASS_NAMES=(linux-home macos-home windows-home tmp-scratchpad flattened-projects)

# `[A-Za-z0-9_.-]+` deliberately excludes `<`, `>`, `$`, `{`, `}`, space and
# every other shell/markup metacharacter - so a bracket placeholder
# (`/home/<user>`), a variable (`/home/$USER`), or prose ("the /home/
# directory") never even reaches the extraction step: the class simply finds
# no characters to consume there and the pattern doesn't match at that
# position at all. Only a plausible literal username reaches the allowlist
# check below.
CLASS_GREP_ERE=(
  '/home/[A-Za-z0-9_.-]+'
  '/Users/[A-Za-z0-9_.-]+'
  'C:\\Users\\[A-Za-z0-9_.-]+'
  '/tmp/claude-[0-9]+/-home-[A-Za-z0-9._-]+'
  'projects/-home-[A-Za-z0-9._-]+'
)

# Same shapes, anchored, one capturing group each - fed a single grep MATCH
# (never a whole line), so `^...$` anchoring is exact rather than a prefix
# check.
CLASS_BASH_ERE=(
  '^/home/([A-Za-z0-9_.-]+)$'
  '^/Users/([A-Za-z0-9_.-]+)$'
  '^C:\\Users\\([A-Za-z0-9_.-]+)$'
  '^/tmp/claude-[0-9]+/-home-([A-Za-z0-9._-]+)$'
  '^projects/-home-([A-Za-z0-9._-]+)$'
)

# The tmp-scratchpad/flattened-projects classes get NO allowlist exemption:
# unlike a plain OS home path, there is no realistic legitimate spelling of
# these two shapes using real identifier characters - this repo's own
# genuine placeholder for them is the bracket form `<flattened-repo-path>` /
# `<scratchpad>`, which (per the class comment above) never reaches this
# code path at all. Any literal match is real.
CLASS_APPLY_ALLOWLIST=(1 1 1 0 0)

# Placeholder spellings already used legitimately in this repo's own docs
# (CONTRIBUTING.md, CLAUDE.md) - compared by EXACT (case-sensitive) string
# equality against the captured token, never case-folded: "user" and "USER"
# are both listed because both are genuine conventions (Linux example paths
# vs. Windows %USERPROFILE% documentation) and neither should silently
# excuse the other's case variant.
ALLOWED_PLACEHOLDERS=(user users you USER runner)

# ---------------------------------------------------------------------------
# Pure-ish helpers (no global state beyond the parallel arrays above).

# is_allowed_token TOKEN -> 0 if TOKEN exactly matches an entry in
# ALLOWED_PLACEHOLDERS, 1 otherwise.
is_allowed_token() {
  local token="$1" a
  for a in "${ALLOWED_PLACEHOLDERS[@]}"; do
    [ "$token" = "$a" ] && return 0
  done
  return 1
}

# scan_file FILE -> prints one "FILE:LINE:CLASS:MATCH" row per violation
# found in FILE; returns 0 if at least one violation was printed, 1 if none.
# Never itself decides pass/fail for the whole run - that is scan_tree's job
# (this function cannot tell "no violations" apart from "file could not be
# read", which is exactly why the caller checks readability FIRST).
scan_file() {
  local f="$1" i class ere bashere applyallow line lineno match token found=1
  for i in "${!CLASS_NAMES[@]}"; do
    class="${CLASS_NAMES[$i]}"
    ere="${CLASS_GREP_ERE[$i]}"
    bashere="${CLASS_BASH_ERE[$i]}"
    applyallow="${CLASS_APPLY_ALLOWLIST[$i]}"
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      # Split on the FIRST colon only (`grep -n -o` emits "LINE:MATCH", and
      # MATCH can itself contain a colon - the windows-home class always
      # does, e.g. "C:\Users\alice" - so `IFS=: read` would mis-split it).
      lineno="${line%%:*}"
      match="${line#*:}"
      if [ "$applyallow" = 1 ] && [[ "$match" =~ $bashere ]]; then
        token="${BASH_REMATCH[1]}"
        is_allowed_token "$token" && continue
      fi
      printf '%s:%s:%s:%s\n' "$f" "$lineno" "$class" "$match"
      found=0
    done < <(grep -n -o -E "$ere" -- "$f" 2>/dev/null)
  done
  return "$found"
}

# scan_tree [EXCLUDE_REL_PATH] -> scans every git-tracked file in the
# current work tree (cwd must be inside it; `git ls-files` resolves relative
# to the work tree root regardless of cwd, matching every other git command
# in this repo's own hooks). Prints violation rows and/or a fail-closed
# diagnostic to stdout. Returns 0 (clean), 1 (violations found), or 2
# (internal / fail-closed error - unusable git, no tracked files, or an
# unreadable tracked file).
scan_tree() {
  local exclude="${1:-}" any_violation=1 any_error=0 f

  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    echo "check-no-home-paths: not inside a git work tree (or git is unavailable) - cannot scan, failing closed."
    return 2
  }

  # `mapfile -d ''` reads NUL-delimited entries directly from the process
  # substitution without ever passing them through a command substitution
  # (which cannot hold embedded NUL bytes in bash) - filenames themselves
  # can't contain NUL, but this also means a `git ls-files` failure inside
  # the process substitution surfaces as an EMPTY array rather than a
  # corrupted one, which is exactly the state the next check treats as an
  # error. This deliberately folds "git ls-files failed" and "genuinely zero
  # tracked files" into the SAME fail-closed answer - per this guard's own
  # stated contract, an empty file list must fail regardless of why it is
  # empty, so there is no case where distinguishing the two would change the
  # outcome.
  local files=()
  mapfile -d '' -t files < <(git ls-files -z 2>/dev/null)

  if [ "${#files[@]}" -eq 0 ]; then
    echo "check-no-home-paths: git ls-files returned zero tracked files - cannot distinguish a genuinely empty repo from a broken git invocation, failing closed rather than reporting a silent pass."
    return 2
  fi

  for f in "${files[@]}"; do
    [ -n "$exclude" ] && [ "$f" = "$exclude" ] && continue
    if [ ! -f "$f" ] || [ ! -r "$f" ]; then
      echo "check-no-home-paths: tracked path is not a readable regular file: $f (deleted from the work tree without staging, permission-denied, or a non-regular type) - cannot verify it, failing closed."
      any_error=1
      continue
    fi
    scan_file "$f" && any_violation=0
  done

  [ "$any_error" -eq 1 ] && return 2
  [ "$any_violation" -eq 0 ] && return 1
  return 0
}

# self_relative_path -> prints this script's OWN path relative to the git
# work tree root, so scan_tree can exclude it. Derived from $0 rather than
# hardcoded so a future rename/move keeps this correct without a second
# edit; falls back to printing nothing (no exclusion) if git or `$0`'s
# directory can't be resolved - a missing exclusion only means this script's
# own comments and code get scanned too, which fails safe (worst case: a
# false-positive on this file, never a missed real leak).
self_relative_path() {
  local abs root
  abs="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")" || return
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || return
  case "$abs" in
    "$root"/*) printf '%s' "${abs#"$root"/}" ;;
  esac
}

# ---------------------------------------------------------------------------
# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  fail=0
  total_cases=0
  EXPECTED_CASES=22

  case "$0" in
    */*) SELF="$0" ;;
    *) SELF="./$0" ;;
  esac
  SELF_ABS="$(cd "$(dirname "$SELF")" && pwd)/$(basename "$SELF")"

  mkrepo() { # -> prints a fresh scratch git repo dir with no tracked files yet
    local d; d=$(mktemp -d)
    git init -q "$d" >/dev/null
    git -C "$d" -c user.email=t@t -c user.name=t config commit.gpgsign false >/dev/null
    printf '%s' "$d"
  }

  # check LABEL WANT(pass|fail) REPO_DIR - runs the real production script
  # (via $SELF_ABS, absolute-pathed so PATH overrides below can't break the
  # interpreter lookup itself) against REPO_DIR's currently-staged tree.
  # Leaves the script's stdout+stderr in the global $LAST_OUT for callers
  # that need to assert on the message content, rather than returning it via
  # `$(check ...)` - that form runs `check` itself inside a command-
  # substitution SUBSHELL, so its `total_cases=$((total_cases + 1))` would
  # increment a copy that vanishes when the subshell exits, silently
  # underclaiming the case count (measured while writing this suite - the
  # exact "case disappears without the tally noticing" shape CLAUDE.md warns
  # about elsewhere in this repo, reproduced here on the first attempt).
  LAST_OUT=""
  check() {
    total_cases=$((total_cases + 1))
    local label="$1" want="$2" repo="$3" rc
    LAST_OUT=$(cd "$repo" && bash "$SELF_ABS" 2>&1)
    rc=$?
    if { [ "$want" = pass ] && [ "$rc" -eq 0 ]; } || { [ "$want" = fail ] && [ "$rc" -ne 0 ]; }; then
      :
    else
      echo "SELFTEST FAIL: $label -> rc=$rc (want $want)"
      printf '%s\n' "$LAST_OUT" | sed 's/^/    /'
      fail=1
    fi
  }

  add() { # REPO REL_PATH CONTENT - writes CONTENT to REPO/REL_PATH and stages it
    local repo="$1" rel="$2" content="$3"
    mkdir -p "$repo/$(dirname "$rel")"
    printf '%s\n' "$content" > "$repo/$rel"
    git -C "$repo" add -A >/dev/null 2>&1
  }

  # --- 1-6: clean trees must pass, including every documented placeholder ---
  r=$(mkrepo); add "$r" README.md 'nothing sensitive here'
  check "1  ordinary clean file" pass "$r"

  r=$(mkrepo); add "$r" docs/a.md 'placeholder: <repo>/CLAUDE.md and <scratchpad>/notes.txt'
  check "2  bracket placeholders (<repo>, <scratchpad>)" pass "$r"

  r=$(mkrepo); add "$r" docs/b.md 'example path: /home/user/project or /home/users/shared'
  check "3  allowlisted linux tokens (user, users)" pass "$r"

  r=$(mkrepo); add "$r" docs/c.md 'macOS: /Users/you/Downloads ; runner: /home/runner/work/repo'
  check "4  allowlisted you/runner tokens" pass "$r"

  r=$(mkrepo); add "$r" docs/d.md 'windows: C:\Users\USER\AppData'
  check "5  allowlisted windows USER token" pass "$r"

  r=$(mkrepo); add "$r" docs/e.md 'env forms never reach the extractor: $HOME, ~/.claude, /home/$USER, /home/<user>'
  check "6  \$HOME / \$USER / <user> forms never match the char class" pass "$r"

  # --- 7-11: one genuine violation per class must fail ---
  r=$(mkrepo); add "$r" docs/f.md 'run: cd /home/alice/sail_command && npm test'
  check "7  linux home leak" fail "$r"
  case "$LAST_OUT" in *"docs/f.md:1:linux-home:/home/alice"*) ;; *) echo "SELFTEST FAIL: 7 message did not name file:line:class:match -> $LAST_OUT"; fail=1 ;; esac

  r=$(mkrepo); add "$r" docs/g.md 'run: cd /Users/alice/sail_command && npm test'
  check "8  macos home leak" fail "$r"

  r=$(mkrepo); add "$r" docs/h.md 'run: cd C:\Users\alice\sail_command'
  check "9  windows home leak" fail "$r"

  r=$(mkrepo); add "$r" docs/i.md 'scratch: /tmp/claude-1000/-home-alice-sail_command/91f5.../scratchpad'
  check "10 tmp-scratchpad leak" fail "$r"

  r=$(mkrepo); add "$r" docs/j.md 'transcripts under ~/.claude/projects/-home-alice-sail-command/'
  check "11 flattened-projects leak" fail "$r"

  # --- 12: multiple violations across multiple files must all be reported ---
  r=$(mkrepo)
  add "$r" docs/k.md 'cd /home/alice/repo'
  add "$r" docs/l.md 'cd /Users/bob/repo'
  check "12 two files, two violations, both reported" fail "$r"
  case "$LAST_OUT" in *docs/k.md*docs/l.md*|*docs/l.md*docs/k.md*) ;; *) echo "SELFTEST FAIL: 12 did not report both files -> $LAST_OUT"; fail=1 ;; esac

  # --- 13: violation mid-line, not path-only, still caught ---
  r=$(mkrepo); add "$r" docs/m.md 'See the log at /home/alice/logs/out.txt for details.'
  check "13 violation embedded mid-sentence" fail "$r"

  # --- 14: self-exclusion - a COPY of the real production script, planted
  # inside the scratch repo at the script's own repo-relative path (so that
  # copy's own $0 resolves against THIS repo's root, not the host's), must
  # NOT trip the guard on itself even though the file it copies contains
  # this whole selftest's worth of literal violating example strings (cases
  # 7-13/15-22's own `add` calls are string literals inside this very file).
  # Invoked by RELATIVE path from the repo root, not via $SELF_ABS - running
  # the host original against this repo would prove nothing about the
  # in-repo copy's self-exclusion.
  r=$(mkrepo)
  mkdir -p "$r/.github/scripts"
  cp "$SELF_ABS" "$r/.github/scripts/check-no-home-paths.sh"
  git -C "$r" add -A >/dev/null 2>&1
  total_cases=$((total_cases + 1))
  LAST_OUT=$(cd "$r" && bash .github/scripts/check-no-home-paths.sh 2>&1); rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "SELFTEST FAIL: 14 self-exclusion (in-repo copy of this script) -> rc=$rc (want 0)"
    printf '%s\n' "$LAST_OUT" | sed 's/^/    /'
    fail=1
  fi

  # --- 15-16: bounding negatives, so the classes above are not silently
  # over-broad (a "-home-" substring alone, or a truncated windows path,
  # must not fire).
  r=$(mkrepo); add "$r" docs/n.md 'see the welcome-home-page.md write-up'
  check "15 bare -home- substring outside claude-specific prefixes" pass "$r"

  r=$(mkrepo); add "$r" docs/o.md 'consult C:\Users\ for the profile root'
  check "16 truncated windows path (no name after the trailing backslash)" pass "$r"

  # --- 17: fail-closed - not a git repo at all ---
  r=$(mktemp -d)
  check "17 fail-closed: not a git repository" fail "$r"

  # --- 18: fail-closed - git repo with zero tracked files ---
  r=$(mkrepo)
  check "18 fail-closed: empty tracked-file list" fail "$r"

  # --- 19: fail-closed - a tracked path deleted from the work tree without
  # staging the deletion (git ls-files still reports it; reading it fails).
  # Portable and non-hanging, unlike a real FIFO or a chmod-000 file (which
  # behaves differently when the suite runs as root) - this reaches the
  # exact same "not a readable regular file" branch scan_tree uses for
  # every other unreadable-tracked-path shape.
  r=$(mkrepo); add "$r" docs/p.md 'clean content'
  rm -f "$r/docs/p.md"
  check "19 fail-closed: tracked file missing from work tree" fail "$r"

  # --- 20: fail-closed - git binary unavailable ---
  toolbox=$(mktemp -d)
  for b in bash grep sed cat mktemp dirname basename mapfile; do
    p=$(command -v "$b" 2>/dev/null) && ln -s "$p" "$toolbox/$b" 2>/dev/null
  done
  r=$(mkrepo); add "$r" README.md 'clean'
  total_cases=$((total_cases + 1))
  out=$(cd "$r" && PATH="$toolbox" bash "$SELF_ABS" 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "SELFTEST FAIL: 20 fail-closed: git binary missing -> rc=0 (want nonzero)"
    fail=1
  fi
  rm -rf "$toolbox"

  # --- 21: violation still caught alongside an allowlisted mention in the
  # SAME file, and the allowlisted one is not itself reported as a hit.
  r=$(mkrepo)
  add "$r" docs/q.md 'example /home/user/project is fine; but /home/alice/project leaked'
  check "21 real leak alongside an allowlisted mention, same file" fail "$r"
  case "$LAST_OUT" in
    *"linux-home:/home/user"*) echo "SELFTEST FAIL: 21 allowlisted mention was reported as a hit -> $LAST_OUT"; fail=1 ;;
  esac
  case "$LAST_OUT" in
    *"linux-home:/home/alice"*) ;;
    *) echo "SELFTEST FAIL: 21 real leak in same file was not reported -> $LAST_OUT"; fail=1 ;;
  esac

  # --- 22: multiple distinct violations on ONE line, all still reachable
  # (each class scans the whole line independently; nothing short-circuits
  # after the first class matches).
  r=$(mkrepo); add "$r" docs/r.md 'compare /home/alice/repo against /Users/alice/repo'
  check "22 two different classes on one line" fail "$r"
  case "$LAST_OUT" in *linux-home*Users* | *Users*linux-home*) ;; *) echo "SELFTEST FAIL: 22 did not report both classes -> $LAST_OUT"; fail=1 ;; esac

  if ! [ "$total_cases" -eq "$EXPECTED_CASES" ] 2>/dev/null; then
    echo "SELFTEST FAILURES: ran $total_cases cases, expected ${EXPECTED_CASES:-<unset/empty>} - a case was skipped or silently dropped"
    exit 1
  fi
  if [ "$fail" -eq 0 ]; then
    echo "SELFTEST OK"
  fi
  exit "$fail"
fi

# ---- production path ----
EXCLUDE="$(self_relative_path)"
out=$(scan_tree "$EXCLUDE")
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "::error::check-no-home-paths found problems (see below) - a tracked file may leak a contributor's local absolute path (home directory, per-user temp path, or the flattened ~/.claude/projects/ form). Replace it with a repo-relative placeholder such as <repo>, <scratchpad>, or <flattened-repo-path> (see chore/redact-home-paths for the pattern)."
  printf '%s\n' "$out"
  exit 1
fi
echo "check-no-home-paths: clean - no home paths found in tracked files."
exit 0
