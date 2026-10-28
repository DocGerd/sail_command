import { describe, expect, it, vi } from 'vitest';
import { solve } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { makeMask, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type LatLon, type MaskMeta } from '../types';
import { destinationPoint, haversineNm } from '../lib/geo';
import { uniformGate } from '../lib/depthGate';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

// #1879: a two-cell zigzag slot is the only way out of the origin's pocket,
// and the destination is over 5 nm away, so the solver steps in 600 s rings.
// ~40 m square cells.
const LAT_CELL = 1 / 2800;
const LON_CELL = 1 / 1600;
const META: MaskMeta = {
  west: 9.9,
  south: 54.7,
  east: 9.9 + 200 * LON_CELL,
  north: 54.7 + 400 * LAT_CELL,
  cols: 200,
  rows: 400,
};
const centre = (row: number, col: number): LatLon => ({
  lat: META.south + (row + 0.5) * LAT_CELL,
  lon: META.west + (col + 0.5) * LON_CELL,
});

const SLOT_FIRST_ROW = 31;
const SEA_FIRST_ROW = 60;
const BLOCK_ROWS = 4;
/** Slot's western column for a row: alternates 100 / 103 every BLOCK_ROWS rows. */
const slotCol = (row: number) =>
  Math.floor((row - SLOT_FIRST_ROW) / BLOCK_ROWS) % 2 === 0 ? 100 : 103;

function isWater(row: number, col: number): boolean {
  if (row >= SEA_FIRST_ROW) return true;
  if (row >= 20 && row < SLOT_FIRST_ROW) return col >= 80 && col <= 120;
  if (row < SLOT_FIRST_ROW) return false;
  const c = slotCol(row);
  if (col === c || col === c + 1) return true;
  // The last two rows of each block also open the jog to the next block.
  const jogRow = (row - SLOT_FIRST_ROW) % BLOCK_ROWS >= BLOCK_ROWS - 2;
  const next = slotCol(row + 1);
  return jogRow && col >= Math.min(c, next) && col <= Math.max(c, next) + 1;
}

const mask = makeMask((r, c) => (isWater(r, c) ? 200 : 0), META);
const ORIGIN = centre(25, 100);
const DESTINATION = centre(380, 100);
const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);
const settings = DEFAULT_SETTINGS;
const gate = uniformGate(settings.safetyDepthM);

function longestSlotChordM(): number {
  let longest = 0;
  for (let row = SLOT_FIRST_ROW; row < SEA_FIRST_ROW; row++)
    for (let col = 98; col <= 104; col++) {
      if (!isWater(row, col)) continue;
      const from = centre(row, col);
      for (let h = 0; h < 360; h++) {
        for (let m = 5; m <= 600; m += 5) {
          const e = destinationPoint(from, h, m / 1852);
          if (e.lat < centre(SLOT_FIRST_ROW, 0).lat || e.lat > centre(SEA_FIRST_ROW - 1, 0).lat)
            break;
          if (!mask.segmentNavigable(from, e, gate)) break;
          if (m > longest) longest = m;
        }
      }
    }
  return longest;
}

describe('#1879: blocked-step retries reach a fixed time floor', () => {
  it('routes out through a zigzag slot under 600 s rings', () => {
    // Preconditions, from the fixture alone: over 5 nm to go, and no straight
    // chord in the slot as long as the slowest 600 s ring's dtS/8 substep
    // (motor, 75 s), but some at least as long as the 18.75 s floor's.
    expect(haversineNm(ORIGIN, DESTINATION)).toBeGreaterThan(5);
    const longest = longestSlotChordM();
    const metres = (kn: number, s: number) => ((kn * s) / 3600) * 1852;
    expect(longest).toBeLessThan(metres(settings.motorSpeedKn, 600 / 8));
    expect(longest).toBeGreaterThan(metres(7.2, 150 / 8));

    const r = solve({
      origin: ORIGIN,
      destination: DESTINATION,
      departureMs: T0,
      polar: new Polar(TEST_POLAR, 1.0),
      wind: new WindField(uniformWindGrid(12, 180)),
      mask,
      settings,
    });
    expect(r.status).toBe('ok');
  });
});
