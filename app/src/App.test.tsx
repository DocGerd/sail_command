import 'fake-indexeddb/auto';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import App from './App';
import { de } from './i18n/dict.de';
import { __resetDbForTests } from './services/db';
import * as db from './services/db';
import { TEST_MASK_META, TEST_POLAR } from './test/fixtures';
import type { Harbor, PolarTable } from './types';

// jsdom has no WebGL/canvas backend, so MapLibre GL is mocked wholesale here
// (mirrors the "not unit-tested" notes in RouteLayer.tsx/BoatMarker.tsx —
// this is the first suite to mount MapView, so it's the one that needs the
// stand-in). Every method MapView/RouteLayer/BoatMarker call on a map or
// marker instance is a no-op; App-level tests exercise tabs/banners/dialog
// logic, not actual map rendering (covered by the Playwright browser pass).
vi.mock('maplibre-gl', () => {
  class FakeMap {
    on() {}
    off() {}
    once(event: string, cb: () => void) {
      if (event === 'load') cb();
    }
    remove() {}
    addControl() {}
    addSource() {}
    addLayer() {}
    getSource() {
      return undefined;
    }
    getLayer() {
      return undefined;
    }
    removeLayer() {}
    removeSource() {}
    isStyleLoaded() {
      return true;
    }
    setLayoutProperty() {}
    setFilter() {}
    setPaintProperty() {}
    fitBounds() {}
    hasImage() {
      return false;
    }
    addImage() {}
  }
  class FakeMarker {
    setLngLat() {
      return this;
    }
    setRotation() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  }
  class FakeAttributionControl {}
  class FakeLngLatBounds {
    extend() {
      return this;
    }
  }
  return {
    Map: FakeMap,
    Marker: FakeMarker,
    AttributionControl: FakeAttributionControl,
    LngLatBounds: FakeLngLatBounds,
    addProtocol: vi.fn(),
  };
});

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };
const FLENSBURG: Harbor = {
  id: 'flensburg',
  names: { de: 'Flensburg', da: 'Flensborg', en: 'Flensburg' },
  country: 'DE',
  snap: { lat: 54.795, lon: 9.435 },
};
const HARBORS: Harbor[] = [FLENSBURG];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function fetchMock() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('mask.meta.json')) return Promise.resolve(jsonResponse(TEST_MASK_META));
    if (url.includes('mask.bin')) {
      const buf = new ArrayBuffer(TEST_MASK_META.rows * TEST_MASK_META.cols);
      return Promise.resolve(new Response(buf, { status: 200 }));
    }
    if (url.includes('polar-genoa.json')) return Promise.resolve(jsonResponse(TEST_POLAR));
    if (url.includes('polar-fock.json')) return Promise.resolve(jsonResponse(FOCK));
    if (url.includes('harbors.json')) return Promise.resolve(jsonResponse(HARBORS));
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function renderApp() {
  return render(<App />);
}

beforeEach(async () => {
  await __resetDbForTests();
  vi.stubGlobal('fetch', fetchMock());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('App', () => {
  it('renders the app shell with the SailCommand title', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'SailCommand', level: 1 })).toBeInTheDocument();
  });

  it('defaults to the Planen tab, and switching tabs shows Routen and Live panel content', async () => {
    renderApp();

    expect(await screen.findByRole('tab', { name: de['nav.plan'] })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    expect(screen.getByRole('tab', { name: de['nav.routes'] })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(de['plansList.empty'])).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: de['nav.live'] }));
    expect(screen.getByRole('tab', { name: de['nav.live'] })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(de['live.noPlan'])).toBeInTheDocument();
  });

  it('shows the offline banner when the browser goes offline, and it clears when back online', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    expect(screen.queryByText(de['banner.offline'])).not.toBeInTheDocument();

    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    fireEvent(window, new Event('offline'));
    expect(await screen.findByText(de['banner.offline'])).toBeInTheDocument();

    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    fireEvent(window, new Event('online'));
    await waitFor(() => {
      expect(screen.queryByText(de['banner.offline'])).not.toBeInTheDocument();
    });
  });

  it('opens About via the header button and shows the A2 disclaimer string in the current (German) language', async () => {
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: de['about.open'] }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(de['app.disclaimer'])).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: de['about.close'] }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a dismissible settings-persistence-failure banner when a settings save fails', async () => {
    renderApp();
    const safetyDepthInput = await screen.findByLabelText(de['options.safetyDepth.label']);

    // Let the mount-time settings load settle first, then arm the failure —
    // this exercises the direct setSettings->saveSettings path, not the
    // pre-load flush path (covered in AppState.test.tsx).
    await waitFor(() => expect(safetyDepthInput).toHaveValue(3));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'saveSettings').mockRejectedValue(new Error('save boom'));

    fireEvent.change(safetyDepthInput, { target: { value: '3.5' } });
    fireEvent.blur(safetyDepthInput);

    expect(await screen.findByText(de['banner.persistenceError'])).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: de['banner.dismiss'] }));
    expect(screen.queryByText(de['banner.persistenceError'])).not.toBeInTheDocument();
  });

  it('a persistence-failure banner clears on the next successful save, without an explicit dismiss', async () => {
    renderApp();
    const safetyDepthInput = await screen.findByLabelText(de['options.safetyDepth.label']);
    await waitFor(() => expect(safetyDepthInput).toHaveValue(3));

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'saveSettings').mockRejectedValueOnce(new Error('save boom'));

    fireEvent.change(safetyDepthInput, { target: { value: '3.5' } });
    fireEvent.blur(safetyDepthInput);
    expect(await screen.findByText(de['banner.persistenceError'])).toBeInTheDocument();

    // mockRejectedValueOnce only overrides the next call; this one falls
    // through to the real saveSettings and should succeed.
    fireEvent.change(safetyDepthInput, { target: { value: '4' } });
    fireEvent.blur(safetyDepthInput);

    await waitFor(() => {
      expect(screen.queryByText(de['banner.persistenceError'])).not.toBeInTheDocument();
    });
  });

  describe('tap-to-pick', () => {
    function armOrigin() {
      const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
      fireEvent.click(within(originSection).getByRole('button', { name: de['planner.pickOnMap'] }));
      return originSection;
    }

    // E8: 'via' extends the same tapTarget machinery (arming/disarming) as
    // origin/destination — armed from the panel's "Add waypoint" button
    // instead of a harbor section's "Pick on map" button, since via points
    // have no harbor picker of their own.
    function armVia() {
      const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
      fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
      return viaSection;
    }

    const tapPickMessage = (targetLabel: string) => de['banner.tapPick'].replace('{target}', targetLabel);

    it('arms tap-to-pick with a cancel banner, and switching tabs away from Plan disarms it', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armOrigin();
      const message = tapPickMessage(de['planner.origin.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      // The banner and MapView's tapActive prop are both driven by the same
      // tapTarget state, so the banner clearing is equivalent to tapActive
      // going false — this is the only tap-armed indicator surfaced to a
      // screen reader/DOM query; MapLibre itself is mocked in this suite.
      fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it('picking a harbor for the armed field disarms tap-to-pick', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      const originSection = armOrigin();
      const message = tapPickMessage(de['planner.origin.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.click(within(originSection).getByRole('button', { name: FLENSBURG.names.de }));

      expect(screen.queryByText(message)).not.toBeInTheDocument();
      expect(within(originSection).getByText(FLENSBURG.names.de, { selector: 'p' })).toBeInTheDocument();
    });

    it('the banner cancel button disarms tap-to-pick', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armOrigin();
      const message = tapPickMessage(de['planner.origin.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: de['banner.tapPick.cancel'] }));
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it('pressing Escape disarms tap-to-pick', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armOrigin();
      const message = tapPickMessage(de['planner.origin.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it('arms tap-to-pick for "via" from the panel\'s Add waypoint button, and switching tabs disarms it', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armVia();
      const message = tapPickMessage(de['planner.via.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it('the banner cancel button disarms via tap-to-pick', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armVia();
      const message = tapPickMessage(de['planner.via.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: de['banner.tapPick.cancel'] }));
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it('pressing Escape disarms via tap-to-pick', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armVia();
      const message = tapPickMessage(de['planner.via.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it('arming origin then arming via re-arms for the new target (only one can be armed at a time)', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armOrigin();
      expect(await screen.findByText(tapPickMessage(de['planner.origin.label']))).toBeInTheDocument();

      armVia();
      expect(screen.queryByText(tapPickMessage(de['planner.origin.label']))).not.toBeInTheDocument();
      expect(await screen.findByText(tapPickMessage(de['planner.via.label']))).toBeInTheDocument();
    });
  });
});
