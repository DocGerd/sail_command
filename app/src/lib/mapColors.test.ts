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

// #715: mapColors.ts's own doc comment states the deliberate exception —
// app.css keeps raw hex literals at every site listed below (a MapLibre
// paint expression and a Canvas 2D strokeStyle structurally cannot consume
// var(), so app.css was never going to import this module) — so THIS file
// is the twin that keeps those literals honest against the shared
// constants. No compiler spans CSS and TypeScript; this is the only thing
// that can catch drift (the maskTolerance.test.ts / useBannerHeight.test.ts
// readFileSync pattern). Every extraction fails CLOSED — an explicit
// not.toBeNull() BEFORE any value comparison — so a selector that is
// renamed, reformatted, or removed reds loudly here instead of silently
// comparing nothing (the same shape as the CSP String.replace incident,
// #223, this repo has already been bitten by once).

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

describe('#715: app.css map-colour literals are honest twins of lib/mapColors.ts', () => {
  const css = readAppCss();

  it('.ais-status-live -> STARBOARD_COLOR', () => {
    const hex = extractHex(
      css,
      /\.ais-status-live\s*\{\s*color:\s*(#[0-9a-fA-F]{6});/,
      '.ais-status-live',
    );
    expect(hex).toBe(STARBOARD_COLOR.toLowerCase());
  });

  it('.ais-status-offline, .ais-status-keyError -> PORT_COLOR', () => {
    const hex = extractHex(
      css,
      /\.ais-status-offline,\s*\.ais-status-keyError\s*\{\s*color:\s*(#[0-9a-fA-F]{6});/,
      '.ais-status-offline, .ais-status-keyError',
    );
    expect(hex).toBe(PORT_COLOR.toLowerCase());
  });

  it('.route-legend-line-starboard -> STARBOARD_COLOR', () => {
    const hex = extractHex(
      css,
      /\.route-legend-line-starboard\s*\{\s*background:\s*(#[0-9a-fA-F]{6});/,
      '.route-legend-line-starboard',
    );
    expect(hex).toBe(STARBOARD_COLOR.toLowerCase());
  });

  it('.route-legend-line-port -> PORT_COLOR', () => {
    const hex = extractHex(
      css,
      /\.route-legend-line-port\s*\{\s*background:\s*(#[0-9a-fA-F]{6});/,
      '.route-legend-line-port',
    );
    expect(hex).toBe(PORT_COLOR.toLowerCase());
  });

  it('.route-legend-line-motor (dashed gradient) -> MOTOR_COLOR', () => {
    const hex = extractHex(
      css,
      /\.route-legend-line-motor\s*\{[^}]*repeating-linear-gradient\(to right,\s*(#[0-9a-fA-F]{6})/,
      '.route-legend-line-motor',
    );
    expect(hex).toBe(MOTOR_COLOR.toLowerCase());
  });

  it('.route-legend-maneuver -> HALO_COLOR fill, INK_COLOR stroke', () => {
    const block = css.match(/\.route-legend-maneuver\s*\{([^}]*)\}/);
    expect(block, '.route-legend-maneuver rule not found').not.toBeNull();
    const fill = block![1].match(/background:\s*(#[0-9a-fA-F]{6});/);
    const stroke = block![1].match(/border:\s*2px solid\s*(#[0-9a-fA-F]{6});/);
    expect(fill, '.route-legend-maneuver background not found').not.toBeNull();
    expect(stroke, '.route-legend-maneuver border not found').not.toBeNull();
    expect(fill![1].toLowerCase()).toBe(HALO_COLOR.toLowerCase());
    expect(stroke![1].toLowerCase()).toBe(INK_COLOR.toLowerCase());
  });

  it('.route-legend-heading -> HALO_COLOR fill, INK_COLOR stroke', () => {
    const block = css.match(/\.route-legend-heading\s*\{([^}]*)\}/);
    expect(block, '.route-legend-heading rule not found').not.toBeNull();
    const fill = block![1].match(/background:\s*(#[0-9a-fA-F]{6});/);
    const stroke = block![1].match(/border:\s*1\.5px solid\s*(#[0-9a-fA-F]{6});/);
    expect(fill, '.route-legend-heading background not found').not.toBeNull();
    expect(stroke, '.route-legend-heading border not found').not.toBeNull();
    expect(fill![1].toLowerCase()).toBe(HALO_COLOR.toLowerCase());
    expect(stroke![1].toLowerCase()).toBe(INK_COLOR.toLowerCase());
  });

  it('.route-legend-via -> VIA_COLOR', () => {
    const hex = extractHex(
      css,
      /\.route-legend-via\s*\{[^}]*background:\s*(#[0-9a-fA-F]{6});/,
      '.route-legend-via',
    );
    expect(hex).toBe(VIA_COLOR.toLowerCase());
  });

  // #251/#53: this constant's app.css twin is the --sc-depth-warning-fg
  // custom property (theme-invariant — same literal in both the light :root
  // block and the dark-mode override), NOT .route-legend-shallow: that
  // swatch is the one map-colour site with a pre-existing token to point at
  // (#715), so it now reads var(--sc-depth-warning-fg) instead of a second
  // raw literal — asserted below as a non-regression guard.
  it('--sc-depth-warning-fg -> DEPTH_WARNING_COLOR', () => {
    const hex = extractHex(
      css,
      /--sc-depth-warning-fg:\s*(#[0-9a-fA-F]{6});/,
      '--sc-depth-warning-fg',
    );
    expect(hex).toBe(DEPTH_WARNING_COLOR.toLowerCase());
  });

  it('#715 non-regression: .route-legend-shallow reads the token, not a second raw literal', () => {
    const block = css.match(/\.route-legend-shallow\s*\{([^}]*)\}/);
    expect(block, '.route-legend-shallow rule not found').not.toBeNull();
    expect(block![1]).toMatch(/background:\s*var\(--sc-depth-warning-fg\);/);
    expect(block![1]).not.toMatch(/background:\s*#[0-9a-fA-F]{6};/);
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
