// #849 part (a): local import/export for plans, settings and saved
// waypoints — a versioned, self-describing snapshot file the user can save
// to disk and load back. This is the whole of part (a); cloud sync
// (part (b): OneDrive et al.) is explicitly OUT OF SCOPE here — it needs a
// registered OAuth client id, a `connect-src` CSP change and a
// conflict-resolution design, none of which this file attempts.
//
// DELIBERATELY NOT IN types.ts. The envelope shape is a transport/
// presentation concern (how a snapshot is written to and read from a
// file), not a domain type the solver's dependency graph reaches — and
// `app/src/types.ts` sits IN the `app/sweep/` #282 acceptance-harness
// closure (`sweepArms.ts` imports `DEFAULT_SETTINGS` from it), so any edit
// there owes a full BASE-double-run + comparison sweep. This module stays
// outside that closure entirely: it only ever `import type`s `Plan` and
// `Settings` from types.ts (never adds to it) and reuses
// `services/migratePlan.ts`'s existing tolerant plan normaliser rather than
// writing a second one.
//
// THE WIND-GRID DECISION (the one design question CLAUDE.md/the #849 issue
// call out explicitly: "Plan is structured-clone-safe ... but NOT
// JSON-safe ... file export needs a dedicated serializer"). This serializer
// KEEPS the wind grid on export, base64-encoding each Float32Array field
// rather than dropping it. Rationale: a saved route must always render
// against the forecast it was computed from, never a re-fetched one
// (CLAUDE.md, Domain rules, "Wind grids are stored with each plan"), and an
// import is exactly a second write path into the same `plans` store a save
// already uses — dropping the grid would either leave a re-imported plan
// with NO forecast to render against, or invite silently re-fetching a
// DIFFERENT hour's data, either of which breaks that invariant. So a
// round-tripped plan reopens byte-for-byte as it looked the day it was
// exported, at the cost of file size: an hourly Open-Meteo grid over
// several forecast days is the bulk of each plan's exported size (see
// `encodeWindGrid` below for the actual encoding). That cost is accepted
// deliberately, per plan, rather than degrading fidelity for every export.
import { migratePlan } from '../services/migratePlan';
import type { SavedWaypoint } from '../services/db';
import type { Plan, Settings, WindGrid } from '../types';
import { windGridCoversBounds, type WindLatticeCoverageBounds } from './wind';

/** Bumped whenever the ENVELOPE shape changes (settings/waypoints presence,
 * wind-grid encoding) — independent of `types.ts`'s `PLAN_SCHEMA_VERSION`,
 * which versions one PLAN record and is unaffected by this file. A newer
 * envelope than this build understands is rejected outright (see
 * `parseExportFile`'s `unsupported-version`), never shape-sniffed. */
export const EXPORT_SCHEMA_VERSION = 1;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// `[].every(...)` is VACUOUSLY TRUE (CLAUDE.md's documented `[]`-defeats-
// truthiness class) — an empty `lats`/`lons`/`timesMs` axis would otherwise
// pass this check silently, so `nonEmpty` guards it as a SEPARATE, explicit
// step rather than folding a length check into the predicate (which would
// re-hide the same failure mode one call site later).
function isNumberArray(x: unknown): x is number[] {
  return Array.isArray(x) && x.every((v) => typeof v === 'number');
}

function nonEmpty(x: number[]): boolean {
  return x.length > 0;
}

// base64-encodes a Float32Array's raw bytes. Chunked `String.fromCharCode`
// (rather than one `.apply`/spread over the whole byte array) so a large
// grid — the multi-forecast-day case this file's header comment warns
// about — cannot blow the call-stack argument limit some engines impose on
// a single spread/apply call.
const BASE64_CHUNK_BYTES = 0x8000;

function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

// Inverse of float32ToBase64. Throws (atob on malformed base64, or a
// non-multiple-of-4 byte length reaching the Float32Array constructor) on
// bad input — callers over untrusted import data must catch this
// themselves; see decodeWindGrid below.
function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** The JSON-safe, on-disk shape of a `WindGrid` — identical field set, with
 * the three `Float32Array` fields replaced by their base64 encoding. */
export interface ExportedWindGrid {
  lats: number[];
  lons: number[];
  timesMs: number[];
  speedKn: string;
  dirFromDeg: string;
  gustKn: string;
  fetchedAtMs: number;
  model: string;
}

function encodeWindGrid(grid: WindGrid): ExportedWindGrid {
  return {
    lats: grid.lats,
    lons: grid.lons,
    timesMs: grid.timesMs,
    speedKn: float32ToBase64(grid.speedKn),
    dirFromDeg: float32ToBase64(grid.dirFromDeg),
    gustKn: float32ToBase64(grid.gustKn),
    fetchedAtMs: grid.fetchedAtMs,
    model: grid.model,
  };
}

// Returns null (never throws) on any malformed shape or undecodable
// base64 — an imported file is untrusted input, and one damaged plan must
// not abort the whole import (mirrors services/db.ts's own "one corrupt
// record must not blank the list" philosophy for listPlans).
//
// MAJOR (review round 1, both reviewers independently): this function must
// enforce the EXACT dimension invariant `lib/wind.ts`'s `WindField`
// constructor enforces by THROWING —
// `speedKn.length === timesMs.length * lats.length * lons.length` (ditto
// dirFromDeg/gustKn) — before this file's own trust boundary, not after.
// `migratePlan`'s windGrid pass-through is deliberately UNVALIDATED, and
// correctly so: it trusts a structured-clone-native IndexedDB record this
// app itself wrote. That trust does NOT transfer here — an import feeds
// this function a windGrid reconstructed from arbitrary JSON, so a
// dimension mismatch (e.g. a truncated `lats` left beside an un-truncated
// `speedKn`) must be caught HERE, as a decode failure (null, counted by
// the caller), rather than surviving into a persisted plan that later
// crashes `new WindField(...)` uncaught inside a `useMemo`
// (`DepthProfile.tsx`, `DepartureCompare.tsx`, `lib/routeGeoJson.ts`) —
// `app/src` has no ErrorBoundary, so that takes the whole React root down,
// not just the one plan.
//
// #1178 MAJOR (PR #1182 review): an imported plan bypasses `planRoute.ts`
// entirely — SettingsPanel.tsx's import handler -> parseExportFile ->
// decodeWindGrid -> migratePlan -> savePlan(p) never constructs a
// `WindField` at all, so `wind.ts`'s own construction-time domain-coverage
// assertion (see that file's doc comment) NEVER RUNS for this path. A
// spatially narrow but dimension-consistent imported windGrid would
// therefore reach DepthProfile.tsx/DepartureCompare.tsx/routeGeoJson.ts's
// "already validated" WindField constructions completely unvalidated —
// exactly the #1178 hazard this whole feature exists to close, reachable
// by a user through Settings -> Import backup. `maskBounds` closes it HERE,
// at the same trust boundary the dimension check above already guards: an
// imported grid failing coverage is treated exactly like any other
// malformed windGrid — null, counted as an invalid plan, the rest of the
// import proceeds. Optional (mirrors `WindField`'s own optional
// `maskBounds`) so every EXISTING unit test in planExport.test.ts, which
// calls `parseExportFile` with no mask context at all, is unaffected;
// SettingsPanel.tsx's real import handler is the one call site that must
// supply it.
function decodeWindGrid(raw: unknown, maskBounds?: WindLatticeCoverageBounds): WindGrid | null {
  if (!isRecord(raw)) return null;
  const { lats, lons, timesMs, speedKn, dirFromDeg, gustKn, fetchedAtMs, model } = raw;
  if (!isNumberArray(lats) || !isNumberArray(lons) || !isNumberArray(timesMs)) return null;
  // `[]`-defeats-`.every()`: an empty axis passes isNumberArray vacuously.
  if (!nonEmpty(lats) || !nonEmpty(lons) || !nonEmpty(timesMs)) return null;
  if (typeof speedKn !== 'string' || typeof dirFromDeg !== 'string' || typeof gustKn !== 'string')
    return null;
  if (typeof fetchedAtMs !== 'number' || typeof model !== 'string') return null;
  if (maskBounds && !windGridCoversBounds({ lats, lons }, maskBounds)) return null;
  try {
    const decodedSpeedKn = base64ToFloat32(speedKn);
    const decodedDirFromDeg = base64ToFloat32(dirFromDeg);
    const decodedGustKn = base64ToFloat32(gustKn);
    // The exact check WindField's own constructor performs (wind.ts) —
    // duplicated deliberately rather than imported, so this decoder can
    // reject a bad grid BEFORE it is ever handed to WindField, at the
    // point where rejection means "skip this plan" rather than "crash".
    const expected = timesMs.length * lats.length * lons.length;
    if (
      decodedSpeedKn.length !== expected ||
      decodedDirFromDeg.length !== expected ||
      decodedGustKn.length !== expected
    )
      return null;
    return {
      lats,
      lons,
      timesMs,
      speedKn: decodedSpeedKn,
      dirFromDeg: decodedDirFromDeg,
      gustKn: decodedGustKn,
      fetchedAtMs,
      model,
    };
  } catch {
    return null;
  }
}

/** The JSON-safe, on-disk shape of a `Plan` — every field identical except
 * `windGrid`. */
export type ExportedPlan = Omit<Plan, 'windGrid'> & { windGrid: ExportedWindGrid };

/** The whole exported file's shape. `settings`/`waypoints` are independent
 * of `plans` — a user may export with zero saved plans, e.g. to back up
 * just their saved waypoints. */
export interface ExportEnvelope {
  schemaVersion: number;
  exportedAtMs: number;
  plans: ExportedPlan[];
  settings: Settings | null;
  waypoints: SavedWaypoint[];
}

/** Builds the envelope from live app state. Takes plain arrays/values — the
 * caller (SettingsPanel.tsx) is responsible for gathering them from
 * services/db.ts and the live Settings prop; this function does no I/O so
 * it stays trivially unit-testable. */
export function buildExportEnvelope(
  plans: readonly Plan[],
  settings: Settings | null,
  waypoints: readonly SavedWaypoint[],
): ExportEnvelope {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAtMs: Date.now(),
    plans: plans.map((p) => ({ ...p, windGrid: encodeWindGrid(p.windGrid) })),
    settings,
    waypoints: [...waypoints],
  };
}

export function exportEnvelopeToJson(envelope: ExportEnvelope): string {
  return JSON.stringify(envelope);
}

/** A stable, sortable filename — ISO timestamp with `:`/`.` swapped for `-`
 * so it is a valid filename on every OS this PWA installs on. */
export function exportFileName(nowMs: number): string {
  return `sailcommand-export-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}.json`;
}

/** Rejection reasons for a fundamentally unreadable import FILE — never for
 * one damaged plan or waypoint inside an otherwise-good file (those are
 * counted and skipped; see ImportResult). Mirrors
 * services/db.ts PlanSummary's 'newer-version'/'damaged' split, one level
 * up: 'unsupported-version' is a file too new for this build to read
 * (never assume it is corrupt), 'not-json'/'not-envelope' are genuinely
 * malformed input. */
export type ImportRejectReason = 'not-json' | 'not-envelope' | 'unsupported-version';

/** Thrown by parseExportFile only for a file this build cannot make any
 * sense of at all. A per-item defect (one bad plan, one bad waypoint)
 * never throws — see ImportResult's invalid* counts. */
export class ImportParseError extends Error {
  readonly reason: ImportRejectReason;
  constructor(reason: ImportRejectReason) {
    super(`SailCommand export file rejected: ${reason}`);
    this.name = 'ImportParseError';
    this.reason = reason;
  }
}

export interface ImportResult {
  plans: Plan[];
  invalidPlanCount: number;
  settings: Settings | null;
  waypoints: SavedWaypoint[];
  invalidWaypointCount: number;
}

function isSavedWaypoint(x: unknown): x is SavedWaypoint {
  return (
    isRecord(x) &&
    typeof x.id === 'string' &&
    typeof x.name === 'string' &&
    typeof x.lat === 'number' &&
    typeof x.lon === 'number' &&
    typeof x.createdAtMs === 'number'
  );
}

// Every REQUIRED Settings field (mirrors types.ts's own field list; kept in
// sync by hand since this file deliberately never imports DEFAULT_SETTINGS
// as a VALUE from types.ts — only `import type`). `aisApiKey` is optional
// (exactOptionalPropertyTypes) and checked separately below.
const REQUIRED_SETTINGS_NUMBER_FIELDS = [
  'safetyDepthM',
  'depthComfortMarginM',
  'motorSpeedKn',
  'motorThresholdKn',
  'sailPreferenceKn',
  'maneuverPenaltyS',
  'performanceFactor',
] as const;

function isSettingsLike(x: unknown): x is Settings {
  if (!isRecord(x)) return false;
  for (const key of REQUIRED_SETTINGS_NUMBER_FIELDS) {
    const v = x[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  if (typeof x.motorEnabled !== 'boolean') return false;
  if (typeof x.showOwnship !== 'boolean') return false;
  // Object.hasOwn, never `in` (CLAUDE.md: `in` walks the prototype chain and
  // is unsafe as a membership test against untrusted input) — not a lookup
  // table here, but the same discipline: x is parsed JSON from a file, so
  // its shape is exactly as untrusted as a stored/imported plan record.
  if (Object.hasOwn(x, 'aisApiKey') && typeof x.aisApiKey !== 'string') return false;
  return true;
}

// Rebuilds a structured-clone-shaped candidate (a REAL WindGrid with
// Float32Array fields, not the base64 strings the file stores) and hands it
// to the SAME tolerant normaliser the app already trusts for a foreign/
// damaged IndexedDB record (services/migratePlan.ts, #54 spec §I.3) —
// deliberately not a second hand-rolled plan validator. An imported plan is
// untrusted input in exactly the way a foreign IndexedDB record is, so it
// gets identical schemaVersion dispatch, boat-catalogue validation and
// forward/backward-compatibility handling.
function decodePlan(raw: unknown, maskBounds?: WindLatticeCoverageBounds): Plan | null {
  if (!isRecord(raw)) return null;
  const windGrid = decodeWindGrid(raw.windGrid, maskBounds);
  if (windGrid === null) return null;
  return migratePlan({ ...raw, windGrid });
}

/**
 * Parses a previously-exported file's text back into plans/settings/
 * waypoints ready to persist. Throws {@link ImportParseError} only when the
 * FILE ITSELF is unreadable (not JSON, not an envelope object, or a
 * schemaVersion newer than this build supports); a single damaged plan or
 * waypoint INSIDE an otherwise-good file is counted and skipped, never
 * fatal to the rest of the import — the same "one corrupt record must not
 * blank the whole list" principle services/db.ts's listPlans applies.
 *
 * `maskBounds` is OPTIONAL — see `decodeWindGrid`'s own #1178 comment for
 * why: it lets `SettingsPanel.tsx` reject a spatially narrow imported
 * windGrid (counted as an invalid plan) while leaving every plain-call
 * test in `planExport.test.ts` unaffected. Pass `mask?.meta` from
 * `useNavMask()` — `undefined` while the mask is still loading skips the
 * check exactly as `WindField`'s own constructor does.
 */
export function parseExportFile(
  text: string,
  maskBounds?: WindLatticeCoverageBounds,
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportParseError('not-json');
  }
  if (!isRecord(parsed)) throw new ImportParseError('not-envelope');
  const schemaVersion = parsed.schemaVersion;
  if (typeof schemaVersion !== 'number') throw new ImportParseError('not-envelope');
  if (schemaVersion > EXPORT_SCHEMA_VERSION) throw new ImportParseError('unsupported-version');

  const rawPlans: unknown[] = Array.isArray(parsed.plans) ? parsed.plans : [];
  const rawWaypoints: unknown[] = Array.isArray(parsed.waypoints) ? parsed.waypoints : [];

  const plans: Plan[] = [];
  let invalidPlanCount = 0;
  for (const rawPlan of rawPlans) {
    const plan = decodePlan(rawPlan, maskBounds);
    if (plan === null) invalidPlanCount++;
    else plans.push(plan);
  }

  const waypoints: SavedWaypoint[] = [];
  let invalidWaypointCount = 0;
  for (const rawWaypoint of rawWaypoints) {
    if (isSavedWaypoint(rawWaypoint)) waypoints.push(rawWaypoint);
    else invalidWaypointCount++;
  }

  const settings = isSettingsLike(parsed.settings) ? parsed.settings : null;

  return { plans, invalidPlanCount, settings, waypoints, invalidWaypointCount };
}
