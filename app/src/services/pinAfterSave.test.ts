import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinAfterSave } from './pinAfterSave';
import type { Plan } from '../types';

const PLAN = { id: 'p1' } as unknown as Plan;
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('createPinAfterSave (#1164 T6)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the pin service with the plan and returns synchronously', async () => {
    let resolvePin!: () => void;
    const pin = vi.fn(() => new Promise<void>((r) => (resolvePin = r)));
    const out: unknown = createPinAfterSave(pin)(PLAN);
    expect(out).toBeUndefined();
    await settle();
    expect(pin).toHaveBeenCalledWith(PLAN);
    resolvePin();
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
});
