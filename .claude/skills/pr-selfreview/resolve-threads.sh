#!/usr/bin/env bash
# resolve-threads.sh — batch reply + resolve every OPEN review thread on a PR.
#
# Folds pr-selfreview SKILL.md's step-4 loop (enumerate -> reply -> resolve,
# one thread at a time) into a single invocation. Step 3 below — the final
# re-enumerate — is the point of the script: a resolver that reports success
# without checking is worse than the manual loop it replaces, so this always
# re-queries GitHub after the pass and exits non-zero, loudly, if any thread
# is still open.
#
# Usage:
#   resolve-threads.sh <PR_NUMBER> -m "shared reply text posted to every thread"
#   resolve-threads.sh <PR_NUMBER> -f mapping.json
#
# mapping.json (for -f) is a JSON array of objects:
#   [{ "path": "app/src/foo.ts", "line": 42, "body": "Fixed in `abc1234`." },
#    { "body": "Default reply for anything not matched above." }]
# Each open thread is matched against its own (path, line) — the same
# coordinates used to anchor the original inline comment (SKILL.md step 2).
# An entry with NEITHER "path" NOR "line" is the catch-all default, tried
# only when no path/line entry matches. A thread matching nothing is a hard
# failure (see below) — the script never silently skips a thread.
#
# All reply bodies pass through `jq -n --arg` to build the GraphQL JSON
# payload, so backtick/code-fence bodies need no special handling and no
# `--input` file authored by hand — jq's -n/--arg does the escaping that a
# double-quoted shell string would mangle.
#
# Repo is fixed to DocGerd/sail_command, matching the rest of this skill.

set -euo pipefail

OWNER="DocGerd"
REPO="sail_command"

usage() {
  cat >&2 <<'EOF'
Usage:
  resolve-threads.sh <PR_NUMBER> -m "shared reply text"
  resolve-threads.sh <PR_NUMBER> -f mapping.json
EOF
  exit 2
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "resolve-threads.sh: '$1' is required but not on PATH" >&2; exit 2; }
}
require_cmd gh
require_cmd jq

[ "$#" -ge 1 ] || usage
PR="$1"
shift

MODE=""
MESSAGE=""
MAPPING_FILE=""
case "${1:-}" in
  -m)
    MODE="shared"
    MESSAGE="${2:?resolve-threads.sh: -m requires a message argument}"
    ;;
  -f)
    MODE="file"
    MAPPING_FILE="${2:?resolve-threads.sh: -f requires a mapping-file argument}"
    [ -f "$MAPPING_FILE" ] || { echo "resolve-threads.sh: mapping file not found: $MAPPING_FILE" >&2; exit 2; }
    jq empty "$MAPPING_FILE" || { echo "resolve-threads.sh: mapping file is not valid JSON: $MAPPING_FILE" >&2; exit 2; }
    ;;
  *)
    usage
    ;;
esac

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# shellcheck disable=SC2016 # GraphQL $variable syntax, not shell expansion
ENUMERATE_QUERY='
query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      reviewThreads(first:100){
        nodes{ id isResolved path line comments(first:1){ nodes{ body } } }
      }
    }
  }
}'

enumerate() {
  gh api graphql -f query="$ENUMERATE_QUERY" -F owner="$OWNER" -F repo="$REPO" -F pr="$PR" \
    --jq '.data.repository.pullRequest.reviewThreads.nodes'
}

# Look up the reply body for one thread (a single-line JSON object on stdin
# via $1). Prints the body to stdout and returns 0 on a match; returns 1 with
# nothing printed when no match exists (shared mode always matches).
reply_body_for_thread() {
  local thread="$1"
  if [ "$MODE" = "shared" ]; then
    printf '%s' "$MESSAGE"
    return 0
  fi
  local path line match
  path="$(printf '%s' "$thread" | jq -r '.path')"
  line="$(printf '%s' "$thread" | jq -r '.line')"
  match="$(jq -c --arg path "$path" --argjson line "$line" '
      [.[] | select(has("path") and has("line")) | select(.path == $path and .line == $line)]
      | first // empty
    ' "$MAPPING_FILE")"
  if [ -n "$match" ]; then
    printf '%s' "$match" | jq -r '.body'
    return 0
  fi
  match="$(jq -c '[.[] | select((has("path") | not) and (has("line") | not))] | first // empty' "$MAPPING_FILE")"
  if [ -n "$match" ]; then
    printf '%s' "$match" | jq -r '.body'
    return 0
  fi
  return 1
}

echo "==> Enumerating review threads on PR #$PR" >&2
THREADS_JSON="$(enumerate)"
OPEN_THREADS="$(printf '%s' "$THREADS_JSON" | jq -c '[.[] | select(.isResolved == false)]')"
OPEN_COUNT="$(printf '%s' "$OPEN_THREADS" | jq 'length')"
echo "==> $OPEN_COUNT open thread(s) found" >&2

if [ "$OPEN_COUNT" -eq 0 ]; then
  echo "==> Nothing to resolve." >&2
  exit 0
fi

PASS_ERRORS=0
for i in $(seq 0 $((OPEN_COUNT - 1))); do
  thread="$(printf '%s' "$OPEN_THREADS" | jq -c ".[$i]")"
  id="$(printf '%s' "$thread" | jq -r '.id')"
  path="$(printf '%s' "$thread" | jq -r '.path // "n/a"')"
  line="$(printf '%s' "$thread" | jq -r '.line // "n/a"')"

  body="$(reply_body_for_thread "$thread")" && matched=1 || matched=0
  if [ "$matched" -ne 1 ]; then
    echo "!! No reply text for thread $id ($path:$line) — no mapping entry and no default; skipping" >&2
    PASS_ERRORS=$((PASS_ERRORS + 1))
    continue
  fi

  echo "==> [$id] $path:$line — replying" >&2
  reply_payload="$TMPDIR/reply-$i.json"
  jq -n --arg id "$id" --arg body "$body" '{
      query: "mutation($id:ID!,$b:String!){ addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$b}){ comment{ id } } }",
      variables: { id: $id, b: $body }
    }' > "$reply_payload"

  if ! gh api graphql --input "$reply_payload" >/dev/null 2>"$TMPDIR/reply-$i.err"; then
    echo "!! [$id] reply failed:" >&2
    cat "$TMPDIR/reply-$i.err" >&2
    PASS_ERRORS=$((PASS_ERRORS + 1))
    continue
  fi

  echo "==> [$id] $path:$line — resolving" >&2
  # shellcheck disable=SC2016 # GraphQL $variable syntax, not shell expansion
  if ! gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' \
      -F id="$id" >/dev/null 2>"$TMPDIR/resolve-$i.err"; then
    echo "!! [$id] resolve failed:" >&2
    cat "$TMPDIR/resolve-$i.err" >&2
    PASS_ERRORS=$((PASS_ERRORS + 1))
  fi
done

echo "==> Re-enumerating to verify" >&2
FINAL_THREADS_JSON="$(enumerate)"
STILL_OPEN="$(printf '%s' "$FINAL_THREADS_JSON" | jq -c '[.[] | select(.isResolved == false)]')"
STILL_OPEN_COUNT="$(printf '%s' "$STILL_OPEN" | jq 'length')"

if [ "$STILL_OPEN_COUNT" -gt 0 ] || [ "$PASS_ERRORS" -gt 0 ]; then
  echo "!! FAILED: $STILL_OPEN_COUNT/$OPEN_COUNT thread(s) still open after the pass ($PASS_ERRORS reply/resolve error(s) during it):" >&2
  printf '%s' "$STILL_OPEN" | jq -r '.[] | "  - \(.id) \(.path // "n/a"):\(.line // "n/a")"' >&2
  exit 1
fi

echo "==> All $OPEN_COUNT thread(s) resolved and verified." >&2
exit 0
