#!/usr/bin/env bash
# Skip-retest classifier for ci.yml's `app` and `e2e` jobs (#877).
#
# #877's measurement: every recent `develop` merge commit's TREE is
# byte-identical to its second parent (the PR head that had just passed
# `app` + `e2e`), because the `protect-main` ruleset's strict up-to-date
# policy forces the PR base to already be the develop tip. A push whose tree
# is provably identical to an already-tested tree gains nothing by re-running
# the full test suite - see CLAUDE.md's cost figures (#877's own issue body).
#
# `retest` follows #327's polarity exactly: `retest != 'false'` means RUN the
# expensive steps; an absent, empty, or any-value-other-than-'false' output
# runs them. Only an explicit `retest=false` skips - the same fail-closed
# shape as classify-docs-only.sh's `run_e2e`/`run_app`.
#
# WHAT THIS SCRIPT DOES NOT DO: it is invoked identically by BOTH the `app`
# and `e2e` jobs (each with its own $CHECK_NAME), and it only ever looks at
# ONE job's own check-run on the SECOND PARENT of a push commit. It has no
# opinion about pull_request events at all - for anything other than `push`
# it returns `retest=true` (run) immediately, so PR runs are completely
# unaffected (#877 acceptance: "PR runs are untouched").
#
# THE RECURSION HAZARD (#877's own issue body, "Recursion hazard, and it is
# real"): a SKIPPED job still reports check conclusion `success`. On a
# `main` push, `HEAD^2` is develop's tip, whose own push run would ITSELF
# have been a skipped success if this gate had already fired there once -
# so "some successful $CHECK_NAME check-run exists on HEAD^2" is NOT
# sufficient on its own; it degrades to nothing after one hop. This script
# closes that hole by requiring the referenced check-run's OWN WORKFLOW RUN
# to have `event == pull_request` - a run that skipped via THIS gate is
# always a `push` event, so it can never satisfy that requirement, and the
# recursion cannot propagate past the run that actually executed the tests.
#
# API traps this repo has already paid for (CLAUDE.md, "API traps this repo
# has already paid for" under #877's own bullet): use the commit's
# `check-runs` listing, never `runs?head_sha=` (measured returning
# `total_count: 0` for a live run); attribute a check-run by the run id
# embedded in its OWN `details_url`, never by check NAME alone (one SHA can
# carry several runs' worth of same-named check-runs). This script follows
# both: it lists check-runs on the SECOND-PARENT SHA filtered by
# `.name == $CHECK_NAME`, then resolves each candidate's run id from that
# entry's own `details_url` before asking that SPECIFIC run for its `.event`.
#
# FAIL-CLOSED (same posture as classify-docs-only.sh): anything ambiguous -
# not a push event, not a 2-parent merge commit, an unreachable second
# parent, a tree mismatch, a `gh api` failure, no qualifying check-run, or a
# qualifying check-run whose OWN run was not a `pull_request` event - all
# return `retest=true` (run the steps). Only the one specific, fully-verified
# shape returns `retest=false`.
#
# `set -euo pipefail`: the errexit guarantee lives in THIS FILE (see
# classify-docs-only.sh's identical note on why `bash -e` at the call site is
# belt-and-braces, not load-bearing on its own) - ci.yml still invokes this
# script as `bash -e .github/scripts/classify-retest.sh` for the same reason.
#
# Production usage (invoked once per job, with that job's own CHECK_NAME):
#   EVENT_NAME=push HEAD_SHA=... CHECK_NAME=app GITHUB_REPOSITORY=owner/repo \
#   GITHUB_OUTPUT=... GITHUB_STEP_SUMMARY=... \
#   bash -e .github/scripts/classify-retest.sh
# Offline self-test against synthesized git repos plus a stubbed `gh` (no
# network, no real GitHub API calls):
#   .github/scripts/classify-retest.sh --selftest
set -euo pipefail

# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  # Re-invoke THIS exact file as a child process under `bash -e`, matching
  # classify-docs-only.sh's own verbatim-script testing rationale.
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  PASS=0; FAIL=0
  EXPECTED_CASES=13

  echo "=== classify-retest.sh: ${EXPECTED_CASES} adversarial cases (bash -e, GH default shell) ==="

  mkrepo() {
    d="$(mktemp -d)"; cd "$d" || exit 1
    git init -q -b main . >/dev/null 2>&1
    git config user.email t@t; git config user.name t; git config commit.gpgsign false
    echo base > f.txt; git add -A >/dev/null; git commit -qm base >/dev/null
    echo "$d"
  }

  # A "stub gh" is defined ONCE and exported for every case below; each case
  # supplies its own fixture via env vars that the stub reads at CALL time,
  # so no per-case redefinition is needed. This mirrors real `gh api` calls
  # byte-for-byte in shape (see the two call sites in the production path
  # below) without touching the network.
  gh() {
    if [ "${1:-}" = "api" ]; then
      local path="${2:-}"
      case "$path" in
        repos/*/commits/*/check-runs)
          if [ "${RETEST_STUB_CHECKRUNS_FAIL:-}" = "1" ]; then
            return 1
          fi
          printf '%s\n' "${RETEST_STUB_CHECKRUNS_TSV:-}"
          return 0
          ;;
        repos/*/actions/runs/*)
          local rid
          rid="$(printf '%s' "$path" | sed -E 's#.*/actions/runs/([0-9]+)$#\1#')"
          if [ "$rid" = "${RETEST_STUB_APP_RUN_ID:-__unset__}" ]; then
            printf '%s\n' "${RETEST_STUB_APP_RUN_EVENT:-}"
            return 0
          fi
          if [ "$rid" = "${RETEST_STUB_PUSH_RUN_ID:-__unset__}" ]; then
            printf '%s\n' "${RETEST_STUB_PUSH_RUN_EVENT:-push}"
            return 0
          fi
          return 1
          ;;
        *)
          return 1
          ;;
      esac
    fi
    return 1
  }
  export -f gh

  invoke() {
    local out sum log rc got reason
    out="$(mktemp)"; sum="$(mktemp)"; log="$(mktemp)"
    set +e
    GITHUB_OUTPUT="$out" GITHUB_STEP_SUMMARY="$sum" bash -e "$SELF" >"$log" 2>&1
    rc=$?
    set -e
    got="$(grep -o 'retest=[a-z]*' "$out" 2>/dev/null | tail -1 | cut -d= -f2)"
    [ -z "$got" ] && got="<none:step-exit-$rc>"
    reason="$(grep -o 'reason=.*' "$log" | tail -1)"
    printf '%s|%s\n' "$got" "${reason:-step failed rc=$rc}"
    rm -f "$out" "$sum" "$log"
  }

  check() {
    local label="$1" expect="$2" result got reason
    result="$(invoke)"
    got="${result%%|*}"
    reason="${result#*|}"
    if [ "$got" = "$expect" ]; then
      printf '  OK   %-58s -> %-8s (%s)\n' "$label" "$got" "$reason"
      PASS=$((PASS + 1))
    else
      printf '  XX   %-58s -> %-8s expected %s  (%s)\n' "$label" "$got" "$expect" "$reason"
      FAIL=$((FAIL + 1))
    fi
  }

  reset_stubs() {
    unset RETEST_STUB_CHECKRUNS_FAIL RETEST_STUB_CHECKRUNS_TSV \
      RETEST_STUB_APP_RUN_ID RETEST_STUB_APP_RUN_EVENT \
      RETEST_STUB_PUSH_RUN_ID RETEST_STUB_PUSH_RUN_EVENT 2>/dev/null || true
    export CHECK_NAME=app GITHUB_REPOSITORY=o/r
  }

  # commit_tree <tree-ish> <parent1> <parent2> - plumbing so a merge
  # commit's tree can be pinned INDEPENDENTLY of its parents, letting the
  # tree-match and tree-mismatch cases be constructed directly rather than
  # relying on `git merge` machinery to happen to agree or disagree.
  commit_tree() {
    git commit-tree "$1" -p "$2" -p "$3" -m merge
  }

  # ---------- 1 non-push event ----------
  reset_stubs
  r=$(mkrepo); cd "$r"
  EVENT_NAME=pull_request HEAD_SHA=$(git rev-parse HEAD)
  export EVENT_NAME HEAD_SHA
  check "1  non-push event (pull_request)" true

  # ---------- 2 push, empty HEAD_SHA ----------
  reset_stubs
  r=$(mkrepo); cd "$r"
  EVENT_NAME=push HEAD_SHA=""
  export EVENT_NAME HEAD_SHA
  check "2  push, empty HEAD_SHA" true

  # ---------- 3 push, HEAD_SHA unreachable ----------
  reset_stubs
  r=$(mkrepo); cd "$r"
  EVENT_NAME=push HEAD_SHA=0000000000000000000000000000000000000009
  export EVENT_NAME HEAD_SHA
  check "3  push, HEAD_SHA unreachable" true

  # ---------- 4 push, single-parent (non-merge) commit ----------
  reset_stubs
  r=$(mkrepo); cd "$r"
  EVENT_NAME=push HEAD_SHA=$(git rev-parse HEAD)
  export EVENT_NAME HEAD_SHA
  check "4  push, single-parent commit (not a merge)" true

  # ---------- 5 push, octopus merge (3 parents) ----------
  reset_stubs
  r=$(mkrepo); cd "$r"
  BASE=$(git rev-parse HEAD)
  git switch -qc b1; echo x1 >> f.txt; git commit -qam b1; B1=$(git rev-parse HEAD)
  git switch -q main; git switch -qc b2; echo x2 >> f.txt; git commit -qam b2; B2=$(git rev-parse HEAD)
  # `git commit-tree` accepts any number of `-p` flags directly - three here
  # makes an octopus merge in one call.
  OCTOPUS=$(git commit-tree "${BASE}^{tree}" -p "$BASE" -p "$B1" -p "$B2" -m octopus)
  EVENT_NAME=push HEAD_SHA="$OCTOPUS"
  export EVENT_NAME HEAD_SHA
  check "5  push, octopus merge (3 parents)" true

  # ---------- 6 push, 2-parent merge, second parent unreachable ----------
  # `git commit-tree` VALIDATES that every `-p` parent object already exists
  # (measured 2026-09-03: `fatal: ... is not a valid object`), so a bogus
  # second parent cannot be constructed that way - it would abort this whole
  # selftest under `set -e` before the case even ran. `git hash-object -w
  # --stdin -t commit` writes a commit object VERBATIM with no such
  # validation (git's object store doesn't enforce graph consistency at
  # write time), which is what lets this case exist at all: it models a
  # commit whose second parent's OWN object was never fetched (a real
  # shallow-clone shape), not merely an invalid SHA string.
  reset_stubs
  r=$(mkrepo); cd "$r"
  BASE=$(git rev-parse HEAD)
  BASE_TREE=$(git rev-parse "${BASE}^{tree}")
  BOGUS=0000000000000000000000000000000000000042
  MERGE=$(printf 'tree %s\nparent %s\nparent %s\nauthor t <t@t> 0 +0000\ncommitter t <t@t> 0 +0000\n\nmerge\n' \
    "$BASE_TREE" "$BASE" "$BOGUS" | git hash-object -w --stdin -t commit)
  EVENT_NAME=push HEAD_SHA="$MERGE"
  export EVENT_NAME HEAD_SHA
  check "6  push, 2-parent merge, 2nd parent unreachable" true

  # ---------- 7 push, 2-parent merge, tree MISMATCH ----------
  reset_stubs
  r=$(mkrepo); cd "$r"
  BASE=$(git rev-parse HEAD)
  git switch -qc feat; echo changed >> f.txt; git commit -qam feat; FEAT=$(git rev-parse HEAD)
  # Merge commit's tree is pinned to BASE's tree, not FEAT's - a deliberate
  # mismatch a real `git merge` would not normally produce, constructed via
  # plumbing so the mismatch path is directly testable.
  MERGE=$(commit_tree "${BASE}^{tree}" "$BASE" "$FEAT")
  EVENT_NAME=push HEAD_SHA="$MERGE"
  export EVENT_NAME HEAD_SHA
  check "7  push, 2-parent merge, tree MISMATCHES 2nd parent" true

  # A shared "tree MATCHES 2nd parent" fixture for cases 8-13: the merge
  # commit's tree is pinned to FEAT's tree, modelling develop's strict
  # up-to-date policy (#877's own measurement: 12/12 recent merges this way).
  # Echoes "<repo-dir> <merge-sha>" on ONE line - the function body runs
  # inside the command-substitution SUBSHELL that captures its output, so a
  # `cd` inside it (needed to run `git switch`/`git commit` in the right
  # place) is invisible to the CALLER's shell. The caller must `cd` again
  # itself using the returned dir, exactly as `mkrepo` requires elsewhere in
  # this file's own selftest pattern.
  mk_matching_merge() {
    r=$(mkrepo); cd "$r"
    BASE=$(git rev-parse HEAD)
    git switch -qc feat; echo changed >> f.txt; git commit -qam feat; FEAT=$(git rev-parse HEAD)
    MERGE=$(commit_tree "${FEAT}^{tree}" "$BASE" "$FEAT")
    printf '%s %s\n' "$r" "$MERGE"
  }

  # ---------- 8 tree match, gh api check-runs call fails ----------
  reset_stubs
  read -r REPODIR MERGE <<< "$(mk_matching_merge)"; cd "$REPODIR"
  EVENT_NAME=push HEAD_SHA="$MERGE" RETEST_STUB_CHECKRUNS_FAIL=1
  export EVENT_NAME HEAD_SHA RETEST_STUB_CHECKRUNS_FAIL
  check "8  tree match, gh api check-runs call fails" true

  # ---------- 9 tree match, no qualifying check-run entries at all ----------
  reset_stubs
  read -r REPODIR MERGE <<< "$(mk_matching_merge)"; cd "$REPODIR"
  EVENT_NAME=push HEAD_SHA="$MERGE" RETEST_STUB_CHECKRUNS_TSV=""
  export EVENT_NAME HEAD_SHA RETEST_STUB_CHECKRUNS_TSV
  check "9  tree match, zero check-run entries for CHECK_NAME" true

  # ---------- 10 tree match, check-run present but not success (skipped) ----------
  reset_stubs
  read -r REPODIR MERGE <<< "$(mk_matching_merge)"; cd "$REPODIR"
  EVENT_NAME=push HEAD_SHA="$MERGE"
  RETEST_STUB_CHECKRUNS_TSV=$'skipped\thttps://github.com/o/r/actions/runs/1111/job/2222'
  export EVENT_NAME HEAD_SHA RETEST_STUB_CHECKRUNS_TSV
  check "10 tree match, check-run conclusion=skipped (forced-skip probe)" true

  # ---------- 11 tree match, success but run event != pull_request (recursion guard) ----------
  reset_stubs
  read -r REPODIR MERGE <<< "$(mk_matching_merge)"; cd "$REPODIR"
  EVENT_NAME=push HEAD_SHA="$MERGE"
  RETEST_STUB_CHECKRUNS_TSV=$'success\thttps://github.com/o/r/actions/runs/1111/job/2222'
  RETEST_STUB_APP_RUN_ID=1111
  RETEST_STUB_APP_RUN_EVENT=push
  export EVENT_NAME HEAD_SHA RETEST_STUB_CHECKRUNS_TSV RETEST_STUB_APP_RUN_ID RETEST_STUB_APP_RUN_EVENT
  check "11 tree match, success but referenced run event=push (recursion guard)" true

  # ---------- 12 tree match, success and run event == pull_request (the ONE skip case) ----------
  reset_stubs
  read -r REPODIR MERGE <<< "$(mk_matching_merge)"; cd "$REPODIR"
  EVENT_NAME=push HEAD_SHA="$MERGE"
  RETEST_STUB_CHECKRUNS_TSV=$'success\thttps://github.com/o/r/actions/runs/1111/job/2222'
  RETEST_STUB_APP_RUN_ID=1111
  RETEST_STUB_APP_RUN_EVENT=pull_request
  export EVENT_NAME HEAD_SHA RETEST_STUB_CHECKRUNS_TSV RETEST_STUB_APP_RUN_ID RETEST_STUB_APP_RUN_EVENT
  check "12 tree match, success, referenced run event=pull_request -> SKIP" false

  # ---------- 13 tree match, MULTIPLE check-run entries: one push-success, ----------
  # one pull_request-success - proves the loop skips the disqualifying entry
  # and finds the qualifying one rather than stopping at the first line.
  reset_stubs
  read -r REPODIR MERGE <<< "$(mk_matching_merge)"; cd "$REPODIR"
  EVENT_NAME=push HEAD_SHA="$MERGE"
  RETEST_STUB_CHECKRUNS_TSV=$'success\thttps://github.com/o/r/actions/runs/3333/job/4444\nsuccess\thttps://github.com/o/r/actions/runs/1111/job/2222'
  RETEST_STUB_PUSH_RUN_ID=3333
  RETEST_STUB_PUSH_RUN_EVENT=push
  RETEST_STUB_APP_RUN_ID=1111
  RETEST_STUB_APP_RUN_EVENT=pull_request
  export EVENT_NAME HEAD_SHA RETEST_STUB_CHECKRUNS_TSV RETEST_STUB_PUSH_RUN_ID RETEST_STUB_PUSH_RUN_EVENT RETEST_STUB_APP_RUN_ID RETEST_STUB_APP_RUN_EVENT
  check "13 tree match, multiple check-runs, one qualifies -> SKIP" false

  echo
  echo "PASS=$PASS FAIL=$FAIL"
  TOTAL=$((PASS + FAIL))
  if ! [ "$TOTAL" -eq "$EXPECTED_CASES" ] 2>/dev/null; then
    echo "SELFTEST FAILURES: ran $TOTAL cases, expected ${EXPECTED_CASES:-<unset/empty>} - a case was skipped or silently dropped"
    exit 1
  fi
  if [ "$FAIL" -eq 0 ]; then echo "SELFTEST OK"; else echo "SELFTEST FAILURES"; fi
  exit "$FAIL"
fi

# ---- production path ----
EVENT_NAME="${EVENT_NAME:-}"
HEAD_SHA="${HEAD_SHA:-}"
CHECK_NAME="${CHECK_NAME:-}"
REPO="${GITHUB_REPOSITORY:-}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/null}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

# Same rationale as classify-docs-only.sh's identical guard: a decision
# silently discarded to /dev/null under real Actions is indistinguishable
# from "skip" once the outer `if: retest != 'false'` gate reads the absent
# output.
if [ -n "${GITHUB_ACTIONS:-}" ] && [ "$GITHUB_OUTPUT" = /dev/null ]; then
  echo "::error::GITHUB_OUTPUT is unset under GitHub Actions - refusing to silently write the retest decision to /dev/null (that would read as 'skip' to the job's if: gates)" >&2
  exit 1
fi

retest=true
reason="not a push event"
p2=""
rid=""

if [ "${EVENT_NAME}" = "push" ]; then
  retest=true
  reason="head commit unreachable"
  if [ -n "${HEAD_SHA}" ] && git cat-file -e "${HEAD_SHA}^{commit}" 2>/dev/null; then
    # `git cat-file -p <sha>` prints the commit's OWN raw object content
    # (tree/parent/author/committer/message) WITHOUT needing to open any
    # parent object - unlike `git rev-list --parents`, which tries to walk
    # (and therefore READ) each parent to build its output and aborts with
    # exit 128 the instant one is missing, making the very "second parent
    # unreachable" case this script exists to fail closed on also abort the
    # whole script under `set -e` before that fail-closed branch could run.
    # Measured directly (2026-09-03): `git rev-list --parents -n 1` on a
    # commit whose second parent object is absent fails outright with
    # "Failed to traverse parents of commit ..."; `git cat-file -p` on the
    # same commit succeeds and lists both parent lines unconditionally.
    if ! commit_body="$(git cat-file -p "${HEAD_SHA}^{commit}" 2>/dev/null)"; then
      retest=true
      reason="could not read commit object for ${HEAD_SHA}"
    else
      mapfile -t parent_arr < <(printf '%s\n' "${commit_body}" | sed -n 's/^parent //p')
      if [ "${#parent_arr[@]}" -ne 2 ]; then
        retest=true
        reason="not a 2-parent merge commit (found ${#parent_arr[@]} parents)"
      else
        p2="${parent_arr[1]}"
        if ! git cat-file -e "${p2}^{commit}" 2>/dev/null; then
          retest=true
          reason="second parent ${p2} unreachable (shallow clone?)"
        else
          head_tree="$(git rev-parse "${HEAD_SHA}^{tree}" 2>/dev/null || true)"
          p2_tree="$(git rev-parse "${p2}^{tree}" 2>/dev/null || true)"
          if [ -z "${head_tree}" ] || [ -z "${p2_tree}" ]; then
            retest=true
            reason="could not resolve a tree object"
          elif [ "${head_tree}" != "${p2_tree}" ]; then
            retest=true
            reason="tree differs from second parent ${p2}"
          else
            # Tree matches - look for an already-green, GENUINELY-EXECUTED
            # ${CHECK_NAME} check-run on the second parent. "Genuinely
            # executed" means: conclusion is success, AND the run that
            # produced it was a pull_request event - never a push, which is
            # the recursion guard this whole script exists to enforce (see
            # header).
            retest=true
            reason="no qualifying ${CHECK_NAME} check-run found on ${p2}"
            if checkruns="$(gh api "repos/${REPO}/commits/${p2}/check-runs" --jq ".check_runs[] | select(.name==\"${CHECK_NAME}\") | [.conclusion, .details_url] | @tsv" 2>/dev/null)"; then
              while IFS=$'\t' read -r concl url; do
                [ -z "${concl:-}" ] && continue
                [ "${concl}" != "success" ] && continue
                rid="$(printf '%s' "$url" | sed -E 's#.*/actions/runs/([0-9]+)/job/.*#\1#')"
                [ -z "$rid" ] && continue
                if ev="$(gh api "repos/${REPO}/actions/runs/${rid}" --jq '.event' 2>/dev/null)"; then
                  if [ "$ev" = "pull_request" ]; then
                    retest=false
                    reason="tree matches already-tested PR head ${p2}; ${CHECK_NAME} run ${rid} (pull_request, success)"
                    break
                  fi
                fi
              done <<< "${checkruns}"
            else
              retest=true
              reason="gh api check-runs lookup failed for ${p2}"
            fi
          fi
        fi
      fi
    fi
  fi
fi

echo "retest=${retest} reason=${reason}"
if [ "${retest}" = "false" ]; then
  echo "::notice::Skipping ${CHECK_NAME} re-test: tree matches already-tested PR head ${p2}, run ${rid} (pull_request, success) - see the job summary for detail"
fi

echo "retest=${retest}" >> "$GITHUB_OUTPUT"
{
  echo "### ${CHECK_NAME} retest classification (#877)"
  echo "- retest: **${retest}**"
  echo "- reason: ${reason}"
} >> "$GITHUB_STEP_SUMMARY"
