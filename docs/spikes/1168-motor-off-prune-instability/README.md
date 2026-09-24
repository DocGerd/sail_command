# #1168 probe harness

Supporting files for [`../1168-motor-off-prune-instability.md`](../1168-motor-off-prune-instability.md).
The probes ran at `875b420`.

## Files

- `instrumentation.patch` turns `app/src/routing/isochrone.ts` into the
  instrumented copy `scratch1168iso.ts`. The copy exports `DIAG` with these
  fields:
  - `mode`: `prod`, `pareto`, `nodom`, `arrmin`, `retract` or `defer`
  - `div`: the confined prune divisor
  - `track`: whether to record arrivals for attribution
  - `record`: whether to record per-ring counters
- `probe-solve.test.ts` runs bare `solve()` on Flensburg → Bagenkop. Set
  `SC_CONTROL=1` to compare against production `solve()`.
- `probe-plan.test.ts` runs `planRoute()` with `./isochrone` mocked to the
  copy. `SC_ALT` is `none`, `salvage` or `div4`.
- `probe-cost.test.ts` measures search cost on `breeze`, or on
  `light-motorless` with `SC_LM=1`.
- `results/` holds the raw JSONL behind every table in the spike document.

## Run

From the repo root:

1. Apply the patch to a copy:
   `patch -o app/src/routing/scratch1168iso.ts app/src/routing/isochrone.ts < docs/spikes/1168-motor-off-prune-instability/instrumentation.patch`
2. Copy the probe you need into `app/src/routing/`, for example as
   `scratch1168diag.test.ts`.
3. Run it filtered:
   `SC_OUT=<scratchpad>/out.jsonl SC_TWS=2.8,3.0 npm --prefix app run test -- scratch1168diag`

Other environment variables: `SC_RIG`, `SC_SNAP`, `SC_MODE`, `SC_DIV`,
`SC_SALVAGE`, `SC_DUMP`, `SC_IDS`, `SC_RIGS`.

Delete the copied files afterwards. They hardcode a test timeout, which
`timeoutGuard.test.ts` rejects under `app/src/`.

Keep `SC_DUMP` and the attribution modes to short runs. With `track` on,
the arrival lists hold references to every node, and a `breeze`-sized solve
runs out of heap. `probe-cost.test.ts` turns `track` off for that reason.
