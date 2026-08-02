import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SeamarkFeatureCollection } from './seamarkGeoJson';
import { seamarkPopoverRows } from './seamarkPopover';

// Guards against #300's silent regression case (see the issue): #295
// proposes extending the data bbox, which will re-run the pipeline and can
// introduce seamark tag values that exist nowhere in today's translation
// maps. Without this test, the popover would quietly start showing raw
// English fallback text again in exactly the newly added area — this test
// reads the REAL committed dataset (never a synthetic fixture) and fails
// loudly the moment a value has no translation key.
const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const seamarks = JSON.parse(
  readFileSync(resolve(dataDir, 'seamarks.json'), 'utf8'),
) as SeamarkFeatureCollection;

describe('seamarkPopoverRows coverage over the shipped seamarks.json', () => {
  it('has a shipped dataset with at least one feature (sanity: an empty fixture would make every assertion below vacuous)', () => {
    expect(seamarks.features.length).toBeGreaterThan(0);
  });

  it('translates every type/category/colour/lightColour value present in the shipped data — no fallback token', () => {
    // #300 F8: collected into a Set of DISTINCT VALUES, not one line per
    // feature — 1794 features share only a few dozen distinct tag values, so
    // a per-feature list drowns a real drift in duplicate lines (a dropped
    // colour.grey entry alone produced 31 byte-identical lines under the
    // old per-feature form) and vitest truncates long array diffs, hiding
    // exactly the new values a reviewer needs to see. `feature.id` is
    // dropped too: verified zero features in the shipped dataset carry one,
    // so `(feature ${feature.id ?? '?'})` always rendered dead "(feature ?)"
    // text and named nothing.
    const untranslated = new Set<string>();
    for (const feature of seamarks.features) {
      const props = feature.properties;
      if (!props) continue;
      for (const row of seamarkPopoverRows(props)) {
        // lightCharacter and the lightPeriod unit are deliberately never
        // translation-key-less-fallback rows for THIS check: lightCharacter
        // is verbatim by design (asserted separately below), and
        // lightPeriod always resolves via its template key.
        if (row.labelKey === 'seamark.popover.lightCharacter') continue;
        for (const token of row.value) {
          if ('text' in token) {
            untranslated.add(`${row.labelKey}: "${token.text}"`);
          }
        }
      }
    }
    expect([...untranslated]).toEqual([]);
  });

  it('keeps every lightCharacter value verbatim (never routed through a translation key)', () => {
    let checked = 0;
    for (const feature of seamarks.features) {
      const props = feature.properties;
      if (!props?.lightCharacter) continue;
      const row = seamarkPopoverRows(props).find(
        (r) => r.labelKey === 'seamark.popover.lightCharacter',
      );
      expect(row?.value).toEqual([{ text: props.lightCharacter }]);
      checked += 1;
    }
    // Sanity: the dataset does tag lightCharacter somewhere, so this branch
    // is actually exercised rather than vacuously passing.
    expect(checked).toBeGreaterThan(0);
  });
});
