#!/usr/bin/env node
// Generates app/public/test-fixtures/wind-docs-plan-route.json — a DOCS-ONLY
// deterministic Open-Meteo response fixture, consumed via the app's
// `?windFixture=` escape hatch (src/state/usePlanFlow.ts) purely so
// docs/screenshots/capture.mjs can produce a reproducible, non-uniform-wind
// hero screenshot (#459) without depending on live Open-Meteo weather (which
// a 2026-08-08 sweep found gives no sail-dominant route across a full 12 h
// window — unschedulable) and without reusing the E2E suite's
// app/public/test-fixtures/wind-sw12.json (uniform 12 kn / 225° everywhere —
// every wind barb identical, a visible synthetic-data tell in a hero image,
// and CI-pinned by plan.spec.ts/annotations.spec.ts/etc. — touching it here
// would risk destabilizing the whole e2e suite for a docs concern).
//
// This file is SEPARATE from gen-wind-fixture.mjs (the e2e fixture
// generator) and is never invoked by `pree2e` or any test — it exists only
// for a maintainer re-running docs/screenshots/capture.mjs to regenerate the
// README hero image. Like wind-sw12.json, the COMMITTED fixture's `time[]`
// starts at generation time and drifts out of the app's forecast horizon
// after a few days — that is expected, not a bug: re-run this script
// immediately before any recapture (see capture.mjs's header for the full
// command).
//
// Shape matches src/services/openMeteo.ts's `fetchWindGrid` expectations
// exactly: one object per queried grid point, in the same lat-major order
// buildUrl() constructs (`for (const lat of LATS) for (const lon of LONS)`,
// i.e. point index p = latIdx * LONS.length + lonIdx — openMeteo.ts's own
// WindGrid-layout comment), each `{ hourly: { time, wind_speed_10m,
// wind_direction_10m, wind_gusts_10m } }` with `time` in unix seconds.
//
// NON-UNIFORM BY DESIGN (#459 requirement 5, and the whole reason this file
// exists instead of just reusing wind-sw12.json): speed and direction both
// vary smoothly across the 11x17 grid via a linear gradient in
// lat/lon-fraction-of-domain space, modelling a plausible SE breeze that
// backs and freshens toward the NE corner of the forecast domain (loosely
// evocative of an approaching front — no physical model, just a smooth,
// visually distinct spatial texture). Every hour carries the SAME spatial
// field (no time variation) — deliberately simple; #459 only requires
// spatial non-uniformity ("visibly varying barbs across the chart"), and a
// static-in-time field is one fewer axis to reason about when tuning for a
// sail-dominant, decided-rig route.
//
// Constants below were hand-tuned (see docs/screenshots/capture.mjs's own
// header for the harbor pair and the reasoning) against this app's committed
// Salona 45 polars (app/public/data/polar-{genoa,fock}.json): at TWS ~7-10 kn
// and TWA ~70-95° (a close-to-beam reach), genoa consistently outpaces fock
// by ~3-5% boat speed — genoa's light-air reaching advantage — which is
// large enough over a ~14 nm route to clear RIG_TIE_BAND_MS (60 s,
// routing/planRoute.ts) decisively, and TWS 7-10 kn at TWA ~70-95° yields
// genoa boat speeds of roughly 7-8 kn, comfortably above the ~3.7 kn
// sail-speed floor (routing/isochrone.ts) that would otherwise plan motor
// legs — see CLAUDE.md's "Motor legs are first-class" domain rule for that
// floor's derivation.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const N_POINTS_LAT = 11; // must match openMeteo.ts's LATS.length
const N_POINTS_LON = 17; // must match openMeteo.ts's LONS.length
const LAT0 = 54.3;
const LON0 = 9.4;
const LAT1 = 55.3; // must match openMeteo.ts's LATS domain (54.3 + 10*0.1)
const LON1 = 11.0; // must match openMeteo.ts's LONS domain (9.4 + 16*0.1)
const N_HOURS = 144; // FORECAST_DAYS (6) * 24, matches openMeteo.ts's FORECAST_DAYS

// Spatial gradient, in kn/° over the domain fraction (0 at LAT0/LON0, 1 at
// LAT1/LON1) — see the header comment above for how these were chosen.
const SPEED_BASE_KN = 7;
const SPEED_LON_RANGE_KN = 6; // +6 kn west -> east across the full domain
const SPEED_LAT_RANGE_KN = 2; // +2 kn south -> north across the full domain
const DIR_BASE_DEG = 130; // SE, "coming from" (meteorological convention)
const DIR_LON_RANGE_DEG = 70; // backs toward SSW->S west -> east
const DIR_LAT_RANGE_DEG = 15;
const GUST_FACTOR = 1.3; // matches gen-wind-fixture.mjs's ~12->16 kn ratio

function windAt(lat, lon) {
  const lonFrac = (lon - LON0) / (LON1 - LON0);
  const latFrac = (lat - LAT0) / (LAT1 - LAT0);
  const speedKn = SPEED_BASE_KN + SPEED_LON_RANGE_KN * lonFrac + SPEED_LAT_RANGE_KN * latFrac;
  const dirDeg =
    (DIR_BASE_DEG + DIR_LON_RANGE_DEG * lonFrac + DIR_LAT_RANGE_DEG * latFrac + 360) % 360;
  return { speedKn, dirDeg };
}

const startS = Math.floor(Date.now() / 1000 / 3600) * 3600; // current UTC hour boundary, unix seconds
const time = Array.from({ length: N_HOURS }, (_, i) => startS + i * 3600);

const fixture = [];
for (let i = 0; i < N_POINTS_LAT; i++) {
  const lat = Number((LAT0 + i * 0.1).toFixed(1));
  for (let j = 0; j < N_POINTS_LON; j++) {
    const lon = Number((LON0 + j * 0.1).toFixed(1));
    const { speedKn, dirDeg } = windAt(lat, lon);
    fixture.push({
      hourly: {
        time,
        wind_speed_10m: Array(N_HOURS).fill(speedKn),
        wind_direction_10m: Array(N_HOURS).fill(dirDeg),
        wind_gusts_10m: Array(N_HOURS).fill(speedKn * GUST_FACTOR),
      },
    });
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '../public/test-fixtures/wind-docs-plan-route.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(fixture));

const corner00 = windAt(LAT0, LON0);
const corner11 = windAt(LAT1, LON1);
console.log(
  `wrote ${outPath} — ${N_POINTS_LAT * N_POINTS_LON} points x ${N_HOURS} hours, ` +
    `time[0]=${startS} (${new Date(startS * 1000).toISOString()})\n` +
    `  SW corner (${LAT0},${LON0}): ${corner00.speedKn.toFixed(1)} kn / ${corner00.dirDeg.toFixed(0)}°\n` +
    `  NE corner (${LAT1},${LON1}): ${corner11.speedKn.toFixed(1)} kn / ${corner11.dirDeg.toFixed(0)}°`,
);
