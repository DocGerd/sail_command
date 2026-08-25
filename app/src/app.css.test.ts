import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// #711: MapLibre's own AttributionControl chrome hardcodes
// `.maplibregl-ctrl-attrib.maplibregl-compact-show{background-color:#fff;
// color:#000}` and `.maplibregl-ctrl-attrib a{color:rgba(0,0,0,.75)}` with
// no dark variant (node_modules/maplibre-gl/dist/maplibre-gl.css) — the same
// defect class CLAUDE.md documents for .seamark-popup/.ais-popup. jsdom
// computes no CSS cascade, so no DOM/component test can see whether a
// `@media (prefers-color-scheme: dark)` rule exists or what it contains —
// this follows the repo's established pattern for exactly that gap
// (useBannerHeight.test.ts, panelWidth.test.ts, maskTolerance.test.ts,
// chipShallowFill.test.ts) and reads the real app.css source directly via
// `node:fs`.
//
// NOT `import.meta.glob(..., '?raw')` (the browser-safe form
// depthColor.test.ts uses for a .tsx source file): MEASURED here that
// Vitest's default `test.css: false` mocks out EVERY `.css`-suffixed module
// with an empty proxy regardless of query string, so a `?raw` import of
// app.css resolves to a zero-length string under this repo's vitest config
// — silently, no error, which is why `node:fs` (unaffected by that mocking)
// is what every other CSS-scanning test in this repo already uses.
const APP_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), './app.css');

function readAppCss(): string {
  return readFileSync(APP_CSS_PATH, 'utf8');
}

/**
 * Balanced-brace scan for every top-level `@media (prefers-color-scheme:
 * dark) { ... }` block in `css` — a plain regex can't match nested braces
 * (the block itself contains rule bodies with their own `{}`). Returns the
 * full `@media ... { ... }` text of each block found, and separately the
 * source with every such block removed (for asserting something is NOT
 * present outside them).
 */
function darkMediaBlocks(css: string): { blocks: string[]; withoutBlocks: string } {
  const marker = '@media (prefers-color-scheme: dark)';
  const blocks: string[] = [];
  let withoutBlocks = '';
  let i = 0;
  for (;;) {
    const mediaIdx = css.indexOf(marker, i);
    if (mediaIdx === -1) {
      withoutBlocks += css.slice(i);
      break;
    }
    withoutBlocks += css.slice(i, mediaIdx);
    const braceStart = css.indexOf('{', mediaIdx);
    let depth = 1;
    let j = braceStart + 1;
    while (depth > 0 && j < css.length) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    blocks.push(css.slice(mediaIdx, j));
    i = j;
  }
  return { blocks, withoutBlocks };
}

describe('#711: app.css themes the MapLibre attribution control in dark mode', () => {
  it('has exactly one dark-mode override for .maplibregl-ctrl-attrib, reusing --sc-bg/--sc-fg', () => {
    const { blocks } = darkMediaBlocks(readAppCss());
    const attribBlocks = blocks.filter((b) => b.includes('.maplibregl-ctrl-attrib'));
    // Before #711 this array is empty — `toHaveLength(1)` fails RED with
    // "expected [] to have a length of 1 but got 0" (no dark-mode block
    // mentions the attribution control at all yet).
    expect(attribBlocks, 'no dark-mode .maplibregl-ctrl-attrib block found').toHaveLength(1);
    const block = attribBlocks[0];
    expect(block).toMatch(
      /\.maplibregl-ctrl-attrib\.maplibregl-compact-show\s*\{[^}]*background-color:\s*var\(--sc-bg\)/,
    );
    expect(block).toMatch(
      /\.maplibregl-ctrl-attrib\.maplibregl-compact-show\s*\{[^}]*color:\s*var\(--sc-fg\)/,
    );
    expect(block).toMatch(/\.maplibregl-ctrl-attrib\s+a\s*\{[^}]*color:\s*var\(--sc-fg\)/);
  });

  it('never overrides .maplibregl-ctrl-attrib OUTSIDE a dark-mode media block (light mode stays untouched)', () => {
    // Structural twin of the PR's build-diff proof (dist CSS outside every
    // dark-media block is byte-identical before/after #711): confirms the
    // SOURCE never re-declares the selector unscoped either, so a future
    // edit can't accidentally widen it to apply in light mode too. Strips
    // `/* ... */` comments first — the explanatory comment ABOVE the dark
    // block (naming the exact selector it themes) legitimately mentions
    // `.maplibregl-ctrl-attrib` in prose outside the block itself.
    const { withoutBlocks } = darkMediaBlocks(readAppCss());
    const withoutComments = withoutBlocks.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toContain('.maplibregl-ctrl-attrib');
  });
});
