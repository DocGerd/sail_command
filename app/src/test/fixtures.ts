import type { PolarTable } from '../types';

/** Tiny synthetic polar: symmetric, monotone in TWS, humped over TWA. */
export const TEST_POLAR: PolarTable = {
  rig: 'genoa',
  boat: 'test',
  tws: [4, 8, 12, 16, 20],
  twa: [40, 60, 90, 120, 150, 180],
  speeds: [
    [2.0, 4.0, 5.5, 6.0, 6.2], // 40
    [2.6, 5.0, 6.5, 7.2, 7.4], // 60
    [3.0, 5.6, 7.2, 8.2, 8.6], // 90
    [2.8, 5.2, 7.0, 8.4, 8.8], // 120
    [2.0, 4.0, 5.8, 7.0, 7.8], // 150
    [1.6, 3.2, 4.8, 6.0, 6.8], // 180
  ],
  beat: { tws: [4, 8, 12, 16, 20], angle: [47, 44, 42, 40, 40] },
  gybe: { tws: [4, 8, 12, 16, 20], angle: [150, 155, 165, 170, 175] },
  source: 'synthetic test fixture',
};
