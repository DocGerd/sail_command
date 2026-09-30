// #596: depthDisclosure.ts's own sibling test — this file previously had
// none (its two exports were only exercised indirectly through AboutDialog's
// and RouteSummary's own component tests). Added alongside #596's extension
// of `formatDepthM`'s signature (an optional `fractionDigits` param, default
// 1, unchanged from before), since that is the one function every #596 call
// site across RouteSummary.tsx/LiveView.tsx/BoatPicker.tsx/DepthProfile.tsx
// now goes through.
import { describe, it, expect } from 'vitest';
import { formatDepthM, formatDraftM, depthMaskCaveatVars } from './depthDisclosure';
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

// #1575: a DRAFT shows up to two decimals and never rounds DOWN (a draft must
// not read shallower than it is); formatDepthM's one decimal would show the
// 2.59 m keel as 2.6 m.
describe('formatDraftM', () => {
  it.each([
    [2.1, '2.1', '2,1'],
    [1.9, '1.9', '1,9'],
    [3, '3.0', '3,0'],
    // 2.2 * 100 is 220.00000000000003: without the nudge it would ceil to 2.21.
    [2.2, '2.2', '2,2'],
    [2.55, '2.55', '2,55'],
    [2.59, '2.59', '2,59'],
  ])('renders %s as the exact value at up to two decimals', (draft, en, de) => {
    expect(formatDraftM(draft, 'en')).toBe(en);
    expect(formatDraftM(draft, 'de')).toBe(de);
  });

  // Rounds UP to 0.01; the third-decimal inputs are chosen so that
  // round-to-nearest would give the other answer in each pair.
  it.each([
    [2.501, '2.51'],
    [2.504, '2.51'],
    [2.589, '2.59'],
    [2.591, '2.6'],
  ])('rounds %s UP to two decimals, never down', (draft, en) => {
    expect(formatDraftM(draft, 'en')).toBe(en);
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

  it('renders EASY GO!’s 2.59 m draft to two decimals beside one-decimal depths', () => {
    const vars = depthMaskCaveatVars(boatById('salona-44-easy-go'), 'de');
    expect(vars.draft).toBe('2,59');
    expect(vars.gate).toBe('3,5');
    expect(vars.floor).toBe('1,7');
  });
});
