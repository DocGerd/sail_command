import { useCallback, useEffect, useRef, useState } from 'react';
import Button from './Button';
import { useMapInstance } from './MapView';
import { useT } from '../i18n';
import {
  COMPASS_EASE_ID,
  COMPASS_STATUS_MS,
  EASE_NORTH_MS,
  EASE_TRACK_MS,
  ORIENTATION_STALE_MS,
  TRACK_DEADBAND_DEG,
  TRACK_DEADBAND_REDUCED_DEG,
  compassLabelKey,
  nextOrientation,
  orientationVisual,
  shouldEaseToCourse,
  shouldSnapNorth,
  trackUpAvailable,
  type OrientationMode,
} from '../lib/mapOrientation';
import { usePrefersReducedMotion } from '../lib/usePrefersReducedMotion';
import type { GpsFix } from '../services/geolocation';

export interface CompassControlProps {
  /** Latest ownship fix (App's single `useOwnshipGps` call site, <=1 Hz). */
  fix: GpsFix | null;
  /** `settings.showOwnship` — without it there is no COG source at all. */
  showOwnship: boolean;
}

/**
 * #155: chart-style north arrow that doubles as the north-up / track-up
 * control. Always mounted, on every tab (decision 2: the map is shared chrome,
 * and flipping orientation on a tab switch would disorient).
 *
 * The live bearing NEVER enters React state: `map.on('rotate')` writes a
 * rAF-throttled `style.transform` straight onto the needle group. State here
 * changes only on user intent (a tap, a hand rotation) and on the two
 * human-scale timers — that is what keeps a 60 fps rotation gesture from
 * re-rendering the app (the #158 per-fix-signal rule, applied to the camera).
 */
export default function CompassControl({ fix, showOwnship }: CompassControlProps) {
  const map = useMapInstance();
  const t = useT();
  const reducedMotion = usePrefersReducedMotion();

  const [mode, setMode] = useState<OrientationMode>('north');
  const [stale, setStale] = useState(false);
  const [statusText, setStatusText] = useState('');
  // Bumped on every rejected tap; used only as a React key so the pulse ring
  // remounts (and therefore restarts its animation) without remounting the
  // button — a key change on the button itself would drop keyboard focus.
  const [pulseSeq, setPulseSeq] = useState(0);

  const needleRef = useRef<SVGGElement | null>(null);
  const statusTimerRef = useRef<number | undefined>(undefined);

  // Latest values for the map listeners, which are registered once per map
  // instance and must not be torn down on every render.
  //
  // `modeRef` is written SYNCHRONOUSLY alongside every setMode (never synced
  // from a render effect): MapLibre can deliver rotatestart and rotateend in
  // the same tick on a quick flick, and a ref that lagged one render behind
  // would have the rotateend handler still reading the pre-rotation mode —
  // silently losing the snap-to-north. All mode writes go through
  // `applyMode`, so the two can never diverge.
  const modeRef = useRef<OrientationMode>(mode);
  const applyMode = useCallback((next: OrientationMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  });

  // True only while THIS component's own easeTo is driving the camera;
  // cleared on 'moveend'. Belt-and-braces companion to the
  // rotatestart/originalEvent signal below: keyboard rotation reaches the
  // camera through MapLibre's own handler-driven ease, so a 'rotate' seen
  // while this flag is false is by definition not ours — i.e. the user turned
  // the chart and owns the bearing from here (`free`).
  const easingRef = useRef(false);

  const easeBearing = useCallback(
    (bearingDeg: number, durationMs: number, linear = false) => {
      if (!map) return;
      easingRef.current = true;
      map.easeTo({
        bearing: bearingDeg,
        duration: reducedMotionRef.current ? 0 : durationMs,
        // COMPASS_EASE_ID is load-bearing, not cosmetic. easeTo's first act is
        // `this._stop(false, options.easeId)`, which runs the INTERRUPTED
        // ease's `_afterEase(eventData, interruptingEaseId)` synchronously,
        // before the new ease emits a frame. `_afterEase` suppresses its
        // rotateend/moveend only when `this._easeId === easeId` — so without a
        // stable id, one compass ease interrupting another fires `moveend`,
        // clearing `easingRef` mid-flight, and the very next `rotate` frame of
        // our OWN animation gets mistaken for a hand rotation and demotes the
        // mode to `free`. That is reachable in ordinary use: `useOwnshipGps`
        // applies no throttle, so two fixes closer together than EASE_TRACK_MS
        // chain two follow eases and track-up switches itself off mid-passage;
        // a fast double-tap does the same with no GPS at all.
        // Natural completion still passes no id (`finish()` takes none), so
        // moveend — and the flag reset — survives for the non-interrupted case.
        easeId: COMPASS_EASE_ID,
        // Linear for the track-up follow only: consecutive ~900 ms eases at
        // the ~1 Hz fix cadence chain into continuous motion, where an
        // ease-in-out would visibly stutter at every fix boundary.
        ...(linear ? { easing: (x: number) => x } : {}),
      });
    },
    [map],
  );

  // Kept in a ref so the listener effect below depends on `map` alone.
  const easeBearingRef = useRef(easeBearing);
  useEffect(() => {
    easeBearingRef.current = easeBearing;
  });

  // ---- needle painting + manual-rotation detection (one registration/map) ----
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const needle = needleRef.current;
      // North stays north: with MapLibre's bearing being "the compass
      // direction that is up", the needle must counter-rotate by it.
      if (needle) needle.style.transform = `rotate(${-map.getBearing()}deg)`;
    };
    const schedulePaint = () => {
      if (raf === 0) raf = requestAnimationFrame(paint);
    };
    const dropToFree = () => {
      if (modeRef.current !== 'free') applyMode('free');
    };
    const onRotate = () => {
      schedulePaint();
      if (!easingRef.current) dropToFree();
    };
    // Primary manual-rotation signal: a gesture-driven rotatestart carries the
    // originating DOM event; a camera animation's does not.
    const onRotateStart = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent !== undefined) dropToFree();
    };
    const onRotateEnd = () => {
      // Chart-plotter affordance: a hand rotation that lands within a degree
      // of north snaps the rest of the way — otherwise a gesture user can
      // never get back to an exact 0 bearing.
      if (modeRef.current === 'free' && shouldSnapNorth(map.getBearing())) {
        applyMode('north');
        easeBearingRef.current(0, EASE_NORTH_MS);
      }
    };
    const onMoveEnd = () => {
      easingRef.current = false;
    };

    paint();
    map.on('rotate', onRotate);
    map.on('rotatestart', onRotateStart);
    map.on('rotateend', onRotateEnd);
    map.on('moveend', onMoveEnd);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      map.off('rotate', onRotate);
      map.off('rotatestart', onRotateStart);
      map.off('rotateend', onRotateEnd);
      map.off('moveend', onMoveEnd);
    };
  }, [map, applyMode]);

  const trackAvailable = trackUpAvailable(showOwnship, fix);

  // ---- track-up follow loop ----
  // Keyed on the fix prop, so it runs at the GPS publish cadence (<=1 Hz by
  // useOwnshipGps's construction). A camera ease is exactly the cheap,
  // idempotent per-fix consumer #158 allows; the deadband is what stops COG
  // noise from chaining pointless eases while the boat wallows.
  useEffect(() => {
    if (!map || mode !== 'track' || !trackAvailable) return;
    const cog = fix?.cogDeg;
    if (cog == null) return;
    const deadband = reducedMotion ? TRACK_DEADBAND_REDUCED_DEG : TRACK_DEADBAND_DEG;
    if (!shouldEaseToCourse(map.getBearing(), cog, deadband)) return;
    easeBearing(cog, EASE_TRACK_MS, true);
  }, [map, mode, trackAvailable, fix, reducedMotion, easeBearing]);

  // ---- held-bearing staleness ----
  // Decision 1: losing the fix (or dropping below the SOG floor) HOLDS the
  // last bearing rather than spinning the chart back to north; after the grace
  // period the ring dims so the user knows the orientation is being held, not
  // followed. Reset lives in the cleanup — i.e. it fires exactly when the
  // episode ends (fix returns, mode leaves track, unmount) — so the effect
  // body never sets state.
  useEffect(() => {
    if (mode !== 'track' || trackAvailable) return;
    const id = window.setTimeout(() => setStale(true), ORIENTATION_STALE_MS);
    return () => {
      window.clearTimeout(id);
      setStale(false);
    };
  }, [mode, trackAvailable]);

  // Switching "show my position" off removes the COG source entirely, so
  // track-up cannot honestly continue — return to north rather than holding a
  // bearing that will never update again.
  useEffect(() => {
    if (showOwnship) return;
    if (modeRef.current === 'track') {
      applyMode('north');
      easeBearing(0, EASE_NORTH_MS);
    }
  }, [showOwnship, easeBearing, applyMode]);

  useEffect(
    () => () => {
      window.clearTimeout(statusTimerRef.current);
    },
    [],
  );

  const handleTap = useCallback(() => {
    const next = nextOrientation(mode, trackAvailable);
    applyMode(next.mode);
    if (next.action === 'ease-north') {
      easeBearing(0, EASE_NORTH_MS);
      return;
    }
    if (next.action === 'ease-track') {
      // nextOrientation only returns ease-track when trackAvailable, which is
      // exactly the condition under which cogDeg is non-null.
      if (fix?.cogDeg != null) easeBearing(fix.cogDeg, EASE_TRACK_MS, true);
      return;
    }
    // reject (decision 4): no camera change, but never a silent no-op — a
    // 300 ms pulse for sighted users and a live-region status for everyone
    // else. The button stays enabled so it remains discoverable.
    setPulseSeq((n) => n + 1);
    setStatusText(t('map.compass.unavailableStatus'));
    window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = window.setTimeout(() => setStatusText(''), COMPASS_STATUS_MS);
  }, [mode, trackAvailable, fix, easeBearing, applyMode, t]);

  const visual = orientationVisual(mode, stale);

  return (
    <div className="compass-control">
      <Button
        variant="ghost"
        className="compass-btn"
        data-orientation={visual}
        aria-label={t(compassLabelKey(visual, trackAvailable))}
        onClick={handleTap}
      >
        {/* NEEDLE-ONLY, by the #155 design pass's own pre-agreed fallback. The
            design carried a rotating "N" at 6.5 viewBox units (~7 px as
            rendered) and made it conditional on a real-browser legibility
            check. It failed: captured at 1 device pixel per CSS px and
            magnified nearest-neighbour, the glyph is an unresolvable blob (its
            diagonal cannot be drawn in ~5 px), while the two-tone needle reads
            cleanly. So the glyph is dropped, the freed room goes to the
            needle, and "north" is carried by the aria-label — which names the
            orientation in words for every user, sighted or not. */}
        <svg className="compass-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          {/* Static bezel — screen-fixed, so it reads as chrome around the
              rotating card rather than as compass marks. */}
          <circle className="compass-ring" cx="12" cy="12" r="11" />
          <line className="compass-tick" x1="12" y1="1" x2="12" y2="2.6" />
          <line className="compass-tick" x1="23" y1="12" x2="21.4" y2="12" />
          <line className="compass-tick" x1="12" y1="23" x2="12" y2="21.4" />
          <line className="compass-tick" x1="1" y1="12" x2="2.6" y2="12" />
          {/* Rotating card. Symmetric about the pivot so the needle looks
              balanced at every bearing. */}
          <g className="compass-needle" ref={needleRef}>
            <path className="compass-needle-n" d="M12 3.4 L15.6 12 L8.4 12 Z" />
            <path className="compass-needle-s" d="M12 20.6 L15.6 12 L8.4 12 Z" />
          </g>
        </svg>
        {pulseSeq > 0 && <span key={pulseSeq} className="compass-pulse" aria-hidden="true" />}
      </Button>
      {/* Ineligible-tap announcement. Empty between announcements so the same
          message announced twice in a row still reaches the user. */}
      <div className="sr-only" role="status">
        {statusText}
      </div>
    </div>
  );
}
