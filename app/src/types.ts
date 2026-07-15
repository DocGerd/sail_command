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
}

export const DEFAULT_SETTINGS: Settings = {
  safetyDepthM: 3.0,
  motorSpeedKn: 6.5,
  motorThresholdKn: 2.5,
  maneuverPenaltyS: 45,
  performanceFactor: 0.9,
  motorEnabled: true,
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

export interface PlanResultOk {
  status: 'ok';
  // planRoute guarantees at least one of genoa/fock is non-null when status is 'ok'
  // (both-failed returns status 'error' instead).
  genoa: RigResult | null; // null if that rig found no route
  fock: RigResult | null;
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
}
