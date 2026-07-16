#!/usr/bin/env node
// Generates app/public/test-fixtures/wind-sw12.json — a deterministic Open-Meteo
// response fixture consumed via the app's `?windFixture=` escape hatch (E3,
// src/state/usePlanFlow.ts) so E2E specs never depend on the live Open-Meteo
// API or on real (variable) weather.
//
// Shape matches src/services/openMeteo.ts's `fetchWindGrid` expectations
// exactly: a JSON array of one object per queried point (187 = LATS.length *
// LONS.length there — 11 lats * 17 lons), each `{ hourly: { time,
// wind_speed_10m, wind_direction_10m, wind_gusts_10m } }` with `time` in
// unix seconds (`timeformat: 'unixtime'`). fetchWindGrid never reads any
// lat/lon field off the response itself (the grid's lats/lons are the
// hardcoded LATS/LONS constants) so the fixture omits them entirely — only
// the four `hourly` arrays matter.
//
// Uniform 12 kn / 225° (SW, meteorological "coming from") everywhere and at
// every hour: a broad reach for the Langballigau -> Sønderborg leg plan.spec
// drives, fast and deterministic to route. `time` starts at the CURRENT UTC
// hour boundary and is regenerated on every run (see the `pree2e` package.json
// hook) so the departure default (next full hour, PlannerPanel.tsx's
// `nextFullHourMs`) always falls inside the fixture's forecast horizon —
// a fixture frozen at authoring time would go stale and push departure
// beyond the horizon within days.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const N_POINTS = 187; // 11 lats * 17 lons — must match openMeteo.ts's LATS.length * LONS.length
const N_HOURS = 144; // FORECAST_DAYS (6) * 24 — must match openMeteo.ts's FORECAST_DAYS
const WIND_SPEED_KN = 12;
const WIND_DIR_FROM_DEG = 225; // SW
const WIND_GUST_KN = 16;

const startS = Math.floor(Date.now() / 1000 / 3600) * 3600; // current UTC hour boundary, unix seconds

const time = Array.from({ length: N_HOURS }, (_, i) => startS + i * 3600);
const hourly = {
  time,
  wind_speed_10m: Array(N_HOURS).fill(WIND_SPEED_KN),
  wind_direction_10m: Array(N_HOURS).fill(WIND_DIR_FROM_DEG),
  wind_gusts_10m: Array(N_HOURS).fill(WIND_GUST_KN),
};
const fixture = Array.from({ length: N_POINTS }, () => ({ hourly }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '../public/test-fixtures/wind-sw12.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(fixture));

console.log(
  `wrote ${outPath} — ${N_POINTS} points x ${N_HOURS} hours, ` +
    `${WIND_SPEED_KN} kn / ${WIND_DIR_FROM_DEG}°, time[0]=${startS} (${new Date(startS * 1000).toISOString()})`,
);
