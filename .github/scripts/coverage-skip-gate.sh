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
# to `DECISION_RUN=true` - there is no branch anywhere in
# `decide_run_coverage` whose fallback is skip.
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
# ---- #901 review Blocker: the floor could never fire, fixed here ----
# The first shipped version of this script found "the last successful
# coverage.yml run on develop" via a single run-list lookup and measured
# `age_days` against THAT run's timestamp. The bug: a SKIP night's JOB also
# reports overall `success` (only its internal steps show `skipped`), so
# every night - run or skip - produced a fresh "successful run" newer than
# the one before it. Once the SHA stabilised, the lookup always found LAST
# NIGHT'S OWN SKIP as the baseline, `age_days` reset to ~1 every night, and
# `age_days >= FORCE_DAYS` became unreachable - the floor silently never
# fired under sustained stability, defeating the entire rationale above.
#
# The fix distinguishes "the job succeeded" from "coverage was actually
# measured": `fetch_last_real_measurement` walks backwards through the last
# `MAX_LOOKBACK_RUNS` successful runs (newest first) and, for each, fetches
# its job's step list and asks `is_real_measurement_job` whether the
# `test:coverage` step itself concluded `success` (a real measurement) rather
# than `skipped` (a night this same gate skipped). The first run whose
# coverage step actually ran is the baseline for BOTH the SHA comparison and
# the age comparison - so a run of skip nights is transparent to the floor,
# and the floor advances only when a REAL measurement lands.
#
# This needed no permission beyond the `actions: read` this workflow already
# grants: `GET /actions/runs/{id}/jobs` is the same scope as the run-list
# endpoint. The two "fetch" functions
# (`_fetch_runs_list`/`_fetch_job_for_run`) are the ONLY two `gh api` call
# sites in the whole script, factored out specifically so `--selftest` can
# override them with canned JSON and black-box test
# `fetch_last_real_measurement`'s skip-walking loop with zero network access
# - see the self-test section for the exact scenario (three fabricated skip
# nights on top of one real one) that reproduces the review's finding.
#
# `MAX_LOOKBACK_RUNS` bounds how far back a run of skip nights can be walked
# before giving up and failing open (no real measurement found in the
# window). At the default weekly floor this only needs to reach ~7-8 entries
# once the floor is live and firing periodically; it defaults wider (30, the
# #879 issue's own sample window) so the very first runs after this fix
# deploys - and any one-off stretch where the floor was itself disabled or
# broken for a while - still find a genuine prior measurement rather than
# needlessly failing open. If the window is exhausted with no real
# measurement found, `fetch_last_real_measurement` returns non-zero and the
# caller treats it exactly like an API error: fail open, run in full. This
# also means a brand-new repository with zero coverage-workflow history (or
# one where every sampled run predates this workflow's existence) fails
# open on its very first invocation, with no separate bootstrap branch
# needed - there is nothing "first-run-special" in the code path.
#
# This script deliberately NEVER exits non-zero on its own decision logic -
# every external call (the two `gh api` lookups, date parsing) is guarded by
# an explicit `if`, not by `set -e`, precisely because a step that errors
# before writing GITHUB_OUTPUT would stop the job before `npm ci` ever runs,
# which would defeat "ambiguity runs the suite" for the one input class (a
# broken API call) this script exists to be robust against. The
# `GITHUB_OUTPUT` unset-under-real-Actions check near the bottom is the one
# exception - that is an impossible-in-practice misconfiguration (Actions
# always sets it), not a legitimate uncertain input, and mirrors
# classify-docs-only.sh's identical assertion for the same reason.
#
# Production usage (invoked by coverage.yml's `coverage` job as its first
# step - EVENT_NAME/CURRENT_SHA/REPO come from `github.*` context, GH_TOKEN
# from `secrets.GITHUB_TOKEN`):
#   EVENT_NAME=schedule CURRENT_SHA=<sha> REPO=owner/repo \
#   GITHUB_OUTPUT=... GH_TOKEN=... .github/scripts/coverage-skip-gate.sh
# Offline self-test against synthetic inputs, including the #901 regression
# (no network - both `gh api` call sites are overridden with fakes):
#   .github/scripts/coverage-skip-gate.sh --selftest
set -uo pipefail

REPO="${REPO:-DocGerd/sail_command}"
WORKFLOW_FILE="${WORKFLOW_FILE:-coverage.yml}"
BRANCH="${BRANCH:-develop}"
FORCE_DAYS="${FORCE_DAYS:-7}"
MAX_LOOKBACK_RUNS="${MAX_LOOKBACK_RUNS:-30}"

# Cap on the DIGIT COUNT (not the value) of any epoch/day-count this script
# does arithmetic on. 15 digits covers roughly 31.6 million years past the
# Unix epoch - vastly more headroom than any real `date -u +%s` or GitHub
# `updated_at` will ever produce - while staying safely clear of bash's
# 64-bit signed `$(( ))` overflow range (~19 digits). #901 review Minor: this
# was previously unbounded (only a digits-only regex, no length check), so a
# sufficiently long numeric string could in principle overflow the
# arithmetic below; unreachable in practice (both epochs are always sourced
# from `date -u +%s` or a parsed ISO-8601 timestamp) but cheap to close
# outright rather than leave "theoretical".
MAX_EPOCH_DIGITS=15

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
    DECISION_REASON="no usable previous real measurement on ${BRANCH} (API error, empty result, or unparseable timestamp) - failing open"
    return
  fi

  # From here on we trust last_sha/last_epoch are populated; validate the
  # numeric fields before doing arithmetic on them so a corrupt/non-numeric/
  # implausibly-long epoch can never reach `$(( ))` (which could abort the
  # script or overflow regardless of `set -e`, defeating "always exit 0").
  for _pair in "now_epoch:$now_epoch" "last_epoch:$last_epoch" "force_days:$force_days"; do
    _name="${_pair%%:*}"; _val="${_pair#*:}"
    case "$_val" in
      ''|*[!0-9]*)
        DECISION_RUN=true
        DECISION_REASON="${_name} is not a plain integer ('${_val}') - failing open"
        return ;;
    esac
    if [ "${#_val}" -gt "$MAX_EPOCH_DIGITS" ]; then
      DECISION_RUN=true
      DECISION_REASON="${_name} has an implausible digit count (${#_val}, value '${_val}') - failing open (guards the arithmetic below against overflow)"
      return
    fi
  done

  if [ "$current_sha" != "$last_sha" ]; then
    DECISION_RUN=true
    DECISION_REASON="develop has moved since the last real measurement (${last_sha} -> ${current_sha})"
    return
  fi

  local age_days=$(( (now_epoch - last_epoch) / 86400 ))
  if [ "$age_days" -lt 0 ]; then
    DECISION_RUN=true
    DECISION_REASON="last real measurement's timestamp is after now_epoch - ambiguous, failing open"
    return
  fi

  if [ "$age_days" -ge "$force_days" ]; then
    DECISION_RUN=true
    DECISION_REASON="sha unchanged (${last_sha}) but ${age_days}d >= the ${force_days}d weekly floor - forcing a re-measurement (#877 removed the other re-execution path; this floor is now the only guaranteed one)"
    return
  fi

  DECISION_RUN=false
  DECISION_REASON="sha unchanged (${last_sha}) and only ${age_days}d since the last real measurement (< ${force_days}d floor) - skipping"
}

# ---- job classifier (no I/O - pure JSON string in, boolean out) ----
# Takes ONE job object (the shape `gh api .../actions/runs/{id}/jobs --jq
# '.jobs[] | select(.name=="coverage")'` returns) and decides whether its
# `test:coverage` step actually EXECUTED (conclusion "success") rather than
# being gated off by this very script on a skip night (conclusion
# "skipped"). Matches the step by substring/case-insensitive `test:coverage`
# rather than an exact name so it also matches the default GitHub-generated
# step name ("Run npm run test:coverage") that every run BEFORE this fix
# already carries - no discontinuity at the point this script was deployed.
is_real_measurement_job() {
  local job_json="$1"
  local step_conclusion
  step_conclusion="$(printf '%s' "$job_json" | jq -r \
    '[.steps[]? | select(.name != null and (.name | test("test:coverage"; "i")))][0].conclusion // empty' \
    2>/dev/null)"
  [ "$step_conclusion" = "success" ]
}

# ---- the two (and only two) gh api call sites, factored out for testability ----
# Production bodies. --selftest overrides both with fakes below - bash
# resolves a function call at CALL time, so redefining them after this point
# but before `fetch_last_real_measurement` is invoked is sufficient; no
# sourcing or subshell tricks needed.
_fetch_runs_list() {
  local repo="$1" workflow_file="$2" branch="$3" max_runs="$4"
  gh api "repos/${repo}/actions/workflows/${workflow_file}/runs" \
    -X GET -f status=success -f "branch=${branch}" -f "per_page=${max_runs}" \
    --jq '[.workflow_runs[] | {id, head_sha, updated_at, html_url}]'
}

_fetch_job_for_run() {
  local repo="$1" run_id="$2"
  gh api "repos/${repo}/actions/runs/${run_id}/jobs" \
    --jq '[.jobs[] | select(.name == "coverage")][0] // empty'
}

# ---- the walk-back lookup (I/O via the two functions above only) ----
# Returns 0 and prints "head_sha\tupdated_at\thtml_url" for the newest run
# among the last `max_runs` successful runs whose coverage step actually
# executed; returns 1 (nothing printed) on any failure or if none is found -
# both cases the caller treats identically to "no previous run" (fail open).
fetch_last_real_measurement() {
  local repo="$1" workflow_file="$2" branch="$3" max_runs="$4"
  local runs_json
  if ! runs_json="$(_fetch_runs_list "$repo" "$workflow_file" "$branch" "$max_runs" 2>&1)"; then
    return 1
  fi

  local count
  count="$(printf '%s' "$runs_json" | jq 'length' 2>/dev/null)"
  case "${count:-}" in ''|*[!0-9]*) return 1 ;; esac

  local i=0 run_id head_sha updated_at html_url job_json
  while [ "$i" -lt "$count" ]; do
    run_id="$(printf '%s' "$runs_json" | jq -r ".[$i].id")"
    head_sha="$(printf '%s' "$runs_json" | jq -r ".[$i].head_sha")"
    updated_at="$(printf '%s' "$runs_json" | jq -r ".[$i].updated_at")"
    html_url="$(printf '%s' "$runs_json" | jq -r ".[$i].html_url")"

    if job_json="$(_fetch_job_for_run "$repo" "$run_id" 2>/dev/null)" \
        && [ -n "$job_json" ] && is_real_measurement_job "$job_json"; then
      printf '%s\t%s\t%s\n' "$head_sha" "$updated_at" "$html_url"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
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
  check_bool() {
    local label="$1" expected="$2"
    shift 2
    local actual
    if "$@"; then actual=true; else actual=false; fi
    if [ "$actual" = "$expected" ]; then
      PASS=$((PASS + 1))
    else
      FAIL=$((FAIL + 1))
      echo "FAIL: $label - expected $expected got $actual"
    fi
  }

  DAY=86400
  NOW=1700000000

  echo "=== decide_run_coverage: decision-table rows ==="

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
  check "floor boundary: 1 second under 7 days" false \
    schedule shaA true shaA $((NOW - (7 * DAY - 1))) "$NOW" 7
  check "floor boundary: 1 second over 7 days" true \
    schedule shaA true shaA $((NOW - (7 * DAY + 1))) "$NOW" 7

  # --- table row: API error -> run ---
  check "api error (fetch_ok=false)" true \
    schedule shaA false "" "" "$NOW" 7
  check "api call succeeded but returned unparseable garbage" true \
    schedule shaA garbage shaA $((NOW - 1 * DAY)) "$NOW" 7
  check "fetch_ok as literal '1' (not exact 'true') fails open" true \
    schedule shaA 1 shaA $((NOW - 1 * DAY)) "$NOW" 7
  check "fetch_ok as 'TRUE' (case-sensitive mismatch) fails open" true \
    schedule shaA TRUE shaA $((NOW - 1 * DAY)) "$NOW" 7

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

  # --- defensive rows: malformed numeric inputs must fail open ---
  check "non-numeric now_epoch" true \
    schedule shaA true shaA 12345 "not-a-number" 7
  check "non-numeric last_epoch" true \
    schedule shaA true shaA "not-a-number" "$NOW" 7
  check "non-numeric force_days" true \
    schedule shaA true shaA $((NOW - 1 * DAY)) "$NOW" "not-a-number"
  check "force_days=-1 (leading '-' fails the digits-only check)" true \
    schedule shaA true shaA $((NOW - 1 * DAY)) "$NOW" "-1"
  check "force_days=0 forces a run every unchanged night" true \
    schedule shaA true shaA $((NOW - 1)) "$NOW" 0
  check "last_epoch in the future relative to now" true \
    schedule shaA true shaA $((NOW + 1 * DAY)) "$NOW" 7
  # #901 review Minor: overflow-magnitude epochs (19 nines - within a
  # digits-only regex but far past MAX_EPOCH_DIGITS) must fail open, not
  # reach the `$(( ))` arithmetic below.
  check "now_epoch with an implausible digit count (19 nines)" true \
    schedule shaA true shaA $((NOW - 1 * DAY)) "9999999999999999999" 7
  check "last_epoch with an implausible digit count (19 nines)" true \
    schedule shaA true shaA "9999999999999999999" "$NOW" 7

  # --- edge-case SHAs (already resolve to run before this fix; pinned here) ---
  check "empty current_sha" true \
    schedule "" true shaA $((NOW - 1 * DAY)) "$NOW" 7
  check "whitespace-only last_sha" true \
    schedule shaA true "   " $((NOW - 1 * DAY)) "$NOW" 7

  echo
  echo "=== is_real_measurement_job: job-step classifier (#901 review row 1) ==="
  # These are exactly the API shapes a night produces: the overall JOB always
  # concludes "success" whether or not the coverage step ran - only the
  # coverage step's OWN conclusion distinguishes a real measurement from a
  # night this gate itself skipped. This is the classifier whose absence was
  # the #901 Blocker: the original code never asked this question at all.
  REAL_JOB_JSON='{"name":"coverage","steps":[{"name":"Run actions/checkout@abc","conclusion":"success"},{"name":"Decide whether tonight'"'"'s run is needed (#879)","conclusion":"success"},{"name":"Run npm ci","conclusion":"success"},{"name":"Run npm run test:coverage","conclusion":"success"},{"name":"Upload coverage to Codecov","conclusion":"success"}]}'
  SKIP_JOB_JSON='{"name":"coverage","steps":[{"name":"Run actions/checkout@abc","conclusion":"success"},{"name":"Decide whether tonight'"'"'s run is needed (#879)","conclusion":"success"},{"name":"Run npm ci","conclusion":"skipped"},{"name":"Run npm run test:coverage","conclusion":"skipped"},{"name":"Upload coverage to Codecov","conclusion":"skipped"}]}'
  EMPTY_JOB_JSON='{"name":"coverage","steps":[]}'
  MISSING_STEP_JOB_JSON='{"name":"coverage","steps":[{"name":"Run actions/checkout@abc","conclusion":"success"}]}'

  check_bool "a real night's job classifies as a real measurement" true \
    is_real_measurement_job "$REAL_JOB_JSON"
  check_bool "a SKIP night's job (job=success, step=skipped) classifies as NOT a real measurement - the #901 Blocker" false \
    is_real_measurement_job "$SKIP_JOB_JSON"
  check_bool "a job with no steps at all classifies as NOT a real measurement" false \
    is_real_measurement_job "$EMPTY_JOB_JSON"
  check_bool "a job missing the coverage step entirely classifies as NOT a real measurement" false \
    is_real_measurement_job "$MISSING_STEP_JOB_JSON"

  echo
  echo "=== fetch_last_real_measurement: black-box walk-back test (#901 review row 1/2) ==="
  # Fabricate exactly the review's reported scenario: the three newest
  # successful runs are skip nights (job=success, coverage step=skipped),
  # and the fourth (oldest sampled) is the last run that actually measured.
  # Both gh-api call sites are overridden - zero network - so this exercises
  # the REAL production loop in fetch_last_real_measurement, not a
  # hand-modeled stand-in.
  _fetch_runs_list() {
    cat <<'JSON'
[
  {"id": 4, "head_sha": "shaSTABLE", "updated_at": "2026-09-03T02:20:00Z", "html_url": "https://example.invalid/runs/4"},
  {"id": 3, "head_sha": "shaSTABLE", "updated_at": "2026-09-02T02:20:00Z", "html_url": "https://example.invalid/runs/3"},
  {"id": 2, "head_sha": "shaSTABLE", "updated_at": "2026-09-01T02:20:00Z", "html_url": "https://example.invalid/runs/2"},
  {"id": 1, "head_sha": "shaSTABLE", "updated_at": "2026-08-31T02:20:00Z", "html_url": "https://example.invalid/runs/1"}
]
JSON
  }
  _fetch_job_for_run() {
    case "$2" in
      4|3|2) printf '%s' "$SKIP_JOB_JSON" ;;
      1) printf '%s' "$REAL_JOB_JSON" ;;
      *) printf '' ;;
    esac
  }

  WALKBACK_RESULT="$(fetch_last_real_measurement "owner/repo" "coverage.yml" "develop" 4)"
  WALKBACK_RC=$?
  WALKBACK_EXPECTED="$(printf 'shaSTABLE\t2026-08-31T02:20:00Z\thttps://example.invalid/runs/1')"
  if [ "$WALKBACK_RC" -eq 0 ] && [ "$WALKBACK_RESULT" = "$WALKBACK_EXPECTED" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: walk-back over 3 fabricated skip nights should land on run 1 (the real one) - got rc=$WALKBACK_RC result='$WALKBACK_RESULT'"
  fi

  # Every sampled run is a skip - no real measurement anywhere in the window.
  _fetch_job_for_run() { printf '%s' "$SKIP_JOB_JSON"; }
  if ! fetch_last_real_measurement "owner/repo" "coverage.yml" "develop" 4 >/dev/null; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: an all-skip window should return failure (fail open upstream), but fetch_last_real_measurement succeeded"
  fi

  # Empty run list (brand-new workflow / repo).
  _fetch_runs_list() { printf '[]'; }
  if ! fetch_last_real_measurement "owner/repo" "coverage.yml" "develop" 30 >/dev/null; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: an empty run list should return failure, but fetch_last_real_measurement succeeded"
  fi

  # The run-list API call itself fails (network/auth/rate-limit).
  _fetch_runs_list() { echo "simulated gh api failure" >&2; return 1; }
  if ! fetch_last_real_measurement "owner/repo" "coverage.yml" "develop" 30 >/dev/null 2>&1; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: a failing run-list API call should return failure, but fetch_last_real_measurement succeeded"
  fi

  echo
  echo "=== multi-night simulation: does the floor fire under sustained SHA stability? (#901 review row 2) ==="
  # Models N consecutive nights on an unchanged SHA, feeding each night's
  # OWN outcome into the NEXT night's baseline - exactly what the shipped
  # `fetch_last_real_measurement` does across real nightly runs, just
  # without the gh-api round-trip. `buggy=true` reproduces the #901 defect
  # verbatim: the baseline advances on EVERY successful job (run or skip),
  # because that is what "last successful workflow run" meant before this
  # fix. `buggy=false` is the shipped behaviour: the baseline advances ONLY
  # when that night actually measured (decision=run).
  simulate_stable_nights() {
    local n="$1" force_days="$2" buggy="$3"
    local sha="shaSTABLE"
    local last_sha="$sha"
    local last_epoch=0
    local run_count=0
    local i now_epoch
    for i in $(seq 1 "$n"); do
      now_epoch=$((i * DAY))
      DECISION_RUN=""; DECISION_REASON=""
      decide_run_coverage schedule "$sha" true "$last_sha" "$last_epoch" "$now_epoch" "$force_days"
      echo "  night $i: decision=${DECISION_RUN} baseline_age_days=$(( (now_epoch - last_epoch) / DAY )) reason=${DECISION_REASON}"
      if [ "$DECISION_RUN" = "true" ]; then
        run_count=$((run_count + 1))
        last_epoch="$now_epoch"
        last_sha="$sha"
      elif [ "$buggy" = "true" ]; then
        # BUG REPRODUCTION (#901 review Blocker): a skip night's JOB also
        # reports overall "success", so the original "last successful run"
        # lookup advanced the baseline on this skip exactly as readily as on
        # a real run.
        last_epoch="$now_epoch"
        last_sha="$sha"
      fi
    done
    echo "RUN_COUNT=$run_count"
  }

  echo "--- FIXED baseline (advances only on a real measurement), 21 nights, 7-day floor ---"
  FIXED_OUT="$(simulate_stable_nights 21 7 false)"
  echo "$FIXED_OUT"
  FIXED_RUNS="$(printf '%s\n' "$FIXED_OUT" | grep -oE 'RUN_COUNT=[0-9]+' | cut -d= -f2)"
  if [ "$FIXED_RUNS" = "3" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: fixed 21-night simulation expected exactly 3 forced runs (nights 7, 14, 21), got $FIXED_RUNS"
  fi

  echo "--- BUGGY baseline (advances on every successful job, matching the #901 defect), 21 nights, 7-day floor ---"
  BUGGY_OUT="$(simulate_stable_nights 21 7 true)"
  echo "$BUGGY_OUT"
  BUGGY_RUNS="$(printf '%s\n' "$BUGGY_OUT" | grep -oE 'RUN_COUNT=[0-9]+' | cut -d= -f2)"
  if [ "$BUGGY_RUNS" = "0" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: buggy-baseline control should demonstrate the floor NEVER firing (0 forced runs) over 21 nights, got $BUGGY_RUNS - the control itself is broken"
  fi

  echo
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

if raw="$(fetch_last_real_measurement "$REPO" "$WORKFLOW_FILE" "$BRANCH" "$MAX_LOOKBACK_RUNS")"; then
  IFS=$'\t' read -r LAST_SHA LAST_UPDATED_AT LAST_RUN_URL <<< "$raw"
  if [ -n "$LAST_SHA" ] && [ -n "${LAST_UPDATED_AT:-}" ]; then
    if LAST_EPOCH="$(date -u -d "$LAST_UPDATED_AT" +%s 2>/dev/null)"; then
      FETCH_OK=true
    else
      echo "::warning::coverage-skip-gate: could not parse updated_at '${LAST_UPDATED_AT}' - failing open" >&2
    fi
  fi
else
  echo "::notice::coverage-skip-gate: no previous REAL coverage measurement found among the last ${MAX_LOOKBACK_RUNS} successful ${WORKFLOW_FILE} runs on ${BRANCH} (API error, empty history, or every sampled run was itself skipped) - failing open (running in full)" >&2
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
