import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { uniformWindGrid, OFF_CATALOGUE_BOAT } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot, type PlanRequest } from '../types';
import { solverTimeoutMs } from '../test/timeouts';

/**
 * #553 / spec §I.3 — `RoutingClient.plan()` must solve with the boat the
 * REQUEST names, resolved against the catalogue at the boundary.
 *
 * THE DEFECT THIS PINS. `plan()` used to call
 * `buildPlanMessage(request, DEFAULT_BOAT_ID, …)` — a CONSTANT — with a
 * comment saying "Deliberately NOT `request.boat.id`". `protocol.ts` then does
 * `boat: boatById(req.boatId)`, and `PlanDeps.boat` selects BOTH the polar
 * tables (`polarFor` keys on `deps.boat.id`) and the spec §C.4(a) relaxation
 * floor (`relaxationFloorM(deps.boat)`, derived from DRAFT). So a second
 * boat's plan would have been solved with the Salona 45's polars and the
 * Salona 45's depth floor while the UI reported the user's own boat from
 * `request.boat`. Harmless at a one-entry catalogue; a silent safety error at
 * two.
 *
 * WHY A CATALOGUE STUB IS REQUIRED, and this is the whole methodological
 * point of the file. With the real single-boat catalogue,
 * `request.boat.id === DEFAULT_BOAT_ID === 'salona-45'`, so the fixed code and
 * the defective code emit a BYTE-IDENTICAL `plan` message. A test written
 * against the real catalogue would pass under both and its green would carry
 * ZERO information — this repo's documented "a mutation that cannot REACH the
 * code path under test is zero evidence" trap. `vi.mock` therefore widens
 * BOATS with a SECOND entry, via `importOriginal` so every other export
 * (`boatById`, `polarKey`, `DEFAULT_BOAT_ID`) stays real and `DEFAULT_BOAT_ID`
 * keeps pointing at `salona-45`. The request then names `probe-44`, and the
 * two versions of the code disagree observably: `probe-44` vs `salona-45`.
 * Measured mutation results are in the PR report.
 */

// `vi.mock`'s factory is HOISTED above every top-level declaration in this
// file, so the stub boat has to be created by `vi.hoisted` — a plain `const`
// above the mock still reads as "Cannot access before initialization"
// (measured: that was this file's first shape and it failed at collection with
// 0 tests, not with a normal assertion failure).
const { PROBE_BOAT } = vi.hoisted(() => ({
  PROBE_BOAT: {
    id: 'probe-44',
    name: 'Probe 44',
    // Deliberately NOT 2.1: draft is what the relaxation floor is derived
    // from, so a distinct value makes a boat mix-up detectable downstream too.
    draftM: 2.55,
    // Required on BoatDef since #563. Unused by every row here (which read
    // only `id`), but a catalogue entry missing it is not a BoatDef, and a
    // fixture that only looks like one is the kind of thing a later stricter
    // mock turns into a puzzle.
    draftProvenance: {
      keel: 'deep/racing',
      hullVerified: false,
      note: 'test stub — not a real hull',
    },
    motorSpeedKn: 6.0,
    maneuverPenaltyS: 50,
    sails: [
      {
        id: 'genoa',
        label: 'Probe Genoa',
        polarAsset: 'data/polars/probe-44-genoa.json',
        polarProvenance: { tier: 'estimated' as const, note: 'test stub' },
      },
      {
        id: 'fock',
        label: 'Probe Jib',
        polarAsset: 'data/polars/probe-44-fock.json',
        polarProvenance: { tier: 'estimated' as const, note: 'test stub' },
      },
    ],
  },
}));

vi.mock('../data/boats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/boats')>();
  return { ...actual, BOATS: [...actual.BOATS, PROBE_BOAT] };
});

// Imported AFTER the vi.mock factory above is registered (vitest hoists
// `vi.mock`, so ordering here is presentational, not load-bearing) — but the
// module under test must be imported so it picks up the widened catalogue.
const { RoutingClient, RoutingError, buildPlanMessage, catalogueBoatId } =
  await import('./workerClient');

const TEST_TIMEOUT_MS = solverTimeoutMs(5000);

function fakeWorker() {
  return {
    onmessage: null as ((e: MessageEvent<WorkerResponse>) => void) | null,
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
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function requestFor(boat: PlanRequest['boat']): PlanRequest {
  return {
    origin: { lat: 54.7525, lon: 10.0025 },
    destination: { lat: 54.7525, lon: 10.3025 },
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: null,
    departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
    settings: DEFAULT_SETTINGS,
    sailIds: ['genoa', 'fock'],
    boat,
  };
}

/** The `plan` message the client posted, or a loud failure. */
function lastPlanMessage(posted: readonly WorkerRequest[]) {
  const sent = posted[posted.length - 1];
  if (!sent || sent.type !== 'plan') {
    throw new Error(`expected a plan message, got ${sent ? sent.type : 'nothing posted'}`);
  }
  return sent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#553 plan() resolves the REQUEST boat, never DEFAULT_BOAT_ID', () => {
  it(
    'posts the request boat id — probe-44, not the catalogue default salona-45',
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });
      const p = client.plan(requestFor(PROBE_BOAT), uniformWindGrid(12, 0));
      // The fake worker never replies; the promise stays pending. Swallow it so
      // the dispose() below cannot surface as an unhandled rejection.
      p.catch(() => {});
      await flush();

      const sent = lastPlanMessage(w.posted);
      // THE discriminating assertion. Reverting the call site to
      // DEFAULT_BOAT_ID makes this read 'salona-45'.
      expect(sent.boatId).toBe('probe-44');
      // The polar keys are derived from that SAME id inside buildPlanMessage,
      // so this is a second, independent read of the same decision: a client
      // that named the right boat but fetched the default's tables would be
      // just as wrong, and `sent.boatId` alone could not see it.
      expect(sent.polarKeys).toEqual(['probe-44/genoa', 'probe-44/fock']);
      client.dispose();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'CONTROL: a request naming the default boat still posts salona-45',
    async () => {
      // Without this row the assertion above is satisfiable by a client that
      // posts the string 'probe-44' unconditionally. It also pins that the fix
      // is a no-op for every plan the app makes today.
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });
      const p = client.plan(requestFor(defaultBoatSnapshot()), uniformWindGrid(12, 0));
      p.catch(() => {});
      await flush();

      const sent = lastPlanMessage(w.posted);
      expect(sent.boatId).toBe('salona-45');
      expect(sent.polarKeys).toEqual(['salona-45/genoa', 'salona-45/fock']);
      client.dispose();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a boat the catalogue no longer holds as a TYPED boat-not-in-catalogue failure',
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });

      const err = await client
        .plan(requestFor(OFF_CATALOGUE_BOAT), uniformWindGrid(12, 0))
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RoutingError);
      // The KIND is the contract — never the message text. Classifying by
      // message is the #282/#411 label-as-control-input coupling.
      expect((err as InstanceType<typeof RoutingError>).kind).toBe('boat-not-in-catalogue');
      // The offending id is named, so a bug report identifies the boat.
      expect((err as Error).message).toContain('gone-45');
      // Rejected BEFORE anything was posted: no plan message, so no worker
      // state to unwind and no chance of the worker throwing on boatById.
      expect(w.posted.filter((m) => m.type === 'plan')).toHaveLength(0);
      client.dispose();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('#553 catalogueBoatId', () => {
  it('resolves a catalogue id and returns null for one that is absent', () => {
    expect(catalogueBoatId('salona-45')).toBe('salona-45');
    expect(catalogueBoatId('probe-44')).toBe('probe-44');
    expect(catalogueBoatId('gone-45')).toBeNull();
    // Not a prefix/substring match: 'salona' must not resolve to 'salona-45'.
    expect(catalogueBoatId('salona')).toBeNull();
    expect(catalogueBoatId('')).toBeNull();
  });
});

describe('#553 buildPlanMessage keys polars by the boat it is given', () => {
  it('uses the passed boatId for both the field and the polar keys', () => {
    // Narrowed through `catalogueBoatId` rather than cast, so this row also
    // exercises the real string -> BoatId crossing instead of asserting it away.
    const boatId = catalogueBoatId('probe-44');
    expect(boatId).not.toBeNull();
    const msg = buildPlanMessage(requestFor(PROBE_BOAT), boatId!, {
      id: 'plan-1',
      windGrid: uniformWindGrid(12, 0),
    });
    expect(msg.boatId).toBe('probe-44');
    expect(msg.polarKeys).toEqual(['probe-44/genoa', 'probe-44/fock']);
    // exactOptionalPropertyTypes: an absent budget omits the key entirely.
    expect('budgetMs' in msg).toBe(false);
  });
});
