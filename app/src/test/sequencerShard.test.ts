import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TestSpecification, Vitest } from 'vitest/node';
import { SLOW_TEST_FILES_FIRST, SlowFileFirstSequencer } from '../../vite.config';

// #1286: pins SlowFileFirstSequencer.shard(), which splits CI's `app` job
// across `--shard=i/N` runners. Runs over the REAL test file list, so a
// renamed pinned file or a lost/duplicated file fails here, not as a silently
// skipped or doubled CI shard.

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function realTestFiles(): string[] {
  return (readdirSync(resolve(APP_ROOT, 'src'), { recursive: true }) as string[])
    .map((p) => `src/${p.replace(/\\/g, '/')}`)
    .filter((p) => /\.test\.tsx?$/.test(p))
    .sort();
}

function spec(relPath: string): TestSpecification {
  return { moduleId: `${APP_ROOT}/${relPath}` } as unknown as TestSpecification;
}

async function shardOf(files: string[], index: number, count: number): Promise<string[]> {
  const ctx = { config: { root: APP_ROOT, shard: { index, count } } } as unknown as Vitest;
  const picked = await new SlowFileFirstSequencer(ctx).shard(files.map(spec));
  return picked.map((s) => s.moduleId.slice(APP_ROOT.length + 1));
}

describe('SlowFileFirstSequencer.shard (#1286)', () => {
  const files = realTestFiles();

  it('every pinned slow file exists exactly once in the real test list', () => {
    expect(files.length).toBeGreaterThan(SLOW_TEST_FILES_FIRST.length);
    for (const suffix of SLOW_TEST_FILES_FIRST) {
      expect({ suffix, hits: files.filter((f) => f.endsWith(suffix)) }).toEqual({
        suffix,
        hits: [suffix],
      });
    }
  });

  it.each([1, 2, 3, 4])(
    'with %i shard(s), every file lands in exactly one shard',
    async (count) => {
      const seen: string[] = [];
      for (let index = 1; index <= count; index++)
        seen.push(...(await shardOf(files, index, count)));
      expect(seen.slice().sort()).toEqual(files);
    },
  );

  // #1303 re-pin: inserting `realmask.repro.confinedDominance.test.ts` at rank 1
  // shifted every later file's rank by one, so the literals below moved by one
  // shard each. The row's INVARIANT is unchanged and still holds — measured on
  // CI run 35318244674, the two slowest files are `confinedDominance`
  // (1075 s, shard 2) and `horizonRelaxation` (855 s, shard 3), on different
  // runners, with shard totals 2131 / 2700 / 2249 s. Placing the slowest file
  // at rank 1 rather than appending it is deliberate: the sequencer schedules
  // pinned files in array order, so the slowest must start early in its shard.
  it('with 3 shards, the two slowest pinned files never share a runner (literal)', async () => {
    const shard1 = await shardOf(files, 1, 3);
    const shard2 = await shardOf(files, 2, 3);
    const shard3 = await shardOf(files, 3, 3);
    expect(shard1).toContain('src/routing/invariants.property.test.ts');
    expect(shard2).toContain('src/routing/realmask.repro.confinedDominance.test.ts');
    expect(shard2).toContain('src/routing/realmask.repro.issue20.marstalDefault.test.ts');
    expect(shard3).toContain('src/routing/realmask.repro.relaxationFloor.wiring.test.ts');
    expect(shard3).toContain('src/routing/realmask.repro.horizonRelaxation.test.ts');
    expect(shard2).not.toContain('src/routing/invariants.property.test.ts');
    expect(shard2).not.toContain('src/routing/realmask.repro.horizonRelaxation.test.ts');
  });

  it.each([2, 3, 4])('with %i shards, pinned slow files spread round-robin', async (count) => {
    const perShard: string[][] = [];
    for (let index = 1; index <= count; index++) {
      const picked = await shardOf(files, index, count);
      perShard.push(SLOW_TEST_FILES_FIRST.filter((suffix) => picked.includes(suffix)));
    }
    const expected = Array.from({ length: count }, (_, i) =>
      SLOW_TEST_FILES_FIRST.filter((_s, rank) => rank % count === i),
    );
    expect(perShard).toEqual(expected);
    const sizes = perShard.map((s) => s.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });
});
