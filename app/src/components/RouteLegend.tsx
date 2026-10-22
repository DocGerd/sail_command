import { useState } from 'react';
import { useLang, useT } from '../i18n';
import { usePersistedToggle } from '../lib/usePersistedToggle';
import { formatSeaStateM, SEA_STATE_BAND_KEY, SHADED_BANDS, type ShadedBand } from '../lib/waveMap';
import { SEA_STATE_EDGES_M } from '../lib/waves';
import type { Lang } from '../lib/format';

// Metre range per WMO band, from the classifier's own edges.
function bandRange(band: ShadedBand, t: ReturnType<typeof useT>, lang: Lang): string {
  const m = (v: number) => formatSeaStateM(v, lang, 2);
  switch (band) {
    case 'calm':
      return t('route.legend.seaStateBelow', { max: m(SEA_STATE_EDGES_M.smooth) });
    case 'smooth':
      return t('route.legend.seaStateRange', {
        min: m(SEA_STATE_EDGES_M.smooth),
        max: m(SEA_STATE_EDGES_M.slight),
      });
    case 'slight':
      return t('route.legend.seaStateRange', {
        min: m(SEA_STATE_EDGES_M.slight),
        max: m(SEA_STATE_EDGES_M.moderate),
      });
    case 'moderate':
      return t('route.legend.seaStateRange', {
        min: m(SEA_STATE_EDGES_M.moderate),
        max: m(SEA_STATE_EDGES_M.rough),
      });
    case 'rough':
      return t('route.legend.seaStateAbove', { min: m(SEA_STATE_EDGES_M.rough) });
  }
}

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
// unconditionally, not gated on the toggle's own state.
export default function RouteLegend({
  hasForcedLeg,
  hasHandover,
  hasWaveGrid,
}: {
  hasForcedLeg: boolean;
  hasHandover: boolean;
  hasWaveGrid: boolean;
}) {
  const t = useT();
  const [lang] = useLang();
  // Reader only; RouteLayer owns the toggle row (#1699).
  const [wavesVisible] = usePersistedToggle('sc-waves-visible', true);
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
      {wavesVisible && hasWaveGrid && (
        <div className="route-legend-depth route-legend-sea-state">
          <p className="route-legend-subheading">{t('route.legend.seaStateHeading')}</p>
          {SHADED_BANDS.map((band) => (
            <p key={band} className="depth-legend-row">
              <span
                className={`route-legend-swatch route-legend-sea route-legend-sea-${band}`}
                aria-hidden="true"
              />
              {`${t(SEA_STATE_BAND_KEY[band])}: ${bandRange(band, t, lang)}`}
            </p>
          ))}
          <p>{t('route.legend.seaStateNoData')}</p>
          <p className="depth-legend-row">
            <svg
              className="route-legend-swatch route-legend-sea-arrow"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path d="M8 1.6 L12 7.2 L9.1 7.2 L9.1 14.4 L6.9 14.4 L6.9 7.2 L4 7.2 Z" />
            </svg>
            {t('route.legend.seaStateArrow')}
          </p>
          <p>{t('route.legend.seaStateCaveat')}</p>
        </div>
      )}
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
        {hasHandover && (
          <li>
            <span className="route-legend-swatch route-legend-handover" aria-hidden="true" />
            {t('route.legend.handover')}
          </li>
        )}
      </ul>
      {hasForcedLeg && <p className="route-legs-note">{t('route.legs.forcedNote')}</p>}
    </details>
  );
}
