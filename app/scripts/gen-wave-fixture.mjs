#!/usr/bin/env node
// Writes app/public/test-fixtures/wave-bands.json, the Open-Meteo Marine
// response waves.spec.ts plans on via `?waveFixture=` (#1699,
// src/state/usePlanFlow.ts). Gitignored: `pree2e` regenerates it with the
// same current-hour start as gen-wind-fixture.mjs. Shape lives in
// wave-fixture.mjs.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWaveFixture, N_HOURS, NULL_POINTS } from './wave-fixture.mjs';

const startS = Math.floor(Date.now() / 1000 / 3600) * 3600; // current UTC hour, unix seconds
const fixture = buildWaveFixture(startS);

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '../public/test-fixtures/wave-bands.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(fixture));

console.log(
  `wrote ${outPath} — ${fixture.length} points x ${N_HOURS} hours, ` +
    `${NULL_POINTS.length} all-null points, time[0]=${startS} (${new Date(startS * 1000).toISOString()})`,
);
