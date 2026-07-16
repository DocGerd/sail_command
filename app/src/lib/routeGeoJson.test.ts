import { describe, it, expect } from 'vitest';
import {
  adaptiveBarbFeatures,
  legsToFeatureCollection,
  nearestHourIndex,
  routePointFeatures,
} from './routeGeoJson';
import { formatTime } from './format';
import { makeMask, makeWindGrid } from '../test/fixtures';
import type { LatLon, Leg, MaskMeta } from '../types';

const SAIL_LEG: Leg = {
  kind: 'sail',
  board: 'starboard',
  start: { lat: 54.8, lon: 9.5 },
  end: { lat: 54.85, lon: 9.6 },
  startTimeMs: 0,
  endTimeMs: 3_600_000,
  headingDeg: 90,
  twaDeg: 80,
  twsKn: 12,
  speedKn: 6.5,
  distanceNm: 5,
  maneuverAtStart: null,
};

const TACK_LEG: Leg = {
  kind: 'sail',
  board: 'port',
  start: { lat: 54.85, lon: 9.6 },
  end: { lat: 54.9, lon: 9.65 },
  startTimeMs: 3_600_000,
  endTimeMs: 7_200_000,
  headingDeg: 340,
  twaDeg: -60,
  twsKn: 12,
  speedKn: 6.0,
  distanceNm: 4,
  maneuverAtStart: 'tack',
};

const MOTOR_LEG: Leg = {
  kind: 'motor',
  board: null,
  start: { lat: 54.9, lon: 9.65 },
  end: { lat: 54.92, lon: 9.7 },
  startTimeMs: 7_200_000,
  endTimeMs: 9_000_000,
  headingDeg: 45,
  twsKn: 1,
  speedKn: 6.5,
  distanceNm: 2,
  maneuverAtStart: null,
};

const GYBE_LEG: Leg = {
  kind: 'sail',
  board: 'starboard',
  start: { lat: 54.92, lon: 9.7 },
  end: { lat: 54.95, lon: 9.8 },
  startTimeMs: 9_000_000,
  endTimeMs: 12_600_000,
  headingDeg: 200,
  twaDeg: 150,
  twsKn: 12,
  speedKn: 5.5,
  distanceNm: 3,
  maneuverAtStart: 'gybe',
};

describe('legsToFeatureCollection', () => {
  it('emits one LineString feature per leg, coordinates in [lon, lat] order', () => {
    const fc = legsToFeatureCollection([SAIL_LEG]);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [9.5, 54.8],
        [9.6, 54.85],
      ],
    });
  });

  it('tags a sail leg with kind, board, maneuver and a bare-knots speedLabel', () => {
    const fc = legsToFeatureCollection([TACK_LEG]);
    expect(fc.features[0].properties).toEqual({
      kind: 'sail',
      board: 'port',
      maneuver: 'tack',
      legIndex: 0,
      speedLabel: '6.0 kn',
    });
  });

  it('tags a motor leg with board null, maneuver null and a motor-prefixed speedLabel', () => {
    const fc = legsToFeatureCollection([MOTOR_LEG]);
    expect(fc.features[0].properties).toEqual({
      kind: 'motor',
      board: null,
      maneuver: null,
      legIndex: 0,
      speedLabel: 'M · 6.5 kn', // default motor letter
    });
  });

  it('uses the injected motor letter in the speedLabel', () => {
    const fc = legsToFeatureCollection([MOTOR_LEG], { motorLetter: 'X' });
    expect(fc.features[0].properties.speedLabel).toBe('X · 6.5 kn');
  });

  it('tags each feature with its index into the legs array', () => {
    const fc = legsToFeatureCollection([SAIL_LEG, TACK_LEG, MOTOR_LEG]);
    expect(fc.features.map((f) => f.properties.legIndex)).toEqual([0, 1, 2]);
  });

  it('returns an empty feature collection for no legs', () => {
    expect(legsToFeatureCollection([])).toEqual({ type: 'FeatureCollection', features: [] });
  });
});

describe('routePointFeatures', () => {
  const ETA_MS = 12_600_000;

  it('emits start (legs[0].start) and finish (last leg end) with their times', () => {
    const fc = routePointFeatures([SAIL_LEG, TACK_LEG, MOTOR_LEG], ETA_MS, 'en');
    const start = fc.features.find((f) => f.properties.kind === 'start')!;
    const finish = fc.features.find((f) => f.properties.kind === 'finish')!;
    expect(start.geometry.coordinates).toEqual([9.5, 54.8]);
    expect(start.properties.eta).toBe(formatTime(0, 'en'));
    expect(finish.geometry.coordinates).toEqual([9.7, 54.92]); // MOTOR_LEG.end
    expect(finish.properties.eta).toBe(formatTime(ETA_MS, 'en'));
  });

  it('emits one tack/gybe feature per maneuver joint and one heading feature per plain joint', () => {
    const fc = routePointFeatures([SAIL_LEG, TACK_LEG, GYBE_LEG, MOTOR_LEG], ETA_MS, 'en');
    const kinds = fc.features.map((f) => f.properties.kind);
    // SAIL(start) · TACK(tack) · GYBE(gybe) · MOTOR(heading, maneuver null) · finish
    expect(kinds).toEqual(['start', 'tack', 'gybe', 'heading', 'finish']);
    const tack = fc.features.find((f) => f.properties.kind === 'tack')!;
    expect(tack.geometry.coordinates).toEqual([9.6, 54.85]); // TACK_LEG.start
    expect(tack.properties.eta).toBe(formatTime(3_600_000, 'en'));
    const heading = fc.features.find((f) => f.properties.kind === 'heading')!;
    expect(heading.geometry.coordinates).toEqual([9.65, 54.9]); // MOTOR_LEG.start
  });

  it('ranks finish=0 < start=1 < maneuvers=2 < heading=3', () => {
    const fc = routePointFeatures([SAIL_LEG, TACK_LEG, GYBE_LEG, MOTOR_LEG], ETA_MS, 'en');
    const rankOf = (kind: string) =>
      fc.features.find((f) => f.properties.kind === kind)!.properties.rank;
    expect(rankOf('finish')).toBe(0);
    expect(rankOf('start')).toBe(1);
    expect(rankOf('tack')).toBe(2);
    expect(rankOf('gybe')).toBe(2);
    expect(rankOf('heading')).toBe(3);
  });

  it('formats eta via formatTime for the given language', () => {
    for (const lang of ['de', 'en'] as const) {
      const fc = routePointFeatures([SAIL_LEG, TACK_LEG, MOTOR_LEG], ETA_MS, lang);
      // HH:mm h23 is locale-invariant across de/en, so the strings match between
      // languages; the lang param is still threaded through formatTime.
      for (const f of fc.features) expect(f.properties.eta).toMatch(/^\d{2}:\d{2}$/);
      const start = fc.features.find((f) => f.properties.kind === 'start')!;
      expect(start.properties.eta).toBe(formatTime(0, lang));
    }
  });

  it('emits only start + finish for a single-leg route (no joints)', () => {
    const fc = routePointFeatures([SAIL_LEG], 3_600_000, 'en');
    expect(fc.features.map((f) => f.properties.kind)).toEqual(['start', 'finish']);
  });

  it('returns an empty feature collection for no legs', () => {
    expect(routePointFeatures([], 0, 'en')).toEqual({ type: 'FeatureCollection', features: [] });
  });
});

describe('nearestHourIndex', () => {
  it('picks the nearest index and resolves ties to the earlier one', () => {
    expect(nearestHourIndex([0, 3_600_000], 3_600_000 - 1000)).toBe(1);
    expect(nearestHourIndex([0, 3_600_000], 1000)).toBe(0);
    expect(nearestHourIndex([0, 3_600_000], 1_800_000)).toBe(0); // exact midpoint → earlier
  });
});

describe('adaptiveBarbFeatures', () => {
  // Real regional grid geometry: lats 54.3..55.3, lons 9.4..11.0, 0.1° step
  // (11 x 17 = 187 nodes), constant wind so only the sampling geometry matters.
  const GRID = makeWindGrid(() => ({ speedKn: 10, dirFromDeg: 180 }), { hours: 3 });
  const T0 = GRID.timesMs[0];

  // Pure linear projector: px = degrees * scale, independent of the viewport
  // pan, so shifting bounds simulates a pan without changing the screen scale.
  const proj = (scale: number) => (p: LatLon) => ({
    x: (p.lon - 9.0) * scale,
    y: (55.5 - p.lat) * scale,
  });

  const key = (c: number[]) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

  const BARB_LEG: Leg = {
    kind: 'sail',
    board: 'starboard',
    start: { lat: 54.5, lon: 9.6 },
    end: { lat: 55.0, lon: 10.0 },
    startTimeMs: T0,
    endTimeMs: T0 + 3_600_000,
    headingDeg: 45,
    twaDeg: 80,
    twsKn: 10,
    speedKn: 6,
    distanceNm: 20,
    maneuverAtStart: null,
  };

  // All-land mask: every lattice point is culled (depthM 0), leaving a
  // ribbon-only result (the ribbon is never land-culled). Cleaner than a
  // far-away viewport for isolating the ribbon now that it is viewport-clipped.
  const allLand = makeMask(() => 0);

  it('is deterministic and dense at overview zoom (the #36 repro: > 3 barbs)', () => {
    const view = {
      project: proj(1000),
      bounds: { west: 9.5, south: 54.5, east: 10.5, north: 55.0 },
    };
    const a = adaptiveBarbFeatures(GRID, T0, view, [], null);
    const b = adaptiveBarbFeatures(GRID, T0, view, [], null);
    expect(a).toEqual(b);
    expect(a.features.length).toBeGreaterThan(3);
    for (const f of a.features) expect(f.properties).toHaveProperty('speedKn');
  });

  it('lattice is grid-index-anchored, so it is pan-stable across a non-lattice shift', () => {
    const p = proj(1000);
    const boundsA = { west: 9.5, south: 54.5, east: 10.5, north: 55.0 };
    const boundsB = { west: 9.53, south: 54.53, east: 10.53, north: 55.03 }; // shifted 0.03° (non-lattice)
    const fcA = adaptiveBarbFeatures(GRID, T0, { project: p, bounds: boundsA }, [], null);
    const fcB = adaptiveBarbFeatures(GRID, T0, { project: p, bounds: boundsB }, [], null);
    // Points inside the overlap of the two unpadded viewports must match exactly.
    const overlap = { west: 9.53, south: 54.53, east: 10.5, north: 55.0 };
    const inOverlap = (c: number[]) =>
      c[0] >= overlap.west &&
      c[0] <= overlap.east &&
      c[1] >= overlap.south &&
      c[1] <= overlap.north;
    const coordsIn = (fc: ReturnType<typeof adaptiveBarbFeatures>) =>
      fc.features
        .map((f) => f.geometry.coordinates)
        .filter(inOverlap)
        .map(key)
        .sort();
    expect(coordsIn(fcA).length).toBeGreaterThan(0);
    expect(coordsIn(fcA)).toEqual(coordsIn(fcB));
  });

  it('clamps subdivision to n >= -2 (never finer than a quarter grid step)', () => {
    // Huge scale → native step is enormous on screen → without the clamp n would
    // go very negative; the clamp holds the lattice step at 0.1 * 2^-2 = 0.025°.
    const view = {
      project: proj(100_000),
      bounds: { west: 9.5, south: 54.5, east: 9.6, north: 54.6 },
    };
    const fc = adaptiveBarbFeatures(GRID, T0, view, [], null);
    const lats = [
      ...new Set(fc.features.map((f) => Number(f.geometry.coordinates[1].toFixed(6)))),
    ].sort((x, y) => x - y);
    expect(lats.length).toBeGreaterThan(1);
    let minDiff = Infinity;
    for (let i = 1; i < lats.length; i++) minDiff = Math.min(minDiff, lats[i] - lats[i - 1]);
    expect(minDiff).toBeGreaterThan(0.02); // finer than 0.025 would mean the clamp failed
    expect(minDiff).toBeLessThan(0.03);
  });

  it('caps total features at 500, ribbon first and budget spent in-view', () => {
    const bigView = {
      project: proj(4000),
      bounds: { west: 9.4, south: 54.3, east: 11.0, north: 55.3 },
    };
    const full = adaptiveBarbFeatures(GRID, T0, bigView, [BARB_LEG], null);
    expect(full.features.length).toBe(500);

    // Ribbon-only via an all-land mask (lattice culled; ribbon never is). The
    // leg is fully inside bigView, so this is every ribbon sample.
    const ribbonOnly = adaptiveBarbFeatures(GRID, T0, bigView, [BARB_LEG], allLand);
    expect(ribbonOnly.features.length).toBeGreaterThan(0);
    expect(ribbonOnly.features.length).toBeLessThan(500);

    // Ribbon leads the feature list (priority under the cap): the first
    // ribbonOnly.length features of the full result are exactly the ribbon.
    for (let i = 0; i < ribbonOnly.features.length; i++) {
      expect(key(full.features[i].geometry.coordinates)).toBe(
        key(ribbonOnly.features[i].geometry.coordinates),
      );
    }
  });

  it('spaces ribbon samples ~110 px apart, starting a half-interval in', () => {
    const p = proj(1000);
    // All-land mask → ribbon only; the whole leg is inside the viewport.
    const view = { project: p, bounds: { west: 9.4, south: 54.3, east: 11.0, north: 55.3 } };
    const fc = adaptiveBarbFeatures(GRID, T0, view, [BARB_LEG], allLand);
    const screens = fc.features.map((f) =>
      p({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }),
    );
    const ps = p(BARB_LEG.start);
    // First sample sits ~half an interval (55 px) down the leg from the start.
    const firstOffset = Math.hypot(screens[0].x - ps.x, screens[0].y - ps.y);
    expect(firstOffset).toBeGreaterThan(45);
    expect(firstOffset).toBeLessThan(65);
    // Consecutive samples are ~110 px apart.
    for (let i = 1; i < screens.length; i++) {
      const d = Math.hypot(screens[i].x - screens[i - 1].x, screens[i].y - screens[i - 1].y);
      expect(d).toBeGreaterThan(100);
      expect(d).toBeLessThan(120);
    }
  });

  it('clips ribbon to the padded viewport: in-view samples kept, off-view dropped', () => {
    const p = proj(2000);
    // A long leg spanning the whole grid; a small viewport over its middle.
    const longLeg: Leg = {
      ...BARB_LEG,
      start: { lat: 54.3, lon: 9.4 },
      end: { lat: 55.3, lon: 11.0 },
    };
    const bounds = { west: 10.0, south: 54.7, east: 10.3, north: 54.9 };
    // All-land mask → the count is purely the clipped ribbon.
    const ribbon = adaptiveBarbFeatures(
      GRID,
      T0,
      { project: p, bounds },
      [longLeg],
      allLand,
    ).features;
    expect(ribbon.length).toBeGreaterThan(0);

    // Reference padded on-screen rect (RIBBON_PX = 110), same 4-corner method.
    const corners = [
      p({ lat: bounds.north, lon: bounds.west }),
      p({ lat: bounds.north, lon: bounds.east }),
      p({ lat: bounds.south, lon: bounds.west }),
      p({ lat: bounds.south, lon: bounds.east }),
    ];
    const minX = Math.min(...corners.map((c) => c.x)) - 110;
    const maxX = Math.max(...corners.map((c) => c.x)) + 110;
    const minY = Math.min(...corners.map((c) => c.y)) - 110;
    const maxY = Math.max(...corners.map((c) => c.y)) + 110;
    const inRect = (s: { x: number; y: number }) =>
      s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;

    // Every emitted ribbon sample is inside the padded rect.
    for (const f of ribbon) {
      const s = p({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });
      expect(inRect(s)).toBe(true);
    }
    // The count equals exactly the in-view samples of the full leg (out-of-view
    // dropped, in-view unchanged).
    const ps = p(longLeg.start);
    const pe = p(longLeg.end);
    const len = Math.hypot(pe.x - ps.x, pe.y - ps.y);
    let expected = 0;
    for (let d = 55; d <= len; d += 110) {
      const s = { x: ps.x + ((pe.x - ps.x) * d) / len, y: ps.y + ((pe.y - ps.y) * d) / len };
      if (inRect(s)) expected++;
    }
    expect(ribbon.length).toBe(expected);
    // The clip really dropped most of the long leg's samples.
    expect(expected).toBeLessThan(Math.floor(len / 110));
  });

  it('samples lattice AND ribbon at the slider time, not a fixed hour', () => {
    // Wind uniform in space but hour-dependent: 5 + hourIdx*10 kn.
    const grid = makeWindGrid((_lat, _lon, h) => ({ speedKn: 5 + h * 10, dirFromDeg: 180 }), {
      hours: 3,
    });
    const view = {
      project: proj(1000),
      bounds: { west: 9.4, south: 54.3, east: 11.0, north: 55.3 },
    };
    // Sample at hour index 1 → every barb (lattice and ribbon) must read 15 kn.
    const fc = adaptiveBarbFeatures(grid, grid.timesMs[1], view, [BARB_LEG], null);
    expect(fc.features.length).toBeGreaterThan(0);
    for (const f of fc.features) expect(f.properties.speedKn).toBeCloseTo(15, 5);
    // The ribbon alone (all-land mask) also reads the slider hour.
    const ribbon = adaptiveBarbFeatures(grid, grid.timesMs[1], view, [BARB_LEG], allLand);
    expect(ribbon.features.length).toBeGreaterThan(0);
    for (const f of ribbon.features) expect(f.properties.speedKn).toBeCloseTo(15, 5);
    // At hour 0 the same barbs read 5 kn — proves it's the slider hour, not fixed.
    const fc0 = adaptiveBarbFeatures(grid, grid.timesMs[0], view, [BARB_LEG], null);
    for (const f of fc0.features) expect(f.properties.speedKn).toBeCloseTo(5, 5);
  });

  it('skips lattice barbs within 48 px of a ribbon sample', () => {
    const p = proj(1000);
    const view = { project: p, bounds: { west: 9.4, south: 54.3, east: 11.0, north: 55.3 } };
    const full = adaptiveBarbFeatures(GRID, T0, view, [BARB_LEG], null);
    // Same viewport, all-land mask → ribbon only (coords identical to full's ribbon).
    const ribbonOnly = adaptiveBarbFeatures(GRID, T0, view, [BARB_LEG], allLand);
    const ribbonKeys = new Set(ribbonOnly.features.map((f) => key(f.geometry.coordinates)));
    const ribbonScreens = ribbonOnly.features.map((f) =>
      p({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }),
    );
    for (const f of full.features) {
      if (ribbonKeys.has(key(f.geometry.coordinates))) continue; // a ribbon barb itself
      const s = p({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });
      for (const rs of ribbonScreens) {
        expect(Math.hypot(s.x - rs.x, s.y - rs.y)).toBeGreaterThanOrEqual(48);
      }
    }
  });

  it('land-culls lattice barbs via the mask, and keeps them all when mask is null', () => {
    const meta: MaskMeta = {
      west: 9.4,
      south: 54.3,
      east: 11.0,
      north: 55.3,
      cols: 320,
      rows: 200,
    };
    const lonStep = (meta.east - meta.west) / meta.cols;
    // Everything east of lon 10.2 is land (byte 0); west is 20 m water (byte 200).
    const landEast = makeMask((_r, c) => (meta.west + (c + 0.5) * lonStep > 10.2 ? 0 : 200), meta);
    const view = {
      project: proj(1000),
      bounds: { west: 9.4, south: 54.3, east: 11.0, north: 55.3 },
    };

    const culled = adaptiveBarbFeatures(GRID, T0, view, [], landEast);
    const uncapped = adaptiveBarbFeatures(GRID, T0, view, [], null);

    expect(culled.features.length).toBeLessThan(uncapped.features.length);
    // Every kept barb sits on water.
    for (const f of culled.features) {
      const d = landEast.depthM({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });
      expect(d).toBeGreaterThan(0);
    }
    // Without a mask, some barbs land on the (un-culled) land cells.
    const onLand = uncapped.features.filter(
      (f) =>
        landEast.depthM({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }) <= 0,
    );
    expect(onLand.length).toBeGreaterThan(0);
  });

  it('emits nothing when the viewport is off-grid and there is no route', () => {
    const view = { project: proj(1000), bounds: { west: 20, south: 60, east: 21, north: 61 } };
    expect(adaptiveBarbFeatures(GRID, T0, view, [], null).features).toHaveLength(0);
  });
});
