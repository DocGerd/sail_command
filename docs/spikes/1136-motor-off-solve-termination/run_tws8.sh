#!/usr/bin/env bash
HERE="$(cd "$(dirname "$0")" && pwd)"
SC_TEST=probe_tws8.test.ts SC_OUTNAME=out_tws8.json SC_LOGNAME=run_tws8.log bash "$HERE/run.sh" "$1"
