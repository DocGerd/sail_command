import { defaultSafetyDepthM } from './lib/boatDepth';
import { boatById, DEFAULT_BOAT_ID, type PolarProvenance, type SailId } from './data/boats';

// #54: re-exported so every existing `import type { ... } from '../types'`
// call site keeps working unchanged — SailId is DEFINED in data/boats.ts
// (derived from the BOATS catalogue, spec §E.3) and types.ts is the neutral
// domain-type layer the rest of the app already imports from. Never
// redeclare a second, hand-written sail-id union here — that would
// silently drift from the catalogue the moment a boat with a different sail
// set is added.
export type { SailId };

export interface LatLon {
  lat: number;
  lon: number;
}

// #846: a via point is a LatLon that MAY carry a user-assigned name ("off
// Holnis", "Kalkgrund"). Deliberately an optional field on a superset
// interface, never a required one and never a restructured viaPoints
// container — either would turn this into a breaking change (design spec
// §2.1). Optional means every existing call site typed at the plain LatLon
// shape keeps compiling unchanged (a LatLon literal satisfies ViaPoint,
// since a missing optional property is fine structurally), so widening
// PlanRequest.viaPoints below to ViaPoint[] costs nothing at any producer
// that never mentions `name`. The solver (planRoute.ts) still reads only
// .lat/.lon off each via point, so this is presentation-only — see §2.2 of
// the design spec for why that keeps PlanResult byte-identical and no
// app/sweep/ run owed.
export interface ViaPoint extends LatLon {
  name?: string;
}

export type Board = 'port' | 'starboard';
export type LegKind = 'sail' | 'motor';
export type ManeuverKind = 'tack' | 'gybe';

export interface Settings {
  safetyDepthM: number; // default 3.0
  // #243 depth comfort preference: beyond the hard safetyDepthM gate, the
  // solver also PRICES every candidate segment on its minimum charted
  // clearance — free at/above safetyDepthM + this margin, up to ~1.43x the
  // crossing time right at the gate itself, linear in between. 0 disables the
  // preference entirely (the solver's SolveParams.comfortDepthM stays
  // undefined, taking the byte-identical pre-#243 path). Always anchored to
  // the REQUESTED safetyDepthM, even during a #53 relaxed-gate solve — see
  // planRoute.ts.
  depthComfortMarginM: number; // default 2.0
  motorSpeedKn: number; // default 6.5
  motorThresholdKn: number; // default 2.5
  // #254 sailing preference: the solver motors a candidate heading whenever
  // sailing it would be more than this many knots slower than motoring, i.e.
  // the effective sail-speed floor is
  //   max(motorThresholdKn, motorSpeedKn - sailPreferenceKn).
  // The margin is therefore a hard upper bound on how much boat speed a
  // sail-locked heading can be losing. motorThresholdKn survives underneath as
  // the seaworthiness floor, which is what stops a user-lowered motorSpeedKn
  // from producing motor legs SLOWER than sailing. At or above
  // motorSpeedKn - motorThresholdKn (4.0 at defaults) the floor collapses back
  // to motorThresholdKn, taking the byte-identical pre-#254 path.
  sailPreferenceKn: number; // default 2.8
  maneuverPenaltyS: number; // default 45
  performanceFactor: number; // default 0.9
  motorEnabled: boolean; // default true
  // #25 addendum: standalone "show my position" ownship marker, decoupled
  // from Live View — default OFF/opt-in (enabling it triggers the
  // geolocation permission flow). Unrelated to routing, so it is
  // deliberately NOT part of PlanRequest/the router's inputs.
  showOwnship: boolean; // default false
  // #25 AIS live traffic overlay (Live tab only): the BYOK aisstream.io API
  // key, device-local (IndexedDB settings), never transmitted anywhere except
  // inside aisstream's own subscription message. OPTIONAL and
  // absent-by-default = feature off; exactOptionalPropertyTypes means an unset
  // field is omitted, never `undefined`.
  //
  // #746: the user's own vessel MMSI is NOT here. It identifies a VESSEL, so
  // it has to follow the boat, whereas this key identifies an ACCOUNT and must
  // NOT change on a boat switch. It now lives in localStorage, one key per
  // boat — see lib/ownMmsi.ts, which carries the full reasoning. Do not add it
  // back: `Settings` is snapshotted BY VALUE into every `PlanRequest` (spec
  // §I.3), and an MMSI describes no route computation.
  aisApiKey?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  // #54: derived from the Salona 45's own draft (spec C.3) rather than a
  // hand-written literal — evaluates to 3.0, preserving today's value by
  // derivation instead of by hand.
  safetyDepthM: defaultSafetyDepthM(boatById(DEFAULT_BOAT_ID)),
  depthComfortMarginM: 2.0,
  motorSpeedKn: 6.5,
  motorThresholdKn: 2.5,
  sailPreferenceKn: 2.8,
  maneuverPenaltyS: 45,
  performanceFactor: 0.9,
  motorEnabled: true,
  showOwnship: false,
};

export interface PolarTable {
  // Field NAME unchanged (retyped only) — this is exactly the shape the
  // committed pipeline output (app/public/data/polars/salona-45-genoa.json
  // and salona-45-fock.json) ships on disk (a "rig" key naming the sail), so
  // renaming the field would desync runtime JSON parsing from the type
  // with no compiler to catch it.
  rig: SailId;
  boat: string;
  tws: number[]; // knots, ascending
  twa: number[]; // degrees 0..180, ascending
  speeds: number[][]; // speeds[twaIdx][twsIdx] = boat speed kn
  beat: { tws: number[]; angle: number[] }; // optimal beat TWA per TWS
  gybe: { tws: number[]; angle: number[] }; // optimal downwind TWA per TWS
  source: string;
}

// Flattened index: ((ti * lats.length) + latIdx) * lons.length + lonIdx
export interface WindGrid {
  lats: number[]; // ascending
  lons: number[]; // ascending
  timesMs: number[]; // hourly, ascending, UTC epoch ms
  speedKn: Float32Array;
  dirFromDeg: Float32Array; // meteorological: coming FROM, degrees true
  gustKn: Float32Array;
  fetchedAtMs: number;
  model: string;
}

export interface WindSample {
  speedKn: number;
  dirFromDeg: number;
  gustKn: number;
}

export interface LegCommon {
  start: LatLon;
  end: LatLon;
  startTimeMs: number;
  endTimeMs: number;
  headingDeg: number; // course over ground, degrees true — no leeway model
  // exists, so never render this as "heading" (#379); UI shows it as COG.
  twsKn: number; // TWS at leg start
  speedKn: number;
  distanceNm: number;
  // #53 graceful degradation: present only on plans that relaxed the depth
  // gate, on legs whose geometry crosses cells charted shallower than the
  // REQUESTED safety depth — carrying that leg's minimum charted depth so map
  // and depth profile can highlight it. exactOptionalPropertyTypes: the key is
  // omitted entirely on unflagged legs, never set to undefined. Lives on
  // LegCommon so both Leg variants (sail and motor) carry it.
  shallow?: { minDepthM: number };
}

export type Leg =
  | (LegCommon & {
      kind: 'sail';
      board: Board;
      // signed: >= 0 starboard board, < 0 port board (0 = head-to-wind edge case, starboard)
      // 0° (head-to-wind) resolves to starboard as a side effect of the >= 0 rule above; ±180°
      // (dead run) is the one case with special handling — see boardForCandidate in maneuver.ts
      // (inherits the parent leg's board).
      twaDeg: number;
      maneuverAtStart: ManeuverKind | null;
    })
  | (LegCommon & { kind: 'motor'; board: null; maneuverAtStart: null });

export interface RigResult {
  // #54: renamed from `rig` — nothing else about this interface changes.
  sailId: SailId;
  legs: Leg[];
  etaMs: number;
  durationMs: number;
  distanceNm: number;
  maneuverCount: number;
  motorDistanceNm: number;
}

// #259: the honest rig-comparison outcome, distinct from the plain
// `recommended` pick on PlanResultOk below. 'decided' names a genuine faster
// rig; 'tie' means the ETA gap between the two rigs is inside planRoute's tie
// band (RIG_TIE_BAND_MS) — too close to call, not a ranking; 'moot' means
// neither rig's polar drove a single leg (both routes are entirely motor), so
// the polar comparison itself is meaningless — a STRONGER statement than
// 'tie'. `erasableSyntaxOnly` forbids enums, hence the string-literal union.
// #54: still BINARY (its `rig` field name is unchanged) — spec §J OQ-3 caps
// comparison at 2 sails for release-1; do not generalise this to N-way.
//
// #553 / spec §N.4: 'not-compared' means NO comparison was performed at all —
// a strictly weaker statement than 'tie' or 'moot', both of which report the
// OUTCOME of a comparison that did run. `assemble` (routing/planRoute.ts)
// returns it whenever `compareRigs` was not called: fewer than two sails
// produced a result, more than two were requested (the cap is 2, so no N-way
// verdict is defined), or the boat's polars are tier C, where the second
// table is the first times a documented overlay ramp so their difference is a
// function of the ramp rather than of the hull.
//
// NOT the N-way generalisation §L rejects (`[OQ-3] Generalise
// RigRecommendation to N-way now`) — spec §N.9 says so explicitly. The cap
// stays at 2, `decided` still carries exactly one `rig`, and no N-way tie
// semantics are defined here or anywhere else: the N >= 3 case is answered by
// declining to rank, not by ranking N things.
export type RigRecommendation =
  { kind: 'decided'; rig: SailId } | { kind: 'tie' } | { kind: 'moot' } | { kind: 'not-compared' };

export type NoRouteReason =
  | 'unreachable' // frontier died against land/depth everywhere
  | 'beyond-horizon' // forecast horizon exceeded before arrival
  | 'calm-motor-off' // no progress possible under sail, motor disabled
  | 'snap-failed-origin' // origin not navigable within 300 m
  | 'snap-failed-destination'
  | 'snap-failed-via' // a via point not navigable within 300 m
  // #432: the plan's wall-clock budget ran out mid-search. Unlike every other
  // member this is NOT a finding about the route — the search never finished,
  // so it is explicitly not a claim that no route exists. Deliberately spelled
  // unlike its internal cause ('budget-exhausted', routing/planRoute.ts) so the
  // presentational and control vocabularies stay greppable apart (#282).
  | 'search-budget-exceeded';

// #54 spec §I.3: the boat a plan was computed for, denormalised BY VALUE
// into the plan record — never a catalogue id reference. Precedent is
// PlanRequest.settings, already a snapshot rather than a pointer to live
// settings. With this in place everything needed to RENDER a saved plan
// lives inside the record, so a plan whose boat has left the catalogue
// still opens; the catalogue is needed only to re-plan.
//
// Deliberately narrower than BoatDef: motorSpeedKn and maneuverPenaltyS are
// per-boat DEFAULTS that a plan already captures resolved in its Settings
// snapshot, so storing them here too would create a second copy that can
// disagree with the one the solver actually used.
export interface BoatSnapshot {
  readonly id: string;
  readonly name: string;
  readonly draftM: number;
  readonly sails: readonly {
    readonly id: string;
    readonly label: string;
    readonly polarProvenance: PolarProvenance;
  }[];
}

// Copies every field rather than aliasing its argument, so nothing stored in
// a plan can share a mutable reference with the BOATS constant or with
// another plan's snapshot (same rule recalcRequest applies to
// viaPoints/settings). The parameter is the SNAPSHOT shape, not BoatDef, so
// one function serves both directions: a catalogue BoatDef is structurally
// assignable to it, and an existing snapshot can be re-copied.
export function boatSnapshot(boat: BoatSnapshot): BoatSnapshot {
  return {
    id: boat.id,
    name: boat.name,
    draftM: boat.draftM,
    sails: boat.sails.map((s) => ({
      id: s.id,
      label: s.label,
      polarProvenance: { tier: s.polarProvenance.tier, note: s.polarProvenance.note },
    })),
  };
}

/** A fresh snapshot of the default catalogue boat — a new object per call. */
export function defaultBoatSnapshot(): BoatSnapshot {
  return boatSnapshot(boatById(DEFAULT_BOAT_ID));
}

export interface PlanRequest {
  origin: LatLon;
  destination: LatLon;
  viaPoints: ViaPoint[]; // visited in order, origin -> viaPoints[0] -> ... -> destination
  originHarborId: string | null;
  destinationHarborId: string | null;
  departureMs: number;
  settings: Settings;
  // #54: the plan's selected sails, IN SOLVE ORDER — this list, not a module
  // constant, is now the source of truth for the order planRoute.ts solves
  // sails in (spec §E.3; replaces the deleted RIG_ORDER). Capped at 2 for
  // release-1 (spec §J OQ-3) — RigRecommendation stays binary and is not
  // generalised to N-way.
  readonly sailIds: readonly SailId[];
  // #54 spec §I.3: by value, never a catalogue id reference.
  readonly boat: BoatSnapshot;
}

// #53 graceful degradation below safety depth: when a plan only routes at a
// relaxed (below-requested) depth gate, the result carries this plan-level
// warning. Structured-clone-safe plain numbers (IndexedDB/postMessage).
export interface ShallowInfo {
  requestedDepthM: number; // the user's safety depth the plan was requested at
  usedDepthM: number; // the relaxed gate the solver actually ran with (>= 2.1)
  minGateDepthM: number; // shallowest charted cell actually traversed below requestedDepthM
}

// #54: one entry per requested sail (PlanRequest.sailIds order). Replaces
// the old fixed genoa/fock/genoaReason/fockReason quartet on PlanResultOk —
// declared exactly this way because Tasks 8 (the sweep's canonicalising
// comparator), 10b (partial results on budget exhaustion) and 11 (plan
// migration) all depend on this shape.
export interface SailResult {
  readonly sailId: SailId;
  readonly result: RigResult | null; // null if that sail found no route
  // why a null sail found no route ("every result is user-visible" needs the
  // reason, not just the absence); null when the sail has a result.
  readonly reason: NoRouteReason | null;
}

export interface PlanResultOk {
  readonly status: 'ok';
  // planRoute guarantees at least one entry's `result` is non-null when
  // status is 'ok' (both-failed returns status 'error' instead).
  readonly sails: readonly SailResult[];
  readonly recommended: SailId;
  // #54 spec §E.3: false when a requested sail's search was cut short by the
  // plan's wall-clock budget, so that sail was never compared and `recommended`
  // names a winner picked from the rest. A sail that found no route for any
  // other reason still counts as compared — its search finished.
  readonly comparisonComplete: boolean;
  // #53: present only when the route required relaxing the depth gate below
  // the requested safety depth. One value for the whole plan — every sail
  // solves at the same relaxed gate by construction. exactOptionalPropertyTypes:
  // omitted entirely when no relaxation happened, never set to undefined.
  readonly shallow?: ShallowInfo;
  // #259: present whenever planRoute computed the honest comparison (every
  // plan solved after #259 landed). Optional so pre-#259 PlanResultOk
  // literals across the test suite keep typechecking unchanged.
  // exactOptionalPropertyTypes: omitted entirely when absent, never assigned
  // undefined. Absence is resolved via a single fallback,
  // `rigRecommendationOf()` in lib/resultSummary.ts — never re-derive it
  // ad hoc at a call site. #54: still binary (spec §J OQ-3) — unchanged by
  // the sails-list rename.
  readonly rigRecommendation?: RigRecommendation;
  readonly snappedOrigin: LatLon;
  readonly snappedDestination: LatLon;
}

// Returns the recommended sail's RigResult. Throws rather than fabricating an
// ETA if the recommended sail's result is null — status 'ok' guarantees the
// recommended sail has a non-null result (both-failed is a status 'error'
// instead), so a null here means that invariant was violated upstream and
// callers must not paper over it with a fallback like the departure time.
export function recommendedResult(result: PlanResultOk): RigResult {
  const entry = result.sails.find((s) => s.sailId === result.recommended);
  if (!entry?.result) {
    throw new Error(
      `invariant violated: recommended sail '${result.recommended}' has a null result`,
    );
  }
  return entry.result;
}

export interface PlanResultError {
  status: 'error';
  reason: NoRouteReason;
}

export type PlanResult = PlanResultOk | PlanResultError;

// #54 spec §I.3: stamped on every written plan. The IndexedDB version is not
// the only entry path — a plan can also arrive from a future import (#3) —
// and an untagged record has no self-description, so services/migratePlan.ts
// dispatches on this rather than sniffing the record's shape.
export const PLAN_SCHEMA_VERSION = 1;

// Structured-clone-safe (IndexedDB, postMessage) but NOT JSON-safe:
// windGrid carries Float32Array fields.
// File import/export (e.g. Garmin sync, issue #3) needs a dedicated
// serializer — never JSON.stringify(plan).
export interface Plan {
  id: string; // crypto.randomUUID()
  name: string; // e.g. "Flensburg → Marstal"
  createdAtMs: number;
  schemaVersion: number;
  request: PlanRequest;
  windGrid: WindGrid; // the forecast this plan was computed from
  result: PlanResultOk;
}

export interface Harbor {
  id: string;
  names: { de: string; da: string; en: string };
  country: 'DE' | 'DK';
  snap: LatLon; // guaranteed-navigable point off the harbor mouth
  approachNote?: { de: string; en: string };
}

// Presentational output of an origin/destination/via pick, shared between
// PlannerPanel and App.tsx's wiring. Source-discriminated rather than a
// nullable harborId: a harbor pick always has a real harborId (never ''/
// null), so a consumer that only cares about the harbor case (e.g. building
// a PlanRequest's originHarborId/destinationHarborId) narrows on `source`
// instead of null-checking a field that a 'tap' pick never meaningfully has.
export type PickedPoint =
  | { source: 'harbor'; point: LatLon; harborId: string; label: string }
  | { source: 'tap'; point: LatLon; label: string };

export interface MaskMeta {
  west: number;
  south: number;
  east: number;
  north: number;
  cols: number;
  rows: number;
  // encoding: byte 0 = LAND or unknown/unsurveyed (non-navigable);
  // 1..254 = depth in decimeters, rounded DOWN (0.1..25.4 m);
  // 255 = deep (>= 25.4 m). Row 0 = southernmost row,
  // col 0 = westernmost col; cell center = origin + (idx + 0.5) * step.
  // Optional build-time provenance metadata (pipeline/build_mask.py writes
  // these into mask.meta.json; older builds may omit them). Structured-clone-
  // safe (plain string/string[]) — never assume present, only rendered for
  // display (e.g. AboutDialog's data-sources list).
  encoding?: string;
  verticalDatum?: string;
  sources?: string[];
}

// Seamarks / aids-to-navigation overlay (#7). One Point feature per aid in
// app/public/data/seamarks.json (pipeline/build_seamarks.mjs), trimmed to
// exactly these fields. `seamarkType` is always one of buoy_*/beacon_*/
// light_* (the pipeline's core-AtoN filter) but is typed as `string`, not a
// closed union: seamarkGlyphs.ts classifies it by prefix/suffix at render
// time, so an unfamiliar value from a future re-pull degrades to a fallback
// glyph instead of a type error. Light fields are flat (not a nested
// `light: {...}` object) because a MapLibre GeoJSON source silently
// stringifies nested object properties on read-back (queryRenderedFeatures/
// click `e.features[].properties`) — flat strings survive the round-trip.
export interface SeamarkProperties {
  seamarkType: string;
  category?: string;
  colour?: string;
  shape?: string;
  lightCharacter?: string;
  lightPeriod?: string;
  lightColour?: string;
}
