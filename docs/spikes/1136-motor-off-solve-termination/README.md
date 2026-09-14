# #1136 design-pass probe (spike §11)

Throwaway measurement behind §11 of `../1136-motor-off-solve-termination.md`.
Run 2026-09-14 at merge-base `d3e3769`. Nothing here is imported by the app,
the test suite or the sweep.

- `apply_probe.py <isochrone.ts>` — scratch-instruments `solve()`: UNBOUNDED
  salvage (no cap; never two salvage passes in a row), death counters frozen
  after the first salvage, per-ring trace. Inert while `PROBE.enabled` is
  false. Restore the file (`git restore`) before committing anything.
- `probe.test.ts` — sets A (spike §1 config), B (oracle-disconnected
  Flensburg→Marstal at 3.0 m) and C (Flensburg→Marstal on the relaxed gate,
  plan fidelity: `performanceFactor` 0.9, comfort 5 / none, both rigs).
  `probe_tws8.test.ts` re-runs A's TWS 8 with a 20 000-ring cap.
- `run.sh <worktree>` / `run_tws8.sh <worktree>` — needs a `node_modules`
  link to `<repo>/app/node_modules` beside these files.
- `analyze.py <out.json>` — replays candidate stopping rules over a trace.
  Exact: a stopping rule only ends a run at a salvage trigger, so the
  trajectory before it is the unbounded one.
- `results.txt` — `analyze.py` output for both runs. The `ms` figures are
  bare `solve()` under vitest on one WSL2 dev machine, load unknown: an order
  of magnitude, never a browser-worker figure.
