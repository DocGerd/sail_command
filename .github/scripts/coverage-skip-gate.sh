#!/usr/bin/env bash
# Nightly-coverage skip gate for coverage.yml (#879).
#
# #879: 7 of 29 sampled nights (2026-08-05..2026-09-02) re-measured a
# byte-identical `develop` tree at ~4125s mean job duration - ~8h of runner
# time over 29 days for zero new information. This script decides whether a
# scheduled coverage run should execute the expensive steps
# (`npm ci` / `npm run test:coverage` / the Codecov upload) or skip them and
# report a `::notice::` naming the run whose measurement still stands.
#
# POLARITY (read this before touching the decision logic): the safe default
# here is RUN, never skip. `Coverage` is not a required check (`protect-main`
# needs only `app`+`e2e`), so a wrongly-run night costs a few thousand
# seconds of a non-blocking job; a wrongly-skipped night silently stops
# measuring coverage with no reporting obligation to catch it. Every
# ambiguous, missing, malformed, or erroring input below therefore resolves
# to `DECISION_RUN=true` - this is the opposite bias from
# `classify-docs-only.sh`'s "skip is the risky direction so ambiguity runs
# e2e" only in the sense that BOTH scripts default to running their expensive
# work on doubt; there is no branch anywhere in `decide_run_coverage` whose
# fallback is skip.
#
# WEEKLY FLOOR (#879's maintainer ruling): #877 (skip `app`/`e2e` on a
# byte-identical push to an already-green PR head) and this issue each cited
# the OTHER's re-execution as their own safety fallback. Landing both without
# a floor would leave a quiet week with ZERO re-execution of either suite -
# no per-push run (skipped by #877) and no nightly run (skipped by this
# script) ever exercising the code again. `FORCE_DAYS` (default 7, i.e.
# weekly) is what restores a guaranteed floor: even on a develop branch that
# never moves, this script forces a run once `age_days >= FORCE_DAYS`
# regardless of the SHA comparison. If you are reading this because someone
# proposed deleting or loosening the floor: don't, unless #877's own
# push-skip gate has also been removed - the floor exists BECAUSE that gate
# removed the other path, not decoratively.
#
# This script deliberately NEVER exits non-zero on its own decision logic -
# every external call (the `gh api` lookup, date parsing) is guarded by an
# explicit `if`, not by `set -e`, precisely because a step that errors before
# writing GITHUB_OUTPUT would stop the job before `npm ci` ever runs, which
# would defeat "ambiguity runs the suite" for the one input class (a broken
# API call) this script exists to be robust against. The `GITHUB_OUTPUT`
# unset-under-real-Actions check near the bottom is the one exception - that
# is an impossible-in-practice misconfiguration (Actions always sets it), not
# a legitimate uncertain input, and mirrors classify-docs-only.sh's identical
# assertion for the same reason.
#
# Production usage (invoked by coverage.yml's `coverage` job as its first
# step, working-directory `app` per that job's `defaults` - EVENT_NAME/
# CURRENT_SHA/REPO come from `github.*` context, GH_TOKEN from
# `secrets.GITHUB_TOKEN`):
#   EVENT_NAME=schedule CURRENT_SHA=<sha> REPO=owner/repo \
#   GITHUB_OUTPUT=... GH_TOKEN=... .github/scripts/coverage-skip-gate.sh
# Offline self-test against synthetic inputs (#879):
#   .github/scripts/coverage-skip-gate.sh --selftest
set -uo pipefail

REPO="${REPO:-DocGerd/sail_command}"
WORKFLOW_FILE="${WORKFLOW_FILE:-coverage.yml}"
BRANCH="${BRANCH:-develop}"
FORCE_DAYS="${FORCE_DAYS:-7}"

# ---- pure decision function (no I/O - what --selftest exercises directly) ----
# Sets globals DECISION_RUN (true|false) and DECISION_REASON (string).
decide_run_coverage() {
  local event_name="$1" current_sha="$2" fetch_ok="$3" last_sha="$4" \
        last_epoch="$5" now_epoch="$6" force_days="$7"

  if [ "$event_name" = "workflow_dispatch" ]; then
    DECISION_RUN=true
    DECISION_REASON="workflow_dispatch always runs in full (the manual escape hatch)"
    return
  fi

  if [ "$fetch_ok" != "true" ] || [ -z "$last_sha" ] || [ -z "$last_epoch" ]; then
    DECISION_RUN=true
    DECISION_REASON="no usable previous successful run on ${BRANCH} (API error, empty result, or unparseable timestamp) - failing open"
    return
  fi

  # From here on we trust last_sha/last_epoch are populated; validate the
  # numeric fields before doing arithmetic on them so a corrupt/non-numeric
  # epoch can never reach `$(( ))` (which would abort the script under some
  # bash builds regardless of `set -e`, defeating "always exit 0").
  case "$now_epoch" in ''|*[!0-9]*)
    DECISION_RUN=true
    DECISION_REASON="now_epoch is not a plain integer ('${now_epoch}') - failing open"
    return ;;
  esac
  case "$last_epoch" in ''|*[!0-9]*)
    DECISION_RUN=true
    DECISION_REASON="last_epoch is not a plain integer ('${last_epoch}') - failing open"
    return ;;
  esac
  case "$force_days" in ''|*[!0-9]*)
    DECISION_RUN=true
    DECISION_REASON="force_days is not a plain integer ('${force_days}') - failing open"
    return ;;
  esac

  if [ "$current_sha" != "$last_sha" ]; then
    DECISION_RUN=true
    DECISION_REASON="develop has moved since the last successful run (${last_sha} -> ${current_sha})"
    return
  fi

  local age_days=$(( (now_epoch - last_epoch) / 86400 ))
  if [ "$age_days" -lt 0 ]; then
    DECISION_RUN=true
    DECISION_REASON="last successful run's timestamp is after now_epoch - ambiguous, failing open"
    return
  fi

  if [ "$age_days" -ge "$force_days" ]; then
    DECISION_RUN=true
    DECISION_REASON="sha unchanged (${last_sha}) but ${age_days}d >= the ${force_days}d weekly floor - forcing a re-measurement (#877 removed the other re-execution path; this floor is now the only guaranteed one)"
    return
  fi

  DECISION_RUN=false
  DECISION_REASON="sha unchanged (${last_sha}) and only ${age_days}d since the last successful run (< ${force_days}d floor) - skipping"
}

# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  PASS=0; FAIL=0
  check() {
    # check <label> <expected_run> <event_name> <current_sha> <fetch_ok> <last_sha> <last_epoch> <now_epoch> <force_days>
    local label="$1" expected="$2"
    shift 2
    DECISION_RUN=""; DECISION_REASON=""
    decide_run_coverage "$@"
    if [ "$DECISION_RUN" = "$expected" ]; then
      PASS=$((PASS + 1))
    else
      FAIL=$((FAIL + 1))
      echo "FAIL: $label - expected run=$expected, got run=$DECISION_RUN (reason: $DECISION_REASON)"
    fi
  }

  DAY=86400
  NOW=1700000000

  # --- table row: SHA moved -> run ---
  check "sha moved" true \
    schedule shaB true shaA $((NOW - 1 * DAY)) "$NOW" 7

  # --- table row: SHA same + within 7 days -> skip ---
  check "sha same, 1d old (within floor)" false \
    schedule shaA true shaA $((NOW - 1 * DAY)) "$NOW" 7
  check "sha same, exactly 6d old (within floor)" false \
    schedule shaA true shaA $((NOW - 6 * DAY)) "$NOW" 7

  # --- table row: SHA same + >= 7 days -> run (weekly floor) ---
  check "sha same, exactly 7d old (floor boundary, inclusive)" true \
    schedule shaA true shaA $((NOW - 7 * DAY)) "$NOW" 7
  check "sha same, 30d old (well past floor)" true \
    schedule shaA true shaA $((NOW - 30 * DAY)) "$NOW" 7

  # --- table row: API error -> run ---
  check "api error (fetch_ok=false)" true \
    schedule shaA false "" "" "$NOW" 7
  check "api call succeeded but returned unparseable garbage" true \
    schedule shaA garbage shaA $((NOW - 1 * DAY)) "$NOW" 7

  # --- table row: no previous run -> run ---
  check "no previous run (empty last_sha)" true \
    schedule shaA true "" $((NOW - 1 * DAY)) "$NOW" 7
  check "no previous run (empty last_epoch)" true \
    schedule shaA true shaA "" "$NOW" 7

  # --- table row: non-schedule trigger (workflow_dispatch) -> always run ---
  check "workflow_dispatch, sha unchanged, 1d old" true \
    workflow_dispatch shaA true shaA $((NOW - 1 * DAY)) "$NOW" 7
  check "workflow_dispatch with a broken fetch too" true \
    workflow_dispatch shaA false "" "" "$NOW" 7

  # --- extra defensive rows: malformed numeric inputs must fail open ---
  check "non-numeric now_epoch" true \
    schedule shaA true shaA 12345 "not-a-number" 7
  check "non-numeric last_epoch" true \
    schedule shaA true shaA "not-a-number" "$NOW" 7
  check "non-numeric force_days" true \
    schedule shaA true shaA $((NOW - 1 * DAY)) "$NOW" "not-a-number"
  check "last_epoch in the future relative to now" true \
    schedule shaA true shaA $((NOW + 1 * DAY)) "$NOW" 7

  echo "selftest: $PASS passed, $FAIL failed"
  if [ "$FAIL" -eq 0 ]; then
    echo "SELFTEST OK"
    exit 0
  fi
  exit 1
fi

# ---- production path ----
EVENT_NAME="${EVENT_NAME:-}"
CURRENT_SHA="${CURRENT_SHA:-}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/null}"

# Mirrors classify-docs-only.sh's identical assertion: GITHUB_OUTPUT is
# always set by the real Actions runner, so this branch is an
# impossible-in-practice misconfiguration guard, not a legitimate uncertain
# input - every genuinely uncertain input below is handled by
# `decide_run_coverage` defaulting to run=true and this script still exiting
# 0, never by aborting the step.
if [ -n "${GITHUB_ACTIONS:-}" ] && [ "$GITHUB_OUTPUT" = /dev/null ]; then
  echo "::error::GITHUB_OUTPUT is unset under GitHub Actions - refusing to silently write the coverage decision to /dev/null (that would read as 'skip' to the job's if: gates)" >&2
  exit 1
fi

NOW_EPOCH="$(date -u +%s)"
FETCH_OK=false
LAST_SHA=""
LAST_EPOCH=""
LAST_RUN_URL=""

# `status=success` + `branch=develop` (load-bearing per #879 - without the
# branch filter, a workflow_dispatch run from an unrelated feature branch
# could sort first and permanently poison the comparison) + `per_page=1`
# sorts newest-first by default, so `.workflow_runs[0]` is the most recent
# successful develop run. Wrapped in `if ! raw=$(...)` rather than a bare
# assignment so a `gh api` failure (bad token, network, rate limit, workflow
# renamed) is caught here rather than propagating an unset `$?` past a
# command substitution under `set -e` semantics elsewhere.
if raw="$(gh api "repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs" \
    -X GET -f status=success -f "branch=${BRANCH}" -f per_page=1 \
    --jq '.workflow_runs[0] // empty | [.head_sha, .updated_at, .html_url] | @tsv' \
    2>&1)"; then
  if [ -n "$raw" ]; then
    IFS=$'\t' read -r LAST_SHA LAST_UPDATED_AT LAST_RUN_URL <<< "$raw"
    if [ -n "$LAST_SHA" ] && [ -n "${LAST_UPDATED_AT:-}" ]; then
      if LAST_EPOCH="$(date -u -d "$LAST_UPDATED_AT" +%s 2>/dev/null)"; then
        FETCH_OK=true
      else
        echo "::warning::coverage-skip-gate: could not parse updated_at '${LAST_UPDATED_AT}' - failing open" >&2
      fi
    fi
  else
    echo "::notice::coverage-skip-gate: no previous successful ${WORKFLOW_FILE} run found on ${BRANCH} - failing open (running in full)" >&2
  fi
else
  echo "::warning::coverage-skip-gate: gh api lookup failed - failing open (running in full). Output: ${raw}" >&2
fi

decide_run_coverage "$EVENT_NAME" "$CURRENT_SHA" "$FETCH_OK" "$LAST_SHA" "$LAST_EPOCH" "$NOW_EPOCH" "$FORCE_DAYS"

if [ "$DECISION_RUN" = "false" ]; then
  echo "::notice::Skipping nightly coverage run - ${DECISION_REASON}. Published coverage figures still reflect head_sha=${LAST_SHA} (${LAST_RUN_URL})."
else
  echo "::notice::Running full coverage suite - ${DECISION_REASON}"
fi

{
  echo "run_coverage=${DECISION_RUN}"
  echo "reason=${DECISION_REASON}"
  echo "last_success_sha=${LAST_SHA}"
  echo "last_success_url=${LAST_RUN_URL}"
} >> "$GITHUB_OUTPUT"

exit 0
