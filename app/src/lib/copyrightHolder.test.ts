import { describe, expect, it } from 'vitest';

import { copyrightHolder } from '../../scripts/copyright-holder.mjs';

// Regression tests for CodeQL js/incomplete-multi-character-sanitization
// (#69): the author-field sanitizer used to be two single-pass global
// replaces (strip "<email>", strip "(url)") with no residual-character
// cleanup, so crafted author strings could reach the generated notices file
// with `<script`-shaped content intact. All expectations below are derived
// BY HAND from the replace semantics and pinned as literals — never computed
// by calling the function under test.
describe('copyrightHolder sanitization', () => {
  it('defeats the paren-splice bypass: removal must not CREATE "<script"', () => {
    // Hand-derivation for raw = '<(x)script':
    //   1. /<[^>]*>/g  — the string contains no '>' at all, so the tag
    //      pattern never matches: unchanged.
    //   2. /\([^)]*\)/g — deletes '(x)', splicing the surviving '<' onto
    //      'script'. The OLD sanitizer stopped here and returned the
    //      sanitizer-manufactured string '<script'.
    //   3. residual [<>] strip — drops the '<': 'script'.
    expect(copyrightHolder({ name: 'evil-pkg', author: '<(x)script' })).toBe('script');
  });

  it('defeats the unclosed-tag bypass: a lone "<script" must not survive', () => {
    // Hand-derivation for raw = 'Mallory <script':
    //   1. /<[^>]*>/g  — no closing '>', so nothing matches: unchanged.
    //   2. /\([^)]*\)/g — no parens: unchanged. The OLD sanitizer returned
    //      'Mallory <script' verbatim.
    //   3. residual [<>] strip — drops the '<': 'Mallory script'.
    expect(copyrightHolder({ name: 'evil-pkg', author: 'Mallory <script' })).toBe('Mallory script');
  });

  it('still strips ordinary "<email>" and "(url)" decorations', () => {
    // 'Jane Doe <jane@example.com> (https://example.com)' →
    // tag replace drops '<jane@example.com>', paren replace drops
    // '(https://example.com)', trim collapses the trailing spaces.
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
    // '<>' is fully consumed by the tag replace → empty → fallback.
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
