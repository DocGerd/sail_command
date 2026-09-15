#!/usr/bin/env bash
HERE="$(cd "$(dirname "$0")" && pwd)"
SC_TEST=probe_plan.test.ts SC_OUTNAME=out_plan.json SC_LOGNAME=run_plan.log bash "$HERE/run.sh" "$1"
