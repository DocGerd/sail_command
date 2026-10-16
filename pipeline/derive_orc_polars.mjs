/**
 * Multi-boat spec §P.3/§P.4 — EASY GO!'s tables from a sister hull's ORC data.
 *
 * `orc-ns-cert-rows-v1` (tier B jib), per grid TWS column, on the Salona 45 grid:
 *   - certificate column: the grid TWS itself; above the certificate's last
 *     `WindSpeeds` entry that column is held (TWS 25 reads 24 kn);
 *   - rows 52/60/90/110/120/135 = 3600 / R<twa>; rows 150/165/180 = 3600 / DW<twa>;
 *     an R row is a straight-line speed only inside [BeatAngle, GybeAngle], so a
 *     used R row outside it aborts;
 *   - V_b = (3600 / Beat) / cos(BeatAngle): `Beat` is a VMG allowance;
 *   - rows below BeatAngle: V_b x TWA / BeatAngle (Polar.speedKn's below-table shape);
 *   - every other row: monotone cubic PCHIP (Fritsch-Carlson monotonicity; slopes
 *     as SciPy/MATLAB `pchip`) through BeatAngle -> V_b, R52 R60 R75 R90 R110 R120
 *     R135 and DW150 DW165 DW180;
 *   - each cell round2 (estimate_polars.mjs). Build asserts: below maxSpeedKn,
 *     TWS-monotone to 20 kn, and no row below BeatAngle beating the Beat VMG.
 *
 * `orc-jib-genoa-ramp-v1` (tier C genoa): round2(jib x max(1, S45 genoa / S45 jib))
 * on the rounded, recomputed jib. The clamp is the method: without it the held
 * 24 kn column would make the genoa slower than the jib.
 *
 * Inputs: the certificate under orc-sources/ and the Salona 45 grid and ramp in
 * polars-source.json. No network.
 *
 * USAGE
 *   node derive_orc_polars.mjs --check [--sources <dir>]
 *   node derive_orc_polars.mjs --emit-boat salona-44-easy-go [--sources <dir>]
 * --emit-boat prints the boat block for polars-source.json; nothing here writes files.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_PATH, round2 } from './estimate_polars.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const SOURCES_DIR = join(here, 'orc-sources');

export const CERT_METHOD = 'orc-ns-cert-rows-v1';
export const GENOA_RAMP_METHOD = 'orc-jib-genoa-ramp-v1';
export const DERIVATION_METHODS = [CERT_METHOD, GENOA_RAMP_METHOD];

const R_ROWS = { 52: 'R52', 60: 'R60', 90: 'R90', 110: 'R110', 120: 'R120', 135: 'R135' };
const DW_ROWS = { 150: 'DW150', 165: 'DW165', 180: 'DW180' };
const R_KNOTS = { ...R_ROWS, 75: 'R75' };
const MONOTONE_TO_TWS = 20;

function fail(msg) {
  throw new Error(`derive_orc_polars: ${msg}`);
}

const rad = (a) => (a * Math.PI) / 180;

/** Monotone cubic Hermite interpolation of (xs, ys) at x, xs strictly ascending. */
export function pchip(xs, ys, x) {
  const n = xs.length;
  const h = [];
  const d = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] > 0) {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  const end = (h0, h1, d0, d1) => {
    const v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(v) !== Math.sign(d0)) return 0;
    if (Math.sign(d0) !== Math.sign(d1) && Math.abs(v) > 3 * Math.abs(d0)) return 3 * d0;
    return v;
  };
  m[0] = end(h[0], h[1], d[0], d[1]);
  m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  let i = 0;
  while (i < n - 2 && x > xs[i + 1]) i++;
  const t = (x - xs[i]) / h[i];
  const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
  const h10 = t ** 3 - 2 * t ** 2 + t;
  const h01 = -2 * t ** 3 + 3 * t ** 2;
  const h11 = t ** 3 - t ** 2;
  return h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1];
}

/** `own x max(clampMin, to / from)` cell by cell; never edit estimate_polars.mjs's unclamped rampSpeeds. */
export function clampedRampSpeeds(ownSpeeds, fromSpeeds, toSpeeds, clampMin) {
  return ownSpeeds.map((row, i) =>
    row.map((v, j) => round2(v * Math.max(clampMin, toSpeeds[i][j] / fromSpeeds[i][j]))),
  );
}

function requireRow(allowances, key) {
  const row = allowances[key];
  const n = allowances.WindSpeeds.length;
  if (!Array.isArray(row) || row.length !== n || !row.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0))
    fail(`certificate row ${key} missing or not ${n} positive numbers`);
  return row;
}

function requireTableAsserts(name, speeds, tws, twa, maxSpeedKn) {
  speeds.forEach((row, i) =>
    row.forEach((v, j) => {
      if (!(Number.isFinite(v) && v > 0 && v < maxSpeedKn))
        fail(`${name}: ${v} kn at ${twa[i]}/${tws[j]} is not in (0, ${maxSpeedKn})`);
      if (j > 0 && tws[j] <= MONOTONE_TO_TWS && v < row[j - 1])
        fail(`${name}: not TWS-monotone at ${twa[i]}/${tws[j]} (${row[j - 1]} then ${v})`);
    }),
  );
}

/** The jib table, beat and gybe angles from one certificate's `Allowances`, on the given grid. */
export function deriveCertTable(allowances, tws, twa, { name = CERT_METHOD, maxSpeedKn } = {}) {
  const ws = allowances?.WindSpeeds;
  if (!Array.isArray(ws) || ws.length < 2) fail('certificate WindSpeeds missing');
  const beatAngle = requireRow(allowances, 'BeatAngle');
  const gybeAngle = requireRow(allowances, 'GybeAngle');
  const beat = requireRow(allowances, 'Beat');
  const rows = Object.fromEntries(
    Object.values({ ...R_KNOTS, ...DW_ROWS }).map((key) => [key, requireRow(allowances, key)]),
  );

  ws.forEach((w, c) => {
    for (const [a, key] of Object.entries(R_KNOTS))
      if (!(beatAngle[c] <= Number(a) && Number(a) <= gybeAngle[c]))
        fail(
          `${key} at ${w} kn is outside [BeatAngle ${beatAngle[c]}, GybeAngle ${gybeAngle[c]}], ` +
            'so it is not a straight-line speed',
        );
  });

  const columns = tws.map((w) => {
    const c = ws.indexOf(w);
    if (c >= 0) return c;
    if (w > ws[ws.length - 1]) return ws.length - 1;
    fail(`grid TWS ${w} kn is not a certificate WindSpeeds column`);
  });

  const speeds = twa.map(() => new Array(tws.length));
  columns.forEach((c, j) => {
    const thb = beatAngle[c];
    const vb = 3600 / beat[c] / Math.cos(rad(thb));
    const knots = [[thb, vb]];
    for (const [a, key] of Object.entries({ ...R_KNOTS, ...DW_ROWS }))
      knots.push([Number(a), 3600 / rows[key][c]]);
    knots.sort((p, q) => p[0] - q[0]);
    const xs = knots.map((k) => k[0]);
    const ys = knots.map((k) => k[1]);
    for (let k = 1; k < xs.length; k++)
      if (!(xs[k] > xs[k - 1])) fail(`PCHIP knots at ${ws[c]} kn do not strictly ascend (${xs[k - 1]} then ${xs[k]})`);

    twa.forEach((a, i) => {
      let v;
      if (Object.hasOwn(R_ROWS, a)) v = 3600 / rows[R_ROWS[a]][c];
      else if (Object.hasOwn(DW_ROWS, a)) v = 3600 / rows[DW_ROWS[a]][c];
      else if (a < thb) v = (vb * a) / thb;
      else if (a <= 180) v = pchip(xs, ys, a);
      else fail(`grid TWA ${a} is above 180`);
      speeds[i][j] = round2(v);
      if (a < thb && speeds[i][j] * Math.cos(rad(a)) > 3600 / beat[c])
        fail(`${name}: ${a}/${tws[j]} beats the certificate's Beat VMG`);
    });
  });

  if (maxSpeedKn !== undefined) requireTableAsserts(name, speeds, tws, twa, maxSpeedKn);
  return {
    speeds,
    beat: { tws: [...tws], angle: columns.map((c) => beatAngle[c]) },
    gybe: { tws: [...tws], angle: columns.map((c) => gybeAngle[c]) },
  };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceFile(relPath, sourcesDir) {
  const m = /^orc-sources\/([A-Za-z0-9._-]+\.json)$/.exec(relPath ?? '');
  if (!m) fail(`source path ${JSON.stringify(relPath)} is not a file directly under orc-sources/`);
  return join(sourcesDir, m[1]);
}

function readCertRecord(relPath, refNo, sourcesDir) {
  const file = sourceFile(relPath, sourcesDir);
  const record = JSON.parse(readFileSync(file, 'utf8')).record;
  if (record?.RefNo !== refNo) fail(`${relPath} holds RefNo ${JSON.stringify(record?.RefNo)}, not ${refNo}`);
  return { record, file };
}

function boatOf(src, id) {
  const b = src.boats.find((x) => x.id === id);
  if (!b) fail(`no boat ${JSON.stringify(id)} in polars-source.json`);
  return b;
}

function sameAxes(a, b) {
  return JSON.stringify([a.tws, a.twa]) === JSON.stringify([b.tws, b.twa]);
}

/** One sail's table from its `derivation` block, recomputing any sail it derives from. */
export function derivedSail(src, boat, sailId, { sourcesDir = SOURCES_DIR } = {}) {
  const sail = boat.sails?.[sailId];
  const der = sail?.derivation;
  const name = `${boat.id}/${sailId}`;
  if (der == null) fail(`${name} declares no derivation block`);
  const maxSpeedKn = boat.validation?.maxSpeedKn;
  if (!(typeof maxSpeedKn === 'number' && maxSpeedKn > 0)) fail(`${boat.id}: validation.maxSpeedKn missing`);

  if (der.method === CERT_METHOD) {
    if (!Array.isArray(der.sources) || der.sources.length !== 1)
      fail(`${name}: ${CERT_METHOD} needs exactly one source`);
    const { record } = readCertRecord(der.sources[0].path, der.donor?.refNo, sourcesDir);
    return deriveCertTable(record.Allowances, boat.tws, boat.twa, { name, maxSpeedKn });
  }

  if (der.method === GENOA_RAMP_METHOD) {
    const ramp = der.ramp;
    if (ramp?.clampMin !== 1) fail(`${name}: ${GENOA_RAMP_METHOD} is clamped at exactly 1`);
    if (der.fromSailId === sailId) fail(`${name}: derives from itself`);
    const base = derivedSail(src, boat, der.fromSailId, { sourcesDir });
    const rampBoat = boatOf(src, ramp.boatId);
    if (!sameAxes(rampBoat, boat)) fail(`${name}: ramp boat ${ramp.boatId} is on a different grid`);
    const from = rampBoat.sails?.[ramp.fromSailId]?.speeds;
    const to = rampBoat.sails?.[ramp.toSailId]?.speeds;
    if (!Array.isArray(from) || !Array.isArray(to)) fail(`${name}: ramp sails missing on ${ramp.boatId}`);
    const speeds = clampedRampSpeeds(base.speeds, from, to, ramp.clampMin);
    requireTableAsserts(name, speeds, boat.tws, boat.twa, maxSpeedKn);
    speeds.forEach((row, i) =>
      row.forEach((v, j) => {
        if (v < base.speeds[i][j]) fail(`${name}: below ${der.fromSailId} at ${boat.twa[i]}/${boat.tws[j]}`);
      }),
    );
    return { speeds, beat: base.beat, gybe: base.gybe };
  }

  fail(`${name}: unknown derivation method ${JSON.stringify(der.method)}`);
}

const FOCK_NOTE =
  "Tier B, MODELLED - this boat's own table, anchored on a SISTER HULL's ORC certificate, not on a certificate of this boat. Source: ORC Non-Spinnaker certificate 2026 for the Salona 44 SANTA ANASTASIA (CRO 1938, RefNo 04590004MKR), issued 2026-04-22, retrieved 2026-10-15; deep keel (inferred from its ORC-measured draft of 2.415 m, the certificate has no keel field). It is that hull's white-sail polar in its 41.66 m2 jib configuration, read onto the app grid; this boat's own jib area, loading and keel are unknown, and the sign of the resulting error is unknown. Against the builder's ORC VPP 1.11 jib polar for another Salona 44 sister hull (2010, CRO 2009) the table differs by -5% to +9% per cell; that compares two sister-hull VPP runs and is not an error bound for this boat. Below about 8 kn the table decides between sailing and motoring, so a leg may be motored that would sail, or the reverse. Flat-water racing VPP - tune with the performance factor. NOT race-calibrated, and never measured against this boat.";

const GENOA_NOTE =
  "Tier C, ESTIMATED - this boat's jib table (see the jib note: a sister hull's certificate, not this boat's) multiplied cell-by-cell by the Salona 45's documented genoa overlay ramp, i.e. its genoa table divided by its jib table, never below 1 (about +4-5% at 4 kn, +3-4% at 6, +2-3% at 8, +1-2% at 10, nothing from 16 kn). The ramp was set for a smaller genoa/jib step than the 61.10 m2 furling genoa the builder lists for the Salona 44 (this boat's own headsail areas are not known), so the light-air gain may be understated; from 16 kn the genoa is credited with the jib's speed, which assumes it is depowered optimally and may be too high. The difference between this boat's two tables is therefore a function of THAT RAMP, not of this hull, and carries no information about it - which is why the sail comparison is withheld rather than presented as a finding. Below about 8 kn the table decides between sailing and motoring, so a leg may be motored that would sail, or the reverse. Same grid and angles, and the same uncertainty, as the jib table. Flat-water racing VPP - tune with the performance factor. NOT race-calibrated, and never measured against this boat.";

const POLARGRAPH = 'orc-vpp111-salona44-cro2009-polargraph.json';

function anchorSource(pgKn, twa, tws) {
  return (
    `Builder-published ORC VPP 1.11 polar of a Salona 44 sister hull (CRO 2009, issued 8.12.2010): ` +
    `Jib ${pgKn.toFixed(2)} kn at TWA ${twa} / TWS ${tws}. Band about +/-10%, rounded to 0.05 kn; ` +
    "it catches an index or unit slip, not this boat's error."
  );
}

const TEMPLATES = {
  'salona-44-easy-go': {
    name: 'Salona 44 (EASY GO!)',
    draftM: 2.59,
    gridFrom: 'salona-45',
    maxSpeedKn: 12,
    maxSpeedKnSource:
      'judgement - one knot above the 11 kn reaching figure of a model sea trial (25 kn wind); the ORC certificate peaks at 10.55 kn in the held 24 kn column',
    anchors: [
      { label: 'upwind', twa: 52, tws: 12, minKn: 7.3, maxKn: 8.9 },
      { label: 'beam reach', twa: 90, tws: 8, minKn: 6.8, maxKn: 8.35 },
      { label: 'broad reach', twa: 135, tws: 10, minKn: 5.5, maxKn: 6.8 },
      { label: 'run', twa: 180, tws: 12, minKn: 5.4, maxKn: 6.6 },
    ],
    sails: {
      genoa: {
        provenance: { tier: 'estimated', note: GENOA_NOTE },
        derivation: {
          method: GENOA_RAMP_METHOD,
          fromSailId: 'fock',
          ramp: { boatId: 'salona-45', fromSailId: 'fock', toSailId: 'genoa', clampMin: 1 },
          uncertaintyPct: 10,
        },
      },
      fock: {
        provenance: { tier: 'modelled', note: FOCK_NOTE },
        source: { path: 'orc-sources/orc-ns-tur-santa-anastasia-2026.json', refNo: '04590004MKR' },
      },
    },
  },
};

function certDerivation(spec, sourcesDir) {
  const { record, file } = readCertRecord(spec.path, spec.refNo, sourcesDir);
  return {
    method: CERT_METHOD,
    donor: {
      kind: 'orc-cert',
      relation: 'sister-hull',
      refNo: record.RefNo,
      yacht: record.YachtName,
      sailNo: record.SailNo,
      measuredDraftM: record.Draft,
      areaJibM2: record.Area_Jib,
      areaMainM2: record.Area_Main,
    },
    sources: [{ path: spec.path, sha256: sha256(file) }],
  };
}

/** The full polars-source.json record for a templated boat, every table derived. */
export function emitBoat(src, boatId, { sourcesDir = SOURCES_DIR } = {}) {
  if (!Object.hasOwn(TEMPLATES, boatId)) fail(`no derivation template for ${JSON.stringify(boatId)}`);
  const t = TEMPLATES[boatId];
  const grid = boatOf(src, t.gridFrom);
  const pg = JSON.parse(readFileSync(join(sourcesDir, POLARGRAPH), 'utf8'));
  const pgAt = (twa, tws) => {
    const cell = pg.jib?.[String(tws)]?.find((c) => c.tag === '' && c.twa === twa);
    if (!cell) fail(`polargraph has no Jib cell at ${twa}/${tws}`);
    return cell.btv;
  };
  const boat = {
    id: boatId,
    name: t.name,
    draftM: t.draftM,
    validation: {
      maxSpeedKn: t.maxSpeedKn,
      maxSpeedKnSource: t.maxSpeedKnSource,
      anchors: t.anchors.map((a) => ({ ...a, source: anchorSource(pgAt(a.twa, a.tws), a.twa, a.tws) })),
    },
    tws: [...grid.tws],
    twa: [...grid.twa],
    sails: {},
  };
  for (const [sailId, s] of Object.entries(t.sails))
    boat.sails[sailId] = {
      provenance: s.provenance,
      derivation: s.derivation ?? certDerivation(s.source, sourcesDir),
    };
  let angles;
  for (const sailId of Object.keys(boat.sails)) {
    const d = derivedSail(src, boat, sailId, { sourcesDir });
    boat.sails[sailId].speeds = d.speeds;
    angles ??= d;
  }
  const { id, name, draftM, validation, tws, twa, sails } = boat;
  return { id, name, draftM, validation, tws, twa, beat: angles.beat, gybe: angles.gybe, sails };
}

/** D5's comparison over the COMMITTED record: every derivation method known (and the template's), tables byte for byte. */
export function reproductionFailures(src, { sourcesDir = SOURCES_DIR } = {}) {
  const out = [];
  for (const boat of src.boats) {
    const template = Object.hasOwn(TEMPLATES, boat.id) && boat.polarsFrom === undefined ? TEMPLATES[boat.id] : null;
    const reported = new Set();
    const push = (sailId, detail) => {
      reported.add(sailId);
      out.push({ boatId: boat.id, sailId, detail });
    };
    for (const [sailId, t] of Object.entries(template?.sails ?? {})) {
      const want = t.derivation?.method ?? CERT_METHOD;
      const der = boat.sails?.[sailId]?.derivation;
      if (der == null) push(sailId, 'declares no derivation block');
      else if (der.method !== want) push(sailId, `derivation.method ${JSON.stringify(der.method)} is not ${want}`);
    }
    for (const [sailId, sail] of Object.entries(boat.sails ?? {})) {
      if (sail?.derivation == null || reported.has(sailId)) continue;
      if (!DERIVATION_METHODS.includes(sail.derivation.method)) {
        push(sailId, `unknown derivation method ${JSON.stringify(sail.derivation.method)}`);
        continue;
      }
      let got;
      try {
        got = derivedSail(src, boat, sailId, { sourcesDir });
      } catch (e) {
        push(sailId, e.message);
        continue;
      }
      for (const [key, committed, derived] of [
        ['speeds', sail.speeds, got.speeds],
        ['beat', boat.beat, got.beat],
        ['gybe', boat.gybe, got.gybe],
      ])
        if (JSON.stringify(committed) !== JSON.stringify(derived))
          push(sailId, `committed ${key} differs from the derivation`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- CLI ----

const INLINE_MAX = 160;

function isFlat(v) {
  return v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => typeof x === 'number'));
}

/** polars-source.json's hand layout: number rows and short flat objects on one line. */
function format(v, indent) {
  if (isFlat(v)) return Array.isArray(v) ? `[${v.join(', ')}]` : JSON.stringify(v);
  const pad = ' '.repeat(indent + 2);
  if (Array.isArray(v)) return `[\n${v.map((x) => pad + format(x, indent + 2)).join(',\n')}\n${' '.repeat(indent)}]`;
  const entries = Object.entries(v);
  if (entries.every(([, x]) => isFlat(x))) {
    const inline = `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${format(x, 0)}`).join(', ')} }`;
    if (indent + inline.length <= INLINE_MAX) return inline;
  }
  return `{\n${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${format(x, indent + 2)}`).join(',\n')}\n${' '.repeat(indent)}}`;
}

function main(argv) {
  const args = [...argv];
  let sourcesDir = SOURCES_DIR;
  const s = args.indexOf('--sources');
  if (s >= 0) {
    if (args[s + 1] === undefined) fail('--sources needs a directory');
    sourcesDir = args[s + 1];
    args.splice(s, 2);
  }
  const src = JSON.parse(readFileSync(SOURCE_PATH, 'utf8'));

  if (args[0] === '--emit-boat' && args.length === 2) {
    process.stdout.write(`    ${format(emitBoat(src, args[1], { sourcesDir }), 4)}\n`);
    return 0;
  }
  if (args[0] !== '--check' || args.length !== 1) {
    process.stderr.write('usage: derive_orc_polars.mjs --check | --emit-boat <boatId> [--sources <dir>]\n');
    return 2;
  }

  for (const boatId of Object.keys(TEMPLATES)) {
    const committed = src.boats.find((b) => b.id === boatId);
    if (committed !== undefined && committed.polarsFrom === undefined) continue;
    const boat = emitBoat(src, boatId, { sourcesDir });
    for (const [sailId, sail] of Object.entries(boat.sails))
      process.stdout.write(
        `derived ${boatId}/${sailId} (${sail.derivation.method}, ${boat.twa.length}x${boat.tws.length}): build asserts pass\n`,
      );
    process.stdout.write(`${boatId}: no committed tables in polars-source.json to reproduce\n`);
  }
  const failures = reproductionFailures(src, { sourcesDir });
  for (const f of failures) process.stderr.write(`NOT REPRODUCIBLE ${f.boatId}/${f.sailId}: ${f.detail}\n`);
  if (failures.length > 0) return 1;
  for (const b of src.boats)
    for (const [sailId, sail] of Object.entries(b.sails ?? {}))
      if (DERIVATION_METHODS.includes(sail?.derivation?.method))
        process.stdout.write(`${b.id}/${sailId} reproduces from orc-sources\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
