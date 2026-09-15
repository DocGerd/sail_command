// #1164 follow-up: app/vite.config.ts independently declares three region
// constants at build time (Node-only file classification can't import
// app/src/lib/basemapRegions.ts — the browser/Node tsconfig split), and they
// must never drift from that module's exports, which the runtime protocol
// (compositeBasemapProtocol.ts) and the pin service (regionPinning.ts) both
// consume. Reads vite.config.ts as a FOREIGN artifact (`readFileSync`, never
// a browser-side import: `CORE_REGION_ID` and `REGION_ARCHIVE_FILENAME_RE`
// are private, unexported consts there).
//
// Review 5202843497 (PR #1230): an earlier revision extracted each literal
// with a single unanchored regex over the RAW file. `RegExp.exec` with no
// `/g` flag returns the FIRST match, so a decoy — a commented-out copy of
// the same declaration shape placed above a changed live one — matched
// instead of the live declaration, and the suite passed 3/3 with the wrong
// value shipped (reproduced for all three assertions in that review).
//
// Fix: locate each declaration's ANCHOR in the comment-STRIPPED source
// first — `stripCommentsAndStrings` deletes every `//` and `/* */` comment
// outright (never merely masks it), so a decoy can never appear there — then
// map that match's character offset back to a LINE NUMBER (newlines are
// preserved 1:1 between raw and stripped by that function's own contract,
// so line numbers agree even though byte offsets don't once comments are
// removed) and extract the literal only from that raw line via a CAPTURE
// regex. String/regex-literal CONTENT is also masked to spaces in the
// stripped source (not merely comments), which is why extraction always
// happens against the RAW line, never the stripped one.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertNonVacuousStrip, stripCommentsAndStrings } from './sourceStrip';
import { CORE_REGION_ID, REGION_ARCHIVE_PREFIX, REGION_MANIFEST_PATH } from '../lib/basemapRegions';

const VITE_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../vite.config.ts');

interface ViteConfigSource {
  readonly raw: string;
  readonly stripped: string;
}

function readViteConfigSource(): ViteConfigSource {
  const raw = readFileSync(VITE_CONFIG_PATH, 'utf8');
  const stripped = stripCommentsAndStrings(raw);
  // Non-vacuity control (#1121): confirms the read succeeded against real
  // source (never an accidentally-empty file, a swallowed error, or a
  // stripper regression) before it is trusted to anchor anything.
  assertNonVacuousStrip(stripped, 'CORE_REGION_ID', 'app/vite.config.ts');
  return { raw, stripped };
}

/**
 * Finds `anchor` in the comment-stripped source (decoys are deleted there,
 * so they can never match), maps the anchor match's END to its RAW line
 * number, then extracts capture group 1 of `capture` from ONLY that one raw
 * line — never a joined multi-line span. A multi-line anchor (the manifest
 * filename case, which must span from `function regionManifest(): Plugin {`
 * down to its own `fileName:`) can legitimately cross several RAW lines that
 * a decoy comment sits inside; those decoy lines vanish from the STRIPPED
 * source (comments are deleted outright) but are still present, verbatim,
 * in the RAW text in between. Joining that whole raw span and running
 * `capture` against it would let an EARLIER decoy line's raw text win the
 * unanchored `RegExp.exec` — the exact class of bug this file exists to
 * close, reintroduced one level down. Restricting `capture` to the single
 * raw line the anchor match ends on closes that: the anchor's own end
 * position is decoy-proof (derived from the comment-free stripped source),
 * so the raw line it points at is always the live declaration's line.
 *
 * Fails CLOSED with a named, loud error — never a silent `undefined` or a
 * match against the wrong site — when either regex stops matching (the
 * declaration moved, was renamed, or was reworded).
 */
function extractLiteral(
  { raw, stripped }: ViteConfigSource,
  anchor: RegExp,
  capture: RegExp,
  label: string,
): string {
  const anchorMatch = anchor.exec(stripped);
  if (!anchorMatch) {
    throw new Error(
      `regionConstantsTwin: ${label}'s anchor no longer matches the comment-stripped ` +
        'app/vite.config.ts — the declaration moved or was reworded; update the anchor here, ' +
        'do not loosen it.',
    );
  }
  const startLine = stripped.slice(0, anchorMatch.index).split('\n').length;
  const endLine = startLine + anchorMatch[0].split('\n').length - 1;
  const rawLine = raw.split('\n')[endLine - 1] ?? '';
  const m = capture.exec(rawLine);
  if (!m || m[1] === undefined) {
    throw new Error(
      `regionConstantsTwin: ${label}'s literal was not found on its own declaration's raw ` +
        `line ${endLine} of app/vite.config.ts — update the capture pattern, do not loosen it.`,
    );
  }
  return m[1];
}

describe('#1164 follow-up: vite.config.ts region constants twin basemapRegions.ts', () => {
  it('CORE_REGION_ID literal agrees', () => {
    const value = extractLiteral(
      readViteConfigSource(),
      /const CORE_REGION_ID\s*=\s*;/,
      /const CORE_REGION_ID = '([^']+)';/,
      'CORE_REGION_ID',
    );
    expect(value).toBe(CORE_REGION_ID);
  });

  it('the region archive filename prefix agrees', () => {
    // REGION_ARCHIVE_FILENAME_RE is
    // `/^region-([a-z0-9][a-z0-9-]*)\.pmtiles\.png$/` — the literal text
    // between the regex's `^` anchor and its first capture group IS the
    // archive-basename prefix. The whole regex literal is masked to spaces
    // in the stripped source (same masking as a string literal), which is
    // why the anchor stops at `=\s*;` rather than naming any of it.
    const value = extractLiteral(
      readViteConfigSource(),
      /const REGION_ARCHIVE_FILENAME_RE\s*=\s*;/,
      /const REGION_ARCHIVE_FILENAME_RE = \/\^([^(]+)\(/,
      'REGION_ARCHIVE_FILENAME_RE prefix',
    );
    expect(value).toBe(REGION_ARCHIVE_PREFIX);
  });

  it('the emitted manifest filename agrees', () => {
    // `glyphManifest()` (a different plugin, earlier in this file) emits
    // its OWN `fileName: 'glyph-manifest.json'` through the identical
    // `emitFile({ type: 'asset', fileName: ..., source: ... })` shape, so
    // an anchor scoped only to that shape would match the WRONG site (the
    // first one in the file) — the same defect this test exists to close,
    // one level up. `function regionManifest(): Plugin {` is the anchor's
    // start precisely because the FUNCTION NAME is a code identifier, not a
    // string, so it survives stripping and is unique to this plugin.
    const value = extractLiteral(
      readViteConfigSource(),
      /function regionManifest\(\): Plugin \{[\s\S]*?fileName:\s*,/,
      /^\s*fileName: '([^']+)'/,
      'region manifest emitted filename',
    );
    expect(value).toBe(REGION_MANIFEST_PATH);
  });
});
