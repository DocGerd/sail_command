// #936: standard Beaufort-scale upper bounds in knots (WMO/Met Office knots
// table). This is a real, universal maritime convention, not an invented
// category scale — the number it summarizes always comes from a real
// windGrid sample.
// index i = force i's inclusive upper bound; a speed above the last entry is
// force 12 (hurricane).
const BEAUFORT_UPPER_BOUNDS_KN = [1, 3, 6, 10, 16, 21, 27, 33, 40, 47, 55, 63] as const;

export function beaufortForce(speedKn: number): number {
  for (let force = 0; force < BEAUFORT_UPPER_BOUNDS_KN.length; force++) {
    const bound = BEAUFORT_UPPER_BOUNDS_KN[force];
    // Force 0's band is 0 kn up to but NOT including 1 kn — the force-1 band
    // (1-3 kn) is closed on the left, so 1.0 kn exactly is force 1, not 0.
    // Every other boundary in this table is closed on both ends.
    if (force === 0 ? speedKn < bound : speedKn <= bound) return force;
  }
  return BEAUFORT_UPPER_BOUNDS_KN.length;
}
