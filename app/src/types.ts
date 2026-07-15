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

export interface Leg {
  kind: LegKind;
  board: Board | null; // null for motor
  start: LatLon;
  end: LatLon;
  startTimeMs: number;
  endTimeMs: number;
  headingDeg: number; // course over ground, degrees true
  twaDeg: number; // signed: >= 0 starboard board, < 0 port board (0 = head-to-wind edge case, starboard); NaN for motor
  twsKn: number; // TWS at leg start
  speedKn: number;
  distanceNm: number;
  maneuverAtStart: ManeuverKind | null;
}

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
  genoa: RigResult | null; // null if that rig found no route
  fock: RigResult | null;
  recommended: Rig;
  snappedOrigin: LatLon;
  snappedDestination: LatLon;
}

export interface PlanResultError {
  status: 'error';
  reason: NoRouteReason;
}

export type PlanResult = PlanResultOk | PlanResultError;

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
