import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Polar } from '../lib/polar';

// Spec §P.3/§P.4/§P.10 items 1 and 6-11. Expected values come from the committed
// sources, the spec's own figures, or an independent SciPy PchipInterpolator
// derivation — never from the generator's output.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PIPELINE = join(REPO, 'pipeline');
const GEN = join(PIPELINE, 'derive_orc_polars.mjs');
const SOURCES = join(PIPELINE, 'orc-sources');
const CERT_FILE = 'orc-ns-tur-santa-anastasia-2026.json';
const PG_FILE = 'orc-vpp111-salona44-cro2009-polargraph.json';

interface Anchor {
  label: string;
  twa: number;
  tws: number;
  minKn: number;
  maxKn: number;
  source: string;
}
interface AngleTable {
  tws: number[];
  angle: number[];
}
interface EmittedSail {
  provenance: { tier: string; note: string };
  derivation: unknown;
  speeds: number[][];
}
interface EmittedBoat {
  id: string;
  name: string;
  draftM: number;
  validation: { maxSpeedKn: number; maxSpeedKnSource: string; anchors: Anchor[] };
  tws: number[];
  twa: number[];
  beat: AngleTable;
  gybe: AngleTable;
  sails: { genoa: EmittedSail; fock: EmittedSail };
}
interface CertRecord {
  RefNo: string;
  YachtName: string;
  SailNo: string;
  Draft: number;
  Area_Jib: number;
  Area_Main: number;
  Allowances: Record<string, number[]>;
}
interface PolargraphCell {
  twa: number;
  tag: string;
  btv: number;
}

const certText = readFileSync(join(SOURCES, CERT_FILE), 'utf8');
const record = (JSON.parse(certText) as { record: CertRecord }).record;
const A = record.Allowances;
const polargraph = JSON.parse(readFileSync(join(SOURCES, PG_FILE), 'utf8')) as {
  tws: number[];
  jib: Record<string, PolargraphCell[]>;
};
const salona45 = (
  JSON.parse(readFileSync(join(PIPELINE, 'polars-source.json'), 'utf8')) as {
    boats: {
      id: string;
      tws: number[];
      twa: number[];
      sails: Record<string, { speeds: number[][] }>;
    }[];
  }
).boats.find((b) => b.id === 'salona-45')!;

const round2 = (x: number): number => Math.round(x * 100) / 100;
const deg = (a: number): number => (a * Math.PI) / 180;

function run(args: string[]): { ok: boolean; output: string } {
  try {
    const stdout = execFileSync('node', [GEN, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: stdout };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** The certificate column a grid TWS reads: its own, or the last one held above it. */
function certCol(tws: number): number {
  const ws = A.WindSpeeds!;
  const j = ws.indexOf(tws);
  return j >= 0 ? j : ws.length - 1;
}

const scratchRoots: string[] = [];
afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

function scratchSources(mutate?: (rec: CertRecord) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-orc-'));
  scratchRoots.push(root);
  const dir = join(root, 'orc-sources');
  cpSync(SOURCES, dir, { recursive: true });
  if (mutate) {
    const env = JSON.parse(readFileSync(join(dir, CERT_FILE), 'utf8')) as { record: CertRecord };
    mutate(env.record);
    writeFileSync(join(dir, CERT_FILE), JSON.stringify(env));
  }
  return dir;
}

let boat: EmittedBoat;
let fock: number[][];
let genoa: number[][];
const at = (t: number[][], twa: number, tws: number): number =>
  t[boat.twa.indexOf(twa)]![boat.tws.indexOf(tws)]!;

beforeAll(() => {
  const r = run(['--emit-boat', 'salona-44-easy-go']);
  expect(r.output).not.toBe('');
  expect(r.ok, r.output).toBe(true);
  boat = JSON.parse(r.output) as EmittedBoat;
  fock = boat.sails.fock.speeds;
  genoa = boat.sails.genoa.speeds;
});

describe('derive_orc_polars.mjs — EASY GO! fock (orc-ns-cert-rows-v1)', () => {
  it('--check exits 0 and names each table (P.10 item 1)', () => {
    const r = run(['--check']);
    expect(r.ok, r.output).toBe(true);
    expect(r.output).toContain('salona-44-easy-go/fock');
    expect(r.output).toContain('salona-44-easy-go/genoa');
  });

  it('emits 15 x 9 tables on the Salona 45 grid (P.10 item 6)', () => {
    expect(boat.tws).toEqual([4, 6, 8, 10, 12, 14, 16, 20, 25]);
    expect(boat.twa).toEqual([35, 40, 45, 52, 60, 70, 80, 90, 100, 110, 120, 135, 150, 165, 180]);
    expect(boat.tws).toEqual(salona45.tws);
    expect(boat.twa).toEqual(salona45.twa);
    for (const t of [fock, genoa]) {
      expect(t).toHaveLength(15);
      for (const row of t) expect(row).toHaveLength(9);
    }
  });

  it('beat and gybe angles are the certificate’s, with 24 kn in column 25 (P.10 item 6)', () => {
    expect(boat.beat.tws).toEqual(boat.tws);
    expect(boat.gybe.tws).toEqual(boat.tws);
    expect(boat.beat.angle).toEqual([47.2, 44.2, 41.8, 40, 38.8, 38.1, 37.8, 37.7, 38.9]);
    expect(boat.gybe.angle).toEqual([141.7, 144.2, 146.1, 174.8, 179.3, 179.8, 179.8, 180, 180]);
    expect(boat.beat.angle).toEqual(boat.tws.map((w) => A.BeatAngle![certCol(w)]));
    expect(boat.gybe.angle).toEqual(boat.tws.map((w) => A.GybeAngle![certCol(w)]));
  });

  it('every cell is finite, above 0 and below maxSpeedKn 12 (P.10 item 6)', () => {
    expect(boat.validation.maxSpeedKn).toBe(12);
    for (const t of [fock, genoa])
      for (const v of t.flat()) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(12);
      }
  });

  it('both tables are TWS-monotone from 4 to 20 kn (P.10 item 6)', () => {
    const last20 = boat.tws.indexOf(20);
    const drops: string[] = [];
    for (const [name, t] of [
      ['fock', fock],
      ['genoa', genoa],
    ] as const)
      t.forEach((row, i) => {
        for (let j = 1; j <= last20; j++)
          if (row[j]! < row[j - 1]!) drops.push(`${name} ${boat.twa[i]}/${boat.tws[j]}`);
      });
    expect(drops).toEqual([]);
  });

  it('rows 52-135 are round2(3600/R) and rows 150-180 round2(3600/DW), columns 4-20 (P.10 item 7)', () => {
    const family: Record<number, string> = {
      52: 'R52',
      60: 'R60',
      90: 'R90',
      110: 'R110',
      120: 'R120',
      135: 'R135',
      150: 'DW150',
      165: 'DW165',
      180: 'DW180',
    };
    const wrong: string[] = [];
    for (const [twa, key] of Object.entries(family))
      for (const w of [4, 6, 8, 10, 12, 14, 16, 20]) {
        const want = round2(3600 / A[key]![certCol(w)]!);
        const got = at(fock, Number(twa), w);
        if (got !== want) wrong.push(`${key}@${w}: ${got} vs ${want}`);
      }
    expect(wrong).toEqual([]);
  });

  it('row 150 tells DW150 from R150 at 4/6/8 kn, where GybeAngle < 150 (control for item 7)', () => {
    for (const w of [4, 6, 8]) {
      expect(A.GybeAngle![certCol(w)]).toBeLessThan(150);
      expect(round2(3600 / A.DW150![certCol(w)]!)).not.toBe(round2(3600 / A.R150![certCol(w)]!));
    }
  });

  it('TWS 25 holds the certificate’s 24 kn column', () => {
    expect(A.WindSpeeds![8]).toBe(24);
    for (const key of ['R52', 'R90', 'R135', 'DW150', 'DW180'] as const) {
      const twa = Number(key.replace(/\D/g, ''));
      expect(at(fock, twa, 25)).toBe(round2(3600 / A[key]![8]!));
    }
  });

  it('derives cleanly from a scratch copy of the sources (control for the aborts below)', () => {
    const r = run(['--check', '--sources', scratchSources()]);
    expect(r.ok, r.output).toBe(true);
    expect(r.output).toContain('salona-44-easy-go/fock');
  });

  it.each([
    [
      'GybeAngle at 8 kn below R135',
      (a: Record<string, number[]>) => (a.GybeAngle![2] = 130),
      /R135.*\b8 kn/,
    ],
    [
      'GybeAngle at 24 kn below R135',
      (a: Record<string, number[]>) => (a.GybeAngle![8] = 134.9),
      /R135.*\b24 kn/,
    ],
    [
      'BeatAngle at 4 kn above R52',
      (a: Record<string, number[]>) => (a.BeatAngle![0] = 52.5),
      /R52.*\b4 kn/,
    ],
    [
      'BeatAngle at 4 kn equal to R52',
      (a: Record<string, number[]>) => (a.BeatAngle![0] = 52),
      /ascend/,
    ],
  ])(
    'fails closed when a planted %s leaves a used R row out of its window',
    (_name, plant, message) => {
      const r = run(['--check', '--sources', scratchSources((rec) => plant(rec.Allowances))]);
      expect(r.ok, r.output).toBe(false);
      expect(r.output).toMatch(message);
    },
  );

  it('rows below the beat angle taper as V_b x TWA / beat angle and never beat the certificate VMG (P.10 item 8)', () => {
    let checked = 0;
    boat.tws.forEach((w, j) => {
      const cj = certCol(w);
      const thb = A.BeatAngle![cj]!;
      const vmgCert = 3600 / A.Beat![cj]!;
      const vb = vmgCert / Math.cos(deg(thb));
      boat.twa.forEach((twa, i) => {
        if (twa >= thb) return;
        checked++;
        expect(fock[i]![j], `${twa}/${w}`).toBe(round2((vb * twa) / thb));
        expect(fock[i]![j]! * Math.cos(deg(twa)), `${twa}/${w}`).toBeLessThanOrEqual(vmgCert);
      });
    });
    expect(checked).toBe(13);
  });

  it('through Polar.speedKn the best beat VMG over a 0.1° sweep is 0.98-1.005 x the certificate (P.10 item 8)', () => {
    const polar = new Polar({
      rig: 'fock',
      boat: boat.name,
      tws: boat.tws,
      twa: boat.twa,
      speeds: fock,
      beat: boat.beat,
      gybe: boat.gybe,
      source: boat.sails.fock.provenance.note,
    });
    for (const w of boat.tws) {
      let best = 0;
      for (let k = 1; k <= 900; k++)
        best = Math.max(best, polar.speedKn(k / 10, w) * Math.cos(deg(k / 10)));
      const ratio = best / (3600 / A.Beat![certCol(w)]!);
      expect(ratio, `${w} kn`).toBeGreaterThanOrEqual(0.98);
      expect(ratio, `${w} kn`).toBeLessThanOrEqual(1.005);
    }
  });

  it('interpolated and tapered rows match an independent SciPy PCHIP derivation', () => {
    const scipy: Record<number, number[]> = {
      35: [2.81, 4.09, 5.11, 5.9, 6.43, 6.7, 6.85, 6.96, 6.84],
      40: [3.21, 4.67, 5.84, 6.75, 7.22, 7.44, 7.56, 7.67, 7.68],
      45: [3.62, 5.23, 6.36, 7.13, 7.57, 7.78, 7.89, 8, 8.01],
      70: [4.66, 6.27, 7.3, 7.92, 8.29, 8.54, 8.73, 8.93, 9.03],
      80: [4.68, 6.29, 7.33, 7.95, 8.34, 8.64, 8.9, 9.23, 9.41],
      100: [4.3, 5.89, 7.02, 7.81, 8.29, 8.65, 8.98, 9.65, 10.24],
    };
    for (const [twa, row] of Object.entries(scipy))
      expect(fock[boat.twa.indexOf(Number(twa))], `row ${twa}`).toEqual(row);
  });

  it('against the polargraph Jib: each of 77 deltas within 0.5 pt of the committed delta, all within ±10 % (P.10 item 9)', () => {
    const committed: Record<number, number[]> = {
      52: [-1.38, -2.02, -2.08, -2.22, -2.75, -3.18, -3.36],
      60: [-2.1, -2.74, -3.48, -3.9, -3.58, -3.64, -3.58],
      70: [-3.09, -3.31, -4.12, -4.49, -4.47, -3.96, -3.88],
      80: [-4.26, -3.93, -4.45, -4.69, -4.95, -5.12, -4.35],
      90: [-4.78, -3.84, -3.76, -3.91, -3.87, -4.46, -4.81],
      110: [-5.2, -3.63, -1.05, -0.97, -0.7, 0.22, 0.83],
      120: [-0.98, 1.45, 2.25, 2.32, 1.33, 1.62, 3.33],
      135: [9.0, 7.93, 7.49, 6.0, 4.57, 2.68, 2.91],
      150: [3.75, 3.73, 3.24, 2.18, 0.97, -0.13, -1.83],
      165: [-2.79, -1.88, -1.72, -1.47, -1.59, -1.45, -2.21],
      180: [-3.49, -2.64, -2.34, -2.0, -2.06, -1.87, -2.57],
    };
    let shared = 0;
    for (const [c, w] of polargraph.tws.entries())
      for (const cell of polargraph.jib[String(w)]!) {
        if (cell.tag !== '' || !boat.twa.includes(cell.twa)) continue;
        shared++;
        const delta = (at(fock, cell.twa, w) / cell.btv - 1) * 100;
        expect(Math.abs(delta - committed[cell.twa]![c]!), `${cell.twa}/${w}`).toBeLessThanOrEqual(
          0.5,
        );
        expect(Math.abs(delta), `${cell.twa}/${w}`).toBeLessThanOrEqual(10);
      }
    expect(shared).toBe(77);
  });

  it('the jib note’s polargraph range and the ceiling source’s peak match the table', () => {
    const deltas: number[] = [];
    for (const w of polargraph.tws)
      for (const cell of polargraph.jib[String(w)]!)
        if (cell.tag === '' && boat.twa.includes(cell.twa))
          deltas.push((at(fock, cell.twa, w) / cell.btv - 1) * 100);
    const lo = Math.round(Math.min(...deltas));
    const hi = Math.round(Math.max(...deltas));
    expect(boat.sails.fock.provenance.note).toContain(`differs by ${lo}% to +${hi}% per cell`);

    const peak = Math.max(...fock.flat());
    expect(fock.some((row) => row[row.length - 1] === peak)).toBe(true);
    expect(boat.validation.maxSpeedKnSource).toContain(
      `peaks at ${peak} kn in the held 24 kn column`,
    );
  });

  it('anchors A1-A4 bracket the polargraph, the jib and the genoa (P.10 item 10)', () => {
    expect(
      boat.validation.anchors.map(({ twa, tws, minKn, maxKn }) => ({ twa, tws, minKn, maxKn })),
    ).toEqual([
      { twa: 52, tws: 12, minKn: 7.3, maxKn: 8.9 },
      { twa: 90, tws: 8, minKn: 6.8, maxKn: 8.35 },
      { twa: 135, tws: 10, minKn: 5.5, maxKn: 6.8 },
      { twa: 180, tws: 12, minKn: 5.4, maxKn: 6.6 },
    ]);
    const pgAt = (twa: number, tws: number): number =>
      polargraph.jib[String(tws)]!.find((c) => c.tag === '' && c.twa === twa)!.btv;
    const expected = [
      { pg: 8.1, fock: 7.92, genoa: 7.96 },
      { pg: 7.56, fock: 7.27, genoa: 7.48 },
      { pg: 6.14, fock: 6.6, genoa: 6.7 },
      { pg: 6.0, fock: 5.88, genoa: 5.94 },
    ];
    boat.validation.anchors.forEach((a, k) => {
      const pg = pgAt(a.twa, a.tws);
      const f = at(fock, a.twa, a.tws);
      const g = at(genoa, a.twa, a.tws);
      expect({ pg, fock: f, genoa: g }).toEqual(expected[k]);
      for (const v of [pg, f, g]) {
        expect(v).toBeGreaterThanOrEqual(a.minKn);
        expect(v).toBeLessThanOrEqual(a.maxKn);
      }
      for (const v of [f, g]) expect(Math.abs(v / pg - 1)).toBeLessThanOrEqual(0.1);
      expect(a.source.length).toBeGreaterThan(0);
    });
  });
});

describe('derive_orc_polars.mjs — EASY GO! genoa (orc-jib-genoa-ramp-v1)', () => {
  const s45g = salona45.sails.genoa!.speeds;
  const s45f = salona45.sails.fock!.speeds;

  it('is round2(fock x max(1, Salona 45 genoa / fock)) cell by cell (P.4)', () => {
    expect(genoa).toEqual(
      fock.map((row, i) => row.map((v, j) => round2(v * Math.max(1, s45g[i]![j]! / s45f[i]![j]!)))),
    );
  });

  it('is never below the jib and equals it in exactly the 56 spec cells (P.10 item 11)', () => {
    const equal: string[] = [];
    const below: string[] = [];
    const wantEqual = (twa: number, tws: number): boolean =>
      tws >= 16 || (tws === 14 && twa <= 120);
    fock.forEach((row, i) =>
      row.forEach((v, j) => {
        const twa = boat.twa[i]!;
        const tws = boat.tws[j]!;
        if (genoa[i]![j]! < v) below.push(`${twa}/${tws}`);
        if (genoa[i]![j] === v) equal.push(`${twa}/${tws}`);
        expect(genoa[i]![j] === v, `${twa}/${tws}`).toBe(wantEqual(twa, tws));
      }),
    );
    expect(below).toEqual([]);
    expect(equal).toHaveLength(56);
  });

  it('the clamp binds: unclamped, nine 25 kn cells would fall below the jib (control for item 11)', () => {
    const below: string[] = [];
    fock.forEach((row, i) =>
      row.forEach((v, j) => {
        if (round2(v * (s45g[i]![j]! / s45f[i]![j]!)) < v)
          below.push(`${boat.twa[i]}/${boat.tws[j]}`);
      }),
    );
    expect(below).toEqual([
      '35/25',
      '40/25',
      '45/25',
      '52/25',
      '60/25',
      '70/25',
      '80/25',
      '90/25',
      '100/25',
    ]);
  });
});

describe('derive_orc_polars.mjs — emitted record (spec §P.1, §P.6)', () => {
  it('names the donor record and the committed source hash', () => {
    expect(boat.id).toBe('salona-44-easy-go');
    expect(boat.draftM).toBe(2.59);
    expect(boat.sails.fock.provenance.tier).toBe('modelled');
    expect(boat.sails.genoa.provenance.tier).toBe('estimated');
    expect(boat.sails.fock.derivation).toEqual({
      method: 'orc-ns-cert-rows-v1',
      donor: {
        kind: 'orc-cert',
        relation: 'sister-hull',
        refNo: '04590004MKR',
        yacht: 'SANTA ANASTASIA',
        sailNo: 'CRO 1938',
        measuredDraftM: 2.415,
        areaJibM2: 41.66,
        areaMainM2: 58.48,
      },
      sources: [
        {
          path: `orc-sources/${CERT_FILE}`,
          sha256: createHash('sha256').update(certText).digest('hex'),
        },
      ],
    });
    expect(record).toMatchObject({
      RefNo: '04590004MKR',
      YachtName: 'SANTA ANASTASIA',
      SailNo: 'CRO 1938',
      Draft: 2.415,
      Area_Jib: 41.66,
      Area_Main: 58.48,
    });
    expect(boat.sails.genoa.derivation).toEqual({
      method: 'orc-jib-genoa-ramp-v1',
      fromSailId: 'fock',
      ramp: { boatId: 'salona-45', fromSailId: 'fock', toSailId: 'genoa', clampMin: 1 },
      uncertaintyPct: 10,
    });
  });
});
