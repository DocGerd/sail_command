import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NavMask } from '../lib/mask';
import { buildDepthImageData, depthCanvasRowMap } from '../lib/depthColor';
import { floodFromSeed, type FloodQueueTrace } from '../lib/harborReachability';
import type { MaskMeta } from '../types';
import { solverTimeoutMs } from './timeouts';

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
const maskBytes = new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin')));
const mask = new NavMask(maskMeta, maskBytes);

// Pins the reachable set of the flood fill, so any change of its queue
// representation must leave the bitset byte-identical.
const FLOOD_GOLDEN_SHA256: ReadonlyArray<readonly [number, string]> = [
  [2.2, 'bc485e01a03f20f25bc57d700b5aa666de7984fc897b3875c168650d3e3d1965'],
  [3.0, 'be2d0560aab7256210a5dab250959da07212b2213ef5a4052eb510357ff47763'],
  [4.0, 'f088b58437579e23b0aac9b1fafa845cdc2730d3c3a35d19fcb67e92833de5b4'],
];

const DEPTH_IMAGE_GOLDEN_SHA256 =
  '696e476ba59f59a69fd00e4451a02d2bb542170f22a3f95d067c0ce75b221402';

describe('floodFromSeed golden bitsets on the committed mask', () => {
  it.each(FLOOD_GOLDEN_SHA256)(
    'gate %s m',
    (gateM, expected) => {
      const trace: FloodQueueTrace = {};
      const flood = floodFromSeed(mask, gateM, trace);
      expect(trace.peakCapacity).toBeLessThan(maskMeta.rows * maskMeta.cols);
      expect(flood.rows).toBe(maskMeta.rows);
      expect(flood.cols).toBe(maskMeta.cols);
      expect(createHash('sha256').update(flood.bits).digest('hex')).toBe(expected);
    },
    solverTimeoutMs(60_000),
  );

  // The production start capacity is never outgrown on the committed mask, so
  // the doubling path is forced with a tiny start.
  it.each(FLOOD_GOLDEN_SHA256)(
    'gate %s m with a forced-growth queue',
    (gateM, expected) => {
      const reference: FloodQueueTrace = { recordOrder: true };
      floodFromSeed(mask, gateM, reference);
      const trace: FloodQueueTrace = { initialCapacity: 1 << 6, recordOrder: true };
      const flood = floodFromSeed(mask, gateM, trace);
      expect(trace.peakCapacity).toBeGreaterThan(1 << 6);
      expect(reference.orderHash).toBeDefined();
      expect(trace.orderHash).toBe(reference.orderHash);
      expect(createHash('sha256').update(flood.bits).digest('hex')).toBe(expected);
    },
    solverTimeoutMs(60_000),
  );
});

describe('buildDepthImageData golden RGBA on the committed mask', () => {
  it(
    'matches the pinned sha256',
    () => {
      const rowMap = depthCanvasRowMap(maskMeta);
      const rgba = buildDepthImageData(maskBytes, maskMeta.rows, maskMeta.cols, rowMap);
      expect(rgba.length).toBe(rowMap.length * maskMeta.cols * 4);
      expect(createHash('sha256').update(rgba).digest('hex')).toBe(DEPTH_IMAGE_GOLDEN_SHA256);
    },
    solverTimeoutMs(60_000),
  );
});
