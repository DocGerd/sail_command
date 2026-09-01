import { useT } from '../i18n';

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
      {/* #813: folded-in #598 depth-hatch legend — a plain wrapper (never
          `.depth-legend-body`, which also carries that file's free-floating
          pill's own width/height clamps, meaningless inside this wide,
          unconstrained panel) sharing only the row/swatch classes that are
          already ancestor-independent. */}
      <div className="route-legend-depth">
        <p className="route-legend-subheading">{t('route.legend.depthHeading')}</p>
        <p className="depth-legend-row">
          <span className="depth-legend-swatch" aria-hidden="true" />
          {t('map.depth.legend.hatchLabel')}
        </p>
        <p>{t('map.depth.legend.basis')}</p>
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
