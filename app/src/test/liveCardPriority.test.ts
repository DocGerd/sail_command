import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// #1822: the narrow Live card outranks the sheet's panel. Pins the card's
// `12rem` floor, the budget (#1843: the sheet's own `55vh` minus the toast, so the
// card's top stays clear of the Tier 2 map chrome) and the panel cap that makes a
// long AIS list scroll inside the sheet.
// `readFileSync`, never a `?raw` glob: that returns "" for a stylesheet.
const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_CSS = readFileSync(resolve(HERE, '../app.css'), 'utf8');

// Strip comments so prose that quotes a declaration cannot satisfy a match.
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const FLAT_CSS = flat(CSS);

const REM_PX = 16;
const SHEET_FALLBACK = 'var(--live-sheet-h, calc(var(--sc-tabbar-h) + 6rem))';

function declarationBlock(selectorRe: RegExp): string {
  const m = selectorRe.exec(FLAT_CSS);
  if (!m) throw new Error(`rule not found: ${selectorRe}`);
  return m[1]!;
}

const liveViewBlock = () => declarationBlock(/(?:^|\} )\.live-view \{([^}]*)\}/);

const CAP_RE =
  /max-height: max\( (\d+(?:\.\d+)?)rem, calc\( \((\d+(?:\.\d+)?)vh - var\(--sc-toast-height, 0px\)\) - var\(--live-sheet-h, calc\(var\(--sc-tabbar-h\) \+ 6rem\)\) \) \);/;

function parseCap(): { floorPx: number; budgetVh: number } {
  const m = CAP_RE.exec(liveViewBlock());
  if (!m)
    throw new Error(
      '`.live-view` max-height no longer has the max(<floor>rem, calc(<N>vh - toast - sheet)) shape',
    );
  return { floorPx: Number(m[1]) * REM_PX, budgetVh: Number(m[2]) };
}

const cardCapPx = (vhPx: number, sheetPx: number, toastPx = 0) => {
  const { floorPx, budgetVh } = parseCap();
  return Math.max(floorPx, (budgetVh / 100) * vhPx - toastPx - sheetPx);
};

const PANEL_CAP_RE = new RegExp(
  '@media \\(max-width: 1023\\.98px\\) \\{ ' +
    '\\.app-shell:has\\(\\.map-area \\.live-view\\) \\.app-panel:has\\(\\.app-panel-ais\\) \\{ ' +
    'max-height: (\\d+(?:\\.\\d+)?)rem; \\} \\}',
);

describe('#1822: Live card priority over the bottom sheet', () => {
  it('the comment stripper leaves real declarations behind', () => {
    expect(CSS.includes('grid-template-areas:')).toBe(true);
    expect(CSS.length).toBeLessThan(RAW_CSS.length);
  });

  it('the card keeps a 12rem floor', () => {
    expect(parseCap().floorPx).toBe(12 * REM_PX);
    // A sheet at the 55vh cap of a 820x1180 viewport leaves the card its floor.
    expect(cardCapPx(1180, 0.55 * 1180)).toBe(12 * REM_PX);
  });

  it('the card budget is the sheet cap', () => {
    // The Tier 2 map chrome is bounded by the sheet's 55vh cap (app.css's #1843
    // comment); a larger card budget lets the card's top reach it. The sheet's own
    // toast-compensated cap is pinned by toastCompensationTwin.test.ts.
    expect(parseCap().budgetVh).toBe(55);
    expect(cardCapPx(1180, 213, 60)).toBe(0.55 * 1180 - 60 - 213);
  });

  it('bottom and max-height read the same sheet fallback', () => {
    const block = liveViewBlock();
    expect(block).toContain(`bottom: ${SHEET_FALLBACK};`);
    expect(CAP_RE.test(block)).toBe(true);
  });

  it('the panel cap is scoped to a docked card, narrow only', () => {
    const m = PANEL_CAP_RE.exec(FLAT_CSS);
    expect(m, 'panel cap rule missing or its gate changed').not.toBeNull();
    // 10rem is a judgement call (app.css's #1822 comment), pinned so any change is deliberate.
    expect(Number(m![1])).toBe(10);
  });

  it('a capped panel hands the card more than a sheet at its own 55vh cap', () => {
    const panelRem = Number(PANEL_CAP_RE.exec(FLAT_CSS)![1]);
    const tabbarPx = Number(/--sc-tabbar-h: (\d+(?:\.\d+)?)rem;/.exec(FLAT_CSS)![1]) * REM_PX;
    const cappedSheet = tabbarPx + panelRem * REM_PX;
    const viewport = 1180;
    expect(cardCapPx(viewport, cappedSheet)).toBeGreaterThan(
      cardCapPx(viewport, 0.55 * viewport) + 100,
    );
    // The stacked card and capped sheet stay within the budget plus its floor.
    expect(cardCapPx(viewport, cappedSheet) + cappedSheet).toBeLessThanOrEqual(
      (parseCap().budgetVh / 100) * viewport,
    );
  });
});
