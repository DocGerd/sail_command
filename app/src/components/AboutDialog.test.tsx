import { useState } from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import { de } from '../i18n/dict.de';
import { en } from '../i18n/dict.en';
import AboutDialog from './AboutDialog';

// Standalone in every other test (open/onClose are just props), but focus
// return specifically needs a real "trigger" element to hand focus back to
// — App.tsx's ⓘ header button in practice, reproduced here minimally.
function DialogWithTrigger() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <AboutDialog open={open} onClose={() => setOpen(false)} />
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
        <AboutDialog open={false} onClose={() => {}} />
      </I18nProvider>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the title and the exact A2 disclaimer string, prominently, in German by default', async () => {
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <AboutDialog open onClose={() => {}} />
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
        <AboutDialog open onClose={() => {}} />
      </I18nProvider>,
    );

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(en['app.disclaimer'])).toBeInTheDocument();
  });

  it('shows the build-time app version line — literally "Version dev" under vitest (#125)', async () => {
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <AboutDialog open onClose={() => {}} />
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

  it('calls onClose when the close button is clicked', async () => {
    vi.stubGlobal('fetch', fetchMock());
    const onClose = vi.fn();
    render(
      <I18nProvider>
        <AboutDialog open onClose={onClose} />
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
        <AboutDialog open onClose={onClose} />
      </I18nProvider>,
    );
    await screen.findByRole('dialog');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <I18nProvider>
        <AboutDialog open={false} onClose={onClose} />
      </I18nProvider>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the static attributions and the mask.meta.json sources fetched on open', async () => {
    const mock = fetchMock([
      'EMODnet Bathymetry Consortium (2024) doi:10.12770/test',
      'OSM land polygons (ODbL)',
    ]);
    vi.stubGlobal('fetch', mock);
    render(
      <I18nProvider>
        <AboutDialog open onClose={() => {}} />
      </I18nProvider>,
    );

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
        <AboutDialog open onClose={() => {}} />
      </I18nProvider>,
    );

    expect(await screen.findByText(de['about.sources.protomaps'])).toBeInTheDocument();
  });

  it('renders no sources list item when mask.meta.json.sources is present but not an array (malformed data)', async () => {
    // @ts-expect-error deliberately malformed for the runtime-validation test
    vi.stubGlobal('fetch', fetchMock('not-an-array'));
    render(
      <I18nProvider>
        <AboutDialog open onClose={() => {}} />
      </I18nProvider>,
    );

    // Static attributions still render; the malformed dynamic sources are
    // dropped instead of being handed to .map() (which would throw/render
    // garbage for a non-array).
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
        <AboutDialog open onClose={() => {}} />
      </I18nProvider>,
    );

    await waitFor(() => expect(mock).toHaveBeenCalled());
    // Never mask.bin, polar-*.json, or harbors.json — those are
    // loadRoutingAssets()'s much bigger bundle, deliberately not triggered
    // just to open About.
    for (const call of mock.mock.calls) {
      expect(String(call[0])).toContain('mask.meta.json');
    }
  });
});
