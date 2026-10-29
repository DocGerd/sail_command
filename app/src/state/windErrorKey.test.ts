import { describe, it, expect } from 'vitest';
import { OpenMeteoError } from '../services/openMeteo';
import { mapWindError } from './windErrorKey';

describe('mapWindError', () => {
  it.each([
    ['offline', 'error.offline'],
    ['rate-limited', 'error.rateLimited'],
    ['http', 'error.windService'],
    ['malformed', 'error.windService'],
  ] as const)('maps OpenMeteoError %s to %s', (kind, key) => {
    expect(mapWindError(new OpenMeteoError(kind, 'x'))).toBe(key);
  });

  it('maps anything else to error.windUnknown', () => {
    expect(mapWindError(new Error('boom'))).toBe('error.windUnknown');
    expect(mapWindError('boom')).toBe('error.windUnknown');
  });
});
