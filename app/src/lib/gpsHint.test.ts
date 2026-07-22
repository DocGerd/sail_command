import { afterEach, describe, expect, it } from 'vitest';
import { claimGpsHintOnce } from './gpsHint';

afterEach(() => {
  localStorage.clear();
});

describe('claimGpsHintOnce', () => {
  it('returns true and persists the pre-existing storage key on a fresh profile', () => {
    expect(localStorage.getItem('sc-gps-hint-shown')).toBeNull();
    expect(claimGpsHintOnce()).toBe(true);
    // Pinned to the literal key LiveView.test.tsx already asserts against
    // (`sc-gps-hint-shown`) — this module is an extraction of that existing
    // behavior, not a new mechanism, so the key must stay byte-identical.
    expect(localStorage.getItem('sc-gps-hint-shown')).toBe('1');
  });

  it('returns false on every subsequent call, regardless of caller', () => {
    expect(claimGpsHintOnce()).toBe(true);
    expect(claimGpsHintOnce()).toBe(false);
    expect(claimGpsHintOnce()).toBe(false);
  });

  it('returns false when the key was already set by a different code path (e.g. a prior LiveView denial)', () => {
    localStorage.setItem('sc-gps-hint-shown', '1');
    expect(claimGpsHintOnce()).toBe(false);
  });
});
