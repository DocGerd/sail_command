/**
 * #1262: extracted from `sweepArms.ts` so `merge-shards.mjs` can reuse the
 * EXACT SAME serializer under plain Node (no vite/vitest) when reassembling
 * sharded output. Zero imports of its own — same constraint `armNames.ts`
 * documents on itself and for the same reason: a file that imports nothing
 * beyond this can be loaded directly under plain Node (>= 22.18, unflagged
 * `.ts` type-stripping) without pulling in `../src/lib/mask` and the rest of
 * the app's module graph, which plain Node's loader cannot resolve the way
 * Vite does. `sweepArms.ts` re-exports `serialize` from here, so this is a
 * pure extraction — no caller-facing change.
 *
 * Deterministic serialization. `JSON.stringify(value, replacer, 1)` — the
 * 1-space indent is part of the baseline identity, not cosmetics: it fixes
 * the byte layout every stored comparison was made against. Non-finite
 * numbers become explicit sentinels because JSON would otherwise turn
 * NaN/Infinity into `null` and quietly erase a real difference.
 */
export function serialize(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? `#nf:${String(v)}` : v),
    1,
  );
}
