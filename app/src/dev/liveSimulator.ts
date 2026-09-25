import type { GpsErrorKind, GpsFix } from '../services/geolocation';
import type { LatLon } from '../types';

// #143: Live-view simulator. Dev/UAT-only harness that feeds synthetic
// GpsFix sequences into the SAME watchPosition seam both GPS consumers
// (LiveView.tsx and useOwnshipGps.ts) already default to, so both seams stay
// driven from one source without either needing a new prop (docs/spikes/
// 749-live-view-demo-mode.md §7.2 precondition 1). Import sites must gate on
// `import.meta.env.DEV || __SC_UAT__` with a fold-exact `? :` (never `&&` in
// JSX — see App.tsx's #107 comment) so a production build tree-shakes this
// whole module out of the prod bundle (#96 byte-identity).
//
// Activation is a query parameter (`?liveSim=<scenario>`), never
// localStorage (spike §5.1/§7.2 precondition 3): an installed PWA's
// `start_url: '.'` carries no query string, so the simulator cannot survive
// a relaunch.

export type LiveSimScenario = 'track' | 'drift' | 'stop' | 'dropout' | 'degraded-accuracy';

export const LIVE_SIM_SCENARIOS: readonly LiveSimScenario[] = [
  'track',
  'drift',
  'stop',
  'dropout',
  'degraded-accuracy',
];

const DEFAULT_SCENARIO: LiveSimScenario = 'track';
export const LIVE_SIM_TICK_MS = 1000; // <=1 Hz publish, mirrors useOwnshipGps.ts's own rule
export const LIVE_SIM_DEFAULT_SPEED_MULTIPLIER = 50;
const MIN_SPEED_MULTIPLIER = 1;
const MAX_SPEED_MULTIPLIER = 500;

const BASE_SOG_KN = 5.5;
const JITTER_SOG_KN = 0.6;
const JITTER_COG_DEG = 4;
const NOMINAL_ACCURACY_M = 8;
const DEGRADED_ACCURACY_M = 120;
const DROPOUT_LIVE_TICKS = 6;
const DROPOUT_DEAD_TICKS = 2;
const DRIFT_GROWTH_NM_PER_TICK = 0.02;
const DRIFT_MAX_NM = 0.6;

const EARTH_RADIUS_NM = 3440.065;

// A small closed loop inside the Flensburg Fjord (mask bounds 54.3-55.6N,
// 9.4-11.6E per mask.meta.json) — synthetic, not tied to any real plan: the
// allowlist this feature was built under has no access to App.tsx's plan
// state, so "follow an existing planned route" (the issue's stretch ask) is
// out of scope here; see the PR body for that deviation.
const TRACK: readonly LatLon[] = [
  { lat: 54.79, lon: 9.445 },
  { lat: 54.81, lon: 9.495 },
  { lat: 54.83, lon: 9.56 },
  { lat: 54.815, lon: 9.61 },
  { lat: 54.795, lon: 9.57 },
  { lat: 54.79, lon: 9.445 },
];

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function haversineNm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function bearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Standard destination-point (direct geodesic) formula, used only for the
// 'drift' scenario's small perpendicular offset — accurate enough at the
// sub-nm scale this simulator ever moves.
function destinationPoint(from: LatLon, bearingDegrees: number, distNm: number): LatLon {
  const angDist = distNm / EARTH_RADIUS_NM;
  const brng = toRad(bearingDegrees);
  const lat1 = toRad(from.lat);
  const lon1 = toRad(from.lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) + Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1),
      Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: toDeg(lat2), lon: toDeg(lon2) };
}

interface TrackGeometry {
  points: readonly LatLon[];
  segmentNm: number[];
  cumulativeNm: number[];
  totalNm: number;
}

function buildTrackGeometry(points: readonly LatLon[]): TrackGeometry {
  const segmentNm: number[] = [];
  const cumulativeNm: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    cumulativeNm.push(total);
    const d = haversineNm(points[i], points[i + 1]);
    segmentNm.push(d);
    total += d;
  }
  return { points, segmentNm, cumulativeNm, totalNm: total };
}

// Lazily built and memoised, NOT a top-level `const x = f(...)` — a
// module-level function CALL is exactly the shape Rollup's tree-shaker
// treats conservatively as a possible side effect, which pulled this whole
// module into the production bundle even with every REFERENCE to it folded
// away (measured: prod entry-chunk diff against a pre-change base, PR body
// has the byte count). Every export below routes through this accessor so
// nothing here runs until something actually calls into the module.
let trackGeometryCache: TrackGeometry | null = null;
function trackGeometry(): TrackGeometry {
  if (trackGeometryCache === null) trackGeometryCache = buildTrackGeometry(TRACK);
  return trackGeometryCache;
}

export function liveSimTrackLengthNm(): number {
  return trackGeometry().totalNm;
}

function pointAtDistanceNm(
  distNm: number,
  geo: TrackGeometry = trackGeometry(),
): { point: LatLon; cogDeg: number } {
  const total = geo.totalNm;
  const lastSegment = geo.segmentNm.length - 1;
  if (total <= 0 || lastSegment < 0) {
    return { point: geo.points[0], cogDeg: 0 };
  }
  let d = distNm % total;
  if (d < 0) d += total;
  for (let i = 0; i <= lastSegment; i++) {
    const segStart = geo.cumulativeNm[i];
    const segLen = geo.segmentNm[i];
    if (d <= segStart + segLen || i === lastSegment) {
      const t = segLen > 0 ? Math.min(1, Math.max(0, (d - segStart) / segLen)) : 0;
      const a = geo.points[i];
      const b = geo.points[i + 1];
      return {
        point: { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t },
        cogDeg: bearingDeg(a, b),
      };
    }
  }
  const last = geo.points[geo.points.length - 1];
  return { point: last, cogDeg: 0 };
}

// Deterministic (tick-indexed, no Math.random) so #143's jsdom coverage can
// pin exact values rather than a range — mirrors this repo's own
// "mutation-check new tests" convention: a seeded-random jitter would still
// be testable but a plain closed-form one is cheaper to verify by hand.
function jitterSogKn(tick: number): number {
  return Math.sin(tick * 0.37) * JITTER_SOG_KN;
}

function jitterCogDeg(tick: number): number {
  return Math.sin(tick * 0.53) * JITTER_COG_DEG;
}

function applyDrift(point: LatLon, cogDeg: number, tick: number): LatLon {
  const offsetNm = Math.min(DRIFT_GROWTH_NM_PER_TICK * tick, DRIFT_MAX_NM);
  if (offsetNm <= 0) return point;
  return destinationPoint(point, (cogDeg + 90) % 360, offsetNm);
}

export interface LiveSimTickResult {
  fix: GpsFix | null;
  // Non-null exactly when fix is null — mirrors watchPosition's onFix/onError
  // contract (one or the other per tick, never both, never neither).
  errorKind: GpsErrorKind | null;
}

export interface LiveSimTickParams {
  scenario: LiveSimScenario;
  speedMultiplier: number;
  tick: number;
  startDistNm: number;
  // #1486 review: when the active plan has a route, 'track'/'drift' follow
  // ITS leg polyline instead of the synthetic Flensburg loop — a leg vertex
  // list (start of leg 0, then each leg's end), the shape LiveView.tsx
  // derives from `legs`. Absent or shorter than 2 points falls back to the
  // synthetic loop (no plan yet).
  routePoints?: readonly LatLon[] | null;
}

/**
 * Pure per-tick fix computation — no timers, no module-level mutable state —
 * so it is fully deterministic given its inputs. The stateful driver
 * (LiveSimController below) is the only thing that owns a clock.
 */
export function computeLiveSimTick(params: LiveSimTickParams): LiveSimTickResult {
  const { scenario, speedMultiplier, tick, startDistNm, routePoints } = params;
  const geo =
    routePoints && routePoints.length >= 2 ? buildTrackGeometry(routePoints) : trackGeometry();

  if (scenario === 'dropout') {
    const cyclePos = tick % (DROPOUT_LIVE_TICKS + DROPOUT_DEAD_TICKS);
    if (cyclePos >= DROPOUT_LIVE_TICKS) {
      return { fix: null, errorKind: 'unavailable' };
    }
  }

  if (scenario === 'stop') {
    const { point } = pointAtDistanceNm(startDistNm, geo);
    return {
      fix: { point, cogDeg: null, sogKn: 0, accuracyM: NOMINAL_ACCURACY_M },
      errorKind: null,
    };
  }

  const elapsedSec = tick * (LIVE_SIM_TICK_MS / 1000) * speedMultiplier;
  const sogKn = Math.max(0, BASE_SOG_KN + jitterSogKn(tick));
  const elapsedNm = (elapsedSec / 3600) * sogKn;
  const { point: trackPoint, cogDeg: baseCogDeg } = pointAtDistanceNm(startDistNm + elapsedNm, geo);
  const cogDeg = (baseCogDeg + jitterCogDeg(tick) + 360) % 360;
  const point = scenario === 'drift' ? applyDrift(trackPoint, cogDeg, tick) : trackPoint;
  const accuracyM = scenario === 'degraded-accuracy' ? DEGRADED_ACCURACY_M : NOMINAL_ACCURACY_M;

  return { fix: { point, cogDeg, sogKn, accuracyM }, errorKind: null };
}

export function isLiveSimScenario(value: string | null): value is LiveSimScenario {
  return value !== null && (LIVE_SIM_SCENARIOS as readonly string[]).includes(value);
}

function currentSearch(): string {
  return typeof location === 'undefined' ? '' : location.search;
}

export function isLiveSimRequested(search: string = currentSearch()): boolean {
  return new URLSearchParams(search).has('liveSim');
}

export function liveSimScenarioFromSearch(search: string = currentSearch()): LiveSimScenario {
  const raw = new URLSearchParams(search).get('liveSim');
  return isLiveSimScenario(raw) ? raw : DEFAULT_SCENARIO;
}

export interface LiveSimState {
  scenario: LiveSimScenario;
  playing: boolean;
  speedMultiplier: number;
}

type FixListener = (fix: GpsFix) => void;
type ErrorListener = () => void;
type StateListener = (state: LiveSimState) => void;

/**
 * ONE ticking clock shared by every subscriber (both GPS seams, plus the
 * controls panel's own state readout) — spike §1.1's "cover both seams or
 * neither" requirement is only meaningful if there is exactly one simulated
 * position at a time, not two independently-clocked ones.
 */
class LiveSimController {
  private tick = 0;
  private startDistNm = 0;
  private routePoints: readonly LatLon[] | null = null;
  private state: LiveSimState = {
    scenario: DEFAULT_SCENARIO,
    playing: true,
    speedMultiplier: LIVE_SIM_DEFAULT_SPEED_MULTIPLIER,
  };
  private fixListeners = new Set<FixListener>();
  private errorListeners = new Set<ErrorListener>();
  private stateListeners = new Set<StateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  configureFromSearch(search: string): void {
    const scenario = liveSimScenarioFromSearch(search);
    if (scenario !== this.state.scenario) this.setScenario(scenario);
  }

  subscribe(onFix: FixListener, onError: ErrorListener): () => void {
    this.fixListeners.add(onFix);
    this.errorListeners.add(onError);
    if (this.state.playing) this.ensureTicking();
    this.emitCurrent();
    return () => {
      this.fixListeners.delete(onFix);
      this.errorListeners.delete(onError);
      if (this.fixListeners.size === 0) this.stopTicking();
    };
  }

  subscribeState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  getState(): LiveSimState {
    return this.state;
  }

  play(): void {
    this.setState({ playing: true });
    this.ensureTicking();
  }

  pause(): void {
    this.setState({ playing: false });
    this.stopTicking();
  }

  setSpeedMultiplier(n: number): void {
    const clamped = Math.min(MAX_SPEED_MULTIPLIER, Math.max(MIN_SPEED_MULTIPLIER, n));
    this.setState({ speedMultiplier: clamped });
  }

  setScenario(scenario: LiveSimScenario): void {
    this.tick = 0;
    this.setState({ scenario });
    this.emitCurrent();
  }

  jumpToFraction(fraction: number): void {
    const clamped = Math.min(1, Math.max(0, fraction));
    this.startDistNm = clamped * this.activeGeometry().totalNm;
    this.tick = 0;
    this.emitCurrent();
  }

  // #1486 review: the 'track' scenario must follow the ACTIVE plan's leg
  // polyline, not always the synthetic loop — set by LiveView.tsx whenever
  // its `legs` change (points null/too-short = no plan, falls back). Does
  // NOT reset tick/position: a plan swap while a simulator run is already
  // moving should keep the same elapsed distance, re-walked against the new
  // route, mirroring how a real GPS fix stream is unaffected by re-planning.
  setRoute(points: readonly LatLon[] | null): void {
    this.routePoints = points;
    this.emitCurrent();
  }

  private activeGeometry(): TrackGeometry {
    return this.routePoints && this.routePoints.length >= 2
      ? buildTrackGeometry(this.routePoints)
      : trackGeometry();
  }

  private setState(patch: Partial<LiveSimState>): void {
    this.state = { ...this.state, ...patch };
    this.stateListeners.forEach((l) => l(this.state));
  }

  private ensureTicking(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.advance(), LIVE_SIM_TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private advance(): void {
    this.tick += 1;
    this.emitCurrent();
  }

  private emitCurrent(): void {
    const result = computeLiveSimTick({
      scenario: this.state.scenario,
      speedMultiplier: this.state.speedMultiplier,
      tick: this.tick,
      startDistNm: this.startDistNm,
      routePoints: this.routePoints,
    });
    if (result.fix) {
      const fix = result.fix;
      this.fixListeners.forEach((l) => l(fix));
    } else {
      this.errorListeners.forEach((l) => l());
    }
  }
}

// Lazily constructed for the same reason trackGeometry() is (see its
// comment): a top-level `new LiveSimController()` is a module-level side
// effect Rollup cannot prove away, which alone was enough to keep this
// whole module in the production bundle. `getLiveSimController()` is the
// only way to reach the singleton; nothing outside this file may construct
// one directly.
let controllerInstance: LiveSimController | null = null;
export function getLiveSimController(): LiveSimController {
  if (controllerInstance === null) controllerInstance = new LiveSimController();
  return controllerInstance;
}

/**
 * watchPosition-shaped adapter: geolocation.ts's fold-exact gate calls this
 * instead of navigator.geolocation.watchPosition when a simulator run is
 * requested. Reads the scenario from the URL once per subscribe (query
 * params are static for a page's lifetime here — no live re-parsing needed).
 */
export function subscribeLiveSim(
  onFix: (fix: GpsFix) => void,
  onError: (kind: GpsErrorKind) => void,
): () => void {
  const controller = getLiveSimController();
  controller.configureFromSearch(currentSearch());
  return controller.subscribe(onFix, () => onError('unavailable'));
}
