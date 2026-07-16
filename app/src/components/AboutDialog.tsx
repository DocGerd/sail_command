import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { MaskMeta } from '../types';

export interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

// Mask-data provenance (EMODnet DTM citation + DOI, OSM/ODbL land polygons)
// comes from mask.meta.json's optional `sources` field (types.ts), fetched
// directly here on every dialog open — NOT via services/assets.ts's
// loadRoutingAssets(), which would force the ~5 MB routing bundle
// (mask.bin, both polars, harbors.json) to download just to open an About
// dialog. mask.meta.json alone is a few hundred bytes; the browser's own
// HTTP cache makes repeat opens cheap without any module-level caching here.
// Best-effort: a failed/older-build fetch just omits the dynamic sources —
// the static attributions below still render.
function fetchMaskSources(): Promise<string[] | undefined> {
  return fetch(`${import.meta.env.BASE_URL}data/mask.meta.json`)
    .then((res) => (res.ok ? (res.json() as Promise<MaskMeta>) : Promise.reject(new Error(`HTTP ${res.status}`))))
    // Minimal runtime validation rather than trusting the cast above: an
    // older/malformed mask.meta.json (or a fetch that resolved with the
    // wrong content entirely) must fall back to "no dynamic sources", not
    // hand a non-array through to the .map() render below.
    .then((meta) => (Array.isArray(meta.sources) ? meta.sources : undefined))
    .catch(() => undefined);
}

export default function AboutDialog({ open, onClose }: AboutDialogProps) {
  const t = useT();
  const [maskSources, setMaskSources] = useState<string[] | undefined>(undefined);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // The element focused right before the dialog opened — restored on close
  // so keyboard/screen-reader users land back where they were (the header's
  // ⓘ button in practice), rather than at the top of the document.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

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

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus();
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

        <button type="button" ref={closeButtonRef} onClick={onClose}>
          {t('about.close')}
        </button>
      </div>
    </div>
  );
}
