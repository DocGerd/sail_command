import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '../types';
import type { PlanSummary } from './db';
import type { PinRegionsOutcome } from './regionPinning';
import { BACKFILL_MAX_FAILURES } from './firstControlPin';

// firstControlPin keeps its "batch pinned this session" and "armed" flags
// at module scope, so each test re-imports a fresh module instance
// (vi.resetModules + dynamic import) instead of sharing state.

vi.mock('./db', () => ({
  listPlans: vi.fn(),
  getPlan: vi.fn(),
}));
vi.mock('./pinAfterSave', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pinAfterSave')>()),
  pinImportedPlans: vi.fn(),
  canPinRegions: vi.fn(),
  saveDataRequested: vi.fn(),
}));
vi.mock('./regionPinning', () => ({
  pinRegionsForPlan: vi.fn(),
}));

const plan = (id: string): Plan => ({ id, createdAtMs: 1 }) as unknown as Plan;

const okSummary = (id: string): PlanSummary => ({
  kind: 'ok',
  id,
  name: id,
  createdAtMs: 1,
  departureMs: 1,
  recommended: 'genoa',
  etaMs: 1,
});

const FULL: PinRegionsOutcome = { status: 'pinned', total: 2, pinned: 2 };

class FakeSwContainer extends EventTarget {
  controller: object | null = null;
}

function stubSw(controlled: boolean): FakeSwContainer {
  const sw = new FakeSwContainer();
  if (controlled) sw.controller = {};
  vi.stubGlobal('navigator', { serviceWorker: sw });
  return sw;
}

async function loadModule() {
  vi.resetModules();
  const mod = await import('./firstControlPin');
  const { pinImportedPlans, canPinRegions, saveDataRequested } = await import('./pinAfterSave');
  const { pinRegionsForPlan } = await import('./regionPinning');
  const { listPlans, getPlan } = await import('./db');
  // Models only one `pin` call per plan; the real one also gates and tracks activity.
  vi.mocked(pinImportedPlans).mockImplementation((plans, pin) => {
    void Promise.allSettled(plans.map((p) => pin?.(p)));
  });
  vi.mocked(canPinRegions).mockImplementation(() => navigator.serviceWorker?.controller != null);
  vi.mocked(saveDataRequested).mockReturnValue(false);
  vi.mocked(pinRegionsForPlan).mockResolvedValue(FULL);
  return { ...mod, pinImportedPlans, saveDataRequested, pinRegionsForPlan, listPlans, getPlan };
}

const flagSet = (key: string) => localStorage.getItem(key) === '1';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal('requestIdleCallback', (cb: () => void) => cb());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('armBatchPinOnFirstControl (#1518)', () => {
  it('pins every ok saved plan on the FIRST controllerchange, with no RouteSummary mounted', async () => {
    const sw = stubSw(false);
    const { armBatchPinOnFirstControl } = await loadModule();
    const { listPlans, getPlan } = await import('./db');
    const { pinImportedPlans } = await import('./pinAfterSave');

    const okPlan = plan('ok-plan');
    const summaries: PlanSummary[] = [
      {
        kind: 'ok',
        id: 'ok-plan',
        name: 'o',
        createdAtMs: 1,
        departureMs: 1,
        recommended: 'genoa',
        etaMs: 1,
      },
      // A row migratePlan already refused — must never be fetched or pinned.
      {
        kind: 'unreadable',
        reason: 'damaged',
        id: 'bad-plan',
        name: 'b',
        createdAtMs: 1,
      },
    ];
    vi.mocked(listPlans).mockResolvedValue(summaries);
    vi.mocked(getPlan).mockImplementation(async (id) => (id === 'ok-plan' ? okPlan : undefined));

    armBatchPinOnFirstControl();
    sw.controller = {};
    sw.dispatchEvent(new Event('controllerchange'));
    await vi.waitFor(() => expect(pinImportedPlans).toHaveBeenCalledTimes(1));

    expect(getPlan).toHaveBeenCalledWith('ok-plan');
    expect(getPlan).not.toHaveBeenCalledWith('bad-plan');
    expect(pinImportedPlans).toHaveBeenCalledWith([okPlan], expect.any(Function));
  });

  it('does not listen for controllerchange when already controlled at arm time', async () => {
    const sw = stubSw(true);
    const addEventListener = vi.spyOn(sw, 'addEventListener');
    const { armBatchPinOnFirstControl, listPlans } = await loadModule();
    vi.mocked(listPlans).mockResolvedValue([]);

    armBatchPinOnFirstControl();

    expect(
      addEventListener.mock.calls.filter(([type]) => type === 'controllerchange'),
    ).toHaveLength(0);
  });

  it('runs once per session even across repeated controllerchange events', async () => {
    const sw = stubSw(false);
    const { armBatchPinOnFirstControl } = await loadModule();
    const { listPlans, getPlan } = await import('./db');
    const { pinImportedPlans } = await import('./pinAfterSave');
    vi.mocked(listPlans).mockResolvedValue([okSummary('a')]);
    vi.mocked(getPlan).mockResolvedValue(plan('a'));

    armBatchPinOnFirstControl();
    sw.controller = {};
    sw.dispatchEvent(new Event('controllerchange'));
    await vi.waitFor(() => expect(pinImportedPlans).toHaveBeenCalledTimes(1));

    // { once: true } means the listener itself cannot fire twice; a second
    // dispatch on the same target must not re-run the batch either.
    sw.dispatchEvent(new Event('controllerchange'));
    expect(pinImportedPlans).toHaveBeenCalledTimes(1);
  });

  it("pinAllSavedPlansOnce's own once-flag survives being called directly a second time", async () => {
    stubSw(true);
    const { pinAllSavedPlansOnce } = await loadModule();
    const { listPlans, getPlan } = await import('./db');
    const { pinImportedPlans } = await import('./pinAfterSave');
    vi.mocked(listPlans).mockResolvedValue([okSummary('a')]);
    vi.mocked(getPlan).mockResolvedValue(plan('a'));

    await pinAllSavedPlansOnce();
    await pinAllSavedPlansOnce();

    expect(listPlans).toHaveBeenCalledTimes(1);
    expect(pinImportedPlans).toHaveBeenCalledTimes(1);
  });

  it('Save-Data skips the batch before reading any saved plan', async () => {
    const sw = stubSw(false);
    const { armBatchPinOnFirstControl, saveDataRequested, listPlans, getPlan, pinImportedPlans } =
      await loadModule();
    vi.mocked(saveDataRequested).mockReturnValue(true);
    vi.mocked(listPlans).mockResolvedValue([okSummary('p1')]);
    vi.mocked(getPlan).mockResolvedValue(plan('p1'));

    armBatchPinOnFirstControl();
    sw.controller = {};
    sw.dispatchEvent(new Event('controllerchange'));
    await new Promise((r) => setTimeout(r, 0));

    expect(listPlans).not.toHaveBeenCalled();
    expect(getPlan).not.toHaveBeenCalled();
    expect(pinImportedPlans).not.toHaveBeenCalled();
  });

  it('an uncontrolled page skips the batch before reading any saved plan', async () => {
    stubSw(false);
    const { pinAllSavedPlansOnce, listPlans, pinImportedPlans } = await loadModule();

    await pinAllSavedPlansOnce();

    expect(listPlans).not.toHaveBeenCalled();
    expect(pinImportedPlans).not.toHaveBeenCalled();
  });

  it('stays dormant with no service worker in the environment', async () => {
    vi.stubGlobal('navigator', {});
    const { armBatchPinOnFirstControl } = await loadModule();
    const { pinImportedPlans } = await import('./pinAfterSave');

    expect(() => armBatchPinOnFirstControl()).not.toThrow();
    expect(pinImportedPlans).not.toHaveBeenCalled();
  });

  it('arming is idempotent — a second call never adds a second listener', async () => {
    const sw = stubSw(false);
    const addEventListener = vi.spyOn(sw, 'addEventListener');
    const { armBatchPinOnFirstControl } = await loadModule();

    armBatchPinOnFirstControl();
    armBatchPinOnFirstControl();

    // Assert on the REGISTRATION itself, not on pinAllSavedPlansOnce's own
    // effect — that dedups via a SEPARATE flag (batchPinnedThisSession) and
    // would absorb a duplicate listener firing, making an outcome-only
    // assertion here vacuous for the `armed` guard specifically.
    const controllerchangeCalls = addEventListener.mock.calls.filter(
      ([type]) => type === 'controllerchange',
    );
    expect(controllerchangeCalls).toHaveLength(1);
  });
});

describe('persisted backfill flag (#1533)', () => {
  const twoPlans = async () => {
    const m = await loadModule();
    vi.mocked(m.listPlans).mockResolvedValue([okSummary('a'), okSummary('b')]);
    vi.mocked(m.getPlan).mockImplementation(async (id) => plan(id));
    return m;
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('already-controlled page with the flag absent runs the batch, then sets the flag', async () => {
    stubSw(true);
    const { armBatchPinOnFirstControl, pinImportedPlans, BACKFILL_DONE_KEY } = await twoPlans();

    armBatchPinOnFirstControl();

    await vi.waitFor(() => expect(flagSet(BACKFILL_DONE_KEY)).toBe(true));
    expect(pinImportedPlans).toHaveBeenCalledTimes(1);
    expect(pinImportedPlans).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })],
      expect.any(Function),
    );
  });

  it('already-controlled page with the flag present skips the batch entirely', async () => {
    stubSw(true);
    const { armBatchPinOnFirstControl, listPlans, pinImportedPlans, BACKFILL_DONE_KEY } =
      await twoPlans();
    localStorage.setItem(BACKFILL_DONE_KEY, '1');

    armBatchPinOnFirstControl();
    await settle();

    expect(listPlans).not.toHaveBeenCalled();
    expect(pinImportedPlans).not.toHaveBeenCalled();
  });

  it('the first-controllerchange path still runs the batch when the flag is already set', async () => {
    const sw = stubSw(false);
    const { armBatchPinOnFirstControl, pinImportedPlans, BACKFILL_DONE_KEY } = await twoPlans();
    localStorage.setItem(BACKFILL_DONE_KEY, '1');

    armBatchPinOnFirstControl();
    sw.controller = {};
    sw.dispatchEvent(new Event('controllerchange'));

    await vi.waitFor(() => expect(pinImportedPlans).toHaveBeenCalledTimes(1));
  });

  it('the first-controllerchange batch also sets the flag on success', async () => {
    const sw = stubSw(false);
    const { armBatchPinOnFirstControl, BACKFILL_DONE_KEY } = await twoPlans();

    armBatchPinOnFirstControl();
    sw.controller = {};
    sw.dispatchEvent(new Event('controllerchange'));

    await vi.waitFor(() => expect(flagSet(BACKFILL_DONE_KEY)).toBe(true));
  });

  it('a saved-plan-less profile still completes the backfill', async () => {
    stubSw(true);
    const { armBatchPinOnFirstControl, listPlans, BACKFILL_DONE_KEY } = await loadModule();
    vi.mocked(listPlans).mockResolvedValue([]);

    armBatchPinOnFirstControl();

    await vi.waitFor(() => expect(flagSet(BACKFILL_DONE_KEY)).toBe(true));
  });

  describe('a failed batch leaves the flag unset', () => {
    const outcomes: [string, () => Promise<PinRegionsOutcome>][] = [
      ['a partial pin', async () => ({ status: 'pinned', total: 2, pinned: 1 })],
      ['manifest-unavailable', async () => ({ status: 'manifest-unavailable' })],
      ['pin-record-failed', async () => ({ status: 'pin-record-failed', total: 2, pinned: 2 })],
      ['a rejected pin', async () => Promise.reject(new Error('network'))],
    ];
    it.each(outcomes)('%s', async (_name, outcome) => {
      stubSw(true);
      const { armBatchPinOnFirstControl, pinRegionsForPlan, BACKFILL_DONE_KEY } = await twoPlans();
      vi.mocked(pinRegionsForPlan).mockImplementation(outcome);

      armBatchPinOnFirstControl();

      await vi.waitFor(() => expect(pinRegionsForPlan).toHaveBeenCalledTimes(2));
      await settle();
      expect(flagSet(BACKFILL_DONE_KEY)).toBe(false);
    });

    it('one failing plan among successes', async () => {
      stubSw(true);
      const { armBatchPinOnFirstControl, pinRegionsForPlan, BACKFILL_DONE_KEY } = await twoPlans();
      vi.mocked(pinRegionsForPlan).mockImplementation(async (p) =>
        p.id === 'a' ? FULL : { status: 'manifest-unavailable' },
      );

      armBatchPinOnFirstControl();

      await vi.waitFor(() => expect(pinRegionsForPlan).toHaveBeenCalledTimes(2));
      await settle();
      expect(flagSet(BACKFILL_DONE_KEY)).toBe(false);
    });

    it('a plan deleted mid-batch does not count as a failure', async () => {
      stubSw(true);
      const { armBatchPinOnFirstControl, pinRegionsForPlan, BACKFILL_DONE_KEY } = await twoPlans();
      vi.mocked(pinRegionsForPlan).mockImplementation(async (p) =>
        p.id === 'a' ? FULL : { status: 'plan-gone', total: 2, pinned: 0 },
      );

      armBatchPinOnFirstControl();

      await vi.waitFor(() => expect(flagSet(BACKFILL_DONE_KEY)).toBe(true));
    });

    it('listPlans rejecting', async () => {
      stubSw(true);
      const { armBatchPinOnFirstControl, listPlans, pinImportedPlans, BACKFILL_DONE_KEY } =
        await loadModule();
      vi.mocked(listPlans).mockRejectedValue(new Error('idb'));

      armBatchPinOnFirstControl();

      await vi.waitFor(() => expect(listPlans).toHaveBeenCalledTimes(1));
      await settle();
      expect(pinImportedPlans).not.toHaveBeenCalled();
      expect(flagSet(BACKFILL_DONE_KEY)).toBe(false);
    });

    it('getPlan rejecting for one plan still pins the rest but leaves the flag unset', async () => {
      stubSw(true);
      const { armBatchPinOnFirstControl, getPlan, pinRegionsForPlan, BACKFILL_DONE_KEY } =
        await twoPlans();
      vi.mocked(getPlan).mockImplementation(async (id) => {
        if (id === 'a') throw new Error('idb');
        return plan(id);
      });

      armBatchPinOnFirstControl();

      await vi.waitFor(() => expect(pinRegionsForPlan).toHaveBeenCalledTimes(1));
      await settle();
      expect(flagSet(BACKFILL_DONE_KEY)).toBe(false);
    });

    it('Save-Data leaves the flag and the failure count untouched so a later load retries', async () => {
      stubSw(true);
      const {
        armBatchPinOnFirstControl,
        saveDataRequested,
        listPlans,
        BACKFILL_DONE_KEY,
        BACKFILL_FAILURES_KEY,
      } = await twoPlans();
      vi.mocked(saveDataRequested).mockReturnValue(true);

      armBatchPinOnFirstControl();
      await settle();

      expect(listPlans).not.toHaveBeenCalled();
      expect(flagSet(BACKFILL_DONE_KEY)).toBe(false);
      expect(localStorage.getItem(BACKFILL_FAILURES_KEY)).toBeNull();
    });
  });

  it('a flag write failure does not throw', async () => {
    stubSw(true);
    const { armBatchPinOnFirstControl, pinRegionsForPlan } = await twoPlans();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    armBatchPinOnFirstControl();

    await vi.waitFor(() => expect(pinRegionsForPlan).toHaveBeenCalledTimes(2));
  });

  it('the key is scoped per deployment (prod vs /uat/ share one origin)', async () => {
    vi.stubEnv('BASE_URL', '/sail_command/');
    const prod = (await loadModule()).BACKFILL_DONE_KEY;
    vi.stubEnv('BASE_URL', '/sail_command/uat/');
    const uat = (await loadModule()).BACKFILL_DONE_KEY;

    expect(uat).not.toBe(prod);
  });
});

describe('attempt cap and idle deferral (#1533)', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const oneLoad = async (outcome: PinRegionsOutcome) => {
    stubSw(true);
    const m = await loadModule();
    vi.mocked(m.listPlans).mockResolvedValue([okSummary('a')]);
    vi.mocked(m.getPlan).mockResolvedValue(plan('a'));
    vi.mocked(m.pinRegionsForPlan).mockResolvedValue(outcome);
    return m;
  };
  const FAILED: PinRegionsOutcome = { status: 'manifest-unavailable' };

  it('stops the startup backfill after the capped number of failed loads', async () => {
    for (let i = 1; i <= BACKFILL_MAX_FAILURES; i++) {
      const { armBatchPinOnFirstControl, BACKFILL_FAILURES_KEY } = await oneLoad(FAILED);
      armBatchPinOnFirstControl();
      await vi.waitFor(() => expect(localStorage.getItem(BACKFILL_FAILURES_KEY)).toBe(String(i)));
    }

    const { armBatchPinOnFirstControl, listPlans, pinImportedPlans, BACKFILL_DONE_KEY } =
      await oneLoad(FULL);
    vi.mocked(listPlans).mockClear();
    vi.mocked(pinImportedPlans).mockClear();
    armBatchPinOnFirstControl();
    await settle();

    expect(listPlans).not.toHaveBeenCalled();
    expect(pinImportedPlans).not.toHaveBeenCalled();
    expect(flagSet(BACKFILL_DONE_KEY)).toBe(false);
  });

  it('still runs below the cap, and success sets the flag and clears the count', async () => {
    const { armBatchPinOnFirstControl, BACKFILL_DONE_KEY, BACKFILL_FAILURES_KEY } =
      await oneLoad(FULL);
    localStorage.setItem(BACKFILL_FAILURES_KEY, String(BACKFILL_MAX_FAILURES - 1));

    armBatchPinOnFirstControl();

    await vi.waitFor(() => expect(flagSet(BACKFILL_DONE_KEY)).toBe(true));
    expect(localStorage.getItem(BACKFILL_FAILURES_KEY)).toBeNull();
  });

  it('a corrupt count stops the backfill', async () => {
    const { armBatchPinOnFirstControl, listPlans, BACKFILL_FAILURES_KEY } = await oneLoad(FULL);
    localStorage.setItem(BACKFILL_FAILURES_KEY, 'garbage');

    armBatchPinOnFirstControl();
    await settle();

    expect(listPlans).not.toHaveBeenCalled();
  });

  it('the first-controllerchange path ignores the cap', async () => {
    const sw = stubSw(false);
    const {
      armBatchPinOnFirstControl,
      pinImportedPlans,
      listPlans,
      getPlan,
      BACKFILL_FAILURES_KEY,
    } = await loadModule();
    vi.mocked(listPlans).mockResolvedValue([okSummary('a')]);
    vi.mocked(getPlan).mockResolvedValue(plan('a'));
    localStorage.setItem(BACKFILL_FAILURES_KEY, String(BACKFILL_MAX_FAILURES));

    armBatchPinOnFirstControl();
    sw.controller = {};
    sw.dispatchEvent(new Event('controllerchange'));

    await vi.waitFor(() => expect(pinImportedPlans).toHaveBeenCalledTimes(1));
  });

  it('defers the controlled-at-arm backfill until the browser is idle', async () => {
    let idle: (() => void) | undefined;
    const requestIdleCallback = vi.fn((cb: () => void) => {
      idle = cb;
    });
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    const { armBatchPinOnFirstControl, listPlans } = await oneLoad(FULL);

    armBatchPinOnFirstControl();
    await settle();
    expect(listPlans).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
      timeout: expect.any(Number),
    });

    idle?.();
    await vi.waitFor(() => expect(listPlans).toHaveBeenCalledTimes(1));
  });
});
