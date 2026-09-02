import { useState } from 'react';
import { useT } from '../i18n';
import { usePersistedToggle } from '../lib/usePersistedToggle';

// Collapsible map legend for the route overlay, mounted inside
// `.route-layer-controls` (only while a plan is active). Default-collapsed —
// cockpit pixels are expensive. Its own component so RouteLayer's diff stays a
// single mount line (Task B rewrites RouteLayer heavily).
//
// #813: this disclosure is now the SOLE "Legende"/"Legend" surface once a
// plan is active — it also carries DataLayers.tsx's #598 depth-hatch legend
// content, folded in under its own sub-heading below. Before #813 the app
// showed TWO simultaneous disclosures with the identical accessible name
// (this one, plus DataLayers.tsx's free-floating `.depth-legend`), describing
// related-but-separate hazard cues (the #492 hatch and the #53 shallow-leg
// casing below) in near-duplicate wording — a user couldn't tell whether they
// meant the same thing or two different things. Fix shape: COMPLEMENTARY, not
// merged into one shared DOM location — DataLayers.tsx now suppresses its own
// `.depth-legend` disclosure entirely once a plan exists (see that file's own
// #813 comment), and its content moves HERE instead. The complementary half
// matters: with NO plan, THIS component never even mounts (RouteLayer.tsx
// returns null before reaching this file's own mount line), so
// DataLayers.tsx's `.depth-legend` is what keeps the #597 safety caveat
// reachable in that state — exactly one "Legende" disclosure exists at any
// time, never both, never neither. The depth-section copy below is reused
// VERBATIM from the `map.depth.legend.*` keys (unchanged, still also used by
// DataLayers.tsx) rather than re-authored, so the #597 sentence survives
// byte-for-byte.
//
// #813 fix-wave, MAJOR 1: on a NARROW layout this disclosure sits nested
// inside RouteLayer.tsx's OWN `#628` outer "Anzeigeoptionen" Disclosure,
// which defaults CLOSED there (`defaultOpen={isWide}`) — a wrapper
// `.depth-legend` never had to contend with (it was always a top-level,
// independent element). Left default-closed itself, that stacked TWO closed
// `<details>` ancestors above the #597 caveat on narrow where BASE had only
// ONE — content inside a closed `<details>` drops out of the accessibility
// tree entirely, so this was a real reachability regression on this app's
// primary (on-deck, phone) context, exactly what #813's own text says a fix
// must not cost ("must survive consolidation and stay reachable … fail
// open, toward being shown").
//
// Fix: default this disclosure OPEN on narrow, closed on wide (unchanged
// from its pre-#813 "cockpit pixels are expensive" default there) — this
// is the ONLY lever reachable from this file: RouteLayer.tsx mounts
// `<RouteLegend />` INSIDE its own outer Disclosure's body (not editable in
// this task's scope), so the outer wrapper's own closed-on-narrow default
// and its "Anzeigeoptionen" label are unchanged and still cost ONE closed
// ancestor on narrow — this restores parity with BASE's ancestor COUNT (1),
// not full independence from any wrapper at all.
//
// Computed ONCE at mount via a lazy `useState` initializer, deliberately NOT
// a live `open={!isWide}` prop recomputed every render: React treats a
// changing `open` value as CONTROLLED and would force the DOM attribute back
// on every narrow<->wide crossing, discarding a user's own manual toggle —
// the mirror image of the `Disclosure` primitive's documented
// `useState(defaultOpen)` seed-once trap (CLAUDE.md, #628) that never
// re-syncs at all. A stable value that never changes after mount is what
// keeps React from touching the DOM attribute again once rendered, letting
// native `<details>` toggling behave normally afterward.
//
// Deliberately NOT `lib/useWideLayout.ts`'s own hook: that hook subscribes
// to the media query's 'change' event (needed by RouteLayer.tsx's outer
// Disclosure, which DOES re-seed on a live rotation, #628 review Major 3) —
// this component only ever needs a ONE-TIME mount-time read, never a live
// resubscription, so importing the reactive hook here would be pure
// overhead with a real cost: MEASURED, it collides with
// RouteLayer.test.tsx's own `setMatchMedia` test helper, whose fake
// `MediaQueryList` supports exactly ONE registered 'change' listener via a
// single `let` variable (correct for jsdom/testing, since real
// `MediaQueryList.addEventListener` supports many) — a second subscriber
// from this component overwrites RouteLayer's own listener registration,
// silently breaking its `#628 review wave 4 Minor` rotation test. A raw,
// listener-free read sidesteps that entirely. The media-query STRING is
// therefore duplicated as a literal rather than imported (`useWideLayout.ts`
// does not export `WIDE_LAYOUT_QUERY`) — same accepted precedent as
// DataLayers.tsx's own `SHORT_LANDSCAPE_QUERY` literal; re-check this string
// against that module's own query text if either ever changes.
function isWideAtMount(): boolean {
  return (
    typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches
  );
}

// Swatch colors mirror the live paint expressions: sail lines #009E73/#D55E00
// and the #5b5b5b dashed motor line (RouteLayer.tsx), the white maneuver circle,
// and the #CC79A7 via marker (ViaMarkers.tsx). The heading-change dot entry
// names the annotation mark Task B (#37) renders; the coupling is copy-only, so
// the legend stands alone even before that PR merges. The alt-rig entry (#324)
// mirrors sc-route-alt-{sail,motor}'s dashed/reduced-opacity paint — shown
// unconditionally like the others (e.g. the motor swatch even on an all-sail
// route), not gated on the toggle's own state.
//
// #681 x #813: the folded-in depth section ALSO carries the independent
// hazard-hatch toggle (`sc-depth-hatch-visible`) plus the base ramp's own
// flag (`sc-depth-visible`, read here only for the `disabled` mirror) — the
// SAME two `usePersistedToggle` keys DataLayers.tsx's own `.depth-legend`
// checkbox uses. That hook now cross-instance-syncs (its own #681 x #813
// module comment): DataLayers.tsx stays the always-mounted component that
// actually applies `hatchVisible`/`depthVisible` to the map layer, in EITHER
// plan state, while this component and DataLayers.tsx's own legend are the
// two COMPLEMENTARY surfaces that OFFER the control — never both mounted at
// once, exactly like the legend disclosure itself. Without the sync, ticking
// this checkbox would write localStorage correctly but DataLayers.tsx's own
// React state (the one its layer-visibility effect reads) would only catch
// up on a future remount — the composition bug #681's review caught.
export default function RouteLegend() {
  const t = useT();
  const [hatchVisible, setHatchVisible] = usePersistedToggle('sc-depth-hatch-visible', true);
  const [depthVisible] = usePersistedToggle('sc-depth-visible', true);
  // #813 fix-wave MAJOR 1: see this file's own comment above `isWideAtMount`
  // for the full derivation. Lazy initializer -> read once at mount, never
  // re-read.
  const [defaultOpen] = useState(() => !isWideAtMount());
  return (
    <details className="route-legend" open={defaultOpen}>
      <summary>{t('route.legend.title')}</summary>
      {/* #813: folded-in #598 depth-hatch legend — a plain wrapper (never
          `.depth-legend-body`, which also carries that file's free-floating
          pill's own width/height clamps, meaningless inside this wide,
          unconstrained panel) sharing only the row/swatch classes that are
          already ancestor-independent. */}
      <div className="route-legend-depth">
        <p className="route-legend-subheading">{t('route.legend.depthHeading')}</p>
        {/* #839: same guard as DataLayers.tsx's own copy of this row (that
            file's own #839 comment carries the full rationale) — gated on
            the SAME `depthVisible && hatchVisible` composite the map layer
            itself uses (the #384 defect-class shape), never `hatchVisible`
            alone. */}
        {depthVisible && hatchVisible && (
          <p className="depth-legend-row">
            <span className="depth-legend-swatch" aria-hidden="true" />
            {t('map.depth.legend.hatchLabel')}
          </p>
        )}
        {/* #681 x #813: same control, same keys, same `disabled` mirror as
            DataLayers.tsx's own copy — see that file's return JSX for the
            full layout-budget derivation of why the control exists here at
            all (a third `.data-layer-controls` row was rejected). This is
            the surface that keeps it reachable once a plan is active, since
            DataLayers.tsx's own `.depth-legend` is suppressed in that state
            (#813, `plan === null` gate). */}
        <label className="depth-legend-row">
          <input
            type="checkbox"
            checked={hatchVisible}
            disabled={!depthVisible}
            onChange={(e) => setHatchVisible(e.target.checked)}
          />
          {t('map.depth.legend.hatchToggle')}
        </label>
        {/* #839: same composite guard as the hatchLabel row above — the
            #597 caveat below stays unconditional (a mask-coverage gap
            independent of the hatch toggle's own state). */}
        {depthVisible && hatchVisible && <p>{t('map.depth.legend.basis')}</p>}
        <p>{t('map.depth.legend.caveat')}</p>
      </div>
      <ul>
        <li>
          <span className="route-legend-swatch route-legend-line-starboard" aria-hidden="true" />
          {t('route.legend.sailStarboard')}
        </li>
        <li>
          <span className="route-legend-swatch route-legend-line-port" aria-hidden="true" />
          {t('route.legend.sailPort')}
        </li>
        <li>
          <span className="route-legend-swatch route-legend-line-motor" aria-hidden="true" />
          {t('route.legend.motor')}
        </li>
        <li>
          <span className="route-legend-swatch route-legend-maneuver" aria-hidden="true" />
          {t('route.legend.maneuver')}
        </li>
        <li>
          <span className="route-legend-swatch route-legend-heading" aria-hidden="true" />
          {t('route.legend.headingChange')}
        </li>
        <li>
          <span className="route-legend-swatch route-legend-via" aria-hidden="true" />
          {t('route.legend.via')}
        </li>
        <li>
          <span className="route-legend-swatch route-legend-shallow" aria-hidden="true" />
          {t('route.legend.shallow')}
        </li>
        <li>
          <span className="route-legend-swatch route-legend-alt-rig" aria-hidden="true" />
          {t('route.legend.altRig')}
        </li>
      </ul>
    </details>
  );
}
