import type { Harbor } from '../types';

// #834: promoted out of HarborPicker.tsx, which is where #652 first added
// this field. That file's own comment explained why it lived there as a
// local intersection rather than widening the shared `Harbor` type in
// types.ts ("this picker is currently the ONLY consumer of that fact...
// Promote it onto `Harbor` itself if a second consumer ever needs it") — and
// #834 IS that second consumer (PlannerPanel's selected-endpoint row, which
// used to lose the #652 disclosure the instant a known-disconnected harbor
// was picked, #652's whole point). Promoting all the way onto `Harbor` in
// `types.ts` was deliberately declined: `app/sweep/sweepArms.ts` imports
// `defaultBoatSnapshot`/`DEFAULT_SETTINGS` (values) and `LatLon`/`MaskMeta`/
// `PolarTable`/`SailId`/`Settings`/`WindGrid` (types) from `types.ts`, which
// puts that whole FILE in the `app/sweep/` #282 acceptance-harness closure —
// the closure tool marks any hit OWED at file granularity, so widening
// `types.ts` at all would owe a ~31 min/arm-set sweep for a field that is
// presentation-only and never reaches `PlanResult`. This module sits outside
// that closure — nothing under `routing/**`, `lib/mask.ts` or `sweep/**`
// imports it — so a second consumer costs nothing there.
export type HarborWithReachability = Harbor & { knownDisconnected?: boolean };
