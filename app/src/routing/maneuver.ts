import type { Board, ManeuverKind } from '../types';

export function boardOf(twaSigned: number): Board {
  return twaSigned >= 0 ? 'starboard' : 'port';
}

/** Board of a candidate heading; at exactly ±180° TWA the board is ambiguous → inherit. */
export function boardForCandidate(twaSigned: number, parentBoard: Board | null): Board {
  if (Math.abs(twaSigned) === 180 && parentBoard) return parentBoard;
  return boardOf(twaSigned);
}

/** Only called when the board actually changed between two sail legs. */
export function classifyManeuver(prevTwaSigned: number, nextTwaSigned: number): ManeuverKind {
  return Math.abs(prevTwaSigned) + Math.abs(nextTwaSigned) <= 180 ? 'tack' : 'gybe';
}
