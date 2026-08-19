import { useState } from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import { de } from '../i18n/dict.de';
import { en } from '../i18n/dict.en';
import AboutDialog from './AboutDialog';
import { boatById } from '../data/boats';
import { depthMaskCaveatVars } from '../lib/depthDisclosure';

// #539: the dialog's mask-tolerance caveat is now parameterised by the
// SELECTED boat (spec J OQ-2), so every render site must supply one. The
// Salona 45 keeps these tests describing the same boat they always did; the
// per-boat arithmetic itself is pinned against HAND-WRITTEN literals for
// every catalogue boat in test/maskTolerance.test.ts, not here.
const TEST_BOAT = boatById('salona-45');

// Standalone in every other test (open/onClose are just props), but focus
// return specifically needs a real "trigger" element to hand focus back to
// — App.tsx's About header button in practice (#427: an inline SVG icon,
// not a glyph), reproduced here minimally.
function DialogWithTrigger() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <AboutDialog boat={TEST_BOAT} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function fetchMock(
  sources: string[] | undefined = ['EMODnet Bathymetry Consortium (2024) doi:10.12770/test'],
) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('mask.meta.json')) {
      return Promise.resolve(
        jsonResponse({
          west: 9.4,
          south: 54.3,
          east: 11.0,
          north: 55.3,
          cols: 1,
          rows: 1,
          sources,
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('AboutDialog', () => {
  it('renders nothing when closed', () => {
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open={false} onClose={() => {}} />
      </I18nProvider>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the title and the exact A2 disclaimer string, prominently, in German by default', async () => {
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={() => {}} />
      </I18nProvider>,
    );

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(de['app.disclaimer'])).toBeInTheDocument();
    expect(screen.getByText(de['about.title'])).toBeInTheDocument();
    expect(screen.getByText(de['app.tagline'])).toBeInTheDocument();
  });

  it('shows the English disclaimer when the language is English', async () => {
    localStorage.setItem('sc-lang', 'en');
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={() => {}} />
      </I18nProvider>,
    );

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(en['app.disclaimer'])).toBeInTheDocument();
  });

  it('shows the build-time app version line — literally "Version dev" under vitest (#125)', async () => {
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={() => {}} />
      </I18nProvider>,
    );

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // Vitest resolves vite.config.ts with command 'serve', so the
    // __SC_APP_VERSION__ define is the literal 'dev' here (pinned below) —
    // a real build bakes `git describe --tags --always` output instead
    // (asserted by grepping dist, not unit-testable). Literal expectation on
    // purpose: deriving it from the dict + define would be a tautology.
    expect(__SC_APP_VERSION__).toBe('dev');
    expect(screen.getByText('Version dev')).toBeInTheDocument();
  });

  it('shows the "What\'s new" disclosure with the baked-in changelog content (#131)', async () => {
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={() => {}} />
      </I18nProvider>,
    );

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(de['about.changelog.title'])).toBeInTheDocument();
    // The real repo-root CHANGELOG.md is imported `?raw` and parsed at module
    // load — 0.1.0's heading is a historical fact that can never leave the
    // file, so it pins that real content (not a fixture) reached the DOM.
    // (textContent, not accessible name — see ChangelogView.test.tsx.)
    expect(screen.getByRole('heading', { name: /0\.1\.0/ })).toHaveTextContent(
      '0.1.0 — 2026-07-16',
    );
    expect(screen.getByText(de['about.changelog.langNote'])).toBeInTheDocument();
  });

  it('shows the depth-mask tolerance caveat alongside the polars caveat (#455)', async () => {
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={() => {}} />
      </I18nProvider>,
    );

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(de['about.caveats.polars'])).toBeInTheDocument();
    // #539: the dict entry is a TEMPLATE now, so a bare getByText(de[...])
    // would search for a string containing literal "{gate}" and never match.
    // Interpolating with the same helper the component uses keeps this row
    // doing what it always did — proving the caveat reached the DOM — while
    // the numbers themselves are pinned elsewhere.
    const vars = depthMaskCaveatVars(TEST_BOAT, 'de');
    let expected: string = de['about.caveats.depthMask'];
    for (const [k, v] of Object.entries(vars)) expected = expected.replaceAll(`{${k}}`, v);
    expect(screen.getByText(expected)).toBeInTheDocument();
    // Dict-independence pin, this repo's standing requirement for a
    // getByText(dict[...]) assertion (#504 review round 2): these literals
    // are typed HERE, so the row cannot shrink along with the dict, and they
    // are the SALONA's — an Elan would read 2,8 / 1,9 / 1,0.
    expect(expected).toContain('Standard-Sicherheitstiefe für die Salona 45 beträgt 3,0 m');
    expect(expected).toContain('Tiefgang von 2,1 m');
    expect(expected).toContain('nur 1,2 m');
  });

  it('calls onClose when the close button is clicked', async () => {
    vi.stubGlobal('fetch', fetchMock());
    const onClose = vi.fn();
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={onClose} />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: de['about.close'] }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Escape while open, and stops listening once closed', async () => {
    vi.stubGlobal('fetch', fetchMock());
    const onClose = vi.fn();
    const { rerender } = render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={onClose} />
      </I18nProvider>,
    );
    await screen.findByRole('dialog');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open={false} onClose={onClose} />
      </I18nProvider>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('starts the Data sources section collapsed, matching the changelog Disclosure (#187)', async () => {
    vi.stubGlobal('fetch', fetchMock());
    const { container } = render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={() => {}} />
      </I18nProvider>,
    );

    await screen.findByRole('dialog');
    const details = Array.from(container.querySelectorAll('details')).find((d) =>
      d.textContent?.includes(de['about.sources.heading']),
    );
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('renders the static attributions and the mask.meta.json sources fetched on open, once the Data sources disclosure is expanded (#187)', async () => {
    const mock = fetchMock([
      'EMODnet Bathymetry Consortium (2024) doi:10.12770/test',
      'OSM land polygons (ODbL)',
    ]);
    vi.stubGlobal('fetch', mock);
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={() => {}} />
      </I18nProvider>,
    );

    // #187: Data sources starts collapsed, same as the changelog — expand it
    // before asserting on its content.
    fireEvent.click(await screen.findByText(de['about.sources.heading']));

    expect(await screen.findByText(/EMODnet Bathymetry Consortium/)).toBeInTheDocument();
    expect(screen.getByText(/OSM land polygons/)).toBeInTheDocument();
    expect(screen.getByText(de['about.sources.protomaps'])).toBeInTheDocument();
    expect(screen.getByText(de['about.sources.openMeteo'])).toBeInTheDocument();
  });

  it('still renders static attributions and does not crash when the mask.meta.json fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))),
    );
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={() => {}} />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByText(de['about.sources.heading']));
    expect(await screen.findByText(de['about.sources.protomaps'])).toBeInTheDocument();
  });

  it('renders no sources list item when mask.meta.json.sources is present but not an array (malformed data)', async () => {
    // @ts-expect-error deliberately malformed for the runtime-validation test
    vi.stubGlobal('fetch', fetchMock('not-an-array'));
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={() => {}} />
      </I18nProvider>,
    );

    // Static attributions still render; the malformed dynamic sources are
    // dropped instead of being handed to .map() (which would throw/render
    // garbage for a non-array).
    fireEvent.click(await screen.findByText(de['about.sources.heading']));
    expect(await screen.findByText(de['about.sources.protomaps'])).toBeInTheDocument();
  });

  it('focuses the close button on open, and returns focus to the trigger that opened it on close', async () => {
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <DialogWithTrigger />
      </I18nProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    const closeButton = await screen.findByRole('button', { name: de['about.close'] });
    await waitFor(() => expect(closeButton).toHaveFocus());

    fireEvent.click(closeButton);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('does not force-fetch the full routing asset bundle — only mask.meta.json', async () => {
    const mock = fetchMock();
    vi.stubGlobal('fetch', mock);
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={() => {}} />
      </I18nProvider>,
    );

    await waitFor(() => expect(mock).toHaveBeenCalled());
    // Never mask.bin, polars/*.json, or harbors.json — those are
    // loadRoutingAssets()'s much bigger bundle, deliberately not triggered
    // just to open About.
    for (const call of mock.mock.calls) {
      expect(String(call[0])).toContain('mask.meta.json');
    }
  });
});
