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
import BoatPicker, { harborHintSuffix } from './BoatPicker';
import { DEFAULT_SETTINGS } from '../types';
import type { Harbor } from '../types';
import { BOATS, type BoatDef } from '../data/boats';
import { findLowerSettingHint, type HarborWithReachability } from '../lib/harborReachability';
import { NavMask } from '../lib/mask';
import { en } from '../i18n/dict.en';
import type { MsgKey } from '../i18n/dict.de';

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

describe('PR #1324 review Minor: the access clause catches up once assets resolve', () => {
  it('does not freeze on "not yet checked" once mask/harbors load AFTER the switch', async () => {
    // Deliberately the OPPOSITE of waitForAssetsReady(): switch WHILE the
    // asset load is still pending, then resolve it afterwards. Freezing
    // `accessCount` inside `handleSelect` (the pre-fix shape) could never
    // see this later resolution — only recomputing it at RENDER time, from
    // the CURRENT `mask`/`harbors`, catches up.
    // ONE shared pending promise, returned to every caller — matches the
    // real `loadRoutingAssets()` module-cached singleton (both `useNavMask`
    // and `useHarborsAsset` call it independently; a mock returning a FRESH
    // promise per call would leave one of the two callers permanently
    // unresolved, since only the LAST call's resolver would ever be reached).
    let resolveAssets!: (value: Awaited<ReturnType<typeof realAssets>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof realAssets>>>((resolve) => {
      resolveAssets = resolve;
    });
    mockedLoad.mockImplementation(() => pending);
    renderPicker({ boatId: 'salona-44-speedy-go', safetyDepthM: 3.0 });
    fireEvent.click(screen.getByRole('radio', { name: /Salona 45/ }));

    await waitFor(() => {
      expect(status()).toHaveTextContent('Harbour access not yet checked.');
    });

    resolveAssets(await realAssets());

    await waitFor(() => {
      expect(status()).toHaveTextContent('Harbour access — 1 affected at 3.0 m');
    });
    expect(status()).not.toHaveTextContent('not yet checked');
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
  it('resolves a multi-tick hint search to "may route at 3.2 m (depth data only)" via resumeFromDepthM', async () => {
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
        expect(
          option.getByText(/Augustenborg \(may route at 3.2 m \(depth data only\)\)/),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    // #1321: never the unqualified over-claim, even transiently once resolved.
    expect(option.queryByText(/at any setting/)).not.toBeInTheDocument();
  });
});

// PR #1324 review Major: `harborHintSuffix` must key a `found` outcome by
// its OWN `hint.state`, not collapse `shallow-approach` into the plain `ok`
// phrasing. Tested directly against `harborHintSuffix` (a pure function,
// exported for exactly this) rather than through a full render, using REAL
// `findLowerSettingHint` outcomes over the real committed mask/harbors —
// never a hand-built `LowerSettingHintOutcome` literal. `tFromDict`
// reproduces `useT()`'s own one-line interpolation algorithm over the REAL
// shipped `en` dict, so this reads the actual committed strings without
// needing a rendered `<I18nProvider>` tree for a two-call unit test.
function tFromDict(key: MsgKey, vars?: Record<string, string | number>): string {
  let msg: string = en[key];
  for (const [k, v] of Object.entries(vars ?? {})) msg = msg.replaceAll(`{${k}}`, String(v));
  return msg;
}

describe('#1292/PR #1324: harborHintSuffix keys a found hint by its own state', () => {
  const mask = new NavMask(maskMeta, new Uint8Array(maskBuffer));
  // DERIVED from the real catalogue, IDENTICAL to harborReachability.test.ts's
  // own `synthetic` fixture (same base boat, same draft override, same id
  // string) — reused for all three cases below so each reproduces one of
  // that file's OWN pinned outcomes exactly, never a fixture invented here.
  // `name` stays "Salona 45" from the spread; only `draftM` (and `id`, for
  // catalogue-lookup safety) are overridden.
  const synthetic: BoatDef = {
    ...BOATS[0]!,
    id: 'harborReachability-fixture-easy-go' as BoatDef['id'],
    draftM: 2.55,
  };

  it('found + shallow-approach adds the depth-warning caution (real faldsled outcome)', () => {
    const faldsled = harbors.find((h) => h.id === 'faldsled')! as HarborWithReachability;
    const outcome = findLowerSettingHint(mask, faldsled, synthetic, 5.2);
    // Same assertion harborReachability.test.ts pins for this exact call —
    // confirms the fixture reproduces the frozen API's own real outcome.
    expect(outcome).toEqual({ kind: 'found', hint: { depthM: 5, state: 'shallow-approach' } });
    expect(harborHintSuffix(outcome, synthetic, 'en', tFromDict)).toBe(
      'may route at 5.0 m, with a depth warning (depth data only)',
    );
  });

  it('found + ok carries no caution (real augustenborg/salona-45 outcome)', () => {
    // MEASURED against the real committed mask: salona-45 (draft 2.1 m,
    // default 3.0 m) at a live 3.5 m reads augustenborg `unreachable`; the
    // hint search finds it `ok` at exactly 3.2 m.
    const salona45 = BOATS.find((b) => b.id === 'salona-45')!;
    const augustenborg = harbors.find((h) => h.id === 'augustenborg')! as HarborWithReachability;
    const outcome = findLowerSettingHint(mask, augustenborg, salona45, 3.5);
    expect(outcome).toEqual({ kind: 'found', hint: { depthM: 3.2, state: 'ok' } });
    expect(harborHintSuffix(outcome, salona45, 'en', tFromDict)).toBe(
      'may route at 3.2 m (depth data only)',
    );
  });

  it('not-found names the boat, never "at any setting" (real marstal/synthetic outcome)', () => {
    // Same (mask, harbor, boat, depth) harborReachability.test.ts's own
    // marstal not-found case uses — its search range (synthetic's 3.5 m
    // default up to 4.6 m) is 11 decimetres, inside the default 12-step
    // budget, so this is guaranteed 'not-found' rather than 'exhausted'.
    const marstal = harbors.find((h) => h.id === 'marstal')! as HarborWithReachability;
    const outcome = findLowerSettingHint(mask, marstal, synthetic, 4.6);
    expect(outcome.kind).toBe('not-found');
    expect(harborHintSuffix(outcome, synthetic, 'en', tFromDict)).toBe(
      "not reachable at or above Salona 45's recommended safety depth",
    );
  });
});
