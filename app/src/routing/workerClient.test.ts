import { describe, expect, it } from 'vitest';
import { RoutingClient } from './workerClient';
import type { WorkerResponse } from './protocol';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PolarTable } from '../types';

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };

function openWaterBuffer(): ArrayBuffer {
  const data = new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(200);
  return data.buffer;
}

function fakeWorker() {
  const w = {
    onmessage: null as ((e: MessageEvent<WorkerResponse>) => void) | null,
    postMessage: () => {},
    terminate: () => {},
    emit(m: WorkerResponse) {
      this.onmessage?.({ data: m } as MessageEvent<WorkerResponse>);
    },
  };
  return w;
}

const INIT_ASSETS = {
  maskMeta: TEST_MASK_META,
  maskBuffer: openWaterBuffer(),
  polarGenoa: TEST_POLAR,
  polarFock: FOCK,
};

const PLAN_REQUEST = {
  // cell centers (grid step 0.005°), per 449af00: keep the spec-mandated
  // 300 m snap radius and adapt test geometry rather than loosen it.
  origin: { lat: 54.7525, lon: 10.0025 }, destination: { lat: 54.7525, lon: 10.3025 },
  viaPoints: [], originHarborId: null, destinationHarborId: null,
  departureMs: Date.UTC(2026, 6, 15, 8, 0, 0), settings: DEFAULT_SETTINGS,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('RoutingClient promise settling', () => {
  it('dispose() rejects an in-flight plan', async () => {
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });
    const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
    await flush();
    client.dispose();
    await expect(p).rejects.toThrow(/disposed/);
  }, 2000);

  it('global fatal rejects an in-flight plan', async () => {
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });
    const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
    await flush();
    w.emit({ type: 'fatal', id: null, message: 'mask corrupted' });
    await expect(p).rejects.toThrow(/mask corrupted/);
  }, 2000);

  it('first-init failure rejects init()', async () => {
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    const p = client.init(INIT_ASSETS);
    w.emit({ type: 'fatal', id: null, message: 'bad mask length' });
    await expect(p).rejects.toThrow(/bad mask length/);
  }, 2000);
});
