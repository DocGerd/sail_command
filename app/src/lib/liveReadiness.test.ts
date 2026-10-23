import { describe, it, expect } from 'vitest';
import {
  aisCheck,
  forecastCheck,
  forecastCoverage,
  glyphsCheck,
  gpsCheck,
  regionsCheck,
  wakeLockCheck,
} from './liveReadiness';
import { de } from '../i18n/dict.de';
import { en } from '../i18n/dict.en';

const H = 3_600_000;

describe('#1807 regionsCheck', () => {
  it.each([
    ['ready', true, 'live.ready.regions.ok'],
    ['pinning', false, 'live.ready.regions.pinning'],
    ['checking', false, 'live.ready.regions.no'],
    ['failed', false, 'live.ready.regions.no'],
    ['not-ready', false, 'live.ready.regions.no'],
  ] as const)('%s -> ready %s', (status, ready, detailKey) => {
    expect(regionsCheck(status)).toEqual({ id: 'regions', ready, detailKey });
  });
});

describe('#1807 glyphsCheck', () => {
  it('ready only when the cache check returned true', () => {
    expect(glyphsCheck(true)).toEqual({
      id: 'glyphs',
      ready: true,
      detailKey: 'live.ready.glyphs.ok',
    });
    expect(glyphsCheck(false).ready).toBe(false);
    expect(glyphsCheck(null).ready).toBe(false);
  });
});

describe('#1807 gpsCheck', () => {
  it.each([
    ['granted', false, true, 'live.ready.gps.ok'],
    ['prompt', false, false, 'live.ready.gps.prompt'],
    ['denied', false, false, 'live.ready.gps.denied'],
    ['unknown', false, false, 'live.ready.gps.unknown'],
    ['checking', false, false, 'live.ready.gps.unknown'],
    // The GPS source saw PERMISSION_DENIED: wins over a stale 'granted' query.
    ['granted', true, false, 'live.ready.gps.denied'],
  ] as const)('%s (denied flag %s) -> ready %s', (permission, denied, ready, detailKey) => {
    expect(gpsCheck(permission, denied)).toEqual({ id: 'gps', ready, detailKey });
  });
});

describe('#1807 forecastCoverage', () => {
  const times = [0, H, 2 * H, 3 * H, 4 * H, 5 * H];

  it('covers a passage that fits the grid, departing on time', () => {
    expect(forecastCoverage(times, H, 3 * H, 0)).toBe('covers');
  });

  it('shifts the passage to start now when now is after the planned departure', () => {
    // 2 h passage starting now at 2.5 h ends at 4.5 h: inside the 5 h grid.
    expect(forecastCoverage(times, H, 3 * H, 2.5 * H)).toBe('covers');
    // Starting now at 3.5 h it would end at 5.5 h: past the last hour.
    expect(forecastCoverage(times, H, 3 * H, 3.5 * H)).toBe('ends-early');
  });

  it('accepts an arrival exactly on the last hour', () => {
    expect(forecastCoverage(times, 3 * H, 5 * H, 0)).toBe('covers');
  });

  it('reports a grid that starts after the passage, also when it ends early too', () => {
    expect(forecastCoverage([2 * H, 5 * H], H, 3 * H, 0)).toBe('starts-late');
    expect(forecastCoverage([2 * H, 3 * H], H, 4 * H, 0)).toBe('starts-late');
  });

  it('cannot check an empty grid, non-finite values or arrival before departure', () => {
    expect(forecastCoverage([], H, 2 * H, 0)).toBe('unknown');
    expect(forecastCoverage([0, Number.NaN], H, 2 * H, 0)).toBe('unknown');
    expect(forecastCoverage(times, H, Number.NaN, 0)).toBe('unknown');
    expect(forecastCoverage(times, 3 * H, 2 * H, 0)).toBe('unknown');
    expect(forecastCoverage([0, Number.POSITIVE_INFINITY], H, 2 * H, 0)).toBe('unknown');
  });

  it('reads a Float64Array grid', () => {
    expect(forecastCoverage(new Float64Array(times), H, 3 * H, 0)).toBe('covers');
  });

  it.each([
    ['covers', true, 'live.ready.forecast.ok'],
    ['starts-late', false, 'live.ready.forecast.startsLate'],
    ['ends-early', false, 'live.ready.forecast.endsEarly'],
    ['unknown', false, 'live.ready.forecast.unknown'],
  ] as const)('maps %s to its own detail', (coverage, ready, detailKey) => {
    expect(forecastCheck(coverage)).toEqual({ id: 'forecast', ready, detailKey });
  });
});

describe('#1807 offline-map remedy names the tab that holds the save control', () => {
  it.each([
    ['de', de],
    ['en', en],
  ] as const)('%s', (_lang, dict) => {
    expect(dict['live.ready.regions.no']).toContain(dict['nav.routes']);
    expect(dict['live.ready.regions.no']).not.toContain(dict['nav.plan']);
  });
});

describe('#1807 wakeLockCheck', () => {
  it('follows API support', () => {
    expect(wakeLockCheck(true)).toEqual({
      id: 'wakeLock',
      ready: true,
      detailKey: 'live.ready.wakeLock.ok',
    });
    expect(wakeLockCheck(false)).toEqual({
      id: 'wakeLock',
      ready: false,
      detailKey: 'live.ready.wakeLock.no',
    });
  });
});

describe('#1807 aisCheck', () => {
  it.each([
    ['live', true, 'live.ready.ais.ok'],
    ['off', false, 'live.ready.ais.off'],
    ['keyError', false, 'live.ready.ais.keyError'],
    ['offline', false, 'live.ready.ais.offline'],
    // Connected but nothing received: the key is not yet proven.
    ['noTraffic', false, 'live.ready.ais.unconfirmed'],
    ['connecting', false, 'live.ready.ais.unconfirmed'],
    [null, false, 'live.ready.ais.unconfirmed'],
  ] as const)('%s -> ready %s', (status, ready, detailKey) => {
    expect(aisCheck(status)).toEqual({ id: 'ais', ready, detailKey });
  });
});
