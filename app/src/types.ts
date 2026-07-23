export interface LatLon {
  lat: number;
  lon: number;
}

export type Rig = 'genoa' | 'fock';
export type Board = 'port' | 'starboard';
export type LegKind = 'sail' | 'motor';
export type ManeuverKind = 'tack' | 'gybe';

export interface Settings {
  safetyDepthM: number; // default 3.0
  motorSpeedKn: number; // default 6.5
  motorThresholdKn: number; // default 2.5
  maneuverPenaltyS: number; // default 45
  performanceFactor: number; // default 0.9
  motorEnabled: boolean; // default true
  // #25 addendum: standalone "show my position" ownship marker, decoupled
  // from Live View — default OFF/opt-in (enabling it triggers the
  // geolocation permission flow). Unrelated to routing, so it is
  // deliberately NOT part of PlanRequest/the router's inputs.
  showOwnship: boolean; // default false
  // #25 AIS live traffic overlay (Live tab only): BYOK aisstream.io API key +
  // the user's own vessel MMSI, both device-local (IndexedDB settings), never
  // transmitted anywhere except (the key) inside aisstream's subscription
  // message. Both OPTIONAL and absent-by-default = feature off;
  // exactOptionalPropertyTypes means an unset field is omitted, never
  // `undefined`. `ownMmsi` is a string (preserves leading zeros; validated via
  // isValidMmsi before use) and only ever filters the display — never sent.
  aisApiKey?: string;
  ownMmsi?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  safetyDepthM: 3.0,
  motorSpeedKn: 6.5,
  motorThresholdKn: 2.5,
  maneuverPenaltyS: 45,
  performanceFactor: 0.9,
  motorEnabled: true,
  showOwnship: false,
};

export interface PolarTable {
  rig: Rig;
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
  headingDeg: number; // course over ground, degrees true
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
  rig: Rig;
  legs: Leg[];
  etaMs: number;
  durationMs: number;
  distanceNm: number;
  maneuverCount: number;
  motorDistanceNm: number;
}

export type NoRouteReason =
  | 'unreachable' // frontier died against land/depth everywhere
  | 'beyond-horizon' // forecast horizon exceeded before arrival
  | 'calm-motor-off' // no progress possible under sail, motor disabled
  | 'snap-failed-origin' // origin not navigable within 300 m
  | 'snap-failed-destination'
  | 'snap-failed-via'; // a via point not navigable within 300 m

export interface PlanRequest {
  origin: LatLon;
  destination: LatLon;
  viaPoints: LatLon[]; // visited in order, origin -> viaPoints[0] -> ... -> destination
  originHarborId: string | null;
  destinationHarborId: string | null;
  departureMs: number;
  settings: Settings;
}

// #53 graceful degradation below safety depth: when a plan only routes at a
// relaxed (below-requested) depth gate, the result carries this plan-level
// warning. Structured-clone-safe plain numbers (IndexedDB/postMessage).
export interface ShallowInfo {
  requestedDepthM: number; // the user's safety depth the plan was requested at
  usedDepthM: number; // the relaxed gate the solver actually ran with (>= 2.1)
  minGateDepthM: number; // shallowest charted cell actually traversed below requestedDepthM
}

export interface PlanResultOk {
  status: 'ok';
  // planRoute guarantees at least one of genoa/fock is non-null when status is 'ok'
  // (both-failed returns status 'error' instead).
  genoa: RigResult | null; // null if that rig found no route
  fock: RigResult | null;
  // #53: present only when the route required relaxing the depth gate below
  // the requested safety depth. One value for the whole plan — both rigs
  // solve at the same relaxed gate by construction. exactOptionalPropertyTypes:
  // omitted entirely when no relaxation happened, never set to undefined.
  shallow?: ShallowInfo;
  // why a null rig found no route ("both results are user-visible" needs the
  // reason, not just the absence); null when the rig has a result
  genoaReason: NoRouteReason | null;
  fockReason: NoRouteReason | null;
  recommended: Rig;
  snappedOrigin: LatLon;
  snappedDestination: LatLon;
}

// Returns the recommended rig's RigResult. Throws rather than fabricating an
// ETA if the recommended rig's result is null — status 'ok' guarantees the
// recommended rig has a non-null result (both-failed is a status 'error'
// instead), so a null here means that invariant was violated upstream and
// callers must not paper over it with a fallback like the departure time.
export function recommendedResult(result: PlanResultOk): RigResult {
  const rig = result.recommended === 'genoa' ? result.genoa : result.fock;
  if (!rig) {
    throw new Error(
      `invariant violated: recommended rig '${result.recommended}' has a null result`,
    );
  }
  return rig;
}

export interface PlanResultError {
  status: 'error';
  reason: NoRouteReason;
}

export type PlanResult = PlanResultOk | PlanResultError;

// Structured-clone-safe (IndexedDB, postMessage) but NOT JSON-safe:
// windGrid carries Float32Array fields.
// File import/export (e.g. Garmin sync, issue #3) needs a dedicated
// serializer — never JSON.stringify(plan).
export interface Plan {
  id: string; // crypto.randomUUID()
  name: string; // e.g. "Flensburg → Marstal"
  createdAtMs: number;
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
