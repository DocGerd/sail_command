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
  bearingReached,
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

  // #203. The bearing this component last COMMANDED the camera to, held until
  // a settle reconciles it against `map.getBearing()`; null means the compass
  // is asserting nothing and the camera is simply wherever the map says.
  //
  // This replaces the boolean "am I easing" flag #155 shipped. That flag was
  // cleared by ANY moveend, and MapLibre suppresses an interrupted ease's
  // moveend only when the interrupting easeId MATCHES — so every FOREIGN ease
  // (pan inertia, keyboard rotation, a plan-change fitBounds) cleared it and
  // the controller mistook its own animation for a hand rotation. A target
  // bearing reconciled against the camera cannot be corrupted that way: it is
  // derived from the source of truth instead of tracked alongside it.
  const commandedBearingRef = useRef<number | null>(null);

  // True ONLY for the synchronous extent of our own map.easeTo() call.
  // `easeTo`'s first statement is `this._stop(false, options.easeId)`
  // (maplibre-gl-dev.js:69468), which runs the INTERRUPTED ease's `_afterEase`
  // inline — so any rotateend/moveend delivered inside this window describes
  // the camera we are REPLACING, not ours, and must not be reconciled against
  // our brand-new target.
  const inOwnEaseCallRef = useRef(false);

  const easeBearing = useCallback(
    (bearingDeg: number, durationMs: number, linear = false) => {
      if (!map) return;
      commandedBearingRef.current = bearingDeg;
      inOwnEaseCallRef.current = true;
      try {
        map.easeTo({
          bearing: bearingDeg,
          duration: reducedMotionRef.current ? 0 : durationMs,
          // COMPASS_EASE_ID keeps one compass ease from cancelling the next
          // one's start/end bookkeeping: `_afterEase` suppresses the
          // interrupted ease's rotateend/moveend only when the ids MATCH
          // (maplibre-gl-dev.js:69671), so a chained follow ease or a fast
          // double-tap emits no spurious settle at all. It does NOT help
          // against a foreign ease — the id will not match one we do not own —
          // which is why the settle path below reconciles against the camera
          // instead of trusting any single event (#203).
          easeId: COMPASS_EASE_ID,
          // Linear for the track-up follow only: consecutive ~900 ms eases at
          // the ~1 Hz fix cadence chain into continuous motion, where an
          // ease-in-out would visibly stutter at every fix boundary.
          ...(linear ? { easing: (x: number) => x } : {}),
        });
      } finally {
        inOwnEaseCallRef.current = false;
      }
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
    // The manual-rotation signal, and the whole of it (#203): MapLibre stamps
    // `originalEvent` onto the rotate events a USER caused, and onto nothing
    // else. Gesture rotation goes through HandlerManager, whose
    // `mergeHandlerResult` records `originalEvent: handlerResult.originalEvent
    // || e` (:68533) and re-fires it on both `rotatestart` and every `rotate`
    // (:68659-68677); MapLibre's own keyboard rotation calls
    // `easeTo({ easeId: 'keyboardHandler', ... }, { originalEvent: e })`
    // (:67349), so its frames carry it too; rotate inertia is
    // `easeTo(inertialEase, { originalEvent: originalEndEvent })` (:68712) —
    // the continuation of the user's flick, and correctly counted as theirs.
    // A camera animation started by THIS app (or by RouteLayer's fitBounds)
    // passes no eventData at all, so its frames carry none.
    //
    // #155 additionally gated `rotate` on an "am I easing" boolean because it
    // believed keyboard rotation carried no originalEvent. The MapLibre source
    // above says otherwise, and that gate is precisely what a foreign ease's
    // moveend cleared mid-flight — turning our OWN follow animation into a
    // phantom hand rotation and dropping track-up to free (#203 F2). Both
    // events are checked, earliest wins, so a gesture is still caught on the
    // very first frame.
    const onUserRotation = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent !== undefined) dropToFree();
    };
    const onRotate = (e: { originalEvent?: unknown }) => {
      schedulePaint();
      onUserRotation(e);
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
    // #203: reconcile the CLAIMED orientation against the camera every time
    // the map comes to rest. `north` is the only mode with a fixed target, so
    // it is the only one that can be caught lying — and it is the mode a
    // half-finished ease strands, because nothing else ever re-asserts 0.
    // `track` deliberately holds: the follow loop re-eases on the next fix,
    // and a held bearing with no fix is the documented stale behaviour, not a
    // desync (#155 decision 1).
    const onMoveEnd = () => {
      // Delivered from inside our own easeTo: this is the ease we just
      // replaced coming to rest, describing the OLD camera.
      if (inOwnEaseCallRef.current) return;
      // A camera animation is still running (ours, or one that started inside
      // our rotateend snap) — the target may yet be reached, so judging the
      // claim now would demote on a bearing that is still in motion.
      if (map.isEasing()) return;
      commandedBearingRef.current = null;
      if (modeRef.current === 'north' && !bearingReached(map.getBearing(), 0)) {
        // The chart is not north-up and no longer heading there. Falling to
        // `free` is the honest reading — and it is what makes the next tap an
        // `ease-north` instead of the `reject` dead end of #203 F1.
        applyMode('free');
      }
    };

    paint();
    map.on('rotate', onRotate);
    map.on('rotatestart', onUserRotation);
    map.on('rotateend', onRotateEnd);
    map.on('moveend', onMoveEnd);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      map.off('rotate', onRotate);
      map.off('rotatestart', onUserRotation);
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
    // What the compass currently CLAIMS the bearing is: its outstanding ease
    // target while one is in force (a second tap inside a 600 ms reset-north
    // must still read as "we are north-up" and advance to track-up), otherwise
    // the live camera. With no map there is nothing to assert and nothing to
    // move, and `reject` is the correct outcome either way.
    const asserted = commandedBearingRef.current ?? map?.getBearing() ?? 0;
    const next = nextOrientation(mode, trackAvailable, asserted);
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
  }, [map, mode, trackAvailable, fix, easeBearing, applyMode, t]);

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
