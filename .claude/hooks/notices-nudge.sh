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
# Therefore this hook FAILS OPEN in CLAUDE.md's sense ("a BLOCKING guard should
# fail closed, a NUDGE should fail open"): whenever it cannot establish that a
# command is inert, it FIRES. Every degraded path in this file - unparseable
# input, no `jq`, no `python3` - fires rather than going silent. That is the
# only vocabulary used here; "fail closed" would mean the opposite.
#
# Concretely: FIRE BY DEFAULT. The trigger below is deliberately the same broad,
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
#     deliberate - it fires, which is the cheap direction. `$` is also the one
#     REDUNDANT member of the exclusion set: `$(...)` is already caught by `(`
#     and `` `...` `` by the backtick, and a bare `${VAR}` cannot invoke
#     anything. Kept as defence in depth, so a mutation removing it alone does
#     not fail the self-test - that is expected, not an untested gap.
#   * What the self-test's mutation coverage actually is, so the header does
#     not claim more than it delivers: dropping `\n`, `&`, `;`, `|` or the
#     backtick from the exclusion set each FAILS the self-test, as does adding
#     any of grep/rg/sed/find/xargs/awk to the allowlist. Dropping `$`, or any
#     ONE of `(` `)` `<` `>`, does NOT - `$` is redundant (above), and those
#     four are MUTUALLY redundant, since process substitution needs both a
#     paren and an angle bracket, so removing one leaves the other covering it.
#     Genuine redundancy, not a hole; dropping the whole group would fail.
#   * Suppression covers the `echo`/`cat` mention shapes only. It does NOT
#     suppress the misfire actually reported in #216 (a multi-line `gh api`
#     call whose heredoc PROSE mentioned npm and install). Suppressing that
#     safely needs heredoc awareness, i.e. the parser that sank PR #233.
#
# ---------------------------------------------------------------------------
# TWO CONSTRAINTS ON MOVING THIS CODE:
#
#   * BASH, not sh - for EXACTLY ONE reason: `_provably_inert` uses `[[ ... ]]`
#     with an ANSI-C `$'...'` bracket set. `_triggers`' `[!a-zA-Z0-9]` is NOT a
#     reason: bracket negation with `!` is POSIX and works in dash
#     (`[^...]` would be the bashism). Verified:
#         $ dash -c 'case "npm ci;x" in *npm*\ ci[!a-zA-Z0-9]*) echo FIRE;; esac'
#         FIRE
#         $ dash -c '[[ "a;b" == *[";"]* ]]'
#         dash: 1: [[: not found
#     settings.json invokes this file directly, so the shebang wins. Do NOT
#     paste `_provably_inert` back inline into settings.json, where the hook
#     command may run under `sh`.
#   * settings.json resolves this script through $CLAUDE_PROJECT_DIR (same as
#     premerge-verify.sh). settings.json and this file travel in the SAME
#     commit, so a checkout can never have one without the other - but a
#     LOCALLY DIRTY settings.json pointing here from a branch that predates
#     this script would make the hook silently do nothing. If you ever split
#     them, restore an inline fallback first.
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
#
# THE COST OF THAT WIDENING, NAMED (it is not free):
# `[!a-zA-Z0-9]` also admits `.` `-` `_` `/` `,`, so any ` i`/` ci`/` rm`/
# ` up`/` add` token followed by punctuation now fires. Measured, old vs new:
#     npm --prefix app run test -- rm.test.ts       old=skip  new=FIRE
#     npm --prefix app run test -- i.test.ts        old=skip  new=FIRE
#     npm --prefix app run test -- ci.spec.ts       old=skip  new=FIRE
#     npm --prefix app run build 2>&1 | tee i.log   old=skip  new=FIRE
# CLAUDE.md's per-file filter convention (`npm --prefix app run test --
# <filter>`) makes that the single most common Bash command in this repo, so
# this lands on a hot path. Accepted within the asymmetry - a false nudge costs
# a line, a missed `npm ci` costs a red CI - but recorded rather than left for
# someone to rediscover.
#
# Do NOT "fix" it by suppressing `npm ... run ...`: an npm script, or a
# `pre`/`post` hook, can itself shell out to `npm install`, so that suppression
# would manufacture exactly the under-fire class this file spends its budget
# proving absent.
#
# KNOWN RESIDUAL, deliberately not fixed: the separator BEFORE a short
# subcommand is still a literal space, so a TAB does not fire -
#     $'npm\tci'  ->  skip        ($'npm\tinstall' still fires, via *npm*install*)
# Pre-existing (the old inline pattern missed it too), so the hard invariant is
# untouched. The available fix, `*npm*[!a-zA-Z0-9]ci[!a-zA-Z0-9]*`, widens the
# LEADING separator too and would newly fire on ordinary paths like
# `run test -- foo.ci.ts`; given nobody in this repo types a tab inside a
# command, that trade buys nothing on the hot path already named above.
_triggers() {
  # SC2221/SC2222: several alternatives subsume each other (*npm*install* also
  # matches *npm*uninstall*). Harmless - every alternative has the same body -
  # and kept verbatim so the trigger is byte-identical to the inline hook.
  #
  # #313: `npm audit fix` and `npm dedupe` (incl. their `--prefix` variants)
  # both rewrite package-lock.json silently, same as the alternatives already
  # here, so they get the same exact-or-boundary shape as the short-subcommand
  # alternatives above (`\ ci|\ ci[!a-zA-Z0-9]*` etc), NOT the unbounded
  # `*npm*...*` shape `install`/`uninstall`/`update` use - "audit fix"/"dedupe"
  # are ordinary words that can appear as a PREFIX of something else (e.g.
  # this repo's own `test-fixtures/`), so an unbounded trailing `*` would also
  # fire on "audit fixture", a mention that happens to share the prefix. This
  # is a pure alternation ADDITION - monotonic per the file-header argument
  # above (can only widen firing, never narrow it).
  # shellcheck disable=SC2221,SC2222
  case "$1" in
    *npm*install*|*npm*uninstall*|*npm*update*|*npm*\ ci|*npm*\ ci[!a-zA-Z0-9]*|*npm*\ add|*npm*\ add[!a-zA-Z0-9]*|*npm*\ i|*npm*\ i[!a-zA-Z0-9]*|*npm*\ rm|*npm*\ rm[!a-zA-Z0-9]*|*npm*\ remove|*npm*\ remove[!a-zA-Z0-9]*|*npm*\ up|*npm*\ up[!a-zA-Z0-9]*|*npm*\ audit\ fix|*npm*\ audit\ fix[!a-zA-Z0-9]*|*npm*\ dedupe|*npm*\ dedupe[!a-zA-Z0-9]*) return 0 ;;
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
  tab=$'\t'
  # Counted independently of the generator arrays below, so a case that
  # silently disappears - a `check` line deleted, or an array element
  # (invocations/wrappers/nearmiss/d_pres/d_subs/d_tails) shrunk - cannot
  # leave this suite reporting `SELFTEST OK` having covered less than it
  # claims to (PR #350 review, Finding 3, extended past the docs-only
  # classifier it was raised against - "in every selftest that reports a
  # tally"). The array-length constants are asserted against the LITERAL
  # arrays right after each is defined below, independently of the loops
  # that consume them - deriving "expected" from the same array a loop
  # iterates would be the exact equivalence-test tautology CLAUDE.md warns
  # against (an expectation computed from the thing under test always
  # matches it).
  check_calls=0
  EXPECTED_CHECK_CALLS=55
  check() { # want  desc  cmd
    check_calls=$((check_calls + 1))
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

  # --- The two shapes the hand-written table above structurally cannot see.
  # --- Every other newline case here also contains `<` or leads with a word
  # --- that is not on the allowlist, so `$'\n'` inside _provably_inert's
  # --- bracket set was pinned by NOTHING: deleting it left SELFTEST OK while
  # --- introducing an under-fire on multi-line Bash calls, the most common
  # --- shape in this repo. Same for a bare `&`.
  check fire "newline is the ONLY metachar, echo first" "echo starting build${nl}npm ci"
  check fire "bare & is the ONLY metachar, echo first"  "echo a & npm ci"

  # --- The widening's named over-fire class, pinned so it stays a KNOWN cost
  # --- rather than drifting into an unnoticed one (see the header block).
  check fire "OVER-FIRE (accepted): run test -- rm.test.ts" "npm --prefix app run test -- rm.test.ts"
  check fire "OVER-FIRE (accepted): run test -- i.test.ts"  "npm --prefix app run test -- i.test.ts"
  check skip "hot path WITHOUT punctuation still quiet"     "npm --prefix app run test -- invariants"

  # --- #313: npm audit fix / npm dedupe also rewrite package-lock.json
  # --- silently and must fire, including the repo-convention --prefix form.
  check fire "npm audit fix"                   "npm audit fix"
  check fire "npm --prefix app audit fix"      "npm --prefix app audit fix"
  check fire "npm dedupe"                      "npm dedupe"
  check fire "npm --prefix app dedupe"         "npm --prefix app dedupe"
  # --- #313 mention-not-invocation: each new trigger has an echo-mention
  # --- counterpart that MUST stay suppressed via _provably_inert, isolating
  # --- the invocation-vs-mention distinction per the #216 lesson (a row must
  # --- carry no OTHER construct - here, no metachar from the exclusion set -
  # --- that could independently cause the same skip).
  check skip "echo mentioning npm audit fix"   'echo "run npm audit fix first"'
  check skip "echo mentioning npm dedupe"      'echo "run npm dedupe first"'
  # --- #313 boundary guard: "audit fix"/"dedupe" get the SAME
  # --- exact-or-[!a-zA-Z0-9]-boundary shape as the other short subcommands
  # --- (ci/add/i/rm/remove/up), not the unbounded `*npm*...*` shape - this
  # --- repo says "fixture" constantly (`app/public/test-fixtures/`, the
  # --- `pree2e`-regenerated wind fixture), so an unbounded trailing `*`
  # --- would fire on a plain npm-test-filter mention of it. This is
  # --- produced by `_triggers` itself returning skip (no `\ audit\ fix`
  # --- suffix and no `[!a-zA-Z0-9]` char after it - "t" in "fixtures" is
  # --- alnum) - `_provably_inert` is never reached, since the command's
  # --- first word is `npm`, not echo/printf/cat, so it could not be the
  # --- mechanism producing this skip.
  check skip "boundary guard: audit fixtures is not audit fix" "npm run test -- audit fixtures"

  # --- Known residual: tab before a short subcommand does not fire (header).
  check skip "RESIDUAL: tab before ci"         "npm${tab}ci"
  check fire "tab before install still fires"  "npm${tab}install"

  # =========================================================================
  # GENERATED CORPORA - the load-bearing evidence, made re-runnable.
  #
  # These were originally throwaway scripts whose results lived only in a PR
  # description. The generators are folded in here so the hard invariant and
  # the superset claim can be re-checked by anyone, later, without the PR.
  #
  # What they do NOT cover, stated so the table is not over-read:
  #   * Loops A-C drive the PURE `decide()`. The stdin->JSON->stdout wrapper
  #     and the degraded no-`jq`/no-`python3` path get four smoke rows in D,
  #     enough to kill an `IN=$(cat)` regression - not a full matrix. An
  #     unparseable-stdin payload is covered by hand only.
  #   * TAB as a separator before a short subcommand (see the residual above).
  #   * Nothing runs `--selftest` in CI - `.claude/` is outside ci.yml's
  #     scope - so this is a maintainer-run check, not a gate.
  # =========================================================================

  # ---- A. hard invariant: a real invocation always fires, in any context ----
  invocations=(
    "npm install" "npm i" "npm ci" "npm add left-pad" "npm uninstall left-pad"
    "npm remove left-pad" "npm rm left-pad" "npm update" "npm up"
    "npm --prefix app install" "npm --prefix app ci" "npm -w app install"
    "npm install --save-dev vitest" "npm ci --omit=dev"
    # #313
    "npm audit fix" "npm --prefix app audit fix" "npm dedupe" "npm --prefix app dedupe"
  )
  # shellcheck disable=SC2016  # literal $( ) and backticks ARE the test data
  wrappers=(
    "%s" "  %s" "sudo %s" "CI=1 %s" "(%s)" "{ %s; }"
    "git status && %s" "%s && git status" "git status; %s" "%s; git status"
    "false || %s" "%s | tee /tmp/log" "%s &"
    $'git status\n%s' $'%s\ngit status'
    $'cat > /tmp/n.md <<EOF\nprose\nEOF\n%s'
    $'cat > /tmp/n.md <<\\EOF\nprose\nEOF\n%s'
    $'cat > /tmp/n.md <<\'EOF\'\nprose\nEOF\n%s'
    $'cat > /tmp/n.md <<-EOF\n\tprose\n\tEOF\n%s'
    "echo starting && %s" "cat /etc/hostname && %s"
    'echo "$(%s)"' 'echo `%s`' "cat <(%s)" "printf '%%s' hi; %s"
    "%s > /tmp/out 2>&1" "time %s" "npx foo; %s"
  )
  EXPECTED_INVOCATIONS=18
  EXPECTED_WRAPPERS=28
  if [ "${#invocations[@]}" -ne "$EXPECTED_INVOCATIONS" ] || [ "${#wrappers[@]}" -ne "$EXPECTED_WRAPPERS" ]; then
    echo "SELFTEST FAIL [array size]: invocations=${#invocations[@]} (want $EXPECTED_INVOCATIONS), wrappers=${#wrappers[@]} (want $EXPECTED_WRAPPERS) - an array shrank or grew without updating the pinned constant"
    fail=1
  fi
  gen_a=0
  for inv in "${invocations[@]}"; do
    for w in "${wrappers[@]}"; do
      # shellcheck disable=SC2059  # $w IS the format string, by construction
      cmd=$(printf "$w" "$inv")
      gen_a=$((gen_a + 1))
      if [ "$(decide "$cmd")" != fire ]; then
        echo "SELFTEST FAIL [hard invariant]: real invocation did not fire -> <<$(printf '%s' "$cmd" | tr '\n\t' '~>')>>"
        fail=1
      fi
    done
  done

  # ---- B. near-misses: shapes that LOOK suppressible but must still fire ----
  # This is where a mention-vs-invocation error in THIS fix's own first-word
  # matcher would show up - the defect class the fix exists to close.
  # shellcheck disable=SC2016  # literal $( ) and backticks ARE the test data
  nearmiss=(
    'echo hi; npm install'          'echo hi && npm ci'      'echo hi | npm install'
    'echo "$(npm ci)"'              'echo `npm ci`'          'cat <(npm ci)'
    'cat /tmp/x > /tmp/y; npm ci'   $'echo hi\nnpm ci'       '(echo hi) && npm ci'
    'ECHO=1 echo npm install; npm ci'
    'echoes npm install'            'cats npm install'
    './echo npm install'            '/bin/echo npm install'  'FOO=bar echo npm install'
    # Allowlist MEMBERSHIP, pinned: every one of these is a text-search tool
    # that CAN execute a program (rg --pre, find -exec, sed`s `e`, awk`s
    # system(), xargs), which is exactly why none is on the allowlist. Without
    # these rows, adding any of them survives the whole table.
    #
    # Each row must carry NO character from _provably_inert's exclusion set, or
    # it kills the mutant for the wrong reason: the exclusion does the work and
    # allowlist membership is never exercised. `xargs npm install < pkgs.txt`
    # had exactly that bug - the `<` alone disqualified it, so adding `xargs`
    # to the allowlist survived the whole battery while a real, metachar-free
    # `xargs npm install` would have been silently suppressed.
    #
    # `awk` is the same trap one step further: an INLINE program
    # (`awk "BEGIN{system(...)}"`) always carries parens, so such a row can
    # never test membership either. `-f progfile` is the honest vector - the
    # `system()` call lives in the FILE, and the command line is metachar-free.
    'grep -rn "npm install" .'      'rg --pre npm install .'
    'sed -e "e npm ci" notes.txt'   'find . -name x -exec npm install {} +'
    'xargs npm install'             'awk -f run-npm-install.awk pkgs.txt'
  )
  EXPECTED_NEARMISS=21
  if [ "${#nearmiss[@]}" -ne "$EXPECTED_NEARMISS" ]; then
    echo "SELFTEST FAIL [array size]: nearmiss=${#nearmiss[@]} (want $EXPECTED_NEARMISS) - an array shrank or grew without updating the pinned constant"
    fail=1
  fi
  for cm in "${nearmiss[@]}"; do
    if [ "$(decide "$cm")" != fire ]; then
      echo "SELFTEST FAIL [near-miss]: suppressed something not provably inert -> <<$(printf '%s' "$cm" | tr '\n' '~')>>"
      fail=1
    fi
  done

  # ---- C. differential: the widened trigger is a SUPERSET of the legacy one --
  # The legacy pattern is reproduced verbatim from the inline hook this script
  # replaced. If any input fires LEGACY but not the current `_triggers`, the
  # widening stopped being widening-only and the hard invariant is at risk.
  _triggers_legacy() {
    # shellcheck disable=SC2221,SC2222
    case "$1" in
      *npm*install*|*npm*uninstall*|*npm*update*|*npm*\ ci|*npm*\ ci\ *|*npm*\ add|*npm*\ add\ *|*npm*\ i|*npm*\ i\ *|*npm*\ rm|*npm*\ rm\ *|*npm*\ remove|*npm*\ remove\ *|*npm*\ up|*npm*\ up\ *) return 0 ;;
    esac
    return 1
  }
  # #313: "audit fix" and "dedupe" are new-only alternatives (absent from
  # _triggers_legacy below), so they never trip the superset FAIL branch -
  # they only ever contribute to `added`, extending the same generator loop
  # to the new alternatives rather than inventing a parallel structure.
  d_subs=(ci add i rm remove up install uninstall update run test build x "" "audit fix" dedupe)
  d_pres=("npm" "npm --prefix app" "sudo npm" "  npm" "echo npm" "git status && npm" "xnpm")
  d_tails=("" " " ";" ")" "|" "&&" "$nl" " left-pad" "x" "1" "-g" "$tab" "'" '"')
  EXPECTED_D_SUBS=16
  EXPECTED_D_PRES=7
  EXPECTED_D_TAILS=14
  if [ "${#d_subs[@]}" -ne "$EXPECTED_D_SUBS" ] || [ "${#d_pres[@]}" -ne "$EXPECTED_D_PRES" ] || [ "${#d_tails[@]}" -ne "$EXPECTED_D_TAILS" ]; then
    echo "SELFTEST FAIL [array size]: d_subs=${#d_subs[@]} (want $EXPECTED_D_SUBS), d_pres=${#d_pres[@]} (want $EXPECTED_D_PRES), d_tails=${#d_tails[@]} (want $EXPECTED_D_TAILS) - an array shrank or grew without updating the pinned constant"
    fail=1
  fi
  gen_c=0; only_legacy=0; added=0
  for p in "${d_pres[@]}"; do
    for s in "${d_subs[@]}"; do
      for t in "${d_tails[@]}"; do
        for sfx in "" " git status" "${nl}npm run build"; do
          cmd="$p $s$t$sfx"
          gen_c=$((gen_c + 1))
          if _triggers_legacy "$cmd"; then
            _triggers "$cmd" || {
              echo "SELFTEST FAIL [superset]: legacy fires, current does not -> <<$(printf '%s' "$cmd" | tr '\n\t' '~>')>>"
              fail=1; only_legacy=$((only_legacy + 1))
            }
          elif _triggers "$cmd"; then
            added=$((added + 1))
          fi
        done
      done
    done
  done

  # ---- D. the production WRAPPER, not just decide() ----------------------
  # Small but load-bearing: the one bug that actually shipped in this file was
  # `IN=$(cat)`, which needs an external `cat` and so read NOTHING when PATH
  # could not resolve it - a real `npm install` silently stopped firing. That
  # lives in the stdin->JSON->stdout wrapper, which loops A-C never touch, so
  # a mutation reintroducing it survives the entire battery above. These four
  # rows are the guard for exactly that regression class.
  wrapper_calls=0
  wrapper_check() { # want-fire(0|1)  desc  json-payload  [runner...]
    wrapper_calls=$((wrapper_calls + 1))
    local want="$1" desc="$2" payload="$3"; shift 3
    local out got=1
    out=$(printf '%s' "$payload" | "$@" "$0" 2>/dev/null)
    [ -n "$out" ] && got=0
    if [ "$got" != "$want" ]; then
      echo "SELFTEST FAIL [wrapper]: $desc -> fired=$got want=$want"
      fail=1
    fi
  }
  wrapper_check 0 "real invocation through the wrapper" '{"tool_input":{"command":"npm install left-pad"}}' bash
  wrapper_check 1 "inert command through the wrapper"   '{"tool_input":{"command":"git status"}}' bash
  # These two rows are conditional on the environment (a machine without
  # /bin/bash cannot run the "degraded" scenario at all), so the expected
  # wrapper-call count below is computed to match rather than pinned as a
  # single literal - EXPECTED_WRAPPER_CALLS reflects the SAME condition,
  # not a re-derivation from wrapper_calls itself.
  EXPECTED_WRAPPER_CALLS=2
  if [ -x /bin/bash ]; then
    # Degraded: neither jq nor python3 (nor `cat`) resolvable. Must still fire
    # on a real invocation, and must NOT nudge on every Bash call.
    wrapper_check 0 "degraded: npm ci still fires" '{"tool_input":{"command":"npm ci"}}' env PATH=/nonexistent /bin/bash
    wrapper_check 1 "degraded: git status quiet"   '{"tool_input":{"command":"git status"}}' env PATH=/nonexistent /bin/bash
    EXPECTED_WRAPPER_CALLS=4
  fi
  if [ "$wrapper_calls" -ne "$EXPECTED_WRAPPER_CALLS" ]; then
    echo "SELFTEST FAIL [wrapper count]: wrapper_calls=$wrapper_calls (want $EXPECTED_WRAPPER_CALLS for this environment) - a wrapper_check row was skipped or dropped"
    fail=1
  fi

  # Pinned so a case that silently disappears from the hand-written table
  # (check_calls) cannot leave the suite reporting `SELFTEST OK` having run
  # fewer cases than it claims to (PR #350 review, Finding 3). The
  # generator-loop counts (gen_a, nearmiss, gen_c) are already guarded
  # independently above via the pinned array-length constants - re-checking
  # them here against a value derived from the SAME loop would be the
  # equivalence-test tautology CLAUDE.md warns against.
  if [ "$check_calls" -ne "$EXPECTED_CHECK_CALLS" ]; then
    echo "SELFTEST FAIL [check count]: check_calls=$check_calls (want $EXPECTED_CHECK_CALLS) - a check() row was skipped or dropped"
    fail=1
  fi

  if [ "$fail" -eq 0 ]; then
    echo "generated: ${gen_a} invocation shapes, ${#nearmiss[@]} near-misses, ${gen_c} differential inputs (legacy-only=${only_legacy}, newly-fired=${added})"
    echo "SELFTEST OK"
  fi
  exit "$fail"
fi

# ---- production path ----
# Slurp stdin with the `read` BUILTIN, never `IN=$(cat)`. `cat` is external, so
# on a machine whose PATH cannot resolve it the command substitution yields an
# empty string and this hook silently decides on nothing - an under-fire, the
# one direction that is out of bounds. Measured: with PATH unset, `IN=$(cat)`
# made a real `npm install` stop firing. `read -d ''` has no such dependency.
IN=""
IFS= read -r -d '' IN || true
if CMD=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null); then
  :
elif CMD=$(printf '%s' "$IN" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tool_input",{}).get("command") or "")' 2>/dev/null); then
  :
else
  # FAIL OPEN (CLAUDE.md: "a BLOCKING guard should fail closed, a NUDGE should
  # fail open"). This hook is a nudge, so failing open means it KEEPS FIRING
  # when it cannot verify - it never goes silent on a possible dependency
  # change. That is the one direction used throughout this file; the words
  # "fail closed" appear nowhere, because they would describe the opposite.
  #
  # Degrade with the information still on hand rather than throwing it away:
  # decide on the RAW stdin blob. This stays a strict superset of the parsed
  # path - the blob contains the command text verbatim (JSON escaping only ever
  # INSERTS backslashes, which are themselves `[!a-zA-Z0-9]`, so a trigger can
  # only become easier to match), and the blob's first word is `{"tool_input"`,
  # never echo/printf/cat, so `_provably_inert` can never suppress it. It
  # cannot introduce an under-fire, and it stops the hook nudging on 100% of
  # Bash calls (`git status` included) on a machine with neither tool.
  if [ "$(decide "$IN")" = fire ]; then
    emit "$NUDGE (Note: the notices guard could not parse this tool input - neither jq nor python3 is usable - so it matched the raw input instead. Install jq to restore precision.)"
  fi
  exit 0
fi

[ "$(decide "$CMD")" = fire ] && emit "$NUDGE"
exit 0
