import { describe, expect, it } from 'vitest';
import { de } from '../i18n/dict.de';
import { en } from '../i18n/dict.en';
import type { MsgKey } from '../i18n/dict.de';

// #524: `satisfies Record<MsgKey, string>` (dict.de.ts / dict.en.ts) enforces
// KEY parity between the two dicts but has zero visibility into the
// `{placeholder}` tokens a string interpolates — i18n/index.tsx's `t()` does
// `msg.replaceAll(`{${k}}`, ...)` and silently leaves any unmatched
// `{token}` verbatim in the rendered output, so a placeholder typo or
// omission in ONE language ships to users with no typecheck, lint or
// existing-test signal at all (i18n.test.tsx exercises translate/
// interpolate/toggle/lang-sync behaviour only, never placeholder tokens).
//
// Pattern follows maskTolerance.test.ts's fail-closed idiom (used throughout
// this repo's cross-artifact guards, e.g. useBannerHeight.test.ts /
// panelWidth.test.ts): a regex that silently stops matching must fail
// LOUDLY, not pass quietly by comparing two accidentally-empty sets. Here
// that means THREE separate fail-closed checks, not one:
//   1. the EXTRACTOR itself is proven non-vacuous against known-interpolated
//      keys (self-test, independent of whether any dict pair actually
//      matches) — guards against the regex silently stopping matching;
//   2. the KEY LIST being iterated is proven non-empty BEFORE the per-key
//      loop runs — guards against the #411 "a guard's data needs a twin"
//      vacuity class, where a stubbed-to-[] iteration source would
//      otherwise report a silent, contentless pass;
//   3. the extractor's APERTURE itself is proven to cover every `{...}`
//      shape actually present in either dict, so a placeholder outside it
//      cannot go invisible to checks 1 and 2 at once (below).

// #524 review MINOR: `t()`'s `vars` parameter is `Record<string, string |
// number>` (i18n/index.tsx:40) — ANY string is a legal placeholder name, but
// the original `[a-zA-Z]+` extractor only recognised pure-letter tokens. A
// future `{boat_id}`, `{count2}` or `{eta-time}` would have been invisible to
// BOTH dicts at once (both sides extract to `[]` and compare equal), which
// is the same silent-pass shape this whole file exists to prevent. Widened
// to letters, digits, underscore and hyphen — the identifier-like shapes a
// template variable name actually takes (camelCase, snake_case, kebab-case).
// Guard 3 below additionally proves this aperture, whatever it is, covers
// every `{...}` shape present in the SHIPPED dicts today, so a future shape
// this widening still doesn't anticipate reds loudly instead of vanishing.
function extractPlaceholders(msg: string): string[] {
  const tokens = new Set<string>();
  for (const match of msg.matchAll(/\{([a-zA-Z0-9_-]+)\}/g)) tokens.add(match[1]);
  return [...tokens].sort();
}

describe('#524: i18n dict placeholder parity (de vs en)', () => {
  // Fail-closed guard 1: prove the extractor itself still recognises a
  // placeholder token, using two keys independently known (by direct read of
  // both dict files) to carry `{...}` interpolation in BOTH languages today
  // — 'plan.eta' ('Ankunft {time}' / 'Arrival {time}') and 'map.scale.aria'
  // ('Maßstab: {distance} {unit}' / 'Map scale: {distance} {unit}'). If the
  // regex ever stops matching (placeholder syntax changes, a typo in the
  // pattern), these assertions red BEFORE the per-key comparison below could
  // silently pass by comparing two accidentally-empty sets.
  it('the extractor recognises placeholders on known-interpolated keys (fail-closed self-test)', () => {
    expect(extractPlaceholders(de['plan.eta'])).toEqual(['time']);
    expect(extractPlaceholders(en['plan.eta'])).toEqual(['time']);
    expect(extractPlaceholders(de['map.scale.aria']).sort()).toEqual(['distance', 'unit']);
    expect(extractPlaceholders(en['map.scale.aria']).sort()).toEqual(['distance', 'unit']);
  });

  // #524 review MINOR, pinning the widening: `{eta-time}` contains a hyphen
  // and `{boat_id}` an underscore — both OUTSIDE the OLD `[a-zA-Z]+`
  // aperture (the old regex would have extracted `[]` from either string,
  // since it cannot match across a `-`/`_`), and both INSIDE the new
  // `[a-zA-Z0-9_-]+` one. Synthetic strings, not real dict entries — this
  // pins the extractor's OWN aperture directly, independent of what the
  // shipped dicts happen to contain today.
  it('#524 review: the extractor sees placeholder shapes the OLD [a-zA-Z]+ aperture would have missed', () => {
    expect(extractPlaceholders('Arrival at {eta-time} for {boat_id}, leg {count2}')).toEqual(
      ['boat_id', 'count2', 'eta-time'].sort(),
    );
  });

  it('every MsgKey has the same placeholder token set in both languages', () => {
    const keys = Object.keys(de) as MsgKey[];
    // Fail-closed guard 2: an empty iteration source (e.g. a stubbed-to-[]
    // key list) must not silently report success — #411's "a guard's data
    // needs a twin" vacuity class.
    expect(keys.length, 'MsgKey list is empty — the guard has nothing to check').toBeGreaterThan(0);

    const mismatches: string[] = [];
    for (const key of keys) {
      const deTokens = extractPlaceholders(de[key]);
      const enTokens = extractPlaceholders(en[key]);
      const same =
        deTokens.length === enTokens.length && deTokens.every((t, i) => t === enTokens[i]);
      if (!same) {
        mismatches.push(`${key}: de=[${deTokens.join(',')}] en=[${enTokens.join(',')}]`);
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  // Fail-closed guard 3, #524 review MINOR: the widening above narrows the
  // gap but does not close it by construction — any FIXED charset can still
  // miss a future shape (a space, a unicode letter, digits-only). This scans
  // every `{...}` in BOTH dicts with a maximally permissive extractor and
  // asserts each captured token matches extractPlaceholders' OWN aperture —
  // so the day a placeholder shape appears that guard 1/2 would silently
  // skip (both sides compute `[]` and compare equal), THIS row names it
  // instead of passing quietly.
  it('#524 review: no {token} in either dict falls outside the extractor aperture', () => {
    const APERTURE = /^[a-zA-Z0-9_-]+$/;
    const outside: string[] = [];
    for (const [lang, dict] of [
      ['de', de],
      ['en', en],
    ] as const) {
      for (const [key, msg] of Object.entries(dict)) {
        for (const m of msg.matchAll(/\{([^}]*)\}/g)) {
          if (!APERTURE.test(m[1])) outside.push(`${lang}/${key}: {${m[1]}}`);
        }
      }
    }
    expect(outside, outside.join('\n')).toEqual([]);
  });
});
