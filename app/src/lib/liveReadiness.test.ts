import { describe, it, expect } from 'vitest';
import {
  aisCheck,
  forecastCheck,
  forecastCovers,
  glyphsCheck,
  gpsCheck,
  regionsCheck,
  wakeLockCheck,
} from './liveReadiness';

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

describe('#1807 forecastCovers', () => {
  const times = [0, H, 2 * H, 3 * H, 4 * H, 5 * H];

  it('covers a passage that fits the grid, departing on time', () => {
    expect(forecastCovers(times, H, 3 * H, 0)).toBe(true);
  });

  it('shifts the passage to start now when now is after the planned departure', () => {
    // 2 h passage starting now at 2.5 h ends at 4.5 h: inside the 5 h grid.
    expect(forecastCovers(times, H, 3 * H, 2.5 * H)).toBe(true);
    // Starting now at 3.5 h it would end at 5.5 h: past the last hour.
    expect(forecastCovers(times, H, 3 * H, 3.5 * H)).toBe(false);
  });

  it('accepts an arrival exactly on the last hour', () => {
    expect(forecastCovers(times, 3 * H, 5 * H, 0)).toBe(true);
  });

  it('rejects a grid that starts after the passage', () => {
    expect(forecastCovers([2 * H, 5 * H], H, 3 * H, 0)).toBe(false);
  });

  it('fails closed on an empty grid, non-finite values or arrival before departure', () => {
    expect(forecastCovers([], H, 2 * H, 0)).toBe(false);
    expect(forecastCovers([0, Number.NaN], H, 2 * H, 0)).toBe(false);
    expect(forecastCovers(times, H, Number.NaN, 0)).toBe(false);
    expect(forecastCovers(times, 3 * H, 2 * H, 0)).toBe(false);
    expect(forecastCovers([0, Number.POSITIVE_INFINITY], H, 2 * H, 0)).toBe(false);
  });

  it('reads a Float64Array grid', () => {
    expect(forecastCovers(new Float64Array(times), H, 3 * H, 0)).toBe(true);
  });

  it('maps to the check', () => {
    expect(forecastCheck(true)).toEqual({
      id: 'forecast',
      ready: true,
      detailKey: 'live.ready.forecast.ok',
    });
    expect(forecastCheck(false)).toEqual({
      id: 'forecast',
      ready: false,
      detailKey: 'live.ready.forecast.no',
    });
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
