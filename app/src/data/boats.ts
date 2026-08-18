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

// #54 spec N (2026-08-18), which SUPERSEDES OQ-7. Two Flensburg fleet models
// join the catalogue at provenance tier C — polar tables SCALED from the
// Salona 45's certificate-anchored jib table by one uniform hull scalar,
// because no ORC/IRC certificate and no published VPP was obtained for either
// hull (spec G.1, M.6). The full method, its measured accuracy ceiling and the
// four things it structurally cannot do live in pipeline/estimate_polars.mjs's
// header; pipeline/build_polars.mjs's E1–E8 make every step fail closed.
//
// The consequence that matters most here is a TYPE-level one (spec N.4): the
// second sail of a tier-C boat is its own base table times the Salona 45's
// documented overlay ramp, so the difference between a tier-C boat's two
// tables is a function of THE RAMP, NOT THE HULL. It is not a noisy finding,
// it is not a finding — which is why `assemble` must resolve any sail set
// containing a tier-C sail to `not-compared` rather than rank the two. That
// suppression lives in the routing layer and is NOT implemented here.
//
// Both new gates derive to <= 3.0 m (1.90 m -> 2.8 m, 2.10 m -> 3.0 m), so no
// harbour becomes unreachable for any boat and no new connectivity ceiling is
// crossed — verified by a real pipeline/verify_mask.py run at all three gates,
// 28/33 harbours at each. Deeper fleet boats (Grand Soleil 46 at 2.30 m, EASY
// GO! at 2.55 m) DO drop harbours and are deferred until the picker can grey
// them out (spec N.7); do not add them here.
//
// `motorSpeedKn` and `maneuverPenaltyS` on the two fleet entries are the app's
// EXISTING defaults carried over unresearched, not per-hull figures — spec F.2
// makes them per-boat defaults but requires no research, and none was done.
// Named so the coincidence is not read as a finding. The one published datum
// found (Yachting World measured an Elan 444 at "8 at cruising revs") is
// deliberately NOT used: that test boat carried the upgraded 75 hp saildrive
// against a 55 hp standard, so the figure is not attributable to PIRANJA.
const S44_GENOA_NOTE =
  "Tier C, ESTIMATED - this hull's own jib table (see the salona-44-speedy-go fock note) " +
  "multiplied cell-by-cell by the Salona 45's documented genoa overlay ramp, i.e. its genoa " +
  'table divided by its jib table (+3-5% light-air upwind/reach, 0 at 14-20 kn, -2% upwind at ' +
  "25 kn). The difference between this boat's two tables is therefore a function of THAT RAMP, " +
  'not of this hull, and carries no information about it - which is why the sail comparison is ' +
  'withheld rather than presented as a finding. Same inherited grid and angles, and the same ' +
  'uncertainty, as the jib table. Flat-water racing VPP - tune with the performance factor. NOT ' +
  'race-calibrated, and never measured against this boat.';

const S44_FOCK_NOTE =
  'Tier C, ESTIMATED - no ORC/IRC certificate and no published VPP was obtained for this hull. ' +
  "Scaled from the Salona 45's certificate-anchored jib table (ORC International 2026, AUT " +
  '035/26) by one uniform hull scalar k = 1.020, the square root of the sail-area/displacement ' +
  'ratios: 92.81 m2 and 9,500 kg for this hull against 92.35 m2 and 10,000 kg for the Salona ' +
  '45, both figures from sailboatdata.com so the measurement basis is uniform. The TWA/TWS grid ' +
  'and the beat and gybe angles are INHERITED from the Salona 45 unchanged - an inherited ' +
  'claim, not a derived one: a uniform scalar cannot move pointing angles, capture hull shape ' +
  'or fix a wrong keel. Typically within a few percent, up to about ten percent in individual ' +
  'conditions; the residual is polar shape, which no scalar corrects. Flat-water racing VPP - ' +
  'tune with the performance factor. NOT race-calibrated, and never measured against this boat.';

const ELAN_GENOA_NOTE =
  "Tier C, ESTIMATED - this hull's own jib table (see the elan-444-piranja fock note) " +
  "multiplied cell-by-cell by the Salona 45's documented genoa overlay ramp, i.e. its genoa " +
  'table divided by its jib table (+3-5% light-air upwind/reach, 0 at 14-20 kn, -2% upwind at ' +
  "25 kn). The difference between this boat's two tables is therefore a function of THAT RAMP, " +
  'not of this hull, and carries no information about it - which is why the sail comparison is ' +
  'withheld rather than presented as a finding. Same inherited grid and angles, and the same ' +
  'uncertainty, as the jib table. Flat-water racing VPP - tune with the performance factor. NOT ' +
  'race-calibrated, and never measured against this boat.';

const ELAN_FOCK_NOTE =
  'Tier C, ESTIMATED - no ORC/IRC certificate and no published VPP was obtained for this hull. ' +
  "Scaled from the Salona 45's certificate-anchored jib table (ORC International 2026, AUT " +
  '035/26) by one uniform hull scalar k = 0.892, the square root of the sail-area/displacement ' +
  'ratios: 77.76 m2 and 10,900 kg for this hull against 92.35 m2 and 10,000 kg for the Salona ' +
  '45, both figures from sailboatdata.com. ONE SOURCE ONLY, and deliberately: Yachting World ' +
  "prints this model's 100% foretriangle area as 85.7 m2 (the main measured larger), and mixing " +
  'that one figure in gives k = 0.936 - a 5% shift through every cell of the table, from a ' +
  'reputable source, with nothing downstream able to detect it. The TWA/TWS grid and the beat ' +
  'and gybe angles are INHERITED from the Salona 45 unchanged - an inherited claim, not a ' +
  'derived one: a uniform scalar cannot move pointing angles, capture hull shape or fix a wrong ' +
  'keel. Typically within a few percent, up to about ten percent in individual conditions; the ' +
  'residual is polar shape, which no scalar corrects. MEASURED against the only independent ' +
  'light-air report for this hull: at TWA 45 / TWS 8, where Yachting World recorded just over 6 ' +
  'kn close-hauled, this table reads 5.45 kn - about 9% low, at the top of the band above. ' +
  'Because the scalar is uniform, that relative error is the same in every cell; there is no ' +
  'separate, larger light-air error mode. That is the light-air band where the estimator is ' +
  'weakest and where a sail-versus-motor decision can flip, so treat light-air legs for this ' +
  'boat with particular caution. Flat-water racing VPP - tune with the performance factor. NOT ' +
  'race-calibrated, and never measured against this boat.';

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
  {
    // Spec N.1. One entry per named VESSEL (OQ-4), and the id says so: EASY
    // GO! is the SAME MODEL and a DIFFERENT HULL (2.55 m deep keel, spec N.2)
    // and will land as `salona-44-easy-go`. A model-shaped `salona-44` would
    // have read as the class while permanently denoting one hull — and the id
    // is persisted inside every plan's boat snapshot and drives the polar
    // asset filenames, so it is cheap to get right now and effectively
    // impossible to change later.
    //
    // A shared per-model entry would have been worse still: one draft for two
    // hulls 0.45 m apart, which is the "wrong default variant is a silent
    // safety error" that spec L rejected the keel-variant picker over,
    // arriving through the sister-ship door instead.
    //
    // KNOWN CONFLICT, tracked as #567 rather than left in a PR body: OQ-4 says
    // sister ships SHARE a polar asset, and that is not expressible today —
    // verifyMaskBoatGate.test.ts requires the catalogue and pipeline boat-id
    // sets to be identical in both directions (for the stronger spec C.6
    // reason that no boat may ship without a verify_mask.py run at its own
    // derived gate), so a per-vessel entry implies a per-vessel polar file.
    // Harmless while no sister pair is in scope; a real conflict the moment
    // EASY GO! lands, because the two hulls would then carry duplicate tables
    // that can drift apart silently.
    id: 'salona-44-speedy-go',
    name: 'Salona 44 (SPEEDY GO!)',
    // Its own literal, deliberately. Spec L has a row on exactly this: 2.10 m
    // coincides NUMERICALLY with the Salona 45's BOAT_DRAFT_M and is a
    // different model, a different hull and a different polar. Never reference
    // that constant here — a shared reference means a later change to one
    // silently moves the other.
    draftM: 2.1,
    draftProvenance: {
      keel: 'standard',
      hullVerified: false,
      note:
        'Standard keel, 2.10 m, from the operator’s published tech sheet for this vessel ' +
        '(built 2014). Not checked against the hull’s own papers. Its sister ship EASY GO! ' +
        'is the same model on the 2.55 m deep keel, which is why the keel is stated per vessel ' +
        'rather than per model.',
    },
    motorSpeedKn: 6.5,
    maneuverPenaltyS: 45,
    sails: [
      {
        id: 'genoa',
        // Plain names, deliberately. The Salona 45's labels state measured sail
        // sizes ("Genoa 135 %"); this boat's inventory was not researched, and
        // its tables inherit the Salona 45's ~135 % genoa / ~110 % jib
        // configurations. Claiming those percentages here would dress an
        // inherited configuration up as a measured one.
        label: 'Genoa',
        polarAsset: 'data/polars/salona-44-speedy-go-genoa.json',
        polarProvenance: { tier: 'estimated', note: S44_GENOA_NOTE },
      },
      {
        id: 'fock',
        label: 'Jib',
        polarAsset: 'data/polars/salona-44-speedy-go-fock.json',
        polarProvenance: { tier: 'estimated', note: S44_FOCK_NOTE },
      },
    ],
  },
  {
    id: 'elan-444-piranja',
    name: 'Elan Impression 444 (PIRANJA)',
    // Derived gate 2.8 m — SHALLOWER than today's 3.0 m default, so this
    // boat's reachable-harbour set is a SUPERSET of the Salona 45's. It still
    // needed a new `("marstal", 2.8): 2.0` connectivity exception, because
    // verify_mask.py keys exceptions by (harbour, boat gate) and marstal's
    // existing entry was justified at 3.0 m only. See that entry's comment.
    draftM: 1.9,
    draftProvenance: {
      keel: 'standard fin-and-bulb',
      hullVerified: false,
      note:
        'Standard fin-and-bulb keel, 1.90 m, from the operator’s published tech sheet for ' +
        'this vessel. Not checked against the hull’s own papers. The model also ships a ' +
        '1.60 m shoal keel; if this hull were that variant the derived gate would be ' +
        'over-cautious, which is the harmless direction.',
    },
    motorSpeedKn: 6.5,
    maneuverPenaltyS: 45,
    sails: [
      {
        id: 'genoa',
        label: 'Genoa',
        polarAsset: 'data/polars/elan-444-piranja-genoa.json',
        polarProvenance: { tier: 'estimated', note: ELAN_GENOA_NOTE },
      },
      {
        id: 'fock',
        label: 'Jib',
        polarAsset: 'data/polars/elan-444-piranja-fock.json',
        polarProvenance: { tier: 'estimated', note: ELAN_FOCK_NOTE },
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
// per-boat lookup it was expected to become needs a SELECTED boat.
//
// This says DEFAULT boat, and since #54's spec-N amendment that is no longer
// the same thing as "the only boat" — the catalogue now holds three. The
// earlier note here read "today there is exactly one boat, so this and
// boatById(DEFAULT_BOAT_ID).sails name the same set"; that equivalence is gone
// and the DEFAULT_BOAT_ID lookup is now load-bearing rather than incidental.
// It stays correct because every call site listed above is one with no
// selected boat to consult, which is still the Salona 45 — but a future call
// site that DOES have a selected boat must read that boat's sails, not this.
//
// Cast is safe: boatById(DEFAULT_BOAT_ID) always resolves to a real entry of
// the const `BOATS` array above, whose sail ids ARE the SailId union by
// construction — `BoatDef.sails[].id` is typed as plain `string` (SailDef is
// the general per-boat shape, not narrowed to any one boat's literal ids).
export const DEFAULT_SAIL_IDS: readonly SailId[] = boatById(DEFAULT_BOAT_ID).sails.map(
  (s) => s.id as SailId,
);
