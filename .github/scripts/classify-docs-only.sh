#!/usr/bin/env bash
# Docs-only vs. code classifier for ci.yml's `e2e` job (#327, PR #330).
#
# Extracted from an inline `run:` block in `.github/workflows/ci.yml` (#334) so
# it carries committed test coverage: it is a BLOCKING guard on a REQUIRED
# check (~60 lines of shell that previously had zero automated coverage - the
# same shape #274 already burned this repo on once).
#
# FAIL-CLOSED ON ITS OWN (PR #350 review round 2, R2-2): `set -euo pipefail`
# below means the errexit guarantee lives in THIS FILE, not in how it happens
# to be invoked. Round 1 fixed the Blocker by having ci.yml invoke this
# script as `run: bash -e .github/scripts/classify-docs-only.sh` rather than
# the bare `run: .github/scripts/classify-docs-only.sh` (the bare form execs
# the script via its own shebang into a NEW bash process that does not
# inherit errexit, so a failed `>> "$GITHUB_OUTPUT"` write was silently
# swallowed and a required check's expensive steps skipped on a GREEN job
# that wrote no decision at all) - correct, but it left the guarantee sitting
# in the CALLER, with nothing testing that the caller still says `bash -e`; a
# future tidy-up dropping those two tokens would silently bring the Blocker
# back, and `--selftest` (which drives itself via `bash -e "$SELF"`) cannot
# see it either. `-e` here removes that dependency entirely - the script is
# fail-closed under ANY invocation, bare or not. ci.yml's `bash -e` stays as
# belt-and-braces, not because it is still load-bearing on its own.
#
# `if ! changed=$(...); then` is used below instead of a bare
# `changed=$(...); status=$?` for the same reason either way: a bare failing
# command substitution under `-e` aborts the step before any exit-status
# variable could be read, making that check dead code; wrapping it as an
# `if` condition is exempt from `-e` and is what actually makes that branch
# reachable (see case 21 below, which exercises it).
#
# `e2e` is REQUIRED under `protect-main` with a strict up-to-date policy, so
# the JOB must always run and always report - a trigger-level `paths:` /
# `paths-ignore:` filter would make the check never report at all on a
# skipped PR, blocking the PR forever. Only the EXPENSIVE steps inside the job
# are `if:`-gated on this script's `run_e2e` output, and that gate itself
# defaults to RUN on anything other than the literal string `false`
# (`!= 'false'`, not `== 'true'`) so an absent or empty output - this script
# aborting before it writes one - still runs e2e rather than skipping it.
#
# FAIL-CLOSED DEFAULT: the wrong-direction failure is a code PR silently
# skipping e2e and reporting green, which is far worse than a docs PR paying
# the few minutes of e2e it didn't need (measured ~3-4 min/run, not the ~10
# min sometimes assumed elsewhere - see CLAUDE.md's Commands section). Any
# ambiguity - a non-PR event, an unreadable base/head commit (shallow clone,
# merge queue, force-push), a failing `git diff`, or an empty changed-file
# list - defaults to RUN, explicitly, not by accident of how an expression
# happens to evaluate.
#
# `.claude/**` is deliberately NOT on the allowlist below - it holds
# executable hooks (`.claude/settings.json`, `.claude/hooks/`), so it is code,
# never docs. Do not add it.
#
# Production usage - invoked by ci.yml with working-directory at repo root
# (bare invocation works too - see the FAIL-CLOSED ON ITS OWN note above):
#   EVENT_NAME=... BASE_SHA=... HEAD_SHA=... \
#   GITHUB_OUTPUT=... GITHUB_STEP_SUMMARY=... .github/scripts/classify-docs-only.sh
# Offline self-test against synthesized git repos (#334):
#   .github/scripts/classify-docs-only.sh --selftest
set -euo pipefail

# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  # Re-invoke THIS exact file (not a copy, not an extracted function) as a
  # child process under `bash -e`, matching ci.yml's real invocation shell -
  # PR #330's review found the fail-closed property only by testing the
  # VERBATIM script this way; testing an extracted pure function would not
  # have caught the `-e`-sensitivity bugs that shape guarded against.
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  PASS=0; FAIL=0

  mkrepo() {
    d="$(mktemp -d)"; cd "$d" || exit 1
    git init -q -b main . >/dev/null 2>&1
    git config user.email t@t; git config user.name t; git config commit.gpgsign false
    git config core.quotePath true   # git default - the script must override this itself
    mkdir -p docs app/src .github/ISSUE_TEMPLATE
    echo base > docs/seed.md; echo base > app/src/seed.ts; echo base > README.md
    git add -A >/dev/null; git commit -qm base >/dev/null
    echo "$d"
  }

  commit_with() { # commit_with <msg> ; files already staged
    git add -A >/dev/null 2>&1; git commit -qm "$1" >/dev/null 2>&1; git rev-parse HEAD
  }

  # run <label> <expected run_e2e> <event> <base> <head>
  run() {
    local label="$1" expect="$2" ev="$3" b="$4" h="$5"
    local out sum log rc got reason
    out="$(mktemp)"; sum="$(mktemp)"; log="$(mktemp)"
    set +e
    EVENT_NAME="$ev" BASE_SHA="$b" HEAD_SHA="$h" \
      GITHUB_OUTPUT="$out" GITHUB_STEP_SUMMARY="$sum" \
      bash -e "$SELF" >"$log" 2>&1
    rc=$?
    set -e
    got="$(grep -o 'run_e2e=[a-z]*' "$out" 2>/dev/null | tail -1 | cut -d= -f2)"
    [ -z "$got" ] && got="<none:step-exit-$rc>"
    reason="$(grep -o 'reason=.*' "$log" | tail -1)"
    if [ "$got" = "$expect" ]; then
      printf '  OK   %-58s -> %-8s (%s)\n' "$label" "$got" "${reason:-step failed rc=$rc}"
      PASS=$((PASS + 1))
    else
      printf '  XX   %-58s -> %-8s expected %s  (%s)\n' "$label" "$got" "$expect" "${reason:-step failed rc=$rc}"
      FAIL=$((FAIL + 1))
    fi
    rm -f "$out" "$sum" "$log"
  }

  # Pinned so a case that silently disappears (deleted outright, or dropped
  # by a conditional `&&`-chain whose precondition stops holding, like 12f's
  # filename-creation step) cannot leave the suite reporting `SELFTEST OK`
  # having run fewer cases than it claims to (PR #350 review, Finding 3 -
  # constructed mutations M2/M3/M4 all left `FAIL=0` with a shrunken PASS).
  EXPECTED_CASES=34

  echo "=== classify-docs-only.sh: ${EXPECTED_CASES} adversarial cases (bash -e, GH default shell) ==="

  # ---------- 1 docs-only ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; H=$(commit_with docs)
  run "1  docs/** only" false pull_request "$B" "$H"

  # ---------- 2 mixed docs + app ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; echo x >> app/src/seed.ts; H=$(commit_with mixed)
  run "2  docs/** + app/src (MIXED, must RUN)" true pull_request "$B" "$H"

  # ---------- 3 workflow file ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  mkdir -p .github/workflows; echo x > .github/workflows/ci.yml; H=$(commit_with wf)
  run "3  .github/workflows/ci.yml" true pull_request "$B" "$H"

  # ---------- 4 unlisted path ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x > NOTICE.txt; H=$(commit_with unl)
  run "4  unlisted root file NOTICE.txt" true pull_request "$B" "$H"

  # ---------- 5 empty diff ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  run "5  empty diff (base == head)" true pull_request "$B" "$B"

  # ---------- 6 unreachable base ----------
  r=$(mkrepo); cd "$r"; B=0000000000000000000000000000000000000001; H=$(git rev-parse HEAD)
  run "6  bogus base sha (unreachable)" true pull_request "$B" "$H"

  # ---------- 6b unreachable head ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  run "6b bogus head sha (unreachable)" true pull_request "$B" 0000000000000000000000000000000000000002

  # ---------- 6c base sha is a TREE not a commit ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD^{tree}); H=$(git rev-parse HEAD)
  run "6c base sha is a tree object" true pull_request "$B" "$H"

  # ---------- 7 push event ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD); echo x >> docs/seed.md; H=$(commit_with d)
  run "7  push event, docs-only diff" true push "$B" "$H"
  run "7b empty env shas + push" true push "" ""

  # ---------- 8 rename code -> docs ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  git mv app/src/seed.ts docs/seed.ts >/dev/null; H=$(commit_with ren)
  run "8  RENAME app/src/seed.ts -> docs/seed.ts" true pull_request "$B" "$H"

  # ---------- 8b rename docs -> code ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  git mv docs/seed.md app/src/seed.md >/dev/null; H=$(commit_with ren2)
  run "8b RENAME docs/seed.md -> app/src/seed.md" true pull_request "$B" "$H"

  # ---------- 9 prefix trap ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  mkdir -p docs-internal; echo x > docs-internal/x.ts; H=$(commit_with pfx)
  run "9  docs-internal/x.ts (prefix trap)" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x > README.md.bak; H=$(commit_with pfx2)
  run "9b README.md.bak (suffix trap)" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  mkdir -p app/docs; echo x > app/docs/a.md; H=$(commit_with pfx3)
  run "9c app/docs/a.md (unanchored-glob trap)" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x > xREADME.md; H=$(commit_with pfx4)
  run "9d xREADME.md" true pull_request "$B" "$H"

  # ---------- 10 nested docs ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  mkdir -p docs/superpowers/specs; echo x > docs/superpowers/specs/a.md; H=$(commit_with nest)
  run "10 docs/a/b/c.md nested (should SKIP)" false pull_request "$B" "$H"

  # ---------- 11 changelog.d ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  mkdir -p changelog.d; echo x > changelog.d/1.md; H=$(commit_with cd)
  run "11 changelog.d/1.md (SKIP by design)" false pull_request "$B" "$H"

  # ---------- 12 weird filenames ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x > 'docs/a b.md'; H=$(commit_with sp)
  run "12 'docs/a b.md' (space)" false pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x > 'docs/ä.md'; H=$(commit_with uni)
  run "12b 'docs/ä.md' (unicode, repo quotePath on)" false pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x > 'app/src/ä.ts'; H=$(commit_with uni2)
  run "12c 'app/src/ä.ts' (unicode CODE file)" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x > '-weird.ts'; H=$(commit_with dash)
  run "12d '-weird.ts' (leading dash)" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x > 'a"b.ts'; H=$(commit_with q)
  run '12e a"b.ts (embedded quote)' true pull_request "$B" "$H"

  # Unconditional (PR #350 review, Finding 3's complementary half): a
  # filesystem/git that rejects a newline in a filename must COUNT as a
  # failed case, not silently drop the `run()` call and shrink PASS+FAIL -
  # that shrinkage is exactly what let mutation M4 slip through undetected.
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  if printf 'x' > "$(printf 'evil\nfile.ts')" 2>/dev/null && H=$(commit_with nl); then
    run "12f newline in filename" true pull_request "$B" "$H"
  else
    printf '  XX   %-58s -> %-8s (%s)\n' "12f newline in filename" "<could-not-create>" "filesystem/git rejected a newline in a filename - case did not execute"
    FAIL=$((FAIL + 1))
  fi

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x > 'docs*.ts'; H=$(commit_with glob)
  run "12g 'docs*.ts' (glob metachar in name)" true pull_request "$B" "$H"

  # ---------- 13 base ahead (stale base) ----------
  r=$(mkrepo); cd "$r"; B0=$(git rev-parse HEAD)
  git switch -qc feat; echo x >> docs/seed.md; H=$(commit_with docsonly)
  git switch -q main; echo x >> app/src/seed.ts; B1=$(commit_with basemoved)
  run "13 base moved ahead w/ code; head docs-only" true pull_request "$B1" "$H"

  # ---------- 14 genuinely shallow clone (not just a bogus SHA) ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; H=$(commit_with docsonly2)
  shallow=$(mktemp -d)
  git clone -q --depth 1 "file://$r" "$shallow" >/dev/null 2>&1
  cd "$shallow"
  run "14 genuinely shallow clone (base object missing)" true pull_request "$B" "$H"

  # ---------- 15 bare 'docs' path (no trailing slash) at root ----------
  # mkrepo() creates docs/ as a DIRECTORY - remove it first so a plain file
  # named literally "docs" can exist at that path instead.
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  rm -rf docs; echo x > docs; H=$(commit_with bare)
  run "15 root file literally named 'docs' (no slash)" true pull_request "$B" "$H"

  # ---------- 16/17 new allowlist entries added after PR #330 (CLAUDE.md, LICENSE) ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x > CLAUDE.md; H=$(commit_with claudemd)
  run "16 CLAUDE.md alone" false pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x > LICENSE; H=$(commit_with license)
  run "17 LICENSE alone" false pull_request "$B" "$H"

  # ---------- 18/19/20 .claude/** must stay code (never docs) ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  mkdir -p .claude; echo x > .claude/settings.json; H=$(commit_with settings)
  run "18 .claude/settings.json changed" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  mkdir -p .claude/hooks; echo x > .claude/hooks/foo.sh; H=$(commit_with hookfile)
  run "19 .claude/hooks/foo.sh changed" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  mkdir -p .claude/hooks; echo x >> CLAUDE.md; echo x > .claude/hooks/bar.sh; H=$(commit_with mixed2)
  run "20 CLAUDE.md + .claude/hooks/bar.sh (MIXED, must RUN)" true pull_request "$B" "$H"

  # ---------- 21 git diff fails though both commits exist (PR #350 review, ----------
  # ---------- Finding 4: the one fail-closed branch nothing else reaches)  ----------
  # `cat-file -e` on both SHAs succeeds (they're real commits), but the base
  # commit's TREE object is then deleted, so `git diff` itself fails (exit
  # 128) after the reachability check already passed. This is the ONLY case
  # in the whole suite that reaches the `else` arm of
  # `if changed="$(git ... diff ...)"; then ... else diff_status=$?; ...`
  # below - every other case either trips the earlier `cat-file` guard
  # (6/6b/6c/14) or hands `git diff` two intact commits. Deliberately
  # docs-only BY CONTENT (only docs/seed.md changed) so it can only pass via
  # the fail-closed `git diff failed` branch, never by accidentally matching
  # a non-docs path - the same near-miss shape #216 warns against (a row
  # meant to isolate one condition must not carry a second trigger for the
  # same outcome).
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; H=$(commit_with docsonly3)
  TREE=$(git rev-parse "$B^{tree}")
  rm -f ".git/objects/${TREE:0:2}/${TREE:2}"
  run "21 base tree object missing (git diff fails)" true pull_request "$B" "$H"

  echo
  echo "PASS=$PASS FAIL=$FAIL"
  TOTAL=$((PASS + FAIL))
  # Positive assertion, not `-ne` (PR #350 review round 2, R2-1): `[ "$TOTAL"
  # -ne "$EXPECTED_CASES" ]` with an EMPTY or non-numeric RHS makes `[` print
  # "integer expression expected" and return status 2, not 1 - the `if` then
  # takes the FALSE branch, the guard is silently skipped, and the suite
  # prints SELFTEST OK regardless. `set -u` does not help: it catches an
  # UNSET variable, but an empty one is defined. `! [ ... -eq ... ]` inverts
  # a TRUE (status 0, exactly this many cases ran) into the only case that
  # skips the failure branch; a genuine mismatch (status 1) OR a `[` usage
  # error (status 2, e.g. EXPECTED_CASES accidentally left empty or
  # non-numeric while bumping the count) both negate to true and land in the
  # failure branch. `2>/dev/null` suppresses the "integer expression
  # expected" noise on that path.
  if ! [ "$TOTAL" -eq "$EXPECTED_CASES" ] 2>/dev/null; then
    echo "SELFTEST FAILURES: ran $TOTAL cases, expected ${EXPECTED_CASES:-<unset/empty>} - a case was skipped or silently dropped"
    exit 1
  fi
  if [ "$FAIL" -eq 0 ]; then echo "SELFTEST OK"; else echo "SELFTEST FAILURES"; fi
  exit "$FAIL"
fi

# ---- production path (verbatim from ci.yml's former inline classify step) ----
EVENT_NAME="${EVENT_NAME:-}"
BASE_SHA="${BASE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/null}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

# The /dev/null default above is deliberate for standalone CLI use (running
# this script by hand, or under --selftest, without a real Actions
# environment) - NOT for a real run under Actions, where a decision silently
# discarded to /dev/null is indistinguishable from "skip" once the outer
# `if: run_e2e != 'false'` gate reads the (absent) output (PR #350 review,
# Finding 6). Scoped to $GITHUB_ACTIONS so it fires only where it matters:
# an unset GITHUB_OUTPUT under real Actions aborts loudly instead of
# defaulting away the write.
if [ -n "${GITHUB_ACTIONS:-}" ] && [ "$GITHUB_OUTPUT" = /dev/null ]; then
  echo "::error::GITHUB_OUTPUT is unset under GitHub Actions - refusing to silently write the e2e decision to /dev/null (that would read as 'skip' to the job's if: gates)" >&2
  exit 1
fi

run_e2e=true
reason="not a pull_request event"

if [ "${EVENT_NAME}" = "pull_request" ]; then
  base_sha="${BASE_SHA}"
  head_sha="${HEAD_SHA}"

  if git cat-file -e "${base_sha}^{commit}" 2>/dev/null \
    && git cat-file -e "${head_sha}^{commit}" 2>/dev/null; then

    # Two-dot diff, not three-dot: two-dot needs no merge-base, so it
    # survives a shallow/partial object store, and a stale or over-broad base
    # only ever ADDS files to the changed set - the safe direction for a
    # fail-closed check. `--no-renames` so a code file renamed INTO docs/
    # still shows its origin path and isn't misclassified as docs-only.
    # `-c core.quotePath=false` so a non-ASCII path (e.g. `docs/ä.md`) comes
    # back as literal UTF-8 instead of git's default C-quoted octal escapes
    # (`"docs/\303\244.md"`), which would match no allowlist glob and force a
    # needless RUN.
    #
    # The git-diff failure is captured via `if ! changed=...; then` rather
    # than `changed=...; status=$?` - the invoking shell (GitHub's default
    # `bash -e {0}` for `run:` steps, combined with this script's own
    # `set -uo pipefail`) does NOT clear `-e`, so a bare failing command
    # substitution would abort the whole step before any exit-status variable
    # could be read, making that check dead code. Wrapping the substitution
    # as an `if` condition is exempt from `-e` and is what actually makes
    # this branch reachable.
    if changed="$(git -c core.quotePath=false diff --no-renames --name-only "${base_sha}" "${head_sha}")"; then
      if [ -z "${changed}" ]; then
        run_e2e=true
        reason="empty changed-file list"
      else
        run_e2e=false
        reason="all changed paths matched the docs allowlist"
        while IFS= read -r f; do
          [ -z "$f" ] && continue
          case "$f" in
            # NOTE: `docs/*` also matches non-Markdown files under docs/
            # (e.g. docs/screenshots/capture.mjs) - accepted because docs/ is
            # assumed to stay non-executable (nothing under it is referenced
            # by any workflow or package script today). If docs/ ever gains a
            # build step or generated artifact that feeds app/pipeline code,
            # narrow this entry instead of widening the exclusion.
            #
            # Deliberately NOT `.claude/**` - it holds executable hooks
            # (`.claude/settings.json`, `.claude/hooks/`), so it is code,
            # never docs. Do not add it here.
            CHANGELOG.md|README.md|ROADMAP.md|GOVERNANCE.md|CONTRIBUTING.md|SECURITY.md|CODE_OF_CONDUCT.md|CLAUDE.md|LICENSE|docs/*|.github/ISSUE_TEMPLATE/*|.github/PULL_REQUEST_TEMPLATE.md|changelog.d/*)
              ;;
            *)
              # Record only the FIRST path that forces a run - do not
              # overwrite once already true (an unlisted path is code, never
              # docs, per #327's definition of done).
              if [ "${run_e2e}" != "true" ]; then
                run_e2e=true
                reason="non-docs path: ${f}"
              fi
              ;;
          esac
        done <<< "${changed}"
      fi
    else
      diff_status=$?
      run_e2e=true
      reason="git diff failed (exit ${diff_status})"
    fi
  else
    run_e2e=true
    reason="base or head commit unreachable (shallow clone / merge-queue / force-push)"
  fi
fi

# Log to stdout too, not just $GITHUB_OUTPUT/$GITHUB_STEP_SUMMARY - a
# misclassification six months from now needs the WHY in the plain job log,
# not only in machine-readable outputs that don't show up in `gh run view
# --log`. Name the value, not a boolean (this repo has paid for a
# boolean-only assertion twice already).
echo "changed paths:"
printf '%s\n' "${changed:-<none>}"
echo "run_e2e=${run_e2e} reason=${reason}"

echo "run_e2e=${run_e2e}" >> "$GITHUB_OUTPUT"
{
  echo "### e2e classification"
  echo "- run_e2e: **${run_e2e}**"
  echo "- reason: ${reason}"
} >> "$GITHUB_STEP_SUMMARY"
