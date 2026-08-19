import { useEffect, useRef, useState } from 'react';
// #131: repo-root CHANGELOG.md, baked into the bundle at build time by Vite's
// `?raw` static import — never fetched at runtime, so "What's new" works
// fully offline and always describes the exact bundle it ships in (same
// honesty rule as __SC_APP_VERSION__ above the disclosure). The dev server
// serves the out-of-root file via the vite.config.ts `server.fs.allow` entry.
import changelogRaw from '../../../CHANGELOG.md?raw';
// #189: changelog.d/*.md fragments — the conflict-free replacement for
// having every user-visible-behavior PR edit CHANGELOG.md's shared
// [Unreleased] section directly. Parsed Node-side by vite.config.ts's
// changelogFragmentsPlugin (never via a `?raw` glob — see that plugin's own
// comment for why), exposed as this virtual module's default export.
import fragmentsRaw from 'virtual:changelog-fragments';
import { useT, useLang } from '../i18n';
import { depthMaskCaveatVars } from '../lib/depthDisclosure';
import { parseChangelog } from '../lib/changelog';
import { assembleFragments, withPendingFragments } from '../lib/changelogFragments';
import type { BoatDef } from '../data/boats';
import type { MaskMeta } from '../types';
import ChangelogView from './ChangelogView';
import Disclosure from './Disclosure';

// Parsed once at module load — the content is a build-time constant. Pending
// fragments are folded into a synthetic 'Unreleased' preview so UAT
// (develop's unreleased state) keeps showing pending work even though no PR
// edits CHANGELOG.md directly anymore (#189).
const changelogReleases = withPendingFragments(
  parseChangelog(changelogRaw),
  assembleFragments(fragmentsRaw),
);

export interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * #539 / #54 spec J OQ-2. The SELECTED boat, whose own draft and derived
   * gate the mask-tolerance caveat states.
   *
   * REQUIRED rather than defaulted to the catalogue's default boat: a missing
   * prop would then silently render the Salona 45's numbers for an Elan
   * skipper — the exact defect #539 exists to close, reintroduced as a
   * fallback. Per this repo's guard-asymmetry rule, a wrong figure in depth
   * copy is the expensive direction, so this fails at the type level instead.
   */
  boat: BoatDef;
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
  return (
    fetch(`${import.meta.env.BASE_URL}data/mask.meta.json`)
      .then((res) =>
        res.ok
          ? (res.json() as Promise<MaskMeta>)
          : Promise.reject(new Error(`HTTP ${res.status}`)),
      )
      // Minimal runtime validation rather than trusting the cast above: an
      // older/malformed mask.meta.json (or a fetch that resolved with the
      // wrong content entirely) must fall back to "no dynamic sources", not
      // hand a non-array through to the .map() render below.
      .then((meta) => (Array.isArray(meta.sources) ? meta.sources : undefined))
      .catch(() => undefined)
  );
}

export default function AboutDialog({ open, onClose, boat }: AboutDialogProps) {
  const t = useT();
  const [lang] = useLang();
  const [maskSources, setMaskSources] = useState<string[] | undefined>(undefined);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // The element focused right before the dialog opened — restored on close
  // so keyboard/screen-reader users land back where they were (the header's
  // About button in practice, #427: an inline SVG icon, not a glyph),
  // rather than at the top of the document.
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
        <p className="about-tagline">{t('app.tagline')}</p>
        {/* #125: build-time version (vite.config.ts `define`) — identifies
            the installed bundle for stale-service-worker triage. Shows the
            literal 'dev' on the dev server by design. */}
        <p className="about-version">{t('about.version', { version: __SC_APP_VERSION__ })}</p>

        {/* #131: "What's new" — sibling of the version line it answers
            ("…and what's in this build?"). Collapsed by default so the
            disclaimer stays above the fold. */}
        <Disclosure summary={t('about.changelog.title')} className="about-changelog">
          <ChangelogView releases={changelogReleases} />
        </Disclosure>

        <p className="about-disclaimer">{t('app.disclaimer')}</p>

        <section>
          <h3>{t('about.caveats.heading')}</h3>
          <ul>
            <li>{t('about.caveats.polars')}</li>
            {/* #455, made per-boat by #539 (spec C.8 R5 / J OQ-2). The four
                numbers this string states — the TOLERANCE_M bound, the
                SELECTED boat's derived default safety depth, its own draft,
                and its #53 relaxed-depth floor — are no longer literals in
                the dict: lib/depthDisclosure.ts derives them from
                pipeline/build_mask.py's TOLERANCE_M (via lib/mask.ts) and
                lib/boatDepth.ts, and app/src/test/maskTolerance.test.ts
                renders THIS dict template for EVERY catalogue boat and
                asserts the rendered text contains that boat's HAND-WRITTEN
                literals. Needle hand-written, haystack production-rendered —
                so perturbing either side alone reds the guard. */}
            <li>{t('about.caveats.depthMask', depthMaskCaveatVars(boat, lang))}</li>
            <li>{t('about.dataSize')}</li>
          </ul>
        </section>

        {/* #187: collapsed by default, matching the changelog Disclosure
            above. Licensing is unaffected — every ODbL/CC-BY credit here is
            independently satisfied by the persistent on-map MapLibre
            attribution (MapView.tsx's ATTRIBUTION string), which is visible
            regardless of this dialog's (or its disclosure's) state. */}
        <Disclosure summary={t('about.sources.heading')} className="about-sources">
          <ul>
            <li>{t('about.sources.protomaps')}</li>
            <li>{t('about.sources.osm')}</li>
            {/* #455: the mask's ODbL statement used to be a static item here
                because the committed mask.meta.json predated that entry. The
                regenerated mask carries it in `sources`, so it now arrives
                through `maskSources` below — a static copy would show it
                twice. Untranslated, like the other three mask sources: it is
                the licence's own formal wording, not UI copy.

                KNOWN CONSEQUENCE, accepted (PR #476 review): that statement is
                now FETCH-DEPENDENT, and `fetchMaskSources()` ends
                `.catch(() => undefined)`, so a failed mask.meta.json load
                renders none of the four mask sources. Accepted rather than
                re-adding a static copy, because ODbL attribution does not
                depend on this path: `about.sources.osm` immediately above is
                static, and MapView.tsx's ATTRIBUTION carries a persistent
                on-map OSM/ODbL credit that is visible regardless of this
                dialog. Only this specific derivative-database WORDING becomes
                conditional, and the same fetch already gated the other three
                mask sources before #455 — so this is a pre-existing pattern
                inherited, not a new failure mode introduced here. If that
                silent catch is ever judged unacceptable for a licence string,
                fix it at `fetchMaskSources` for all four rather than by
                reinstating one static duplicate. */}
            <li>{t('about.sources.openMeteo')}</li>
            <li>{t('about.sources.polars')}</li>
            <li>{t('about.sources.seamarks')}</li>
            {maskSources?.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Disclosure>

        <button type="button" ref={closeButtonRef} onClick={onClose}>
          {t('about.close')}
        </button>
      </div>
    </div>
  );
}
