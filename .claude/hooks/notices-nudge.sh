#!/usr/bin/env bash
# PostToolUse Bash nudge: "npm changed dependencies -> regenerate
# app/public/THIRD-PARTY-NOTICES.txt". SailCommand #216.
#
# ---------------------------------------------------------------------------
# DESIGN: this hook is a NUDGE, not a blocker, so it is designed around its
# ASYMMETRY (CLAUDE.md, "Design a guard around its ASYMMETRY").
#
#   over-firing  -> one extra line of output. Cheap.
#   under-firing -> a dependency bump lands with a stale
#                   THIRD-PARTY-NOTICES.txt and CI reds ~10 min later at
#                   `git diff --exit-code`. Expensive, and it is the exact
#                   thing this hook exists to prevent.
#
# Therefore: FIRE BY DEFAULT. The trigger below is deliberately the same broad,
# unanchored substring soup it has always been. What is new is a SUPPRESSION
# allowlist of a few command shapes that are *provably* incapable of running
# npm at all. Anything not provably inert still fires.
#
# This is deliberately NOT the approach of the closed PR #233, which tried to
# ANCHOR the match on an invocation. That needs a real shell tokenizer: an
# ordinary `<<\EOF` heredoc made its scanner swallow a trailing real command,
# so a genuine `npm ci` silently stopped firing - the worse failure direction.
# Nothing here strips, rewrites, or re-segments the command string, so no
# parsing bug in this file can remove a fire; the only new logic can suppress
# a fire, and only for the enumerated shapes proven below.
#
# ---------------------------------------------------------------------------
# THE SUPPRESSION PROOF (re-run the original mention-vs-invocation defect class
# against this file's own matcher, per CLAUDE.md "a fix INHERITS its bug's
# blind spot"):
#
# A command is suppressed only when BOTH hold:
#   (a) its first word is literally `echo`, `printf` or `cat`; and
#   (b) it contains NONE of:  newline  &  ;  |  `  $  (  )  <  >
#
# Can such a command invoke npm? Enumerating every bash construct that can
# introduce a second command word:
#   command separators / lists  ; & && | ||        -> excluded by (b)
#   newline-separated commands                      -> excluded by (b)
#   command substitution        $(...)  `...`       -> excluded by (b)
#   arithmetic/parameter expansion that could name
#     a command                 $VAR ${...}         -> excluded by (b) ($)
#   process substitution        <(...)  >(...)      -> excluded by (b)
#   heredoc / redirection       << <<< < >          -> excluded by (b)
#   subshell / group            (...)  {...;}       -> excluded by (b)
#                                                      ( ) and the required ;
#   the command word itself                         -> excluded by (a):
#     `echo`, `printf` and `cat` cannot execute another program. None has an
#     --exec/--filter/preprocessor option (unlike e.g. `find -exec`,
#     `xargs`, GNU `sed`'s `e`, `awk`'s system(), `rg --pre`), which is why
#     those are NOT on the allowlist.
# Every `npm` in such a command is therefore an ARGUMENT - a mention - never a
# command word.
#
# Residuals, stated rather than hidden:
#   * If `echo`/`printf`/`cat` has been redefined as a shell function or alias
#     that itself runs npm, the proof does not hold. Accepted: the hook only
#     ever sees command TEXT, and a machine in that state has larger problems.
#   * A `$`-containing `echo` (e.g. `echo "$FOO"`) is NOT suppressed. That is
#     deliberate - it fires, which is the cheap direction.
#   * Suppression covers the `echo`/`cat` mention shapes only. It does NOT
#     suppress the misfire actually reported in #216 (a multi-line `gh api`
#     call whose heredoc PROSE mentioned npm and install). Suppressing that
#     safely needs heredoc awareness, i.e. the parser that sank PR #233.
#
# Offline self-test of the pure decision logic:
#   .claude/hooks/notices-nudge.sh --selftest
# ---------------------------------------------------------------------------
set -uo pipefail

NUDGE='npm changed dependencies. Regenerate third-party notices: npm --prefix app run notices - CI fails on any drift in app/public/THIRD-PARTY-NOTICES.txt. Run it before committing.'

# The message is embedded verbatim in JSON: keep it free of " and \.
emit() { printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$1"; }

# ---- pure decision logic (no I/O, unit-testable via --selftest) ----

# Broad, deliberately unanchored trigger. Never narrow it; widening it is
# always safe (over-firing is the cheap direction).
#
# Widened once, relative to the inline hook this script replaced: the
# short-subcommand alternatives used to be `*npm*\ ci|*npm*\ ci\ *`, i.e. they
# required end-of-string or a literal SPACE after the subcommand. Measured
# consequence - these REAL invocations did not fire:
#     "npm ci\ngit status"   "npm ci; git status"   "(npm ci)"
# The trailing `\ *` alternative is now `[!a-zA-Z0-9]*`, which accepts any
# non-word character (newline, ; ) | & etc.) as well as a space. Space is a
# member of that class, so the new alternative is a strict SUPERSET of the old
# one for every subcommand - the change can only ever add fires, never remove
# one. The install/uninstall/update alternatives are already maximally broad
# and are untouched.
_triggers() {
  # SC2221/SC2222: several alternatives subsume each other (*npm*install* also
  # matches *npm*uninstall*). Harmless - every alternative has the same body -
  # and kept verbatim so the trigger is byte-identical to the inline hook.
  # shellcheck disable=SC2221,SC2222
  case "$1" in
    *npm*install*|*npm*uninstall*|*npm*update*|*npm*\ ci|*npm*\ ci[!a-zA-Z0-9]*|*npm*\ add|*npm*\ add[!a-zA-Z0-9]*|*npm*\ i|*npm*\ i[!a-zA-Z0-9]*|*npm*\ rm|*npm*\ rm[!a-zA-Z0-9]*|*npm*\ remove|*npm*\ remove[!a-zA-Z0-9]*|*npm*\ up|*npm*\ up[!a-zA-Z0-9]*) return 0 ;;
  esac
  return 1
}

# The suppression allowlist. Returns 0 only for shapes proven inert above.
_provably_inert() {
  local cmd="$1" rest first
  # (b) no character that can introduce another command word.
  [[ $cmd == *[$'\n&;|`$()<>']* ]] && return 1
  # (a) first word, after any leading whitespace. An env/sudo prefix
  #     (`FOO=bar echo ...`) therefore does NOT qualify - it fires.
  rest=${cmd#"${cmd%%[![:space:]]*}"}
  first=${rest%%[[:space:]]*}
  case "$first" in echo|printf|cat) return 0 ;; esac
  return 1
}

# echoes exactly "fire" or "skip"
decide() {
  _triggers "$1" || { echo skip; return; }
  _provably_inert "$1" && { echo skip; return; }
  echo fire
}

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

  # --- MUST FIRE: a real dependency-changing invocation. A failure here is a
  # --- hard-invariant violation, not a tuning question.
  check fire "bare npm install"                "npm install"
  check fire "bare npm ci"                     "npm ci"
  check fire "npm install with a package"      "npm install express"
  check fire "repo convention --prefix"        "npm --prefix app install left-pad"
  check fire "after &&"                        "git status && npm install"
  check fire "on a second line"                "git status${nl}npm install"
  check fire "after a <<EOF heredoc"           "cat > /tmp/n.md <<EOF${nl}see npm docs${nl}EOF${nl}npm install"
  check fire "after a <<\\EOF heredoc"         "cat > /tmp/n.md <<\\EOF${nl}see npm docs${nl}EOF${nl}npm install"
  check fire "npm uninstall"                   "npm uninstall left-pad"
  check fire "npm update"                      "npm update"
  check fire "npm add"                         "npm add left-pad"
  check fire "npm i"                           "npm i left-pad"
  check fire "npm rm"                          "npm rm left-pad"
  check fire "npm up"                          "npm up"
  check fire "sudo prefix"                     "sudo npm install -g pnpm"
  check fire "env prefix"                      "CI=1 npm ci"
  check fire "subshell"                        "(npm install)"
  check fire "backslash continuation"          "npm --prefix app \\${nl}  install left-pad"
  check fire "semicolon after echo"            "echo hi; npm install"
  # shellcheck disable=SC2016  # literal $( ) is the test input, not an expansion
  check fire "command substitution in echo"    'echo "$(npm install)"'
  check fire "process substitution in cat"     "cat <(npm install)"
  check fire "npm install inside a heredoc"    "cat <<EOF${nl}npm install${nl}EOF"

  # --- MAY SUPPRESS: provably inert mention shapes.
  check skip "echo mentioning npm install"     'echo "run npm install"'
  check skip "cat of a file whose NAME mentions it" "cat notes-mentioning-npm-install.md"
  check skip "printf mentioning npm update"    "printf 'npm update first'"
  check skip "leading whitespace + echo"       "   echo remember to npm i later"

  # --- SKIP: the trigger never matched in the first place (unchanged behaviour).
  check skip "git status"                      "git status"
  check skip "npm run build"                   "npm run build"
  check skip "npm typecheck"                   "npm --prefix app run typecheck"
  check skip "npm test with a filter"          "npm --prefix app run test -- invariants"
  check skip "empty command"                   ""

  # --- MUST FIRE: real invocations the pre-widening trigger MISSED, because it
  # --- demanded a literal space or end-of-string after a short subcommand.
  check fire "npm ci then newline"             "npm ci${nl}git status"
  check fire "npm ci then ;"                   "npm ci; git status"
  check fire "npm ci in a subshell"            "(npm ci)"
  check fire "npm ci piped"                    "npm ci | tee /tmp/log"
  check fire "npm rm then newline"             "npm rm left-pad${nl}git status"
  check fire "npm add then ;"                  "npm add left-pad; git status"
  check fire "npm up then newline"             "npm up${nl}git status"
  check fire "npm i then newline"              "npm i left-pad${nl}git status"
  check fire "npm remove then )"               "(npm remove left-pad)"

  # --- The widening must not turn a mention into a fire on its own: an echo
  # --- mentioning the newly-reachable shapes is still suppressed.
  check skip "echo mentioning npm ci; ..."     'echo "step 1: npm ci"'

  [ "$fail" -eq 0 ] && echo "SELFTEST OK"
  exit "$fail"
fi

# ---- production path ----
IN=$(cat)
if CMD=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null); then
  :
elif CMD=$(printf '%s' "$IN" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tool_input",{}).get("command") or "")' 2>/dev/null); then
  :
else
  # Fail CLOSED: could not read the command at all, so nudge unconditionally.
  emit "$NUDGE (Note: the notices guard could not parse this tool input - neither jq nor python3 is usable - so it is nudging unconditionally. Install jq to restore precision.)"
  exit 0
fi

[ "$(decide "$CMD")" = fire ] && emit "$NUDGE"
exit 0
