import { useState } from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
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

  it('focuses the title-close icon button on open (#696: the near-title control, not the bottom Close button), and returns focus to the trigger that opened it on close', async () => {
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
    // #696: two distinctly-named close controls exist now — the icon one
    // beside the title (de['about.closeDialog']) and the text one at the
    // bottom (de['about.close']). The INITIAL FOCUS target is the title
    // one; asserting against the wrong name here would either find zero
    // matches (icon button not yet rendered under the old name) or pass
    // vacuously against a button that was never the focus target.
    const iconCloseButton = await screen.findByRole('button', {
      name: de['about.closeDialog'],
    });
    await waitFor(() => expect(iconCloseButton).toHaveFocus());

    fireEvent.click(iconCloseButton);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('also returns focus to the trigger when closed via the bottom Close button (both close controls close AND restore)', async () => {
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <DialogWithTrigger />
      </I18nProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    fireEvent.click(trigger);
    const bottomCloseButton = await screen.findByRole('button', { name: de['about.close'] });

    fireEvent.click(bottomCloseButton);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('#696: Tab from the last focusable element cycles to the first (icon close button), and Shift+Tab from the first cycles to the last', async () => {
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={() => {}} />
      </I18nProvider>,
    );

    const dialog = await screen.findByRole('dialog');
    const iconCloseButton = screen.getByRole('button', { name: de['about.closeDialog'] });
    const bottomCloseButton = screen.getByRole('button', { name: de['about.close'] });

    // The dialog's LAST focusable element is the bottom Close button (no
    // links/inputs in this content, so the two Disclosure <summary>s and
    // the two Close buttons are the only tab stops, in DOM order).
    bottomCloseButton.focus();
    expect(bottomCloseButton).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab' });
    // #696 mutation check: an earlier draft of this trap only compared
    // `document.activeElement` against the STATIC first/last computed once
    // per keydown but never called `.focus()` on the wrap target — that
    // draft leaves `document.activeElement` unchanged (still
    // bottomCloseButton) while still calling `preventDefault()`, so this
    // assertion is what catches a trap that "handles" the key without
    // actually moving focus.
    expect(iconCloseButton).toHaveFocus();

    // Shift+Tab from the FIRST focusable element (the icon close button,
    // also the initial-focus target) must wrap to the LAST.
    iconCloseButton.focus();
    expect(iconCloseButton).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(bottomCloseButton).toHaveFocus();

    // A plain Tab/Shift+Tab that does NOT land on an edge must be left
    // alone (no preventDefault, no forced refocus) — i.e. this trap only
    // intervenes at the boundary, matching real browser tab-cycling
    // everywhere else in the dialog. Move focus to something in the
    // middle (a Disclosure summary) and confirm a Tab does not snap it
    // back to either edge.
    const changelogSummary = within(dialog).getByText(de['about.changelog.title']);
    changelogSummary.focus();
    expect(changelogSummary).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab' });
    // Real jsdom does not auto-advance focus on a synthetic Tab keydown
    // (unlike a real browser), so the only thing this can assert is that
    // OUR handler didn't force it onto an edge it doesn't belong to.
    expect(changelogSummary).toHaveFocus();
  });

  it('#696: Tab does not escape the dialog when focus is somehow outside it (defensive wrap)', async () => {
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <DialogWithTrigger />
      </I18nProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'Open' });
    fireEvent.click(trigger);
    await screen.findByRole('dialog');
    const iconCloseButton = screen.getByRole('button', { name: de['about.closeDialog'] });

    // Simulate focus having landed OUTSIDE the dialog (e.g. the trigger,
    // which is still in the document behind the backdrop) while the
    // dialog is open, then press Tab.
    trigger.focus();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(iconCloseButton).toHaveFocus();
  });

  // #780: `focusableElements()` had no visibility filter, so a matching
  // element present in the DOM but not actually focusable to a user (here:
  // `display: none` on an ANCESTOR, not the element itself) still became a
  // Tab-cycle stop. Status per the issue's own DoD step 1: this dialog's
  // CURRENT content is all statically visible — no live element hits this
  // today — so the element below is injected specifically to exercise the
  // filter, not to claim the hazard is presently reachable. jsdom's
  // fallback path (no `Element.checkVisibility`) is what this test proves:
  // it can pin `display: none`, including walked up an ancestor — but NOT
  // a zero-sized box or a control nested inside a collapsed <details>,
  // which need a real browser's `checkVisibility()` (see AboutDialog.tsx's
  // own #780 comment for exactly why, measured against jsdom 30.0.1).
  it('#780: a focusable element hidden via an ANCESTOR display:none is excluded from the Tab cycle', async () => {
    vi.stubGlobal('fetch', fetchMock());
    render(
      <I18nProvider>
        <AboutDialog boat={TEST_BOAT} open onClose={() => {}} />
      </I18nProvider>,
    );

    const dialog = await screen.findByRole('dialog');
    const iconCloseButton = screen.getByRole('button', { name: de['about.closeDialog'] });
    const bottomCloseButton = screen.getByRole('button', { name: de['about.close'] });

    // Appended AFTER the real last focusable element, so it would become
    // the trap's new "last" if the filter didn't exclude it — the button
    // itself carries no `display` of its own; only its WRAPPER does, which
    // is what makes this a genuine ancestor-walk case rather than the
    // trivial "check the element itself" one.
    const hiddenWrapper = document.createElement('div');
    hiddenWrapper.style.display = 'none';
    const hiddenButton = document.createElement('button');
    hiddenButton.textContent = 'not reachable';
    hiddenWrapper.append(hiddenButton);
    dialog.append(hiddenWrapper);

    // Mutation check (this repo's standing requirement): with the filter
    // REMOVED, `hiddenButton` becomes the real DOM-order "last" focusable
    // element, so Tab from `bottomCloseButton` (now second-to-last) is
    // never recognised as "at the last element" at all — jsdom's synthetic
    // Tab keydown never itself advances focus (see the #696 Tab-cycle test
    // above), so focus would stay stuck on `bottomCloseButton` instead of
    // wrapping to `iconCloseButton`, and this assertion reds.
    bottomCloseButton.focus();
    expect(bottomCloseButton).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(iconCloseButton).toHaveFocus();

    hiddenWrapper.remove();
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
