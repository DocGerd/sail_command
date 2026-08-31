#!/usr/bin/env bash
# PreToolUse Bash NUDGE: warn when a `git commit` or `gh pr create` invocation
# carries text matching a GitHub closing keyword pattern in its own command
# text (the commit message / the PR title+body, both of which appear inline
# in the Bash command string itself for the common `-m "..."`/`--body "..."`
# forms). SailCommand #727.
#
# WHY THIS EXISTS (CLAUDE.md's own "Closing keywords" bullet under Release &
# branching): GitHub's closing keywords have NO NEGATION AWARENESS, and fire
# from TWO locations - the PR body and EVERY commit message in the merged
# range. Measured incidents in THIS repo: #257 ("this PR does NOT close #211"
# closed #211 anyway - the disclaimer written to PREVENT the close was the
# trigger); #279 (a stale `Clos` + `es #265` survived as the PR body's last
# line after a mid-flight descope); #335 (body and title both regex-checked
# clean, but an EARLIER COMMIT ended `Closes #319` and closed it); #452
# (closed ACCIDENTALLY by a bare `fix #452` in a docs commit SUBJECT, and
# that stale issue title later handed a FALSE PREMISE to a safety
# investigation, #649). The existing defence was a HAND-RUN grep CLAUDE.md
# documents but nothing enforces - this hook is that enforcement, moved to
# the point where the text is ABOUT to be written.
#
# DESIGN: this is a NUDGE, not a blocker - per CLAUDE.md's guard-asymmetry
# rule ("a BLOCKING guard should fail closed, a NUDGE should fail open"),
# EVERY path through this script either emits a non-blocking
# `additionalContext` advisory or emits NOTHING at all. It NEVER emits
# `permissionDecision` in any form - not "ask" (this is not artifact-guard.sh
# or wind-fixture-guard.sh's commit branch - there is nothing here worth
# interrupting a workflow over) and DEFINITELY not "allow" (CLAUDE.md's own
# #478 bullet: "allow" would BYPASS the user's OWN permission rules rather
# than merely drop the hook's prompt - an accident this file must never
# reproduce). Consequently this file's failure-handling is the MIRROR of
# wind-fixture-guard.sh's: where that guard escalates an unanswerable input
# to `ask` because part of it blocks, THIS guard just stays silent on
# anything it cannot parse or decide - silence costs nothing here, where a
# nudge's whole value proposition is "cheap to fire, cheap to skip".
#
# THE `.claude/settings.json` CALL SITE IS DELIBERATELY SILENT ON A MISSING/
# NON-EXECUTABLE HOOK FILE - NOT `ask`, and this is a considered choice, not
# an oversight (PR #797 review Minor 4 asked this be written down so a future
# reader does not "fix" it back to `ask`). Reasoning, adjudicated in review:
#   - `ask` is affirmatively WRONG here. This hook is wired on the BARE
#     `Bash` matcher (every Bash call, not a filtered subset), so an `ask`
#     else-branch would prompt on EVERY Bash call in any checkout lacking
#     this script (a worktree cut from a pre-#727 branch, a fresh clone).
#     CLAUDE.md's own `premerge-verify.sh` bullet records exactly this
#     failure mode already happening to a DIFFERENT guard in this repo: "a
#     guard that always asks trains you to click through" - which erodes the
#     click-through habit for the two REAL blocking guards sharing that same
#     array (artifact-guard.sh, wind-fixture-guard.sh), not just this one.
#   - A THIRD option - a visible-but-non-blocking "hook missing" advisory
#     instead of pure silence - is worse than both. The call site cannot
#     know whether the command is actually a `git commit`/`gh pr create`
#     without RUNNING this hook, so a missing-script advisory would fire on
#     EVERY Bash call, not just the ones this hook cares about. Gating it
#     on the command shape would mean duplicating `_triggers_commit`/
#     `_triggers_pr_create` into `settings.json` as inline shell - exactly
#     the logic-in-JSON duplication #274/#404 moved OUT of this repo's
#     guards (a second, hand-maintained copy that can drift from the real
#     one), for a nudge whose cost of silent absence is one missed reminder.
#   - The liveness rule this repo's #274 bullet prescribes IS satisfied, not
#     waived: the call site uses the CONJUNCTIVE `[ -f "$H" ] && [ -x "$H" ]`
#     form (never a bare `-x`, which is true for a directory and would let
#     `exec`/invocation die 126 emitting nothing) - closing the exact
#     directory-at-hook-path trap #274 exists to catch. The divergence from
#     artifact-guard.sh/wind-fixture-guard.sh is ONLY in the else-branch
#     (silent here vs. `ask` there), and that divergence tracks the
#     blocking/nudge split correctly, not sloppily - a NUDGE array entry can
#     use a narrower liveness contract than a BLOCKING one because the cost
#     of a false-negative (a live hook mistaken for absent) differs by class.
#   - Residual, ACCEPTED rather than closed: an operator cannot tell "this
#     hook is silent because nothing matched" from "this hook is silent
#     because the file is gone". That is a materially SMALLER hazard than
#     #424's canary residual (a SELFTEST claiming verification it did not
#     perform) - this hook makes no claim about any commit either way, and
#     CLAUDE.md's hand-run grep remains the documented backstop regardless
#     of whether this hook ever ran.
#
#   `ruff-on-pipeline-edit.sh` is ALSO silent on a missing hook file, but
#   NOT for this reasoning (PR #797 review round 2, Minor 6: an earlier
#   version of this paragraph claimed the two hooks share this reasoning,
#   which was wrong on two counts).
#
# MINOR 6 FACT (verified against Claude Code's own hooks documentation and
# this repo's committed .claude/settings.json, not restated from memory):
# `permissionDecision` does not apply to PostToolUse hooks at all -
# PostToolUse fires AFTER the tool has already run and cannot block, so
# `ask`/`allow`/`deny` have nothing left to gate. Separately,
# `artifact-guard.sh` has ZERO PostToolUse entries in .claude/settings.json
# (verified: `jq '.hooks.PostToolUse[] | .hooks[].command'` matches
# "artifact-guard" 0 times) - it sits only in `PreToolUse` `Edit|Write`
# and `PreToolUse` `Bash`, so ruff-on-pipeline-edit.sh's `PostToolUse`
# `Edit|Write` array never contained it. See ruff-on-pipeline-edit.sh's
# own header for its full call-site paragraph.
#
# TRIGGER SHAPE (matches wind-fixture-guard.sh's own `_triggers_commit`
# byte-for-byte, including the `git -C`/`git -c` compound forms - this guard
# reuses that proven trigger for `git commit` rather than re-deriving it) plus
# a new `gh pr create` trigger. Scoped deliberately narrow, per the brief: NOT
# `gh pr edit` (a real residual - a closing keyword landing in a body edited
# after creation is not caught here; `gh pr edit` was out of scope for this
# issue) and NOT a bare `git commit --amend` distinction (amend still writes a
# commit message and is caught the same way as a fresh commit; no special-
# casing needed since the trigger only looks for the word "commit").
#
# WHAT GETS SCANNED, deliberately naive: the guard's own CLAUDE.md remedy is
# "a two-part grep... over commit messages... and separately over the PR body
# itself" - a whole-string substring scan, not an argv-aware extraction of
# just the -m/--body VALUE. This file does the same: once a command is judged
# to be a `git commit`/`gh pr create` invocation, the CLOSING_KEYWORD_RE
# pattern is matched against the ENTIRE raw command string, not just the
# parsed-out message. That means it ALSO scans `--title` for `gh pr create`
# (a free bonus - CLAUDE.md's own bullet says "keep the PR TITLE clean too -
# it costs nothing", and this gets it for free), and it means a closing
# keyword appearing in, say, a `-m` value AND a `--body` value both surface
# through the SAME single scan. It is NOT a decision-relevant boundary here
# whether the match sits in the flag NAME, the VALUE, or between them -
# unlike artifact-guard.sh's PROTECTED_PATHS matching (where getting that
# boundary wrong lets a real write slip past), a false-positive nudge here
# costs one extra line of context and a false negative costs nothing new
# (the existing hand-run grep remains the backstop CLAUDE.md documents).
#
# PATTERN: CLAUDE.md's own validated spelling, copied VERBATIM, not
# re-derived (per this repo's "when a reviewer supplies EXACT replacement
# text, adopt it VERBATIM" rule - here the "reviewer" is CLAUDE.md's own
# Release & branching bullet, already measured against real false positives
# and false negatives in this repo's history):
#   (clos(e|es|ed)?|fix(e[sd])?|resolve[sd]?)[[:space:]:(]*#[0-9]+
# It deliberately admits the colon form (`Clos` + `es: #321`) and the paren
# form (`fix (#412`), deliberately DROPS the gerunds (`closing`/`fixing`/
# `resolving` are not GitHub keywords - "clos" alone with the optional group
# empty, immediately followed by "ing", fails the required
# `[[:space:]:(]*#[0-9]+` tail, so "closing #12" does not match), and
# deliberately still matches `postfix #12` - the safe over-fire direction for
# a nudge, unchanged from the pattern's own documented history. `grep -iE` for
# case-insensitivity (GitHub's own keywords are case-insensitive; CLAUDE.md's
# worked example uses `-iE` too - matched here, not re-derived).
#
# MEASURED RESIDUAL, stated rather than implied (CLAUDE.md's own note on the
# bracketed conventional-commit form): `fix(#54):` does NOT actually close on
# GitHub (PR #538 merged commit `fix(#54): ...` and #54 stayed open) - but
# this pattern KEEPS matching it deliberately, "one measurement of one form is
# not a licence to write conventional-commit scopes around issue refs." A row
# below pins that this guard still nudges on that shape even though GitHub
# itself would not have closed anything - an intentional, documented
# over-fire, not a bug.
#
# WHAT THIS DOES NOT CATCH, stated rather than implied (matching
# wind-fixture-guard.sh's own "NOT ATTEMPTED" convention). Explicitly
# NON-EXHAUSTIVE - this enumerates what has been CONSTRUCTED AND RUN through
# the production path (PR #797 review Minor 5), not a claim of completeness;
# `_triggers_commit`/`_triggers_pr_create` are simple substring matches, and
# any command shape that avoids their exact substrings evades this hook by
# construction, whether or not it is named below.
#   1. A message supplied via `git commit -F file.txt` or `gh pr create
#      --body-file file.md` lives in a FILE this hook never reads - only
#      inline `-m`/`--body` text on the command line itself is visible here.
#      A `git commit` with no `-m` at all (opens $EDITOR) is equally
#      invisible. Neither is a regression versus the status quo (the
#      hand-run grep CLAUDE.md documents has the identical blind spot, since
#      it also greps rendered TEXT, not files-yet-to-be-written) - both
#      residuals are inherited, not introduced.
#   2. EDITING an already-created PR's body is a DIFFERENT command entirely,
#      and this hook only triggers on `gh pr create`. CLAUDE.md's own
#      `gh pr edit` bullet (PR #797 review round 2, Minor 9: an earlier
#      version of this citation also named a "Multiple open PRs" bullet,
#      which carries no such path - verified against the committed
#      CLAUDE.md, removed) documents the repo's PRESCRIBED path for that
#      edit: `gh api repos/O/R/pulls/N --method PATCH --input body.json`
#      (the GraphQL bug in `gh pr edit` forces this route) - MEASURED
#      silent (constructed and run against this hook's
#      production path, PR #797 review response): the command string
#      contains neither "git commit" nor "gh pr create" as a substring, so
#      neither trigger fires and no nudge is emitted, even when the JSON
#      body being PATCHed in carries a bare `Closes #N`. A residual list
#      that omits the repo's own documented workflow is worse than no list
#      at all, which is why this is named explicitly rather than left to
#      the reader to rediscover. `gh pr edit` itself (blocked by the same
#      GraphQL bug, so rarely used, but not impossible) shares this gap.
#   3. More generally, ANY git invocation where a global option other than
#      the already-handled `-C`/`-c` compound forms sits between the words
#      "git" and "commit" evades `_triggers_commit`, because that trigger is
#      an EXACT substring match on "git commit" (one literal space). MEASURED
#      silent (constructed and run): `git --git-dir=X --work-tree=Y commit
#      -m "Closes #12"`, `git --work-tree=X commit -m "Closes #12"`, and
#      `git  commit -m "Closes #12"` (two spaces - the substring "git commit"
#      with exactly one space is absent). This is the SAME shape as #2, one
#      level down: a trigger built from a literal substring is inherently a
#      finite allowlist of invocation forms, not a parse of "is this a git
#      commit". Inherited from wind-fixture-guard.sh's `_triggers_commit`,
#      which this file reuses deliberately (see TRIGGER SHAPE above) rather
#      than re-deriving a parser - PR #233's shell-parser road was tried and
#      declined for exactly this class of guard, twice, in this repo's
#      history (see CLAUDE.md's guard-asymmetry bullet).
#
# Offline self-test of the pure decision logic PLUS a handful of end-to-end
# sanity checks through the real production path:
#   .claude/hooks/closing-keyword-guard.sh --selftest
set -uo pipefail

CLOSING_KEYWORD_RE='(clos(e|es|ed)?|fix(e[sd])?|resolve[sd]?)[[:space:]:(]*#[0-9]+'

# _json_string TEXT - prints a JSON-quoted, PROPERLY ESCAPED string literal
# (surrounding quotes included) for arbitrary TEXT. Review Minor 3 (PR #797):
# the OLD emit_nudge embedded $1 into a hand-written printf format string
# with no escaping at all, and $1 here is built by INTERPOLATING $MATCH -
# itself a substring the regex extracted verbatim from an attacker/user-
# controlled Bash command - directly into the message. A literal TAB
# anywhere in that match (`[[:space:]]` in CLOSING_KEYWORD_RE matches one)
# survives into the emitted JSON as a RAW, UNESCAPED control byte, which is
# not legal inside a JSON string per RFC 8259 (control chars U+0000-U+001F
# MUST be escaped) - `jq empty` rejects it outright. A hook emitting
# malformed JSON is a failure mode with NO good outcome: not a decision, not
# a diagnosable error, just noise the harness cannot parse.
# jq -> python3 fallback mirrors the fail-open discipline used throughout
# this file. MINOR 8 (PR #797 review round 2): the LAST-RESORT fallback
# (neither available) does NOT "strip every byte JSON cannot represent" -
# measured against its own code, it touches exactly five bytes: `\` and
# `"` are DELETED (silently changes the text's MEANING while staying
# VALID json - worse than it looks, since nothing signals it happened),
# `\n`/`\t`/`\r` each become a space (lossy, but stays valid). Every
# OTHER JSON-illegal control byte (SOH 0x01, VT 0x0b, ...) passes through
# untouched and still breaks the JSON. This is a MINOR, not a defect to
# harden, because the fallback is UNREACHABLE in production: both hooks
# require jq OR python3 just to PARSE the incoming tool_input, earlier in
# the script than this function is ever called, so "neither available"
# already exits 0 first - verified with a positive control (a PATH of real
# binaries excluding jq and python3 makes both hooks exit silently; a
# jq-only and a python3-only PATH each emit valid JSON for a TAB payload).
# Applies uniformly to
# ANY text this hook emits (the whole nudge message, not just $MATCH) -
# consistent with ruff-on-pipeline-edit.sh's sibling helper of the same name
# and contract (Minor 3's "make them consistent" instruction).
_json_string() {
  printf '%s' "$1" | jq -Rs . 2>/dev/null \
    || printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
    || printf '"%s"' "$(printf '%s' "$1" | tr -d '\\"' | tr '\n\t\r' '   ')"
}

emit_nudge() { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":%s}}\n' "$(_json_string "$1")"; }

# ---- pure decision logic (no I/O, unit-testable via --selftest) ----

# _triggers_commit: byte-for-byte the same shape as wind-fixture-guard.sh's
# own helper of the same name (including the `git -C`/`git -c` compound
# forms) - reused deliberately rather than re-derived, since that trigger is
# already proven against this repo's real command corpus.
_triggers_commit() {
  case "$1" in
    *git\ commit*|*git\ -C*commit*|*git\ -c*commit*) return 0 ;;
  esac
  return 1
}

_triggers_pr_create() {
  case "$1" in
    *gh\ pr\ create*) return 0 ;;
  esac
  return 1
}

# _closing_keyword_match CMD - prints the FIRST substring of CMD matching
# CLOSING_KEYWORD_RE (case-insensitive), or nothing if there is no match.
_closing_keyword_match() {
  printf '%s' "$1" | grep -ioE "$CLOSING_KEYWORD_RE" | head -1
}

# decide CMD - echoes exactly "commit", "pr_create" or "skip". A command
# matching BOTH triggers (unusual, but possible via `&&`) resolves "commit"
# first - deliberate, matching wind-fixture-guard.sh's own first-match-wins
# convention for the same reason: a nudge only needs to fire once, and commit
# is checked first because it is the more common shape in this repo's history
# (release/back-merge/hotfix commits vastly outnumber `gh pr create` calls in
# any single agent turn).
decide() {
  local cmd="$1"
  if _triggers_commit "$cmd" && [ -n "$(_closing_keyword_match "$cmd")" ]; then
    echo commit
    return
  fi
  if _triggers_pr_create "$cmd" && [ -n "$(_closing_keyword_match "$cmd")" ]; then
    echo pr_create
    return
  fi
  echo skip
}

# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  fail=0
  total=0
  # Counted for the same reason every other selftest in this repo counts
  # (PR #350 review, Finding 3): a row that silently disappears must not
  # leave this suite reporting SELFTEST OK having run fewer cases than it
  # claims to.
  # (PR #797 review, Minor 3) 32 -> 33: +1 for the JSON-validity row pinning
  # a literal TAB inside the matched substring no longer breaks the emitted
  # JSON (see that row's own comment).
  EXPECTED_CASES=33

  check() { # want(fire|skip)  desc  cmd
    total=$((total + 1))
    local want="$1" desc="$2" cmd="$3" got
    got=$(decide "$cmd")
    if [ "$want" = fire ]; then
      if [ "$got" = skip ]; then
        echo "SELFTEST FAIL: $desc -> got [skip] want [fire] (cmd: $cmd)"
        fail=1
      fi
    else
      if [ "$got" != skip ]; then
        echo "SELFTEST FAIL: $desc -> got [$got] want [skip] (cmd: $cmd)"
        fail=1
      fi
    fi
  }

  # --- MUST FIRE: commit-shaped, bare/colon/paren forms, both #257 and #279
  # incident shapes reproduced literally. ---
  check fire "bare Closes"                          'git commit -m "Closes #257"'
  check fire "#257 shape: negation does not save it" 'git commit -m "This PR does NOT close #211"'
  check fire "colon form (real GitHub spelling)"     'git commit -m "Closes: #321"'
  check fire "paren form"                            'git commit -m "fix (#412 done)"'
  check fire "bracketed conventional-commit form (#452 note: does NOT actually close on GitHub, but this pattern deliberately still matches it)" \
    'git commit -m "fix(#54): tidy up"'
  check fire "postfix #12 (ACCEPTED over-fire, safe direction for a nudge)" \
    'git commit -m "apply the postfix #12 workaround"'
  check fire "case-insensitive: CLOSES uppercase"    'git commit -m "CLOSES #99"'
  check fire "multiple refs, first is a closer"      'git commit -m "Closes #10, Refs #20"'
  check fire "bare resolve (no suffix)"               'git commit -m "resolve #7"'
  check fire "resolved"                               'git commit -m "resolved #7"'
  check fire "resolves"                               'git commit -m "resolves #7"'
  check fire "git -C compound"                        'git -C /path commit -m "fixes #54"'
  check fire "git -c compound"                        'git -c user.name=x commit -m "closes #10"'

  # --- MUST NOT FIRE: gerunds are not GitHub keywords. ---
  check skip "gerund: closing"                        'git commit -m "closing #12 for real this time"'
  check skip "gerund: fixing"                          'git commit -m "fixing #12"'
  check skip "gerund: resolving"                       'git commit -m "resolving #12"'

  # --- MUST NOT FIRE: the OLD pattern's false positive, now fixed. ---
  check skip "fixture #99 is not a keyword match"      'git commit -m "regenerate fixture #99"'

  # --- MUST NOT FIRE: the safe reference form, and no ref at all. ---
  check skip "Refs is the safe form"                   'git commit -m "Refs #319"'
  check skip "no issue reference at all"               'git commit -m "tidy up formatting"'

  # --- MUST NOT FIRE: trigger never matched in the first place (#727's own
  # invocation-vs-mention discipline - CLAUDE.md's "hook: invocation vs
  # mention" rule: match the command INVOKING git commit/gh pr create, not
  # merely one MENTIONING it). ---
  check skip "git status, no trigger"                  'git status'
  check skip "echo mentioning closes, no trigger"       'echo "remember: closes #12 needs a fix"'
  check skip "empty command"                            ''

  # --- gh pr create: both firing locations, #257/#279 incident shapes. ---
  check fire "gh pr create --body, #257 shape"          'gh pr create --title "fix" --body "This PR does NOT close #211"'
  check fire "gh pr create --body, #279 shape (stray trailing keyword)" \
    'gh pr create --title "fix" --body "changed approach.

Closes #265"'
  check fire "gh pr create -b short flag"               'gh pr create -b "fixes #10"'
  check fire "gh pr create --title alone carries a keyword (free bonus)" \
    'gh pr create --title "fix(#54): tidy" --body "see description"'
  check skip "gh pr create, clean Refs-only body"       'gh pr create --title "fix" --body "Refs #319"'
  check skip "gh pr create, no ref at all"              'gh pr create --title "tidy" --body "no issues touched"'

  # --- MEDIUM: `git commit` inside a longer pipeline still fires (whole-
  # string scan, not argv-position-sensitive). ---
  check fire "commit after &&"                          'npm test && git commit -m "fixes #54"'

  # ---- END-TO-END sanity through the real production path ($SELF, a
  # synthetic tool_input JSON payload piped to the actual script - not a
  # second hand-maintained copy of decide(), same discipline artifact-guard.sh
  # adopted at #404 for exactly this reason). ----
  case "$0" in
    */*) SELF=$0 ;;
    *) SELF=./$0 ;;
  esac

  _prod_check() { # want(advisory|silent)  desc  cmd
    total=$((total + 1))
    local want="$1" desc="$2" cmd="$3" json out
    json=$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(
      printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
        || printf '%s' "$cmd" | jq -Rs .
    )")
    out=$(printf '%s' "$json" | "$SELF" 2>&1)
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

  _prod_check advisory "sanity: real commit payload with a closer -> advisory, no permissionDecision" \
    'git commit -m "Closes #257"'
  _prod_check silent   "sanity: real commit payload with a clean Refs -> silent" \
    'git commit -m "Refs #319"'
  _prod_check silent   "sanity: empty stdin / non-triggering command -> silent" \
    'git status'

  # Minor 3 (PR #797 review), MUTATION-CHECKED: a literal TAB inside the
  # matched substring (CLOSING_KEYWORD_RE's `[[:space:]]` tail matches one)
  # used to reach the emitted JSON as a raw, unescaped control byte -
  # `jq empty` rejects that outright, and a hook emitting malformed JSON is
  # a failure with no good outcome. Builds the payload via `python3 -c
  # json.dumps` (falling back to `jq -Rs .`) so the embedded tab is a REAL
  # byte after jq parses tool_input.command, not an escaped two-character
  # sequence a naive shell string could not represent - the same technique
  # used to reproduce this defect against the review's own repro. Validates
  # the FULL emitted line through `jq empty`, not just a substring grep,
  # because #424's own lesson applies here too: a check that cannot fail is
  # not a check.
  _prod_check_valid_json() { # desc  cmd
    total=$((total + 1))
    local desc="$1" cmd="$2" json out
    json=$(python3 -c 'import json,sys; print(json.dumps({"tool_input":{"command":sys.argv[1]}}))' "$cmd" 2>/dev/null \
      || printf '{"tool_input":{"command":%s}}' "$(printf '%s' "$cmd" | jq -Rs .)")
    out=$(printf '%s' "$json" | "$SELF" 2>&1)
    if [ -z "$out" ]; then
      echo "SELFTEST FAIL [prod json]: $desc -> expected an advisory, got silence"
      fail=1
      return
    fi
    if ! printf '%s' "$out" | jq empty 2>/dev/null; then
      echo "SELFTEST FAIL [prod json]: $desc -> emitted INVALID JSON: $out"
      fail=1
    fi
  }
  _prod_check_valid_json "Minor 3: literal TAB in the matched substring must still emit valid JSON" \
    "$(printf 'git commit -m "Closes\t#12"')"

  # Positive assertion, not `-ne` (same reasoning as artifact-guard.sh's own
  # matching comment: `-ne` against an empty/non-numeric RHS fails OPEN).
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
# Fail OPEN on every input-handling failure, per the guard-asymmetry design
# note above - this file NEVER asks and NEVER blocks, so an unparseable
# payload just gets silence, exactly like a genuinely non-triggering command
# would. (Contrast wind-fixture-guard.sh, which escalates the SAME failures
# to `ask` because part of that guard blocks - there is no blocking branch
# here to protect.)
IN=$(cat)
[ -n "$IN" ] || exit 0

CMD=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null) \
  || CMD=$(printf '%s' "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tool_input',{}).get('command') or '')" 2>/dev/null) \
  || exit 0

[ -n "$CMD" ] || exit 0

VERDICT=$(decide "$CMD")
[ "$VERDICT" = skip ] && exit 0

MATCH=$(_closing_keyword_match "$CMD")
case "$VERDICT" in
  commit)
    emit_nudge "This commit message matches a GitHub closing keyword ('$MATCH') - closing keywords have NO negation awareness and fire on merge into the default branch even inside a disclaimer like 'does NOT close #N'. If this issue should stay open, use 'Refs #N' instead. If it should genuinely close, this is expected. (SailCommand #727 / CLAUDE.md's Closing-keywords bullet)"
    ;;
  pr_create)
    emit_nudge "This PR title/body matches a GitHub closing keyword ('$MATCH') - closing keywords have NO negation awareness and fire on merge into the default branch even inside a disclaimer like 'does NOT close #N'. Check both the PR body AND every commit message in the branch (fixing one does not fix the other). If this issue should stay open, use 'Refs #N' instead. (SailCommand #727 / CLAUDE.md's Closing-keywords bullet)"
    ;;
esac
exit 0
