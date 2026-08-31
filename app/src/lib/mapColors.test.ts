import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  BOAT_COLOR,
  DEPTH_WARNING_COLOR,
  HALO_COLOR,
  INK_COLOR,
  MOTOR_COLOR,
  POSITION_HALO_COLOR,
  PORT_COLOR,
  STARBOARD_COLOR,
  VIA_COLOR,
} from './mapColors';

// #715: app.css cannot IMPORT lib/mapColors.ts (no compiler spans CSS
// and TypeScript), so its own sites read these values through --sc-*
// custom properties instead — --sc-starboard, --sc-port, --sc-via,
// --sc-motor, --sc-ink, --sc-halo, the same shape as the pre-existing
// --sc-depth-warning-fg (#251). THIS file is the twin that keeps each
// token's value honest against the shared constants (the
// maskTolerance.test.ts / useBannerHeight.test.ts readFileSync pattern).
// Every extraction fails CLOSED — an explicit not.toBeNull() BEFORE any
// value comparison — so a selector that is renamed, reformatted, or
// removed reds loudly here instead of silently comparing nothing (the
// same shape as the CSP String.replace incident, #223, this repo has
// already been bitten by once).
//
// An earlier revision of this comment said app.css keeps RAW hex literals
// because MapLibre/Canvas "structurally cannot consume var()" — wrong:
// that barrier applies only to the true MapLibre-paint / Canvas-2D-
// strokeStyle sites, which are all TypeScript and import mapColors.ts
// directly, never to app.css's own DOM CSS (corrected after PR #798
// review).

const APP_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../app.css');

function readAppCss(): string {
  return readFileSync(APP_CSS_PATH, 'utf8');
}

/**
 * Extracts a single hex colour from app.css via an anchored regex and fails
 * CLOSED if it is not found exactly once (mirrors readToleranceM() in
 * maskTolerance.test.ts). Comparison is case-insensitive throughout this
 * file — hex letter case has no rendering effect, and app.css spells these
 * values lowercase while mapColors.ts spells them uppercase; that is not a
 * divergence worth pinning.
 */
function extractHex(css: string, pattern: RegExp, label: string): string {
  const match = css.match(pattern);
  expect(
    match,
    `app.css's ${label} rule not found (renamed, reformatted, or moved) — update this regex ` +
      'and re-verify the value against mapColors.ts',
  ).not.toBeNull();
  return match![1].toLowerCase();
}

describe('#715: app.css --sc-* map-colour TOKENS are honest twins of lib/mapColors.ts', () => {
  const css = readAppCss();

  it('--sc-starboard -> STARBOARD_COLOR', () => {
    const hex = extractHex(css, /--sc-starboard:\s*(#[0-9a-fA-F]{6});/, '--sc-starboard');
    expect(hex).toBe(STARBOARD_COLOR.toLowerCase());
  });

  it('--sc-port -> PORT_COLOR', () => {
    const hex = extractHex(css, /--sc-port:\s*(#[0-9a-fA-F]{6});/, '--sc-port');
    expect(hex).toBe(PORT_COLOR.toLowerCase());
  });

  it('--sc-via -> VIA_COLOR', () => {
    const hex = extractHex(css, /--sc-via:\s*(#[0-9a-fA-F]{6});/, '--sc-via');
    expect(hex).toBe(VIA_COLOR.toLowerCase());
  });

  it('--sc-motor -> MOTOR_COLOR', () => {
    const hex = extractHex(css, /--sc-motor:\s*(#[0-9a-fA-F]{6});/, '--sc-motor');
    expect(hex).toBe(MOTOR_COLOR.toLowerCase());
  });

  it('--sc-ink -> INK_COLOR', () => {
    const hex = extractHex(css, /--sc-ink:\s*(#[0-9a-fA-F]{6});/, '--sc-ink');
    expect(hex).toBe(INK_COLOR.toLowerCase());
  });

  it('--sc-halo -> HALO_COLOR', () => {
    const hex = extractHex(css, /--sc-halo:\s*(#[0-9a-fA-F]{6});/, '--sc-halo');
    expect(hex).toBe(HALO_COLOR.toLowerCase());
  });

  it('--sc-depth-warning-fg -> DEPTH_WARNING_COLOR', () => {
    const hex = extractHex(
      css,
      /--sc-depth-warning-fg:\s*(#[0-9a-fA-F]{6});/,
      '--sc-depth-warning-fg',
    );
    expect(hex).toBe(DEPTH_WARNING_COLOR.toLowerCase());
  });
});

/**
 * Asserts a CSS block matches `blockPattern`, that it references
 * `var(--${token})` at least once, and that NO raw hex literal survives
 * anywhere inside it (PR #798 review: every app.css map-colour site was
 * a raw literal before this wave — now none may be, since every one of
 * them turned out to have no structural barrier to a token). Fails
 * CLOSED on a missing block, same as extractHex above.
 */
function assertUsesToken(css: string, blockPattern: RegExp, token: string, label: string): void {
  const block = css.match(blockPattern);
  expect(block, `app.css's ${label} rule not found (renamed, reformatted, or moved)`).not.toBeNull();
  const body = block![1];
  expect(body, `${label} does not reference var(--${token})`).toMatch(
    new RegExp(`var\\(--${token}\\)`),
  );
  expect(body, `${label} still contains a raw hex literal instead of only the token`).not.toMatch(
    /#[0-9a-fA-F]{6}/,
  );
}

describe('#715: app.css sites reference the token, never a raw literal (non-regression)', () => {
  const css = readAppCss();

  it('.ais-status-live -> var(--sc-starboard)', () => {
    assertUsesToken(css, /\.ais-status-live\s*\{([^}]*)\}/, 'sc-starboard', '.ais-status-live');
  });

  it('.ais-status-offline, .ais-status-keyError -> var(--sc-port)', () => {
    assertUsesToken(
      css,
      /\.ais-status-offline,\s*\.ais-status-keyError\s*\{([^}]*)\}/,
      'sc-port',
      '.ais-status-offline, .ais-status-keyError',
    );
  });

  it('.route-legend-line-starboard -> var(--sc-starboard)', () => {
    assertUsesToken(
      css,
      /\.route-legend-line-starboard\s*\{([^}]*)\}/,
      'sc-starboard',
      '.route-legend-line-starboard',
    );
  });

  it('.route-legend-line-port -> var(--sc-port)', () => {
    assertUsesToken(
      css,
      /\.route-legend-line-port\s*\{([^}]*)\}/,
      'sc-port',
      '.route-legend-line-port',
    );
  });

  it('.route-legend-line-motor (dashed gradient) -> var(--sc-motor)', () => {
    // #715 (PR #798 review fix-wave): .route-legend-line-motor appears
    // TWICE in app.css — once as the third selector in the shared sizing
    // rule (`.route-legend-line-starboard,\n.route-legend-line-port,\n
    // .route-legend-line-motor { width... }`) and once as its own rule
    // carrying the gradient. A bare `/\.route-legend-line-motor\s*\{/`
    // matches the FIRST (shared, no colour at all) and silently asserts
    // nothing about the second — anchored here on `repeating-linear-
    // gradient`, which only the real colour rule contains, so the match
    // cannot land on the wrong block.
    const block = css.match(
      /\.route-legend-line-motor\s*\{([^}]*repeating-linear-gradient[^}]*)\}/,
    );
    expect(block, '.route-legend-line-motor (gradient) rule not found').not.toBeNull();
    const body = block![1];
    expect(body).toMatch(/var\(--sc-motor\)/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('.route-legend-maneuver -> var(--sc-halo) fill, var(--sc-ink) stroke', () => {
    const block = css.match(/\.route-legend-maneuver\s*\{([^}]*)\}/);
    expect(block, '.route-legend-maneuver rule not found').not.toBeNull();
    const body = block![1];
    expect(body).toMatch(/background:\s*var\(--sc-halo\);/);
    expect(body).toMatch(/border:\s*2px solid\s*var\(--sc-ink\);/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('.route-legend-heading -> var(--sc-halo) fill, var(--sc-ink) stroke', () => {
    const block = css.match(/\.route-legend-heading\s*\{([^}]*)\}/);
    expect(block, '.route-legend-heading rule not found').not.toBeNull();
    const body = block![1];
    expect(body).toMatch(/background:\s*var\(--sc-halo\);/);
    expect(body).toMatch(/border:\s*1\.5px solid\s*var\(--sc-ink\);/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('.route-legend-via -> var(--sc-via)', () => {
    assertUsesToken(css, /\.route-legend-via\s*\{([^}]*)\}/, 'sc-via', '.route-legend-via');
  });

  it('.route-legend-shallow -> var(--sc-depth-warning-fg)', () => {
    assertUsesToken(
      css,
      /\.route-legend-shallow\s*\{([^}]*)\}/,
      'sc-depth-warning-fg',
      '.route-legend-shallow',
    );
  });
});

// BOAT_COLOR and POSITION_HALO_COLOR have NO app.css literal to twin against
// (verified by a repo-wide grep — #0072B2 never appears in app.css; #FFD400
// appears only inside this file's own header PROSE comment, never as a live
// declaration), so they are sanity-pinned directly rather than twinned.
// Sanity pins for the remaining constants too — this is deliberately NOT a
// twin (both sides would be the same import, the #50 equivalence-tautology
// this repo's own CLAUDE.md warns against), just a guard against an
// accidental edit to the wrong literal.
describe('#715: sanity pins (not twins) for the Okabe-Ito literals themselves', () => {
  it('every exported constant is the expected, unchanged hex literal', () => {
    expect(STARBOARD_COLOR).toBe('#009E73');
    expect(PORT_COLOR).toBe('#D55E00');
    expect(VIA_COLOR).toBe('#CC79A7');
    expect(BOAT_COLOR).toBe('#0072B2');
    expect(MOTOR_COLOR).toBe('#5B5B5B');
    expect(INK_COLOR).toBe('#1A1A1A');
    expect(HALO_COLOR).toBe('#FFFFFF');
    expect(POSITION_HALO_COLOR).toBe('#FFD400');
    expect(DEPTH_WARNING_COLOR).toBe('#E69F00');
  });
});
