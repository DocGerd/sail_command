---
name: pr-selfreview
description: Use whenever you have created or updated a pull request you authored and need to self-review it before merge — run a review, post ONE inline review thread per finding, solve all findings, then resolve every thread (reply + GraphQL resolveReviewThread). Reach for this any time you open a PR of your own, even when not explicitly asked to review it. Triggers on /pr-selfreview.
---

# Self-review a PR you authored

Every PR you create gets self-reviewed before it merges. Run a review, post
**one inline review thread per finding**, solve all findings (commit + push),
then **resolve every thread** (reply + GraphQL). The fiddly part is the `gh`
mechanics — the tables below give exact spellings. Repo: `DocGerd/sail_command`
(swap `N` for the PR number, `SHA` for the head commit, `THREAD_ID` for a
`reviewThreads` node id).

## The loop

| Step | Do | Key gotcha |
|---|---|---|
| 1 REVIEW | Establish BASE + diff, run `pr-review-toolkit:review-pr` on it | Feature PRs base on `develop`, not `main` |
| 2 POST | One inline thread per finding, anchored to an in-diff line | 422 outside diff hunks → PR-level comment; backticks → JSON `--input` |
| 3 SOLVE | Fix every finding, commit, push | Never `--no-verify` / `--force` / `-f` / `--force-with-lease` |
| 4 RESOLVE | Reply to and resolve every thread | Use the `pullRequest.reviewThreads` GraphQL path |

## 1. REVIEW — gather findings

Feature PRs target `develop`; releases/hotfixes target `main`. Get the diff
against the PR's own base:

- Diff: `gh pr diff N` (or `git fetch origin` then `git diff origin/develop...HEAD`).
- Head SHA (for inline anchors): `gh api repos/DocGerd/sail_command/pulls/N --jq .head.sha`.

Run `pr-review-toolkit:review-pr` on the diff (or dispatch the code-reviewer
agents). Do **not** read the linked issue with `gh issue view` — it hits the
Projects-classic bug (see gotchas); use `gh api repos/DocGerd/sail_command/issues/N`.

## 2. POST — one inline thread per finding

Anchor each finding to a line that appears in the diff. **Inline review
comments 422 outside diff hunks** — if a finding is not on a changed line, post
it as a PR-level comment instead. **Bodies containing backticks MUST be sent as
a JSON file via `--input`** — double-quoted shell interpolation mangles
backticks.

`comment.json` (inline, on a changed line):

```json
{
  "body": "Narrow on `kind` instead of casting the `Leg`.",
  "commit_id": "SHA",
  "path": "app/src/routing/solver.ts",
  "line": 42,
  "side": "RIGHT"
}
```

```
gh api repos/DocGerd/sail_command/pulls/N/comments --method POST --input comment.json
```

Out-of-diff finding → PR-level comment (`body` only, no `path`/`line`):

```
gh api repos/DocGerd/sail_command/issues/N/comments --method POST --input comment.json
```

If a finding touches `docs/superpowers/specs/`, do **not** fix it here — spec
edits go through the main session only (the ask-gate hook must prompt the user).

## 3. SOLVE — fix, commit, push

Fix every finding, commit, and push to the PR branch. Never `--no-verify`,
`--force`, `-f`, or `--force-with-lease`; if a hook fails, fix the root cause.
Record each fix commit so you can cite the SHA when you reply in step 4.

Destructive-git guard: **never combine `gh api -f …` with `git push` in one
Bash call** — the guard pattern-matches `-f` anywhere in a compound command.
Split them into separate Bash invocations.

## 4. RESOLVE — reply to and resolve every thread

The `pullRequest.reviewThreads` GraphQL path is unaffected by the
Projects-classic bug. Enumerate threads, reply to each, then resolve each.

Enumerate open threads (read-only, no backticks — inline `-f query` is fine):

```
gh api graphql -f query='
query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      reviewThreads(first:100){
        nodes{ id isResolved comments(first:1){ nodes{ body path } } }
      }
    }
  }
}' -F owner=DocGerd -F repo=sail_command -F pr=N
```

Reply (bodies carry backticks → send the whole GraphQL request as a JSON
`--input` file). `reply.json`:

```json
{
  "query": "mutation($id:ID!,$b:String!){ addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$b}){ comment{ id } } }",
  "variables": { "id": "THREAD_ID", "b": "Fixed in `abc1234`." }
}
```

```
gh api graphql --input reply.json
```

Resolve the thread (no backticks — inline is fine):

```
gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' -F id=THREAD_ID
```

Done when re-running the enumerate query shows every `isResolved: true`.

## gh gotchas

| Broken here | Use instead |
|---|---|
| `gh issue view N`, `gh pr view --json closingIssuesReferences` (Projects-classic deprecation) | `gh api repos/DocGerd/sail_command/issues/N` / `.../pulls/N --jq …` |
| `gh pr edit` for PR-body edits (same bug) | `gh api repos/DocGerd/sail_command/pulls/N --method PATCH --input body.json` |
| `gh pr checks --json` (unsupported here) | poll `gh api repos/DocGerd/sail_command/commits/SHA/check-runs` |
| double-quoted shell body (mangles backticks) | JSON `--input` file |
| inline comment on an out-of-diff line (422) | anchor to an in-diff line, or PR-level `issues/N/comments` |
| `gh api -f …` and `git push` in one Bash call (`-f` guard) | split into two Bash calls |

The `pullRequest.reviewThreads` / `resolveReviewThread` GraphQL path is the one
`gh`-adjacent surface the Projects-classic bug does **not** touch — use it for
all thread enumeration and resolution.
