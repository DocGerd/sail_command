import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #320 structural guard (PR #375 review): app/e2e/labels.spec.ts's Signal
// (B) filters browser console warnings on the LITERAL stem
// "Unable to load glyph range" — the exact string maplibre-gl's glyph
// manager emits via `warnOnce()` when a glyph-range download fails and it
// silently falls back to a locally-drawn TinySDF glyph
// (node_modules/maplibre-gl/src/render/glyph_manager.ts,
// `_warnOnMissingGlyphRange`, maplibre-gl 6.1.0 as installed). That file's
// own header comment already documents the residual this guard closes: a
// future maplibre-gl upgrade could reword or relocate this message, and
// Signal (B) would then fail OPEN — silently stop catching the exact
// regression #320 exists to catch, while reporting green. This is the same
// class of undefended library-internals dependency as
// `symbol_bucket.ts:391` (CLAUDE.md), which the #200/#232 review flagged as
// a nice-to-have rather than required; here it's required, because Signal
// (B) is the PRIMARY discriminator its own file exists to provide, not a
// secondary check.
//
// Fails CLOSED, not open, on either failure mode:
//   - the file has moved/been renamed (a maplibre-gl upgrade restructured
//     the package) — readFileSync throws, caught and re-thrown as an
//     explicit, actionable failure naming the missing path.
//   - the file still exists but no longer contains the expected literal
//     (the message was reworded) — the `expect().toBe(true)` below fails
//     with a message naming exactly what's missing and what to do about it.
// Neither shape is silently skipped or treated as a pass — a guard that
// warns-and-continues on either failure would reproduce the exact fail-open
// gap it exists to close.
const GLYPH_MANAGER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/maplibre-gl/src/render/glyph_manager.ts',
);

// The exact substring labels.spec.ts's Signal (B) matches via
// `msg.text().startsWith(...)` — kept as a single source of truth here
// rather than re-derived, so a change to either side is a one-line diff to
// find, not a re-read of both files.
const EXPECTED_WARNING_STEM = 'Unable to load glyph range';

describe('#320 structural guard: glyph-fallback warning string', () => {
  it('the installed maplibre-gl still emits the exact stem labels.spec.ts Signal (B) filters on', () => {
    let source: string;
    try {
      source = readFileSync(GLYPH_MANAGER_PATH, 'utf8');
    } catch (err) {
      throw new Error(
        `#320 guard: could not read ${GLYPH_MANAGER_PATH} — maplibre-gl's internal file layout moved ` +
          `(a dependency upgrade?). app/e2e/labels.spec.ts's Signal (B) console-warning filter needs ` +
          `re-verifying against the new location before this guard can pass again; update ` +
          `GLYPH_MANAGER_PATH here once you've confirmed where the warning now lives.`,
        { cause: err },
      );
    }

    expect(
      source.includes(EXPECTED_WARNING_STEM),
      `#320 guard: expected the literal "${EXPECTED_WARNING_STEM}" inside ${GLYPH_MANAGER_PATH} — it is ` +
        `gone or has been reworded. A maplibre-gl upgrade changed this message, which means ` +
        `app/e2e/labels.spec.ts's Signal (B) is now filtering on a warning that no longer fires — it will ` +
        `report green through the exact glyph-fallback regression #320 exists to catch. Update both ` +
        `EXPECTED_WARNING_STEM here and the filter in labels.spec.ts to match the new wording; do not just ` +
        `silence this failure.`,
    ).toBe(true);
  });
});
