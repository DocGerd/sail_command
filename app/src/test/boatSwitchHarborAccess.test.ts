// #1393. `harborReachability.test.ts`'s own it.each(BOATS) row already pins
// "0 unreachable" for every catalogue boat AT ITS OWN default depth (2.8 m
// Elan, 3.0 m both Salonas). That leaves one combo a plain default-settings
// boat switch can still reach untested: `clampSettingsToBoat` never lowers
// the gate (spec C.7), so switching a Salona (3.0 m) -> Elan (2.8 m default)
// leaves the live depth at 3.0 m — Elan evaluated at the OTHER boat's
// default, not its own. This file closes that gap: every catalogue boat at
// BOTH real default depths, plus a cross-boat identity check at each depth.
//
// Together with `BoatPicker.harborAccess.test.tsx`'s #1325 describe block
// (which measures 4.0 m — an artificially raised depth well above either
// real default — as the shallowest depth that exercises the endpoint-
// unreachable clause at all), this pins that the #1325 clause structurally
// cannot fire from a plain boat switch at default settings among the three
// shipped catalogue boats.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NavMask } from '../lib/mask';
import { BOATS } from '../data/boats';
import { defaultSafetyDepthM } from '../lib/boatDepth';
import { computeHarborAccess, type HarborWithReachability } from '../lib/harborReachability';
import type { MaskMeta } from '../types';
import { solverTimeoutMs } from './timeouts';

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
const maskBytes = new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin')));
const mask = new NavMask(maskMeta, maskBytes);
const harbors = JSON.parse(
  readFileSync(resolve(dataDir, 'harbors.json'), 'utf8'),
) as HarborWithReachability[];

// The only two depths a plain default-settings switch among the three
// shipped boats can ever produce: each boat's own defaultSafetyDepthM,
// derived here (never hardcoded) so a catalogue draft change updates this
// set automatically rather than silently narrowing what gets checked.
const REAL_DEFAULT_DEPTHS = [...new Set(BOATS.map((b) => defaultSafetyDepthM(b)))];

const CASES = BOATS.flatMap((boat) => REAL_DEFAULT_DEPTHS.map((depth) => ({ boat, depth })));

describe('#1393: boat switch at default settings never reaches unreachable', () => {
  it.each(CASES)(
    '$boat.id at depth $depth: 0 unreachable',
    { timeout: solverTimeoutMs(300_000) },
    ({ boat, depth }) => {
      const result = computeHarborAccess(mask, harbors, boat, depth);
      const unreachable = [...result.entries()]
        .filter(([, state]) => state === 'unreachable')
        .map(([id]) => id);
      expect(unreachable).toEqual([]);
    },
  );

  it.each(REAL_DEFAULT_DEPTHS)(
    'at depth %s m, every catalogue boat reads the same per-harbour access',
    { timeout: solverTimeoutMs(300_000) },
    (depth) => {
      const maps = BOATS.map((boat) => computeHarborAccess(mask, harbors, boat, depth));
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
