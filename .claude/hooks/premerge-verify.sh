#!/usr/bin/env bash
# Pre-merge verification guard for `gh pr merge` — SailCommand #177.
#
# Mechanises the memorised #119 near-miss LAW: before a `gh pr merge`, confirm
#   1. the PR object is UP TO DATE — its recorded head.sha equals the live
#      branch-ref tip. A mismatch means GitHub dropped a `synchronize` webhook,
#      so the PR's green checks describe a STALE commit and merging would
#      silently drop the fix that was pushed after them (#119); AND
#   2. check-runs actually EXIST for that exact head SHA (checks have run for
#      this commit, not a predecessor).
#
# Emits Claude Code PreToolUse JSON on stdout:
#   deny  -> positively detected a stale head or zero check-runs (hard block)
#   ask   -> could not verify (unparseable command, API/auth failure, fork or
#            deleted branch); surface to the human, never hard-block a merge
#            on tooling fragility
#   (silent exit 0) -> the command is not `gh pr merge`, or all checks passed
#
# Offline self-test of the pure decision logic:
#   .claude/hooks/premerge-verify.sh --selftest
set -uo pipefail

emit_deny() { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"; exit 0; }
emit_ask()  { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$1"; exit 0; }

# Pure decision logic — no network, unit-testable via --selftest.
# args: pr_sha  tip_sha  check_count
# echoes exactly one of: "allow" | "deny:<reason>" | "ask:<reason>"
decide() {
  local pr_sha="$1" tip_sha="$2" count="$3"
  if [ -z "$pr_sha" ]; then
    echo "ask:could not read the PR head.sha from the GitHub API - verify head.sha==pushed SHA and check-runs by hand (#119)."
    return
  fi
  if [ -z "$tip_sha" ]; then
    echo "ask:could not resolve the PR branch tip (fork or deleted branch?) - verify head.sha==pushed SHA by hand (#119)."
    return
  fi
  if [ "$pr_sha" != "$tip_sha" ]; then
    echo "deny:PR head.sha ($pr_sha) != live branch tip ($tip_sha) - GitHub dropped a synchronize webhook, so the green checks describe a STALE commit (#119). Resync the head (REST close->reopen or update-branch), cancel the stale-SHA run, rerun checks for the fresh SHA, THEN merge."
    return
  fi
  if ! [ "$count" -gt 0 ] 2>/dev/null; then
    echo "deny:no check-runs exist for the PR head.sha ($pr_sha) - checks have not run for THIS exact commit (#119). Wait for app+e2e to register and go green for this SHA before merging."
    return
  fi
  echo "allow"
}

# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  fail=0
  expect() { # desc  want-prefix  got
    case "$3" in "$2"*) : ;; *) echo "SELFTEST FAIL: $1 -> got [$3] want [$2*]"; fail=1 ;; esac
  }
  expect "fresh head + checks -> allow" "allow"  "$(decide abc123 abc123 3)"
  expect "stale head -> deny"           "deny:"  "$(decide abc123 def456 3)"
  expect "zero check-runs -> deny"      "deny:"  "$(decide abc123 abc123 0)"
  expect "non-numeric count -> deny"    "deny:"  "$(decide abc123 abc123 x)"
  expect "missing pr sha -> ask"        "ask:"   "$(decide '' abc123 3)"
  expect "missing tip sha -> ask"       "ask:"   "$(decide abc123 '' 3)"
  if [ "$fail" -eq 0 ]; then echo "SELFTEST OK"; else echo "SELFTEST FAILURES"; fi
  exit "$fail"
fi

# ---- production path: read the tool input from stdin ----
IN=$(cat)
CMD=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null) \
  || CMD=$(printf '%s' "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null) \
  || CMD=""

# Fire ONLY when the command is an actual `gh pr merge` INVOCATION - i.e. it
# begins (after leading whitespace / env-var / sudo / time prefixes) with
# `gh pr merge`. It must NOT fire when the string merely appears as DATA inside
# another command (a `git commit -F` message, `printf`/`echo`, a `grep` pattern):
# those begin with git/printf/grep, not gh, and firing on them spams false
# approval prompts (#193 self-review).
case "$CMD" in
  *gh\ pr\ merge*) : ;;                 # cheap substring pre-filter
  *) exit 0 ;;
esac
FIRST=$(printf '%s' "$CMD" \
  | sed -E 's/^[[:space:]]+//' \
  | sed -E 's/^(sudo[[:space:]]+|command[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*//')
printf '%s' "$FIRST" | grep -qE '^gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)' || exit 0

# Within a real merge command, refuse to auto-approve a CHAIN of merges
# (`gh pr merge 100 && gh pr merge 200`) - merges must be serial so each PR is
# verified individually. Count only segments that themselves START with the
# invocation, so a trailing `&& git commit -m '... gh pr merge ...'` (data, not a
# merge) is correctly ignored.
REAL=$(printf '%s' "$FIRST" | tr ';&|' '\n\n\n' | grep -cE '^[[:space:]]*gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)')
[ "${REAL:-0}" -gt 1 ] 2>/dev/null && emit_ask "command chains ${REAL} 'gh pr merge' invocations - merge strictly serially so each PR's head.sha and check-runs are verified individually (#119)."

command -v gh >/dev/null 2>&1 || emit_ask "gh CLI unavailable - cannot verify head.sha/check-runs before merge (#119); confirm by hand."

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || REPO=""
[ -n "$REPO" ] || emit_ask "could not resolve owner/repo - cannot verify the merge target (#119); confirm by hand."
OWNER=${REPO%%/*}

# PR number = first bare integer in the invocation itself (the segment up to the
# first shell separator); else resolve from the current branch's open PR.
PR=$(printf '%s' "$FIRST" | sed -E 's/[;&|].*$//' | sed -E 's/^gh[[:space:]]+pr[[:space:]]+merge//' | grep -oE '[0-9]+' | head -1)
if [ -z "$PR" ]; then
  BR=$(git -C "${CLAUDE_PROJECT_DIR:-.}" branch --show-current 2>/dev/null)
  [ -n "$BR" ] || emit_ask "no PR number in the command and no current branch to resolve one - verify head.sha==pushed SHA and check-runs by hand (#119)."
  PR=$(gh api "repos/$REPO/pulls?head=$OWNER:$BR&state=open" --jq '.[0].number // empty' 2>/dev/null)
  [ -n "$PR" ] || emit_ask "could not resolve an open PR for branch '$BR' - verify head.sha==pushed SHA and check-runs by hand (#119)."
fi

# PR head SHA + branch ref + head repo (fork-aware), one API call, TSV.
INFO=$(gh api "repos/$REPO/pulls/$PR" --jq '[.head.sha, .head.ref, (.head.repo.full_name // "")] | @tsv' 2>/dev/null) || INFO=""
PR_SHA=$(printf '%s' "$INFO" | cut -f1)
HEAD_REF=$(printf '%s' "$INFO" | cut -f2)
HEAD_REPO=$(printf '%s' "$INFO" | cut -f3)
[ -n "$PR_SHA" ] || emit_ask "could not read PR #$PR head.sha from GitHub - verify head.sha==pushed SHA and check-runs by hand (#119)."

# Live branch tip = the actual last-pushed SHA (looked up in the head repo, so
# same-repo and fork PRs both resolve).
TIP_REPO=${HEAD_REPO:-$REPO}
TIP_SHA=$(gh api "repos/$TIP_REPO/git/ref/heads/$HEAD_REF" --jq '.object.sha' 2>/dev/null) || TIP_SHA=""

# Check-runs registered for the PR head SHA. A failed API call is "cannot
# verify" (ask), NOT "zero check-runs" (deny) - only a successful 0 denies.
if ! COUNT=$(gh api "repos/$REPO/commits/$PR_SHA/check-runs" --jq '.total_count' 2>/dev/null); then
  emit_ask "PR #$PR: could not read check-runs for head.sha $PR_SHA (API/auth failure) - verify check-runs exist for this exact SHA by hand (#119)."
fi
[ -n "$COUNT" ] || COUNT=0

DECISION=$(decide "$PR_SHA" "$TIP_SHA" "$COUNT")
case "$DECISION" in
  allow)  exit 0 ;;
  deny:*) emit_deny "PR #$PR: ${DECISION#deny:}" ;;
  ask:*)  emit_ask  "PR #$PR: ${DECISION#ask:}" ;;
  *)      emit_ask  "PR #$PR: pre-merge guard produced no decision - verify by hand (#119)." ;;
esac
