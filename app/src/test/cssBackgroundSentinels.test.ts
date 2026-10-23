import { describe, expect, it } from 'vitest';
import { withBackgroundSentinels } from './cssBackgroundSentinels';

describe('#1773 withBackgroundSentinels', () => {
  it('rewrites a var() with a fallback to a unique literal colour per token', () => {
    const { css, sentinel } = withBackgroundSentinels(
      '.a { background: var(--x, #fff); } .b { background-color: var(--y); } .c { background: var(--x); }',
    );
    expect(sentinel('--x')).not.toBe(sentinel('--y'));
    expect(css).toBe(
      `.a { background: ${sentinel('--x')}; } .b { background-color: ${sentinel('--y')}; } .c { background: ${sentinel('--x')}; }`,
    );
  });

  it('replaces a nested fallback var() whole', () => {
    const { css, sentinel } = withBackgroundSentinels(
      '.a { background: var(--a, var(--b, red)); }',
    );
    expect(css).toBe(`.a { background: ${sentinel('--a')}; }`);
    expect(() => sentinel('--b')).toThrow(/--b/);
  });

  it('rewrites several var() in one value', () => {
    const { css, sentinel } = withBackgroundSentinels(
      '.a { background: linear-gradient(var(--a), var(--b)); }',
    );
    expect(css).toBe(`.a { background: linear-gradient(${sentinel('--a')}, ${sentinel('--b')}); }`);
  });

  it('throws for a token no background declaration references', () => {
    const { sentinel } = withBackgroundSentinels('.a { color: var(--z); background: none; }');
    expect(() => sentinel('--z')).toThrow(/--z/);
  });

  it('ignores a background mention inside a comment', () => {
    const { css, sentinel } = withBackgroundSentinels(
      '/* background: var( oops */ .a { background: var(--k); }',
    );
    expect(css).toBe(` .a { background: ${sentinel('--k')}; }`);
  });
});
