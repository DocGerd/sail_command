// #1393, rescoped by #1575. Two facts about a plain default-settings boat
// switch, both pinned against the real committed mask and harbours.
//
// (1) Among the boats whose own default gate is <= 3.0 m (Salona 45, SPEEDY
// GO!, PIRANJA), a switch never produces `unreachable`, and all of them read
// identical per-harbour access at each such depth. `clampSettingsToBoat` never
// lowers the gate (spec C.7), so a Salona (3.0 m) -> Elan (2.8 m default)
// switch leaves the live depth at 3.0 m.
//
// (2) EASY GO! (2.59 m draft, 3.5 m default gate) BREAKS the old "a default
// switch never announces an unreachable endpoint" invariant on purpose: the
// clamp raises a switch INTO it to 3.5 m, where augustenborg and marstal read
// `unreachable`, so the #1325 endpoint-unreachable announcement is reachable
// from a plain default switch. `BoatPicker.harborAccess.test.tsx`'s #1325
// block pins the announcement's wording; `app/e2e/harbor-access-markers.spec.ts`
// pins it end to end.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NavMask } from '../lib/mask';
import { BOATS, boatById, type BoatDef } from '../data/boats';
import { defaultSafetyDepthM } from '../lib/boatDepth';
import { clampSettingsToBoat } from '../lib/boatSettings';
import { computeHarborAccess, type HarborWithReachability } from '../lib/harborReachability';
import { DEFAULT_SETTINGS } from '../types';
import type { MaskMeta } from '../types';
import { solverTimeoutMs } from './timeouts';

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
const maskBytes = new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin')));
const mask = new NavMask(maskMeta, maskBytes);
const harbors = JSON.parse(
  readFileSync(resolve(dataDir, 'harbors.json'), 'utf8'),
) as HarborWithReachability[];

const SHALLOW_GATE_MAX_M = 3.0;
const EASY_GO = boatById('salona-44-easy-go');

// Derived (never hardcoded) so a catalogue draft change updates the sets
// rather than silently narrowing what gets checked.
const SHALLOW_BOATS = BOATS.filter((b) => defaultSafetyDepthM(b) <= SHALLOW_GATE_MAX_M);
const SHALLOW_DEPTHS = [...new Set(SHALLOW_BOATS.map((b) => defaultSafetyDepthM(b)))];
const CASES = SHALLOW_BOATS.flatMap((boat) => SHALLOW_DEPTHS.map((depth) => ({ boat, depth })));

function unreachableAt(boat: BoatDef, depth: number): string[] {
  return [...computeHarborAccess(mask, harbors, boat, depth).entries()]
    .filter(([, state]) => state === 'unreachable')
    .map(([id]) => id)
    .sort();
}

describe('#1393: a default switch among the boats gated <= 3.0 m never reaches unreachable', () => {
  it('the scoped sets are non-empty and exclude EASY GO! (non-vacuity)', () => {
    expect(SHALLOW_BOATS.length).toBeGreaterThan(1);
    expect(SHALLOW_DEPTHS.length).toBeGreaterThan(1);
    expect(SHALLOW_BOATS.map((b) => b.id)).not.toContain(EASY_GO.id);
  });

  it.each(CASES)(
    '$boat.id at depth $depth: 0 unreachable',
    { timeout: solverTimeoutMs(300_000) },
    ({ boat, depth }) => {
      expect(unreachableAt(boat, depth)).toEqual([]);
    },
  );

  it.each(SHALLOW_DEPTHS)(
    'at depth %s m, every boat gated <= 3.0 m reads the same per-harbour access',
    { timeout: solverTimeoutMs(300_000) },
    (depth) => {
      const maps = SHALLOW_BOATS.map((boat) => computeHarborAccess(mask, harbors, boat, depth));
      for (const harbor of harbors) {
        const states = maps.map((m) => m.get(harbor.id));
        expect(
          states.every((s) => s === states[0]),
          `${harbor.id}: ${states.join(', ')}`,
        ).toBe(true);
      }
    },
  );
});

describe('#1575: a default switch INTO EASY GO! can reach unreachable, and only there', () => {
  it('EASY GO! at its own default gate reads exactly augustenborg and marstal unreachable', () => {
    const gate = defaultSafetyDepthM(EASY_GO);
    expect(gate).toBe(3.5);
    const unreachable = unreachableAt(EASY_GO, gate);
    expect(unreachable.length).toBeGreaterThan(0);
    expect(unreachable).toEqual(['augustenborg', 'marstal']);
  });

  it.each(SHALLOW_BOATS)(
    'a switch from $id at its default depth is clamped UP to EASY GO!’s 3.5 m gate',
    (from) => {
      const stored = { ...DEFAULT_SETTINGS, safetyDepthM: defaultSafetyDepthM(from) };
      const { settings, clamped } = clampSettingsToBoat(stored, EASY_GO);
      expect(clamped).toBe(true);
      expect(settings.safetyDepthM).toBe(3.5);
    },
  );

  it.each(SHALLOW_BOATS)(
    'switching back from EASY GO! keeps 3.5 m, where $id reads only augustenborg unreachable',
    { timeout: solverTimeoutMs(300_000) },
    (to) => {
      const stored = { ...DEFAULT_SETTINGS, safetyDepthM: 3.5 };
      const { settings, clamped } = clampSettingsToBoat(stored, to);
      expect(clamped).toBe(false);
      expect(settings.safetyDepthM).toBe(3.5);
      expect(unreachableAt(to, settings.safetyDepthM)).toEqual(['augustenborg']);
    },
  );
});
