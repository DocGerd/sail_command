import { describe, expect, it } from 'vitest';
import { beaufortForce } from './beaufort';

describe('beaufortForce', () => {
  it.each([
    [0, 0],
    [0.99, 0],
    [1, 1],
    [3, 1],
    [3.01, 2],
    [10, 3],
    [10.01, 4],
    [63, 11],
    [63.01, 12],
    [120, 12],
  ])('%s kn is force %s', (kn, force) => {
    expect(beaufortForce(kn)).toBe(force);
  });
});
