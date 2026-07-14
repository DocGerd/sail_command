import type { PolarTable, Rig } from '../types';
import { normalizeDeg180 } from './geo';

function interp1(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  const n = xs.length;
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 1;
  while (xs[i] < x) i++;
  const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + f * (ys[i] - ys[i - 1]);
}

export class Polar {
  readonly rig: Rig;
  private table: PolarTable;
  private performanceFactor: number;

  constructor(table: PolarTable, performanceFactor = 1.0) {
    this.rig = table.rig;
    this.table = table;
    this.performanceFactor = performanceFactor;
  }

  speedKn(twaDeg: number, twsKn: number): number {
    const { tws, twa, speeds } = this.table;
    const a = Math.abs(normalizeDeg180(twaDeg));
    if (twsKn <= 0) return 0;

    // TWS: clamp above max, scale linearly to 0 below min.
    let twsFactor = 1;
    let w = twsKn;
    if (w > tws[tws.length - 1]) w = tws[tws.length - 1];
    if (w < tws[0]) {
      twsFactor = w / tws[0];
      w = tws[0];
    }
    let j = 1;
    while (j < tws.length - 1 && tws[j] < w) j++;
    const fw = (w - tws[j - 1]) / (tws[j] - tws[j - 1]);

    const speedAtTwa = (rowLo: number, rowHi: number, fa: number): number => {
      const lo = speeds[rowLo][j - 1] + fw * (speeds[rowLo][j] - speeds[rowLo][j - 1]);
      const hi = speeds[rowHi][j - 1] + fw * (speeds[rowHi][j] - speeds[rowHi][j - 1]);
      return lo + fa * (hi - lo);
    };

    let v: number;
    if (a <= twa[0]) {
      // no-go taper: 0 at TWA 0 → full value at first table row
      v = speedAtTwa(0, 0, 0) * (a / twa[0]);
    } else if (a >= twa[twa.length - 1]) {
      v = speedAtTwa(twa.length - 1, twa.length - 1, 0);
    } else {
      let i = 1;
      while (twa[i] < a) i++;
      const fa = (a - twa[i - 1]) / (twa[i] - twa[i - 1]);
      v = speedAtTwa(i - 1, i, fa);
    }
    return v * twsFactor * this.performanceFactor;
  }

  beatAngleDeg(twsKn: number): number {
    return interp1(this.table.beat.tws, this.table.beat.angle, twsKn);
  }

  gybeAngleDeg(twsKn: number): number {
    return interp1(this.table.gybe.tws, this.table.gybe.angle, twsKn);
  }
}
