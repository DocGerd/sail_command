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
import Button from './Button';
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

// #696: elements a keyboard user can reach inside the dialog, for the Tab
// focus trap below. `summary` is listed explicitly — the two `Disclosure`s
// (`#131`/`#187`) render native `<details><summary>`, and `<summary>` is
// keyboard-focusable in every real browser despite carrying no `tabindex`,
// so a selector built only from the usual form-control tags would silently
// miss it and let Tab escape through the (visually hidden, but still
// present) app shell behind the disclosure. `:not([disabled])` on the
// form-control tags mirrors the native rule that a disabled control is
// never in the tab order; `[tabindex]:not([tabindex="-1"])` covers anything
// deliberately opted in (or out) via an explicit tabindex.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

// #780: `FOCUSABLE_SELECTOR` above only tests the TAG/attribute shape — it
// has no idea whether a match is actually reachable by a keyboard user.
// This dialog's own content is currently all statically visible (verified:
// no conditionally-hidden focusable element exists in the JSX below as of
// this fix — see the DoD status note on the issue), so the trap is LATENT,
// not observed live; the filter exists so a future conditionally-rendered
// control inside the dialog doesn't silently acquire the hazard.
function isFocusableToUser(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === 'function') {
    // Real modern browsers (Chromium 105+/Firefox 122+/Safari 17.4+, all
    // well below this app's floor). `checkVisibility()` UNCONDITIONALLY
    // covers `display: none`/`display: contents` and
    // `content-visibility: hidden`, each walked up the ancestor chain —
    // which is what makes it also correctly exclude a control nested
    // inside a COLLAPSED <details> (`details:not([open]) > :not(summary)`
    // is a real UA-stylesheet `display: none` rule, so the ancestor walk
    // catches it) and anything hidden via the `hidden` attribute (`[hidden]
    // { display: none }` is likewise a UA default). `visibility: hidden`/
    // `collapse` is opt-in via `checkVisibilityCSS` (off by default) —
    // turned on here since the issue names it explicitly. Verified against
    // MDN (2026-08-31): NEITHER the default NOR any option covers a
    // zero-SIZED box, so that's checked separately below via
    // `getClientRects()` — a real layout box in any browser that ships
    // `checkVisibility()` at all, and the issue's own suggested formula for
    // exactly this case.
    return el.checkVisibility({ checkVisibilityCSS: true }) && el.getClientRects().length > 0;
  }
  // jsdom (this app's unit-test environment, and the reason this branch
  // exists at all rather than calling checkVisibility() unconditionally)
  // computes NO layout whatsoever: `getClientRects()`/
  // `getBoundingClientRect()` read all-zero for EVERY element here,
  // including ordinary visible ones (measured against the installed jsdom
  // 30.0.1) — a size check in this branch would exclude everything, so it
  // is deliberately NOT used. What jsdom's CSSOM DOES resolve correctly
  // without layout: `display: none` — but only on the element checked
  // directly, since `display` is NOT an inherited property (confirmed:
  // jsdom does not propagate a parent's `display: none` onto a child's own
  // computed `display`), hence the explicit ancestor walk below — and
  // `visibility: hidden`, which IS inherited and correctly reflects an
  // ancestor's value on a single read of the element itself (also
  // confirmed against jsdom). `[hidden]` is covered for free: jsdom's own
  // default stylesheet maps it to `display: none`, so the ancestor walk
  // already catches it. NEITHER a zero-sized box NOR a control nested
  // inside a collapsed <details> is reachable through this fallback —
  // jsdom ships no default-stylesheet rule hiding a closed <details>'s
  // body at all, unlike a real browser. See AboutDialog.test.tsx's #780
  // tests for exactly what that leaves this suite able to pin.
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return getComputedStyle(el).visibility !== 'hidden';
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isFocusableToUser,
  );
}

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
  // #696: the icon close button beside the title is the natural initial-
  // focus / restore-on-close target — it's the first element a Tab or a
  // screen reader reaches, so landing here means "you're in a dialog, here's
  // how out" instead of requiring a full traversal to find the (still
  // present) bottom Close button first.
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // #696: the dialog's own root, so the Tab-trap effect below can enumerate
  // ITS OWN focusable descendants without depending on DOM order elsewhere
  // in the app shell.
  const dialogRef = useRef<HTMLDivElement>(null);
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
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // #696: a real focus trap. `aria-modal="true"` above ASSERTS that the
      // rest of the document is inert to assistive tech, but nothing
      // previously enforced it for KEYBOARD users — Tab/Shift+Tab could
      // walk straight through the (visually dimmed, but still live) app
      // shell behind the backdrop into map/routing controls a sighted mouse
      // user would never reach while the dialog is "open". Cycling within
      // the dialog's own focusables closes that gap without touching
      // App.tsx (out of scope here; the issue's own alternative to marking
      // the app-shell siblings `inert`).
      if (e.key !== 'Tab') return;
      const dialogEl = dialogRef.current;
      if (!dialogEl) return;
      const focusables = focusableElements(dialogEl);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Also wraps when focus is somehow OUTSIDE the dialog (e.g. nothing
      // focused yet) rather than only at the two edges, so the trap can't
      // be defeated by a focus target the dialog doesn't know about.
      const outside = !active || !dialogEl.contains(active);
      if (e.shiftKey) {
        if (outside || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (outside || active === last) {
        e.preventDefault();
        first.focus();
      }
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
        ref={dialogRef}
      >
        <div className="about-dialog-header">
          <h2 id="about-dialog-title">{t('about.title')}</h2>
          {/* #696: a close affordance NEAR THE TITLE — previously the only
              close control was the bottom Close button, reachable only
              after traversing the whole dialog (title, tagline, version,
              What's new, disclaimer, caveats, Data sources). On the
              short-landscape edge viewports (844x390, 740x360) that bottom
              button can sit below the fold; this one never does. Icon-only
              (no visible label), so it needs its own aria-label — reuses
              the inline-SVG-with-app.css-classes pattern #427 established
              for the header's (i) info icon (currentColor -> --sc-fg,
              themes automatically in both colour schemes with no new
              tokens), not that icon's geometry. The bottom Close button is
              KEPT per the issue's "keep or drop as the maintainer prefers"
              — removing a working, already-tested control is the riskier
              default. */}
          <Button
            variant="ghost"
            ref={closeButtonRef}
            className="about-close-btn"
            aria-label={t('about.closeDialog')}
            onClick={onClose}
          >
            <svg
              className="about-close-icon-svg"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </Button>
        </div>
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

        <Button variant="ghost" onClick={onClose}>
          {t('about.close')}
        </Button>
      </div>
    </div>
  );
}
