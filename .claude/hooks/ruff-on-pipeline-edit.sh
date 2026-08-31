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

emit_advisory() { printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$1"; }

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
  EXPECTED_CASES=13

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

  _mkproj_fake_ruff() { # ok(0|1) -> a project dir whose pipeline/.venv/bin/ruff always exits OK or always flags something
    local ok="$1" tmp; tmp=$(mktemp -d)
    mkdir -p "$tmp/pipeline/.venv/bin"
    printf 'x = 1\n' > "$tmp/pipeline/scratch.py"
    if [ "$ok" = 0 ]; then
      printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/pipeline/.venv/bin/ruff"
    else
      printf '#!/usr/bin/env bash\necho "scratch.py:1:80: E501 line too long"\nexit 1\n' > "$tmp/pipeline/.venv/bin/ruff"
    fi
    chmod +x "$tmp/pipeline/.venv/bin/ruff"
    printf '%s' "$tmp"
  }

  proj_no_venv=$(_mkproj_no_venv)
  proj_clean=$(_mkproj_fake_ruff 0)
  proj_flagged=$(_mkproj_fake_ruff 1)

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

  rm -rf "$proj_no_venv" "$proj_clean" "$proj_flagged"

  # The empty-path row above builds `{"tool_input":{"file_path":""}}`, not
  # truly empty stdin - add ONE genuinely empty-stdin row directly, since
  # that is a distinct failure shape (no JSON at all, not JSON with an empty
  # value) and #424's own lesson ("an experiment that never ran emits exactly
  # the output of one that found nothing") applies here too: an untested
  # empty-stdin path is not evidence that it degrades safely.
  total=$((total + 1))
  raw_out=$(printf '' | CLAUDE_PROJECT_DIR="$proj_no_venv" "$SELF" 2>&1)
  if [ -n "$raw_out" ]; then
    echo "SELFTEST FAIL [prod]: genuinely empty stdin -> got [$raw_out] want silence"
    fail=1
  fi

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
if [ ! -x "$RUFF" ]; then
  emit_advisory "ruff hook inert: pipeline/.venv/bin/ruff missing - this pipeline/**/*.py edit was NOT linted. Set up the venv once with: python3 -m venv pipeline/.venv && pipeline/.venv/bin/pip install -r pipeline/requirements.txt (CLAUDE.md's Pipeline bullet)."
  exit 0
fi

CHECK_OUT=$("$RUFF" check "$F" 2>&1); CHECK_RC=$?
FMT_OUT=$("$RUFF" format --check "$F" 2>&1); FMT_RC=$?

if [ "$CHECK_RC" -ne 0 ] || [ "$FMT_RC" -ne 0 ]; then
  MSG=$(printf '%s\n%s' "$CHECK_OUT" "$FMT_OUT" | grep -v '^$' | head -8 | tr '\n' ' ' | tr -d '\\' | tr '"' "'")
  emit_advisory "ruff flagged $(printf '%s' "$F" | tr -d '\\' | tr '"' "'") (pipeline/.venv's ruff is UNPINNED against CI's hash-pinned .github/workflows/python-lint-requirements.txt - a local pass here would be evidence, not proof, and this python-lint.yml ruff job is ADVISORY, not required, so a red ruff can merge silently if ignored): $MSG"
fi
exit 0
