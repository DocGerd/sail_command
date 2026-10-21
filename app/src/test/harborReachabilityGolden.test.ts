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
  [2.2, '6cc039f904e41f3618cb2976389c94a86cabed8c4b69409d0826f03014121d7b'],
  [3.0, '881ea099316a6b4d8460ff455d867ea9c9dbe3ffb2eba5c9d26f753633229b4a'],
  [4.0, '485ce1f3c48f43b6b192ee1515718c72dfead96d37b260b281326ce19ffb990d'],
];

const DEPTH_IMAGE_GOLDEN_SHA256 =
  '4fddd4d294aac1a9cd0bda40d1e5ef70f69793ccbe589360b67e1b41f0298f80';

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
