import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';

// #711: MapLibre's own AttributionControl chrome hardcodes
// `.maplibregl-ctrl-attrib.maplibregl-compact{background-color:#fff;
// color:#000}` and `.maplibregl-ctrl-attrib a{color:rgba(0,0,0,.75)}` with
// no dark variant (read against maplibre-gl 6.5.0,
// node_modules/maplibre-gl/dist/maplibre-gl.css) — the same defect class
// CLAUDE.md documents for .seamark-popup/.ais-popup. The colour pair sits
// on `.maplibregl-compact` itself, NOT on `.maplibregl-compact-show`
// (which adds only padding/visibility) — `.compact-show` never appears
// without `.compact` already present (MapLibre's own
// `_toggleAttribution`/`_updateData`), so `.compact` alone is the
// selector that covers both the collapsed steady state (see MapView.tsx's
// #33 comment: the control starts COLLAPSED everywhere) and the
// one-shot-expanded state. jsdom computes no CSS cascade, so no
// DOM/component test can see whether a
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
    // The negative lookahead requires the SUPERSET selector
    // `.maplibregl-compact` (covers both the collapsed steady state and
    // the opened one) — it fails to match `.maplibregl-compact-show{...}`,
    // since `-show` follows `compact` before the brace, so a regression
    // back to the narrower opened-only selector reds this row.
    expect(block).toMatch(
      /\.maplibregl-ctrl-attrib\.maplibregl-compact(?!-show)\s*\{[^}]*background-color:\s*var\(--sc-bg\)/,
    );
    expect(block).toMatch(
      /\.maplibregl-ctrl-attrib\.maplibregl-compact(?!-show)\s*\{[^}]*color:\s*var\(--sc-fg\)/,
    );
    expect(block).toMatch(/\.maplibregl-ctrl-attrib\s+a\s*\{[^}]*color:\s*var\(--sc-fg\)/);
  });

  it('#718: also themes the attribution-TOGGLE BUTTON (translucent-white circle + black SVG glyph)', () => {
    const { blocks } = darkMediaBlocks(readAppCss());
    // Still exactly ONE dark block mentions `.maplibregl-ctrl-attrib` — the
    // #718 button rule lives INSIDE the SAME block as the #711 container
    // rule above, not a new sibling block. A new top-level dark block for
    // this selector would ALSO satisfy `.includes('.maplibregl-ctrl-attrib')`
    // (that substring is a prefix of `-button` too), so this assertion is a
    // real structural check, not a restatement of the first test above.
    const attribBlocks = blocks.filter((b) => b.includes('.maplibregl-ctrl-attrib'));
    expect(attribBlocks, 'still exactly one dark-mode .maplibregl-ctrl-attrib block').toHaveLength(
      1,
    );
    const block = attribBlocks[0];
    // Same superset-selector reasoning as the container rule above:
    // `.maplibregl-compact-show` never appears without `.maplibregl-compact`
    // already present, so anchoring the button rule on `-show` alone would
    // miss the everyday collapsed steady state. Negative lookahead rejects
    // that narrower selector — mutation-checked: narrowing the source rule
    // to `.maplibregl-compact-show .maplibregl-ctrl-attrib-button` reds this
    // row; dropping the rule entirely reds it too.
    expect(block).toMatch(
      /\.maplibregl-ctrl-attrib\.maplibregl-compact(?!-show)\s+\.maplibregl-ctrl-attrib-button\s*\{[^}]*filter:\s*invert\(1\)/,
    );
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

// PR #763 review Major 4: the `[role='alert']` qualifier on
// `.planner-guidance[role='alert']` / `.options-help[role='alert']`
// (#703) had NO test at all — the reviewer's mutation "delete both
// qualifiers" left the whole focused suite 235/235 GREEN. Same pattern as
// #506's `.chip-shallow` guard above and CLAUDE.md's own documented jsdom
// caveat: `getComputedStyle(el).backgroundColor` reads `rgba(0, 0, 0, 0)`
// for a plain hint AND for an alert-role element ALIKE (jsdom parses
// neither `color-mix()` nor `var()`), so only the `background` SHORTHAND
// discriminates between "no rule matched" and "the error-wash rule won".
describe("#703: role='alert' overrides require the [role='alert'] qualifier, not the bare class", () => {
  afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  function mountWithRealCss(className: string, role: string | null): HTMLParagraphElement {
    const style = document.createElement('style');
    style.textContent = readAppCss();
    document.head.appendChild(style);
    const el = document.createElement('p');
    el.className = className;
    if (role !== null) el.setAttribute('role', role);
    document.body.appendChild(el);
    return el;
  }

  it(".planner-guidance[role='alert'] resolves a DIFFERENT background than a plain .planner-guidance hint", () => {
    const hint = mountWithRealCss('planner-guidance', null);
    const alertEl = mountWithRealCss('planner-guidance', 'alert');

    const hintBackground = getComputedStyle(hint).background;
    const alertBackground = getComputedStyle(alertEl).background;

    expect(
      alertBackground,
      `#703 guard: .planner-guidance[role='alert']'s resolved "background" was ` +
        `"${alertBackground}", identical to the plain hint's "${hintBackground}" ` +
        `— deleting the [role='alert'] qualifier (or replacing it with a bare ` +
        `.planner-guidance rule) would give every plain FYI hint the error-wash ` +
        `treatment too, exactly the mutation this test exists to catch.`,
    ).not.toBe(hintBackground);
    expect(alertBackground).toContain('--sc-banner-error-bg');
  });

  it(".options-help[role='alert'] resolves a DIFFERENT background than a plain .options-help hint", () => {
    const hint = mountWithRealCss('options-help', null);
    const alertEl = mountWithRealCss('options-help', 'alert');

    const hintBackground = getComputedStyle(hint).background;
    const alertBackground = getComputedStyle(alertEl).background;

    expect(
      alertBackground,
      `#703 guard: .options-help[role='alert']'s resolved "background" was ` +
        `"${alertBackground}", identical to the plain hint's "${hintBackground}".`,
    ).not.toBe(hintBackground);
    expect(alertBackground).toContain('--sc-banner-error-bg');
  });
});
