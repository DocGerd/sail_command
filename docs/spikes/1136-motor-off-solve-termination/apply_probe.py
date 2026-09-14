#!/usr/bin/env python3
"""#1136 design-pass probe: scratch instrumentation of app/src/routing/isochrone.ts.

Adds an UNBOUNDED solve-level salvage (never two salvage passes in a row, no
MAX_SALVAGES cap) plus a per-ring trace. Behaviour is unchanged while
PROBE.enabled is false. Death counters freeze after the first salvage (spike
hole 2). SCRATCH ONLY: restore the file (git restore) before any commit.

Usage: python3 apply_probe.py <path-to-isochrone.ts>
"""
import sys

path = sys.argv[1]
src = open(path, encoding="utf8").read()


def sub(old: str, new: str) -> None:
    global src
    n = src.count(old)
    if n != 1:
        sys.exit(f"anchor matched {n} times, expected 1: {old!r}")
    src = src.replace(old, new)


sub(
    "const MAX_FRONTIER = 30_000;\n",
    "const MAX_FRONTIER = 30_000;\n"
    "export const PROBE = { enabled: false, ringCap: 4000, trace: [] as Array<Record<string, unknown>> };\n",
)
sub(
    "  let calmDeaths = 0;\n",
    "  let calmDeaths = 0;\n  let _salvages = 0;\n  let _skipDom = false;\n  let _ring = 0;\n",
)
sub(
    "    const byKey = new Map<string, Node>();\n",
    "    const byKey = new Map<string, Node>();\n    let _wouldDom = 0;\n",
)
sub(
    "        if (seen !== undefined && visitedDominates(seen, child)) continue;\n",
    "        if (seen !== undefined && visitedDominates(seen, child)) {\n"
    "          if (!_skipDom) continue;\n"
    "          _wouldDom++;\n"
    "        }\n",
)
sub(
    "      if (produced === 0) {\n",
    "      if (produced === 0 && _salvages === 0) {\n",
)
sub(
    "    let next = [...byKey.values()];\n",
    "    let next = [...byKey.values()];\n"
    "    PROBE.trace.push({ ring: _ring++, pass: _skipDom ? 'S' : 'N', nodes: frontier.length,\n"
    "      next: next.length, minDist, visited: visited.size, wouldDom: _wouldDom,\n"
    "      tH: (tMs - p.departureMs) / 3.6e6, best: best !== null, salvages: _salvages });\n"
    "    if (PROBE.trace.length > PROBE.ringCap) throw new Error('RING_CAP');\n"
    "    const _wasSalvage = _skipDom;\n"
    "    _skipDom = false;\n"
    "    if (PROBE.enabled && next.length === 0 && best === null && !_wasSalvage) {\n"
    "      _skipDom = true;\n"
    "      _salvages++;\n"
    "      continue;\n"
    "    }\n",
)
open(path, "w", encoding="utf8").write(src)
print("probe applied")
