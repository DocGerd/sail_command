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
    ['a non-string rig', '{"v":1,"planId":"p1","tab":"plan","rig":42}'],
    ['a missing rig', '{"v":1,"planId":"p1","tab":"plan"}'],
  ])('rejects %s as null (fresh boot)', (_name, raw) => {
    expect(parseSessionSnapshot(raw)).toBeNull();
  });

  // #54 spec §I.3: an id this build's catalogue does not know is NOT a parse
  // failure. Whether a sail id is usable is a question about the plan the
  // snapshot points at, and rejecting it here would collapse the WHOLE
  // snapshot — costing the user their restored plan id and tab as well, for a
  // field the restore can simply decline to apply. useSessionRestore.ts owns
  // that check, against the plan's own per-sail list.
  it('#54: keeps a sail id the catalogue does not know, rather than collapsing the snapshot', () => {
    expect(parseSessionSnapshot('{"v":1,"planId":"p1","tab":"routes","rig":"spinnaker"}')).toEqual({
      v: 1,
      planId: 'p1',
      tab: 'routes',
      rig: 'spinnaker',
    });
  });

  // #299: 'boat' is a real, persistable Tab value (App.tsx's write-back
  // effect saves it like any other) and a SYNTACTICALLY VALID parse result —
  // parseSessionSnapshot is a pure shape validator with no restore policy
  // (PR #486 review, Minor 6), so it round-trips 'boat' like any other Tab
  // rather than silently returning something the caller didn't write. The
  // "never restore INTO 'boat'" DECISION lives one level up, in
  // readSessionSnapshot, tested separately below.
  it("#299: parseSessionSnapshot round-trips a 'boat' tab UNCHANGED — it is a pure parser, no restore policy", () => {
    expect(parseSessionSnapshot('{"v":1,"planId":"p1","tab":"boat","rig":"fock"}')).toEqual({
      v: 1,
      planId: 'p1',
      tab: 'boat',
      rig: 'fock',
    });
  });

  it("#299: writeSessionSnapshot persists 'boat' verbatim (unaffected by the read-time restore policy)", () => {
    writeSessionSnapshot({ v: 1, planId: 'p1', tab: 'boat', rig: null });
    expect(localStorage.getItem(SESSION_SNAPSHOT_KEY)).toBe(
      '{"v":1,"planId":"p1","tab":"boat","rig":null}',
    );
  });

  describe("readSessionSnapshot's restore policy (#299, PR #486 review Minor 6)", () => {
    it("coerces a persisted 'boat' tab to 'plan' — a sailor reopening the PWA on deck must land on a content tab, not the boat/skipper settings form", () => {
      localStorage.setItem(SESSION_SNAPSHOT_KEY, '{"v":1,"planId":"p1","tab":"boat","rig":"fock"}');
      expect(readSessionSnapshot()).toEqual({ v: 1, planId: 'p1', tab: 'plan', rig: 'fock' });
    });

    it("the no-plan variant also coerces a persisted 'boat' tab to 'plan'", () => {
      localStorage.setItem(SESSION_SNAPSHOT_KEY, '{"v":1,"planId":null,"tab":"boat","rig":null}');
      expect(readSessionSnapshot()).toEqual({ v: 1, planId: null, tab: 'plan', rig: null });
    });

    it('every OTHER tab passes through unchanged', () => {
      localStorage.setItem(SESSION_SNAPSHOT_KEY, '{"v":1,"planId":"p1","tab":"routes","rig":null}');
      expect(readSessionSnapshot()).toEqual({ v: 1, planId: 'p1', tab: 'routes', rig: null });
    });

    // The coercion must not SWALLOW a genuinely corrupt value — it only
    // ever runs on an already-successfully-parsed snapshot, gated behind
    // `snapshot === null` short-circuiting first.
    it('a genuinely corrupt persisted value still returns null — the restore policy never masks a parse failure', () => {
      localStorage.setItem(SESSION_SNAPSHOT_KEY, '{"v":1,"planId":"p1","tab":"nonsense"');
      expect(readSessionSnapshot()).toBeNull();
    });
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
