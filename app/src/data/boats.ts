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
// imports PolarProvenance from here in Task 11 — one direction only, no
// cycle. That is safe only because the chain types.ts -> lib/boatDepth.ts ->
// lib/mask.ts (mask.ts, geo.ts and depthGate.ts) imports from types.ts with
// `import type`, and tsconfig.app.json's verbatimModuleSyntax: true
// guarantees those type-only imports are erased at build time — DEFAULT_SETTINGS
// is an eagerly-evaluated top-level const, so a future VALUE import from
// types.ts into any of those three would become a real TDZ hazard that
// typecheck cannot see.

// These two notes duplicate pipeline/build_polars.mjs's SOURCE_NOTES verbatim
// with no derivation between them; Task 12 owns collapsing that into one source.
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
    motorSpeedKn: 6.5,
    maneuverPenaltyS: 45,
    sails: [
      {
        id: 'genoa',
        label: 'Genoa 135 %',
        polarAsset: 'data/polar-genoa.json',
        polarProvenance: { tier: 'modelled', note: GENOA_NOTE },
      },
      {
        id: 'fock',
        label: 'Jib 110 %',
        polarAsset: 'data/polar-fock.json',
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
