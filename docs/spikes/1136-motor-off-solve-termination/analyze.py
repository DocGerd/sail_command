#!/usr/bin/env python3
"""Offline evaluation of candidate salvage stopping rules over probe traces.

A stopping rule only ever ENDS a salvaged solve at a salvage trigger, so the
trajectory up to that trigger is identical to the unbounded run: replaying the
unbounded trace and stopping at the first refused salvage is exact.
"""
import json
import sys

with open(sys.argv[1]) as fh:
    runs = json.load(fh)


def events(trace):
    """Per salvage: (ring, visited size at trigger, best-ever minDist up to trigger)."""
    ev, best = [], float("inf")
    for r in trace:
        best = min(best, r["minDist"])
        if r["pass"] == "S":
            ev.append((r["ring"], r["visited"], best))
    return ev


def rule_new_cells(ev):
    # allow salvage k only if visited grew since salvage k-1 (k=0 always allowed)
    for k in range(1, len(ev)):
        if ev[k][1] <= ev[k - 1][1]:
            return k
    return None


def rule_no_progress(ev, K, eps=0.05):
    # stop at the first salvage after K consecutive salvages with no best-minDist gain > eps
    stale = 0
    for k in range(1, len(ev)):
        stale = stale + 1 if ev[k - 1][2] - ev[k][2] <= eps else 0
        if stale >= K:
            return k
    return None


for r in runs:
    if "trace" not in r:
        print(r)
        continue
    ev = events(r["trace"])
    line = (f"{r['label']}: {r['status']} {r['cause']} eta={r['etaH']} rings={r['rings']} "
            f"salv={r['salvages']} ms={r['ms']:.0f}")
    print(line)
    if not ev:
        continue
    last = r["trace"][-1]
    print(f"   final tH={last['tH']:.2f} visited={last['visited']} bestMinDist={min(t['minDist'] for t in r['trace']):.2f}")
    print(f"   visited at salvages: {[e[1] for e in ev][:40]}")
    print(f"   bestMinDist at salvages: {[round(e[2], 2) for e in ev][:40]}")
    print(f"   rule new-cells stops at salvage #{rule_new_cells(ev)} of {len(ev)}")
    run = longest = 0
    for a, b in zip(ev, ev[1:]):
        run = run + 1 if b[1] <= a[1] else 0
        longest = max(longest, run)
    print(f"   longest run of consecutive salvages claiming no new prune cell: {longest}")
    for K in (2, 4, 8, 16):
        print(f"   rule no-progress K={K} stops at salvage #{rule_no_progress(ev, K)}")
