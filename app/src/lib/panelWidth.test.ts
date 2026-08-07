import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { PANEL_MIN_WIDTH_PX, PANEL_MAP_RESERVE_PX, panelMaxWidthPx } from './panelWidth';

const APP_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../app.css');

describe('panelMaxWidthPx', () => {
  it('at the 1024px breakpoint floor, applies the viewport-minus-reserve branch', () => {
    // min(0.7*1024, 1024-480) = min(716.8, 544) = 544
    expect(panelMaxWidthPx(1024)).toBe(544);
  });

  it('on a very wide monitor, applies the 70vw branch instead', () => {
    // min(0.7*3840, 3840-480) = min(2688, 3360) = 2688
    expect(panelMaxWidthPx(3840)).toBe(2688);
  });

  it('never returns less than PANEL_MIN_WIDTH_PX even for a pathologically narrow "wide" viewport', () => {
    // A viewport just barely over some hypothetical lower breakpoint: both
    // branches could undershoot 320px (e.g. 500: min(350, 20) = 20) — the
    // floor must win.
    expect(panelMaxWidthPx(500)).toBe(PANEL_MIN_WIDTH_PX);
  });

  it('at exactly reserve+min, the two branches tie at the floor', () => {
    const viewport = PANEL_MAP_RESERVE_PX + PANEL_MIN_WIDTH_PX; // 800
    expect(panelMaxWidthPx(viewport)).toBe(PANEL_MIN_WIDTH_PX);
  });
});

describe('#355: app.css / lib/panelWidth.ts cross-language invariant', () => {
  it('the 320px floor literal in app.css matches PANEL_MIN_WIDTH_PX', () => {
    const css = readFileSync(APP_CSS_PATH, 'utf8');
    const match = css.match(
      /grid-template-columns:\s*minmax\((\d+)px,\s*var\(--sc-panel-w,\s*1fr\)\)/,
    );
    expect(
      match,
      'app.css wide-layout grid-template-columns rule not found or reshaped — update the regex above alongside the CSS change',
    ).not.toBeNull();
    expect(Number(match![1])).toBe(PANEL_MIN_WIDTH_PX);
  });
});
