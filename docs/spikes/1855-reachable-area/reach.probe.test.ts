// #1855 spike probe: destination-free front expansion over the real mask and
// polars. reach() re-implements solve()'s ring loop (isochrone.ts at the
// worktree's base) minus the destination terms, reusing its exported helpers.
// Select configs with SC_PROBE_ONLY=<comma list of ids>; results merge into
// SC_PROBE_OUT (default ./results.json) after every config.
import { it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { NavMask } from '../../../app/src/lib/mask';
import { Polar } from '../../../app/src/lib/polar';
import { WindField } from '../../../app/src/lib/wind';
import { uniformGate, approachGate, APPROACH_RADIUS_M } from '../../../app/src/lib/depthGate';
import type { DepthGate } from '../../../app/src/lib/depthGate';
import {
  destinationPointFrom,
  haversineNm,
  initialBearingDeg,
  initialBearingDegFrom,
  normalizeDeg180,
  preparePoint,
  haversineNmTo,
} from '../../../app/src/lib/geo';
import {
  sailCandidates,
  edgeFactor,
  pruneCellConfined,
  visitedDominates,
  stampVisited,
  defaultMaxFrontier,
  solve,
  type VisitedStamp,
} from '../../../app/src/routing/isochrone';
import { boardForCandidate, classifyManeuver } from '../../../app/src/routing/maneuver';
import { computeHarborAccess } from '../../../app/src/lib/harborReachability';
import { defaultSafetyDepthM, relaxationFloorM } from '../../../app/src/lib/boatDepth';
import { BOATS, boatById } from '../../../app/src/data/boats';
import { DEFAULT_SETTINGS } from '../../../app/src/types';
import type { LatLon, MaskMeta, PolarTable, Settings } from '../../../app/src/types';
import { uniformWindGrid } from '../../../app/src/test/fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../../../app/public/data');
const OUT = process.env.SC_PROBE_OUT ?? resolve(here, 'results.json');
const ONLY = (process.env.SC_PROBE_ONLY ?? '').split(',').filter(Boolean);

const meta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
const mask = new NavMask(meta, new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))));
const harbors = JSON.parse(readFileSync(resolve(dataDir, 'harbors.json'), 'utf8')) as Array<{
  id: string;
  snap: LatLon;
  knownDisconnected?: boolean;
}>;
const polarTable = (name: string) =>
  JSON.parse(readFileSync(resolve(dataDir, 'polars', name), 'utf8')) as PolarTable;
const harbor = (id: string) => {
  const h = harbors.find((x) => x.id === id);
  if (!h) throw new Error(`no harbour ${id}`);
  return h;
};

// Mirrors isochrone.ts's module-private constants at the worktree's base.
const MIN_SAIL_KN = 0.2;
const PRUNE_LAT = 0.002;
const PRUNE_LON = 0.003;
const CONFINED_PRUNE_DIV = 2;
const MOTOR_OFF_CONFINED_PRUNE_DIV = 3;
const CONFINEMENT_MARGIN_CELLS = 1;
const FORCED_MOTOR_HEADINGS = Array.from({ length: 36 }, (_, i) => i * 10);
const H = 3_600_000;

type Kind = 'sail' | 'motor' | 'start';
interface Node {
  lat: number;
  lon: number;
  tMs: number;
  costMs: number;
  kind: Kind;
  board: 'port' | 'starboard' | null;
  headingDeg: number;
  twaSigned: number;
  maneuvers: number;
  distToDestNm: number;
}

function better(a: Node, b: Node): boolean {
  if (a.costMs !== b.costMs) return a.costMs < b.costMs;
  if (a.maneuvers !== b.maneuvers) return a.maneuvers < b.maneuvers;
  if (a.distToDestNm !== b.distToDestNm) return a.distToDestNm < b.distToDestNm;
  if (a.headingDeg !== b.headingDeg) return a.headingDeg < b.headingDeg;
  return a.lat !== b.lat ? a.lat < b.lat : a.lon < b.lon;
}

interface ReachParams {
  origin: LatLon;
  departureMs: number;
  capMs: number;
  polar: Polar;
  wind: WindField;
  settings: Settings;
  gate: DepthGate;
  comfortDepthM: number | undefined;
  forcedMotor?: boolean;
  // Fidelity-control mode: replicate solve()'s direct-TWA candidate and
  // distance tie-break toward this point (never arrives).
  towards?: LatLon;
  maxRings?: number;
  marksH: number[];
}

function reach(p: ReachParams) {
  const t0 = performance.now();
  const { polar, wind, settings, gate, comfortDepthM } = p;
  const maxFrontier = defaultMaxFrontier(mask.meta);
  const motorEnabled = settings.motorEnabled;
  const sailFloorKn = motorEnabled
    ? Math.max(settings.motorThresholdKn, settings.motorSpeedKn - settings.sailPreferenceKn)
    : settings.motorThresholdKn;
  const towardsP = p.towards ? preparePoint(p.towards) : null;
  const dtS = 600;
  const confinedDiv = motorEnabled ? CONFINED_PRUNE_DIV : MOTOR_OFF_CONFINED_PRUNE_DIV;
  const confinedCells = new Map<string, boolean>();
  const keyOf = (lat: number, lon: number, kind: Kind, board: Node['board']): string => {
    const b = kind === 'motor' ? 'M' : board === 'port' ? 'P' : 'S';
    const li = Math.floor(lat / PRUNE_LAT);
    const lo = Math.floor(lon / PRUNE_LON);
    const cell = `${li}:${lo}`;
    let confined = confinedCells.get(cell);
    if (confined === undefined) {
      confined = pruneCellConfined(mask, gate, li, lo, CONFINEMENT_MARGIN_CELLS);
      confinedCells.set(cell, confined);
    }
    if (!confined) return `${cell}:${b}`;
    const k = confinedDiv;
    return `f${Math.floor((lat * k) / PRUNE_LAT)}:${Math.floor((lon * k) / PRUNE_LON)}:${b}`;
  };

  let frontier: Node[] = [
    {
      lat: p.origin.lat,
      lon: p.origin.lon,
      tMs: p.departureMs,
      costMs: p.departureMs,
      kind: 'start',
      board: null,
      headingDeg: NaN,
      twaSigned: NaN,
      maneuvers: 0,
      distToDestNm: towardsP ? haversineNmTo(p.origin, towardsP) : 0,
    },
  ];
  const visited = new Map<string, VisitedStamp>();
  // Coarse (board-agnostic) area cells: min true arrival and first ring.
  const cellMinT = new Map<string, number>();
  const cellFirstRing = new Map<string, number>();
  const cellFirstT = new Map<string, number>();
  let lateTLowered = 0; // a cell's min tMs lowered in a ring after its first
  let lateTLoweredMaxMs = 0;
  let lateCostLowered = 0; // a visited stamp's costMs lowered after first stamp
  const stampRing = new Map<string, number>();
  const rings: Array<{ ring: number; expanded: number; winners: number; kept: number; truncated: boolean }> = [];
  let expandedTotal = 0;
  let childrenTotal = 0;
  let truncatedRings = 0;
  const marks: Record<string, { rings: number; expanded: number; wallMs: number; cells: number; peakFrontier: number }> = {};
  const pendingMarks = [...p.marksH].sort((a, b) => a - b);
  let ring = 0;
  let peak = 1;
  let endReason = 'frontier-empty';

  while (frontier.length > 0) {
    if (p.maxRings !== undefined && ring >= p.maxRings) {
      endReason = 'max-rings';
      break;
    }
    let minTMs = Infinity;
    for (const n of frontier) if (n.tMs < minTMs) minTMs = n.tMs;
    if (minTMs + dtS * 1000 > p.capMs) {
      endReason = 'cap';
      break;
    }
    const byKey = new Map<string, Node>();
    for (const node of frontier) {
      expandedTotal++;
      const from = { lat: node.lat, lon: node.lon };
      const w = wind.sample(from, node.tMs);
      const fromP = preparePoint(from);
      const beat = polar.beatAngleDeg(w.speedKn);
      let candidates: number[];
      if (p.forcedMotor) {
        candidates = FORCED_MOTOR_HEADINGS;
      } else {
        // Destination-free: passing +beat as the direct TWA adds nothing.
        const direct = towardsP
          ? normalizeDeg180(w.dirFromDeg - initialBearingDegFrom(fromP, towardsP))
          : beat;
        candidates = sailCandidates(beat, polar.gybeAngleDeg(w.speedKn), motorEnabled, direct);
      }
      const twsBracket = polar.bracketTws(w.speedKn);
      for (const candidate of candidates) {
        let headingDeg: number;
        let twa: number;
        let kind: 'sail' | 'motor';
        let speed: number;
        if (p.forcedMotor) {
          headingDeg = candidate;
          twa = NaN;
          kind = 'motor';
          speed = settings.motorSpeedKn;
        } else {
          twa = candidate;
          headingDeg = (((w.dirFromDeg - twa) % 360) + 360) % 360;
          const sailSpeed = polar.speedKnAt(twa, twsBracket);
          if (sailSpeed >= sailFloorKn) {
            kind = 'sail';
            speed = sailSpeed;
          } else if (motorEnabled) {
            kind = 'motor';
            speed = settings.motorSpeedKn;
          } else if (sailSpeed >= MIN_SAIL_KN) {
            kind = 'sail';
            speed = sailSpeed;
          } else continue;
        }
        const board = kind === 'sail' ? boardForCandidate(twa, node.board) : null;
        let maneuver = null as ReturnType<typeof classifyManeuver> | null;
        let effS = dtS;
        if (kind === 'sail' && node.kind === 'sail' && node.board && board !== node.board) {
          maneuver = classifyManeuver(node.twaSigned, twa);
          effS = Math.max(dtS - settings.maneuverPenaltyS, 0);
        }
        const distNm = (speed * effS) / 3600;
        if (distNm <= 0) continue;
        let stepMs = dtS * 1000;
        let end = destinationPointFrom(fromP, headingDeg, distNm);
        let factor = edgeFactor(mask, from, end, gate, comfortDepthM);
        if (factor === null) {
          for (const div of [2, 4, 8]) {
            const subDtS = dtS / div;
            const subEffS = maneuver ? Math.max(subDtS - settings.maneuverPenaltyS, 0) : subDtS;
            const d = (speed * subEffS) / 3600;
            if (d <= 0) break;
            const e = destinationPointFrom(fromP, headingDeg, d);
            const f = edgeFactor(mask, from, e, gate, comfortDepthM);
            if (f !== null) {
              end = e;
              stepMs = subDtS * 1000;
              factor = f;
              break;
            }
          }
          if (factor === null) continue;
        }
        if (node.tMs + stepMs > p.capMs) continue;
        childrenTotal++;
        const child: Node = {
          lat: end.lat,
          lon: end.lon,
          tMs: node.tMs + stepMs,
          costMs: node.costMs + stepMs / factor,
          kind,
          board,
          headingDeg,
          twaSigned: kind === 'motor' ? NaN : twa,
          maneuvers: node.maneuvers + (maneuver ? 1 : 0),
          distToDestNm: towardsP ? haversineNmTo(end, towardsP) : 0,
        };
        const key = keyOf(child.lat, child.lon, child.kind, child.board);
        const seen = visited.get(key);
        if (seen !== undefined && visitedDominates(seen, child)) continue;
        const inc = byKey.get(key);
        if (!inc || better(child, inc)) byKey.set(key, child);
      }
    }
    let next = [...byKey.values()];
    const winners = next.length;
    let truncated = false;
    if (next.length > maxFrontier) {
      next.sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
      next = next.slice(0, maxFrontier);
      truncated = true;
      truncatedRings++;
    }
    for (const n of next) {
      const k = keyOf(n.lat, n.lon, n.kind, n.board);
      const seen = visited.get(k);
      if (seen !== undefined && n.costMs < seen.costMs && (stampRing.get(k) ?? ring) < ring) lateCostLowered++;
      if (!stampRing.has(k)) stampRing.set(k, ring);
      stampVisited(visited, k, { costMs: n.costMs, maneuvers: n.maneuvers });
      const c = `${Math.floor(n.lat / PRUNE_LAT)}:${Math.floor(n.lon / PRUNE_LON)}`;
      const prev = cellMinT.get(c);
      if (prev === undefined) {
        cellMinT.set(c, n.tMs);
        cellFirstRing.set(c, ring);
        cellFirstT.set(c, n.tMs);
      } else if (n.tMs < prev) {
        if ((cellFirstRing.get(c) ?? ring) < ring) {
          lateTLowered++;
          lateTLoweredMaxMs = Math.max(lateTLoweredMaxMs, prev - n.tMs);
        }
        cellMinT.set(c, n.tMs);
      }
    }
    frontier = next;
    if (frontier.length > peak) peak = frontier.length;
    rings.push({ ring, expanded: rings.length === 0 ? 1 : rings[rings.length - 1].kept, winners, kept: next.length, truncated });
    ring++;
    const ringClock = p.departureMs + ring * dtS * 1000;
    while (pendingMarks.length > 0 && ringClock >= p.departureMs + pendingMarks[0] * H) {
      const h = pendingMarks.shift()!;
      let cells = 0;
      for (const t of cellMinT.values()) if (t <= p.departureMs + h * H) cells++;
      marks[`${h}h`] = { rings: ring, expanded: expandedTotal, wallMs: Math.round(performance.now() - t0), cells, peakFrontier: peak };
    }
  }
  // Per cell: how far its final min tMs sits below the min at the end of its first ring.
  const lateCells = { lowered: 0, over5min: 0, over15min: 0, over30min: 0 };
  for (const [c, t] of cellMinT) {
    const d = (cellFirstT.get(c) ?? t) - t;
    if (d > 0) lateCells.lowered++;
    if (d > 5 * 60_000) lateCells.over5min++;
    if (d > 15 * 60_000) lateCells.over15min++;
    if (d > 30 * 60_000) lateCells.over30min++;
  }
  return {
    lateCells,
    endReason,
    rings: ring,
    expandedTotal,
    childrenTotal,
    peakFrontier: peak,
    maxFrontier,
    truncatedRings,
    lateTLowered,
    lateTLoweredMaxMs,
    lateCostLowered,
    visitedKeys: visited.size,
    areaCells: cellMinT.size,
    marks,
    wallMs: Math.round(performance.now() - t0),
    ringSizes: rings.map((r) => r.kept),
    cellMinT,
  };
}

/** Max great-circle reach per 10-degree sector within `hours`, from origin. */
function sectors(origin: LatLon, cellMinT: Map<string, number>, departureMs: number, hours: number) {
  const out = new Array<number>(36).fill(0);
  let cells = 0;
  let areaNm2 = 0;
  for (const [c, t] of cellMinT) {
    if (t > departureMs + hours * H) continue;
    const [li, lo] = c.split(':').map(Number);
    const p = { lat: (li + 0.5) * PRUNE_LAT, lon: (lo + 0.5) * PRUNE_LON };
    const d = haversineNm(origin, p);
    const s = Math.floor((((initialBearingDeg(origin, p) % 360) + 360) % 360) / 10) % 36;
    if (d > out[s]) out[s] = d;
    cells++;
    areaNm2 += PRUNE_LAT * 60 * PRUNE_LON * 60 * Math.cos((p.lat * Math.PI) / 180);
  }
  return { maxNmBySector: out.map((x) => Math.round(x * 10) / 10), cells, areaNm2: Math.round(areaNm2) };
}

function load(): Record<string, unknown> {
  return existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>) : {};
}
function save(key: string, value: unknown) {
  const r = load();
  r[key] = value;
  writeFileSync(OUT, JSON.stringify(r, null, 2));
}

const wanted = (id: string) => ONLY.length === 0 || ONLY.includes(id);
const S45 = boatById('salona-45');
const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);

it('M3 harbour access per boat at its own default gate', () => {
  if (!wanted('m3')) return;
  const perBoat: Record<string, unknown> = {};
  for (const boat of BOATS) {
    const gateM = defaultSafetyDepthM(boat);
    const acc = computeHarborAccess(mask, harbors, boat, gateM);
    const counts: Record<string, number> = {};
    const shallow: string[] = [];
    const unreachable: string[] = [];
    for (const [id, st] of acc) {
      counts[st] = (counts[st] ?? 0) + 1;
      if (st === 'shallow-approach') shallow.push(id);
      if (st === 'unreachable') unreachable.push(id);
    }
    const origins: Record<string, unknown> = {};
    for (const id of ['flensburg', 'soenderborg', 'marstal']) {
      const snapped = mask.snapToNavigable(harbor(id).snap, gateM);
      origins[id] = { state: acc.get(id), snapped: snapped !== null };
    }
    perBoat[boat.id] = {
      gateM,
      relaxationFloorM: relaxationFloorM(boat),
      harbours: acc.size,
      counts,
      shallowApproach: shallow,
      unreachable,
      origins,
    };
  }
  save('m3', { basis: 'computeHarborAccess (SEED_POINT flood at the boat default gate)', perBoat });
});

interface Cfg {
  id: string;
  origin: string;
  rig: 'genoa' | 'fock';
  tws: number;
  settings?: Partial<Settings>;
  forcedMotor?: boolean;
  originDisc?: boolean;
  capH: number;
}

const CFGS: Cfg[] = [
  { id: 'flens-genoa-12', origin: 'flensburg', rig: 'genoa', tws: 12, capH: 10 },
  { id: 'flens-fock-12', origin: 'flensburg', rig: 'fock', tws: 12, capH: 10 },
  { id: 'sonder-genoa-12', origin: 'soenderborg', rig: 'genoa', tws: 12, capH: 10 },
  { id: 'sonder-fock-12', origin: 'soenderborg', rig: 'fock', tws: 12, capH: 10 },
  { id: 'marstal-genoa-12', origin: 'marstal', rig: 'genoa', tws: 12, capH: 10 },
  { id: 'marstal-genoa-12-disc', origin: 'marstal', rig: 'genoa', tws: 12, capH: 10, originDisc: true },
  { id: 'sonder-genoa-12-cap6', origin: 'soenderborg', rig: 'genoa', tws: 12, capH: 6 },
  { id: 'sonder-genoa-12-motoroff', origin: 'soenderborg', rig: 'genoa', tws: 12, capH: 6, settings: { motorEnabled: false } },
  { id: 'sonder-motoronly', origin: 'soenderborg', rig: 'genoa', tws: 12, capH: 6, forcedMotor: true },
  { id: 'sonder-genoa-12-comfortoff', origin: 'soenderborg', rig: 'genoa', tws: 12, capH: 6, settings: { depthComfortMarginM: 0 } },
  { id: 'sonder-genoa-6', origin: 'soenderborg', rig: 'genoa', tws: 6, capH: 6 },
  { id: 'sonder-genoa-6-motoroff', origin: 'soenderborg', rig: 'genoa', tws: 6, capH: 6, settings: { motorEnabled: false } },
];

for (const cfg of CFGS) {
  it(`reach ${cfg.id}`, () => {
    if (!wanted(cfg.id)) return;
    const settings: Settings = { ...DEFAULT_SETTINGS, ...cfg.settings };
    const gateM = settings.safetyDepthM;
    const origin = mask.snapToNavigable(harbor(cfg.origin).snap, gateM);
    if (!origin) {
      save(cfg.id, { error: 'snap-failed' });
      return;
    }
    const gate = cfg.originDisc
      ? approachGate(mask.meta, [origin], gateM, [relaxationFloorM(S45)], APPROACH_RADIUS_M)
      : uniformGate(gateM);
    const comfortDepthM =
      settings.depthComfortMarginM > 0 ? gateM + settings.depthComfortMarginM : undefined;
    const wind = new WindField(uniformWindGrid(cfg.tws, 225, { hours: 48 }), mask.meta);
    const polar = new Polar(polarTable(`salona-45-${cfg.rig}.json`), settings.performanceFactor);
    const r = reach({
      origin,
      departureMs: T0,
      capMs: T0 + cfg.capH * H,
      polar,
      wind,
      settings,
      gate,
      comfortDepthM,
      forcedMotor: cfg.forcedMotor,
      marksH: [2, 4, 6, 8, 10].filter((h) => h <= cfg.capH),
    });
    const { cellMinT, ...rest } = r;
    const sect: Record<string, unknown> = {};
    for (const h of [2, 4, 6, 10].filter((x) => x <= cfg.capH)) sect[`${h}h`] = sectors(origin, cellMinT, T0, h);
    save(cfg.id, {
      cfg: { ...cfg, gateM, comfortDepthM, windDirFromDeg: 225, boat: S45.id },
      origin,
      ...rest,
      sectors: sect,
      loadavg: readFileSync('/proc/loadavg', 'utf8').trim(),
    });
  });
}

it('fidelity control: reach(towards) vs solve() frontier sizes over 12 rings', () => {
  if (!wanted('fidelity')) return;
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const gateM = settings.safetyDepthM;
  const origin = mask.snapToNavigable(harbor('flensburg').snap, gateM)!;
  const dest = mask.snapToNavigable(harbor('marstal').snap, gateM)!;
  const wind = new WindField(uniformWindGrid(12, 225, { hours: 48 }), mask.meta);
  const polar = new Polar(polarTable('salona-45-genoa.json'), settings.performanceFactor);
  const comfortDepthM = gateM + settings.depthComfortMarginM;
  const N = 12;
  const solveSizes: number[] = [];
  solve({
    origin,
    destination: dest,
    departureMs: T0,
    polar,
    wind,
    mask,
    settings,
    comfortDepthM,
    onProgress: (i) => solveSizes.push(i.frontierSize),
    deadline: { expired: () => solveSizes.length >= N },
  });
  const r = reach({
    origin,
    departureMs: T0,
    capMs: T0 + 47 * H,
    polar,
    wind,
    settings,
    gate: uniformGate(gateM),
    comfortDepthM,
    towards: dest,
    maxRings: N,
    marksH: [],
  });
  const noTowards = reach({
    origin,
    departureMs: T0,
    capMs: T0 + 47 * H,
    polar,
    wind,
    settings,
    gate: uniformGate(gateM),
    comfortDepthM,
    maxRings: N,
    marksH: [],
  });
  save('fidelity', {
    rings: N,
    solveSizes,
    reachTowardsSizes: r.ringSizes,
    identical: JSON.stringify(solveSizes) === JSON.stringify(r.ringSizes),
    reachDestinationFreeSizes: noTowards.ringSizes,
  });
});
