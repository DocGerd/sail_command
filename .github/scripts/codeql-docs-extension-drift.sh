#!/usr/bin/env bash
# CI guard (#911): codeql.yml's docs/** re-include list has no keeper
# against drift from CodeQL's own indexed-file model.
#
# BACKGROUND: `.github/workflows/codeql.yml`'s `pull_request:` trigger
# excludes `docs/**` wholesale, then re-includes real source living under
# `docs/` by a hand-maintained extension list (`ts`, `tsx`, `js`, `jsx`,
# `mjs`, `py`). Nothing keeps that list in sync with what CodeQL's
# extractors actually index - a future `docs/**` file with an extension
# CodeQL indexes but this list doesn't re-include (`.cjs`, `.mts`, `.html`,
# `.yml`/`.yaml` are the candidates #911 itself names) would be silently
# dropped from PR-scoped analysis, and nothing reds (CodeQL is not a
# required check - `protect-main` requires only `app`+`e2e`).
#
# This script walks docs/** for every file actually present in this tree
# and asserts, for each one, that it either (a) matches a `paths:`
# re-include pattern in codeql.yml, or (b) is confirmed NOT part of
# CodeQL's default-indexed set. Load-bearing distinction from #911, cited
# there against `github/codeql`'s `javascript/extractor/src/com/semmle/js/
# extractor/AutoBuild.java` (re-fetched 2026-09-03): `FileType` enum
# membership is NOT "indexed by default" - JSON is a FileType but reaches
# extraction only through a narrow BASENAME allowlist, never a blanket
# extension re-include the way HTML/JS/YAML/TypeScript do. So this script
# runs two independent checks: an EXTENSION check against
# CODEQL_INDEXED_EXTENSIONS, and a separate BASENAME check against
# CODEQL_JSON_BASENAME_PATTERNS for JSON's narrower path.
#
# THREE INDEPENDENT SOURCES, deliberately never cross-derived (CLAUDE.md:
# "don't derive needle and haystack from the same source" - a check whose
# two sides come from one place is a tautology that passes forever):
#   1. The HAYSTACK - every file actually present under docs/ in this tree,
#      read straight off the filesystem (`find`), not from any list here.
#   2. NEEDLE #1 - the docs/** re-include patterns, parsed directly out of
#      codeql.yml itself via an ADDRESSED lookup (anchored on the exact
#      `    paths:` line, never a whole-file scan - CLAUDE.md's #359
#      precedent: a whole-file scrape for this kind of check fail-opened
#      four times before being replaced by an addressed, declared model).
#   3. NEEDLE #2 - CODEQL_INDEXED_EXTENSIONS and
#      CODEQL_JSON_BASENAME_PATTERNS below: hand-maintained constants
#      derived from AutoBuild.java (cited above), never from codeql.yml or
#      from the docs/ tree. Update them by hand, with a citation, if
#      CodeQL's own indexed set changes - nothing here re-fetches it.
#
# FAIL-CLOSED (CLAUDE.md's guard-asymmetry rule): a missing codeql.yml, a
# missing docs/ directory, an unparseable/restructured `paths:` block, or
# the loss of the `!docs/**` exclusion this script's model depends on all
# FAIL rather than silently reporting "no drift". None of those states may
# print anything indistinguishable from a genuine clean pass.
#
# Discovered and run by ci.yml's `hook-selftests` job (same mechanism as
# #836's sibling script): that job globs `.github/scripts/*.sh` at
# `-maxdepth 1` and requires both exit 0 and a literal `SELFTEST OK` line
# from `bash "$f" --selftest`. This script is deliberately NOT wired into
# codeql.yml itself - it is a NUDGE against a silent gap, not a blocking
# gate on the docs tree, and `hook-selftests` is advisory (not a required
# check), matching the advisory tier #911 itself suggests.
#
# Usage: .github/scripts/codeql-docs-extension-drift.sh [--selftest]
#   (no args)   check THIS repo's real docs/ tree against THIS repo's real
#               codeql.yml, from the repo root.
#   --selftest  run this script's own test battery against synthetic
#               trees; prints SELFTEST OK and exits 0 only if every case
#               behaves as expected.

set -uo pipefail

# ---------------------------------------------------------------------
# Needle #2 (see header): hand-maintained, not derived from anything else
# in this script or from this repo's tree.
# ---------------------------------------------------------------------

# Extensions CodeQL's javascript-typescript extractor indexes BY DEFAULT
# via AutoBuild.java's setupFilters() blanket re-include of
# FileType.{HTML, JS, YAML, TYPESCRIPT}, plus `py` for the separate python
# leg (that extractor is not extension-gated the same way; it indexes
# *.py wherever it runs). `cjs`/`mts`/`cts`/`html`/`yml`/`yaml` are the
# members codeql.yml's current re-include list does NOT cover - #911
# names `.cjs`, `.mts`, `.html`, `.yml`/`.yaml` explicitly as the "obvious
# candidates"; `.cts` is added here for symmetry with `.mts` (TypeScript's
# other CommonJS-module extension). Re-verify against AutoBuild.java
# before editing this line; it does not self-update.
CODEQL_INDEXED_EXTENSIONS="html js jsx mjs cjs ts tsx mts cts yml yaml py"

# JSON reaches extraction only through this explicit BASENAME allowlist
# (verified 2026-09-03 against the same AutoBuild.java, cited in #911) -
# arbitrary `*.json` is NOT indexed despite JSON being a `FileType` member.
# A docs/** file matching one of these basenames would be indexed by
# CodeQL regardless of the extension list above, so it needs its OWN
# re-include coverage in codeql.yml; there is currently none.
CODEQL_JSON_BASENAME_PATTERNS=(
  'package.json'
  '*tsconfig*.json'
  'manifest.json'
  '.eslintrc*'
  'xs-app.json'
  '*.view.json'
  '.xsaccess'
  'codeql-javascript-*.json'
)

WORKFLOW_REL_PATH=".github/workflows/codeql.yml"

is_member() {
  # is_member NEEDLE LIST...  (LIST is a bash word-split list, not a file)
  local needle="$1"
  shift
  local x
  for x in "$@"; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

# check_drift ROOT
# Returns 0 (clean), 1 (drift found), or 2 (guard could not run - fail
# closed). Diagnostics go to stdout via echo, same as this repo's other
# hooks.
check_drift() {
  local root="$1" wf docs_dir
  wf="$root/$WORKFLOW_REL_PATH"
  docs_dir="$root/docs"

  if [ ! -f "$wf" ]; then
    echo "::error::$wf does not exist - cannot verify codeql.yml's docs/** re-include list (#911)"
    return 2
  fi
  if [ ! -d "$docs_dir" ]; then
    echo "::error::$docs_dir does not exist - cannot enumerate docs/** files (#911)"
    return 2
  fi

  # Needle #1: addressed lookup, never a whole-file scan (#359's precedent).
  # Anchor on the exact `    paths:` line under `pull_request:` and take
  # only the immediately-following 6-space `- ` item lines, stopping at
  # the first line that breaks that shape (the next top-level `on:` key).
  local items
  items=$(awk '
    /^    paths:$/ { grab=1; next }
    grab && /^      - / { print; next }
    grab { exit }
  ' "$wf")

  if [ -z "$items" ]; then
    echo "::error::could not find a \`    paths:\` block with item lines in $wf - codeql.yml's trigger structure may have changed; update this script's model (#911)"
    return 2
  fi
  if ! printf '%s\n' "$items" | grep -qxF "      - '!docs/**'"; then
    echo "::error::$wf's paths: block no longer excludes docs/** via \`- '!docs/**'\` - this guard's model of the re-include mechanism no longer matches; update this script (#911)"
    return 2
  fi

  local reincluded_raw
  reincluded_raw=$(printf '%s\n' "$items" \
    | sed -n "s/^      - 'docs\/\*\*\/\*\.\([A-Za-z0-9]*\)'\$/\1/p" \
    | tr 'A-Z' 'a-z')
  local reincluded=()
  if [ -n "$reincluded_raw" ]; then
    mapfile -t reincluded <<< "$reincluded_raw"
  fi

  # Haystack: every file actually present under docs/ in THIS tree, read
  # straight off the filesystem - independent of both needles above.
  local files=()
  mapfile -t files < <(find "$docs_dir" -type f | sort)

  local drift=0 f base ext

  # 1) extension check
  local present_exts=()
  local pe
  for f in "${files[@]}"; do
    base=$(basename "$f")
    case "$base" in
      *.*) pe="${base##*.}"; present_exts+=("$(tr 'A-Z' 'a-z' <<< "$pe")") ;;
    esac
  done
  # dedupe
  local -A seen=()
  for ext in "${present_exts[@]:-}"; do
    [ -n "$ext" ] || continue
    [ -n "${seen[$ext]:-}" ] && continue
    seen[$ext]=1
    if is_member "$ext" "${reincluded[@]:-}"; then
      continue
    fi
    if is_member "$ext" $CODEQL_INDEXED_EXTENSIONS; then
      echo "::error::docs/** contains a *.$ext file, which CodeQL's default extractor filters index, but codeql.yml's paths: re-include list has no \`docs/**/*.$ext\` entry - it will be silently dropped from PR-scoped analysis (#911)"
      drift=1
    fi
  done

  # 2) JSON basename-allowlist check (JSON's narrower path to extraction,
  # independent of the extension list above)
  for f in "${files[@]}"; do
    base=$(basename "$f")
    for pattern in "${CODEQL_JSON_BASENAME_PATTERNS[@]}"; do
      if [[ "$base" == $pattern ]]; then
        ext=""
        case "$base" in *.*) ext=$(tr 'A-Z' 'a-z' <<< "${base##*.}") ;; esac
        if [ -n "$ext" ] && is_member "$ext" "${reincluded[@]:-}"; then
          break
        fi
        echo "::error::$f matches CodeQL's JSON basename allowlist ('$pattern') and would be indexed regardless of extension, but codeql.yml's paths: re-include list has no matching entry for it - it will be silently dropped from PR-scoped analysis (#911)"
        drift=1
        break
      fi
    done
  done

  [ "$drift" -eq 0 ] && return 0
  return 1
}

# =======================================================================
if [ "${1:-}" = "--selftest" ]; then
  fail=0
  total_cases=0
  EXPECTED_CASES=10

  mkrepo() {
    local d
    d=$(mktemp -d)
    mkdir -p "$d/.github/workflows" "$d/docs"
    echo "$d"
  }

  # Minimal but structurally faithful codeql.yml fragment. $1 = root dir,
  # remaining args = extra `docs/**/*.EXT` re-include lines to append
  # (each arg is one bare extension, e.g. "cjs").
  write_wf() {
    local d="$1"; shift
    {
      echo "name: CodeQL"
      echo "on:"
      echo "  pull_request:"
      echo "    paths:"
      echo "      - '**'"
      echo "      - '!docs/**'"
      echo "      - '!README.md'"
      echo "      - 'docs/**/*.ts'"
      echo "      - 'docs/**/*.tsx'"
      echo "      - 'docs/**/*.js'"
      echo "      - 'docs/**/*.jsx'"
      echo "      - 'docs/**/*.mjs'"
      echo "      - 'docs/**/*.py'"
      local ext
      for ext in "$@"; do
        echo "      - 'docs/**/*.$ext'"
      done
      echo "  schedule:"
      echo "    - cron: '23 4 * * 1'"
    } > "$d/.github/workflows/codeql.yml"
  }

  run() {
    local root="$1"
    check_drift "$root" >"$LAST_OUT_FILE" 2>&1
    LAST_RC=$?
    LAST_OUT=$(cat "$LAST_OUT_FILE")
  }

  LAST_OUT_FILE=$(mktemp)
  trap 'rm -f "$LAST_OUT_FILE"' EXIT

  # 1: baseline mirroring the real repo shape - ts/mjs covered, non-matching
  # json basenames present - must be CLEAN.
  total_cases=$((total_cases + 1))
  r=$(mkrepo); write_wf "$r"
  touch "$r/docs/scratch.ts" "$r/docs/capture.mjs" "$r/docs/run1.json" "$r/docs/notes.md"
  run "$r"
  [ "$LAST_RC" -eq 0 ] || { echo "SELFTEST FAIL: 1 clean baseline -> rc=$LAST_RC out=$LAST_OUT"; fail=1; }

  # 2 (POSITIVE CONTROL): an indexed-but-uncovered extension under docs/
  # must be DETECTED as drift - proves the extension detector can fire at
  # all, not merely that it stays silent.
  total_cases=$((total_cases + 1))
  r=$(mkrepo); write_wf "$r"
  touch "$r/docs/legacy.cjs"
  run "$r"
  [ "$LAST_RC" -eq 1 ] || { echo "SELFTEST FAIL: 2 uncovered indexed ext (.cjs) -> rc=$LAST_RC (want 1) out=$LAST_OUT"; fail=1; }
  case "$LAST_OUT" in *"*.cjs"*) ;; *) echo "SELFTEST FAIL: 2 message did not name .cjs -> $LAST_OUT"; fail=1 ;; esac

  # 3: the SAME extension, but now covered by an explicit re-include line -
  # must be CLEAN. Proves case 2 fired on the coverage gap, not merely on
  # the extension's mere presence.
  total_cases=$((total_cases + 1))
  r=$(mkrepo); write_wf "$r" cjs
  touch "$r/docs/legacy.cjs"
  run "$r"
  [ "$LAST_RC" -eq 0 ] || { echo "SELFTEST FAIL: 3 covered .cjs -> rc=$LAST_RC (want 0) out=$LAST_OUT"; fail=1; }

  # 4: a present extension confirmed NOT part of CodeQL's indexed set
  # (image/markdown) must stay CLEAN even though it's uncovered - proves
  # the detector distinguishes "uncovered" from "uncovered AND indexed".
  total_cases=$((total_cases + 1))
  r=$(mkrepo); write_wf "$r"
  touch "$r/docs/diagram.png" "$r/docs/notes.md" "$r/docs/change.diff"
  run "$r"
  [ "$LAST_RC" -eq 0 ] || { echo "SELFTEST FAIL: 4 non-indexed ext -> rc=$LAST_RC (want 0) out=$LAST_OUT"; fail=1; }

  # 5 (POSITIVE CONTROL, JSON path): a basename matching the JSON
  # allowlist must be DETECTED even with a generic .json extension.
  total_cases=$((total_cases + 1))
  r=$(mkrepo); write_wf "$r"
  mkdir -p "$r/docs/sub"
  touch "$r/docs/sub/package.json"
  run "$r"
  [ "$LAST_RC" -eq 1 ] || { echo "SELFTEST FAIL: 5 package.json basename -> rc=$LAST_RC (want 1) out=$LAST_OUT"; fail=1; }
  case "$LAST_OUT" in *"package.json"*) ;; *) echo "SELFTEST FAIL: 5 message did not name package.json -> $LAST_OUT"; fail=1 ;; esac

  # 6: an arbitrary .json file NOT matching any allowlisted basename stays
  # CLEAN (this is the #911 "sweep-dump json" case) - proves case 5 fired
  # on the basename match, not merely on the .json extension.
  total_cases=$((total_cases + 1))
  r=$(mkrepo); write_wf "$r"
  touch "$r/docs/run1.json" "$r/docs/double-run-control.json"
  run "$r"
  [ "$LAST_RC" -eq 0 ] || { echo "SELFTEST FAIL: 6 arbitrary json -> rc=$LAST_RC (want 0) out=$LAST_OUT"; fail=1; }

  # 7: a glob-pattern basename match (*tsconfig*.json) must also fire.
  total_cases=$((total_cases + 1))
  r=$(mkrepo); write_wf "$r"
  touch "$r/docs/tsconfig.build.json"
  run "$r"
  [ "$LAST_RC" -eq 1 ] || { echo "SELFTEST FAIL: 7 tsconfig glob basename -> rc=$LAST_RC (want 1) out=$LAST_OUT"; fail=1; }

  # 8 (FAIL-CLOSED): missing codeql.yml entirely.
  total_cases=$((total_cases + 1))
  r=$(mkrepo); rm -f "$r/.github/workflows/codeql.yml"
  run "$r"
  [ "$LAST_RC" -eq 2 ] || { echo "SELFTEST FAIL: 8 missing codeql.yml -> rc=$LAST_RC (want 2)"; fail=1; }

  # 9 (FAIL-CLOSED): missing docs/ directory.
  total_cases=$((total_cases + 1))
  r=$(mkrepo); write_wf "$r"; rmdir "$r/docs"
  run "$r"
  [ "$LAST_RC" -eq 2 ] || { echo "SELFTEST FAIL: 9 missing docs/ -> rc=$LAST_RC (want 2)"; fail=1; }

  # 10 (FAIL-CLOSED): the `!docs/**` exclusion this script's model depends
  # on has disappeared from a restructured codeql.yml - must fail closed,
  # never silently report clean.
  total_cases=$((total_cases + 1))
  r=$(mkrepo)
  {
    echo "name: CodeQL"
    echo "on:"
    echo "  pull_request:"
    echo "    paths:"
    echo "      - '**'"
    echo "      - '!README.md'"
    echo "  schedule:"
    echo "    - cron: '23 4 * * 1'"
  } > "$r/.github/workflows/codeql.yml"
  run "$r"
  [ "$LAST_RC" -eq 2 ] || { echo "SELFTEST FAIL: 10 missing !docs/** exclusion -> rc=$LAST_RC (want 2)"; fail=1; }

  if [ "$total_cases" -ne "$EXPECTED_CASES" ]; then
    echo "SELFTEST FAILURES: ran $total_cases cases, expected $EXPECTED_CASES - a case was skipped or silently dropped"
    fail=1
  fi

  if [ "$fail" -eq 0 ]; then
    echo "SELFTEST OK"
    exit 0
  else
    exit 1
  fi
fi

# =======================================================================
# Real invocation: check THIS repo's own tree, from wherever this script
# is invoked (ci.yml's hook-selftests job runs with no working-directory,
# i.e. the checkout root - CLAUDE.md's own note on that job).
check_drift "."
rc=$?
if [ "$rc" -eq 0 ]; then
  echo "OK: no docs/** file is both CodeQL-indexed and uncovered by codeql.yml's paths: re-include list"
fi
exit "$rc"
