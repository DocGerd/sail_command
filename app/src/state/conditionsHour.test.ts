import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  clampHour,
  getConditionsHour,
  resetConditionsHourForTests,
  seedConditionsHour,
  setConditionsHour,
  stepDay,
  stepHour,
  subscribeConditionsHour,
  validHours,
} from './conditionsHour';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 14, 0);
const AXIS = Array.from({ length: 48 }, (_, i) => T0 + i * H);

afterEach(() => resetConditionsHourForTests());

describe('validHours', () => {
  it('drops hours before the current hour and keeps the current one', () => {
    const v = validHours(AXIS, T0 + 5 * H + 59 * 60_000);
    expect(v[0]).toBe(T0 + 5 * H);
    expect(v).toHaveLength(43);
  });
});

describe('clampHour', () => {
  it('floors into the axis and reports clamping at both ends', () => {
    expect(clampHour(T0 + 3 * H + 30 * 60_000, AXIS)).toEqual({ ms: T0 + 3 * H, clamped: false });
    expect(clampHour(T0 - 1, AXIS)).toEqual({ ms: T0, clamped: true });
    expect(clampHour(T0 + 47 * H + 59 * 60_000, AXIS)).toEqual({ ms: T0 + 47 * H, clamped: false });
    expect(clampHour(T0 + 48 * H, AXIS)).toEqual({ ms: T0 + 47 * H, clamped: true });
    expect(clampHour(T0, [])).toBeNull();
  });
});

describe('stepping', () => {
  it('steps an hour and stops at the ends', () => {
    expect(stepHour(AXIS, T0 + 4 * H, 1)).toBe(T0 + 5 * H);
    expect(stepHour(AXIS, T0, -1)).toBe(T0);
    expect(stepHour(AXIS, T0 + 47 * H, 1)).toBe(T0 + 47 * H);
  });

  it('steps a day keeping the clock hour, clamped into range', () => {
    expect(stepDay(AXIS, T0 + 4 * H, 1)).toBe(T0 + 28 * H);
    expect(stepDay(AXIS, T0 + 30 * H, 1)).toBe(T0 + 47 * H);
    expect(stepDay(AXIS, T0 + 4 * H, -1)).toBe(T0);
  });
});

describe('seedConditionsHour', () => {
  it('seeds from a changed departure, flooring it', () => {
    expect(seedConditionsHour(T0 + 6 * H + 15 * 60_000, AXIS)).toBe(false);
    expect(getConditionsHour()).toBe(T0 + 6 * H);
  });

  it('keeps the user hour while the departure is unchanged', () => {
    seedConditionsHour(T0 + 6 * H, AXIS);
    setConditionsHour(T0 + 20 * H);
    seedConditionsHour(T0 + 6 * H, AXIS);
    expect(getConditionsHour()).toBe(T0 + 20 * H);
    seedConditionsHour(T0 + 8 * H, AXIS);
    expect(getConditionsHour()).toBe(T0 + 8 * H);
  });

  it('reports a clamped departure seed', () => {
    expect(seedConditionsHour(T0 + 72 * H, AXIS)).toBe(true);
    expect(getConditionsHour()).toBe(T0 + 47 * H);
  });

  it('advances a past hour to the first valid hour', () => {
    seedConditionsHour(T0 + 2 * H, AXIS);
    seedConditionsHour(T0 + 2 * H, validHours(AXIS, T0 + 13 * H));
    expect(getConditionsHour()).toBe(T0 + 13 * H);
  });

  it('waits for an axis before consuming the seed', () => {
    expect(seedConditionsHour(T0 + 6 * H, [])).toBe(false);
    expect(getConditionsHour()).toBeNull();
    seedConditionsHour(T0 + 6 * H, AXIS);
    expect(getConditionsHour()).toBe(T0 + 6 * H);
  });

  it('notifies subscribers only on a change', () => {
    const l = vi.fn();
    subscribeConditionsHour(l);
    setConditionsHour(T0);
    setConditionsHour(T0);
    expect(l).toHaveBeenCalledTimes(1);
  });
});
