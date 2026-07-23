import { destinationPoint } from './geo';
import type { LatLon } from '../types';

/**
 * The straight-line "where will it be in `minutes`" projection used by moving
 * markers/targets: a 2-point line from `pos` along course `cogDeg` (degrees
 * true) with length = the distance covered at `sogKn` over `minutes`. Pure
 * geometry — the caller decides whether to draw it (e.g. suppress the
 * zero-length line of a stationary vessel). Shared by the AIS COG vectors (#25)
 * and the ownship projection vector (#141) so both use identical math; never
 * inline this computation.
 */
export function projectionLine(
  pos: LatLon,
  cogDeg: number,
  sogKn: number,
  minutes: number,
): [LatLon, LatLon] {
  const distanceNm = (sogKn * minutes) / 60;
  return [{ lat: pos.lat, lon: pos.lon }, destinationPoint(pos, cogDeg, distanceNm)];
}
