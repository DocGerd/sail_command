#!/usr/bin/env bash
# Routing-closure classifier for ci.yml's `app-shard` job (#1336). Gates
# ONLY the ~18 `app/src/routing/realmask.repro.*.test.ts` files, which
# measured 88.4% of a shard's time on run 35334122320 and compute something
# new only when the routing closure changes.
#
# Modelled on classify-docs-only.sh (#327/#875) — same fail-closed shape,
# same two-dot diff, same `--selftest` convention. FAIL-CLOSED default is
# RUN (`run_realmask=true`), the opposite polarity of classify-docs-only.sh
# because here doing MORE work is the safe direction. Gates a STEP inside
# `app-shard`, never the job — `app` is a required check under
# `protect-main` and must always report.
#
# Trigger set = closure hits UNION the realmask supplement (files a static
# import walk cannot see are triggers for: the realmask suite itself, its
# fixtures, and everything that changes HOW the suite runs) UNION any
# deleted path under app/ (a file closure.mjs's live filesystem walk can no
# longer see) UNION a drift check (any relative import the realmask suite's
# OWN current files make that lands outside both the closure and the
# supplement — a standing invariant check, independent of the diff).
#
# closure.mjs (`.claude/skills/sweep-closure/closure.mjs`, #729) is the
# derivation tool for "is this path reachable from the #282 sweep roots" —
# see its own header for the method. This script consumes its `files`
# subcommand output ONLY (IN_CLOSURE/NOT_IN_CLOSURE per path, one verdict
# line per input path); it does not alter or depend on `diff`'s output shape.
#
# Production usage (mirrors classify-docs-only.sh):
#   EVENT_NAME=... BASE_SHA=... HEAD_SHA=... \
#   GITHUB_OUTPUT=... GITHUB_STEP_SUMMARY=... \
#   bash -e .github/scripts/classify-realmask.sh
# Offline self-test against synthesized git repos:
#   bash .github/scripts/classify-realmask.sh --selftest
set -euo pipefail

CLOSURE_MJS=".claude/skills/sweep-closure/closure.mjs"

# The realmask supplement: paths that change HOW or WHAT the realmask suite
# computes but that a static import walk from the #282 sweep's own roots
# cannot see (the suite itself is NOT_IN_CLOSURE — verified 2026-09-21 against
# develop@5b1b29b — since nothing in the sweep closure imports a *.test.ts).
# The last three entries exist because a change to the gate or to its own
# oracle must run what it gates.
is_supplement_path() {
  case "$1" in
    app/src/routing/realmask.repro.*) return 0 ;;
    app/src/test/realmaskFixtures.ts) return 0 ;;
    app/vite.config.ts) return 0 ;;
    app/package.json) return 0 ;;
    app/package-lock.json) return 0 ;;
    app/tsconfig*.json) return 0 ;;
    app/src/test/setup.ts) return 0 ;;
    app/src/test/fixtures.ts) return 0 ;;
    app/src/test/timeouts.ts) return 0 ;;
    .github/workflows/ci.yml) return 0 ;;
    .github/scripts/classify-realmask.sh) return 0 ;;
    .claude/skills/sweep-closure/*) return 0 ;;
    *) return 1 ;;
  esac
}

# run_closure_files <path> [<path>…] — the ONE call site both the closure-hit
# check and the drift check use, so a crash/garbage-output failure mode is
# tested once and covers both callers. Sets CLOSURE_FILES_OK (true/false)
# and, on success, CLOSURE_VERDICTS (array, one IN_CLOSURE|NOT_IN_CLOSURE per
# input path, SAME ORDER — matched by POSITION, never by parsing the path
# back out of the line, since a path can legally contain spaces).
run_closure_files() {
  local out
  if ! out="$(node "${CLOSURE_MJS}" files "$@" 2>&1)"; then
    CLOSURE_FILES_OK=false
    return 0
  fi
  mapfile -t CLOSURE_VERDICTS < <(printf '%s\n' "$out" | grep -E '^(IN_CLOSURE|NOT_IN_CLOSURE)' | awk '{print $1}')
  if [ "${#CLOSURE_VERDICTS[@]}" -ne "$#" ]; then
    CLOSURE_FILES_OK=false
    return 0
  fi
  CLOSURE_FILES_OK=true
}

# resolve_realmask_imports — prints repo-relative paths (one per line,
# deduped, sorted) that the realmask suite's OWN current files relatively
# `import` and that resolve to a real file on disk. Best-effort: an
# unresolvable specifier (bare package, or a path that doesn't resolve to an
# existing file under the tried extensions) is silently skipped — this is a
# drift DETECTOR, not a bundler, and skipping only ever narrows what it
# checks, never widens a false trigger.
resolve_realmask_imports() {
  node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const routingDir = path.join(root, 'app/src/routing');
const targets = [];
if (fs.existsSync(routingDir)) {
  for (const f of fs.readdirSync(routingDir)) {
    if (/^realmask\.repro\..*\.test\.ts$/.test(f)) targets.push(path.join(routingDir, f));
  }
}
const fixtures = path.join(root, 'app/src/test/realmaskFixtures.ts');
if (fs.existsSync(fixtures)) targets.push(fixtures);
const EXT = ['.ts', '.tsx', '.mts', '.cts'];
const seen = new Set();
for (const file of targets) {
  const text = fs.readFileSync(file, 'utf8');
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) {
    const base = path.resolve(path.dirname(file), m[1]);
    let hit = null;
    for (const ext of EXT) {
      if (fs.existsSync(base + ext)) { hit = base + ext; break; }
    }
    if (!hit) {
      for (const ext of EXT) {
        const idx = path.join(base, 'index' + ext);
        if (fs.existsSync(idx)) { hit = idx; break; }
      }
    }
    if (hit) seen.add(path.relative(root, hit));
  }
}
for (const r of [...seen].sort()) console.log(r);
NODE
}

# ---- offline self-test ----
if [ "${1:-}" = "--selftest" ]; then
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  REPO_ROOT="$(cd "$(dirname "$SELF")/../.." && pwd)"
  REAL_CLOSURE_MJS="${REPO_ROOT}/.claude/skills/sweep-closure/closure.mjs"
  if [ ! -f "${REAL_CLOSURE_MJS}" ]; then
    echo "SELFTEST FAILURES: ${REAL_CLOSURE_MJS} not found — cannot build a synthesized repo without the real tool" >&2
    exit 1
  fi
  PASS=0; FAIL=0

  # A curated PATH that resolves every common shell tool but never `node` —
  # used by the "node unavailable" fail-closed case. Symlink farm rather
  # than a bare directory restriction: node is frequently installed outside
  # /usr/bin (nvm, etc.), so simply pointing PATH at /usr/bin would pass
  # that case by accident rather than by construction.
  make_path_without_node() {
    local d
    d="$(mktemp -d)"
    local dir f name
    for dir in /usr/local/bin /usr/bin /bin /usr/local/sbin /usr/sbin /sbin; do
      [ -d "$dir" ] || continue
      for f in "$dir"/*; do
        [ -e "$f" ] || continue
        name="$(basename "$f")"
        case "$name" in
          node | nodejs) continue ;;
        esac
        [ -e "$d/$name" ] || ln -sf "$f" "$d/$name" 2>/dev/null || true
      done
    done
    printf '%s\n' "$d"
  }
  NO_NODE_PATH="$(make_path_without_node)"

  mkrepo() {
    # Builds a MINIMAL synthesized repo carrying the real sweep-closure
    # import edge (app/sweep/sweepArms.ts -> app/src/routing/planRoute.ts,
    # matching the real repo's ROOTS -> planRoute.ts closure membership,
    # confirmed 2026-09-21 against develop@5b1b29b) plus realmask files with
    # clean imports, plus two out-of-closure controls
    # (harborReachability.ts / boatSettings.ts, the issue's own negative
    # control), plus a COPY of the real closure.mjs.
    local d
    d="$(mktemp -d)"
    cd "$d" || exit 1
    git init -q -b main . >/dev/null 2>&1
    git config user.email t@t
    git config user.name t
    git config commit.gpgsign false
    git config core.quotePath true
    mkdir -p app/sweep app/src/routing app/src/test app/src/lib app/src/data \
      .claude/skills/sweep-closure .github/workflows .github/scripts docs
    if [ "${1:-}" != "--no-closure" ]; then
      cp "${REAL_CLOSURE_MJS}" .claude/skills/sweep-closure/closure.mjs
    fi
    echo 'export {};' > app/sweep/vitest.config.ts
    cat > app/sweep/sweepArms.ts <<'EOF'
import { planRoute } from '../src/routing/planRoute';
export const armCount = planRoute;
EOF
    cat > app/src/routing/planRoute.ts <<'EOF'
export function planRoute() {
  return null;
}
EOF
    for name in confinedDominance depthComfort forcedSegment horizonRelaxation; do
      cat > "app/src/routing/realmask.repro.${name}.test.ts" <<EOF
import { expect, it } from 'vitest';
import { mask } from '../test/realmaskFixtures';
it('${name}', () => { expect(mask).toBeDefined(); });
EOF
    done
    cat > app/src/test/realmaskFixtures.ts <<'EOF'
export const mask = { cells: 0 };
EOF
    echo 'export const uniformWindGrid = 0;' > app/src/test/fixtures.ts
    echo 'export const SOLVER_TEST_TIMEOUT_MS = 1;' > app/src/test/timeouts.ts
    echo 'import "./fixtures";' > app/src/test/setup.ts
    echo 'export function harborReachability() { return true; }' > app/src/lib/harborReachability.ts
    echo 'export const boatSettings = {};' > app/src/data/boatSettings.ts
    echo '{}' > app/package.json
    echo '{}' > app/package-lock.json
    echo '{}' > app/tsconfig.json
    echo 'export default {};' > app/vite.config.ts
    echo 'name: CI' > .github/workflows/ci.yml
    echo base > docs/seed.md
    git add -A >/dev/null
    git commit -qm base >/dev/null
    echo "$d"
  }

  commit_with() {
    git add -A >/dev/null 2>&1
    git commit -qm "$1" >/dev/null 2>&1
    git rev-parse HEAD
  }

  # run <label> <expected run_realmask> <event> <base> <head> [PATH override]
  run() {
    local label="$1" expect="$2" ev="$3" b="$4" h="$5" pathoverride="${6:-}"
    local out sum log rc got reason
    out="$(mktemp)"
    sum="$(mktemp)"
    log="$(mktemp)"
    set +e
    if [ -n "$pathoverride" ]; then
      PATH="$pathoverride" EVENT_NAME="$ev" BASE_SHA="$b" HEAD_SHA="$h" \
        GITHUB_OUTPUT="$out" GITHUB_STEP_SUMMARY="$sum" \
        bash -e "$SELF" >"$log" 2>&1
    else
      EVENT_NAME="$ev" BASE_SHA="$b" HEAD_SHA="$h" \
        GITHUB_OUTPUT="$out" GITHUB_STEP_SUMMARY="$sum" \
        bash -e "$SELF" >"$log" 2>&1
    fi
    rc=$?
    set -e
    got="$(grep -o 'run_realmask=[a-z]*' "$out" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
    [ -z "$got" ] && got="<none:step-exit-$rc>"
    reason="$(grep -o 'reason_realmask=.*' "$log" | tail -1 || true)"
    if [ "$got" = "$expect" ]; then
      printf '  OK   %-58s -> run_realmask=%-8s (%s)\n' "$label" "$got" "${reason:-step failed rc=$rc}"
      PASS=$((PASS + 1))
    else
      printf '  XX   %-58s -> run_realmask=%-8s expected=%s  (%s)\n' "$label" "$got" "$expect" "${reason:-step failed rc=$rc}"
      FAIL=$((FAIL + 1))
    fi
    rm -f "$out" "$sum" "$log"
  }

  EXPECTED_CASES=29
  echo "=== classify-realmask.sh: ${EXPECTED_CASES} adversarial cases (bash -e) ==="

  # ---------- 1 non-PR event ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; H=$(commit_with docs)
  run "1  push event" true push "$B" "$H"

  # ---------- 2 empty diff ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  run "2  empty diff (base == head)" true pull_request "$B" "$B"

  # ---------- 3 unreachable base ----------
  r=$(mkrepo); cd "$r"; B=0000000000000000000000000000000000000001; H=$(git rev-parse HEAD)
  run "3  bogus base sha (unreachable)" true pull_request "$B" "$H"

  # ---------- 3b unreachable head ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  run "3b bogus head sha (unreachable)" true pull_request "$B" 0000000000000000000000000000000000000002

  # ---------- 3c base sha is a tree, not a commit ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD^{tree}); H=$(git rev-parse HEAD)
  run "3c base sha is a tree object" true pull_request "$B" "$H"

  # ---------- 4 shallow clone ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; H=$(commit_with docs2)
  shallow=$(mktemp -d)
  git clone -q --depth 1 "file://$r" "$shallow" >/dev/null 2>&1
  cd "$shallow"
  run "4  genuinely shallow clone (base object missing)" true pull_request "$B" "$H"

  # ---------- 5 base tree object missing (git diff fails) ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; H=$(commit_with docs3)
  TREE=$(git rev-parse "$B^{tree}")
  rm -f ".git/objects/${TREE:0:2}/${TREE:2}"
  run "5  base tree object missing (git diff fails)" true pull_request "$B" "$H"

  # ---------- 6 docs-only diff ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; H=$(commit_with docs4)
  run "6  docs-only diff" false pull_request "$B" "$H"

  # ---------- 7/8 out-of-closure controls (the issue's own negative control) ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> app/src/lib/harborReachability.ts; H=$(commit_with harborReach)
  run "7  out-of-closure: harborReachability.ts" false pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> app/src/data/boatSettings.ts; H=$(commit_with boatSettings)
  run "8  out-of-closure: boatSettings.ts" false pull_request "$B" "$H"

  # ---------- 9 closure hit ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> app/src/routing/planRoute.ts; H=$(commit_with planroute)
  run "9  closure hit: planRoute.ts (import walk)" true pull_request "$B" "$H"

  # ---------- 10-21 supplement entries ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> app/src/routing/realmask.repro.confinedDominance.test.ts; H=$(commit_with supp1)
  run "10 supplement: realmask.repro.*.test.ts" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> app/src/test/realmaskFixtures.ts; H=$(commit_with supp2)
  run "11 supplement: realmaskFixtures.ts" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> app/vite.config.ts; H=$(commit_with supp3)
  run "12 supplement: app/vite.config.ts" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> app/package.json; H=$(commit_with supp4)
  run "13 supplement: app/package.json" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> app/package-lock.json; H=$(commit_with supp5)
  run "14 supplement: app/package-lock.json" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> app/tsconfig.json; H=$(commit_with supp6)
  run "15 supplement: app/tsconfig.json" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> app/src/test/setup.ts; H=$(commit_with supp7)
  run "16 supplement: app/src/test/setup.ts" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> app/src/test/fixtures.ts; H=$(commit_with supp8)
  run "17 supplement: app/src/test/fixtures.ts" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> app/src/test/timeouts.ts; H=$(commit_with supp9)
  run "18 supplement: app/src/test/timeouts.ts" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> .github/workflows/ci.yml; H=$(commit_with supp10)
  run "19 supplement: .github/workflows/ci.yml" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> .github/scripts/classify-realmask.sh; H=$(commit_with supp11)
  run "20 supplement: .github/scripts/classify-realmask.sh" true pull_request "$B" "$H"

  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> .claude/skills/sweep-closure/closure.mjs; H=$(commit_with supp12)
  run "21 supplement: .claude/skills/sweep-closure/closure.mjs" true pull_request "$B" "$H"

  # ---------- 22 deletion under app/ ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  git rm -q app/src/lib/harborReachability.ts; H=$(commit_with delfile)
  run "22 deletion under app/ (closure.mjs can't see it's gone)" true pull_request "$B" "$H"

  # ---------- 23 drift: realmask imports a non-closure/non-supplement module ----------
  r=$(mkrepo); cd "$r"
  echo 'export const rogue = 1;' > app/src/lib/rogueModule.ts
  cat > app/src/routing/realmask.repro.rogue.test.ts <<'EOF'
import { it, expect } from 'vitest';
import { rogue } from '../lib/rogueModule';
it('rogue', () => { expect(rogue).toBe(1); });
EOF
  git add -A >/dev/null; git commit -qm rogue >/dev/null
  B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; H=$(commit_with unrelated-docs-change)
  run "23 drift: realmask imports outside closure+supplement" true pull_request "$B" "$H"

  # ---------- 24 node unavailable ----------
  r=$(mkrepo); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; H=$(commit_with docs5)
  run "24 node unavailable" true pull_request "$B" "$H" "$NO_NODE_PATH"

  # ---------- 25 closure.mjs missing (absent at BOTH base and head, so the
  # diff itself never touches .claude/skills/sweep-closure/ — a diff that
  # DELETED it would hit the supplement match instead, testing the wrong
  # thing) ----------
  r=$(mkrepo --no-closure); cd "$r"; B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; H=$(commit_with docs6)
  run "25 closure.mjs missing" true pull_request "$B" "$H"

  # ---------- 26 closure.mjs crashes ----------
  r=$(mkrepo); cd "$r"
  printf '#!/usr/bin/env node\nprocess.exit(3);\n' > .claude/skills/sweep-closure/closure.mjs
  git add -A >/dev/null; git commit -qm stubcrash >/dev/null
  B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; H=$(commit_with docs7)
  run "26 closure.mjs exits non-zero" true pull_request "$B" "$H"

  # ---------- 27 closure.mjs prints unparseable garbage ----------
  r=$(mkrepo); cd "$r"
  printf '#!/usr/bin/env node\nconsole.log("hello world");\n' > .claude/skills/sweep-closure/closure.mjs
  git add -A >/dev/null; git commit -qm stubgarbage >/dev/null
  B=$(git rev-parse HEAD)
  echo x >> docs/seed.md; H=$(commit_with docs8)
  run "27 closure.mjs prints unparseable output" true pull_request "$B" "$H"

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
BASE_SHA="${BASE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/null}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ -n "${GITHUB_ACTIONS:-}" ] && [ "$GITHUB_OUTPUT" = /dev/null ]; then
  echo "::error::GITHUB_OUTPUT is unset under GitHub Actions - refusing to silently write the realmask decision to /dev/null (that would read as 'skip' to the app-shard step's if: gate)" >&2
  exit 1
fi

run_realmask=true
reason_realmask="not a pull_request event"
changed=""

if [ "${EVENT_NAME}" = "pull_request" ]; then
  base_sha="${BASE_SHA}"
  head_sha="${HEAD_SHA}"

  if git cat-file -e "${base_sha}^{commit}" 2>/dev/null \
    && git cat-file -e "${head_sha}^{commit}" 2>/dev/null; then

    # Two-dot diff (not three-dot / --merge-base): needs no merge-base, so
    # it survives a shallow/partial object store, and a stale or over-broad
    # base only ever ADDS files to the changed set — the fail-closed
    # direction. Same choice classify-docs-only.sh makes, for the same
    # reason (see that script's header).
    if changed="$(git -c core.quotePath=false diff --no-renames --name-only "${base_sha}" "${head_sha}")"; then
      if [ -z "${changed}" ]; then
        run_realmask=true
        reason_realmask="empty changed-file list"
      else
        run_realmask=false
        reason_realmask="no changed path is in the routing closure or the realmask supplement"

        # --- deleted paths under app/: closure.mjs's live filesystem walk
        # cannot see a file that no longer exists, so a deletion under app/
        # is a fail-closed trigger on its own (deliberately WHOLE-directory,
        # same "over-report, never under-report" shape as closure.mjs's own
        # PATH_PREFIXES). ---
        if deleted="$(git -c core.quotePath=false diff --no-renames --name-only --diff-filter=D "${base_sha}" "${head_sha}")"; then
          while IFS= read -r f; do
            [ -z "$f" ] && continue
            case "$f" in
              app/*)
                if [ "${run_realmask}" != "true" ]; then
                  run_realmask=true
                  reason_realmask="deleted path under app/: ${f}"
                fi
                ;;
            esac
          done <<< "${deleted}"
        else
          run_realmask=true
          reason_realmask="git diff (deletions) failed"
        fi

        # --- supplement match on the changed set ---
        if [ "${run_realmask}" != "true" ]; then
          while IFS= read -r f; do
            [ -z "$f" ] && continue
            if is_supplement_path "$f"; then
              if [ "${run_realmask}" != "true" ]; then
                run_realmask=true
                reason_realmask="supplement path: ${f}"
              fi
            fi
          done <<< "${changed}"
        fi

        # --- tooling check (shared by the closure-hit check and the drift
        # check below) ---
        tooling_ok=true
        if [ "${run_realmask}" != "true" ]; then
          if ! command -v node >/dev/null 2>&1; then
            tooling_ok=false
            run_realmask=true
            reason_realmask="node unavailable for the routing closure check"
          elif [ ! -f "${CLOSURE_MJS}" ]; then
            tooling_ok=false
            run_realmask=true
            reason_realmask="closure.mjs missing at ${CLOSURE_MJS}"
          fi
        fi

        # --- closure-hit check: any changed path reachable from the #282
        # sweep roots (`closure.mjs files`, never `diff`, so the tool's
        # sweep-only draftProvenance exemption is not silently inherited). ---
        if [ "${run_realmask}" != "true" ] && [ "${tooling_ok}" = "true" ]; then
          mapfile -t changed_arr <<< "${changed}"
          if run_closure_files "${changed_arr[@]}" && [ "${CLOSURE_FILES_OK}" = "true" ]; then
            for i in "${!changed_arr[@]}"; do
              if [ "${CLOSURE_VERDICTS[$i]}" = "IN_CLOSURE" ]; then
                run_realmask=true
                reason_realmask="routing closure hit: ${changed_arr[$i]}"
                break
              fi
            done
          else
            run_realmask=true
            reason_realmask="closure.mjs errored or gave unparseable output over the diff"
          fi
        fi

        # --- drift check: does the realmask suite currently import
        # anything outside BOTH the closure and the supplement? Independent
        # of the diff — a standing invariant on the suite's own dependency
        # set, so a future import from a non-closure module fails closed on
        # its own even on an otherwise-unrelated PR. ---
        if [ "${run_realmask}" != "true" ] && [ "${tooling_ok}" = "true" ]; then
          mapfile -t realmask_imports < <(resolve_realmask_imports)
          if [ "${#realmask_imports[@]}" -gt 0 ]; then
            if run_closure_files "${realmask_imports[@]}" && [ "${CLOSURE_FILES_OK}" = "true" ]; then
              for i in "${!realmask_imports[@]}"; do
                if [ "${CLOSURE_VERDICTS[$i]}" = "NOT_IN_CLOSURE" ] && ! is_supplement_path "${realmask_imports[$i]}"; then
                  run_realmask=true
                  reason_realmask="drift: realmask imports ${realmask_imports[$i]}, outside the routing closure and the supplement"
                  echo "::warning::${reason_realmask}"
                  break
                fi
              done
            else
              run_realmask=true
              reason_realmask="drift check: closure.mjs errored or gave unparseable output over realmask's own imports"
            fi
          fi
        fi
      fi
    else
      diff_status=$?
      run_realmask=true
      reason_realmask="git diff failed (exit ${diff_status})"
    fi
  else
    run_realmask=true
    reason_realmask="base or head commit unreachable (shallow clone / merge-queue / force-push)"
  fi
fi

echo "changed paths:"
printf '%s\n' "${changed:-<none>}"
echo "run_realmask=${run_realmask} reason_realmask=${reason_realmask}"

echo "run_realmask=${run_realmask}" >> "$GITHUB_OUTPUT"
{
  echo "### realmask classification (#1336)"
  echo "- run_realmask: **${run_realmask}**"
  echo "- reason: ${reason_realmask}"
} >> "$GITHUB_STEP_SUMMARY"
