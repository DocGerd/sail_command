import { describe, expect, it } from 'vitest';
import { boardForCandidate, boardOf, classifyManeuver } from './maneuver';

describe('maneuver', () => {
  it('derives board from signed TWA', () => {
    expect(boardOf(45)).toBe('starboard');
    expect(boardOf(-45)).toBe('port');
    expect(boardOf(0)).toBe('starboard'); // head-to-wind edge: arbitrary but stable
  });

  it('dead run inherits the parent board (no phantom gybe at exactly 180°)', () => {
    expect(boardForCandidate(180, 'port')).toBe('port');
    expect(boardForCandidate(-180, 'starboard')).toBe('starboard');
    expect(boardForCandidate(180, null)).toBe('starboard');
    expect(boardForCandidate(-45, 'starboard')).toBe('port');
  });

  it('classifies tack vs gybe by which way the boat turns through the wind', () => {
    expect(classifyManeuver(-45, 45)).toBe('tack'); // beat: through head-to-wind
    expect(classifyManeuver(-150, 150)).toBe('gybe'); // run: through dead-downwind
    expect(classifyManeuver(-60, 130)).toBe('gybe'); // mixed, shorter turn is through the stern
    expect(classifyManeuver(-60, 110)).toBe('tack'); // mixed, shorter turn is through the bow
    expect(classifyManeuver(-90, 90)).toBe('tack'); // exactly 180° combined — boundary inclusive
  });
});
