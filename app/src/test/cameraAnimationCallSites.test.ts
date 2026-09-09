import { describe, expect, it } from 'vitest';
import { stripCommentsAndStrings } from './sourceStrip';

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
// Includes .js/.jsx alongside .ts/.tsx (closing one of the #253 residual
// scanner holes below): none exist in this tree today (checked with a
// repo-wide find), but a future non-TS file would otherwise be invisible to
// this scan by construction, not merely unlikely.
const sourceFiles = import.meta.glob<string>(
  ['../**/*.{ts,tsx,js,jsx}', '!../test/**', '!../**/*.test.{ts,tsx,js,jsx}'],
  { query: '?raw', import: 'default', eager: true },
);

// v6's camera.ts: every line number below was re-derived against the
// installed maplibre-gl@6.7.0 (2026-09-08) and is unchanged between the v6
// baseline this comment was originally written against and 6.7.0.
// easeTo/flyTo/rotateTo/resetNorth/fitBounds are genuinely
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
//
// By that same "fires moveend with no originalEvent" criterion, six more
// methods belong here (verified against the installed v6
// node_modules/maplibre-gl/src/ui/camera.ts): setCenter (:415),
// setCenterElevation (:421), setZoom (:445), setPadding (:496),
// setPitch (:531) and setRoll (:538) are each a thin wrapper that calls
// jumpTo({...}) directly, and jumpTo (:708) fires 'moveend' unconditionally
// at the end of the function regardless of which fields actually changed —
// so every one of these is just as capable of tripping the guard as
// setBearing already was. No app source calls any of the six today (checked
// with a repo-wide grep), so adding them needed no new ALLOWED_FILES entry.
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
  'setCenter',
  'setCenterElevation',
  'setZoom',
  'setPadding',
  'setPitch',
  'setRoll',
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

// Strips comments (and masks string/regex-literal content) via the shared
// `./sourceStrip` helper.
//
// #1121: this file used to carry its own small character-scanning state
// machine with a documented "KNOWN RESIDUAL, latent not live" — no notion of
// a regex literal, so a quote character actually inside one (e.g.
// `/['"]/`) was read as an ordinary string opener, desyncing the
// string-state tracking for the rest of the scan (real structural content
// after it silently swallowed as "string content"). That was accepted at
// #253's fix-up pass because it verified zero differences across all 100
// non-test source files at the time. STILL LATENT, not live, by that same
// yardstick — re-measured 2026-09-09 by running BOTH the old stripper and
// `./sourceStrip`'s regex-aware one through the actual `CAMERA_METHOD_PATTERN`
// scan across all 143 current non-test `app/src` files: zero differences in
// scan results, same as #253 originally found. The divergence is now
// measurably REAL, though: `lib/format.ts`'s `DM_DMS_RE`
// (`/^(-?\d+)\s*°?\s*(\d{1,2})(?:[.,](\d+))?\s*['′]?\s*(?:(\d{1,2}
// )(?:[.,](\d+))?\s*["″]?\s*)?([A-Za-z])?$/`) contains BOTH a single quote
// (`['′]`) and a double quote (`["″]`) inside its character classes, and the
// old stripper's output for that file byte-diffs ~943 characters shorter
// than the regex-aware one's — but the confusion RESYNCS (returns to a
// clean, non-string state) before reaching any exported symbol the camera
// scan or its own non-vacuity control could observe, so it does not
// currently affect this guard's own detection. Adopted anyway, because the
// resync point is a property of THIS file's current text, not a guarantee —
// a future edit to `format.ts` could easily land a real camera-method-named
// string or a second desync-triggering regex literal past the point where
// today's confusion happens to clear. `./sourceStrip`'s
// `isRegexContext`/`scanRegexLiteral` closes the mechanism the same way
// #1120 closed it for `startPreviewSwAssertCallSites.test.ts`'s own scan
// target, where the identical hole IS live (see that file's own comment).
const stripComments = stripCommentsAndStrings;

// Matches both dot dispatch (`map.easeTo(...)`) and bracket dispatch with a
// literal string key (`map['easeTo'](...)`, `` map[`easeTo`](...) ``) — the
// latter closes one of the #253 residual scanner holes cheaply, since the
// method name is still a static string. A genuinely DYNAMIC bracket key
// (`map[m]()`, `map[someExpr()]()`) is NOT closable this way — the method
// name isn't in the source text at all, only a variable — and is left as a
// documented residual below; no such call exists anywhere in this codebase
// today (checked), and closing it for real would require type information
// this text-scanning approach doesn't have.
const CAMERA_METHOD_PATTERN = (() => {
  const alt = CAMERA_METHODS.join('|');
  return new RegExp(`\\.(${alt})\\(|\\[\\s*['"\`](${alt})['"\`]\\s*\\]\\s*\\(`, 'g');
})();

/** full glob path -> the camera calls found in it (for a legible failure). */
function findCameraCallSites(): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const [path, source] of Object.entries(sourceFiles)) {
    const stripped = stripComments(source);
    const matches = [...stripped.matchAll(CAMERA_METHOD_PATTERN)].map((m) => (m[1] ?? m[2])!);
    if (matches.length === 0) continue;
    hits.set(path, [...(hits.get(path) ?? []), ...matches]);
  }
  return hits;
}

// KNOWN RESIDUAL, latent not live: a dynamic bracket key —
// `map[methodNameVariable]()` — cannot be matched by this or any text-only
// scanner, since the actual method name never appears as a literal in the
// source. This scanner is a structural guard against ACCIDENTAL new call
// sites written the ordinary way, not an exhaustive proof against deliberate
// obfuscation. #1121 closed the SIBLING regex-literal hole this comment used
// to also name (see `stripComments`'s own header above); this one fails in
// the same direction — a missed call site reads as green, never as a false
// failure.

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

  // #1121 review round 2 (Major): a file-specific non-vacuity control was
  // tried here (asserting `lib/format.ts`'s stripped output still contained
  // `parseHemisphereCoord`, a symbol declared after the quote-bearing
  // `DM_DMS_RE`) and DELETED after mutation-checking it. Forcing
  // `./sourceStrip`'s `isRegexContext` to always return `false` (the
  // sharpest available reproduction of "regex-literal awareness regresses")
  // left ALL THREE tests in this file passing, that control included — the
  // desync in `format.ts` resyncs before reaching `parseHemisphereCoord` (see
  // `stripComments`'s header comment above), so the control could never red
  // under the mutation it existed to catch. A control that cannot fail is
  // worse than no control: it stops anyone looking for a real one. The
  // shared `assertNonVacuousStrip` primitive is still exercised
  // load-bearingly by `timeoutGuard.test.ts` and
  // `startPreviewSwAssertCallSites.test.ts` (both genuinely red under the
  // same mutation), so nothing is lost by not duplicating a non-discriminating
  // copy here.
});
