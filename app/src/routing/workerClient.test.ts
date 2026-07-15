import { describe, expect, it } from 'vitest';
import { RoutingClient } from './workerClient';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PlanResult, type PolarTable, type Rig } from '../types';

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };

function openWaterBuffer(): ArrayBuffer {
  const data = new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(200);
  return data.buffer;
}

function fakeWorker() {
  const w = {
    onmessage: null as ((e: MessageEvent<WorkerResponse>) => void) | null,
    // Assigned by RoutingClient's constructor (fix A1); tests invoke these
    // directly to simulate the runtime firing them.
    onerror: null as ((e: ErrorEvent) => void) | null,
    onmessageerror: null as ((e: MessageEvent) => void) | null,
    posted: [] as WorkerRequest[],
    postMessage(m: WorkerRequest) {
      this.posted.push(m);
    },
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
  // cell centers (grid step 0.005°): keep the spec-mandated 300 m snap
  // radius and adapt test geometry rather than loosen it.
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

  it('plan() called after dispose() rejects immediately', async () => {
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });
    client.dispose();
    await expect(client.plan(PLAN_REQUEST, uniformWindGrid(12, 0))).rejects.toThrow(/disposed/);
  }, 2000);

  it('plan() resolves with the emitted result and forwards progress intact', async () => {
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });
    const progress: [Rig, number, number][] = [];
    const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0), (rig, tMs, frontierSize) =>
      progress.push([rig, tMs, frontierSize]),
    );
    await flush();
    const sent = w.posted[w.posted.length - 1];
    if (sent.type !== 'plan') throw new Error('expected a plan message');
    w.emit({ type: 'progress', id: sent.id, rig: 'genoa', tMs: 1000, frontierSize: 5 });
    const result: PlanResult = { status: 'error', reason: 'unreachable' };
    w.emit({ type: 'result', id: sent.id, result });
    await expect(p).resolves.toBe(result);
    expect(progress).toEqual([['genoa', 1000, 5]]);
  }, 2000);

  it('two concurrent plan() calls (distinct ids) settle independently', async () => {
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });
    const p1 = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
    const p2 = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
    await flush();
    const [sent1, sent2] = w.posted.slice(-2);
    if (sent1.type !== 'plan' || sent2.type !== 'plan') throw new Error('expected plan messages');
    expect(sent1.id).not.toBe(sent2.id);
    const result: PlanResult = { status: 'error', reason: 'unreachable' };
    w.emit({ type: 'result', id: sent1.id, result });
    w.emit({ type: 'fatal', id: sent2.id, message: 'segment blocked' });
    await expect(p1).resolves.toBe(result);
    await expect(p2).rejects.toThrow(/segment blocked/);
  }, 2000);

  it('worker.onerror fired by the runtime rejects an in-flight plan', async () => {
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });
    const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
    await flush();
    w.onerror?.(new ErrorEvent('error', { message: 'worker crashed' }));
    await expect(p).rejects.toThrow(/worker crashed/);
  }, 2000);
});
