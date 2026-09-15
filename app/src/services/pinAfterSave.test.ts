import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPinAfterSave,
  pinRegionsAfterDepartureConfirm,
  pinRegionsAfterImport,
  pinRegionsAfterReplan,
  pinRegionsAfterReroute,
  pinRegionsAfterSave,
} from './pinAfterSave';
import type { Plan } from '../types';

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

  it('the five named per-consumer instances are five distinct functions, not aliases of one shared singleton', () => {
    const instances = [
      pinRegionsAfterSave,
      pinRegionsAfterReplan,
      pinRegionsAfterReroute,
      pinRegionsAfterDepartureConfirm,
      pinRegionsAfterImport,
    ];
    expect(new Set(instances).size).toBe(instances.length);
  });
});
