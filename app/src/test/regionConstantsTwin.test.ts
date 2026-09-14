// #1164 follow-up: app/vite.config.ts independently declares three region
// constants at build time (Node-only file classification can't import
// app/src/lib/basemapRegions.ts — the browser/Node tsconfig split), and they
// must never drift from that module's exports, which the runtime protocol
// (compositeBasemapProtocol.ts) and the pin service (regionPinning.ts) both
// consume. Reads vite.config.ts as a FOREIGN artifact (`readFileSync`, never
// a browser-side import: `CORE_REGION_ID` and `REGION_ARCHIVE_FILENAME_RE`
// are private, unexported consts there) and extracts each literal via an
// ADDRESSED pattern anchored to its declaring statement — never a bare
// substring search for the expected value — so a renamed identifier or a
// reworded declaration fails CLOSED with a named message instead of
// silently reading `undefined` or matching the wrong site.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertNonVacuousStrip, stripCommentsAndStrings } from './sourceStrip';
import { CORE_REGION_ID, REGION_ARCHIVE_PREFIX, REGION_MANIFEST_PATH } from '../lib/basemapRegions';

const VITE_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../vite.config.ts');

/**
 * Reads vite.config.ts's raw text. `stripCommentsAndStrings` +
 * `assertNonVacuousStrip` (#1121) are used here ONLY as a non-vacuity
 * control confirming the read succeeded against real source (never an
 * accidentally-empty file, a swallowed error, or a stripper regression) —
 * the literals below are extracted from the RAW text, because
 * `stripCommentsAndStrings` MASKS every string/regex literal's CONTENT to
 * spaces (that masking is what makes it safe against a decoy mention inside
 * a comment for OTHER guards), which would erase the very values this test
 * needs to read.
 */
function readViteConfigSource(): string {
  const raw = readFileSync(VITE_CONFIG_PATH, 'utf8');
  assertNonVacuousStrip(stripCommentsAndStrings(raw), 'CORE_REGION_ID', 'app/vite.config.ts');
  return raw;
}

/**
 * Extracts capture group 1 of `pattern` from `source`, or throws with
 * `label` named. An addressed pattern must fail CLOSED — a loud, named
 * error — rather than silently matching nothing (`undefined`) when the
 * declaration it targets moves, is renamed, or is reworded.
 */
function extractLiteral(source: string, pattern: RegExp, label: string): string {
  const m = pattern.exec(source);
  if (!m || m[1] === undefined) {
    throw new Error(
      `regionConstantsTwin: addressed pattern for ${label} no longer matches ` +
        'app/vite.config.ts — the declaration moved or was reworded; update the pattern here, ' +
        'do not loosen it.',
    );
  }
  return m[1];
}

describe('#1164 follow-up: vite.config.ts region constants twin basemapRegions.ts', () => {
  it('CORE_REGION_ID literal agrees', () => {
    const value = extractLiteral(
      readViteConfigSource(),
      /const CORE_REGION_ID = '([^']+)';/,
      'CORE_REGION_ID',
    );
    expect(value).toBe(CORE_REGION_ID);
  });

  it('the region archive filename prefix agrees', () => {
    // REGION_ARCHIVE_FILENAME_RE is
    // `/^region-([a-z0-9][a-z0-9-]*)\.pmtiles\.png$/` — the literal text
    // between the regex's `^` anchor and its first capture group IS the
    // archive-basename prefix.
    const value = extractLiteral(
      readViteConfigSource(),
      /const REGION_ARCHIVE_FILENAME_RE = \/\^([^(]+)\(/,
      'REGION_ARCHIVE_FILENAME_RE prefix',
    );
    expect(value).toBe(REGION_ARCHIVE_PREFIX);
  });

  it('the emitted manifest filename agrees', () => {
    // Anchored to regionManifest()'s own plugin `name` immediately before
    // its `emitFile` call, so this can never match the sibling
    // glyphManifest() plugin's own 'glyph-manifest.json' fileName a few
    // functions away in the same file.
    const value = extractLiteral(
      readViteConfigSource(),
      /name: 'sailcommand:region-manifest'[\s\S]*?fileName: '([^']+)'/,
      'region manifest emitted filename',
    );
    expect(value).toBe(REGION_MANIFEST_PATH);
  });
});
