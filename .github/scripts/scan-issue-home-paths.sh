#!/usr/bin/env bash
# ADVISORY sweep: hunt a contributor's absolute home-directory path leaked
# into an issue body, a PR body, an issue/PR conversation comment, or a PR
# review (inline diff) comment — a surface `.github/scripts/
# check-no-home-paths.sh` (#474) cannot see at all, because that script's
# `scan_tree()` walks `git ls-files` and greps tracked FILE CONTENTS. An
# issue/PR/comment body is never a git object; it lives only behind the
# GitHub API. Written for #675 — a comment on issue #346 published an
# absolute home path this way, caught only by a human reviewer's out-of-diff
# observation, not by any automated control.
#
# THIS IS DELIBERATELY A SEPARATE SCRIPT, not an extension of
# check-no-home-paths.sh, for two independent reasons. (1) #675's own body
# names them siblings, not the same gap: one is git-object content a file
# scan misses (symlink targets, #479), the other is GitHub-API-hosted prose
# that was never part of the git tree at all — different retrieval mechanism,
# different failure mode. (2) check-no-home-paths.sh is wired into the
# REQUIRED `app` job and BLOCKS a merge; nothing here can ever be a blocking
# pre-merge gate, because GitHub has no equivalent gate for issue/PR/comment
# CREATION (#675's own "Possible directions" section says so explicitly) — a
# leak is visible to the public the instant it is posted, long before any
# scheduled sweep runs. Coupling this script to the required one (a shared
# sourced file, a shared exit-code contract) would put a change made for THIS
# advisory surface one edit away from reddening a REQUIRED check for the
# unrelated tracked-file surface. The two scripts therefore duplicate their
# PATTERN CLASSES (below) rather than share them; if a class is added to one,
# consider whether the other needs it too, but do not merge the two files.
#
# GUARD-ASYMMETRY (CLAUDE.md): this is a NUDGE, not a BLOCKING guard — it can
# only ever fire AFTER publication, and its own detection window is bounded
# by how often the scheduling workflow runs, never by pre-merge review. A
# nudge must FAIL OPEN: a parse failure, a missing tool, or an API error must
# produce NOISE (a failed run, worth a human's five minutes), never SILENCE
# (a script that reports "clean" without having actually looked). Concretely:
# a missing `gh`/`jq`, an unreachable API, a record that will not parse as
# JSON, or a fetch returning suspiciously zero records all end this script at
# exit 2 ("could not verify"), which is a DIFFERENT exit code from 0 ("looked,
# and it's clean") — a monitoring human must never confuse the two. Exit 1
# means "looked, and found something."
#
# WHAT THIS DOES NOT COVER (state the gap, don't paper over it): top-level PR
# REVIEW SUMMARY text (`GET /repos/{o}/{r}/pulls/{n}/reviews`) has no
# repo-wide list endpoint — only a per-PR one — so scanning it here would mean
# enumerating every PR individually. Left out deliberately for this pass; if
# extended, add it as a FOURTH fetch alongside the three below, reusing
# `scan_record` unchanged.
#
# Production usage (needs `gh` authenticated — e.g. `GH_TOKEN` from
# `${{ secrets.GITHUB_TOKEN }}` in Actions — and `jq`):
#   .github/scripts/scan-issue-home-paths.sh                 # repo = $GITHUB_REPOSITORY
#   .github/scripts/scan-issue-home-paths.sh --repo owner/repo
# Offline self-test (constructs synthetic JSONL records; makes NO network
# call except in the two "missing tool" fail-closed cases, which stub PATH
# instead of touching the network):
#   .github/scripts/scan-issue-home-paths.sh --selftest
set -uo pipefail

# ---------------------------------------------------------------------------
# Pattern classes — INTENTIONALLY the same shapes as
# check-no-home-paths.sh's CLASS_* arrays (kept as a separate copy per the
# no-shared-file rationale above). THIS SCRIPT MUST NOT CONTAIN ANY REAL
# USERNAME (same guard-asymmetry corollary as the sibling script): it matches
# a GENERIC SHAPE, never a hardcoded identity.
CLASS_NAMES=(linux-home macos-home windows-home tmp-scratchpad flattened-projects mnt-c-users wsl-unc-dollar wsl-unc-localhost)

CLASS_GREP_ERE=(
  '/home/[A-Za-z0-9_.-]+'
  '/Users/[A-Za-z0-9_.-]+'
  'C:\\Users\\[A-Za-z0-9_.-]+'
  '/tmp/claude-[0-9]+/-home-[A-Za-z0-9._-]+'
  'projects/-home-[A-Za-z0-9._-]+'
  '/mnt/c/Users/[A-Za-z0-9_.-]+'
  '\\\\wsl\$\\[A-Za-z0-9_. -]+\\home\\[A-Za-z0-9_.-]+'
  '\\\\wsl\.localhost\\[A-Za-z0-9_. -]+\\home\\[A-Za-z0-9_.-]+'
)

CLASS_BASH_ERE=(
  '^/home/([A-Za-z0-9_.-]+)$'
  '^/Users/([A-Za-z0-9_.-]+)$'
  '^C:\\Users\\([A-Za-z0-9_.-]+)$'
  '^/tmp/claude-[0-9]+/-home-([A-Za-z0-9._-]+)$'
  '^projects/-home-([A-Za-z0-9._-]+)$'
  '^/mnt/c/Users/([A-Za-z0-9_.-]+)$'
  '^\\\\wsl\$\\[A-Za-z0-9_. -]+\\home\\([A-Za-z0-9_.-]+)$'
  '^\\\\wsl\.localhost\\[A-Za-z0-9_. -]+\\home\\([A-Za-z0-9_.-]+)$'
)

CLASS_APPLY_ALLOWLIST=(1 1 1 0 0 1 0 0)

ALLOWED_PLACEHOLDERS=(user users you USER runner)

is_allowed_token() {
  local token="$1" a
  for a in "${ALLOWED_PLACEHOLDERS[@]}"; do
    [ "$token" = "$a" ] && return 0
  done
  return 1
}

# scan_record TYPE NUMBER URL BODY -> prints one "TYPE:NUMBER:URL:CLASS:MATCH"
# row per violation found in BODY to stdout; returns 0 if at least one
# violation was printed, 1 if none (inverted convention, deliberately
# mirroring scan_file/scan_symlink_target in check-no-home-paths.sh).
scan_record() {
  local type="$1" number="$2" url="$3" body="$4"
  local i class ere bashere applyallow match token found=1
  [ -z "$body" ] && return 1
  for i in "${!CLASS_NAMES[@]}"; do
    class="${CLASS_NAMES[$i]}"
    ere="${CLASS_GREP_ERE[$i]}"
    bashere="${CLASS_BASH_ERE[$i]}"
    applyallow="${CLASS_APPLY_ALLOWLIST[$i]}"
    while IFS= read -r match; do
      [ -z "$match" ] && continue
      if [ "$applyallow" = 1 ] && [[ "$match" =~ $bashere ]]; then
        token="${BASH_REMATCH[1]}"
        is_allowed_token "$token" && continue
      fi
      printf '%s:%s:%s:%s:%s\n' "$type" "$number" "$url" "$class" "$match"
      found=0
    done < <(grep -o -E "$ere" <<<"$body" 2>/dev/null)
  done
  return "$found"
}

# process_records -> reads JSONL from stdin, one compact JSON object per line
# shaped {type, number, url, body}. Extracts each field with its OWN `jq -r`
# call (never `@tsv`, which would double every backslash in a Windows path
# and structurally blind this script to the windows-home class — see
# selftest case "windows-home leak survives extraction intact"). Prints
# violation rows to stdout as scan_record finds them. Returns 0 (clean), 1
# (violations found), or 2 (a line failed to parse as JSON, or lacked a
# `.type` — inconclusive, NEVER folded into "clean" per the fail-open
# contract above).
process_records() {
  local line type number url body any_violation=1 any_malformed=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if ! type="$(jq -e -r '.type' <<<"$line" 2>/dev/null)"; then
      echo "scan-issue-home-paths: a record could not be parsed as JSON (or lacked .type) - skipping its scan and marking this run inconclusive. First 200 chars: ${line:0:200}" >&2
      any_malformed=1
      continue
    fi
    number="$(jq -r '.number' <<<"$line" 2>/dev/null)"
    url="$(jq -r '.url' <<<"$line" 2>/dev/null)"
    body="$(jq -r '.body' <<<"$line" 2>/dev/null)"
    if scan_record "$type" "$number" "$url" "$body"; then
      any_violation=0
    fi
  done
  if [ "$any_malformed" -eq 1 ]; then
    return 2
  fi
  [ "$any_violation" -eq 0 ] && return 1
  return 0
}

# fetch_and_scan REPO -> fetches issues+PRs, issue/PR comments, and PR review
# comments for REPO via `gh api`, feeds them through process_records, and
# returns its verdict. FAILS CLOSED (returns 2, never a silent 0) on: a
# temp-file failure, ANY of the three `gh api | jq` pipelines failing (needs
# `set -o pipefail`, set at file scope above, so a `gh api` failure is not
# swallowed by a downstream `jq` succeeding on empty input), or a
# suspiciously empty fetch (zero total records - a real repo with any
# history at all should never legitimately have none of the three; treated
# the same way check-no-home-paths.sh treats zero tracked files: cannot
# distinguish "genuinely nothing" from "the fetch silently returned nothing",
# so fail closed rather than report a pass that never actually scanned
# anything).
fetch_and_scan() {
  local repo="$1" tmp rc ok=1 total

  tmp="$(mktemp)" || {
    echo "scan-issue-home-paths: could not create a temp file - failing closed."
    return 2
  }

  if ! gh api --paginate -H "Accept: application/vnd.github+json" \
        "repos/$repo/issues?state=all&per_page=100" \
        | jq -c '.[] | {type: (if .pull_request then "pr" else "issue" end), number, url: .html_url, body: (.body // "")}' \
        >>"$tmp"; then
    echo "scan-issue-home-paths: failed to fetch issues/PRs for $repo."
    ok=0
  fi

  if ! gh api --paginate -H "Accept: application/vnd.github+json" \
        "repos/$repo/issues/comments?per_page=100" \
        | jq -c '.[] | {type: "issue-comment", number: (.issue_url | split("/") | last), url: .html_url, body: (.body // "")}' \
        >>"$tmp"; then
    echo "scan-issue-home-paths: failed to fetch issue/PR conversation comments for $repo."
    ok=0
  fi

  if ! gh api --paginate -H "Accept: application/vnd.github+json" \
        "repos/$repo/pulls/comments?per_page=100" \
        | jq -c '.[] | {type: "review-comment", number: (.pull_request_url | split("/") | last), url: .html_url, body: (.body // "")}' \
        >>"$tmp"; then
    echo "scan-issue-home-paths: failed to fetch PR review (inline diff) comments for $repo."
    ok=0
  fi

  if [ "$ok" -eq 0 ]; then
    echo "scan-issue-home-paths: one or more GitHub API fetches failed for $repo - cannot verify its issue/PR/comment bodies, failing closed (never a silent clean)."
    rm -f "$tmp"
    return 2
  fi

  total="$(wc -l < "$tmp" | tr -d ' ')"
  if [ "${total:-0}" -eq 0 ] 2>/dev/null; then
    echo "scan-issue-home-paths: fetched zero issue/PR/comment records for $repo - cannot distinguish a genuinely empty repo from a broken fetch, failing closed rather than reporting a silent pass."
    rm -f "$tmp"
    return 2
  fi

  process_records < "$tmp"
  rc=$?
  rm -f "$tmp"
  return "$rc"
}

# ---------------------------------------------------------------------------
# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  fail=0
  total_cases=0
  EXPECTED_CASES=11

  case "$0" in
    */*) SELF="$0" ;;
    *) SELF="./$0" ;;
  esac
  SELF_ABS="$(cd "$(dirname "$SELF")" && pwd)/$(basename "$SELF")"

  LAST_OUT=""
  # check LABEL WANT_RC JSONL -> feeds JSONL to process_records (the
  # network-independent core; mirrors check-no-home-paths.sh's own selftest
  # philosophy of testing the scanning logic offline without hitting a real
  # API), asserts its exit code, leaves output in $LAST_OUT.
  check() {
    total_cases=$((total_cases + 1))
    local label="$1" want_rc="$2" jsonl="$3" rc
    LAST_OUT="$(printf '%s\n' "$jsonl" | process_records 2>&1)"
    rc=$?
    if [ "$rc" -ne "$want_rc" ]; then
      echo "SELFTEST FAIL: $label -> rc=$rc (want $want_rc)"
      printf '%s\n' "$LAST_OUT" | sed 's/^/    /'
      fail=1
    fi
  }

  # --- 1: clean body -> pass ---
  check "1  clean issue body" 0 \
    '{"type":"issue","number":1,"url":"https://x/issues/1","body":"nothing sensitive here"}'

  # --- 2: genuine leak, positive control -> must fire ---
  check "2  linux-home leak in an issue body" 1 \
    '{"type":"issue","number":2,"url":"https://x/issues/2","body":"run: cd /home/alice/sail_command && npm test"}'
  case "$LAST_OUT" in
    *"issue:2:https://x/issues/2:linux-home:/home/alice"*) ;;
    *) echo "SELFTEST FAIL: 2 did not report type:number:url:class:match -> $LAST_OUT"; fail=1 ;;
  esac

  # --- 3: allowlisted placeholder -> pass (not a real leak) ---
  check "3  allowlisted /home/user placeholder in a PR body" 0 \
    '{"type":"pr","number":3,"url":"https://x/pull/3","body":"example path: /home/user/project"}'

  # --- 4: windows-home leak, in a REVIEW COMMENT -> must fire, AND the
  # backslashes must survive per-field `jq -r` extraction byte-for-byte
  # (the regression this design point avoids: `@tsv` would double every
  # backslash and silently blind this class).
  check "4  windows-home leak survives extraction intact (review comment)" 1 \
    '{"type":"review-comment","number":4,"url":"https://x/pull/4#discussion_r1","body":"run: cd C:\\Users\\alice\\sail_command"}'
  case "$LAST_OUT" in
    *'windows-home:C:\Users\alice'*) ;;
    *) echo "SELFTEST FAIL: 4 windows-home match missing or backslash-corrupted -> $LAST_OUT"; fail=1 ;;
  esac

  # --- 5: malformed JSON line -> inconclusive, not clean ---
  check "5  malformed JSON line is inconclusive, not clean" 2 \
    'not valid json'

  # --- 6: empty body -> pass, no crash ---
  check "6  empty body string does not crash and is clean" 0 \
    '{"type":"issue-comment","number":6,"url":"https://x/issues/6#issuecomment-1","body":""}'

  # --- 7: two violations across two records, both reported (no
  # short-circuit after the first class/record matches) ---
  check "7  two records, two violations, both reported" 1 \
    '{"type":"issue","number":7,"url":"https://x/issues/7","body":"cd /home/alice/repo"}
{"type":"pr","number":8,"url":"https://x/pull/8","body":"cd /Users/bob/repo"}'
  case "$LAST_OUT" in
    *"issue:7:"*linux-home*"pr:8:"*macos-home* | *"pr:8:"*macos-home*"issue:7:"*linux-home*) ;;
    *) echo "SELFTEST FAIL: 7 did not report both violations -> $LAST_OUT"; fail=1 ;;
  esac

  # --- 8: type/number/url threading - a comment's number is extracted from
  # its parent issue/PR (as production's jq filters do), not left blank ---
  check "8  type/number/url thread through correctly" 1 \
    '{"type":"issue-comment","number":42,"url":"https://x/issues/42#issuecomment-9","body":"see /home/carol/notes"}'
  case "$LAST_OUT" in
    *"issue-comment:42:https://x/issues/42#issuecomment-9:linux-home:/home/carol"*) ;;
    *) echo "SELFTEST FAIL: 8 did not thread type/number/url -> $LAST_OUT"; fail=1 ;;
  esac

  # --- 9: fail-closed - `gh` missing ---
  toolbox=$(mktemp -d)
  for b in bash jq sed cat mktemp dirname basename wc tr grep; do
    p=$(command -v "$b" 2>/dev/null) && ln -s "$p" "$toolbox/$b" 2>/dev/null
  done
  total_cases=$((total_cases + 1))
  out=$(PATH="$toolbox" GITHUB_REPOSITORY=owner/repo bash "$SELF_ABS" 2>&1); rc=$?
  if [ "$rc" -ne 2 ]; then
    echo "SELFTEST FAIL: 9 fail-closed: gh missing -> rc=$rc (want 2)"
    printf '%s\n' "$out" | sed 's/^/    /'
    fail=1
  fi

  # --- 10: fail-closed - `jq` missing ---
  toolbox2=$(mktemp -d)
  for b in bash gh sed cat mktemp dirname basename wc tr grep; do
    p=$(command -v "$b" 2>/dev/null) && ln -s "$p" "$toolbox2/$b" 2>/dev/null
  done
  total_cases=$((total_cases + 1))
  out=$(PATH="$toolbox2" GITHUB_REPOSITORY=owner/repo bash "$SELF_ABS" 2>&1); rc=$?
  if [ "$rc" -ne 2 ]; then
    echo "SELFTEST FAIL: 10 fail-closed: jq missing -> rc=$rc (want 2)"
    printf '%s\n' "$out" | sed 's/^/    /'
    fail=1
  fi
  rm -rf "$toolbox" "$toolbox2"

  # --- 11: fail-closed - no repo determinable (no --repo, no
  # $GITHUB_REPOSITORY) ---
  total_cases=$((total_cases + 1))
  out=$(env -u GITHUB_REPOSITORY bash "$SELF_ABS" 2>&1); rc=$?
  if [ "$rc" -ne 2 ]; then
    echo "SELFTEST FAIL: 11 fail-closed: no repo determinable -> rc=$rc (want 2)"
    printf '%s\n' "$out" | sed 's/^/    /'
    fail=1
  fi

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
REPO="${GITHUB_REPOSITORY:-}"
if [ "${1:-}" = "--repo" ]; then
  REPO="${2:-}"
fi
if [ -z "$REPO" ]; then
  echo "scan-issue-home-paths: no repository specified (pass --repo owner/repo, or set \$GITHUB_REPOSITORY) - failing closed."
  exit 2
fi

command -v gh >/dev/null 2>&1 || {
  echo "scan-issue-home-paths: gh CLI not found on PATH - failing closed."
  exit 2
}
command -v jq >/dev/null 2>&1 || {
  echo "scan-issue-home-paths: jq not found on PATH - failing closed."
  exit 2
}

fetch_and_scan "$REPO"
rc=$?
case "$rc" in
  0)
    echo "scan-issue-home-paths: clean - no home paths found in issue/PR/comment bodies for $REPO."
    exit 0
    ;;
  1)
    echo "::error::scan-issue-home-paths found problems (see rows above, TYPE:NUMBER:URL:CLASS:MATCH) - a contributor's absolute local path may have leaked into an issue, PR, or comment body on $REPO. Redact it by hand via the GitHub UI/API with a repo-relative placeholder such as <repo> or <scratchpad> (see CLAUDE.md's home-path convention)."
    exit 1
    ;;
  *)
    echo "::error::scan-issue-home-paths could not complete its scan of $REPO (see messages above) - treat this run as UNVERIFIED, never as clean."
    exit 2
    ;;
esac
