import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPinActivityForTests,
  createPinAfterSave,
  pinActivityFor,
  pinImportedPlans,
  subscribePinActivity,
  pinRegionsAfterDepartureConfirm,
  pinRegionsAfterReplan,
  pinRegionsAfterReroute,
  pinRegionsAfterSave,
} from './pinAfterSave';
import type { Plan } from '../types';
import type { PinRegionsOutcome } from './regionPinning';

const PLAN = { id: 'p1' } as unknown as Plan;
const settle = () => new Promise((r) => setTimeout(r, 0));

// jsdom has no navigator.serviceWorker; each test declares whether one controls the page.
function setController(controller: object | null): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { controller },
    configurable: true,
  });
}

describe('createPinAfterSave (#1164 T6)', () => {
  beforeEach(() => {
    setController({});
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    vi.restoreAllMocks();
  });

  it('defers the pin call past the save, then calls it with the plan', async () => {
    let resolvePin!: () => void;
    const pin = vi.fn(() => new Promise<void>((r) => (resolvePin = r)));
    createPinAfterSave(pin)(PLAN);
    expect(pin).not.toHaveBeenCalled();
    await settle();
    expect(pin).toHaveBeenCalledWith(PLAN);
    resolvePin();
  });

  it('makes no pin call when a service worker exists but does not control the page', async () => {
    setController(null);
    const pin = vi.fn(() => Promise.resolve());
    createPinAfterSave(pin)(PLAN);
    await settle();
    expect(pin).not.toHaveBeenCalled();
  });

  it('makes no pin call when service workers are unsupported', async () => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    const pin = vi.fn(() => Promise.resolve());
    createPinAfterSave(pin)(PLAN);
    await settle();
    expect(pin).not.toHaveBeenCalled();
  });

  it('warns once across repeated rejections', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pinAfterSave = createPinAfterSave(() => Promise.reject(new Error('offline')));
    pinAfterSave(PLAN);
    pinAfterSave(PLAN);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('turns a synchronous throw into a warning, not an exception', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pinAfterSave = createPinAfterSave(() => {
      throw new Error('boom');
    });
    expect(() => pinAfterSave(PLAN)).not.toThrow();
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stays silent when pinning resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createPinAfterSave(() => Promise.resolve({ status: 'pinned', total: 0, pinned: 0 }))(PLAN);
    await settle();
    expect(warn).not.toHaveBeenCalled();
  });

  // #1233 (PR #1231 review r4009769671): warn scope must be PER CONSUMER,
  // not one module singleton shared by every save path — a failure on one
  // consumer's own factory instance must not silence a DIFFERENT instance's
  // first failure.
  it('two independently-created instances each warn on their own first failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = createPinAfterSave(() => Promise.reject(new Error('a failed')));
    const b = createPinAfterSave(() => Promise.reject(new Error('b failed')));
    a(PLAN);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    b(PLAN);
    await settle();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  // #1233 Major 2 (offline/PWA review): plans import is DELIBERATELY not a
  // fifth createPinAfterSave() instance — see pinImportedPlans's own
  // comment (why it aggregates instead). Four remain.
  it('the four named per-consumer instances are four distinct functions, not aliases of one shared singleton', () => {
    const instances = [
      pinRegionsAfterSave,
      pinRegionsAfterReplan,
      pinRegionsAfterReroute,
      pinRegionsAfterDepartureConfirm,
    ];
    expect(new Set(instances).size).toBe(instances.length);
  });
});

const PLAN_A = { id: 'a' } as unknown as Plan;
const PLAN_B = { id: 'b' } as unknown as Plan;
const PINNED: PinRegionsOutcome = { status: 'pinned', total: 1, pinned: 1 };

describe('pinImportedPlans (#1233 Major 2)', () => {
  beforeEach(() => {
    setController({});
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    vi.restoreAllMocks();
  });

  it('is a no-op — zero pin() calls — for an empty plans array', async () => {
    const pin = vi.fn<(p: Plan) => Promise<PinRegionsOutcome>>();
    pinImportedPlans([], pin);
    await settle();
    expect(pin).not.toHaveBeenCalled();
  });

  it('makes no pin() call when the page is not SW-controlled', async () => {
    setController(null);
    const pin = vi.fn<(p: Plan) => Promise<PinRegionsOutcome>>();
    pinImportedPlans([PLAN_A, PLAN_B], pin);
    await settle();
    expect(pin).not.toHaveBeenCalled();
  });

  it('calls pin() once per plan, and is fire-and-forget (returns before pin() resolves)', async () => {
    let resolveA!: (o: PinRegionsOutcome) => void;
    const pin = vi.fn((p: Plan) =>
      p === PLAN_A
        ? new Promise<PinRegionsOutcome>((r) => (resolveA = r))
        : Promise.resolve(PINNED),
    );
    pinImportedPlans([PLAN_A, PLAN_B], pin);
    expect(pin).not.toHaveBeenCalled(); // still deferred at this point
    await settle();
    expect(pin).toHaveBeenCalledTimes(2);
    expect(pin).toHaveBeenCalledWith(PLAN_A);
    expect(pin).toHaveBeenCalledWith(PLAN_B);
    resolveA(PINNED);
  });

  it('stays silent when every plan pins fully', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pin = vi.fn().mockResolvedValue(PINNED);
    pinImportedPlans([PLAN_A, PLAN_B], pin);
    await settle();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns ONCE, aggregated, naming the failed/total count — not once per plan', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pin = vi
      .fn<(p: Plan) => Promise<PinRegionsOutcome>>()
      .mockResolvedValueOnce(PINNED)
      .mockResolvedValueOnce({ status: 'manifest-unavailable' });
    pinImportedPlans([PLAN_A, PLAN_B], pin);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('1/2');
  });

  it('a PARTIAL pin (pinned < total) counts as a failure for the aggregate, even though the write succeeded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pin = vi
      .fn<(p: Plan) => Promise<PinRegionsOutcome>>()
      .mockResolvedValue({ status: 'pinned', total: 2, pinned: 1 });
    pinImportedPlans([PLAN_A], pin);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a rejected pin() counts as a failure for the aggregate, and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pin = vi.fn().mockRejectedValue(new Error('boom'));
    expect(() => pinImportedPlans([PLAN_A], pin)).not.toThrow();
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // A SYNCHRONOUS throw (not a rejected Promise) from pin() would otherwise
  // throw while `plans.map(...)` builds Promise.allSettled's argument array,
  // becoming an unhandled rejection of this function's own async IIFE rather
  // than a counted failure — this row is what pins the
  // Promise.resolve().then() wrapper each map entry needs.
  it('a SYNCHRONOUS throw from pin() also counts as a failure, and does not throw out of the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pin = vi.fn(() => {
      throw new Error('sync boom');
    });
    expect(() => pinImportedPlans([PLAN_A], pin)).not.toThrow();
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// #295: the per-plan pin activity the readiness chip reads.
describe('pin activity (#295)', () => {
  beforeEach(() => {
    setController({});
    __resetPinActivityForTests();
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    vi.restoreAllMocks();
  });

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('is "pinning" while in flight and clears on a full pin', async () => {
    const d = deferred<PinRegionsOutcome>();
    createPinAfterSave(() => d.promise)(PLAN);
    expect(pinActivityFor('p1')).toBe('pinning');
    d.resolve({ status: 'pinned', total: 2, pinned: 2 });
    await settle();
    expect(pinActivityFor('p1')).toBeUndefined();
  });

  it.each<[string, PinRegionsOutcome]>([
    ['a partial pin', { status: 'pinned', total: 2, pinned: 1 }],
    ['an unavailable manifest', { status: 'manifest-unavailable' }],
    ['a failed pin record', { status: 'pin-record-failed', total: 1, pinned: 1 }],
  ])('reads "failed" after %s', async (_name, outcome) => {
    createPinAfterSave(() => Promise.resolve(outcome))(PLAN);
    await settle();
    expect(pinActivityFor('p1')).toBe('failed');
  });

  it('reads "failed" after a rejection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    createPinAfterSave(() => Promise.reject(new Error('offline')))(PLAN);
    await settle();
    expect(pinActivityFor('p1')).toBe('failed');
  });

  it('forgets a deleted plan ("plan-gone")', async () => {
    createPinAfterSave(() => Promise.resolve({ status: 'plan-gone', total: 1, pinned: 1 }))(PLAN);
    await settle();
    expect(pinActivityFor('p1')).toBeUndefined();
  });

  it('records nothing when no service worker controls the page', async () => {
    setController(null);
    createPinAfterSave(() => Promise.resolve(PINNED))(PLAN);
    await settle();
    expect(pinActivityFor('p1')).toBeUndefined();
  });

  it('an older attempt settling late does not overwrite a newer one still in flight', async () => {
    const first = deferred<PinRegionsOutcome>();
    const second = deferred<PinRegionsOutcome>();
    const pinAfterSave = createPinAfterSave(
      vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    );
    pinAfterSave(PLAN);
    await settle();
    pinAfterSave(PLAN);
    await settle();
    first.resolve({ status: 'manifest-unavailable' });
    await settle();
    expect(pinActivityFor('p1')).toBe('pinning');
    second.resolve(PINNED);
    await settle();
    expect(pinActivityFor('p1')).toBeUndefined();
  });

  it('notifies subscribers on every change and stops after unsubscribe', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribePinActivity(listener);
    createPinAfterSave(() => Promise.resolve(PINNED))(PLAN);
    await settle();
    expect(listener).toHaveBeenCalledTimes(2); // pinning, then cleared
    unsubscribe();
    createPinAfterSave(() => Promise.resolve(PINNED))(PLAN);
    await settle();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('pinImportedPlans records per-plan activity', async () => {
    const pin = vi
      .fn<(p: Plan) => Promise<PinRegionsOutcome>>()
      .mockResolvedValueOnce(PINNED)
      .mockResolvedValueOnce({ status: 'manifest-unavailable' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    pinImportedPlans([PLAN_A, PLAN_B], pin);
    await settle();
    expect(pinActivityFor('a')).toBeUndefined();
    expect(pinActivityFor('b')).toBe('failed');
  });
});
