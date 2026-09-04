import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDepartureScan, type DepartureScanRequest } from './useDepartureScan';
import type { ReplanClient } from './replan';
import { RoutingError } from '../routing/workerClient';
import { uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  defaultBoatSnapshot,
  type LatLon,
  type PlanRequest,
  type PlanResultOk,
  type PlanResultError,
} from '../types';

const ORIGIN: LatLon = { lat: 54.75, lon: 10.0 };
const DESTINATION: LatLon = { lat: 54.75, lon: 10.4 };
const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);

function makeBase(
  overrides: Partial<Omit<PlanRequest, 'sailIds'>> = {},
): Omit<PlanRequest, 'sailIds'> {
  return {
    origin: ORIGIN,
    destination: DESTINATION,
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: null,
    departureMs: DEPARTURE_MS,
    settings: DEFAULT_SETTINGS,
    boat: defaultBoatSnapshot(),
    ...overrides,
  };
}

function okResult(distanceNm: number): PlanResultOk {
  return {
    status: 'ok',
    sails: [
      {
        sailId: 'genoa',
        result: {
          sailId: 'genoa',
          legs: [],
          etaMs: DEPARTURE_MS + 3_600_000,
          durationMs: 3_600_000,
          distanceNm,
          maneuverCount: 0,
          motorDistanceNm: 0,
        },
        reason: null,
      },
    ],
    recommended: 'genoa',
    comparisonComplete: true,
    snappedOrigin: ORIGIN,
    snappedDestination: DESTINATION,
  };
}

const NO_ROUTE_RESULT: PlanResultError = { status: 'error', reason: 'beyond-horizon' };

function makeRequest(overrides: Partial<DepartureScanRequest> = {}): DepartureScanRequest {
  return {
    base: makeBase(),
    windGrid: uniformWindGrid(12, 0, { t0Ms: DEPARTURE_MS - 3_600_000, hours: 96 }),
    stepHours: 3,
    count: 4,
    ...overrides,
  };
}

describe('useDepartureScan', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useDepartureScan(() => Promise.resolve(null)));
    expect(result.current.state).toEqual({
      scanning: false,
      index: 0,
      total: 0,
      candidates: [],
      error: null,
      cancelled: false,
    });
  });

  it('a failed ensureClient surfaces error.workerInit, not a silent no-op', async () => {
    const ensureClient = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => useDepartureScan(ensureClient));

    await act(async () => {
      await result.current.scan(makeRequest());
    });

    expect(ensureClient).toHaveBeenCalledTimes(1);
    expect(result.current.state.error).toBe('error.workerInit');
    expect(result.current.state.candidates).toEqual([]);
  });

  // #356a §2.2 — THE key correctness constraint: every candidate solve must
  // request the genoa ALONE, regardless of what sailIds the active plan
  // itself carries (a plan typically requests both). Mutation-checked below.
  it('scans the genoa alone at every candidate, never the sails the base request carries', async () => {
    const plan = vi.fn().mockResolvedValue(okResult(10));
    const client: ReplanClient = { plan };
    const { result } = renderHook(() => useDepartureScan(() => Promise.resolve(client)));

    await act(async () => {
      await result.current.scan(makeRequest({ base: makeBase(), count: 3, stepHours: 1 }));
    });

    expect(plan).toHaveBeenCalledTimes(3);
    for (const call of plan.mock.calls) {
      const req = call[0] as PlanRequest;
      expect(req.sailIds).toEqual(['genoa']);
    }
  });

  it('steps departureMs forward by stepHours from the base departure, one candidate per hour offset', async () => {
    const plan = vi.fn().mockResolvedValue(okResult(10));
    const client: ReplanClient = { plan };
    const { result } = renderHook(() => useDepartureScan(() => Promise.resolve(client)));

    await act(async () => {
      await result.current.scan(makeRequest({ stepHours: 3, count: 4 }));
    });

    const departures = plan.mock.calls.map((c) => (c[0] as PlanRequest).departureMs);
    expect(departures).toEqual([
      DEPARTURE_MS,
      DEPARTURE_MS + 3 * 3_600_000,
      DEPARTURE_MS + 6 * 3_600_000,
      DEPARTURE_MS + 9 * 3_600_000,
    ]);
    expect(result.current.state.candidates.map((c) => c.departureMs)).toEqual(departures);
  });

  it('classifies each candidate outcome: ok, no-route (beyond-horizon), and failed (a rejected plan())', async () => {
    const plan = vi
      .fn()
      .mockResolvedValueOnce(okResult(12))
      .mockResolvedValueOnce(NO_ROUTE_RESULT)
      .mockRejectedValueOnce(new RoutingError('boat-not-in-catalogue', 'nope'));
    const client: ReplanClient = { plan };
    const { result } = renderHook(() => useDepartureScan(() => Promise.resolve(client)));

    await act(async () => {
      await result.current.scan(makeRequest({ count: 3 }));
    });

    const outcomes = result.current.state.candidates.map((c) => c.outcome.kind);
    expect(outcomes).toEqual(['ok', 'no-route', 'failed']);
    expect(result.current.state.candidates[1]?.outcome).toEqual({
      kind: 'no-route',
      reason: 'beyond-horizon',
    });
    expect(result.current.state.candidates[2]?.outcome).toEqual({
      kind: 'failed',
      messageKey: 'error.boatNotInCatalogue',
    });
  });

  it('a worker-killing failure (not boat-not-in-catalogue) disposes the client and stops scanning the rest', async () => {
    const dispose = vi.fn();
    const plan = vi
      .fn()
      .mockResolvedValueOnce(okResult(10))
      .mockRejectedValueOnce(new RoutingError('worker-fatal', 'boom'));
    const client: ReplanClient = { plan, dispose };
    const { result } = renderHook(() => useDepartureScan(() => Promise.resolve(client)));

    await act(async () => {
      await result.current.scan(makeRequest({ count: 5 }));
    });

    expect(plan).toHaveBeenCalledTimes(2); // never reached candidates 3-5
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(result.current.state.candidates).toHaveLength(2);
    expect(result.current.state.candidates[1]?.outcome).toEqual({
      kind: 'failed',
      messageKey: 'error.routingFailed',
    });
    expect(result.current.state.cancelled).toBe(false); // distinct from a user cancel
  });

  // §4 residual: cancel() lets the CURRENT window's solve finish and skips
  // the rest — never mid-solve. The cancel flag is set while candidate 0's
  // plan() promise is still pending, so it must complete before the loop
  // stops.
  it('cancel() finishes the in-flight candidate, then skips the rest', async () => {
    let resolveFirst!: (r: PlanResultOk) => void;
    const plan = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PlanResultOk>((res) => {
            resolveFirst = res;
          }),
      )
      .mockResolvedValue(okResult(10));
    const client: ReplanClient = { plan };
    const { result } = renderHook(() => useDepartureScan(() => Promise.resolve(client)));

    let scanPromise!: Promise<void>;
    act(() => {
      scanPromise = result.current.scan(makeRequest({ count: 6 }));
    });
    await waitFor(() => expect(result.current.state.scanning).toBe(true));

    act(() => {
      result.current.cancel();
    });

    await act(async () => {
      resolveFirst(okResult(10));
      await scanPromise;
    });

    expect(plan).toHaveBeenCalledTimes(1); // only the in-flight one ever ran
    expect(result.current.state.scanning).toBe(false);
    expect(result.current.state.cancelled).toBe(true);
    expect(result.current.state.candidates).toHaveLength(1);
  });

  it('a second scan() call while one is in flight is a guarded no-op', async () => {
    let resolveFirst!: (r: PlanResultOk) => void;
    const plan = vi.fn().mockImplementation(
      () =>
        new Promise<PlanResultOk>((res) => {
          resolveFirst = res;
        }),
    );
    const ensureClient = vi.fn().mockResolvedValue({ plan } satisfies ReplanClient);
    const { result } = renderHook(() => useDepartureScan(ensureClient));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.scan(makeRequest({ count: 1 }));
      second = result.current.scan(makeRequest({ count: 1 }));
    });
    await waitFor(() => expect(ensureClient).toHaveBeenCalledTimes(1));

    // Exactly one plan() call is in flight (candidate 0 of the FIRST scan —
    // the second call's synchronous busyRef guard means it never reaches
    // ensureClient/plan at all), so one resolve is enough to let both
    // promises settle.
    await act(async () => {
      resolveFirst(okResult(10));
      await Promise.all([first, second]);
    });

    expect(ensureClient).toHaveBeenCalledTimes(1);
    expect(plan).toHaveBeenCalledTimes(1);
  });
});
