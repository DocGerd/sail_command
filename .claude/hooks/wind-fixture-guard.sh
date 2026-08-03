#!/usr/bin/env bash
# PreToolUse Bash guard: warn/block when app/public/test-fixtures/wind-sw12.json
# is dirty and about to be `git add`ed or `git commit`ed. SailCommand #235
# (narrowed scope - see the header of the closed PR #233 and issue #235 for
# the abandoned "anchor the match with a shell parser" road; this file does
# NOT attempt that. It is an extraction + one narrow suppression only).
#
# FIX WAVE (PR #333 review, B1/B2/M1/M2/n2): the first cut ported this file's
# COMMAND-SHAPE logic from the inline hook it replaces, and that logic held up
# under an independent 55-shape corpus. What it did NOT port was the FAIL-
# CLOSED INPUT HANDLING that `artifact-guard.sh` (this file's own stated
# model) already has - a guard whose command-shape matching is perfect is
# still useless if a broken dependency, bad stdin, or an unreachable `git`
# makes it decide on an empty string and stay silent. See "FAIL-CLOSED INPUT
# HANDLING" and "KNOWN SILENT-ALLOW PATHS" below for what changed and why.
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
# `additionalContext` nudge, same asymmetry direction, lower cost either way -
# WITH ONE DELIBERATE EXCEPTION, see "git query failure" below.
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
# FAIL-CLOSED INPUT HANDLING (PR #333 review B1 + M1): the FIRST cut of this
# file read `CMD=$(jq -r '.tool_input.command // empty' 2>/dev/null)` with no
# failure check at all. Measured (B1, against the real settings.json call
# site, a genuine `git commit` payload, and a DIRTY fixture - correct answer
# always `ask`): jq missing, jq exiting non-zero, empty stdin, malformed
# stdin, JSON lacking `tool_input`, and closed stdin (`/dev/null`) all landed
# on `rc=0 stdout=''` - SILENT, write proceeds. Ported (not invented) from
# `artifact-guard.sh:531-564`, this file's own stated model:
#   1. empty stdin (`[ -n "$IN" ]` BEFORE any parse attempt - `jq -r
#      '... // empty'` exits 0 on empty input, so a bare `||` chain never
#      fires on this case, per artifact-guard.sh's own comment on it);
#   2. a jq -> python3 fallback chain for the parse itself, asking only if
#      BOTH fail (this is a graceful DEGRADE, not a blanket "jq missing means
#      ask" - if python3 can still parse it, the real command shape decides,
#      same as it always did);
#   3. a separate `[ -n "$CMD" ]` check after a SUCCESSFUL parse - "JSON
#      without tool_input.command" is not a parse failure, so it must be
#      caught here, not folded into (2).
# M1 (git query failure, e.g. `git` missing, `CLAUDE_PROJECT_DIR` not a repo):
# BASE's `git -C "$CLAUDE_PROJECT_DIR" status --porcelain` had unredirected
# stderr; the first cut added `2>/dev/null` on both branches, turning a git
# failure into a TOTALLY silent allow (no diagnostic at all) where BASE at
# least printed `fatal: not a git repository`. Fixed with an explicit
# `git ... rev-parse --git-dir` gate BEFORE the status query - if git cannot
# even answer that, this guard cannot know whether the fixture is dirty, and
# "unknown" gets the SAME answer as "dirty": `ask`. DELIBERATE ESCALATION,
# named so it isn't mistaken for an oversight: this applies even on the
# `git add` branch, which is otherwise a nudge-only path exempt from the
# blocking asymmetry above. A `git` failure is rare enough, and cheap enough
# to interrupt on, that collapsing it into the SAME fail-closed answer as the
# command-parse failures above was judged simpler and safer than threading a
# separate "unknown but low-stakes" state through the `add` branch. The
# following `git status --porcelain` call (once `rev-parse` has already
# proven git answers) does NOT redirect stderr, so a same-process race would
# still surface a raw diagnostic on the hook's own stderr rather than being
# silently swallowed.
#
# KNOWN SILENT-ALLOW PATHS (n2 - modeled on artifact-guard.sh's own
# "KNOWN SILENT-ALLOW PATHS" section; a list of what has been FOUND, not a
# proof of completeness):
#   1. jq unavailable AND python3 unavailable/failing -> NOW ASKS (see above).
#      jq unavailable but python3 available -> degrades gracefully, no ask.
#   2. empty / malformed / `tool_input.command`-less stdin -> NOW ASKS.
#   3. git unable to answer (`git` missing, `CLAUDE_PROJECT_DIR` not a repo,
#      or any other `rev-parse --git-dir` failure) -> NOW ASKS.
#   4. The script `exec`s (or, post-B2, runs) successfully, emits a
#      SYNTACTICALLY VALID but WRONG decision due to a bug in this file's own
#      logic -> nothing catches this; a call site can only observe process
#      failure (non-zero exit, per B2), never "ran fine but decided wrong".
#      Out of reach of any liveness/exit-code check; covered only by
#      --selftest and code review.
#   5. The hook's own `timeout: 10` (settings.json) is hit -> no JSON is
#      emitted and the tool proceeds; pre-existing, unchanged by this PR.
#      This script runs in well under 100ms even with the git rev-parse
#      round-trip added, so the margin is large, but a list of no-decision
#      paths is incomplete without naming it.
#   6. `settings.json` cannot invoke this script at all (missing file, not
#      executable, directory at the path) -> covered by the CALL SITE's
#      `[ -f "$H" ] && [ -x "$H" ]` liveness check (unchanged by this fix
#      wave, still correct - see the #274 note below).
#   7. (Post-B2) the script runs, is reachable, but exits NON-ZERO due to an
#      internal failure (syntax error, `set -e`/`set -u` trip, bad shebang
#      interpreter) -> settings.json's call site now catches this (B2 below)
#      and asks; before B2 this was a silent allow indistinguishable from a
#      quiet "nothing to report" exit.
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
# settings.json liveness-checks this file (`[ -f "$H" ] && [ -x "$H" ]`,
# emitting its OWN `ask` on failure) before attempting to run it, exactly
# like the artifact-guard.sh call sites already do.
#
# HOW A DIRECTORY AT THE HOOK PATH IS CAUGHT TODAY (M4, PR #333 review round
# 2 - this paragraph used to describe a PRE-B2 mechanism the B2 commit itself
# removed, and the sentence went stale in the same diff that invalidated it):
# `-f` alone already excludes a directory (it tests "is a regular file"), so
# `[ -f "$H" ] && [ -x "$H" ]` denies a directory before either test's `-x`
# half matters - this liveness gate fires FIRST, with the specific "hook
# missing, not a regular file, or not executable" reason. Measured: even with
# the `-f` test removed (leaving only `-x`, which IS true for a directory),
# the call site STILL asks - via a SECOND, independent mechanism, B2's
# exit-status check below. There is no `exec` left in the call site to "die
# with 126": `out=$("$H")` on a directory path is a plain command
# substitution, and bash itself refuses to run a directory as a command
# (`<path>: Is a directory`, exit 126) regardless; `[ "$rc" -ne 0 ]` catches
# that non-zero exit and asks with ITS OWN reason ("guard exited non-zero"),
# not the liveness one. So the directory case is doubly defended post-B2 -
# the `-f`/`-x` gate is no longer the only thing standing between a
# directory and a silent pass-through, though it still gives the more
# specific, pre-execution diagnostic.
#
# B2 (PR #333 review): `[ -f "$H" ] && [ -x "$H" ]` covers REACHABILITY
# (missing, non-executable, directory) but `exec "$H"` REPLACES the calling
# shell, so if the script is reachable, execs, and then dies internally
# (syntax error, `set -e`/`set -u` trip, bad shebang interpreter), there is no
# parent shell left to notice - a non-blocking hook error that lets the
# guarded write proceed. Fixed by NOT `exec`ing: the call site now runs the
# script via command substitution, captures its exit status, and asks if
# that status is non-zero - closing the "reachable but broken" gap at the one
# point where the call site can still act on it. This diverges from
# `artifact-guard.sh`'s own call sites (still `exec`, per that file's own
# review history) - a deliberate, narrower fix for THIS guard, which blocks
# (`ask`) on its primary branch, rather than a repo-wide convention change;
# tracked here rather than silently diverging without a note (n2, item 7).
#
# Offline self-test of the pure decision logic PLUS the settings.json
# call-site liveness AND exit-status checks (the call-site fragment is read
# LIVE from settings.json at selftest time via jq - see _CALLSITE below - so
# it can never drift out of sync the way a hand-copied literal can, M2):
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

# M2 fix: rather than a hand-maintained literal that can (and did) drift out
# of sync with settings.json, read the REAL fragment live from the REAL file
# at selftest time. This can never go stale - there is nothing to keep in
# sync. Requires jq and a readable settings.json at
# "${CLAUDE_PROJECT_DIR:-.}/.claude/settings.json"; if either is unavailable
# the liveness/exit-status selftest rows report that plainly rather than
# silently testing an empty string (see _liveness_check below).
_read_callsite() {
  jq -r '.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[].command' \
    "${CLAUDE_PROJECT_DIR:-.}/.claude/settings.json" 2>/dev/null |
    grep -F 'wind-fixture-guard.sh' | head -1
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

  # ---- Liveness + exit-status: the settings.json call-site guard. --------
  # Reads the REAL fragment live from the REAL settings.json (M2), then runs
  # it against constructed conditions exactly as settings.json would invoke
  # it. Missing / non-executable / directory / a REACHABLE-BUT-BROKEN script
  # must all yield permissionDecision "ask" - the last is B2's fix: the call
  # site no longer `exec`s, so it can observe (and act on) the child's exit
  # status instead of silently disappearing with it.
  _CALLSITE=$(_read_callsite)
  if [ -z "$_CALLSITE" ]; then
    echo "SELFTEST FAIL [liveness]: could not read the settings.json call site (jq missing, or .claude/settings.json not found under CLAUDE_PROJECT_DIR=${CLAUDE_PROJECT_DIR:-.}) - run --selftest from the repo/worktree root"
    fail=1
  else
    _liveness_check() { # desc  kind(missing|nonexec|directory|broken)
      local desc="$1" kind="$2" tmp out
      tmp=$(mktemp -d)
      mkdir -p "$tmp/.claude/hooks"
      case "$kind" in
        missing) : ;;
        nonexec) printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/.claude/hooks/wind-fixture-guard.sh" ;;
        directory) mkdir -p "$tmp/.claude/hooks/wind-fixture-guard.sh" ;;
        broken)
          # Reachable AND executable, but dies internally (a syntax error is
          # representative of the whole B2 class: `set -e`/`set -u` trips and
          # a bad shebang interpreter all share the same observable shape -
          # non-zero exit, no JSON) - this is exactly what `exec` could never
          # let the call site see.
          printf '#!/usr/bin/env bash\nthis is not valid bash(((\n' > "$tmp/.claude/hooks/wind-fixture-guard.sh"
          chmod +x "$tmp/.claude/hooks/wind-fixture-guard.sh"
          ;;
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
    _liveness_check "reachable but internally broken (B2)" broken
  fi

  # ---- Fail-closed input handling (B1) + git-query gate (M1), end to end -
  # Every row below runs THIS script directly (jq present unless a row's own
  # PATH override removes it), never the real repo fixture - a THROWAWAY git
  # repo carries its own app/public/test-fixtures/wind-sw12.json.
  _make_toolbox() { # binaries... -> prints a tmp dir on PATH containing only these
    local dir p
    dir=$(mktemp -d)
    for b in "$@"; do
      p=$(command -v "$b" 2>/dev/null) && ln -s "$p" "$dir/$b"
    done
    printf '%s' "$dir"
  }

  _throwaway_repo() { # dirty(1|0) -> prints a tmp repo dir with the fixture in that state
    local dirty="$1" tmp
    tmp=$(mktemp -d)
    git init -q "$tmp"
    git -C "$tmp" -c user.email=t@t -c user.name=t config commit.gpgsign false
    mkdir -p "$tmp/app/public/test-fixtures"
    printf 'orig\n' > "$tmp/app/public/test-fixtures/wind-sw12.json"
    git -C "$tmp" add -A
    git -C "$tmp" -c user.email=t@t -c user.name=t commit -q -m init
    if [ "$dirty" = 1 ]; then
      printf 'dirty\n' >> "$tmp/app/public/test-fixtures/wind-sw12.json"
    fi
    printf '%s' "$tmp"
  }

  # Runs the REAL script (via $BASH_BIN, absolute-pathed so a restricted
  # PATH-override can't break the interpreter lookup itself - notices-nudge.sh
  # uses the same trick) against a RAW stdin payload and CLAUDE_PROJECT_DIR,
  # optionally under a restricted PATH.
  _prod_check_raw() { # want(ask|nudge|silent)  desc  raw-payload  proj-dir  [PATH-override]
    local want="$1" desc="$2" payload="$3" proj="$4" pathovr="${5:-}" out
    if [ -n "$pathovr" ]; then
      out=$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$proj" PATH="$pathovr" "$BASH_BIN" "$SELFTEST_SELF" 2>/dev/null)
    else
      out=$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$proj" "$BASH_BIN" "$SELFTEST_SELF" 2>/dev/null)
    fi
    case "$want" in
      ask)    case "$out" in *'"permissionDecision":"ask"'*) ;; *) echo "SELFTEST FAIL [prod]: $desc -> got [$out]"; fail=1 ;; esac ;;
      nudge)  case "$out" in *'"additionalContext"'*)        ;; *) echo "SELFTEST FAIL [prod]: $desc -> got [$out]"; fail=1 ;; esac ;;
      silent) [ -z "$out" ] || { echo "SELFTEST FAIL [prod]: $desc -> got [$out]"; fail=1; } ;;
    esac
  }

  # Same as above but for a REAL command: builds proper `{"tool_input":
  # {"command": ...}}` JSON via jq -n (never hand-escaped), so these rows
  # actually exercise decide()/git, not the parse-failure path.
  _prod_check_cmd() { # want  desc  command-text  proj-dir  [PATH-override]
    local want="$1" desc="$2" cmdtext="$3" proj="$4" pathovr="${5:-}" payload
    payload=$(jq -n --arg cmd "$cmdtext" '{tool_input:{command:$cmd}}')
    _prod_check_raw "$want" "$desc" "$payload" "$proj" "$pathovr"
  }

  SELFTEST_SELF="$0"
  BASH_BIN=$(command -v bash)
  repo_dirty=$(_throwaway_repo 1)
  repo_clean=$(_throwaway_repo 0)
  no_git_dir=$(mktemp -d)
  toolbox_no_jq=$(_make_toolbox cat git python3)
  toolbox_no_jq_no_py=$(_make_toolbox cat git)
  toolbox_no_git=$(_make_toolbox cat jq python3)

  # --- Sanity/positive controls: the realistic end-to-end path still works.
  _prod_check_cmd ask    "sanity: dirty fixture + git commit -> ask"    'git commit -m "wip"'            "$repo_dirty"
  _prod_check_cmd silent "sanity: clean fixture + git commit -> silent" 'git commit -m "wip"'             "$repo_clean"
  _prod_check_cmd nudge  "sanity: dirty fixture + git add -> nudge"     'git add app/src/foo.ts'          "$repo_dirty"
  _prod_check_cmd silent "sanity: dirty fixture + inert echo -> silent" 'echo "remember to git commit"'   "$repo_dirty"

  # --- B1: fail-closed on every input-handling failure named in review. ---
  _prod_check_raw ask "B1: empty stdin"                      ''                                   "$repo_dirty"
  _prod_check_raw ask "B1: malformed stdin"                   '{not valid json'                   "$repo_dirty"
  _prod_check_raw ask "B1: JSON without tool_input"           '{"tool_name":"Bash"}'               "$repo_dirty"
  _prod_check_raw ask "B1: tool_input without command"        '{"tool_input":{}}'                  "$repo_dirty"
  _prod_check_cmd ask "B1: jq AND python3 both missing -> asks" \
    'git commit -m "wip"' "$repo_dirty" "$toolbox_no_jq_no_py"

  # M3 fix-wave (PR #333 review round 2): a DIRTY-fixture probe of the
  # jq -> python3 fallback is a two-trigger tautology - `ask` is the correct
  # answer whether the fallback genuinely parses (dirty commit -> ask) OR is
  # entirely absent (parse failure -> the explicit ask), so deleting the
  # fallback clause left this suite green (measured). A CLEAN fixture
  # discriminates: fallback WORKING parses "git commit" correctly,
  # decide()=commit, fixture is clean -> SILENT; fallback BROKEN can't parse
  # at all -> ask, unconditionally, regardless of fixture state. Paired rows,
  # same toolbox, opposite fixture state and opposite expectation - see the
  # M3 mutation-check note below for the red output this pair produces when
  # the fallback clause is deleted.
  _prod_check_cmd silent "B1 (M3): jq missing, python3 present, CLEAN fixture -> silent (fallback genuinely parses)" \
    'git commit -m "wip"' "$repo_clean" "$toolbox_no_jq"
  _prod_check_cmd ask    "B1 (M3): jq AND python3 both missing, CLEAN fixture -> still asks (parse failure, not fixture state)" \
    'git commit -m "wip"' "$repo_clean" "$toolbox_no_jq_no_py"

  # --- M1: git-query failure -> ask, never a silent allow (both branches). -
  _prod_check_cmd ask "M1: CLAUDE_PROJECT_DIR is not a git repo, commit payload" \
    'git commit -m "wip"' "$no_git_dir"
  _prod_check_cmd ask "M1: CLAUDE_PROJECT_DIR is not a git repo, add payload" \
    'git add foo' "$no_git_dir"
  _prod_check_cmd ask "M1: git binary missing entirely, commit payload" \
    'git commit -m "wip"' "$repo_dirty" "$toolbox_no_git"

  rm -rf "$repo_dirty" "$repo_clean" "$no_git_dir" "$toolbox_no_jq" "$toolbox_no_jq_no_py" "$toolbox_no_git"

  if [ "$fail" -eq 0 ]; then
    echo "SELFTEST OK"
  fi
  exit "$fail"
fi

# ---- production path ----
# artifact-guard.sh's fail-closed input handling (B1), ported: an unanswerable
# dependency or an unparseable/incomplete tool_input payload gets `ask`, not
# silence - a blocking guard that cannot determine the command shape must not
# behave as if it saw an inert one.
IN=$(cat)

[ -n "$IN" ] || {
  emit_ask "wind-fixture guard received empty tool input - protection is inert."
  exit 0
}

CMD=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null) \
  || CMD=$(printf '%s' "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tool_input',{}).get('command') or '')" 2>/dev/null) \
  || {
    emit_ask "wind-fixture guard could not parse tool input (malformed JSON, or jq/python3 unavailable) - protection is inert; install jq."
    exit 0
  }

[ -n "$CMD" ] || {
  emit_ask "wind-fixture guard could not extract a Bash command from the tool input - protection is inert."
  exit 0
}

VERDICT=$(decide "$CMD")
[ "$VERDICT" = skip ] && exit 0

# M1: a blocking guard that cannot ask git whether the fixture is dirty must
# not silently behave as if it were clean. Applies to BOTH branches - see the
# "DELIBERATE ESCALATION" note in the file header for why `add` (otherwise a
# low-stakes nudge) is included too.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
git -C "$PROJECT_DIR" rev-parse --git-dir >/dev/null 2>&1 || {
  emit_ask "wind-fixture guard could not query git in $PROJECT_DIR - fixture state unknown, protection is inert."
  exit 0
}

DIRTY=$(git -C "$PROJECT_DIR" status --porcelain -- "$FIX")
case "$VERDICT" in
  commit) [ -n "$DIRTY" ] && emit_ask "$ASK_REASON" ;;
  add)    [ -n "$DIRTY" ] && emit_nudge "$NUDGE_CONTEXT" ;;
esac
exit 0
