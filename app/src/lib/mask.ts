import type { LatLon, MaskMeta } from '../types';
import { haversineNm, toRad } from './geo';

const LAND = 0;
const NM_PER_M = 1 / 1852;

/**
 * Mirrors pipeline/build_mask.py's TOLERANCE_M (mask-build tolerance) on the
 * TypeScript side — nothing compiles across that Python/TS boundary, so
 * app/src/test/maskTolerance.test.ts reads the Python source and fails
 * closed if this value ever drifts from it. build_mask.py blends bilinear
 * over the conservative Resampling.max reading only where the two agree
 * within this bound, so for every cell: depth_blend <= depth_max +
 * MASK_TOLERANCE_M (see that file's own derivation comment, at the
 * `TOLERANCE_M` assignment, for the full argument).
 *
 * Why 0.9 is the value: that comment derives it directly from the blend rule
 * and the boat's draft — at the default gate G = 3.0 m, G - TOLERANCE_M =
 * 2.1 m, exactly BOAT_DRAFT_M (app/src/routing/relaxedDepth.ts). In the
 * source's own words, "this value is derived from the blend rule and the
 * draft; it is not fitted to an outcome."
 *
 * Separately, under that same comment's "LOWER IS NOT SAFER" heading: 0.9
 * cannot simply be tightened (lowered) either — that heading records a
 * measured limit on how far down it can go, not the reason 0.9 was chosen.
 * On the DTM the pipeline builds from, Marstal's approach (at its 2.0 m
 * exception gate) is DISCONNECTED for TOLERANCE_M <= 0.87 m and connects
 * from 0.88 m up, so 0.9 clears that wall by only ~0.03 m.
 */
export const MASK_TOLERANCE_M = 0.9;

/**
 * #493: a SOUND LOWER BOUND on the mask's more cautious (conservative,
 * Resampling.max) reading for a cell whose SHIPPED (blended) depth is
 * `shippedDepthM` — never the true cautious value itself, only a floor it
 * cannot be below. Directly from build_mask.py's blend rule: depth_blend <=
 * depth_max + MASK_TOLERANCE_M, so depth_max >= depth_blend -
 * MASK_TOLERANCE_M. Gate-independent — a property of the mask build, not of
 * any safety gate a user picks.
 *
 * Floors to 0.1 m (never rounds), so the displayed figure can never read
 * deeper than this bound provably allows, and clamps at 0 (depth cannot be
 * negative). The floor is nudged by a sub-decimetre epsilon before
 * quantizing: `shippedDepthM - MASK_TOLERANCE_M` is exact in real-number
 * arithmetic for many inputs (e.g. 2.3 - 0.9 = 1.4) but IEEE754 double
 * precision can land a hair below the true value for others (1.4 - 0.9 =
 * 0.4999999999999999) — a bare `Math.floor` on that residue would silently
 * cost an extra, unearned decimetre of pessimism. The epsilon is far smaller
 * than any real 0.1 m quantization step, so it can never round a genuine
 * fractional depth UP.
 */
export function cautiousDepthLowerBoundM(shippedDepthM: number): number {
  const bound = shippedDepthM - MASK_TOLERANCE_M;
  const flooredTenthsM = Math.floor(bound * 10 + 1e-9);
  return Math.max(0, flooredTenthsM / 10);
}

export class NavMask {
  readonly meta: MaskMeta;
  private data: Uint8Array;
  private latStep: number;
  private lonStep: number;

  constructor(meta: MaskMeta, data: Uint8Array) {
    if (data.length !== meta.rows * meta.cols)
      throw new Error(`mask data length ${data.length} != rows*cols ${meta.rows * meta.cols}`);
    this.meta = meta;
    this.data = data;
    this.latStep = (meta.north - meta.south) / meta.rows;
    this.lonStep = (meta.east - meta.west) / meta.cols;
  }

  private cellOf(p: LatLon): { row: number; col: number } | null {
    const row = Math.floor((p.lat - this.meta.south) / this.latStep);
    const col = Math.floor((p.lon - this.meta.west) / this.lonStep);
    if (row < 0 || row >= this.meta.rows || col < 0 || col >= this.meta.cols) return null;
    return { row, col };
  }

  private depthByte(row: number, col: number): number {
    return this.data[row * this.meta.cols + col];
  }

  private byteToDepthM(b: number): number {
    return b === LAND ? 0 : b === 255 ? 25.4 : b / 10;
  }

  depthM(p: LatLon): number {
    const c = this.cellOf(p);
    return c ? this.byteToDepthM(this.depthByte(c.row, c.col)) : 0;
  }

  /**
   * Depth in metres plus whether the underlying byte is the deep-cap sentinel
   * (255 = "deep, >= 25.4 m"). Byte 254 is *reserved* by the encoding for a
   * measured 25.4 m reading and also decodes to 25.4 via byteToDepthM — the
   * current pipeline never emits it (build_mask.py folds every >= 25.4 m
   * reading into 255, and the committed mask has zero 254 bytes), but relying
   * on that would be fragile, so depthM alone cannot robustly tell "deep,
   * capped" from a 25.4 m reading; the explicit `capped` flag is the honest
   * discriminator, used by the depth profile's ">= 25 m" rendering. Additive
   * accessor: depthM/isNavigable/segmentNavigable behaviour is unchanged.
   */
  depthInfoM(p: LatLon): { depthM: number; capped: boolean } {
    const c = this.cellOf(p);
    if (!c) return { depthM: 0, capped: false };
    const b = this.depthByte(c.row, c.col);
    return { depthM: this.byteToDepthM(b), capped: b === 255 };
  }

  isNavigable(p: LatLon, safetyDepthM: number): boolean {
    const c = this.cellOf(p);
    if (!c) return false;
    const b = this.depthByte(c.row, c.col);
    return b !== LAND && this.byteToDepthM(b) >= safetyDepthM;
  }

  private cellNavigable(row: number, col: number, safetyDepthM: number): boolean {
    if (row < 0 || row >= this.meta.rows || col < 0 || col >= this.meta.cols) return false;
    const b = this.depthByte(row, col);
    return b !== LAND && this.byteToDepthM(b) >= safetyDepthM;
  }

  /**
   * Amanatides–Woo grid traversal from a to b, visiting every touched cell in
   * order. `visit` returning false aborts the walk. Returns true only when the
   * walk reached b's cell with every visit accepting; false on an abort or
   * when the bounded iteration guard trips.
   */
  private walkCells(a: LatLon, b: LatLon, visit: (row: number, col: number) => boolean): boolean {
    // continuous grid coordinates (col-space x, row-space y)
    const x0 = (a.lon - this.meta.west) / this.lonStep;
    const y0 = (a.lat - this.meta.south) / this.latStep;
    const x1 = (b.lon - this.meta.west) / this.lonStep;
    const y1 = (b.lat - this.meta.south) / this.latStep;
    let cx = Math.floor(x0);
    let cy = Math.floor(y0);
    const ex = Math.floor(x1);
    const ey = Math.floor(y1);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
    let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? cx + 1 - x0 : x0 - cx) * tDeltaX;
    let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? cy + 1 - y0 : y0 - cy) * tDeltaY;

    if (!visit(cy, cx)) return false;
    // guard: bounded number of iterations
    for (let iter = 0; iter < this.meta.rows + this.meta.cols + 4; iter++) {
      if (cx === ex && cy === ey) return true;
      if (tMaxX < tMaxY) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        cy += stepY;
        tMaxY += tDeltaY;
      }
      if (!visit(cy, cx)) return false;
    }
    return false;
  }

  /** Every cell the a→b segment touches must be navigable at the given gate. */
  segmentNavigable(a: LatLon, b: LatLon, safetyDepthM: number): boolean {
    return this.walkCells(a, b, (row, col) => this.cellNavigable(row, col, safetyDepthM));
  }

  /**
   * Minimum charted depth over every cell the a→b segment touches, or null
   * exactly when {@link segmentNavigable} would report false (any touched
   * cell below `gateM`, land, or out of bounds) — one `walkCells` pass with
   * the SAME gate check as `segmentNavigable`'s, inlined here (rather than
   * calling `cellNavigable`, which would decode the same byte a second
   * time per cell — this is a hot path, walked for every candidate edge the
   * solver considers) so the set of cells visited and the abort condition
   * stay identical to `segmentNavigable`'s. Used by #243's depth comfort
   * preference to price a segment's clearance beyond the hard gate.
   *
   * UNLIKE {@link segmentShallowestBelow}, deep-capped cells (byte 255)
   * count as a finite 25.4 m in the minimum here, NOT excluded —
   * `segmentShallowestBelow` answers "how shallow" (a "≥25.4 m, actual
   * unknown" reading is correctly never a shallow one), this method answers
   * "how deep" (25.4 m is the honest floor a deep-capped cell guarantees,
   * so it can legitimately BE the segment's minimum). Inert today only
   * because OptionsPanel bounds `safetyDepthM` (max 10) and
   * `depthComfortMarginM` (max 5) so the comfort target never exceeds
   * 15 m — a 25.4 m cell can never end up the binding minimum. Revisit this
   * if either bound widens past 25.4 m.
   */
  segmentClearanceM(a: LatLon, b: LatLon, gateM: number): number | null {
    let min = Infinity;
    const { rows, cols } = this.meta;
    const completed = this.walkCells(a, b, (row, col) => {
      if (row < 0 || row >= rows || col < 0 || col >= cols) return false;
      const byte = this.depthByte(row, col);
      if (byte === LAND) return false;
      const depthM = this.byteToDepthM(byte);
      if (depthM < gateM) return false;
      if (depthM < min) min = depthM;
      return true;
    });
    return completed ? min : null;
  }

  /**
   * Shallowest charted depth among cells the a→b segment touches that are
   * charted strictly below `thresholdM`; null when no touched cell is. Used by
   * #53's per-leg shallow flagging (threshold = the REQUESTED safety depth).
   * Deep-capped cells (byte 255, "≥ 25.4 m — actual depth unknown") never
   * count as shallow: the cap is a floor, not a reading (depthInfoM's
   * `capped` is the honest discriminator, never `depthM === 25.4`). Returns
   * null too when the walk leaves the grid or trips its iteration guard —
   * callers only ever hand this segments the solver already validated.
   */
  segmentShallowestBelow(a: LatLon, b: LatLon, thresholdM: number): number | null {
    let min = Infinity;
    const completed = this.walkCells(a, b, (row, col) => {
      if (row < 0 || row >= this.meta.rows || col < 0 || col >= this.meta.cols) return false;
      const byte = this.depthByte(row, col);
      if (byte === 255) return true; // deep cap: never shallow
      const depthM = this.byteToDepthM(byte);
      if (depthM < thresholdM && depthM < min) min = depthM;
      return true;
    });
    return completed && min !== Infinity ? min : null;
  }

  /**
   * #505: exhaustive per-cell minimum depth reading over the a→b segment —
   * the same {depthM, capped} shape {@link depthInfoM} returns for one point,
   * but walked over EVERY cell the segment touches (the same Amanatides–Woo
   * walk as segmentShallowestBelow/segmentClearanceM) instead of read at a
   * single point. Built for the depth-profile chart's headline "min." figure,
   * which previously came from a uniform-in-TIME sample series (up to 240
   * points, sized for chart rendering, not route coverage) that could step
   * over a leg shorter than the sample interval and understate how shallow
   * the route actually gets.
   *
   * Unlike segmentShallowestBelow (only reports cells below a threshold) and
   * segmentClearanceM (aborts the whole segment below a gate), this has no
   * threshold or gate: it always reports the unconditional minimum, so a
   * caller building a route-wide headline figure never misses a cell either
   * of those gated methods would exclude. Land (byte 0) is included as a
   * 0 m reading rather than aborting the walk, matching
   * segmentShallowestBelow's treatment (not segmentClearanceM's) — the
   * intended callers hand this legs a solver already validated as
   * land-free, so this only matters as a well-defined, maximally-honest
   * fallback. `capped` is true only when the MINIMUM-depth cell itself is
   * deep-capped (byte 255): since a capped cell always decodes to the
   * encoding's deepest representable value (25.4 m), that can only happen
   * when every cell the segment touches is deep-capped — mirroring
   * depthInfoM's per-point "≥ 25 m" contract at route-wide scale.
   *
   * Returns null exactly when the walk leaves the grid or trips its
   * iteration guard. There is no "no cell" case to confuse that with (every
   * completed walk visits at least one cell), so unlike
   * segmentShallowestBelow this method's null is unambiguous on its own —
   * but per the #251/#255 rule, a caller building a SAFETY figure should
   * still bound-check both endpoints against `meta` first, since silently
   * skipping a leg whose walk aborted (rather than treating the whole
   * result as unavailable) risks excluding the leg that was actually the
   * route's true minimum, which is the unsafe direction for a depth figure.
   */
  segmentMinDepthInfoM(a: LatLon, b: LatLon): { depthM: number; capped: boolean } | null {
    let minDepthM = Infinity;
    let minCapped = false;
    const completed = this.walkCells(a, b, (row, col) => {
      if (row < 0 || row >= this.meta.rows || col < 0 || col >= this.meta.cols) return false;
      const byte = this.depthByte(row, col);
      const depthM = this.byteToDepthM(byte);
      if (depthM < minDepthM) {
        minDepthM = depthM;
        minCapped = byte === 255;
      }
      return true;
    });
    return completed && minDepthM !== Infinity ? { depthM: minDepthM, capped: minCapped } : null;
  }

  /**
   * True when a's cell and b's cell are 4-connected through cells navigable at
   * `safetyDepthM` (query-time gate, like every navigability decision). A
   * cheap BFS over the raw byte grid — #53's relaxed-depth discovery probes
   * this per candidate gate instead of running the isochrone solver. Any
   * solver-emitted route implies such a chain (segmentNavigable's traversal
   * steps one cell at a time in x or y, so its swept cells are themselves
   * 4-connected), which is what makes "disconnected ⇒ unreachable" sound.
   */
  cellsConnected(a: LatLon, b: LatLon, safetyDepthM: number): boolean {
    const ca = this.cellOf(a);
    const cb = this.cellOf(b);
    if (!ca || !cb) return false;
    if (
      !this.cellNavigable(ca.row, ca.col, safetyDepthM) ||
      !this.cellNavigable(cb.row, cb.col, safetyDepthM)
    )
      return false;
    const { rows, cols } = this.meta;
    const target = cb.row * cols + cb.col;
    const startIdx = ca.row * cols + ca.col;
    if (startIdx === target) return true;
    const visited = new Uint8Array(rows * cols);
    const queue = new Int32Array(rows * cols);
    let head = 0;
    let tail = 0;
    visited[startIdx] = 1;
    queue[tail++] = startIdx;
    while (head < tail) {
      const idx = queue[head++];
      const row = (idx / cols) | 0;
      const col = idx - row * cols;
      // 4-neighborhood (edge-sharing only — diagonal corner touches do not
      // connect; mirrors pipeline/verify_mask.py's flood fill).
      for (const [nr, nc] of [
        [row - 1, col],
        [row + 1, col],
        [row, col - 1],
        [row, col + 1],
      ]) {
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const nIdx = nr * cols + nc;
        if (visited[nIdx]) continue;
        if (!this.cellNavigable(nr, nc, safetyDepthM)) continue;
        if (nIdx === target) return true;
        visited[nIdx] = 1;
        queue[tail++] = nIdx;
      }
    }
    return false;
  }

  /** Expanding ring search; returns center of nearest navigable cell within maxRadiusM. */
  snapToNavigable(p: LatLon, safetyDepthM: number, maxRadiusM = 300): LatLon | null {
    const start = {
      row: Math.floor((p.lat - this.meta.south) / this.latStep),
      col: Math.floor((p.lon - this.meta.west) / this.lonStep),
    };
    const cellLatM = 111_320 * this.latStep;
    const cellLonM = 111_320 * this.lonStep * Math.cos(toRad(p.lat));
    const minCellStepM = Math.min(cellLatM, cellLonM);
    const maxRing = Math.ceil(maxRadiusM / minCellStepM) + 1;
    let best: { p: LatLon; d: number } | null = null;
    for (let ring = 0; ring <= maxRing; ring++) {
      // Cells can be non-square (lat vs lon extent), so a farther ring can
      // still hold a nearer cell than a closer ring (lon-offset hits vs.
      // lat-offset hits). Only stop once no unscanned ring could possibly
      // beat the current best.
      if (best && ring * minCellStepM > best.d) break;
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const row = start.row + dr;
          const col = start.col + dc;
          if (!this.cellNavigable(row, col, safetyDepthM)) continue;
          const center = {
            lat: this.meta.south + (row + 0.5) * this.latStep,
            lon: this.meta.west + (col + 0.5) * this.lonStep,
          };
          const dM = haversineNm(p, center) / NM_PER_M;
          if (dM <= maxRadiusM && (!best || dM < best.d)) best = { p: center, d: dM };
        }
      }
    }
    return best ? best.p : null;
  }
}
