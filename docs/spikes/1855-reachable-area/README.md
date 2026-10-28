# Supporting files for `../1855-reachable-area.md`

- `grounding.md` — the spike's grounding: issue, #1854 constraints, solver facts and the probe summary (M1–M5). Written at develop `32f67af0`.
- `reach.probe.test.ts`, `vitest.config.ts` — the real-data probe. `reach()` re-implements `solve()`'s ring loop without the destination terms. The config sets `root` to this directory, so `app/`'s vitest (`include: ['src/**/*.test.{ts,tsx}']`) never collects it. It ran from a detached worktree at `32f67af0` with a `node_modules` symlink to `app/node_modules` (`grounding.md` §4 Method). `SC_PROBE_ONLY=<ids>` selects configs; `SC_PROBE_OUT` sets the output path.
- `results.json` — the probe's output, one key per config plus `m3` and `fidelity`. Wall times are one thread on one loaded WSL machine.
- `design-D1.md`, `design-D2.md`, `design-D3.md` — the three candidate designs, as judged.
- `judges.json` — the two judges' scores, rankings and grafts. Judge 2's `graftsFromRunnersUp` reached the spike writer truncated after "(g) add reach.ts to classify-realm"; the rest was not recovered.
- `critique.json` — the critique's 27 findings (C1–C27).
- `revision-log.md` — how each finding was disposed of.

The designs and `grounding.md` cite a scratch directory (`/tmp/s1855/`): its `grounding.md` and `probe/` files are the copies here. They are kept as written.
