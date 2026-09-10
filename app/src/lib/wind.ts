import type { LatLon, MaskMeta, WindGrid, WindSample } from '../types';
import { normalizeDeg360, toDeg, toRad } from './geo';

/** Index of the last element <= x (clamped to [0, xs.length-2]) plus fraction. */
function bracket(xs: number[], x: number): { i: number; f: number } {
  if (x <= xs[0]) return { i: 0, f: 0 };
  const n = xs.length;
  if (n === 1) return { i: 0, f: 0 };
  if (x >= xs[n - 1]) return { i: n - 2, f: 1 };
  let i = 0;
  while (xs[i + 1] < x) i++;
  return { i, f: (x - xs[i]) / (xs[i + 1] - xs[i]) };
}

/**
 * #1178: the four bounds `WindField`'s domain-coverage check needs. A
 * `Pick<MaskMeta, ...>` rather than the whole `MaskMeta` so a caller never
 * has to construct a fake `cols`/`rows`/etc. just to pass this — any
 * `MaskMeta` satisfies it structurally.
 */
export type WindLatticeCoverageBounds = Pick<MaskMeta, 'west' | 'south' | 'east' | 'north'>;

/**
 * #1178: whether `grid`'s lat/lon lattice covers `bounds` — the exact
 * predicate `bracket()` above needs to avoid silently clamping. Exported
 * (not private to `WindField`) so `lib/planExport.ts`'s `decodeWindGrid`
 * can apply the SAME check to an untrusted imported grid BEFORE it is ever
 * persisted — see that file's own doc comment for why the import boundary
 * needs this independently of `WindField`'s own constructor check. Sharing
 * one predicate rather than hand-duplicating the inequality in both places
 * is deliberate: the #1178 hazard this whole check exists to catch is
 * exactly the kind of subtly-wrong inequality that a second, independently
 * written copy could reintroduce.
 */
export function windGridCoversBounds(
  grid: Pick<WindGrid, 'lats' | 'lons'>,
  bounds: WindLatticeCoverageBounds,
): boolean {
  const { lats, lons } = grid;
  const latMin = lats[0];
  const latMax = lats[lats.length - 1];
  const lonMin = lons[0];
  const lonMax = lons[lons.length - 1];
  return (
    latMin <= bounds.south &&
    latMax >= bounds.north &&
    lonMin <= bounds.west &&
    lonMax >= bounds.east
  );
}

export class WindField {
  private grid: WindGrid;

  /**
   * #1178: `maskBounds` is OPTIONAL and deliberately not required. `bracket()`
   * below silently CLAMPS a sample outside the grid's own lat/lon range to
   * the nearest edge value — no throw, no warning — so if the wind lattice
   * (`app/src/services/openMeteo.ts`'s `LATS`/`LONS`) ever fails to cover the
   * mask's domain, every out-of-lattice sample would silently plan a route
   * against wind from the WRONG place. When `maskBounds` is supplied, this
   * constructor asserts ONCE, at construction, that the grid's lat/lon extent
   * covers it, and throws if not — so the failure surfaces immediately at the
   * one place real forecast data enters the routing pipeline
   * (`planRoute.ts`'s `new WindField(windGrid, deps.mask.meta)`), rather than
   * silently degrading a plan's wind sampling near the domain edge.
   *
   * It is optional, not unconditional, because dozens of unit tests
   * (`wind.test.ts` itself included) deliberately construct WindFields from
   * NARROW or even single-point synthetic grids to test `bracket()`'s own
   * clamping/interpolation behaviour — the exact thing this check exists to
   * flag as a hazard when it happens with REAL data. Making the check
   * unconditional would make those tests throw, or force them to fabricate a
   * matching fake mask bounds object that means nothing. Every PRODUCTION
   * call site that has a real `NavMask` on hand (`planRoute.ts`) passes
   * `deps.mask.meta`; sites that reconstruct a `WindField` from an
   * ALREADY-VALIDATED `plan.windGrid` (`DepthProfile.tsx`,
   * `DepartureCompare.tsx`, `routeGeoJson.ts`'s `adaptiveBarbFeatures`) omit
   * it deliberately — that grid was already checked once, at the point it
   * was fetched and used to plan the route in `planRoute.ts`, and it is
   * stored/passed through unchanged (never re-fetched) per this repo's own
   * "wind grids are stored with each plan" rule. Omitting the check there
   * does not hide a real production drift: `openMeteo.ts`'s lattice bounds
   * are a MODULE-LEVEL constant, not something that varies per plan, so if
   * it ever stops covering the mask, `planRoute.ts`'s own construction is
   * where that surfaces — every plan goes through it.
   *
   * See `app/src/test/windLatticeMaskCoverage.test.ts` for the SEPARATE,
   * CI-time drift guard between the committed `openMeteo.ts` lattice and
   * `mask.meta.json`. The two are NOT redundant: that test catches drift at
   * CI time against the committed source/data files (so it fires even
   * before a build exists), while THIS assertion catches it at RUNTIME for
   * any `WindGrid` constructed from data the test never saw (e.g. a future
   * dynamic bbox, #295) — neither subsumes the other, so neither should be
   * deleted as "already covered by the other one".
   */
  constructor(grid: WindGrid, maskBounds?: WindLatticeCoverageBounds) {
    const expected = grid.timesMs.length * grid.lats.length * grid.lons.length;
    if (grid.speedKn.length !== expected)
      throw new Error(
        `windGrid speedKn length ${grid.speedKn.length} != timesMs*lats*lons ${expected}`,
      );
    if (grid.dirFromDeg.length !== expected)
      throw new Error(
        `windGrid dirFromDeg length ${grid.dirFromDeg.length} != timesMs*lats*lons ${expected}`,
      );
    if (grid.gustKn.length !== expected)
      throw new Error(
        `windGrid gustKn length ${grid.gustKn.length} != timesMs*lats*lons ${expected}`,
      );
    if (maskBounds && !windGridCoversBounds(grid, maskBounds)) {
      const { lats, lons } = grid;
      throw new Error(
        `windGrid lattice lat [${lats[0]}, ${lats[lats.length - 1]}] lon [${lons[0]}, ${lons[lons.length - 1]}] does not cover mask bounds ` +
          `lat [${maskBounds.south}, ${maskBounds.north}] lon [${maskBounds.west}, ${maskBounds.east}] — ` +
          `sample() would silently clamp points outside the lattice instead of interpolating real forecast data (#1178)`,
      );
    }
    this.grid = grid;
  }

  startMs(): number {
    return this.grid.timesMs[0];
  }

  horizonMs(): number {
    return this.grid.timesMs[this.grid.timesMs.length - 1];
  }

  sample(p: LatLon, tMs: number): WindSample {
    const { lats, lons, timesMs, speedKn, dirFromDeg, gustKn } = this.grid;
    const la = bracket(lats, p.lat);
    const lo = bracket(lons, p.lon);
    const tt = bracket(timesMs, tMs);
    const nLon = lons.length;
    const nLat = lats.length;

    // Accumulate u/v (wind vector TOWARD which air moves) and gust bilinearly,
    // then linearly across the two time slices.
    let u = 0,
      v = 0,
      g = 0;
    for (const [ti, wt] of [
      [tt.i, 1 - tt.f],
      [tt.i + 1 < timesMs.length ? tt.i + 1 : tt.i, tt.f],
    ] as const) {
      if (wt === 0) continue;
      for (const [lai, wla] of [
        [la.i, 1 - la.f],
        [la.i + 1 < nLat ? la.i + 1 : la.i, la.f],
      ] as const) {
        if (wla === 0) continue;
        for (const [loi, wlo] of [
          [lo.i, 1 - lo.f],
          [lo.i + 1 < nLon ? lo.i + 1 : lo.i, lo.f],
        ] as const) {
          if (wlo === 0) continue;
          const k = (ti * nLat + lai) * nLon + loi;
          const w = wt * wla * wlo;
          const sp = speedKn[k];
          const dir = toRad(dirFromDeg[k]);
          u += w * -sp * Math.sin(dir);
          v += w * -sp * Math.cos(dir);
          g += w * gustKn[k];
        }
      }
    }
    const speed = Math.hypot(u, v);
    const dir = speed < 1e-6 ? 0 : normalizeDeg360(toDeg(Math.atan2(-u, -v)));
    return { speedKn: speed, dirFromDeg: dir, gustKn: g };
  }
}
