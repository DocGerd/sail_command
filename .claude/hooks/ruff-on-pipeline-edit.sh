#!/usr/bin/env bash
# PostToolUse Edit|Write NUDGE: run ruff against a just-edited `pipeline/**/*.py`
# file. SailCommand #728.
#
# WHY THIS EXISTS (CLAUDE.md's "Python gates live OUTSIDE the app toolchain"
# bullet): typecheck/lint/vitest are all JS-side and structurally cannot see
# Python, and `python-lint.yml`'s `ruff` job is ADVISORY, not required
# (`protect-main` gates on `app`+`e2e` only) - a red `ruff` merges silently.
# Measured consequence: #538's three E501s entered on that task's own commit
# and survived that task's review rounds AND the whole-branch review, because
# every gate any of them ran was the `app` toolchain. This hook is the same
# fix pattern this repo already ships for TypeScript (the PostToolUse eslint
# entry in `.claude/settings.json`, `case "$f" in *app/src/*.ts|*app/src/*.tsx)
# ... node_modules/.bin/eslint "$f" ...`) - a direct analogue, moved to the
# point where the file is edited instead of left for CI to (not) catch.
#
# DESIGN: advisory, non-blocking - SAME posture as the eslint hook it mirrors,
# and for a SPECIFIC reason beyond convention (CLAUDE.md's own #728 bullet):
# `pipeline/.venv` carries its OWN ruff, UNPINNED against CI's hash-pinned
# `.github/workflows/python-lint-requirements.txt` (measured 2026-08-18:
# venv 0.16.2 vs CI 0.16.3 - a DIFFERENT pair of versions than whatever this
# checkout happens to hold right now, because the venv is hand-created and
# never pinned). A local ruff pass is EVIDENCE, not PROOF - the CI `ruff` job
# is the authority, and it is advisory, not required, so this hook must never
# claim more certainty than that. This file NEVER emits `permissionDecision`
# in any form (same reasoning as `closing-keyword-guard.sh` and CLAUDE.md's
# #478 bullet: "allow" would bypass the user's own permission rules, and there
# is nothing here worth an "ask" prompt over).
#
# THE `.claude/settings.json` CALL SITE IS DELIBERATELY SILENT ON A MISSING/
# NON-EXECUTABLE HOOK FILE - NOT `ask` (PR #797 review Minor 4; corrected
# round 2, Minor 6 - the FIRST version of this paragraph borrowed
# closing-keyword-guard.sh's click-through reasoning and claimed
# artifact-guard.sh shares this hook's array, both wrong).
#
# MINOR 6 FACT (verified against Claude Code's own hooks documentation and
# this repo's committed .claude/settings.json, not restated from memory):
# `permissionDecision` does not apply to PostToolUse hooks at all -
# PostToolUse fires AFTER the tool has already run and cannot block, so
# `ask`/`allow`/`deny` have nothing left to gate. Separately,
# `artifact-guard.sh` has ZERO PostToolUse entries in .claude/settings.json
# (verified: `jq '.hooks.PostToolUse[] | .hooks[].command'` matches
# "artifact-guard" 0 times) - it sits only in `PreToolUse` `Edit|Write`
# and `PreToolUse` `Bash`, so THIS hook's `PostToolUse` `Edit|Write`
# array never contained it.
#
# A visible "hook missing" advisory would still fire on every non-pipeline
# edit for the reason a gated version would need `_is_pipeline_py`
# duplicated into `settings.json`; and the call site already uses the
# CONJUNCTIVE `[ -f "$H" ] && [ -x "$H" ]` liveness form #274 prescribes.
#
# WHAT IT DOES NOT COVER, stated rather than implied:
#   1. `pipeline/.venv` may not exist at all - a fresh checkout has none until
#      `python3 -m venv pipeline/.venv && pipeline/.venv/bin/pip install -r
#      pipeline/requirements.txt` has been run by hand (CLAUDE.md's Pipeline
#      bullet). A missing venv is NOT a lint failure and must not be treated
#      as one - this hook degrades to one clear, calm advisory naming the
#      setup command, exactly once per edit, never a hard failure.
#   2. A `sed -i` edit to a `pipeline/**/*.py` file carries NO `file_path` in
#      its tool payload (PostToolUse `Bash` events are a different matcher
#      entirely, and this hook is wired on `Edit|Write` only) - such an edit
#      is INVISIBLE to this hook by construction. This is the SAME residual
#      CLAUDE.md's own `polarProvenance`/`draftProvenance` bullet documents
#      for `polars-source.json` ("Bash carries no file_path, so the hook
#      never fires") - not new, and not fixable from this hook alone.
#   3. `ruff format --check` and `ruff check` are both run PER-FILE, on the
#      single edited file - a cross-file rule (an unused import that becomes
#      dead only once a SECOND file stops calling it, say) is out of reach of
#      a single-file invocation, exactly like the eslint hook's own
#      single-file scope.
#
# Offline self-test of the pure path-matching logic PLUS end-to-end checks
# against a scratch project tree with a FAKE ruff binary (deterministic, no
# real dependency on pipeline/.venv actually existing in THIS checkout):
#   .claude/hooks/ruff-on-pipeline-edit.sh --selftest
set -uo pipefail

# _json_string TEXT - prints a JSON-quoted, PROPERLY ESCAPED string literal
# (surrounding quotes included) for arbitrary TEXT. Shared contract with
# closing-keyword-guard.sh's helper of the same name (PR #797 review Minor 3
# asked the two be made consistent) - see that file's copy for the full
# rationale. Here the risk is the same shape: $F (a file path) and $MSG (raw
# ruff/tool stdout+stderr) are both TEXT this hook does not control the
# byte content of, and the OLD emit_advisory embedded them into a
# hand-written printf format string with only ad hoc `tr -d '\\' | tr '"'
# "'"` stripping - which handled backslash and double-quote but left every
# other JSON-illegal control byte (a literal TAB in a ruff diagnostic quoting
# source text, say) to reach the output raw. jq -> python3 fallback mirrors
# the fail-open discipline used throughout this file. MINOR 8 (PR #797
# review round 2): the LAST-RESORT fallback (neither available) does NOT
# "strip every byte JSON cannot represent" - measured against its own code,
# it touches exactly five bytes: `\` and `"` are DELETED (silently
# changes the text's MEANING while staying VALID json - worse than it
# looks, since nothing signals it happened), `\n`/`\t`/`\r` each become
# a space (lossy, but stays valid). Every OTHER JSON-illegal control byte
# (SOH 0x01, VT 0x0b, ...) passes through untouched and still breaks the
# JSON. This is a MINOR, not a defect to harden, because the fallback is
# UNREACHABLE in production: both hooks require jq OR python3 just to
# PARSE the incoming tool_input, earlier in the script than this function
# is ever called, so "neither available" already exits 0 first - verified
# with a positive control (a PATH of real binaries excluding jq and
# python3 makes both hooks exit silently; a jq-only and a python3-only
# PATH each emit valid JSON for a TAB payload).
_json_string() {
  printf '%s' "$1" | jq -Rs . 2>/dev/null \
    || printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
    || printf '"%s"' "$(printf '%s' "$1" | tr -d '\\"' | tr '\n\t\r' '   ')"
}

emit_advisory() { printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\n' "$(_json_string "$1")"; }

# ---- pure decision logic (no I/O, unit-testable via --selftest) ----

# _is_pipeline_py FILE - true iff FILE looks like a pipeline/**/*.py path.
# Single star, deliberately (CLAUDE.md's docs-only-classifier note: in a bash
# `case`, `*` matches `/`, so nested paths under pipeline/ match too - not
# just files directly inside pipeline/). The LEADING `*` is what makes this
# match regardless of whether FILE arrives absolute (the common case for a
# real Edit/Write tool_input.file_path) or repo-root-relative.
_is_pipeline_py() {
  case "$1" in
    *pipeline/*.py) return 0 ;;
  esac
  return 1
}

# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  fail=0
  total=0
  # (PR #797 review) 13 -> 16: +1 Minor 1 (directory at ruff path must land
  # on "hook inert", never "ruff flagged"), +1 Minor 2 (exit>=2 tool error
  # must say "ERRORED (not flagged)", never "ruff flagged"), +1 Minor 3
  # (a literal TAB in ruff's own output must still emit valid JSON).
  EXPECTED_CASES=16

  check_match() { # want(match|skip)  desc  path
    total=$((total + 1))
    local want="$1" desc="$2" path="$3" got
    if _is_pipeline_py "$path"; then got=match; else got=skip; fi
    if [ "$got" != "$want" ]; then
      echo "SELFTEST FAIL [match]: $desc -> got [$got] want [$want] (path: $path)"
      fail=1
    fi
  }

  check_match match "absolute path, top-level pipeline file"     "/home/user/sail_command/pipeline/build_mask.py"
  check_match match "absolute path, nested subdir"                "/home/user/sail_command/pipeline/lib/util.py"
  check_match match "repo-root-relative path"                     "pipeline/verify_mask.py"
  check_match skip  "app tree, not pipeline"                      "/home/user/sail_command/app/src/App.tsx"
  check_match skip  "pipeline-named file but not .py"              "pipeline/README.md"
  check_match skip  "python file outside pipeline/"                "/home/user/sail_command/scripts/tool.py"
  check_match skip  "empty path"                                   ""

  # ---- end-to-end, against a scratch tree with a FAKE ruff binary - proves
  # the WIRING (jq extraction, venv-presence branch, ruff invocation, JSON
  # emission) without depending on a real pipeline/.venv existing in this
  # checkout (which, per the issue itself, is not guaranteed - CLAUDE.md
  # states it is hand-created). A REAL ruff run against a REAL pipeline/.venv
  # is exercised separately by hand at review time (see the PR body / task
  # report), not by this offline suite. ----
  case "$0" in
    */*) SELF=$0 ;;
    *) SELF=./$0 ;;
  esac

  _prod_check() { # want(advisory|silent)  desc  proj-dir  file-path
    total=$((total + 1))
    local want="$1" desc="$2" proj="$3" path="$4" json out
    json=$(printf '{"tool_input":{"file_path":%s}}' "$(
      printf '%s' "$path" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
        || printf '%s' "$path" | jq -Rs .
    )")
    out=$(printf '%s' "$json" | CLAUDE_PROJECT_DIR="$proj" "$SELF" 2>&1)
    case "$want" in
      advisory)
        case "$out" in
          *'"additionalContext"'*) ;;
          *) echo "SELFTEST FAIL [prod]: $desc -> got [$out] want an additionalContext advisory"; fail=1 ;;
        esac
        case "$out" in
          *'"permissionDecision"'*) echo "SELFTEST FAIL [prod]: $desc -> emitted a permissionDecision, which this NUDGE must NEVER do (out: $out)"; fail=1 ;;
        esac
        ;;
      silent)
        [ -z "$out" ] || { echo "SELFTEST FAIL [prod]: $desc -> got [$out] want silence"; fail=1; }
        ;;
    esac
  }

  _mkproj_no_venv() {
    local tmp; tmp=$(mktemp -d)
    mkdir -p "$tmp/pipeline"
    printf 'x = 1\n' > "$tmp/pipeline/scratch.py"
    printf '%s' "$tmp"
  }

  _mkproj_fake_ruff() { # ok(0|1|2) -> a project dir whose pipeline/.venv/bin/ruff exits OK, flags a violation (1), or errors as a TOOL failure (2)
    local ok="$1" tmp; tmp=$(mktemp -d)
    mkdir -p "$tmp/pipeline/.venv/bin"
    printf 'x = 1\n' > "$tmp/pipeline/scratch.py"
    case "$ok" in
      0) printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/pipeline/.venv/bin/ruff" ;;
      1) printf '#!/usr/bin/env bash\necho "scratch.py:1:80: E501 line too long"\nexit 1\n' > "$tmp/pipeline/.venv/bin/ruff" ;;
      2)
        # Minor 2 (PR #797 review): a MEASURED-shaped tool error, exit >= 2 -
        # ruff's own real contract for "the tool itself failed", distinct
        # from exit 1 ("violations found"). Real repro: a bad pyproject.toml
        # key makes ruff exit 2 with a "ruff failed / Cause: ..." message on
        # an otherwise-clean file; this fake reproduces the SHAPE without
        # needing a real ruff binary in the offline suite.
        printf '#!/usr/bin/env bash\necho "ruff failed"\necho "  Cause: Failed to parse pyproject.toml"\nexit 2\n' > "$tmp/pipeline/.venv/bin/ruff"
        ;;
    esac
    chmod +x "$tmp/pipeline/.venv/bin/ruff"
    printf '%s' "$tmp"
  }

  # Minor 1 (PR #797 review): a DIRECTORY at the ruff path, not a missing
  # file - the shape the OLD `[ ! -x "$RUFF" ]` liveness check let through
  # (`-x` alone is TRUE for a directory), invoking `"$RUFF" check "$F"` on a
  # directory and reporting the resulting shell error as "ruff flagged
  # <clean file>". Per `test(1)`: `-x` is a PERMISSION-bit test (execute/
  # search permission) and says nothing about file TYPE - a real directory
  # typically carries the search (`x`) bit too, so `-x` alone cannot tell a
  # directory from a regular file (PR #797 review round 2, Minor 7: an
  # earlier version of this comment called `-f` a permission bit too and
  # contradicted this file's own later liveness-fix comment, which correctly
  # calls `-f` the TYPE test - "is a regular file"). That contradiction is
  # exactly what makes this row non-vacuous: it constructs the failure
  # `-x` alone cannot see, the same class #274's liveness-gate bullet
  # documents for the settings.json call site itself.
  _mkproj_dir_at_ruff() {
    local tmp; tmp=$(mktemp -d)
    mkdir -p "$tmp/pipeline/.venv/bin/ruff"
    printf 'x = 1\n' > "$tmp/pipeline/scratch.py"
    printf '%s' "$tmp"
  }

  proj_no_venv=$(_mkproj_no_venv)
  proj_clean=$(_mkproj_fake_ruff 0)
  proj_flagged=$(_mkproj_fake_ruff 1)
  proj_toolerror=$(_mkproj_fake_ruff 2)
  proj_dir_at_ruff=$(_mkproj_dir_at_ruff)

  _prod_check silent   "non-matching path -> silent, no venv check at all" \
    "$proj_no_venv" "$proj_no_venv/app/src/App.tsx"
  _prod_check advisory "matching path, venv MISSING -> advisory naming the setup command" \
    "$proj_no_venv" "$proj_no_venv/pipeline/scratch.py"
  _prod_check silent   "matching path, venv present, ruff clean -> silent" \
    "$proj_clean" "$proj_clean/pipeline/scratch.py"
  _prod_check advisory "matching path, venv present, ruff flags something -> advisory" \
    "$proj_flagged" "$proj_flagged/pipeline/scratch.py"
  _prod_check silent   "empty stdin -> silent" \
    "$proj_no_venv" ""

  # Minor 1 pin: MUST land on the "hook inert" message (directory denied at
  # the SAME liveness gate as a missing file), MUST NOT claim "flagged".
  total=$((total + 1))
  dir_out=$(printf '{"tool_input":{"file_path":"%s/pipeline/scratch.py"}}' "$proj_dir_at_ruff" | CLAUDE_PROJECT_DIR="$proj_dir_at_ruff" "$SELF" 2>&1)
  case "$dir_out" in
    *'hook inert'*) ;;
    *) echo "SELFTEST FAIL [Minor 1]: directory at ruff path -> expected the 'hook inert' message, got [$dir_out]"; fail=1 ;;
  esac
  case "$dir_out" in
    *'ruff flagged'*) echo "SELFTEST FAIL [Minor 1]: directory at ruff path -> got a FALSE 'ruff flagged' claim on a clean file: $dir_out"; fail=1 ;;
  esac

  # Minor 2 pin: an exit->=2 tool error MUST say "ERRORED (not flagged)",
  # MUST NOT say "ruff flagged" - the wrong diagnosis on the same wrong file.
  total=$((total + 1))
  err_out=$(printf '{"tool_input":{"file_path":"%s/pipeline/scratch.py"}}' "$proj_toolerror" | CLAUDE_PROJECT_DIR="$proj_toolerror" "$SELF" 2>&1)
  case "$err_out" in
    *'ERRORED (not flagged)'*) ;;
    *) echo "SELFTEST FAIL [Minor 2]: exit>=2 tool error -> expected 'ERRORED (not flagged)', got [$err_out]"; fail=1 ;;
  esac
  case "$err_out" in
    *'ruff flagged'*) echo "SELFTEST FAIL [Minor 2]: exit>=2 tool error -> got a WRONG 'ruff flagged' diagnosis instead of a tool-error one: $err_out"; fail=1 ;;
  esac

  # Minor 3 pin, MUTATION-CHECKED: a literal TAB inside ruff's own stdout
  # (e.g. quoting a source line containing one) used to reach the emitted
  # JSON unescaped - `jq empty` rejects that. Validates the FULL emitted
  # line, not a substring grep, per #424's "a check that cannot fail is not
  # a check" lesson.
  total=$((total + 1))
  proj_tab=$(mktemp -d)
  mkdir -p "$proj_tab/pipeline/.venv/bin"
  printf 'x = 1\n' > "$proj_tab/pipeline/scratch.py"
  # A real TAB byte via bash's $'...' ANSI-C quoting, substituted through
  # printf's own %s (not typed as a literal escape sequence, which would be
  # doubly-escaped once through the generator printf and again through the
  # generated script's own echo) - the two %s slots land the tab bytes,
  # while \n elsewhere in the FORMAT string is printf's own newline escape.
  _tab=$'\t'
  printf '#!/usr/bin/env bash\necho "scratch.py:1:1: E501 col%swith%stabs"\nexit 1\n' "$_tab" "$_tab" \
    > "$proj_tab/pipeline/.venv/bin/ruff"
  chmod +x "$proj_tab/pipeline/.venv/bin/ruff"
  tab_out=$(printf '{"tool_input":{"file_path":"%s/pipeline/scratch.py"}}' "$proj_tab" | CLAUDE_PROJECT_DIR="$proj_tab" "$SELF" 2>&1)
  if [ -z "$tab_out" ]; then
    echo "SELFTEST FAIL [Minor 3]: TAB in ruff output -> expected an advisory, got silence"
    fail=1
  elif ! printf '%s' "$tab_out" | jq empty 2>/dev/null; then
    echo "SELFTEST FAIL [Minor 3]: TAB in ruff output -> emitted INVALID JSON: $tab_out"
    fail=1
  fi
  rm -rf "$proj_tab"

  # The empty-path row above builds `{"tool_input":{"file_path":""}}`, not
  # truly empty stdin - add ONE genuinely empty-stdin row directly, since
  # that is a distinct failure shape (no JSON at all, not JSON with an empty
  # value) and #424's own lesson ("an experiment that never ran emits exactly
  # the output of one that found nothing") applies here too: an untested
  # empty-stdin path is not evidence that it degrades safely. MUST run
  # BEFORE "$proj_no_venv" is removed below (PR #797 review round 2, ruled
  # "fix now": the row previously reused $proj_no_venv AFTER its own
  # rm -rf - harmless today only because empty stdin exits before
  # CLAUDE_PROJECT_DIR is ever read, which is fragility, not a defect).
  total=$((total + 1))
  raw_out=$(printf '' | CLAUDE_PROJECT_DIR="$proj_no_venv" "$SELF" 2>&1)
  if [ -n "$raw_out" ]; then
    echo "SELFTEST FAIL [prod]: genuinely empty stdin -> got [$raw_out] want silence"
    fail=1
  fi

  rm -rf "$proj_no_venv" "$proj_clean" "$proj_flagged" "$proj_toolerror" "$proj_dir_at_ruff"

  if ! [ "$total" -eq "$EXPECTED_CASES" ] 2>/dev/null; then
    echo "SELFTEST FAILURES: ran $total cases, expected ${EXPECTED_CASES:-<unset/empty>} - a case was skipped or silently dropped"
    exit 1
  fi
  if [ "$fail" -eq 0 ]; then
    echo "SELFTEST OK"
  fi
  exit "$fail"
fi

# ---- production path ----
# Fail OPEN on every input-handling failure - this file is advisory-only,
# same design note as closing-keyword-guard.sh: silence on an unparseable
# payload is indistinguishable from silence on a genuinely non-matching one,
# and that is fine for a NUDGE.
IN=$(cat)
[ -n "$IN" ] || exit 0

F=$(printf '%s' "$IN" | jq -r '.tool_response.filePath // .tool_input.file_path // empty' 2>/dev/null) \
  || F=$(printf '%s' "$IN" | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('tool_response') or {}).get('filePath') or (d.get('tool_input') or {}).get('file_path') or '')" 2>/dev/null) \
  || exit 0

[ -n "$F" ] || exit 0
_is_pipeline_py "$F" || exit 0

RUFF="${CLAUDE_PROJECT_DIR:-.}/pipeline/.venv/bin/ruff"
# Minor 1 (PR #797 review): CONJUNCTIVE liveness, matching artifact-guard.sh/
# wind-fixture-guard.sh's own `-f && -x` form (`-f` alone already excludes a
# directory - it tests "is a regular file" - so `-d` is not needed
# separately). The OLD `[ ! -x "$RUFF" ]` was non-conjunctive: `-x` alone is
# TRUE for a directory (the search bit, not "is runnable"), so a directory
# at $RUFF's path passed the liveness check, `"$RUFF" check "$F"` then failed
# with a shell "Is a directory" error captured into $CHECK_OUT, and the OLD
# code below reported that as "ruff flagged <file>" - a false violation
# claim on a file ruff never actually read. Conjunctive form denies BEFORE
# invocation, landing on the correct "hook inert" message instead.
if ! { [ -f "$RUFF" ] && [ -x "$RUFF" ]; }; then
  emit_advisory "ruff hook inert: pipeline/.venv/bin/ruff missing - this pipeline/**/*.py edit was NOT linted. Set up the venv once with: python3 -m venv pipeline/.venv && pipeline/.venv/bin/pip install -r pipeline/requirements.txt (CLAUDE.md's Pipeline bullet)."
  exit 0
fi

CHECK_OUT=$("$RUFF" check "$F" 2>&1); CHECK_RC=$?
FMT_OUT=$("$RUFF" format --check "$F" 2>&1); FMT_RC=$?

# Minor 2 (PR #797 review): ruff's own exit-code contract is 0 = clean,
# 1 = violations found (the ordinary case this hook exists for), >= 2 =
# the TOOL ITSELF failed (invalid pyproject.toml/ruff.toml, bad CLI usage,
# an internal crash) - MEASURED: a `[tool.ruff]` TOML block with an unknown
# key makes `ruff check <file>` exit 2 on a file that is otherwise byte-
# identical to a clean pass. The OLD code treated ANY non-zero exit as
# "violations found" and reported a genuinely clean file as "ruff flagged"
# - the wrong diagnosis for the wrong reason, and reachable in practice
# precisely because pipeline/.venv's ruff is UNPINNED against CI's version
# (a config key valid in one ruff release can be unknown in another).
# Distinguish the two: >= 2 on EITHER invocation is a tool error, reported
# as a tool error, never as "flagged" - which would misdirect a reader
# toward fixing code that was never actually linted.
if [ "$CHECK_RC" -ge 2 ] || [ "$FMT_RC" -ge 2 ]; then
  MSG=$(printf '%s\n%s' "$CHECK_OUT" "$FMT_OUT" | grep -v '^$' | head -8 | tr '\n' ' ')
  emit_advisory "ruff ERRORED (not flagged) on $F: $MSG - this is a TOOL error (bad pyproject.toml/ruff.toml, invalid CLI usage, or an internal ruff crash), NOT a code violation - the file may be perfectly clean. pipeline/.venv's ruff is UNPINNED against CI's hash-pinned .github/workflows/python-lint-requirements.txt, so this may not even reproduce under CI's ruff."
elif [ "$CHECK_RC" -ne 0 ] || [ "$FMT_RC" -ne 0 ]; then
  MSG=$(printf '%s\n%s' "$CHECK_OUT" "$FMT_OUT" | grep -v '^$' | head -8 | tr '\n' ' ')
  emit_advisory "ruff flagged $F (pipeline/.venv's ruff is UNPINNED against CI's hash-pinned .github/workflows/python-lint-requirements.txt - a local pass here would be evidence, not proof, and this python-lint.yml ruff job is ADVISORY, not required, so a red ruff can merge silently if ignored): $MSG"
fi
exit 0
