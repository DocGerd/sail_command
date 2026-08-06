import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';

const STEP_PX = 16;
const STEP_PX_COARSE = 64;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export interface PanelResizerProps {
  /** The grid item whose rendered width IS the value being controlled —
      measured (never assumed) for the current `aria-valuenow` and as the
      drag-start reference, so this stays correct whether or not a width has
      ever been explicitly committed. */
  panelRef: RefObject<HTMLElement | null>;
  /** The element carrying the `--sc-panel-w` custom property that actually
      drives the grid column (`.app-shell`) — written to directly during a
      live drag, bypassing React state, so dragging never re-renders the
      panel subtree underneath it (only `onCommit`, fired once per gesture,
      touches React state). */
  targetRef: RefObject<HTMLElement | null>;
  min: number;
  max: number;
  /** Fires once per committed change: on pointerup (only if the pointer
      actually moved — see the handler's own comment), on each keyboard
      step, and on a reset (double-click or Enter). Never fires mid-drag.
      `null` means "reset to the CSS default" (#355: clears the stored
      override). */
  onCommit: (next: number | null) => void;
  'aria-label': string;
}

/**
 * #355: the resizable-panel drag handle, joining the Button/Card/Chip/
 * Disclosure/Field/NumberInput/Skeleton primitive set. New rather than a
 * `NumberInput` extension — `NumberInput` supplies a clamp worth copying but
 * delegates all keyboard stepping to the native `<input type="number">`,
 * and there is no other reusable value-step interaction in this codebase to
 * build on (design doc for #355, verified against the primitive set).
 *
 * WAI-ARIA APG "Window Splitter" pattern: `role="separator"` (NOT a plain
 * decorative separator — the value attributes below are what make this the
 * interactive variant) with `aria-orientation`, `aria-valuenow/min/max`, and
 * `tabIndex={0}` for keyboard reachability. Keyboard: ArrowLeft/ArrowRight
 * step by STEP_PX, Shift+Arrow by STEP_PX_COARSE, Home/End jump to the
 * bounds, Enter (or double-click) resets to the CSS default (`null`) — the
 * only escape hatch if a user drags to an extreme and loses the handle off
 * one edge of the panel.
 *
 * Pointer Events with `setPointerCapture`, not mouse events: capture is what
 * keeps the drag alive once the pointer crosses onto the MapLibre canvas,
 * which would otherwise steal it (MapView.tsx has its own click/drag
 * handling on the map surface). `touch-action: none` (app.css) stops touch
 * scroll from cancelling the pointer stream; `preventDefault` on pointerdown
 * suppresses text selection while dragging.
 *
 * Live-drag writes go straight to `targetRef.current.style`, coalesced to
 * one write per animation frame — never through React state, and this
 * component adds NO `ResizeObserver`/`map.resize()`/window `resize` call of
 * its own for the MAP. (It DOES use a `ResizeObserver` on `panelRef` below,
 * but that watches the PANEL, never MapLibre's own container, so it cannot
 * double the map's resize handling.) MapView.tsx's own comment records that
 * MapLibre already backs `trackResize` with a `ResizeObserver` on its
 * container (confirmed still true against the installed maplibre-gl@6.1.0:
 * `ui/map.ts`'s `_setupResizeObserver`, which additionally throttles its own
 * resize+redraw to one call per 50ms) — a drag is that same container-resize
 * event stream at a higher rate, not a new code path.
 */
export default function PanelResizer({
  panelRef,
  targetRef,
  min,
  max,
  onCommit,
  'aria-label': ariaLabel,
}: PanelResizerProps) {
  // Real rendered width of the panel, kept in sync with a ResizeObserver.
  // Feeds ONLY `aria-valuenow` and the drag-start reference below — never
  // used to POSITION the resizer itself (that's plain CSS Grid, `grid-area:
  // resizer`, so there is no pre-paint POSITIONING-flash risk to guard
  // against here). That is narrower than "no flash at all": the PANEL'S
  // WIDTH is still JS-driven (App.tsx writes `--sc-panel-w`), and that has
  // its own pre-paint timing window — closed at THAT call site via
  // `useLayoutEffect` (see App.tsx's comment), not by anything in this
  // component. This effect's own value (`widthPx`) has no first-paint
  // stakes of its own — a stale `aria-valuenow`/drag-start reference for one
  // frame is not a visual defect — which is what makes `useEffect` (below)
  // the right choice here specifically, unlike App.tsx's write.
  //
  // `useEffect`, NOT `useLayoutEffect` — measured, not a style preference:
  // `panelRef` targets a SIBLING (`.app-bottom-sheet`), not a descendant.
  // React attaches a fiber's ref and runs ITS OWN layout effects as it
  // walks the committed tree in fiber (JSX) order — `<PanelResizer>` is
  // declared BEFORE `.app-bottom-sheet` in App.tsx, so at the moment a
  // `useLayoutEffect` here would run, `panelRef.current` was still `null`
  // (confirmed live: a real Chromium session read `panelRef.current ===
  // null` inside a `useLayoutEffect` version of this hook, while
  // `.app-bottom-sheet`'s own `getBoundingClientRect()` already reported the
  // correct ~637px — the DOM was right, the ref just hadn't been attached
  // yet at that point in the commit). Passive effects (`useEffect`) are
  // deferred until AFTER every layout effect and every ref attachment for
  // the WHOLE commit has completed, so they carry no such ordering
  // dependency on sibling declaration order. `useBannerHeight.ts` and
  // `ScaleBar.tsx` sidestep this class of bug entirely by
  // `document.querySelector`-ing their target rather than holding a ref to
  // a sibling — that's this repo's documented convention for measuring a
  // non-descendant element, and it was considered here too; an explicit
  // `panelRef` prop was kept instead because PanelResizer is a generic
  // primitive (its DOM target is a caller concern, not a class name it
  // should know about), and `useEffect` closes the actual bug without
  // giving that up.
  // Seeded from `min`, not `0` — `0` is out of range against
  // `aria-valuemin={min}` (320 by default), so a screen reader that reads
  // the separator's value before the first `ResizeObserver` callback fires
  // (a real, if narrow, ~20ms window measured live) would see an invalid
  // value. `min` is always a legal value for the eventual real width to
  // clamp toward, so it is never itself misleading the way `0` was.
  const [widthPx, setWidthPx] = useState(min);

  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    // `getBoundingClientRect()` in BOTH the initial read and the ongoing
    // observer callback (rather than the observer's own `contentRect`,
    // which is the CONTENT box, excluding padding/border) — one measurement
    // semantic throughout, so `aria-valuenow`, the drag-start reference, and
    // the border-box grid-track width being resized can never quietly drift
    // apart from each other by whatever padding/border the panel carries.
    const write = () => setWidthPx(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(write);
    ro.observe(el);
    write();
    return () => ro.disconnect();
  }, [panelRef]);

  const rafRef = useRef(0);
  const dragRef = useRef<{ startX: number; startWidth: number; startCssVar: string } | null>(null);
  // The keyboard-step base of record, separate from `widthPx` above. `null`
  // until the first commit; falls back to the RO-measured `widthPx` only
  // before that. `handleKeyDown` closes over `widthPx` (React STATE) to
  // compute each step — on OS key-repeat, ArrowRight can fire again before
  // React has committed the PREVIOUS step's re-render, so a second handler
  // invocation reading `widthPx` sees the SAME pre-step value and computes
  // the identical target, collapsing N rapid presses into one net step
  // (measured live: two fast ArrowRights moved the panel by one 16px step,
  // not two). `committedRef` is written SYNCHRONOUSLY by every commit path
  // below (never by the ResizeObserver — a RO write racing a keyboard
  // commit could otherwise clobber a just-applied newer value with a
  // stale-by-one-tick DOM measurement, the same class of bug one step
  // narrower), so the very next handler invocation — however soon — reads
  // the value THIS invocation just committed. `Home`/`End` don't need it
  // (they target `min`/`max` directly, not a delta from the current value)
  // and a live drag re-measures fresh at pointerdown, so neither shares
  // this path. Reset clears it back to `null`, returning the base to
  // whatever the panel measures once the CSS default takes back over.
  //
  // Accepted residual: if `min`/`max` shrink externally (a viewport resize)
  // after a commit, `committedRef` can sit above the new `max` until the
  // next keyboard step — that step computes from the stale-high base but
  // is immediately clamped by the CURRENT `min`/`max` props, so the result
  // is always in range; the only visible effect is a larger-than-one-step
  // jump on that one keypress, not an out-of-bounds value.
  const committedRef = useRef<number | null>(null);

  const writeLive = useCallback(
    (px: number) => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        targetRef.current?.style.setProperty('--sc-panel-w', `${px}px`);
      });
    },
    [targetRef],
  );

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // A FRESH measurement, not the (possibly stale-by-one-ResizeObserver-
    // tick) `widthPx` state — the panel could have resized for an unrelated
    // reason (a banner appearing, a viewport change) between the last
    // observer callback and this pointerdown.
    const startWidth = Math.round(panelRef.current?.getBoundingClientRect().width ?? widthPx);
    // The `--sc-panel-w` inline value as it stood BEFORE this drag touches
    // it — captured so a zero-movement drag (see `endDrag`) can put it back
    // exactly, rather than leaving behind whatever `writeLive` wrote for an
    // intermediate (never-committed) pointer position.
    const startCssVar = targetRef.current?.style.getPropertyValue('--sc-panel-w') ?? '';
    dragRef.current = { startX: e.clientX, startWidth, startCssVar };
    e.preventDefault();
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    writeLive(clamp(drag.startWidth + (e.clientX - drag.startX), min, max));
  };

  // The single writer of `committedRef` — every commit path (drag end,
  // keyboard step, Home/End) goes through this, so the very next handler
  // invocation always reads back what THIS one just committed rather than a
  // stale measurement (see `committedRef`'s own comment above).
  const commit = (next: number) => {
    const clamped = clamp(next, min, max);
    committedRef.current = clamped;
    onCommit(clamped);
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    cancelAnimationFrame(rafRef.current);
    const dx = e.clientX - drag.startX;
    // A zero-movement pointerdown->pointerup (a plain click) must NOT
    // commit. Without this guard, a stray click on the seam persists an
    // explicit px override equal to whatever the default happened to
    // measure — silently converting the responsive `1fr` default into a
    // fixed width that stops reflowing with the window, with no drag having
    // actually happened.
    if (dx === 0) {
      // MEASURED bug (not merely a theoretical one): `handlePointerMove`
      // may already have called `writeLive` for an intermediate pointer
      // position before the pointer returned to its start x — that write
      // landed on `targetRef.current.style` directly, bypassing React
      // state, and skipping `commit()` here left it there. Restore exactly
      // what was on the property before this drag touched it (captured at
      // pointerdown), not a value derived from `committedRef`/React state —
      // this component doesn't know whether the TRUE current value is "no
      // override" (a persisted width from a PREVIOUS session that this
      // component instance never itself committed) or a real number, so
      // "undo my own uncommitted write" is the only thing it can do
      // correctly without that knowledge.
      const target = targetRef.current;
      if (target) {
        if (drag.startCssVar === '') target.style.removeProperty('--sc-panel-w');
        else target.style.setProperty('--sc-panel-w', drag.startCssVar);
      }
      return;
    }
    commit(drag.startWidth + dx);
  };

  const reset = () => {
    committedRef.current = null;
    onCommit(null);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const step = e.shiftKey ? STEP_PX_COARSE : STEP_PX;
        const delta = e.key === 'ArrowRight' ? step : -step;
        commit((committedRef.current ?? widthPx) + delta);
        e.preventDefault();
        break;
      }
      case 'Home':
        commit(min);
        e.preventDefault();
        break;
      case 'End':
        commit(max);
        e.preventDefault();
        break;
      case 'Enter':
        reset();
        e.preventDefault();
        break;
      default:
        break;
    }
  };

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={widthPx}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={reset}
    />
  );
}
