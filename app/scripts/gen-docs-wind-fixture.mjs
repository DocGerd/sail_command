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
// README hero image.
//
// NOT COMMITTED (fix wave, PR #462 review Major 2): the generated
// wind-docs-plan-route.json is gitignored (see .gitignore's
// "docs-only wind fixtures" entry), on purpose, not merely by omission —
// regenerating it is ALREADY a mandatory step before every recapture (its
// `time[]` starts at generation time and drifts out of the app's forecast
// horizon after ~6 days, same as gen-wind-fixture.mjs's e2e fixture), so a
// committed copy would be dead weight for nearly all of its life: 1.4 MB in
// git history forever, plus ~2.9 MB per deployed ref once Vite copies
// app/public/** into dist (both refs are built into one deploy.yml
// artifact), for bytes nobody is ever meant to actually read against — the
// documented workflow (see capture.mjs's header) always regenerates first.
// Run `node app/scripts/gen-docs-wind-fixture.mjs` before every recapture;
// this is the ONLY source of that file. Verified 2026-08-09 (fix wave):
// deleting the working copy, regenerating, then running capture.mjs against
// a fresh local dev server reproduces an equivalent image end to end — a
// fresh clone that follows the documented sequence needs nothing that isn't
// already committed (the generator itself, in this file).
//
// Shape matches src/services/openMeteo.ts's `fetchWindGrid` expectations
// exactly: one object per queried grid point, in the same lat-major order
// buildUrl() constructs (`for (const lat of LATS) for (const lon of LONS)`,
// i.e. point index p = latIdx * LONS.length + lonIdx — openMeteo.ts's own
// WindGrid-layout comment), each `{ hourly: { time, wind_speed_10m,
// wind_direction_10m, wind_gusts_10m } }` with `time` in unix seconds.
// Values are rounded to 1 decimal (fix wave, PR #462 review Major 2):
// Open-Meteo itself returns 1-dp values, so this makes the fixture MORE
// faithful to the shape it imitates, not less, and it happens to also halve
// the file (measured: 1,478,418 -> 724,866 bytes on the pre-fix-wave
// constants, a 51.0% reduction) — a secondary benefit given the file isn't
// committed any more, but free either way. Re-verified after the rounding
// AND the gradient retune below: Flensburg->Sønderborg still resolves
// byte-for-byte to the same rig recommendation and an unchanged sail/motor
// split (rounding to 0.1 kn / 0.1° is far below anything the solver's
// polar-table interpolation can resolve).
//
// NON-UNIFORM BY DESIGN (#459 requirement 5, and the whole reason this file
// exists instead of just reusing wind-sw12.json): speed and direction both
// vary smoothly via a linear gradient, modelling a plausible SE breeze that
// backs and freshens toward the NE (loosely evocative of an approaching
// front — no physical model, just a smooth, visually distinct spatial
// texture). Every hour carries the SAME spatial field (no time variation) —
// deliberately simple; #459 only requires spatial non-uniformity, and a
// static-in-time field is one fewer axis to reason about when tuning for a
// sail-dominant, decided-rig route.
//
// GRADIENT SCALED TO THE CAPTURED ROUTE, NOT THE FULL FORECAST DOMAIN (fix
// wave, PR #462 review Major 1). The first cut of this file defined the
// gradient's 0..1 fraction over the WHOLE 11x17 grid (lon 9.4-11.0,
// lat 54.3-55.3), but Flensburg->Sønderborg only ever occupies
// lonFrac 0.02-0.24 of that — so ~88% of the designed range never appeared
// in frame, and `barbImageId()`'s 5 kn rounding bucket
// (app/src/lib/windBarbs.ts) put every barb on the route in the SAME
// `barb-10` glyph (verified against the committed PNG: ten cropped barb
// glyphs, all identical, differing only in rotation by <=17.5°). Fixed by
// re-deriving `lonFrac`/`latFrac` over a route-scoped sub-box instead —
// ROUTE_LON0/1 and ROUTE_LAT0/1 below — chosen from the ACTUAL routed
// track, not the harbor endpoints: exported via the app's own "Export GPX"
// button against this fixture (24 trackpoints) and measured
// lat 54.798-54.905 / lon 9.4338-9.7857; the constants below pad that
// slightly (lon 9.40-9.80, lat 54.75-54.95) so the route sits mostly within
// the 0..1 fraction rather than pinned to its edges. This does NOT change
// the 187-point grid shape or its openMeteo.ts-mandated domain — every grid
// point still gets a value from the same formula, just extrapolated
// (fractions outside 0..1, clamped below) for points far from the route,
// which are never sampled by this particular capture anyway.
//
// SPEED_LON_RANGE_KN widened 4->7 in a second pass of the same fix-wave
// round (2026-08-09), from the ACTUAL solved route's own leg table
// (RouteSummary's TWS column — a stronger source than the GPX-trackpoint
// interpolation above, since it's the router's own per-leg wind sample, not
// a re-derived endpoint estimate): the route crossed BOTH the 7.5 kn and
// 12.5 kn `barbImageId()` bucket boundaries — a real glyph SHAPE change
// (bucket 15 adds a second, half-length feather below the first — see
// barbSegments() above) on top of the tick-length change bucket 10 already
// gets over bucket 5, not merely a rotation difference.
//
// #577 (2026-08-19) narrowed the value further to 6.5 to restore a decisive
// rig margin (see the constants comment below) — re-verified the bucket
// crossing survived the retune via the real solved route's own per-leg TWS
// (`planRoute()`, not a browser read this time; see below): on the
// recommended (★) Genoa tab, 21 legs span TWS 6.8-12.9 kn, bucketing to
// {"5": 3, "10": 17, "15": 1} — still all three buckets, though bucket 15
// now covers only a single leg near the route's Sønderborg end (down from 5
// pre-retune) rather than a ~26%-of-distance stretch. HONEST CAVEAT (do not
// overstate this in any user-facing text): whether that one bucket-15 leg is
// actually visible and unoccluded in any given recapture's framing has not
// been re-verified after this retune (the pre-retune framing check found the
// bucket-15 stretch mostly BEHIND the on-map "Route layer controls" panel);
// only the 5->10 crossing was previously confirmed visible.
//
// Constants below were hand-tuned (see docs/screenshots/capture.mjs's own
// header for the harbor pair and the reasoning) against this app's committed
// Salona 45 polars (app/public/data/polars/salona-45-{genoa,fock}.json): at TWS ~7-10 kn
// and TWA ~70-95° (a close-to-beam reach), genoa consistently outpaces fock
// by ~3-5% boat speed — genoa's light-air reaching advantage — which is
// large enough over a ~19 nm route to clear RIG_TIE_BAND_MS (60 s,
// routing/planRoute.ts) decisively, and TWS 7-10 kn at TWA ~70-95° yields
// genoa boat speeds of roughly 7-8 kn, comfortably above the ~3.7 kn
// sail-speed floor (routing/isochrone.ts) that would otherwise plan motor
// legs — see CLAUDE.md's "Motor legs are first-class" domain rule for that
// floor's derivation.
//
// #577 RETUNE (2026-08-19): the #54 multi-boat routing work (landed after
// the 2026-08-09 figures below were measured) shifted this route/fixture
// pair's solve enough that the margin had collapsed from the tuned ~180s
// down to 51.2s — UNDER RIG_TIE_BAND_MS, so the recommendation had drifted
// to a 'tie' (reproduced directly against develop @ 0c494f9 with the
// then-unmodified generator: genoa 10817.6s, fock 10868.8s). Diagnosed and
// fixed the same way as the original #459 tuning — not by trial-and-error
// against a live browser, but by re-solving Flensburg->Sønderborg with the
// real shipped mask/polars via `planRoute()` directly (same code path this
// script's screenshot ultimately exercises, just called from a script
// instead of a browser). SPEED_LON_RANGE_KN narrowed 7->6.5 (keeping the
// TWS span wide enough to still cross both barbImageId() bucket boundaries
// — MEASURED per-leg TWS 6.8-12.9 kn on Genoa, 6.8-13.0 kn on Fock, so the
// route still spans the "5"/"10"/"15" barb buckets, not merely re-tuned back
// toward the pre-#462 single-bucket state). MEASURED result at the retuned
// constant (2026-08-19, same technique): genoa 10814.5s (3h00min) vs fock
// 10961.1s (3h02min), a 146.6s margin — "Faster: Genoa" decisively — with
// 82.7% sail / 17.3% motor on the recommended (★) Genoa tab and 86.3%/13.7%
// on Fock, both comfortably above the >50% sail-dominance requirement.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const N_POINTS_LAT = 11; // must match openMeteo.ts's LATS.length
const N_POINTS_LON = 17; // must match openMeteo.ts's LONS.length
const LAT0 = 54.3; // must match openMeteo.ts's LATS domain start
const LON0 = 9.4; // must match openMeteo.ts's LONS domain start
const N_HOURS = 144; // FORECAST_DAYS (6) * 24, matches openMeteo.ts's FORECAST_DAYS

// Route-scoped gradient box (see the header comment above) — deliberately
// NOT the full forecast domain. Measured via the app's own GPX export
// against Flensburg->Sønderborg on this fixture: track bounds
// lat 54.798-54.905 / lon 9.4338-9.7857, padded slightly.
const ROUTE_LON0 = 9.4;
const ROUTE_LON1 = 9.8;
const ROUTE_LAT0 = 54.75;
const ROUTE_LAT1 = 54.95;

const SPEED_BASE_KN = 6;
const SPEED_LON_RANGE_KN = 6.5; // +6.5 kn west -> east across the route box
const SPEED_LAT_RANGE_KN = 1; // +1 kn south -> north across the route box
const SPEED_MIN_KN = 2; // clamp for physical plausibility outside the route box
const SPEED_MAX_KN = 25;
const DIR_BASE_DEG = 130; // SE, "coming from" (meteorological convention)
const DIR_LON_RANGE_DEG = 25; // backs west -> east across the route box
const DIR_LAT_RANGE_DEG = 8;
const GUST_FACTOR = 1.3; // matches gen-wind-fixture.mjs's ~12->16 kn ratio

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function windAt(lat, lon) {
  const lonFrac = (lon - ROUTE_LON0) / (ROUTE_LON1 - ROUTE_LON0);
  const latFrac = (lat - ROUTE_LAT0) / (ROUTE_LAT1 - ROUTE_LAT0);
  const speedKn = clamp(
    SPEED_BASE_KN + SPEED_LON_RANGE_KN * lonFrac + SPEED_LAT_RANGE_KN * latFrac,
    SPEED_MIN_KN,
    SPEED_MAX_KN,
  );
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
    const speed1 = round1(speedKn);
    const dir1 = round1(dirDeg);
    const gust1 = round1(speedKn * GUST_FACTOR);
    fixture.push({
      hourly: {
        time,
        wind_speed_10m: Array(N_HOURS).fill(speed1),
        wind_direction_10m: Array(N_HOURS).fill(dir1),
        wind_gusts_10m: Array(N_HOURS).fill(gust1),
      },
    });
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '../public/test-fixtures/wind-docs-plan-route.json');
mkdirSync(dirname(outPath), { recursive: true });
const json = JSON.stringify(fixture);
writeFileSync(outPath, json);

const routeStart = windAt(54.798, 9.4338); // Flensburg (measured GPX start)
const routeEnd = windAt(54.905, 9.7857); // Sønderborg (measured GPX end)
console.log(
  `wrote ${outPath} (${json.length} bytes) — ${N_POINTS_LAT * N_POINTS_LON} points x ${N_HOURS} hours, ` +
    `time[0]=${startS} (${new Date(startS * 1000).toISOString()})\n` +
    `  route start (Flensburg): ${routeStart.speedKn.toFixed(1)} kn / ${routeStart.dirDeg.toFixed(0)}°\n` +
    `  route end (Sønderborg): ${routeEnd.speedKn.toFixed(1)} kn / ${routeEnd.dirDeg.toFixed(0)}°`,
);
