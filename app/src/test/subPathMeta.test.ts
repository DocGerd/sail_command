import { describe, expect, it } from 'vitest';
import { subPathMeta } from '../../vite.config';

// #318: subPathMeta() (from #96) injects UAT's noindex `robots` meta and the
// og:url/og:image sub-path rewrites via String.replace with a STRING
// pattern — which silently returns the input UNCHANGED when the pattern is
// absent (no throw, no warning). Measured on the sibling cspMeta() plugin
// during PR #316 review: a routine, valid-HTML reformat of a meta tag made
// `vite build` exit 0 with the injection silently skipped. The `robots`
// noindex meta is the expensive half here (a silent no-op would let the
// unreleased UAT deploy become indexable), so — mirroring cspMeta()'s
// existing #223 guard — the fix must fail closed: THROW rather than return
// the input unchanged. This test pins that directly (cspMeta()'s own guard
// was previously verified only empirically, per CLAUDE.md); the mutation
// check is: remove either requireMarker() guard and this test goes red with
// a false-negative "unchanged HTML round-tripped" pass instead.

// Exact production markers (app/index.html) — kept in sync with that file
// by the same "verify both directions" evidence #318 asked for; see also
// CLAUDE.md's twin-search note on redundant facts drifting apart.
const OG_URL = '<meta property="og:url" content="https://docgerd.github.io/sail_command/" />';
const OG_IMAGE =
  '<meta property="og:image" content="https://docgerd.github.io/sail_command/brand/social-card.png" />';
const TITLE = '<title>SailCommand</title>';
const THEME_COLOR = '<meta name="theme-color" content="#10243D" />';

function fixtureHtml(): string {
  return `<!doctype html>
<html>
  <head>
    ${THEME_COLOR}
    ${TITLE}
    ${OG_URL}
    ${OG_IMAGE}
  </head>
  <body></body>
</html>`;
}

function transform(plugin: ReturnType<typeof subPathMeta>, html: string): string {
  const hook = plugin.transformIndexHtml;
  if (typeof hook !== 'function') throw new Error('transformIndexHtml is not a plain function');
  // Cast away vite's `this: MinimalPluginContextWithoutEnvironment` typing —
  // subPathMeta()'s hook body never reads `this`, so a detached call is fine
  // at runtime; the cast just sidesteps a type-only mismatch in the test.
  const detached = hook as unknown as (html: string) => string;
  return detached(html);
}

describe('subPathMeta() (#318 fail-closed guard)', () => {
  it('rewrites og:url/og:image and, for UAT, retitles and adds robots noindex', () => {
    const plugin = subPathMeta('/sail_command/uat/', true);
    const out = transform(plugin, fixtureHtml());
    expect(out).toContain(
      '<meta property="og:url" content="https://docgerd.github.io/sail_command/uat/" />',
    );
    expect(out).toContain(
      '<meta property="og:image" content="https://docgerd.github.io/sail_command/uat/brand/social-card.png" />',
    );
    expect(out).toContain('<title>SailCommand UAT</title>');
    expect(out).toContain('<meta name="robots" content="noindex, nofollow" />');
  });

  it('leaves prod (non-UAT) HTML without a robots meta', () => {
    const plugin = subPathMeta('/sail_command/', false);
    const out = transform(plugin, fixtureHtml());
    expect(out).not.toContain('robots');
    expect(out).toContain('<title>SailCommand</title>');
  });

  it('throws when the og:url marker is absent, instead of silently returning the input unchanged', () => {
    const plugin = subPathMeta('/sail_command/', false);
    const drifted = fixtureHtml().replace(OG_URL, '<meta property="og:url" content="drifted" />');
    expect(() => transform(plugin, drifted)).toThrow(/og:url/);
  });

  it('throws when the og:image marker is absent', () => {
    const plugin = subPathMeta('/sail_command/', false);
    const drifted = fixtureHtml().replace(
      OG_IMAGE,
      '<meta property="og:image" content="drifted" />',
    );
    expect(() => transform(plugin, drifted)).toThrow(/og:image/);
  });

  it('UAT build throws when the title marker is absent (would silently ship without the UAT retitle)', () => {
    const plugin = subPathMeta('/sail_command/uat/', true);
    const drifted = fixtureHtml().replace(TITLE, '<title>Sail Command</title>');
    expect(() => transform(plugin, drifted)).toThrow(/title/);
  });

  it('UAT build throws when the theme-color marker is absent (would silently ship indexable)', () => {
    const plugin = subPathMeta('/sail_command/uat/', true);
    const drifted = fixtureHtml().replace(
      THEME_COLOR,
      '<meta name="theme-color" content="#000000" />',
    );
    expect(() => transform(plugin, drifted)).toThrow(/theme-color/);
  });

  it('non-UAT build tolerates a drifted title/theme-color marker (never checked outside the uat branch)', () => {
    const plugin = subPathMeta('/sail_command/', false);
    const drifted = fixtureHtml()
      .replace(TITLE, '<title>Sail Command</title>')
      .replace(THEME_COLOR, '<meta name="theme-color" content="#000000" />');
    expect(() => transform(plugin, drifted)).not.toThrow();
  });
});
