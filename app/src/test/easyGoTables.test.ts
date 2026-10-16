import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BoatPicker from '../components/BoatPicker';
import { I18nProvider } from '../i18n';
import { BOATS, boatById, polarKey } from '../data/boats';
import { weakestPolarTier } from '../lib/boatProvenance';
import { recalcRequest } from '../lib/recalc';
import { rigComparisonSuppressedByTier } from '../lib/plan';
import { en } from '../i18n/dict.en';
import { planRoute } from '../routing/planRoute';
import {
  DEFAULT_SETTINGS,
  boatSnapshot,
  type Plan,
  type PlanRequest,
  type PolarTable,
} from '../types';
import { openWaterMask, uniformWindGrid } from './fixtures';
import { polars as realmaskPolars } from './realmaskFixtures';
import { SOLVER_TEST_TIMEOUT_MS } from './timeouts';

vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

// Spec P.10 items 12-15 (#1660) for SALONA 44 EASY GO!.

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const EASY_GO = boatById('salona-44-easy-go');

function loadAsset(asset: string): PolarTable {
  return JSON.parse(readFileSync(resolve(publicDir, asset), 'utf8')) as PolarTable;
}

/** Polars keyed as `loadRoutingAssets` keys them: by the catalogue's own `polarAsset`. */
function loadedPolars(): Record<string, PolarTable> {
  return Object.fromEntries(
    EASY_GO.sails.map((s) => [polarKey(EASY_GO.id, s.id), loadAsset(s.polarAsset)]),
  );
}

const REQ: PlanRequest = {
  origin: { lat: 54.7525, lon: 10.0025 },
  destination: { lat: 54.7525, lon: 10.4025 },
  viaPoints: [],
  originHarborId: null,
  destinationHarborId: null,
  departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
  settings: DEFAULT_SETTINGS,
  sailIds: ['genoa', 'fock'],
  boat: boatSnapshot(EASY_GO),
};

describe('P.10 item 12: EASY GO! catalogue entry', () => {
  it('has exactly genoa (estimated) then fock (modelled), on its own assets', () => {
    expect(EASY_GO.sails.map((s) => [s.id, s.polarProvenance.tier, s.polarAsset])).toEqual([
      ['genoa', 'estimated', 'data/polars/salona-44-easy-go-genoa.json'],
      ['fock', 'modelled', 'data/polars/salona-44-easy-go-fock.json'],
    ]);
  });

  it('declares no downwindSails and no polarsFrom', () => {
    expect(Object.keys(EASY_GO)).not.toContain('downwindSails');
    expect(Object.keys(EASY_GO)).not.toContain('polarsFrom');
  });

  it('notes carry the D6 tokens and no internal register (#595)', () => {
    const genoa = EASY_GO.sails[0]!.polarProvenance.note;
    const fock = EASY_GO.sails[1]!.polarProvenance.note;
    expect(genoa).toContain('ESTIMATED');
    expect(genoa).toContain('ramp');
    expect(fock.toLowerCase()).toContain('sister hull');
    expect(fock).toContain('04590004MKR');
    const internal = [
      /#\d+/,
      /spec [A-Z]/,
      /OQ-\d/,
      ...BOATS.map((b) => new RegExp(b.id)),
      /fock/i,
    ];
    for (const note of [genoa, fock, EASY_GO.draftProvenance.note]) {
      expect(note.length).toBeGreaterThan(0);
      for (const p of internal) expect(note, String(p)).not.toMatch(p);
    }
  });

  it('the real-mask fixtures key EASY GO! at its own tables, not SPEEDY GO!', () => {
    for (const s of EASY_GO.sails) {
      const key = polarKey(EASY_GO.id, s.id);
      expect(realmaskPolars[key]).toEqual(loadAsset(s.polarAsset));
      expect(realmaskPolars[key]).not.toEqual(
        realmaskPolars[polarKey('salona-44-speedy-go', s.id)],
      );
    }
  });
});

describe('P.10 item 13: not-compared on the loaded assets', () => {
  it('weakestPolarTier reads estimated', () => {
    expect(weakestPolarTier(EASY_GO)).toBe('estimated');
  });

  it('planRoute solves both sails and returns not-compared', () => {
    const r = planRoute(REQ, uniformWindGrid(12, 0), {
      polars: loadedPolars(),
      boat: EASY_GO,
      mask: openWaterMask(),
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.sails).toHaveLength(2);
    expect(r.sails.every((s) => s.result !== null)).toBe(true);
    expect(r.rigRecommendation?.kind).toBe('not-compared');
  });
});

describe('P.10 item 14: pre-amendment snapshot, recalculated', () => {
  // EASY GO! shipped both sails `estimated` before the cutover, so that is what
  // a saved plan's snapshot carries.
  const oldBoat = boatSnapshot({
    ...EASY_GO,
    sails: EASY_GO.sails.map((s) => ({
      ...s,
      polarProvenance: { ...s.polarProvenance, tier: 'estimated' as const },
    })),
  });
  const saved = { request: { ...REQ, boat: oldBoat } } as unknown as Plan;

  it('recalculated run uses the own polar assets and renders the estimated not-compared copy', () => {
    expect(EASY_GO.sails.map((s) => s.polarAsset)).toEqual([
      'data/polars/salona-44-easy-go-genoa.json',
      'data/polars/salona-44-easy-go-fock.json',
    ]);
    const req = recalcRequest(saved, REQ.departureMs);
    const r = planRoute(req, uniformWindGrid(12, 0), {
      polars: loadedPolars(),
      boat: EASY_GO,
      mask: openWaterMask(),
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.rigRecommendation?.kind).toBe('not-compared');
    const recalculated = { request: req, result: r } as unknown as Plan;
    expect(rigComparisonSuppressedByTier(recalculated)).toBe(true);
    expect(en['route.rigNotComparedEstimated']).toContain('{tier}');
  });
});

describe('P.10 item 15: picker notes (jsdom half)', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('renders the draft and both polar notes verbatim', () => {
    localStorage.setItem('sc-lang', 'en');
    render(
      createElement(
        I18nProvider,
        null,
        createElement(BoatPicker, {
          boatId: 'salona-44-easy-go',
          onBoatIdChange: vi.fn(),
          settings: DEFAULT_SETTINGS,
          onSettingsChange: vi.fn(),
          originHarborId: null,
          destinationHarborId: null,
        }),
      ),
    );
    const radio = document.getElementById('boat-option-salona-44-easy-go');
    const text = radio?.closest('.boat-option')?.textContent ?? '';
    expect(text.length).toBeGreaterThan(0);
    for (const note of [
      EASY_GO.draftProvenance.note,
      ...EASY_GO.sails.map((s) => s.polarProvenance.note),
    ])
      expect(text).toContain(note);
    // jsdom computes no layout, so horizontal overflow at >= 820 px (P.10
    // item 15) is not observable here; it is left to the real-browser pass.
  });
});
