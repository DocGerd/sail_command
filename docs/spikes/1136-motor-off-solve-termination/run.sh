#!/usr/bin/env bash
# Usage: run.sh <worktree-root>
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
export SC_WT="$1"
export SC_OUT="$HERE/${SC_OUTNAME:-out.json}"
timeout -k 30 5400 ./node_modules/.bin/vitest run --config vitest.config.ts --reporter=verbose </dev/null >"$HERE/${SC_LOGNAME:-run.log}" 2>&1
echo "exit=$?" >>"$HERE/${SC_LOGNAME:-run.log}"
