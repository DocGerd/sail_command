import { useLang, useT } from '../i18n';
import {
  formatSeaStateM,
  SEA_STATE_BAND_KEY,
  SHADED_BANDS,
  WAVE_LATTICE_MID_LAT,
  WAVE_LATTICE_STEP_DEG,
  type ShadedBand,
} from '../lib/waveMap';
import { SEA_STATE_EDGES_M } from '../lib/waves';
import type { Lang } from '../lib/format';

// Metre range per WMO band, from the classifier's own edges.
function bandRange(band: ShadedBand, t: ReturnType<typeof useT>, lang: Lang): string {
  const m = (v: number) => formatSeaStateM(v, lang);
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

const KM_PER_DEG_LAT = 111.32;

// #1854: a cell's footprint from the fetch lattice's step at its mid-latitude.
function cellSizeLine(t: ReturnType<typeof useT>, lang: Lang): string {
  const n = (v: number) => new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'en-GB').format(v);
  const nsKm = WAVE_LATTICE_STEP_DEG * KM_PER_DEG_LAT;
  const ewKm = nsKm * Math.cos((WAVE_LATTICE_MID_LAT * Math.PI) / 180);
  return t('route.legend.seaStateCells', {
    step: n(WAVE_LATTICE_STEP_DEG),
    ew: n(Math.round(ewKm)),
    ns: n(Math.round(nsKm)),
    lat: n(Math.round(WAVE_LATTICE_MID_LAT)),
  });
}

// #1854: the sea-state key, shared by RouteLegend and the Wetter card.
export default function SeaStateLegend() {
  const t = useT();
  const [lang] = useLang();
  return (
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
      <p className="depth-legend-row">
        <svg
          className="route-legend-swatch route-legend-sea-dot"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <circle className="route-legend-sea-dot-halo" cx="8" cy="8" r="2.75" />
          <circle cx="8" cy="8" r="2.75" />
        </svg>
        {t('route.legend.seaStateMarker')}
      </p>
      <p>{cellSizeLine(t, lang)}</p>
      <p>{t('route.legend.seaStateCaveat')}</p>
    </div>
  );
}
