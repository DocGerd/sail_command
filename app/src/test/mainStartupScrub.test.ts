import { describe, it, expect } from 'vitest';

const sources = import.meta.glob('/src/main.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('#1813: main.tsx runs the stored-plan AIS key scrub at startup', () => {
  const src = sources['/src/main.tsx'];

  it('reads main.tsx (positive control: the glob matched a non-empty file)', () => {
    expect(src.length).toBeGreaterThan(0);
    expect(src).toContain('createRoot(');
  });

  it('imports and invokes scrubStoredAisApiKeys before rendering', () => {
    expect(src).toMatch(/import \{ scrubStoredAisApiKeys \} from '\.\/services\/db'/);
    const call = src.search(/^void scrubStoredAisApiKeys\(\);/m);
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(src.indexOf('createRoot('));
  });
});
