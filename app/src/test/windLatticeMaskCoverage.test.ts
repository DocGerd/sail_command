import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { MaskMeta } from '../types';

// #1178: openMeteo.ts's LATS/LONS lattice and mask.meta.json's [west,south,
// east,north] domain are coupled only by hand — no compiler spans a hardcoded
// TS array literal and a committed data asset. If the lattice ever fails to
// cover the mask's domain, WindField.sample()'s bracket() helper silently
// CLAMPS every out-of-lattice query to the nearest edge value (no throw, no
// warning), so a route could be planned against wind sampled from the wrong
// place with no signal at all. This test is the CI-time half of the fix:
// it reads BOTH artifacts via readFileSync (never an `import.meta.glob(...,
// {query:'?raw'})`, which is vacuous for non-.ts/.tsx files under this
// repo's vitest config — see maskTolerance.test.ts / useBannerHeight.test.ts
// for the same pattern) and fails CLOSED if either regex stops matching, so
// a parse that silently stops working reds loudly instead of passing empty.
// The RUNTIME half — WindField's own construction-time assertion — lives in
// app/src/lib/wind.ts and is pinned by wind.test.ts; the two are NOT
// redundant (see wind.ts's own doc comment on why), so this file must never
// be deleted as "already covered by the constructor check" and vice versa.

const OPEN_METEO_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../services/openMeteo.ts',
);
const MASK_META_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../public/data/mask.meta.json',
);

interface LatticeAxis {
  start: number;
  step: number;
  length: number;
}

/**
 * Parses `const LATS = Array.from({ length: N }, (_, i) => Number((START +
 * i * STEP).toFixed(1)));` (and the LONS twin) out of openMeteo.ts's source
 * text. Anchored on the exact declaration shape currently shipped — if that
 * shape ever changes, the regex stops matching and `readAxis` throws (see
 * below), rather than silently reporting a bogus "still covers" result.
 */
function readAxis(source: string, varName: 'LATS' | 'LONS'): LatticeAxis {
  const re = new RegExp(
    `const ${varName} = Array\\.from\\(\\{ length: (\\d+) \\}, \\(_, i\\) => Number\\(\\((-?\\d+(?:\\.\\d+)?) \\+ i \\* (-?\\d+(?:\\.\\d+)?)\\)\\.toFixed\\(1\\)\\)\\);`,
  );
  const match = source.match(re);
  if (!match) {
    throw new Error(
      `openMeteo.ts's ${varName} declaration no longer matches the expected ` +
        `'Array.from({ length: N }, (_, i) => Number((START + i * STEP).toFixed(1)))' shape — ` +
        `update this test's regex rather than let it pass on a stale match (#1178, fail-closed).`,
    );
  }
  const [, length, start, step] = match;
  return { start: Number(start), step: Number(step), length: Number(length) };
}

function axisEnd(axis: LatticeAxis): number {
  return Number((axis.start + (axis.length - 1) * axis.step).toFixed(1));
}

describe('#1178: wind lattice covers the mask domain', () => {
  it('openMeteo.ts LATS/LONS declarations still parse (fail-closed control)', () => {
    const source = readFileSync(OPEN_METEO_PATH, 'utf8');
    // Both must be extractable BEFORE the coverage assertion below can mean
    // anything — an unparseable declaration must fail loudly here, never
    // fall through to a coverage check that silently can't run.
    expect(() => readAxis(source, 'LATS')).not.toThrow();
    expect(() => readAxis(source, 'LONS')).not.toThrow();
  });

  it('LATS/LONS lattice bounds cover mask.meta.json [west,south,east,north]', () => {
    const source = readFileSync(OPEN_METEO_PATH, 'utf8');
    const lats = readAxis(source, 'LATS');
    const lons = readAxis(source, 'LONS');
    const maskMeta = JSON.parse(readFileSync(MASK_META_PATH, 'utf8')) as MaskMeta;

    const latMin = lats.start;
    const latMax = axisEnd(lats);
    const lonMin = lons.start;
    const lonMax = axisEnd(lons);

    // Every point inside the mask's bounds must fall inside the wind
    // lattice's own [min, max] range on both axes — otherwise
    // WindField.sample()'s bracket() clamps it to the lattice edge instead
    // of interpolating real forecast data.
    expect(latMin, `LATS starts at ${latMin}, mask south is ${maskMeta.south}`).toBeLessThanOrEqual(
      maskMeta.south,
    );
    expect(
      latMax,
      `LATS ends at ${latMax}, mask north is ${maskMeta.north}`,
    ).toBeGreaterThanOrEqual(maskMeta.north);
    expect(lonMin, `LONS starts at ${lonMin}, mask west is ${maskMeta.west}`).toBeLessThanOrEqual(
      maskMeta.west,
    );
    expect(lonMax, `LONS ends at ${lonMax}, mask east is ${maskMeta.east}`).toBeGreaterThanOrEqual(
      maskMeta.east,
    );
  });
});
