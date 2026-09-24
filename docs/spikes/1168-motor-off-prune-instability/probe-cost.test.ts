import { it } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { solve, DIAG, defaultMaxFrontier } from './scratch1168iso';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { uniformGate } from '../lib/depthGate';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../types';
import { mask, polarGenoa, polarFock, FLENSBURG, T0 } from '../test/realmaskFixtures';

const OUT = process.env.SC_OUT ?? '/dev/null';
const DIV = Number(process.env.SC_DIV ?? '2');
const SALVAGE = process.env.SC_SALVAGE === '1';
const IDS = process.env.SC_IDS === 'all' ? null : (process.env.SC_IDS ?? 'svendborg').split(',');
const RIGS = (process.env.SC_RIGS ?? 'genoa').split(',');
const LM = process.env.SC_LM === '1';
const harbors = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data/harbors.json'),
    'utf8',
  ),
) as { id: string; snap: { lat: number; lon: number } }[];

it('cost', () => {
  const origin = mask.snapToNavigable(FLENSBURG, 3)!;
  for (const id of IDS ?? harbors.map((x) => x.id))
    for (const rig of RIGS) {
      const h = harbors.find((x) => x.id === id)!;
      const dest = mask.snapToNavigable(h.snap, 3);
      if (!dest) continue;
      DIAG.mode = 'prod';
      DIAG.div = DIV;
      DIAG.track = false;
      DIAG.record = true;
      DIAG.rings = [];
      const r = solve({
        origin,
        destination: dest,
        departureMs: T0,
        polar: new Polar(rig === 'genoa' ? polarGenoa : polarFock, 0.9),
        wind: new WindField(LM ? uniformWindGrid(3, 0) : uniformWindGrid(12, 225)),
        mask,
        settings: LM ? { ...DEFAULT_SETTINGS, motorEnabled: false } : DEFAULT_SETTINGS,
        gate: uniformGate(3),
        comfortDepthM: 5,
        ...(SALVAGE ? { salvage: true } : {}),
      });
      const rings = DIAG.rings;
      const cap = defaultMaxFrontier(mask.meta);
      appendFileSync(
        OUT,
        JSON.stringify({
          id,
          rig,
          div: DIV,
          status: r.status,
          cause: r.status === 'no-route' ? r.cause : null,
          rings: rings.length,
          peak: Math.max(0, ...rings.map((x) => x.next)),
          truncatedRings: rings.filter((x) => x.next === cap).length,
          expanded: rings.reduce((s, x) => s + x.nodes, 0),
          accepted: rings.reduce((s, x) => s + x.accepted, 0),
          costMin: r.status === 'ok' ? (r.costMs - T0) / 60000 : null,
          etaMin: r.status === 'ok' ? (r.etaMs - T0) / 60000 : null,
        }) + '\n',
      );
    }
}, 3_600_000);
