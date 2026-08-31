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
# wind-fixture-guard.sh's own "NOT ATTEMPTED" convention): a message supplied
# via `git commit -F file.txt` or `gh pr create --body-file file.md` lives in
# a FILE this hook never reads - only inline `-m`/`--body` text on the
# command line itself is visible here. A `git commit` with no `-m` at all
# (opens $EDITOR) is equally invisible. Neither is a regression versus the
# status quo (the hand-run grep CLAUDE.md documents has the identical blind
# spot, since it also greps rendered TEXT, not files-yet-to-be-written) - both
# residuals are inherited, not introduced.
#
# Offline self-test of the pure decision logic PLUS a handful of end-to-end
# sanity checks through the real production path:
#   .claude/hooks/closing-keyword-guard.sh --selftest
set -uo pipefail

CLOSING_KEYWORD_RE='(clos(e|es|ed)?|fix(e[sd])?|resolve[sd]?)[[:space:]:(]*#[0-9]+'

emit_nudge() { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$1"; }

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
  EXPECTED_CASES=32

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
