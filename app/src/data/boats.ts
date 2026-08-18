export type PolarTier = 'certificate' | 'modelled' | 'estimated';

export interface PolarProvenance {
  readonly tier: PolarTier;
  readonly note: string;
}

export interface SailDef {
  readonly id: string;
  readonly label: string; // proper noun / size — NOT an i18n key (spec F.3)
  readonly polarAsset: string;
  readonly polarProvenance: PolarProvenance;
}

/**
 * #54 spec N.2. Which keel the `draftM` above assumes, and how firmly.
 *
 * REQUIRED on every boat, including the reference one — an optional field here
 * would let the next fleet entry ship with the disclosure simply absent, which
 * is the failure this record exists to prevent.
 *
 * `hullVerified: false` means the figure is the model's listed keel from the
 * builder's or operator's published specification and was NOT checked against
 * the individual hull's papers. That is an accepted cost of shipping the fleet
 * (spec N.2), not a satisfied condition, and spec M.1's re-verification rule
 * still stands over it.
 *
 * WHY IT MUST REACH THE UI. A wrong keel is invisible in every artifact the app
 * renders: the route, the ETA, the depth banner and the shallow chips all look
 * exactly the same whether the draft is right or 0.45 m too shallow. Only the
 * disclosure makes it checkable by someone who can actually see the boat — so
 * spec N.2 requires this on the picker beside the provenance tier, never buried
 * in a JSON field. The hazard is measured, not hypothetical: EASY GO! and
 * SPEEDY GO! are the same model and were briefed as one 2.10 m pair, and EASY
 * GO! turns out to be the 2.55 m deep-keel hull. Shipping it on the model
 * default would have understated a real vessel's draft by 0.45 m and handed it
 * a gate 0.5 m too shallow, in the one field everything in spec C hangs on.
 * That vessel is deferred (spec N.7) rather than routed on an assumed hull.
 *
 * NOT PERSISTED, and that is a known gap rather than an oversight (spec N.5):
 * `BoatSnapshot` carries `draftM` but no draft provenance, so a re-opened saved
 * plan renders its draft with no sign the keel was assumed. The statement is
 * plan-time and picker-time only for now; it closes by adding a persisted field
 * the first time a hull-verified draft ships alongside an assumed one.
 */
export interface DraftProvenance {
  /** The keel variant `draftM` assumes, e.g. 'standard fin-and-bulb'. */
  readonly keel: string;
  /** True only when the figure came from THIS hull's own papers. */
  readonly hullVerified: boolean;
  /** Where the figure came from, and what it does and does not establish. */
  readonly note: string;
}

export interface BoatDef {
  readonly id: string;
  readonly name: string;
  /**
   * SAFETY-CRITICAL. Drives the derived default gate (spec C.3) AND the #53
   * relaxation floor (spec C.4a).
   *
   * State the literal. NEVER reference the old BOAT_DRAFT_M: the Salona 44's
   * 2.10 m draft coincides numerically with the Salona 45's constant, and a
   * shared reference means a later change to one silently moves the other
   * (spec C.5, "The Salona 44 trap").
   */
  readonly draftM: number;
  /** #54 spec N.2. Which keel `draftM` assumes, and whether it was hull-verified. */
  readonly draftProvenance: DraftProvenance;
  readonly motorSpeedKn: number;
  readonly maneuverPenaltyS: number;
  readonly sails: readonly SailDef[];
}

// Deliberately NOT per-boat, so nobody "completes" this later (spec F.2):
//  - motorThresholdKn (2.5): a seaworthiness floor about WATER, not the hull.
//  - depthComfortMarginM / sailPreferenceKn / performanceFactor / motorEnabled:
//    user preferences, not boat properties.
//  - displacement: nothing in the router consumes it; present in the type it
//    invites a fake physical model on top of an estimated polar.

// Layering note: this module imports nothing from types.ts, and types.ts
// imports PolarProvenance from here (added in Task 11) — one direction only,
// no cycle. That is safe only because the chain types.ts -> lib/boatDepth.ts ->
// lib/mask.ts (mask.ts, geo.ts and depthGate.ts) imports from types.ts with
// `import type`, and tsconfig.app.json's verbatimModuleSyntax: true
// guarantees those type-only imports are erased at build time — DEFAULT_SETTINGS
// is an eagerly-evaluated top-level const, so a future VALUE import from
// types.ts into any of those three would become a real TDZ hazard that
// typecheck cannot see.

// These two notes are the app-side copy of pipeline/polars-source.json's
// per-sail `provenance.note`, which is what build_polars.mjs bakes into each
// polar asset's `source` field. No compiler spans JSON and TypeScript, so
// app/src/test/polarProvenance.test.ts is what keeps the three honest: it
// reads the pipeline source AND the shipped assets and compares them to this
// catalogue. Task 12 relocated the pipeline copy out of build_polars.mjs's
// SOURCE_NOTES into polars-source.json; the count is unchanged at three.
const GENOA_NOTE =
  'Estimate derived from ORC International 2026 certificate Salona 45 "Miles Ahead" (AUT 035/26) — ' +
  'the ~135% genoa table is a modeled overlay on the certificate configuration (+3–5% light-air ' +
  'upwind/reach, 0 at 14–20 kn, −2% upwind at 25 kn); downwind corrected to white sails via 23-boat ' +
  'ORC non-spinnaker ratio study. ' +
  'Flat-water racing VPP — tune with the performance factor. NOT race-calibrated.';
const FOCK_NOTE =
  'Estimate derived from ORC International 2026 certificate Salona 45 "Miles Ahead" (AUT 035/26) — ' +
  'the measured ~110% jib makes this effectively the certificate configuration; downwind corrected to ' +
  'white sails via 23-boat ORC non-spinnaker ratio study. ' +
  'Flat-water racing VPP — tune with the performance factor. NOT race-calibrated.';

export const BOATS = [
  {
    id: 'salona-45',
    // Release-1 carve-out (spec J OQ-4): the Salona 45 is the app's existing
    // reference boat, not a Skipperteam fleet vessel, so this entry is
    // model-level and carries no vessel name. The per-vessel rule governs
    // fleet boats.
    name: 'Salona 45',
    draftM: 2.1,
    draftProvenance: {
      keel: 'standard',
      // The app's own long-standing reference figure, not a fleet-research
      // input: 2.1 m is the draft the whole of #455's below-hull guarantee was
      // derived against (TOLERANCE_M = 0.9 was CHOSEN so that 3.0 - 0.9 lands
      // exactly on it). Marked hull-verified: this is a model-level reference
      // entry with no individual vessel behind it, so there is no hull whose
      // papers could disagree — unlike the two fleet entries below.
      hullVerified: true,
      note:
        "The app's reference boat, model-level with no individual vessel behind it (spec J " +
        'OQ-4 carve-out). 2.1 m is the draft the #455 mask-tolerance guarantee is derived ' +
        'against.',
    },
    motorSpeedKn: 6.5,
    maneuverPenaltyS: 45,
    sails: [
      {
        id: 'genoa',
        label: 'Genoa 135 %',
        polarAsset: 'data/polars/salona-45-genoa.json',
        polarProvenance: { tier: 'modelled', note: GENOA_NOTE },
      },
      {
        id: 'fock',
        label: 'Jib 110 %',
        polarAsset: 'data/polars/salona-45-fock.json',
        polarProvenance: { tier: 'certificate', note: FOCK_NOTE },
      },
    ],
  },
] as const satisfies readonly BoatDef[];

export type BoatId = (typeof BOATS)[number]['id'];
export type SailId = (typeof BOATS)[number]['sails'][number]['id'];

export const DEFAULT_BOAT_ID: BoatId = 'salona-45';

export function boatById(id: BoatId): BoatDef {
  const b = BOATS.find((x) => x.id === id);
  if (!b) throw new Error(`unknown boat id: ${id}`);
  return b;
}

/**
 * #54 spec F.3: the identity of a polar table across the worker boundary.
 * `init` carries EVERY catalogue polar in one map keyed this way and each
 * `plan` names the keys to run, preserving "init once, plan many" at zero
 * per-plan cost.
 *
 * The boat id is part of the key because sail ids are NOT unique across boats
 * — two boats may each carry a `genoa`, and they are different tables.
 *
 * Both parameters are `string`, not `BoatId`/`SailId`: `BoatDef.id` and
 * `SailDef.id` are declared `string` (SailDef is the general per-boat shape,
 * not narrowed to any one boat's literal ids), and the solver's own call site
 * holds a `BoatDef` — so a narrowed parameter would make PlanDeps.boat
 * uncallable here without a cast that lies about non-catalogue boats.
 */
export function polarKey(boatId: string, sailId: string): string {
  return `${boatId}/${sailId}`;
}

// #54: the default boat's full sail set, in catalogue order. Two kinds of
// call site: App.tsx's handlePlan, the one production constructor with no
// prior plan to inherit the solve order from; and the absent-sailIds
// backfill in lib/recalc.ts, state/replan.ts and state/reroute.ts.
//
// Task 11 landed PlanRequest.boat and deliberately left this in place: the
// per-boat lookup it was expected to become needs a SELECTED boat, and boat
// selection is not user-facing in release 1 (spec §B). Today there is exactly
// one boat, so this and boatById(DEFAULT_BOAT_ID).sails name the same set.
// Cast is safe: boatById(DEFAULT_BOAT_ID) always resolves to a real entry of
// the const `BOATS` array below, whose sail ids ARE the SailId union by
// construction — `BoatDef.sails[].id` is typed as plain `string` (SailDef is
// the general per-boat shape, not narrowed to any one boat's literal ids).
export const DEFAULT_SAIL_IDS: readonly SailId[] = boatById(DEFAULT_BOAT_ID).sails.map(
  (s) => s.id as SailId,
);
