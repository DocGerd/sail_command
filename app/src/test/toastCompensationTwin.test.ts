import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { MAP_CHROME_TOP_PX } from '../components/DataLayers';

// #909: the compensated sheet cap `55vh - var(--sc-toast-height, 0px)` is
// encoded in FOUR places and no compiler spans them:
//
//   1. `app.css`  `.app-bottom-sheet`                 (narrow) — grants it
//   2. `app.css`  `.map-stack-tl, .route-layer-controls` (narrow) — spends it
//   3. `app.css`  `.depth-legend-body`                — spends it, one level in
//   4. `DataLayers.tsx`'s `budgetPx`                  — decides `hidden` from it
//
// Drop the term from ONE and the other three are silently wrong in a way
// nothing else observes: the sheet is trimmed and the map chrome never gets
// the room back, or the legend gate computes a budget the CSS does not
// actually grant it. Same shape as this repo's `156543.03` twin failure.
//
// `readFileSync`, NOT an `import.meta.glob(..., { query: '?raw' })`: vitest's
// `CSSEnablerPlugin` matches a CSS-suffixed path with or without a query
// string and returns `export default ""`, so a `?raw` glob of a stylesheet
// resolves to the EMPTY STRING and every assertion below would pass having
// read zero bytes. Every stylesheet-reading guard in this repo uses
// `readFileSync` for that reason.
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_CSS_PATH = resolve(HERE, '../app.css');
const DATA_LAYERS_PATH = resolve(HERE, '../components/DataLayers.tsx');

const RAW_CSS = readFileSync(APP_CSS_PATH, 'utf8');
const DATA_LAYERS_SRC = readFileSync(DATA_LAYERS_PATH, 'utf8');

// This file's own prose quotes every expression it pins, and `app.css`'s
// comments quote them too — so a count over the RAW stylesheet would count
// documentation, and a mutation that landed in a comment would read as
// covered. Strip block comments first; the assertions below then only ever
// see declarations. (CLAUDE.md's "the mutation lands in a COMMENT" class.)
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

// Non-vacuity control for the stripper itself: a needle known to be present
// in a DECLARATION, not in prose. Without this, a stripper that ate the whole
// file would leave every `not.toBeNull()` below failing loudly — but a
// stripper that ate only the declarations while leaving prose would let the
// counts pass for the wrong reason.
const STRIPPER_CONTROL = 'grid-template-areas:';

// Whitespace inside a `calc()` is not semantic and prettier reflows these
// declarations across lines as they grow — match on a normalised copy so a
// reformat can never silently disable a guard.
const flat = (s: string) => s.replace(/\s+/g, ' ');
const FLAT_CSS = flat(CSS);

const COMPENSATED_CAP = '(55vh - var(--sc-toast-height, 0px))';

describe('#909: the compensated sheet cap is one value in four places', () => {
  it('the comment stripper leaves real declarations behind', () => {
    expect(CSS.length).toBeGreaterThan(0);
    expect(
      CSS.includes(STRIPPER_CONTROL),
      `the comment stripper removed declarations, not just comments — every count below would be vacuous`,
    ).toBe(true);
    // And it really did remove something: app.css is comment-dense.
    expect(CSS.length).toBeLessThan(RAW_CSS.length);
  });

  it('site 1: .app-bottom-sheet GRANTS the toast its height back at narrow', () => {
    const m = FLAT_CSS.match(
      /\.app-bottom-sheet \{ max-height: calc\(55vh - var\(--sc-toast-height, 0px\)\); \}/,
    );
    expect(
      m,
      'the narrow `.app-bottom-sheet` cap no longer reads `calc(55vh - var(--sc-toast-height, 0px))` — ' +
        'either the #909 compensation was dropped (the map chrome then loses the toast height outright, ' +
        'reopening #871) or this guard needs re-aiming at its new spelling',
    ).not.toBeNull();
  });

  it('site 2: the map-chrome clusters SPEND exactly that same cap', () => {
    const m = FLAT_CSS.match(
      /\.route-layer-controls, \.map-stack-tl \{[^}]*max-height: calc\( 100% - \(55vh - var\(--sc-toast-height, 0px\)\) - var\(--sc-map-chrome-top\) - 0\.5rem \);/,
    );
    expect(
      m,
      'the narrow `.map-stack-tl`/`.route-layer-controls` bound no longer subtracts the SAME ' +
        'compensated cap the sheet rule grants — the two must move together or the sheet is trimmed ' +
        'and the clusters never receive the room',
    ).not.toBeNull();
  });

  it('site 3: .depth-legend-body restates it in the map-row frame', () => {
    const m = FLAT_CSS.match(
      /\.depth-legend-body \{[^}]*var\(--sc-map-row-h, 100dvh\) - var\(--sc-map-chrome-top, 0\.5rem\) - \(55vh - var\(--sc-toast-height, 0px\)\) - 0\.5rem/,
    );
    expect(
      m,
      "`.depth-legend-body`'s max-height no longer mirrors the cluster bound in the map-row frame. " +
        'It is that element\'s ONLY clip (`.depth-legend` "deliberately sets no overflow"), and a ' +
        'percentage cannot resolve there, so `--sc-map-row-h` is the only frame available to it',
    ).not.toBeNull();
  });

  it('no FOURTH stylesheet declaration encodes the cap, and none of the three was lost', () => {
    const occurrences = FLAT_CSS.split(COMPENSATED_CAP).length - 1;
    expect(
      occurrences,
      `expected exactly 3 declaration sites for \`${COMPENSATED_CAP}\` (the sheet, the map-chrome ` +
        'clusters, the depth-legend body). The short-landscape overrides deliberately carry ' +
        '`--sc-banner-height` INSTEAD — that property already includes the toast since #909, so ' +
        'subtracting both would count it twice',
    ).toBe(3);
  });

  it('site 4: DataLayers adds the toast height back into budgetPx', () => {
    const m = DATA_LAYERS_SRC.match(
      /const budgetPx =\s*mapRowPx\s*-\s*MAP_CHROME_TOP_PX\s*-\s*\(window\.innerHeight \* 0\.55 - toastHeightPx\)/,
    );
    expect(
      m,
      "`DataLayers.tsx`'s `budgetPx` no longer adds `toastHeightPx` back into the sheet-cap term. " +
        'The CSS grants the map chrome that height (site 1); a budget that does not claim it hides ' +
        'the depth legend at viewports where the stylesheet leaves room for it',
    ).not.toBeNull();
  });
});

describe('#909: --sc-map-chrome-top has a TypeScript twin', () => {
  it('the app.css declaration and MAP_CHROME_TOP_PX agree', () => {
    const m = FLAT_CSS.match(/--sc-map-chrome-top: ([0-9.]+)rem;/);
    expect(
      m,
      'app.css no longer declares `--sc-map-chrome-top` as a rem length — this guard cannot check ' +
        'the twin and fails closed rather than passing on an unread value',
    ).not.toBeNull();
    // 16px/rem is this app's root font-size: app.css sets no `html`/`:root`
    // font-size, so the browser default applies. That is the same conversion
    // every other rem literal in this file's guards assumes.
    expect(Number(m![1]) * 16).toBe(MAP_CHROME_TOP_PX);
  });

  it('the cluster top and the max-height term use the SAME token', () => {
    // The one-token lever only works if both halves read the property. A
    // `top: 0.5rem` written as a literal beside a `var()` in the max-height
    // would silently decouple on the next change.
    const m = FLAT_CSS.match(
      /\.route-layer-controls, \.map-stack-tl \{[^}]*top: var\(--sc-map-chrome-top\);/,
    );
    expect(
      m,
      "the narrow cluster's `top` no longer reads `var(--sc-map-chrome-top)`, so changing that one " +
        'token would move the inset without moving the budget that accounts for it',
    ).not.toBeNull();
  });
});
