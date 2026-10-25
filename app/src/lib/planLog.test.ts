import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_PREFIX, planLog } from './planLog';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('planLog (#1777)', () => {
  it('prefixes every level and routes it to the matching console method', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    planLog.info('a');
    planLog.warn('b');
    planLog.error('c');

    expect(LOG_PREFIX).toBe('[SailCommand]');
    expect(info.mock.calls).toEqual([['[SailCommand] a']]);
    expect(warn.mock.calls).toEqual([['[SailCommand] b']]);
    expect(error.mock.calls).toEqual([['[SailCommand] c']]);
  });

  it('passes the detail record and the error object through unchanged', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const detail = { kind: 'timeout' };
    const err = new Error('boom');

    planLog.info('with detail', detail);
    planLog.error('with error', detail, err);
    planLog.error('error only', undefined, err);

    expect(info.mock.calls[0]?.[1]).toBe(detail);
    expect(error.mock.calls[0]?.[1]).toBe(detail);
    expect(error.mock.calls[0]?.[2]).toBe(err);
    // An absent detail is omitted, not logged as `undefined`.
    expect(error.mock.calls[1]).toEqual(['[SailCommand] error only', err]);
  });
});
