import { useEffect, useRef, useState } from 'react';
import { useMapInstance } from './MapView';
import { useLang, useT } from '../i18n';
import { haversineNm } from '../lib/geo';
import {
  SCALE_LIFT_GAP_PX,
  SCALE_LIFT_MAX_VIEWPORT_FRACTION,
  SCALE_SAMPLE_PX,
  pickScaleBar,
  scaleUnitAbbrevKey,
  scaleUnitWordKey,
  type ScaleBarStep,
} from '../lib/mapOrientation';

/**
 * #155: passive nautical scale indicator, bottom-left of the map.
 *
 * Bearing-invariant by construction — the span is measured across the middle
 * of the canvas in SCREEN space, so a rotated chart changes nothing. Unit
 * selection (NM / cables / metres) lives in `lib/mapOrientation.ts`; this
 * component only measures, formats and writes the DOM.
 *
 * `pointer-events: none` (app.css): the bar must never swallow a map tap.
 */
export default function ScaleBar() {
  const map = useMapInstance();
  const [lang] = useLang();
  const t = useT();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);

  // The aria-label is the ONLY part of the bar in React state, and it is only
  // rewritten on moveend — a live region rewritten at pan/zoom frame rate is
  // screen-reader spam. The visible label and bar width are written straight
  // to the DOM under rAF instead.
  const [ariaText, setAriaText] = useState('');
  // null = nothing docked over the corner, so the stylesheet's own bottom
  // offset (tab strip + gap, or the map's bottom edge on wide) applies.
  const [liftPx, setLiftPx] = useState<number | null>(null);
  const [suppressed, setSuppressed] = useState(false);

  // `useT()` returns a fresh closure every render, so it can never be an
  // effect dependency. This sync effect is declared BEFORE the map effect, so
  // on a language change the ref is already current when the map effect
  // (keyed on `lang`) re-runs and repaints.
  const formatRef = useRef<(step: ScaleBarStep) => { label: string; aria: string }>(() => ({
    label: '',
    aria: '',
  }));
  useEffect(() => {
    formatRef.current = (step) => ({
      // Every rung is an integer across the app's reachable zoom range (1-2-5
      // per decade in whichever unit is being labelled), so there is no
      // decimal separator to localise here.
      label: `${step.value} ${t(scaleUnitAbbrevKey(step.unit))}`,
      aria: t('map.scale.aria', {
        distance: step.value,
        unit: t(scaleUnitWordKey(step.unit, step.value)),
      }),
    });
  });

  useEffect(() => {
    if (!map) return;
    let raf = 0;
    let last: ScaleBarStep | null = null;

    const measure = () => {
      const canvas = map.getCanvas();
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      const half = SCALE_SAMPLE_PX / 2;
      const a = map.unproject([cx - half, cy]);
      const b = map.unproject([cx + half, cy]);
      const maxNm = haversineNm({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng });
      const step = pickScaleBar(maxNm, SCALE_SAMPLE_PX);
      // A degenerate viewport (zero-sized canvas mid-resize) keeps the last
      // honest bar rather than painting a NaN one.
      if (!step) return;
      last = step;
      if (barRef.current) barRef.current.style.width = `${step.widthPx.toFixed(1)}px`;
      if (labelRef.current) labelRef.current.textContent = formatRef.current(step).label;
    };
    const schedule = () => {
      if (raf === 0)
        raf = requestAnimationFrame(() => {
          raf = 0;
          measure();
        });
    };
    const onMoveEnd = () => {
      measure();
      if (last) setAriaText(formatRef.current(last).aria);
    };

    measure();
    if (last) setAriaText(formatRef.current(last).aria);
    map.on('move', schedule);
    map.on('resize', schedule);
    map.on('moveend', onMoveEnd);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      map.off('move', schedule);
      map.off('resize', schedule);
      map.off('moveend', onMoveEnd);
    };
  }, [map, lang]);

  // ---- narrow-layout occlusion rule ----
  // On narrow, the Live tab docks its readout (`.live-view`) or its no-plan
  // card (`.live-view-no-plan`) over exactly this corner — the corner a sailor
  // wants the scale in. Lift the bar clear of whichever is docked, and
  // suppress it outright once that lift would push it past
  // SCALE_LIFT_MAX_VIEWPORT_FRACTION of the viewport (a half-screen readout
  // would otherwise strand the bar in the middle of the chart).
  //
  // The lift is measured to the occluder's TOP EDGE (`host.offsetHeight -
  // el.offsetTop`), NOT its height: the two cards dock at different bottom
  // offsets of their own, so lifting by height alone left the bar overlapping
  // the no-plan card by ~20 px (measured in the browser). offsetTop/
  // offsetHeight rather than getBoundingClientRect because the docked card is
  // absolutely positioned against this very host, which makes offsetTop
  // exactly "distance from the host's top".
  //
  // NAMED COUPLING with LiveView.tsx: those two class names are the docked
  // readout's two shapes. On the wide layout LiveView portals both into the
  // panel column (#31), so they are not children of MapView's wrapper at all
  // and the query finds nothing — which is exactly the wanted behaviour, and
  // why this needs no layout prop. The MutationObserver catches the
  // mount/unmount and the readout <-> no-plan swap; the ResizeObserver catches
  // the readout growing as GPS data arrives.
  useEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host) return;
    const canObserveResize = typeof ResizeObserver === 'function';
    let ro: ResizeObserver | null = null;

    const measureOccluder = (el: HTMLElement | null) => {
      if (!el) {
        setLiftPx(null);
        setSuppressed(false);
        return;
      }
      const lift = host.offsetHeight - el.offsetTop;
      setLiftPx(lift);
      setSuppressed(lift > window.innerHeight * SCALE_LIFT_MAX_VIEWPORT_FRACTION);
    };
    const rewire = () => {
      ro?.disconnect();
      ro = null;
      const el = host.querySelector<HTMLElement>('.live-view, .live-view-no-plan');
      measureOccluder(el);
      if (el && canObserveResize) {
        ro = new ResizeObserver(() => measureOccluder(el));
        ro.observe(el);
      }
    };

    rewire();
    const mo = new MutationObserver(rewire);
    mo.observe(host, { childList: true });
    return () => {
      mo.disconnect();
      ro?.disconnect();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={`scale-bar${suppressed ? ' scale-bar-suppressed' : ''}`}
      /* NAMED COUPLING: SCALE_LIFT_GAP_PX mirrors the `0.5rem` breathing space
         in .scale-bar's own stylesheet offset (app.css). Written inline rather
         than through a custom property because it REPLACES that offset
         wholesale — the docked card already clears the tab strip, so the base
         `var(--sc-tabbar-h)` term must not be added on top of it. */
      style={liftPx === null ? undefined : { bottom: `${liftPx + SCALE_LIFT_GAP_PX}px` }}
      role="img"
      aria-label={ariaText}
    >
      <span ref={labelRef} className="scale-bar-label" />
      {/* Classic chart bracket: a bottom-open ⊔ whose inner width IS the
          labelled ground distance. */}
      <div ref={barRef} className="scale-bar-bracket" />
    </div>
  );
}
