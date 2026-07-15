import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchPosition } from './geolocation';

function fakePosition(overrides: Partial<GeolocationCoordinates> = {}): GeolocationPosition {
  const coords: GeolocationCoordinates = {
    latitude: 54.79,
    longitude: 9.43,
    accuracy: 8,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
    toJSON() {
      return this;
    },
    ...overrides,
  };
  return { coords, timestamp: 1_700_000_000_000, toJSON: () => ({}) } as GeolocationPosition;
}

function fakePositionError(code: number): GeolocationPositionError {
  return {
    code,
    message: 'boom',
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('watchPosition', () => {
  it('passes enableHighAccuracy: true to navigator.geolocation.watchPosition', () => {
    const geoWatchPosition = vi.fn().mockReturnValue(1);
    vi.stubGlobal('navigator', { geolocation: { watchPosition: geoWatchPosition, clearWatch: vi.fn() } });

    watchPosition(vi.fn(), vi.fn());

    expect(geoWatchPosition).toHaveBeenCalledTimes(1);
    const opts = geoWatchPosition.mock.calls[0][2];
    expect(opts).toMatchObject({ enableHighAccuracy: true });
  });

  it('converts speed from m/s to knots and passes through position/heading/accuracy', () => {
    const geoWatchPosition = vi.fn().mockReturnValue(1);
    vi.stubGlobal('navigator', { geolocation: { watchPosition: geoWatchPosition, clearWatch: vi.fn() } });

    const onFix = vi.fn();
    watchPosition(onFix, vi.fn());
    const successCb = geoWatchPosition.mock.calls[0][0] as (pos: GeolocationPosition) => void;

    successCb(fakePosition({ latitude: 54.8, longitude: 10.1, heading: 123.4, speed: 5, accuracy: 12 }));

    expect(onFix).toHaveBeenCalledTimes(1);
    const fix = onFix.mock.calls[0][0];
    expect(fix.point).toEqual({ lat: 54.8, lon: 10.1 });
    expect(fix.cogDeg).toBe(123.4);
    expect(fix.sogKn).toBeCloseTo(9.719222, 5); // 5 m/s -> kn
    expect(fix.accuracyM).toBe(12);
  });

  it('is null-safe: missing heading/speed map to null, not NaN or 0', () => {
    const geoWatchPosition = vi.fn().mockReturnValue(1);
    vi.stubGlobal('navigator', { geolocation: { watchPosition: geoWatchPosition, clearWatch: vi.fn() } });

    const onFix = vi.fn();
    watchPosition(onFix, vi.fn());
    const successCb = geoWatchPosition.mock.calls[0][0] as (pos: GeolocationPosition) => void;

    successCb(fakePosition({ heading: null, speed: null }));

    expect(onFix).toHaveBeenCalledWith(
      expect.objectContaining({ cogDeg: null, sogKn: null }),
    );
  });

  it("maps PERMISSION_DENIED to 'denied'", () => {
    const geoWatchPosition = vi.fn().mockReturnValue(1);
    vi.stubGlobal('navigator', { geolocation: { watchPosition: geoWatchPosition, clearWatch: vi.fn() } });

    const onError = vi.fn();
    watchPosition(vi.fn(), onError);
    const errorCb = geoWatchPosition.mock.calls[0][1] as (err: GeolocationPositionError) => void;

    errorCb(fakePositionError(1));
    expect(onError).toHaveBeenCalledWith('denied');
  });

  it.each([2, 3])("maps error code %d (POSITION_UNAVAILABLE/TIMEOUT) to 'unavailable'", (code) => {
    const geoWatchPosition = vi.fn().mockReturnValue(1);
    vi.stubGlobal('navigator', { geolocation: { watchPosition: geoWatchPosition, clearWatch: vi.fn() } });

    const onError = vi.fn();
    watchPosition(vi.fn(), onError);
    const errorCb = geoWatchPosition.mock.calls[0][1] as (err: GeolocationPositionError) => void;

    errorCb(fakePositionError(code));
    expect(onError).toHaveBeenCalledWith('unavailable');
  });

  it("calls onError('unavailable') synchronously and returns a no-op unsubscribe when geolocation is absent", () => {
    vi.stubGlobal('navigator', {});
    const onError = vi.fn();

    const unsubscribe = watchPosition(vi.fn(), onError);

    expect(onError).toHaveBeenCalledWith('unavailable');
    expect(() => unsubscribe()).not.toThrow();
  });

  it('the returned unsubscribe function calls navigator.geolocation.clearWatch with the watch id', () => {
    const clearWatch = vi.fn();
    const geoWatchPosition = vi.fn().mockReturnValue(42);
    vi.stubGlobal('navigator', { geolocation: { watchPosition: geoWatchPosition, clearWatch } });

    const unsubscribe = watchPosition(vi.fn(), vi.fn());
    unsubscribe();

    expect(clearWatch).toHaveBeenCalledWith(42);
  });
});
