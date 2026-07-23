import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SESSION_SNAPSHOT_KEY,
  parseSessionSnapshot,
  readSessionSnapshot,
  writeSessionSnapshot,
  type SessionSnapshot,
} from './sessionSnapshot';

describe('sessionSnapshot (#113)', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips a full snapshot through localStorage under the sc-session key', () => {
    const snapshot: SessionSnapshot = { v: 1, planId: 'plan-abc', tab: 'routes', rig: 'fock' };
    writeSessionSnapshot(snapshot);
    // Pin the stored wire format, not just read-what-we-wrote: a shape change
    // must show up here as a literal diff.
    expect(localStorage.getItem(SESSION_SNAPSHOT_KEY)).toBe(
      '{"v":1,"planId":"plan-abc","tab":"routes","rig":"fock"}',
    );
    expect(readSessionSnapshot()).toEqual({ v: 1, planId: 'plan-abc', tab: 'routes', rig: 'fock' });
  });

  it('round-trips the no-plan variant (planId and rig null)', () => {
    writeSessionSnapshot({ v: 1, planId: null, tab: 'live', rig: null });
    expect(readSessionSnapshot()).toEqual({ v: 1, planId: null, tab: 'live', rig: null });
  });

  it('parses null input (missing key) to null', () => {
    expect(parseSessionSnapshot(null)).toBeNull();
    expect(readSessionSnapshot()).toBeNull(); // nothing stored
  });

  it.each([
    ['truncated JSON', '{"v":1,"planId":"p1"'],
    ['non-JSON garbage', 'not json at all'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON scalar', '42'],
    ['JSON null', 'null'],
  ])('parses %s to null instead of throwing', (_name, raw) => {
    expect(parseSessionSnapshot(raw)).toBeNull();
  });

  it.each([
    ['a foreign (future) version', '{"v":2,"planId":"p1","tab":"plan","rig":null}'],
    ['a missing version', '{"planId":"p1","tab":"plan","rig":null}'],
    ['an unknown tab', '{"v":1,"planId":"p1","tab":"settings","rig":null}'],
    ['a missing tab', '{"v":1,"planId":"p1","rig":null}'],
    ['a non-string planId', '{"v":1,"planId":42,"tab":"plan","rig":null}'],
    ['a missing planId', '{"v":1,"tab":"plan","rig":null}'],
    ['an unknown rig', '{"v":1,"planId":"p1","tab":"plan","rig":"spinnaker"}'],
    ['a missing rig', '{"v":1,"planId":"p1","tab":"plan"}'],
  ])('rejects %s as null (fresh boot)', (_name, raw) => {
    expect(parseSessionSnapshot(raw)).toBeNull();
  });

  it('readSessionSnapshot returns null when localStorage access throws (private mode)', () => {
    localStorage.setItem(SESSION_SNAPSHOT_KEY, '{"v":1,"planId":null,"tab":"live","rig":null}');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readSessionSnapshot()).toBeNull();
  });

  it('writeSessionSnapshot does not throw when localStorage.setItem throws (private-mode quota)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(() =>
      writeSessionSnapshot({ v: 1, planId: 'p1', tab: 'plan', rig: 'genoa' }),
    ).not.toThrow();
  });
});
