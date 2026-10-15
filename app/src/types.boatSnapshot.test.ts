import { describe, it, expect } from 'vitest';
import { BOATS } from './data/boats';
import { boatSnapshot, type BoatSnapshot } from './types';

// Verbatim copy of boatSnapshot as it stood at the BASE of #1661.
function baseSnapshot(boat: BoatSnapshot): BoatSnapshot {
  return {
    id: boat.id,
    name: boat.name,
    draftM: boat.draftM,
    sails: boat.sails.map((s) => ({
      id: s.id,
      label: s.label,
      polarProvenance: { tier: s.polarProvenance.tier, note: s.polarProvenance.note },
    })),
  };
}

const multiSail = BOATS.find((b) => b.sails.length > 1);

describe('boatSnapshot aboard filter (#1661)', () => {
  it('has a multi-sail catalogue boat to exercise', () => {
    expect(multiSail).toBeDefined();
  });

  it.each(BOATS.map((b) => [b.id, b] as const))(
    'no argument is JSON-identical to the BASE output: %s',
    (_id, boat) => {
      expect(JSON.stringify(boatSnapshot(boat))).toBe(JSON.stringify(baseSnapshot(boat)));
    },
  );

  it('keeps only aboard sails, in catalogue order regardless of aboard order', () => {
    const boat = multiSail!;
    const ids = boat.sails.map((s) => s.id);
    const reversed = [...ids].reverse();
    const snap = boatSnapshot(boat, reversed.slice(0, 1));
    expect(snap.sails.map((s) => s.id)).toEqual([reversed[0]]);
    expect(boatSnapshot(boat, reversed).sails.map((s) => s.id)).toEqual(ids);
  });

  it('is idempotent', () => {
    const boat = multiSail!;
    const aboard = [boat.sails[0]!.id];
    const once = boatSnapshot(boat, aboard);
    expect(boatSnapshot(once, aboard)).toEqual(once);
  });

  it('does not alias sails, provenance or the aboard list', () => {
    const boat = multiSail!;
    const aboard = boat.sails.map((s) => s.id);
    const snap = boatSnapshot(boat, aboard);
    expect(snap.sails).not.toBe(boat.sails);
    snap.sails.forEach((s, i) => {
      expect(s).not.toBe(boat.sails[i]);
      expect(s.polarProvenance).not.toBe(boat.sails[i]!.polarProvenance);
    });
    expect(aboard).toHaveLength(boat.sails.length);
  });

  it('an empty aboard list yields no sails', () => {
    const boat = multiSail!;
    expect(boatSnapshot(boat, []).sails).toEqual([]);
  });
});
