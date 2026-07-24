import { describe, it, expect } from 'vitest';
import { projectionLine } from './projectionVector';
import { destinationPoint } from './geo';

describe('projectionLine', () => {
  it('returns a 2-point line from the position to the SOG*minutes projection along COG', () => {
    const pos = { lat: 54.79, lon: 9.43 };
    const line = projectionLine(pos, 90, 6, 6); // 6 kn for 6 min = 0.6 nm along COG 90
    expect(line[0]).toEqual({ lat: 54.79, lon: 9.43 });
    const end = destinationPoint(pos, 90, 0.6);
    expect(line[1].lat).toBeCloseTo(end.lat, 9);
    expect(line[1].lon).toBeCloseTo(end.lon, 9);
  });

  it('scales length with both speed and time (12 kn for 30 min = 6 nm)', () => {
    const pos = { lat: 54.5, lon: 10.0 };
    const line = projectionLine(pos, 0, 12, 30);
    const end = destinationPoint(pos, 0, 6);
    expect(line[1].lat).toBeCloseTo(end.lat, 9);
    expect(line[1].lon).toBeCloseTo(end.lon, 9);
  });

  it('collapses to ~zero length at zero speed (the caller suppresses the draw)', () => {
    const pos = { lat: 54.5, lon: 10.0 };
    const line = projectionLine(pos, 45, 0, 6);
    expect(line[1].lat).toBeCloseTo(54.5, 9);
    expect(line[1].lon).toBeCloseTo(10.0, 9);
  });
});
