import { describe, expect, it } from 'vitest';

// #253 (maplibre-gl 6 migration): the guard CompassControl.tsx's `onMoveEnd`
// uses to tell "our own tracked camera ease is still in flight" from "it just
// ended" was narrowed from MapLibre's own ease-source-agnostic `isEasing()`
// (removed from `Map` in v6) down to component-local state
// (`commandedBearingRef` + the settle event's own `originalEvent`). That
// narrowing was deliberately scoped to the app's CURRENT camera-animating
// call sites (see CompassControl.tsx's `onMoveEnd` comment for the full
// reachability argument): only CompassControl ever starts a bearing-changing
// ease, and RouteLayer's `fitBounds` always passes `duration: 0` (never in
// flight to begin with).
//
// That argument is silently invalidated by a NEW call site: another
// component starting its own `easeTo`/`flyTo`/etc. would introduce exactly
// the "foreign ease with an unpredictable bearing" case the narrowing accepts
// as out of scope today. This test converts that from a silent regression
// into a loud, explained CI failure by scanning the whole app source for
// every camera-animating MapLibre call and asserting the set of files that
// make one is EXACTLY the allowlist below — no more, no less (so removing a
// call site here also needs updating, keeping the list honest).
//
// Source is read via Vite's `?raw` glob import (`vite/client` types, already
// in tsconfig.app.json) rather than Node's `fs` module, so this file needs no
// tsconfig.test.json entry — it stays plain browser-safe test code like every
// other spec beside it.
//
// Comments are stripped before matching (both `//` and `/* */`) because this
// repo's own comments narrate these exact method names in prose — e.g.
// MapView.tsx documents MapLibre's internal `map.resetNorth()` behaviour in a
// comment without ever calling it, and a naive substring scan would flag that
// as a false positive.

// Test infrastructure (this directory) is exempt by design: fakeMaplibre.ts's
// own wrapper methods and this file's own doc comments both legitimately name
// these methods without being a PRODUCTION camera call site. `eager: true`
// resolves everything at collection time, matching how vitest already reads
// the rest of this suite.
const sourceFiles = import.meta.glob<string>(
  ['../**/*.{ts,tsx}', '!../test/**', '!../**/*.test.{ts,tsx}'],
  { query: '?raw', import: 'default', eager: true },
);

const CAMERA_METHODS = ['easeTo', 'flyTo', 'rotateTo', 'resetNorth', 'snapToNorth', 'fitBounds'];

/**
 * Files allowed to call a camera-animating MapLibre method, and WHY each one
 * is safe under the #253 narrowing:
 *
 *   - CompassControl.tsx: `easeTo` only, always through `easeBearing`, which
 *     is the one call site `commandedBearingRef` tracks. This is the file the
 *     narrowing was written for.
 *   - RouteLayer.tsx: `fitBounds` only, always with `duration: 0` — never
 *     actually in flight, so it can never trip the "commanded bearing not yet
 *     reached" half of the guard no matter what bearing it passes.
 */
const ALLOWED_FILES = new Set(['CompassControl.tsx', 'RouteLayer.tsx']);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** file basename -> the camera calls found in it (for a legible failure). */
function findCameraCallSites(): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  const pattern = new RegExp(`\\.(${CAMERA_METHODS.join('|')})\\(`, 'g');
  for (const [path, source] of Object.entries(sourceFiles)) {
    const stripped = stripComments(source);
    const matches = [...stripped.matchAll(pattern)].map((m) => m[1]!);
    if (matches.length === 0) continue;
    const base = path.split('/').pop()!;
    hits.set(base, [...(hits.get(base) ?? []), ...matches]);
  }
  return hits;
}

describe('#253 structural guard: camera-animating call sites', () => {
  it('finds every currently-known call site (proves the scan itself works)', () => {
    const hits = findCameraCallSites();
    expect(hits.get('CompassControl.tsx')).toEqual(['easeTo']);
    expect(hits.get('RouteLayer.tsx')).toEqual(['fitBounds']);
  });

  it('never gains a NEW camera-animating call site outside the #253 allowlist', () => {
    const hits = findCameraCallSites();
    const offenders = [...hits.keys()].filter((file) => !ALLOWED_FILES.has(file));

    if (offenders.length > 0) {
      const detail = offenders.map((file) => `${file}: ${hits.get(file)!.join(', ')}`).join('\n  ');
      throw new Error(
        `New MapLibre camera-animating call site(s) outside the #253 allowlist:\n  ${detail}\n\n` +
          `Why this matters: CompassControl.tsx's onMoveEnd guard narrowed MapLibre 6's ` +
          `removed Map#isEasing() down to component-local state (commandedBearingRef + the ` +
          `settle event's originalEvent) that ONLY recognizes an ease started by ` +
          `CompassControl's own easeBearing (see its onMoveEnd comment, #253). A new ` +
          `bearing-changing ease anywhere else is exactly the "foreign ease" case that guard ` +
          `does not suppress — it can cause a spurious north-up -> free demotion while your ` +
          `new ease is still legitimately in flight. Either route the new call through ` +
          `CompassControl's easeBearing/commandedBearingRef, or re-evaluate whether the ` +
          `guard needs to go back to an ease-source-agnostic signal, and only then add the ` +
          `new file to ALLOWED_FILES in this test.`,
      );
    }
  });
});
