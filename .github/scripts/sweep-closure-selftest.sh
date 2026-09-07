#!/usr/bin/env bash
# #836: nothing in CI ever ran `.claude/skills/sweep-closure/closure.mjs`'s
# own selftest, so the tool that decides whether a diff owes a #282 sweep
# was itself unguarded -- and it already returned a wrong safety verdict
# once (the version first submitted with PR #824 reported 8 of 8 genuine
# sweep inputs, including `mask.bin`, as NOT_IN_CLOSURE; caught only because
# a reviewer built an independent battery, not by any CI signal).
#
# `hook-selftests` (ci.yml) discovers only top-level `*.sh` files under
# `.claude/hooks/` and `.github/scripts/` (`-maxdepth 1`, deliberately
# non-recursive per that job's own comment) and invokes each one as
# `timeout 60 bash "$f" --selftest </dev/null`, run from the checkout root
# with no `working-directory` override, requiring BOTH exit 0 AND a literal
# `SELFTEST OK` line on stdout. `closure.mjs` is a `.mjs` file outside that
# glob, and its selftest is a POSITIONAL `selftest` subcommand rather than a
# `--selftest` flag -- this script is the adapter between the two
# contracts, so closure.mjs's own selftest now rides the same CI gate every
# other `--selftest`-bearing hook already does. Adding this ONE file needs
# zero changes to `ci.yml` itself, by design (issue #836).
#
# BLOCKING guard, so it must fail CLOSED (per CLAUDE.md's guard-asymmetry
# rule): every precondition below is a hard failure, never a silent no-op.
# The literal `SELFTEST OK` marker is forwarded ONLY after
# `node closure.mjs selftest` has itself printed that exact line AND
# exited 0 -- this script never emits the marker on its own authority, so a
# selftest that hangs, crashes, or silently produces no output is
# indistinguishable from a genuine failure, never from a pass.

set -uo pipefail

if [[ "${1:-}" != "--selftest" ]]; then
  echo "usage: $0 --selftest" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "::error::node is not on PATH -- cannot run closure.mjs's selftest" >&2
  exit 1
fi

# Resolve every path from this script's OWN location, never from the
# caller's cwd (this job runs with no `working-directory`, but nothing here
# should depend on that holding forever -- see ci.yml's own comment on why
# a `working-directory` addition to this job is a live landmine).
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd) || {
  echo "::error::could not resolve this script's own directory" >&2
  exit 1
}
repo_root=$(cd -- "$script_dir/../.." >/dev/null 2>&1 && pwd) || {
  echo "::error::could not resolve the repo root from $script_dir" >&2
  exit 1
}

closure_path="$repo_root/.claude/skills/sweep-closure/closure.mjs"
if [[ ! -f "$closure_path" ]]; then
  echo "::error::expected $closure_path is missing or moved -- sweep-closure's selftest cannot run" >&2
  exit 1
fi

out=$(mktemp)
trap 'rm -f "$out"' EXIT

if (cd "$repo_root" && node "$closure_path" selftest) >"$out" 2>&1; then
  rc=0
else
  rc=$?
fi

cat "$out"

# Same "exit 0 alone is not proof" reasoning as `hook-selftests` itself
# applies here one layer down: a `closure.mjs` that silently no-ops on an
# unrecognised subcommand, or whose selftest hangs and gets killed, or that
# crashes before printing anything, must all read as failures -- never as a
# pass that merely lacks output.
if [[ "$rc" -eq 0 ]] && grep -q '^SELFTEST OK$' "$out"; then
  echo "SELFTEST OK"
  exit 0
fi

echo "::error::closure.mjs selftest FAILED (exit $rc, or missing the SELFTEST OK marker) -- see the log above" >&2
exit 1
