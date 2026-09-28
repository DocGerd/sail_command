import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '../types';
import type { PlanSummary } from './db';

// firstControlPin keeps its "batch pinned this session" and "armed" flags
// at module scope, so each test re-imports a fresh module instance
// (vi.resetModules + dynamic import) instead of sharing state.

vi.mock('./db', () => ({
  listPlans: vi.fn(),
  getPlan: vi.fn(),
}));
vi.mock('./pinAfterSave', () => ({
  pinImportedPlans: vi.fn(),
}));

const plan = (id: string): Plan => ({ id, createdAtMs: 1 }) as unknown as Plan;

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
  return await import('./firstControlPin');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(pinImportedPlans).toHaveBeenCalledWith([okPlan]);
  });

  it('never arms when the page is already controlled at arm time', async () => {
    const sw = stubSw(true);
    const { armBatchPinOnFirstControl } = await loadModule();
    const { pinImportedPlans } = await import('./pinAfterSave');
    const { listPlans } = await import('./db');
    vi.mocked(listPlans).mockResolvedValue([]);

    armBatchPinOnFirstControl();
    sw.dispatchEvent(new Event('controllerchange')); // e.g. a SKIP_WAITING update

    // Assert on listPlans (the FIRST thing pinAllSavedPlansOnce touches),
    // not only on pinImportedPlans — a listener that fired and then threw
    // partway through would also leave pinImportedPlans uncalled, which
    // would be zero evidence for THIS guard specifically.
    expect(listPlans).not.toHaveBeenCalled();
    expect(pinImportedPlans).not.toHaveBeenCalled();
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
    expect(pinImportedPlans).toHaveBeenCalledWith([expect.objectContaining({ id: 'p1' })]);
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
    const { armBatchPinOnFirstControl } = await loadModule();
    const { listPlans, getPlan } = await import('./db');
    const { pinImportedPlans } = await import('./pinAfterSave');
    vi.mocked(listPlans).mockResolvedValue([]);
    vi.mocked(getPlan).mockResolvedValue(undefined);

    armBatchPinOnFirstControl();
    armBatchPinOnFirstControl();
    sw.controller = {};
    sw.dispatchEvent(new Event('controllerchange'));
    await vi.waitFor(() => expect(pinImportedPlans).toHaveBeenCalledTimes(1));
  });
});
