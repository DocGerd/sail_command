import { useT } from '../i18n';

// Collapsible map legend for the route overlay, mounted inside
// `.route-layer-controls` (only while a plan is active). Default-collapsed —
// cockpit pixels are expensive. Its own component so RouteLayer's diff stays a
// single mount line (Task B rewrites RouteLayer heavily).
//
// Swatch colors mirror the live paint expressions: sail lines #009E73/#D55E00
// and the #5b5b5b dashed motor line (RouteLayer.tsx), the white maneuver circle,
// and the #CC79A7 via marker (ViaMarkers.tsx). The heading-change dot entry
// names the annotation mark Task B (#37) renders; the coupling is copy-only, so
// the legend stands alone even before that PR merges. The alt-rig entry (#324)
// mirrors sc-route-alt-{sail,motor}'s dashed/reduced-opacity paint — shown
// unconditionally like the others (e.g. the motor swatch even on an all-sail
// route), not gated on the toggle's own state.
export default function RouteLegend() {
  const t = useT();
  return (
    <details className="route-legend">
      <summary>{t('route.legend.title')}</summary>
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
