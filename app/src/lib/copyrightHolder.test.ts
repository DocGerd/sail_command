import { describe, expect, it } from 'vitest';

import { copyrightHolder } from '../../scripts/copyright-holder.mjs';

// Regression tests for CodeQL js/incomplete-multi-character-sanitization
// (#69). The author-field sanitizer strips "(url)" decorations with a regex
// and then removes every "<...>" span (and any stray bracket) with a
// character scanner (stripAngleBracketed) that runs LAST, so the result can
// never contain a '<' or '>' — no matter what the paren strip splices. All
// expectations below are derived BY HAND from that pipeline and pinned as
// literals — never computed by calling the function under test.
describe('copyrightHolder sanitization', () => {
  it('defeats the paren-splice bypass: removal must not surface "<script"', () => {
    // Hand-derivation for raw = '<(x)script':
    //   1. /\([^)]*\)/g deletes '(x)', splicing the surviving '<' onto
    //      'script' → '<script' (the exact #69 attack shape).
    //   2. stripAngleBracketed runs LAST: the '<' opens a span with no
    //      closing '>', so 'script' is swallowed → ''.
    //   3. trim → '' → fallback.
    expect(copyrightHolder({ name: 'evil-pkg', author: '<(x)script' })).toBe(
      'the evil-pkg authors',
    );
  });

  it('defeats the unclosed-tag bypass: a lone "<script" is truncated', () => {
    // Hand-derivation for raw = 'Mallory <script':
    //   1. no parens: unchanged.
    //   2. scanner keeps 'Mallory ', then '<' opens an unclosed span that
    //      swallows 'script' → 'Mallory '.
    //   3. trim → 'Mallory'.
    expect(copyrightHolder({ name: 'evil-pkg', author: 'Mallory <script' })).toBe('Mallory');
  });

  it('counts bracket depth so a nested "> " does not surface inner text early', () => {
    // Hand-derivation for raw = '<a<b>c>d':
    //   scanner: '<'(depth 1) drops 'a'; '<'(depth 2) drops 'b'; '>'(→1)
    //   still open, drops 'c'; '>'(→0); 'd' kept → 'd'. trim → 'd'.
    // A naive "first '<' to first '>'" stripper would yield 'cd'; pinning
    // 'd' distinguishes true depth counting.
    expect(copyrightHolder({ name: 'some-pkg', author: '<a<b>c>d' })).toBe('d');
  });

  it('drops fully nested bracket content entirely', () => {
    // '<<x>>' → scanner: '<'(1) '<'(2) 'x' dropped '>'(1) '>'(0) → '' →
    // fallback.
    expect(copyrightHolder({ name: 'some-pkg', author: '<<x>>' })).toBe('the some-pkg authors');
  });

  it('still strips ordinary "<email>" and "(url)" decorations', () => {
    // 'Jane Doe <jane@example.com> (https://example.com)':
    //   1. paren strip removes '(https://example.com)' →
    //      'Jane Doe <jane@example.com> '.
    //   2. scanner keeps 'Jane Doe ', drops '<jane@example.com>', keeps the
    //      trailing ' ' → 'Jane Doe  '.
    //   3. trim → 'Jane Doe'. (Byte-identical to the pre-#69 chain for
    //      well-formed authors, so the notices file must not drift.)
    expect(
      copyrightHolder({
        name: 'some-pkg',
        author: 'Jane Doe <jane@example.com> (https://example.com)',
      }),
    ).toBe('Jane Doe');
  });

  it('accepts the object author form', () => {
    expect(copyrightHolder({ name: 'some-pkg', author: { name: 'ACME Corp' } })).toBe('ACME Corp');
  });

  it('falls back when sanitization leaves nothing', () => {
    // '<>' → scanner: '<'(1) '>'(0) → '' → fallback.
    expect(copyrightHolder({ name: 'some-pkg', author: '<>' })).toBe('the some-pkg authors');
  });

  it('falls back when there is no author field', () => {
    expect(copyrightHolder({ name: 'some-pkg' })).toBe('the some-pkg authors');
  });

  it('prefers the verified holder overrides', () => {
    // pmtiles ships no license text and its author field does not match the
    // upstream copyright line — the override must win over any author value.
    expect(copyrightHolder({ name: 'pmtiles', author: 'Someone Else <x@y.z>' })).toBe(
      '2021 Protomaps LLC',
    );
  });
});
