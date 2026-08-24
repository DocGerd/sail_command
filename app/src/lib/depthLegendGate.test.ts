import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { LEGEND_COLLAPSED_HEIGHT_PX } from './depthLegendGate';

const APP_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../app.css');

/**
 * Declaration blocks whose selector LIST contains `selector` as an exact
 * member, comments stripped first.
 *
 * Deliberately NOT an anchored `^\.depth-legend\s*\{` grep. CLAUDE.md records
 * the `.sc-btn` case where exactly that shape missed a rule because its
 * selector line ended in a comma (a GROUPED selector list) rather than a brace
 * — the guard reported clean while a real declaration sat one line above it.
 * Splitting the selector list and comparing members catches the grouped form
 * too, so a future `.depth-legend, .something-else { padding: 0.5rem }` cannot
 * slip past this test.
 *
 * Comment stripping is required, not cosmetic: `app.css`'s own prose around
 * these rules discusses `padding: 0.5rem` and `min-height: 44px` in several
 * places, and a scan over the raw file would happily read a declaration out of
 * a paragraph explaining why that declaration is NOT there.
 */
function declarationsFor(css: string, selector: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  // Matches innermost `<prelude> { <declarations> }` pairs; an `@media`
  // wrapper's own braces are skipped because its body contains `{`/`}`, which
  // the declaration character class excludes.
  const rule = /([^{}]*)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(withoutComments))) {
    const members = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (members.includes(selector)) out.push(m[2]);
  }
  return out;
}

/**
 * The LAST match, because that is the one the cascade resolves to.
 *
 * These selectors carry no media query and equal specificity, so among several
 * declarations of one property source order decides — taking the FIRST match
 * would read a value the browser has already overridden, and a later grouped
 * rule re-declaring `padding` with a vertical component would then pass this
 * guard silently. Neither regex is anchored to a `@media`-free context, so
 * this also picks up any wide-layout override rather than ignoring it.
 */
function lastMatch(re: RegExp, haystack: string): RegExpExecArray | null {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let found: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = global.exec(haystack))) found = m;
  return found;
}

describe('#641: app.css / lib/depthLegendGate.ts cross-language invariant', () => {
  it("`.depth-legend > summary`'s min-height literal matches LEGEND_COLLAPSED_HEIGHT_PX", () => {
    const css = readFileSync(APP_CSS_PATH, 'utf8');
    const blocks = declarationsFor(css, '.depth-legend > summary');
    const match = lastMatch(/min-height:\s*([\d.]+)px/, blocks.join('\n'));
    expect(
      match,
      "app.css's `.depth-legend > summary { min-height: <n>px }` rule not found or reshaped — " +
        "DataLayers.tsx's reachability gate is sized from it, so update " +
        'LEGEND_COLLAPSED_HEIGHT_PX and this regex alongside the CSS change',
    ).not.toBeNull();
    expect(Number(match![1])).toBe(LEGEND_COLLAPSED_HEIGHT_PX);
  });

  it('`.depth-legend` carries chrome padding with a ZERO vertical component', () => {
    const css = readFileSync(APP_CSS_PATH, 'utf8');
    const blocks = declarationsFor(css, '.depth-legend');
    const match = lastMatch(/(?:^|;)\s*padding:\s*([^;}]+)/, blocks.join(';\n'));
    // Fail CLOSED on absence: no `padding` at all means the #638 chrome was
    // removed (or moved to a selector this regex no longer sees), which is a
    // regression in its own right — never a reason to pass quietly.
    expect(
      match,
      "app.css's `.depth-legend { padding: ... }` chrome declaration not found — " +
        '#638 gave this element its own panel padding; if it moved, re-derive ' +
        'the collapsed-box height this gate is pinned to',
    ).not.toBeNull();
    const vertical = match![1].trim().split(/\s+/)[0];
    expect(
      vertical,
      `\`.depth-legend\` must keep ZERO vertical padding: any vertical value adds to the ` +
        `collapsed box that DataLayers.tsx gates on ${LEGEND_COLLAPSED_HEIGHT_PX}px, without ` +
        `changing \`> summary\`'s own min-height — silent one-sided drift. ` +
        `Found shorthand "${match![1].trim()}".`,
    ).toMatch(/^0(?:px|rem|em|%)?$/);
  });
});
