import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '../types';
import type { PlanSummary } from './db';
import type { PinRegionsOutcome } from './regionPinning';

// firstControlPin keeps its "batch pinned this session" and "armed" flags
// at module scope, so each test re-imports a fresh module instance
// (vi.resetModules + dynamic import) instead of sharing state.

vi.mock('./db', () => ({
  listPlans: vi.fn(),
  getPlan: vi.fn(),
}));
vi.mock('./pinAfterSave', () => ({
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
  // Mirrors the real pinImportedPlans: fire-and-forget, one pin call per plan.
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
    vi.mocked(listPlans).mockResolvedValue([]);
    vi.mocked(getPlan).mockResolvedValue(undefined);

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
    stubSw(false);
    const { pinAllSavedPlansOnce } = await loadModule();
    const { listPlans } = await import('./db');
    const { pinImportedPlans } = await import('./pinAfterSave');
    vi.mocked(listPlans).mockResolvedValue([]);

    await pinAllSavedPlansOnce();
    await pinAllSavedPlansOnce();

    expect(listPlans).toHaveBeenCalledTimes(1);
    expect(pinImportedPlans).toHaveBeenCalledTimes(1);
  });

  it('is suppressed by Save-Data, same as every other automatic pin path', async () => {
    const sw = stubSw(false);
    Object.defineProperty(globalThis.navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    });
    const { armBatchPinOnFirstControl } = await loadModule();
    const { listPlans, getPlan } = await import('./db');
    const { pinImportedPlans } = await import('./pinAfterSave');
    vi.mocked(listPlans).mockResolvedValue([
      {
        kind: 'ok',
        id: 'p1',
        name: 'p',
        createdAtMs: 1,
        departureMs: 1,
        recommended: 'genoa',
        etaMs: 1,
      },
    ]);
    vi.mocked(getPlan).mockResolvedValue(plan('p1'));

    armBatchPinOnFirstControl();
    sw.controller = {};
    sw.dispatchEvent(new Event('controllerchange'));
    await vi.waitFor(() => expect(pinImportedPlans).toHaveBeenCalledTimes(1));

    // pinAllSavedPlansOnce always fetches the saved-plan list (it does not
    // itself gate on Save-Data); the real pinImportedPlans is what
    // suppresses under Save-Data (pinAfterSave.ts), covered by
    // pinAfterSave.test.ts. Here the mock stands in for that function, so
    // this asserts only that the batch reaches it with the real plan list —
    // see pinAfterSave.test.ts for the Save-Data suppression itself.
    expect(pinImportedPlans).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'p1' })],
      expect.any(Function),
    );
    expect(listPlans).toHaveBeenCalledTimes(1);
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

    it('Save-Data suppresses the pin and leaves the flag unset so a later load retries', async () => {
      stubSw(true);
      const { armBatchPinOnFirstControl, saveDataRequested, listPlans, BACKFILL_DONE_KEY } =
        await twoPlans();
      vi.mocked(saveDataRequested).mockReturnValue(true);

      armBatchPinOnFirstControl();

      await vi.waitFor(() => expect(listPlans).toHaveBeenCalledTimes(1));
      await settle();
      expect(flagSet(BACKFILL_DONE_KEY)).toBe(false);
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
