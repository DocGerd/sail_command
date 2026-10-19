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
 * GO! turns out to be a deep-keel hull. Shipping it on the model default
 * would have understated a real vessel's draft by about 0.5 m and handed it a
 * gate 0.5 m too shallow, in the one field everything in spec C hangs on.
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
// The second sail of a tier-C boat is its own base table times the Salona 45's
// documented overlay ramp, so the difference between its two tables is a
// function of THE RAMP, NOT THE HULL. The comparison still runs and its
// verdict is flagged as estimate-based (spec T); the ramp explanation lives
// in each genoa note below.
//
// PIRANJA and SPEEDY GO! derive gates <= 3.0 m. The deeper hulls drop harbours,
// which the picker marks per harbour (#1135); EASY GO! (below) is the first
// such entry, the Grand Soleil 46 is still deferred (spec N.7).
//
// `motorSpeedKn` and `maneuverPenaltyS` on the fleet entries are the app's
// EXISTING defaults carried over unresearched, not per-hull figures — spec F.2
// makes them per-boat defaults but requires no research, and none was done.
// Named so the coincidence is not read as a finding. The one published datum
// found (Yachting World measured an Elan 444 at "8 at cruising revs") is
// deliberately NOT used: that test boat carried the upgraded 75 hp saildrive
// against a 55 hp standard, so the figure is not attributable to PIRANJA.
const S44_GENOA_NOTE =
  "Tier C, ESTIMATED - this hull's own jib table (see the Salona 44 (SPEEDY GO!) jib note) " +
  "multiplied cell-by-cell by the Salona 45's documented genoa overlay ramp, i.e. its genoa " +
  'table divided by its jib table (+3-5% light-air upwind/reach, 0 at 14-20 kn, -2% upwind at ' +
  "25 kn). The difference between this boat's two tables is therefore a function of THAT RAMP, " +
  'not of this hull, and carries no information about it - so a genoa-versus-jib ranking for ' +
  'this boat reflects the ramp and is shown only as an estimate. Same inherited grid and angles, and the same ' +
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
  "Tier C, ESTIMATED - this hull's own jib table (see the Elan Impression 444 (PIRANJA) jib note) " +
  "multiplied cell-by-cell by the Salona 45's documented genoa overlay ramp, i.e. its genoa " +
  'table divided by its jib table (+3-5% light-air upwind/reach, 0 at 14-20 kn, -2% upwind at ' +
  "25 kn). The difference between this boat's two tables is therefore a function of THAT RAMP, " +
  'not of this hull, and carries no information about it - so a genoa-versus-jib ranking for ' +
  'this boat reflects the ramp and is shown only as an estimate. Same inherited grid and angles, and the same ' +
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

const EASY_GO_GENOA_NOTE =
  "Tier C, ESTIMATED - this boat's jib table (see the jib note: a sister hull's certificate, " +
  "not this boat's) multiplied cell-by-cell by the Salona 45's documented genoa overlay ramp, " +
  'i.e. its genoa table divided by its jib table, never below 1 (about +4-5% at 4 kn, +3-4% at ' +
  '6, +2-3% at 8, +1-2% at 10, nothing from 16 kn). The ramp was set for a smaller genoa/jib ' +
  "step than the 61.10 m2 furling genoa the builder lists for the Salona 44 (this boat's own " +
  'headsail areas are not known), so the light-air gain may be understated; from 16 kn the ' +
  "genoa is credited with the jib's speed, which assumes it is depowered optimally and may be " +
  "too high. The difference between this boat's two tables is therefore a function of THAT " +
  'RAMP, not of this hull, and carries no information about it - so a genoa-versus-jib ranking ' +
  'for this boat reflects the ramp and is shown only as an estimate. Below about 8 kn the table ' +
  'decides between sailing and motoring, so a leg may be motored that would sail, or the ' +
  'reverse. Same grid and angles, and the same uncertainty, as the jib table. Flat-water ' +
  'racing VPP - tune with the performance factor. NOT race-calibrated, and never measured ' +
  'against this boat.';

const EASY_GO_FOCK_NOTE =
  "Tier B, MODELLED - this boat's own table, anchored on a SISTER HULL's ORC certificate, not " +
  'on a certificate of this boat. Source: ORC Non-Spinnaker certificate 2026 for the Salona 44 ' +
  'SANTA ANASTASIA (CRO 1938, RefNo 04590004MKR), issued 2026-04-22, retrieved 2026-10-15; ' +
  'deep keel (inferred from its ORC-measured draft of 2.415 m, the certificate has no keel ' +
  "field). It is that hull's white-sail polar in its 41.66 m2 jib configuration, read onto the " +
  "app grid; this boat's own jib area, loading and keel are unknown, and the sign of the " +
  "resulting error is unknown. Against the builder's ORC VPP 1.11 jib polar for another Salona " +
  '44 sister hull (2010, CRO 2009) the table differs by -5% to +9% per cell; that compares two ' +
  'sister-hull VPP runs and is not an error bound for this boat. Below about 8 kn the table ' +
  'decides between sailing and motoring, so a leg may be motored that would sail, or the ' +
  'reverse. Flat-water racing VPP - tune with the performance factor. NOT race-calibrated, and ' +
  'never measured against this boat.';

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
      // papers could disagree — unlike the fleet entries below.
      hullVerified: true,
      note:
        "The app's reference boat: a boat model, not one individual vessel, so there is no " +
        'hull whose papers this draft could disagree with. 2.1 m is also the draft the ' +
        "safety margin built into the app's depth data was chosen against, and the one " +
        "this boat's default safety depth is calculated from.",
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
    // GO! is the SAME MODEL and a DIFFERENT HULL (deep keel, spec N.2) and is
    // `salona-44-easy-go`. A model-shaped `salona-44` would
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
    // OQ-4: EASY GO! keeps its own catalogue entry and its own verify_mask.py gate scan.
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
        'is the same model on a deeper keel, which is why the keel is stated per vessel ' +
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
  {
    // #1575. The jib (`fock`) is tier B, anchored on a sister hull's ORC
    // certificate; the genoa is tier C, ramped off that jib. Own tables since
    // the EASY GO! cutover (spec P), so the boat is a mixed-tier set.
    id: 'salona-44-easy-go',
    name: 'Salona 44 (EASY GO!)',
    // The operator's page gives 2.55 m, a Salona 44 racing-keel review 2.59 m;
    // the deeper figure is taken, since a draft too shallow is the unsafe
    // direction. Its own literal, never SPEEDY GO!'s 2.10 m.
    draftM: 2.59,
    draftProvenance: {
      keel: 'deep racing keel',
      hullVerified: false,
      note:
        "Deep (racing) keel, 2.59 m. Sources disagree: the builder's technical data lists 2.10 / " +
        '2.55 m for the two keels, the operator’s page for this boat gives 2.55 m, and a published ' +
        'review 2.59 m, whose own imperial figure (8 ft 4 in) reads 2.54 m; six ORC-measured Salona ' +
        '44 hulls of the deeper-keel group read 2.415-2.441 m. ORC drafts are measured at the ' +
        "certificate's measurement displacement (9,300 kg for the donor, against 10,578 kg sailing), " +
        'so the setting should not be lowered toward them. The deeper figure is used so the derived ' +
        'depth gate is not too shallow; 2.55 m gives the same 3.5 m gate. Not checked against the ' +
        "hull's own papers. The polar tables come from a sister hull measured at 2.415 m, so the " +
        'speeds carry no keel term for this boat.',
    },
    motorSpeedKn: 6.5,
    maneuverPenaltyS: 45,
    sails: [
      {
        id: 'genoa',
        label: 'Genoa',
        polarAsset: 'data/polars/salona-44-easy-go-genoa.json',
        polarProvenance: { tier: 'estimated', note: EASY_GO_GENOA_NOTE },
      },
      {
        id: 'fock',
        label: 'Jib',
        polarAsset: 'data/polars/salona-44-easy-go-fock.json',
        polarProvenance: { tier: 'modelled', note: EASY_GO_FOCK_NOTE },
      },
    ],
  },
] as const satisfies readonly BoatDef[];

export type BoatId = (typeof BOATS)[number]['id'];
export type SailId = (typeof BOATS)[number]['sails'][number]['id'];

/** Spec R.6/D11: the compared headsails per plan; a third solve exceeds `PLAN_BUDGET_MS`. */
export const MAX_HEADSAILS = 2;

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

/**
 * #54: one boat's full sail set, in catalogue order — the solve order a
 * `PlanRequest.sailIds` carries (spec E.3).
 *
 * The cast lives here rather than at each call site so its justification is
 * stated once. `SailDef.id` is declared plain `string` (SailDef is the
 * general per-boat shape, not narrowed to any one boat's literal ids) while
 * `SailId` is the catalogue-derived union — so the cast is sound exactly
 * when the argument is an entry of the const `BOATS` array above, whose sail
 * ids ARE that union by construction.
 *
 * That is a property of the CALL SITES, not of the signature: `BoatDef` is the
 * general shape, and nothing narrows `SailDef.id` to the catalogue, so a
 * hand-built `BoatDef` literal with an unknown sail id typechecks here and is
 * silently cast (MEASURED). A plan's stored `BoatSnapshot` is NOT that hazard —
 * it is strictly narrower than `BoatDef` and the compiler rejects it outright
 * (TS2345: missing draftProvenance, motorSpeedKn, maneuverPenaltyS). The two
 * production call sites today pass a `boatById(...)` result, which always
 * resolves inside the catalogue or throws. Feed it anything else and the cast
 * is a lie.
 *
 * A caller holding a SELECTED boat must use this, never `DEFAULT_SAIL_IDS` —
 * see that constant's own comment for the split.
 */
export function sailIdsOf(boat: BoatDef): readonly SailId[] {
  return boat.sails.map((s) => s.id as SailId);
}

// #54: the DEFAULT boat's sail set. Its only remaining call sites are the
// absent-sailIds backfills in lib/recalc.ts, state/replan.ts and
// state/reroute.ts — paths reconstructing a request from a plan saved before
// `sailIds` existed, where there is no selected boat to consult and the plan
// predates the catalogue holding anything but the Salona 45.
//
// #572 removed the other call site. App.tsx's handlePlan used this and, in
// the same object literal, `defaultBoatSnapshot()` — so every new plan was
// solved as a Salona 45 whatever the picker showed. It now reads the selected
// boat through `sailIdsOf(boat)`.
//
// This says DEFAULT boat, and since #54's spec-N amendment that is no longer
// the same thing as "the only boat" — the catalogue holds several. The
// earlier note here read "today there is exactly one boat, so this and
// boatById(DEFAULT_BOAT_ID).sails name the same set"; that equivalence is gone
// and the DEFAULT_BOAT_ID lookup is now load-bearing rather than incidental.
export const DEFAULT_SAIL_IDS: readonly SailId[] = sailIdsOf(boatById(DEFAULT_BOAT_ID));

// #356a (departure-time comparison, design spec §2.2): the specific sail
// every catalogue boat's genoa-type sail is filed under. Routed through this
// module — not written as a bare literal at the useDepartureScan.ts call
// site — per app/src/test/sailLiteralCallSites.test.ts's #54 guard, which
// flags a NEW bare sail-id literal outside this file and services/
// migratePlan.ts.
//
// Deliberately a plain literal, NOT `BOATS[0].sails[0].id` or any other
// POSITIONAL derivation: §2.2's scan is pinned to the genoa SAIL TYPE by
// measurement (genoa-only ranking is byte-identical to true two-rig-best;
// fock-only is NOT), never to "whichever sail happens to sit first" — a
// catalogue reorder that left the id spellings unchanged must not silently
// repoint this at a different sail. The type system is still the derivation:
// `SailId` is `(typeof BOATS)[number]['sails'][number]['id']`, so this
// assignment is a COMPILE ERROR the moment no catalogue boat carries a sail
// id 'genoa' any more — checked by VALUE, immune to array reordering.
export const GENOA_SAIL_ID: SailId = 'genoa';
