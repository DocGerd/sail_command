#!/usr/bin/env bash
# PreToolUse Bash guard: warn/block when app/public/test-fixtures/wind-sw12.json
# is dirty and about to be `git add`ed or `git commit`ed. SailCommand #235
# (narrowed scope - see the header of the closed PR #233 and issue #235 for
# the abandoned "anchor the match with a shell parser" road; this file does
# NOT attempt that. It is an extraction + one narrow suppression only).
#
# ---------------------------------------------------------------------------
# BACKGROUND: `pree2e` regenerates app/public/test-fixtures/wind-sw12.json
# with fresh timestamps on every e2e run (CLAUDE.md). CLAUDE.md says restore
# that churn, never commit it. This guard exists to catch a commit/stage of
# that fixture while it is dirty.
#
# DESIGN: unlike notices-nudge.sh (a NUDGE, asymmetric toward firing), the
# `git commit` branch of THIS guard BLOCKS (`permissionDecision: ask`). Per
# CLAUDE.md's guard-asymmetry rule ("a BLOCKING guard should fail closed, a
# NUDGE should fail open"), the commit branch fails CLOSED: any command shape
# this file cannot prove inert must still be treated as a possible `git
# commit`/`git add` and fire. Wrong in the "suppress" direction lets a real
# `git commit` slip past the check silently (expensive - a dirty fixture
# lands in a commit); wrong in the "fire" direction costs one extra prompt
# (cheap). The `git add` branch only ever emits a non-blocking
# `additionalContext` nudge, same asymmetry direction, lower cost either way.
#
# THE ONE SUPPRESSION ADDED HERE (ported verbatim from notices-nudge.sh's
# proven allowlist - see that file for the full proof, repeated only in
# summary below): a command is suppressed ONLY when BOTH hold:
#   (a) its first word is literally `echo`, `printf` or `cat`; and
#   (b) it contains NONE of:  newline  &  ;  |  `  $  (  )  <  >
# Those three commands cannot execute another program and (b) excludes every
# bash construct that could introduce a second command word (separators,
# command substitution, process substitution, heredoc/redirection, subshell/
# group). Every `git commit`/`git add` in such a command is therefore an
# ARGUMENT - a mention - never a command word.
#
# NOT ATTEMPTED (declared residual, matching notices-nudge.sh's own
# residual): heredoc PROSE mentioning "git commit"/"git add", and `gh api
# --input file.json` payloads whose body text mentions them, are NOT
# suppressed - they still fire. Suppressing those safely needs heredoc/shell
# awareness, i.e. the parser that sank PR #233 (6 Blockers across two
# rounds, 3 of round 2 being the SAME mention-vs-invocation defect class the
# fix existed to close - "a fix inherits its bug's blind spot"). That road is
# declined here, on purpose, for the second time.
#
# ---------------------------------------------------------------------------
# BASH, not sh - for the same reason as notices-nudge.sh: `_provably_inert`
# uses `[[ ... ]]` with an ANSI-C `$'...'` bracket set, which is a bashism.
# `.claude/settings.json` resolves this script through $CLAUDE_PROJECT_DIR
# and invokes it directly, so the shebang wins - do not paste this logic back
# inline into settings.json under a shell that might not be bash.
#
# THE #274 LIVENESS TRAP: extracting an inline hook into a standalone script
# creates a NEW failure mode a purely-inline hook never had - a script that
# cannot run cannot report that it cannot run. The call site in
# settings.json MUST liveness-check this file (`[ -f "$H" ] && [ -x "$H" ]`,
# emitting its OWN `ask` on failure) before `exec`ing it, exactly like the
# artifact-guard.sh call sites already do. Both tests are load-bearing: `-x`
# alone is true for a DIRECTORY, whereupon `exec` dies with 126 emitting
# nothing, and a non-blocking hook error lets the write proceed silently.
#
# Offline self-test of the pure decision logic PLUS the settings.json
# call-site liveness check (kept in sync with settings.json by the
# _CALLSITE variable below - update both together if either changes):
#   .claude/hooks/wind-fixture-guard.sh --selftest
# ---------------------------------------------------------------------------
set -uo pipefail

FIX='app/public/test-fixtures/wind-sw12.json'

ASK_REASON='wind-sw12.json has uncommitted changes (git commit -a would include them). pree2e regenerates this fixture with fresh timestamps - CLAUDE.md says restore it, not commit it (git restore app/public/test-fixtures/wind-sw12.json). Proceed only if the fixture change is intentional (generator changed).'
NUDGE_CONTEXT='wind-sw12.json is dirty - expected pree2e churn per CLAUDE.md. Restore with: git restore app/public/test-fixtures/wind-sw12.json instead of staging it, unless the change is intentional.'

emit_ask() { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$1"; }
emit_nudge() { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$1"; }

# ---- pure decision logic (no I/O, unit-testable via --selftest) ----

# Trigger patterns, reproduced BYTE-FOR-BYTE from the inline hook this script
# replaces (7692f30 already widened these to cover `git -C`/`git -c` compound
# forms - do not re-narrow them here).
_triggers_commit() {
  case "$1" in
    *git\ commit*|*git\ -C*commit*|*git\ -c*commit*) return 0 ;;
  esac
  return 1
}

_triggers_add() {
  case "$1" in
    *git\ add*|*git\ -C*add*|*git\ -c*add*) return 0 ;;
  esac
  return 1
}

# The suppression allowlist, ported verbatim from notices-nudge.sh's proven
# `_provably_inert` (see that file for the exhaustive proof of why no other
# command word can appear in a command satisfying both (a) and (b)).
_provably_inert() {
  local cmd="$1" rest first
  [[ $cmd == *[$'\n&;|`$()<>']* ]] && return 1
  rest=${cmd#"${cmd%%[![:space:]]*}"}
  first=${rest%%[[:space:]]*}
  case "$first" in echo|printf|cat) return 0 ;; esac
  return 1
}

# echoes exactly "commit", "add" or "skip". `commit` is checked before `add`,
# matching the original inline `case` statement's branch order (a case
# statement runs only its FIRST matching branch, so a command containing both
# "git add" and "git commit" substrings was always classified `commit` -
# preserved here on purpose, not incidental).
decide() {
  local cmd="$1"
  if _triggers_commit "$cmd"; then
    _provably_inert "$cmd" && { echo skip; return; }
    echo commit
    return
  fi
  if _triggers_add "$cmd"; then
    _provably_inert "$cmd" && { echo skip; return; }
    echo add
    return
  fi
  echo skip
}

# The settings.json PreToolUse:Bash call site for this hook, kept here
# verbatim so --selftest can exercise the SAME liveness-check shape it ships
# in settings.json without depending on settings.json's own JSON. Update
# both together if either changes.
_CALLSITE='H="${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/wind-fixture-guard.sh"; if [ -f "$H" ] && [ -x "$H" ]; then exec "$H" </dev/null; else echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"wind-fixture guard hook missing, not a regular file, or not executable - protection is inert; check .claude/hooks/wind-fixture-guard.sh exists and is executable.\"}}"; fi'

# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  fail=0
  nl=$'\n'
  check() { # want  desc  cmd
    local got; got=$(decide "$3")
    if [ "$got" != "$1" ]; then
      echo "SELFTEST FAIL: $2 -> got [$got] want [$1]"
      fail=1
    fi
  }

  # --- MUST FIRE (commit): preserved byte-for-byte from the inline hook. ---
  check commit "bare git commit"                    'git commit -m "msg"'
  check commit "git -C compound"                     'git -C /path commit -m x'
  check commit "git -c compound"                     'git -c user.name=x commit'
  check commit "compound after &&"                   'npm test && git commit -m x'
  check commit "commit on a later line"               "git status${nl}git commit -m x"

  # --- MUST FIRE (add): preserved byte-for-byte from the inline hook. ---
  check add "bare git add"                            'git add app/src/foo.ts'
  check add "git -C compound add"                     'git -C /path add foo'
  check add "git -c compound add"                     'git -c core.foo=bar add foo'
  check add "compound add after &&"                   'npm test && git add foo'

  # --- Priority: a command containing BOTH substrings resolves commit,     ---
  # --- matching the original case statement's first-match-wins order.     ---
  check commit "both add and commit present"          'git add foo && git commit -m x'

  # --- NEW: bare echo/printf/cat mentions are provably inert -> skip.      ---
  check skip "echo mentioning git commit"             'echo "remember to git commit"'
  check skip "printf mentioning git add"               "printf 'need to git add later'"
  check skip "cat of a file NAME mentioning git add"    'cat "notes mentioning git add.md"'
  check skip "leading whitespace + echo"                "   echo git commit later"

  # --- Near-miss: superficially echo/cat-shaped but NOT provably inert,    ---
  # --- so must still fire - this is the exact defect class PR #233 kept   ---
  # --- reintroducing into its own fix.                                    ---
  check commit "semicolon after echo"                  'echo hi; git commit -m x'
  # shellcheck disable=SC2016  # literal $( ) is the test input, not an expansion
  check commit "command substitution in echo"          'echo "$(git commit -m x)"'
  check add "first word is ./echo, not echo"           './echo git add foo'
  check commit "process substitution in cat"           'cat <(git commit -m x)'

  # --- SKIP: the trigger never matched in the first place (unchanged). ---
  check skip "git status"                              'git status'
  check skip "git log"                                 'git log --oneline'
  check skip "empty command"                           ''

  # ---- Liveness: the settings.json call-site guard (#274 trap). ----------
  # Constructs missing / non-executable / directory conditions at the hook
  # PATH and runs the actual _CALLSITE shell fragment against each, exactly
  # as settings.json would invoke it. All three must yield permissionDecision
  # "ask" - never a silent pass-through and never a bash exec error.
  _liveness_check() { # desc  kind(missing|nonexec|directory)
    local desc="$1" kind="$2" tmp out
    tmp=$(mktemp -d)
    mkdir -p "$tmp/.claude/hooks"
    case "$kind" in
      missing) : ;;
      nonexec) printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/.claude/hooks/wind-fixture-guard.sh" ;;
      directory) mkdir -p "$tmp/.claude/hooks/wind-fixture-guard.sh" ;;
    esac
    out=$(CLAUDE_PROJECT_DIR="$tmp" bash -c "$_CALLSITE" 2>/dev/null </dev/null)
    rm -rf "$tmp"
    case "$out" in
      *'"permissionDecision":"ask"'*) : ;;
      *) echo "SELFTEST FAIL [liveness]: $desc -> got [$out]"; fail=1 ;;
    esac
  }
  _liveness_check "missing hook file"            missing
  _liveness_check "non-executable hook file"     nonexec
  _liveness_check "directory at hook path"       directory

  if [ "$fail" -eq 0 ]; then
    echo "SELFTEST OK"
  fi
  exit "$fail"
fi

# ---- production path ----
CMD=$(jq -r '.tool_input.command // empty' 2>/dev/null)
case "$(decide "$CMD")" in
  commit)
    if [ -n "$(git -C "${CLAUDE_PROJECT_DIR:-.}" status --porcelain -- "$FIX" 2>/dev/null)" ]; then
      emit_ask "$ASK_REASON"
    fi
    ;;
  add)
    if [ -n "$(git -C "${CLAUDE_PROJECT_DIR:-.}" status --porcelain -- "$FIX" 2>/dev/null)" ]; then
      emit_nudge "$NUDGE_CONTEXT"
    fi
    ;;
esac
exit 0
