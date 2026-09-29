import { useState } from 'react';
import { useT } from '../i18n';
import { usePersistedToggle } from '../lib/usePersistedToggle';

// Collapsible map legend for the route overlay, mounted inside
// `.route-layer-controls` (only while a plan is active). Explanations and
// swatches only: the hatch and contour toggles are top-level rows of
// RouteLayer's "Anzeigeoptionen" (#1541).
//
// While a plan is active this is the sole "Legende" surface; without one it
// never mounts and DataLayers.tsx's `.depth-legend` carries the #597 caveat.
// The depth copy reuses the `map.depth.legend.*` keys verbatim so that
// sentence survives byte-for-byte.
//
// On a narrow layout this sits inside RouteLayer's outer disclosure, which
// starts closed there. To avoid a second closed `<details>` ancestor above
// the #597 caveat it starts OPEN on narrow (#813). The value is read once at
// mount rather than as a live `open` prop, which React would treat as
// controlled and re-force on every layout crossing; `useWideLayout` is not
// used because its `change` subscription collides with RouteLayer.test.tsx's
// single-listener `MediaQueryList` fake. The query text is a literal twin of
// `useWideLayout.ts`'s.
function isWideAtMount(): boolean {
  return (
    typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches
  );
}

// Swatch colors mirror the live paint expressions: sail lines #009E73/#D55E00
// and the #5b5b5b dashed motor line (RouteLayer.tsx), the white maneuver circle,
// and the #CC79A7 via marker (ViaMarkers.tsx). The alt-rig entry (#324) mirrors
// sc-route-alt-{sail,motor}'s dashed/reduced-opacity paint — shown
// unconditionally like the others, not gated on the toggle's own state.
export default function RouteLegend({ hasForcedLeg }: { hasForcedLeg: boolean }) {
  const t = useT();
  // Readers only: DataLayers.tsx applies these flags to the map, and the
  // rows that change them live in RouteLayer.
  const [hatchVisible] = usePersistedToggle('sc-depth-hatch-visible', true);
  const [depthVisible] = usePersistedToggle('sc-depth-visible', true);
  const [contoursVisible] = usePersistedToggle('sc-contours-visible', false);
  const [defaultOpen] = useState(() => !isWideAtMount());
  return (
    <details className="route-legend" open={defaultOpen}>
      <summary>{t('route.legend.title')}</summary>
      <div className="route-legend-depth">
        <p className="route-legend-subheading">{t('route.legend.depthHeading')}</p>
        {/* #839: hatch entries only while the hatch is on the map, the same
            `depthVisible && hatchVisible` composite as the layer. */}
        {depthVisible && hatchVisible && (
          <p className="depth-legend-row">
            <span className="depth-legend-swatch" aria-hidden="true" />
            {t('map.depth.legend.hatchLabel')}
          </p>
        )}
        {depthVisible && hatchVisible && <p>{t('map.depth.legend.basis')}</p>}
        <p>{t('map.depth.legend.caveat')}</p>
        {contoursVisible && (
          <>
            <p className="depth-legend-row">
              <span
                className="depth-legend-swatch depth-legend-swatch-contour"
                aria-hidden="true"
              />
              {t('map.depth.legend.contourLinesLabel')}
            </p>
            <p className="depth-legend-row">
              <span className="depth-legend-swatch depth-legend-swatch-nodata" aria-hidden="true" />
              {t('map.depth.legend.contourNoDataLabel')}
            </p>
          </>
        )}
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
      {hasForcedLeg && <p className="route-legs-note">{t('route.legs.forcedNote')}</p>}
    </details>
  );
}
