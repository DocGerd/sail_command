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

// v6's camera.ts: easeTo/flyTo/rotateTo/resetNorth/fitBounds are genuinely
// animated; fitScreenCoordinates (:613) is too and, like rotateTo, takes an
// explicit bearing. jumpTo (:637) and setBearing (:489, which just calls
// jumpTo) are instant rather than eased, but still change the camera and
// fire 'moveend' with no `originalEvent` — exactly the signal
// CompassControl's onMoveEnd guard reads to decide "was this MY ease" (see
// its comment), so an instant foreign bearing change is just as capable of
// tripping a spurious north-up -> free demotion as an eased one. resetNorthPitch
// (:512) is an easeTo wrapper. panTo/zoomTo (each an easeTo wrapper) and
// panBy/zoomIn/zoomOut (each routes through panTo/zoomTo) round out every
// method on Camera that can move or re-bear the map outside a plain user
// drag/scroll gesture.
const CAMERA_METHODS = [
  'easeTo',
  'flyTo',
  'rotateTo',
  'resetNorth',
  'resetNorthPitch',
  'snapToNorth',
  'fitBounds',
  'fitScreenCoordinates',
  'jumpTo',
  'setBearing',
  'panTo',
  'zoomTo',
  'panBy',
  'zoomIn',
  'zoomOut',
];

/**
 * Files allowed to call a camera-animating MapLibre method, and WHY each one
 * is safe under the #253 narrowing. Keyed on the full glob path (as returned
 * by `import.meta.glob`, e.g. `../components/CompassControl.tsx`) rather
 * than a bare basename — a basename key would let a same-named file dropped
 * anywhere else in the tree (`components/legacy/RouteLayer.tsx`) silently
 * inherit the allowlist:
 *
 *   - components/CompassControl.tsx: `easeTo` only, always through
 *     `easeBearing`, which is the one call site `commandedBearingRef`
 *     tracks. This is the file the narrowing was written for.
 *   - components/RouteLayer.tsx: `fitBounds` only, always with
 *     `duration: 0` — never actually in flight, so it can never trip the
 *     "commanded bearing not yet reached" half of the guard no matter what
 *     bearing it passes.
 */
const ALLOWED_FILES = new Set(['../components/CompassControl.tsx', '../components/RouteLayer.tsx']);

// Strips comments with a small character-scanning state machine rather than
// a `//`-to-end-of-line regex: the naive regex truncates a line at the FIRST
// `//` it sees, including one that is actually inside a string or template
// literal (e.g. `` fetch(`https://x/y`); map.flyTo({...}) ``), which erases
// the real call that followed it on the same line. That failure direction is
// a FALSE GREEN — the guard would silently miss a genuine new call site —
// which is worse than the reverse, so this tracks string state explicitly
// and only treats `//`/`/*` as a comment opener outside of one.
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let inString: '"' | "'" | '`' | null = null;
  while (i < source.length) {
    const c = source[i]!;
    const c2 = source[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += c2 ?? '';
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && c2 === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** full glob path -> the camera calls found in it (for a legible failure). */
function findCameraCallSites(): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  const pattern = new RegExp(`\\.(${CAMERA_METHODS.join('|')})\\(`, 'g');
  for (const [path, source] of Object.entries(sourceFiles)) {
    const stripped = stripComments(source);
    const matches = [...stripped.matchAll(pattern)].map((m) => m[1]!);
    if (matches.length === 0) continue;
    hits.set(path, [...(hits.get(path) ?? []), ...matches]);
  }
  return hits;
}

describe('#253 structural guard: camera-animating call sites', () => {
  it('finds every currently-known call site (proves the scan itself works)', () => {
    const hits = findCameraCallSites();
    expect(hits.get('../components/CompassControl.tsx')).toEqual(['easeTo']);
    expect(hits.get('../components/RouteLayer.tsx')).toEqual(['fitBounds']);
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
