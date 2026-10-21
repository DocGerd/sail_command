# Planning performance (v0.57.0) — design

Status: maintainer-approved 2026-10-21 (recorded on #1790). Goal: lower route-planning solve latency and memory without changing any planned route. Release v0.57.0 the same day; any lane that cannot prove its evidence in time drops to v0.58.0.

## Contract

Every routing change is **byte-identical**: the full #282 sweep (`app/sweep/`) BASE vs HEAD shows identical arm hashes, and each new code path is pinned by a differential test against the code it replaces. Results never depend on thread count, pool size or cache state. Search parameters (frontier cap, step, prune grid) do not change.

## Lanes

### A — solver hot path (P0, owes a sweep)
- `lib/mask.ts`: specialised `segmentNavigable` / `segmentClearanceM` walkers without a per-call closure, beside `walkCells`, which stays (tests and other walkers use it). A 256-entry byte→depth LUT with `byteToDepthM` semantics, cached in `NavMask`, used for a uniform gate and for the requested depth outside the approach gate's bbox (`rowLo..colHi`); cells inside the bbox keep `gateAtCell`. The LUT keeps the `b !== LAND` check ahead of the depth compare, as `cellNavigable` has it.
- `routing/isochrone.ts`, `lib/polar.ts`, `lib/wind.ts`, `lib/geo.ts`: the TWS bracket computed once per node, the wind time bracket cached per distinct `tMs`, per-node trig hoisted with operand order kept. Optional, only if a differential test shows the templated candidate list equals the current one element for element and in order, for every TWS and direct TWA the sweep reaches: candidate headings from a fixed template.
- Evidence: walker visited-cell sequences and returns equal `walkCells`'s (ties, random and real-mask segments, uniform and approach gates); polar, wind and geo values equal the originals under `Object.is`; full sweep byte-identical, BASE first checked against the v0.56.0 head1 run at `3215f063` (arm hashes in the #1778 comment; not in the `recorded-runs.json` ledger); a positive control that moves one arm's hash.

### B — planning feel (P0, sweep-free)
`state/usePlanFlow.ts` skips committing a planning state structurally equal to the last one, so throttled progress messages stop re-rendering `AppShell`. Evidence: zero host re-renders on repeated identical progress; a 1→2 change renders once.

### C — memory (P0, sweep-free)
- `floodFromSeed`: a FIFO ring buffer (64K entries, doubling) replaces a per-gate full-raster `Int32Array` queue. No module-level full-size buffer.
- `buildDepthImageData`: a Uint32 LUT write replaces the per-cell `subarray` copy.
- `DataLayers`: the hatch memo key is recorded at setup, so the `styleEpoch` 0→1 transition no longer repaints.
- Evidence: flood bitset and depth RGBA sha256 equal BASE goldens; e2e counts `putImageData` calls on the depth and hatch canvases after the hatch debounce has elapsed (a positive control at BASE reads 3 with both toggles on), and expects 2 after the change.

### D — two-rig parallel solve (stretch)
Genoa and fock solve concurrently, fanned out inside `runAll` with a barrier per tier (tier choice is plan-level, so per-sail sub-plans are not byte-safe). One ladder expressed as "solve these rigs at this gate" steps, with a synchronous driver (`planRouteWithRecord`, used by the sweep and the routing unit tests, and by the worker when the pool size is 1) and an async dispatcher in the worker layer. Siblings are spawned by the main-thread client and connected to the ladder worker by a `MessageChannel` port; probes and relaxation stay in the ladder worker. Pool `min(2, hardwareConcurrency - 1)`; size 1 is today's path. Cancel and dispose terminate every member; both rigs share one deadline start, and liveness must not let a silent member hide behind a chatty one. The progress readout stays phase-based and may be reworded. Evidence: in-process equivalence test (deep-equal incl. `record`) and the HEAD sweep over the refactored sync driver. The maintainer chose to build it now, overriding spike 1350's tablet-measurement gate (recorded on #1350); it is all-or-nothing with A's sweep and is left out when in doubt.

## Constraints
No backend; no `DB_VERSION` bump; no `types.ts` change or new `Settings` field in B or C; offline keeps working; design floor is tablet ≥820 CSS px.

## Considered and rejected
- **SharedArrayBuffer** (COOP/COEP or a coi service worker): Pages cannot set headers, and a header-injecting service worker risks the Range-206 basemap route and `/uat/` for a ~9.4 MB per-worker saving.
- **WebAssembly**: a different libm breaks byte-identity; `cspMeta()` also omits `'wasm-unsafe-eval'` on purpose, so adopting it would mean widening the CSP.
- **Intra-ring parallelism**: frontier order is the next ring's order (`byKey` insertion), so splitting a ring across workers changes routes unless an ordered merge step restores that order.
- **Bound pruning** (A*-style cut-offs on cost-to-go): changes which nodes survive, so routes move; out of scope for a byte-identical release.
- **Per-sail sub-plans for D**: not byte-safe (above).
- **Memoising polar speed on quantised TWS**: changes values.
- **A module-level full-size flood queue**: keeps tens of MB resident in both the main thread and the worker.
- **Blob workers**: blocked by `worker-src 'self'`.

## Deferred
Filed in Backlog: departure-scan worker pool, solver GC/heap, cheaper harbour flood off the main thread, raster pipeline, MapLibre worker count / `pixelRatio`, `React.lazy`, `listPlans` / export, energy-saving mode (a localStorage toggle, never a `Settings` field), per-cell wind trig cache.
