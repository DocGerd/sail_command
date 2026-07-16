import { render, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Leg, type Plan, type Rig, type RigResult } from '../types';

// The mask is fetched via the module-cached loadRoutingAssets(); mock it so a
// jsdom test can drive a synthetic (uniform-byte) mask through the component.
vi.mock('../services/assets', () => ({ loadRoutingAssets: vi.fn() }));
// Spy on profileSamples (real implementation kept) so the "safety change
// doesn't resample" test can pin sample-memo identity by call count, not just
// path-string equality.
vi.mock('../lib/routeProfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/routeProfile')>();
  return { ...actual, profileSamples: vi.fn(actual.profileSamples) };
});
import { loadRoutingAssets } from '../services/assets';
import { profileSamples } from '../lib/routeProfile';
import DepthProfile from './DepthProfile';

const mockedLoad = vi.mocked(loadRoutingAssets);
const spiedSamples = vi.mocked(profileSamples);

const FETCHED_AT_MS = Date.UTC(2026, 6, 15, 6, 0, 0);
const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);

/** Uniform mask: every cell decodes to the given byte. */
function assetsWith(byte: number) {
  const data = new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(byte);
  return {
    maskMeta: TEST_MASK_META,
    maskBuffer: data.buffer,
    polarGenoa: TEST_POLAR,
    polarFock: TEST_POLAR,
    harbors: [],
  };
}

const GENOA_LEGS: Leg[] = [
  {
    kind: 'sail',
    board: 'starboard',
    start: { lat: 54.79, lon: 9.43 },
    end: { lat: 54.8, lon: 10.0 },
    startTimeMs: DEPARTURE_MS,
    endTimeMs: DEPARTURE_MS + 2 * 3_600_000,
    headingDeg: 88,
    twaDeg: 92,
    twsKn: 10,
    speedKn: 7,
    distanceNm: 15,
    maneuverAtStart: null,
  },
  {
    kind: 'motor',
    board: null,
    start: { lat: 54.8, lon: 10.0 },
    end: { lat: 54.85, lon: 10.52 },
    startTimeMs: DEPARTURE_MS + 2 * 3_600_000,
    endTimeMs: DEPARTURE_MS + 4 * 3_600_000,
    headingDeg: 90,
    twsKn: 2,
    speedKn: 6.5,
    distanceNm: 5,
    maneuverAtStart: null,
  },
];

const GENOA_RESULT: RigResult = {
  rig: 'genoa',
  etaMs: DEPARTURE_MS + 4 * 3_600_000,
  durationMs: 4 * 3_600_000,
  distanceNm: 20,
  maneuverCount: 0,
  motorDistanceNm: 5,
  legs: GENOA_LEGS,
};

const FOCK_RESULT: RigResult = {
  rig: 'fock',
  etaMs: DEPARTURE_MS + 6 * 3_600_000,
  durationMs: 6 * 3_600_000,
  distanceNm: 22,
  maneuverCount: 0,
  motorDistanceNm: 0,
  legs: [
    {
      kind: 'sail',
      board: 'starboard',
      start: { lat: 54.79, lon: 9.43 },
      end: { lat: 54.85, lon: 10.52 },
      startTimeMs: DEPARTURE_MS,
      endTimeMs: DEPARTURE_MS + 6 * 3_600_000,
      headingDeg: 85,
      twaDeg: 95,
      twsKn: 9,
      speedKn: 5.5,
      distanceNm: 22,
      maneuverAtStart: null,
    },
  ],
};

function makePlan(overrides: Partial<Plan['result']> = {}): Plan {
  return {
    id: 'plan-1',
    name: 'Flensburg to Marstal',
    createdAtMs: FETCHED_AT_MS,
    request: {
      origin: { lat: 54.79, lon: 9.43 },
      destination: { lat: 54.85, lon: 10.52 },
      viaPoints: [],
      originHarborId: 'flensburg',
      destinationHarborId: 'marstal',
      departureMs: DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
    },
    windGrid: { ...uniformWindGrid(10, 270), fetchedAtMs: FETCHED_AT_MS },
    result: {
      status: 'ok',
      genoa: GENOA_RESULT,
      fock: FOCK_RESULT,
      genoaReason: null,
      fockReason: null,
      recommended: 'genoa',
      snappedOrigin: { lat: 54.79, lon: 9.43 },
      snappedDestination: { lat: 54.85, lon: 10.52 },
      ...overrides,
    },
  };
}

function setMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function renderProfile(props: { plan?: Plan; rig?: Rig; safetyDepthM?: number } = {}) {
  localStorage.setItem('sc-lang', 'en');
  const plan = props.plan ?? makePlan();
  const utils = render(
    <I18nProvider>
      <DepthProfile plan={plan} rig={props.rig ?? 'genoa'} safetyDepthM={props.safetyDepthM ?? 3} />
    </I18nProvider>,
  );
  return utils;
}

/** Waits for the async mask load to resolve and the chart to render. */
async function waitForChart(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector('.dp-seabed')).not.toBeNull());
}

beforeEach(() => {
  mockedLoad.mockResolvedValue(assetsWith(200)); // 20 m everywhere by default
  setMatchMedia(false);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('DepthProfile', () => {
  it('renders nothing when the active rig has no result (no crash)', () => {
    const plan = makePlan({ genoa: null, genoaReason: 'unreachable' });
    const { container } = renderProfile({ plan, rig: 'genoa' });
    expect(container.querySelector('.depth-profile')).toBeNull();
  });

  it('summary shows the title and the min depth glance value', async () => {
    const { container } = renderProfile();
    await waitForChart(container);
    const summary = container.querySelector('.depth-profile-summary');
    expect(summary?.textContent).toContain('Depth profile');
    expect(summary?.textContent).toContain('min 20.0 m');
  });

  it('opens by default on wide viewports, stays collapsed on narrow (matchMedia at mount)', async () => {
    setMatchMedia(true);
    const wide = renderProfile();
    expect(wide.container.querySelector('details')?.open).toBe(true);
    cleanup();

    setMatchMedia(false);
    const narrow = renderProfile();
    expect(narrow.container.querySelector('details')?.open).toBe(false);
  });

  it('draws HH:mm clock ticks on the X axis', async () => {
    const { container } = renderProfile();
    await waitForChart(container);
    const tickLabels = Array.from(container.querySelectorAll('.dp-tick')).map((t) => t.textContent);
    expect(tickLabels.length).toBeGreaterThan(0);
    expect(tickLabels.every((l) => /^\d{2}:\d{2}$/.test(l ?? ''))).toBe(true);
  });

  it('inverts the depth axis (0 at top, deeper further down)', async () => {
    const { container } = renderProfile();
    await waitForChart(container);
    const yOfLabel = (text: string) => {
      const el = Array.from(container.querySelectorAll('.dp-ylabel')).find(
        (n) => n.textContent === text,
      );
      return el ? Number(el.getAttribute('y')) : NaN;
    };
    expect(yOfLabel('0')).toBeLessThan(yOfLabel('5'));
  });

  it('the safety line moves on a settings change WITHOUT resampling (sample identity pinned)', async () => {
    localStorage.setItem('sc-lang', 'en');
    // ONE plan object reused across the rerender — only safetyDepthM changes,
    // so a correct component reuses the memoized samples (no profileSamples
    // call, byte-identical seabed). If safetyDepthM were wrongly added to the
    // samples-memo deps, the spy would be called again and this fails.
    const plan = makePlan();
    spiedSamples.mockClear();
    const { container, rerender } = render(
      <I18nProvider>
        <DepthProfile plan={plan} rig="genoa" safetyDepthM={3} />
      </I18nProvider>,
    );
    await waitForChart(container);
    const callsAfterMount = spiedSamples.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);
    const seabedBefore = container.querySelector('.dp-seabed')?.getAttribute('d');
    const safetyYBefore = container.querySelector('.dp-safety-line')?.getAttribute('y1');

    rerender(
      <I18nProvider>
        <DepthProfile plan={plan} rig="genoa" safetyDepthM={10} />
      </I18nProvider>,
    );
    const seabedAfter = container.querySelector('.dp-seabed')?.getAttribute('d');
    const safetyYAfter = container.querySelector('.dp-safety-line')?.getAttribute('y1');

    expect(spiedSamples.mock.calls.length).toBe(callsAfterMount); // no resample
    expect(seabedAfter).toBe(seabedBefore); // samples untouched by the safety change
    expect(safetyYAfter).not.toBe(safetyYBefore); // overlay moved
    expect(container.querySelector('.dp-safety-line')?.getAttribute('stroke')).toBe('#E69F00');
  });

  it('tints shallow spans in orange where depth < safety depth', async () => {
    mockedLoad.mockResolvedValue(assetsWith(20)); // 2.0 m everywhere, below default safety 3.0
    const { container } = renderProfile({ safetyDepthM: 3 });
    await waitForChart(container);
    const shallow = container.querySelectorAll('.dp-shallow');
    expect(shallow.length).toBeGreaterThan(0);
    expect(shallow[0].getAttribute('fill')).toBe('#E69F00');
  });

  it('renders capped depth honestly (hatched band + ">= 25 m" label) over the deep-cap sentinel', async () => {
    mockedLoad.mockResolvedValue(assetsWith(255)); // deep cap everywhere
    const { container } = renderProfile();
    await waitForChart(container);
    expect(container.querySelectorAll('.dp-cap-band').length).toBeGreaterThan(0);
    const labels = Array.from(container.querySelectorAll('text')).map((n) => n.textContent);
    expect(labels).toContain('≥ 25 m');
  });

  it('shades motor legs distinctly and follows the displayed rig', async () => {
    const genoa = renderProfile({ rig: 'genoa' }); // has a motor leg
    await waitForChart(genoa.container);
    expect(genoa.container.querySelectorAll('.dp-motor-band').length).toBeGreaterThan(0);
    expect(genoa.container.querySelector('.dp-motor-band')?.getAttribute('fill')).toContain(
      'dp-motor-',
    );
    cleanup();

    const fock = renderProfile({ rig: 'fock' }); // single sail leg, no motor
    await waitForChart(fock.container);
    expect(fock.container.querySelectorAll('.dp-motor-band').length).toBe(0);
  });

  it('places wind barbs and heading arrows in the indicator strip', async () => {
    const { container } = renderProfile();
    await waitForChart(container);
    expect(container.querySelectorAll('.dp-barb').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.dp-heading').length).toBeGreaterThan(0);
  });
});
