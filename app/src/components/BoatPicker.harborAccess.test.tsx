// #1292 (#1135 §5.1/§13 item 3): the Boat-tab harbour-access disclosure,
// the clamp-then-recompute ORDERING rule, and the lower-setting-hint
// scheduling (#1321). Its own file, not an addition to BoatPicker.test.tsx
// or BoatPicker.multiBoat.test.tsx, because — mirroring
// RouteSummary.exposure.test.tsx's own header — those two files render
// WITHOUT any `../services/assets` mock and depend on `useNavMask`/
// `useHarborsAsset` staying permanently null (an unconfigured mock module
// would break that for every other case in those files).
//
// Uses the REAL committed mask.bin/mask.meta.json/harbors.json (read via
// `node:fs`, registered in tsconfig.app.json's exclude list and
// tsconfig.test.json's include list, same mechanism as
// harborReachability.test.ts) and the REAL catalogue (`../data/boats`) —
// no synthetic mask, no mocked boats. Fixture depths below were measured
// directly against this committed data (see the values quoted in each
// test's own comment) rather than hand-picked, so the seed-navigability
// trap CLAUDE.md documents for a synthetic fixture does not apply here.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/assets', () => ({ loadRoutingAssets: vi.fn() }));
import { loadRoutingAssets } from '../services/assets';
import { I18nProvider } from '../i18n';
import BoatPicker from './BoatPicker';
import { DEFAULT_SETTINGS } from '../types';
import type { Harbor } from '../types';

const mockedLoad = vi.mocked(loadRoutingAssets);

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8'));
const maskBuffer = new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))).buffer;
const harbors = JSON.parse(readFileSync(resolve(dataDir, 'harbors.json'), 'utf8')) as Harbor[];

function realAssets() {
  return Promise.resolve({
    maskMeta,
    maskBuffer,
    polars: {},
    harbors,
    seamarks: { type: 'FeatureCollection' as const, features: [] },
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  mockedLoad.mockReset();
});

function renderPicker(opts: { boatId?: string; safetyDepthM?: number } = {}) {
  localStorage.setItem('sc-lang', 'en');
  const onBoatIdChange = vi.fn();
  const onSettingsChange = vi.fn();
  render(
    <I18nProvider>
      <BoatPicker
        boatId={(opts.boatId ?? 'salona-45') as never}
        onBoatIdChange={onBoatIdChange}
        settings={{ ...DEFAULT_SETTINGS, safetyDepthM: opts.safetyDepthM ?? 3.0 }}
        onSettingsChange={onSettingsChange}
      />
    </I18nProvider>,
  );
  return { onBoatIdChange, onSettingsChange };
}

function status(): HTMLElement {
  return screen.getByRole('status');
}

/** `mockedLoad`'s promise resolves asynchronously (a real microtask, unlike
 * `renderPicker`'s synchronous `render()`), so firing a click immediately
 * after render reaches `handleSelect` before `mask`/`harbors` exist —
 * exactly the `accessCount: null` (pending) path, not the scenario under
 * test. Wait for every row's own derivation to finish first (none still
 * reads the §5.1 pending string) before interacting. */
async function waitForAssetsReady(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryAllByText('Harbour access not yet checked.')).toHaveLength(0);
  });
}

describe('#1292 ordering: reachability recomputed AFTER the clamp', () => {
  // MEASURED against the real committed mask (salona-45, no boat mock
  // needed): at 2.0 m safety depth every harbour reads `ok` (0 affected);
  // at salona-45's own 3.0 m default, Marstal reads `shallow-approach`
  // (1 affected) and nothing else changes. Starting the picker on Elan
  // 444 (PIRANJA) at a stored 2.0 m and switching to the Salona 45 clamps
  // the depth up to 3.0 m (spec C.7) — the announcement must reflect the
  // POST-clamp 1-affected state, never the pre-clamp 0-affected one.
  it('announces the NEW boat’s access at the CLAMPED depth, not the pre-clamp one', async () => {
    mockedLoad.mockImplementation(realAssets);
    const { onSettingsChange } = renderPicker({
      boatId: 'elan-444-piranja',
      safetyDepthM: 2.0,
    });
    await waitForAssetsReady();
    fireEvent.click(screen.getByRole('radio', { name: /Salona 45/ }));

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange.mock.calls[0]![0]).toMatchObject({ safetyDepthM: 3.0 });

    await waitFor(() => {
      expect(status()).toHaveTextContent('Harbour access — 1 affected at 3.0 m');
    });
    // The pre-clamp reading (0 affected) must never appear — a caller that
    // read `settings.safetyDepthM` instead of the clamped value would show
    // "no known issues" here instead.
    expect(status()).not.toHaveTextContent('no known issues');
  });
});

describe('#1292 announcement: ONE merged live region, in order', () => {
  it('names the boat, then the raised depth, then the access — as one status region', async () => {
    mockedLoad.mockImplementation(realAssets);
    renderPicker({ boatId: 'elan-444-piranja', safetyDepthM: 2.0 });
    await waitForAssetsReady();
    fireEvent.click(screen.getByRole('radio', { name: /Salona 45/ }));

    // #1293 deliberately reuses ONE role="status" region — never a second
    // live region for the harbour-access half.
    expect(screen.getAllByRole('status')).toHaveLength(1);

    await waitFor(() => {
      expect(status()).toHaveTextContent('Harbour access — 1 affected at 3.0 m');
    });
    const text = status().textContent ?? '';
    const boatIdx = text.indexOf('Salona 45 selected.');
    const clampIdx = text.indexOf('Safety depth raised to 3.0 m');
    const accessIdx = text.indexOf('Harbour access — 1 affected');
    expect(boatIdx).toBeGreaterThanOrEqual(0);
    expect(clampIdx).toBeGreaterThan(boatIdx);
    expect(accessIdx).toBeGreaterThan(clampIdx);
  });

  it('skips the clamp clause, but still announces boat then access, on an unclamped switch', async () => {
    mockedLoad.mockImplementation(realAssets);
    // Salona 44 (SPEEDY GO!) shares the Salona 45's 3.0 m default, so a
    // switch between them at settings.safetyDepthM: 3.0 never clamps.
    renderPicker({ boatId: 'salona-45', safetyDepthM: 3.0 });
    await waitForAssetsReady();
    fireEvent.click(screen.getByRole('radio', { name: /SPEEDY GO/ }));

    await waitFor(() => {
      expect(status()).toHaveTextContent('Harbour access — 1 affected at 3.0 m');
    });
    expect(status()).not.toHaveTextContent('Safety depth raised');
    const text = status().textContent ?? '';
    const boatIdx = text.indexOf('selected.');
    const accessIdx = text.indexOf('Harbour access — 1 affected');
    expect(accessIdx).toBeGreaterThan(boatIdx);
  });
});

describe('#1292/#1321 lower-setting hint: deferred, resumable, never overclaims', () => {
  // MEASURED against the real committed mask: at salona-45's own 4.0 m
  // (its default is 3.0 m), Augustenborg reads `unreachable`. Scanning
  // downward from 4.0 m in 0.1 m steps with HINT_STEPS_PER_SLICE=3 finds
  // it `ok` at exactly 3.2 m, but only after two `exhausted` resumes
  // (4.0 -> resume 3.7 -> resume 3.4 -> found 3.2) — three idle ticks.
  it('resolves a multi-tick hint search to "may route at 3.2 m" via resumeFromDepthM', async () => {
    mockedLoad.mockImplementation(realAssets);
    renderPicker({ boatId: 'salona-45', safetyDepthM: 4.0 });

    const option = within(
      document.getElementById('boat-option-salona-45')!.closest('.boat-option')!,
    );
    await waitFor(
      () => {
        expect(option.getByText(/Augustenborg/)).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    await waitFor(
      () => {
        expect(option.getByText(/Augustenborg \(may route at 3.2 m\)/)).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    // #1321: never the unqualified over-claim, even transiently once resolved.
    expect(option.queryByText(/at any setting/)).not.toBeInTheDocument();
  });
});
