import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// #1822: the narrow Live card outranks the sheet's panel. Pins the card's
// `12rem` floor, its budget (the sheet's own cap, which bounds the Tier 2 map
// chrome) and the panel cap that makes a long AIS list scroll inside the sheet.
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

// The #909 narrow block restates the cap with the toast term, as `.app-bottom-sheet` does there.
const NARROW_CAP_RE = new RegExp(
  '\\.app-bottom-sheet \\{ max-height: calc\\(55vh - var\\(--sc-toast-height, 0px\\)\\); \\} ' +
    '\\.live-view \\{ max-height: max\\( (\\d+(?:\\.\\d+)?)rem, calc\\( \\((\\d+(?:\\.\\d+)?)vh - ' +
    'var\\(--sc-toast-height, 0px\\)\\) - var\\(--live-sheet-h, calc\\(var\\(--sc-tabbar-h\\) \\+ 6rem\\)\\) \\) \\); \\}',
);

const CAP_RE =
  /max-height: max\((\d+(?:\.\d+)?)rem, calc\((\d+(?:\.\d+)?)vh - var\(--live-sheet-h, calc\(var\(--sc-tabbar-h\) \+ 6rem\)\)\)\);/;

function parseCap(): { floorPx: number; budgetVh: number } {
  const m = CAP_RE.exec(liveViewBlock());
  if (!m)
    throw new Error(
      '`.live-view` max-height no longer has the max(<floor>rem, calc(<N>vh - sheet)) shape',
    );
  return { floorPx: Number(m[1]) * REM_PX, budgetVh: Number(m[2]) };
}

function parseNarrowCap(): { floorPx: number; budgetVh: number } {
  const m = NARROW_CAP_RE.exec(FLAT_CSS);
  if (!m) throw new Error('the #909 `.live-view` cap no longer follows `.app-bottom-sheet`');
  return { floorPx: Number(m[1]) * REM_PX, budgetVh: Number(m[2]) };
}

// No toast up: the narrow cap's toast term is 0.
const cardCapPx = (vhPx: number, sheetPx: number) => {
  const { floorPx, budgetVh } = parseNarrowCap();
  return Math.max(floorPx, (budgetVh / 100) * vhPx - sheetPx);
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
    expect(parseNarrowCap().floorPx).toBe(12 * REM_PX);
    // A sheet at the 55vh cap of a 820x1180 viewport leaves the card its floor.
    expect(cardCapPx(1180, 0.55 * 1180)).toBe(12 * REM_PX);
  });

  it("the card budget is the sheet's own cap, so it stops where the map chrome's bound starts", () => {
    expect(parseCap().budgetVh).toBe(55);
    expect(parseNarrowCap().budgetVh).toBe(55);
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
      (parseNarrowCap().budgetVh / 100) * viewport,
    );
  });
});
