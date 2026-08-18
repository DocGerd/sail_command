import { describe, it, expect } from 'vitest';
import { BOATS, boatById, DEFAULT_BOAT_ID } from './boats';

describe('boat catalogue', () => {
  it('release 1 ships exactly the Salona 45', () => {
    expect(BOATS.map((b) => b.id)).toEqual(['salona-45']);
  });

  it('states the Salona 45 draft as its own literal', () => {
    expect(boatById('salona-45').draftM).toBe(2.1);
  });

  it('carries per-boat motor and maneuver defaults matching today', () => {
    const b = boatById('salona-45');
    expect(b.motorSpeedKn).toBe(6.5);
    expect(b.maneuverPenaltyS).toBe(45);
  });

  it('requires a provenance tier on every sail', () => {
    for (const b of BOATS) {
      for (const s of b.sails) {
        expect(['certificate', 'modelled', 'estimated']).toContain(s.polarProvenance.tier);
        expect(s.polarProvenance.note.length).toBeGreaterThan(0);
      }
    }
  });

  it('ships no estimated-tier sail in release 1 (OQ-7)', () => {
    const tiers = BOATS.flatMap((b) => b.sails.map((s) => s.polarProvenance.tier));
    expect(tiers).not.toContain('estimated');
  });

  it('defaults to the Salona 45', () => {
    expect(DEFAULT_BOAT_ID).toBe('salona-45');
  });
});
