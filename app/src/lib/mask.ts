import type { LatLon, MaskMeta } from '../types';
import { haversineNm, toRad } from './geo';

const LAND = 0;
const NM_PER_M = 1 / 1852;

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

  /** Amanatides–Woo grid traversal from a to b; every touched cell must be navigable. */
  segmentNavigable(a: LatLon, b: LatLon, safetyDepthM: number): boolean {
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
    let tMaxX =
      stepX === 0 ? Infinity : (stepX > 0 ? cx + 1 - x0 : x0 - cx) * tDeltaX;
    let tMaxY =
      stepY === 0 ? Infinity : (stepY > 0 ? cy + 1 - y0 : y0 - cy) * tDeltaY;

    if (!this.cellNavigable(cy, cx, safetyDepthM)) return false;
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
      if (!this.cellNavigable(cy, cx, safetyDepthM)) return false;
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
      // Cells are ~557 m (lat) x ~321 m (lon) at 55°N, so a farther ring can
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
