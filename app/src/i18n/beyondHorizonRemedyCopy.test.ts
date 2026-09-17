// #1307: the forecast horizon is the FIXED end of the stored forecast
// (wind.ts's horizonMs()), so a LATER departure leaves strictly LESS
// forecast to search within, not more; #1258's re-measure went both ways
// (+1 h routed, -1 h failed). Guards the reworded copy against
// reintroducing "later"/"später", and pins the replacement wording #1306
// adopted in route.shallow.remedy.
import { describe, expect, it } from 'vitest';
import { de } from './dict.de';
import { en } from './dict.en';

const EN_KEYS = ['error.noRoute.beyondHorizon', 'error.noRoute.beyondHorizonSailOnly'] as const;
const DE_KEYS = EN_KEYS;

describe('#1307: beyond-horizon no-route copy never suggests a LATER departure', () => {
  it.each(EN_KEYS)('EN %s contains no form of "later"', (key) => {
    expect(en[key]).not.toMatch(/\blater\b/i);
  });

  it.each(DE_KEYS)('DE %s contains no form of "später"', (key) => {
    expect(de[key]).not.toMatch(/später/i);
  });

  // Positive control (CLAUDE.md's mutation-vacuity lesson): a probe whose
  // emptiness is meant as evidence needs a needle known to be present. Also
  // pins the replacement wording in these two keys only — this file does
  // not read route.shallow.remedyHorizon, so the two can still drift.
  it.each(EN_KEYS)('EN %s names a different departure time and a fresh forecast', (key) => {
    expect(en[key]).toContain('a different departure time');
    expect(en[key]).toContain('a fresh forecast');
  });

  it.each(DE_KEYS)('DE %s names a different departure time and a fresh forecast', (key) => {
    // Sentence-initial ("Eine andere ...") in both keys today; matched
    // case-insensitively so a reword that moves it mid-sentence does not
    // false-red.
    expect(de[key]).toMatch(/eine andere Abfahrtszeit/i);
    expect(de[key]).toMatch(/eine neue Vorhersage/i);
  });
});
