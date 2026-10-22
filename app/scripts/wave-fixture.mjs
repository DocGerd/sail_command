// Pure builder for the #1699 wave e2e fixture, shared by gen-wave-fixture.mjs
// and src/services/openMeteo.waves.test.ts (the generated file is gitignored).
// Non-uniform on purpose, so the overlay can show every case:
// - Hs cycles through all five WMO bands by latitude row;
// - NULL_POINTS have an all-null series (no data, never calm);
// - direction (FROM, meteorological) and period vary by column.

export const N_LATS = 14; // must match openMeteo.ts's LATS.length
export const N_LONS = 23; // must match openMeteo.ts's LONS.length
export const N_HOURS = 144; // FORECAST_DAYS (6) * 24
// One value inside each band: calm, smooth, slight, moderate, rough.
const BAND_HEIGHTS_M = [0.05, 0.3, 0.8, 1.8, 3.2];
// [latIdx, lonIdx] of the all-null points.
export const NULL_POINTS = [
  [0, 0],
  [0, 1],
  [1, 0],
  [6, 11],
  [13, 22],
];

// One Open-Meteo Marine point object per lattice point, hourly from `startS`.
export function buildWaveFixture(startS) {
  const time = Array.from({ length: N_HOURS }, (_, i) => startS + i * 3600);
  const isNull = (lat, lon) => NULL_POINTS.some(([a, b]) => a === lat && b === lon);
  const fixture = [];
  for (let lat = 0; lat < N_LATS; lat++) {
    for (let lon = 0; lon < N_LONS; lon++) {
      const series = (v) => Array(N_HOURS).fill(isNull(lat, lon) ? null : v);
      fixture.push({
        hourly: {
          time,
          wave_height: series(BAND_HEIGHTS_M[lat % BAND_HEIGHTS_M.length]),
          wave_direction: series((lon * 16 + lat * 7) % 360),
          wave_period: series(2.5 + (lon % 6) * 0.75),
        },
      });
    }
  }
  return fixture;
}
