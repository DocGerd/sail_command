// #596: depthDisclosure.ts's own sibling test — this file previously had
// none (its two exports were only exercised indirectly through AboutDialog's
// and RouteSummary's own component tests). Added alongside #596's extension
// of `formatDepthM`'s signature (an optional `fractionDigits` param, default
// 1, unchanged from before), since that is the one function every #596 call
// site across RouteSummary.tsx/LiveView.tsx/BoatPicker.tsx/DepthProfile.tsx
// now goes through.
import { describe, it, expect } from 'vitest';
import { formatDepthM, depthMaskCaveatVars } from './depthDisclosure';
import { boatById } from '../data/boats';

describe('formatDepthM', () => {
  it('renders one decimal place with a POINT in English', () => {
    expect(formatDepthM(2.1, 'en')).toBe('2.1');
    expect(formatDepthM(3.0, 'en')).toBe('3.0');
  });

  // #596: the whole point of this function — a decimal COMMA in German,
  // never a bare `toFixed(1)`'s point. This is the discriminating assertion
  // for every #596 call site: a regression back to `toFixed(1)` anywhere
  // would still pass the English half of a de/en pair and only red here (or
  // in a component test asserting this exact string).
  it('renders one decimal place with a COMMA in German', () => {
    expect(formatDepthM(2.1, 'de')).toBe('2,1');
    expect(formatDepthM(3.0, 'de')).toBe('3,0');
  });

  it('pads a whole number to one decimal place in both languages', () => {
    expect(formatDepthM(3, 'en')).toBe('3.0');
    expect(formatDepthM(3, 'de')).toBe('3,0');
  });

  // #596: DepthProfile.tsx's Y-axis tick labels are always integers (the
  // grid step is 2 or 5) and must never grow a ".0"/"',0'" suffix that would
  // clutter the chart — the `fractionDigits` escape hatch this issue added.
  it('fractionDigits=0 renders a bare integer in both languages, with no separator at all', () => {
    expect(formatDepthM(4, 'en', 0)).toBe('4');
    expect(formatDepthM(4, 'de', 0)).toBe('4');
    expect(formatDepthM(0, 'de', 0)).toBe('0');
  });

  it('rounds to the requested precision rather than truncating', () => {
    expect(formatDepthM(2.05, 'en')).toBe('2.1');
    expect(formatDepthM(2.04, 'en')).toBe('2.0');
  });
});

describe('depthMaskCaveatVars', () => {
  // Regression check: extending formatDepthM's signature with a defaulted
  // third parameter must not change this existing, unrelated caller's
  // output — it still calls formatDepthM with exactly two arguments.
  it('still resolves the About-dialog vars at one decimal place, unaffected by the new fractionDigits param', () => {
    const boat = boatById('salona-45');
    const vars = depthMaskCaveatVars(boat, 'de');
    expect(vars.draft).toBe('2,1');
    expect(vars.boat).toBe(boat.name);
    // Every value is a plain one-decimal string — none of them accidentally
    // picked up an integer (fractionDigits=0) rendering.
    for (const key of ['tolerance', 'gate', 'draft', 'floor'] as const) {
      expect(vars[key]).toMatch(/^\d+,\d$/);
    }
  });
});
