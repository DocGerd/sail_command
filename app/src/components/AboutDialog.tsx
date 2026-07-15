import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { MaskMeta } from '../types';

export interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

// Mask-data provenance (EMODnet DTM citation + DOI, OSM/ODbL land polygons)
// comes from mask.meta.json's optional `sources` field (types.ts), fetched
// directly here on every dialog open — NOT via services/assets.ts's
// loadRoutingAssets(), which would force the full ~30-40 MB routing bundle
// (mask.bin, both polars, harbors.json) to download just to open an About
// dialog. mask.meta.json alone is a few hundred bytes; the browser's own
// HTTP cache makes repeat opens cheap without any module-level caching here.
// Best-effort: a failed/older-build fetch just omits the dynamic sources —
// the static attributions below still render.
function fetchMaskSources(): Promise<string[] | undefined> {
  return fetch(`${import.meta.env.BASE_URL}data/mask.meta.json`)
    .then((res) => (res.ok ? (res.json() as Promise<MaskMeta>) : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((meta) => meta.sources)
    .catch(() => undefined);
}

export default function AboutDialog({ open, onClose }: AboutDialogProps) {
  const t = useT();
  const [maskSources, setMaskSources] = useState<string[] | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchMaskSources().then((sources) => {
      if (!cancelled) setMaskSources(sources);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="about-dialog-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
        className="about-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="about-dialog-title">{t('about.title')}</h2>

        <p className="about-disclaimer">{t('app.disclaimer')}</p>

        <section>
          <h3>{t('about.caveats.heading')}</h3>
          <ul>
            <li>{t('about.caveats.polars')}</li>
            <li>{t('about.dataSize')}</li>
          </ul>
        </section>

        <section>
          <h3>{t('about.sources.heading')}</h3>
          <ul>
            <li>{t('about.sources.protomaps')}</li>
            <li>{t('about.sources.osm')}</li>
            <li>{t('about.sources.openMeteo')}</li>
            <li>{t('about.sources.polars')}</li>
            {maskSources?.map((s) => <li key={s}>{s}</li>)}
          </ul>
        </section>

        <button type="button" onClick={onClose}>
          {t('about.close')}
        </button>
      </div>
    </div>
  );
}
