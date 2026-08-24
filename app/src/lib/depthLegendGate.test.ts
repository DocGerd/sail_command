import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { LEGEND_COLLAPSED_HEIGHT_PX } from './depthLegendGate';

const APP_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../app.css');

/**
 * RECORDED GAP, measured in PR #659's review and deliberately not closed: this
 * file is blind to a `border` on `.depth-legend`. A border adds to the same
 * border box `LEGEND_COLLAPSED_HEIGHT_PX` is sized from, and `border: 1px solid
 * red` leaves this file 2/2 GREEN. The constant is really "collapsed box
 * height", of which padding is only one contributor. Left open on purpose —
 * both sibling pills carry no border, so the probability is low against a real
 * widening of this guard's surface. Written down so the next reader does not
 * have to rediscover it, and so no comment here reads as covering more than it
 * does.
 */

/**
 * Declaration blocks whose selector LIST contains `selector` as an EXACT
 * member, comments stripped first.
 *
 * Used for `.depth-legend > summary` only. Deliberately NOT an anchored
 * `^\.depth-legend > summary\s*\{` grep: CLAUDE.md records the `.sc-btn` case
 * where exactly that shape missed a rule because its selector line ended in a
 * comma (a GROUPED selector list) rather than a brace — the guard reported
 * clean while a real declaration sat one line above it. Splitting the selector
 * list and comparing members catches that grouped form.
 *
 * KNOWN GAP, and the reason the padding scan below does NOT use this helper:
 * exact-member matching sees only the spelling it is handed. A COMPOUND
 * selector targeting the same element — `details.depth-legend { ... }` — is a
 * different string and slips straight past, MEASURED in PR #659's review (2/2
 * GREEN while the collapsed box grew). `blocksTargeting` exists precisely
 * because that gap is unacceptable for the padding assertion; the same gap is
 * still open for this `min-height` one.
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
 * Blocks whose selector list contains a member TARGETING `.depth-legend`
 * itself — i.e. whose final compound carries that class — comments stripped
 * first.
 *
 * Deliberately NOT `members.includes('.depth-legend')`. That exact-member
 * form does catch the GROUPED `.a, .depth-legend { ... }` shape (the
 * `.sc-btn` lesson), but was MEASURED blind to the COMPOUND one: appending
 * `details.depth-legend { padding: 0.5rem }` to app.css leaves this file
 * 2/2 GREEN while the collapsed box grows to 60px. Splitting on combinators
 * and testing the LAST compound catches both.
 *
 * It over-fires on narrowing variants (`.depth-legend[open]`, `:hover`) by
 * design: this gate decides whether a control is offered at all, so per
 * CLAUDE.md's guard-asymmetry rule it fails CLOSED. Nothing declares padding
 * on those today; if one ever must, split this helper rather than loosen it.
 *
 * Comment stripping is required, not cosmetic: app.css's own prose around
 * these rules discusses `padding: 0.5rem` and `min-height: 44px`, and a scan
 * over the raw file would happily read a declaration out of a paragraph
 * explaining why that declaration is NOT there.
 */
function blocksTargeting(css: string, className: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const cls = new RegExp(`\\.${className}(?![\\w-])`);
  const out: string[] = [];
  // Matches innermost `<prelude> { <declarations> }` pairs; an `@media`
  // wrapper's own braces are skipped because its body contains `{`/`}`, which
  // the declaration character class excludes.
  const rule = /([^{}]*)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(withoutComments))) {
    const members = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (members.some((sel) => cls.test(sel.split(/[\s>+~]+/).pop() ?? ''))) out.push(m[2]);
  }
  return out;
}

/**
 * Every value contributing VERTICAL padding in one declaration block.
 *
 * Both halves are load-bearing, and each was MEASURED to slip past the
 * `split(/\s+/)[0]`-of-the-shorthand form:
 *   - the shorthand's BOTTOM component — 1 value = all sides, 2 = [block,
 *     inline], 3 = [top, inline, bottom], 4 = [top, right, bottom, left], so
 *     `padding: 0 0.5rem 4px` has a zero TOP and a 4px BOTTOM;
 *   - the LONGHANDS, physical and logical — `padding-top: 8px` and
 *     `padding-block: 6px` contain no `padding:` token, so a scan for the
 *     shorthand alone cannot see either.
 * `padding-inline*` is deliberately absent: inline padding is the axis this
 * element is ALLOWED to have (#638's chrome).
 */
function verticalPaddings(decls: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const shorthand = /(?:^|;)\s*padding:\s*([^;}]+)/g;
  while ((m = shorthand.exec(decls))) {
    const parts = m[1].trim().split(/\s+/);
    out.push(parts[0], parts.length >= 3 ? parts[2] : parts[0]);
  }
  const longhand = /(?:^|;)\s*padding-(?:top|bottom|block|block-start|block-end):\s*([^;}]+)/g;
  while ((m = longhand.exec(decls))) out.push(...m[1].trim().split(/\s+/));
  return out;
}

/**
 * The LAST match, because that is the one the cascade resolves to.
 *
 * `.depth-legend > summary` carries no media query and equal specificity, so
 * among several declarations of `min-height` source order decides — taking the
 * FIRST match would read a value the browser has already overridden. The regex
 * is not anchored to a `@media`-free context, so this also picks up any
 * wide-layout override rather than ignoring it.
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
    const blocks = blocksTargeting(css, 'depth-legend');
    // Fail CLOSED on absence: no `padding` shorthand at all means the #638
    // chrome was removed (or moved to a selector this scan no longer sees),
    // which is a regression in its own right — never a reason to pass quietly.
    expect(
      lastMatch(/(?:^|;)\s*padding:\s*([^;}]+)/, blocks.join(';\n')),
      "app.css's `.depth-legend { padding: ... }` chrome declaration not found — " +
        '#638 gave this element its own panel padding; if it moved, re-derive ' +
        'the collapsed-box height this gate is pinned to',
    ).not.toBeNull();
    const vertical = blocks.flatMap(verticalPaddings);
    for (const value of vertical) {
      expect(
        value,
        `\`.depth-legend\` must keep ZERO vertical padding: any vertical value adds to the ` +
          `collapsed box that DataLayers.tsx gates on ${LEGEND_COLLAPSED_HEIGHT_PX}px, without ` +
          `changing \`> summary\`'s own min-height — silent one-sided drift. ` +
          `Found "${value}" among ${JSON.stringify(vertical)}.`,
      ).toMatch(/^0(?:px|rem|em|%)?$/);
    }
  });
});
