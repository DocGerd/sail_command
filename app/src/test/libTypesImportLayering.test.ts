import { describe, expect, it } from 'vitest';

// #1602: these lib modules may import `../types` as types only, so a value
// import cannot pull `types.ts` (and `DEFAULT_SETTINGS`) into them.
// `sourceStrip`'s stripper masks string contents, which would hide the module
// specifier, so comments are removed here with strings left intact.
// `?raw` is only vacuous for `.css`; each read is asserted non-empty below.
const LIB_FILES = ['mask.ts', 'geo.ts', 'depthGate.ts', 'boatDepth.ts'] as const;
const libSources = import.meta.glob<string>(
  ['../lib/mask.ts', '../lib/geo.ts', '../lib/depthGate.ts', '../lib/boatDepth.ts'],
  { query: '?raw', import: 'default', eager: true },
);

function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (quote !== null) {
      out += c;
      if (c === '\\') {
        out += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      out += ' ';
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const TYPES_SPECIFIER = /^\.\.\/types(\.[jt]s)?$/;

function isTypeOnlyClause(clause: string): boolean {
  const c = clause.trim();
  if (/^type\s+from$/.test(c)) return false;
  if (/^type(\s+[A-Za-z_$*]|\s*\{)/.test(c)) return true;
  const braces = /\{([^}]*)\}/.exec(c);
  if (braces === null || c.replace(braces[0], '').replace(/[\s,]/g, '') !== '') return false;
  const names = braces[1]!
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return (
    names.length > 0 &&
    names.every((s) => /^type\s+/.test(s) && !/^type\s+as\s+[A-Za-z_$]+$/.test(s))
  );
}

/** Returns one description per import/export of `../types` that can carry a value. */
function findTypesValueImports(source: string): string[] {
  const code = stripComments(source);
  const hits: string[] = [];
  const specifier = `(?<q>['"\`])(?<path>[^'"\`]*)\\k<q>`;
  const fromForm = new RegExp(`\\b(?:import|export)\\b([^;'"\`]*?)\\bfrom\\s*${specifier}`, 'g');
  for (const m of code.matchAll(fromForm)) {
    if (TYPES_SPECIFIER.test(m.groups!.path!) && !isTypeOnlyClause(m[1]!)) hits.push(m[0].trim());
  }
  const sideEffect = new RegExp(`\\bimport\\s*${specifier}`, 'g');
  for (const m of code.matchAll(sideEffect)) {
    if (TYPES_SPECIFIER.test(m.groups!.path!)) hits.push(m[0].trim());
  }
  const dynamic = new RegExp(`\\b(?:import|require)\\s*\\(\\s*${specifier}`, 'g');
  for (const m of code.matchAll(dynamic)) {
    if (TYPES_SPECIFIER.test(m.groups!.path!)) hits.push(m[0].trim());
  }
  return hits;
}

describe('#1602: lib/{mask,geo,depthGate,boatDepth} import ../types as types only', () => {
  for (const file of LIB_FILES) {
    it(`${file} has no value import of ../types`, () => {
      const source = libSources[`../lib/${file}`];
      expect(source).toBeTypeOf('string');
      expect(source!.length).toBeGreaterThan(0);
      expect(source).toContain('export');
      expect(findTypesValueImports(source!)).toEqual([]);
    });
  }

  describe('matcher positive control', () => {
    const VALUE_FORMS: Record<string, string> = {
      'named value': `import { DEFAULT_SETTINGS } from '../types';`,
      'default value': `import Types from "../types";`,
      'default plus inline type': `import Types, { type LatLon } from '../types';`,
      'inline type plus value': `import { type LatLon, DEFAULT_SETTINGS } from '../types';`,
      namespace: `import * as T from '../types';`,
      'side effect': `import '../types';`,
      'side effect double quote': `import "../types";`,
      'named re-export': `export { DEFAULT_SETTINGS } from '../types';`,
      'star re-export': `export * from '../types';`,
      'backtick specifier': 'import { DEFAULT_SETTINGS } from `../types`;',
      'multi-line': `import {\n  type LatLon,\n  DEFAULT_SETTINGS,\n} from\n  '../types';`,
      'explicit extension': `import { DEFAULT_SETTINGS } from '../types.ts';`,
      'dynamic import': `const t = await import('../types');`,
      'renamed value named type': `import { type as alias } from '../types';`,
      'empty braces': `import {} from '../types';`,
      'after a type import': `import type { LatLon } from '../types';\nimport { DEFAULT_SETTINGS } from '../types';`,
    };
    const TYPE_ONLY_FORMS: Record<string, string> = {
      'import type': `import type { LatLon, MaskMeta } from '../types';`,
      'import type double quote': `import type { LatLon } from "../types";`,
      'import type default': `import type Types from '../types';`,
      'import type namespace': `import type * as T from '../types';`,
      'all inline types': `import { type LatLon, type MaskMeta } from '../types';`,
      'multi-line type': `import type {\n  LatLon,\n  MaskMeta,\n} from\n  '../types';`,
      'type re-export': `export type { LatLon } from '../types';`,
      'other module value import': `import { something } from '../other';`,
      'comment mention': `// import { DEFAULT_SETTINGS } from '../types';\n/* import '../types'; */\nexport const a = 1;`,
      'no import': `export const a = 1;`,
    };

    for (const [name, src] of Object.entries(VALUE_FORMS)) {
      it(`flags: ${name}`, () => {
        expect(findTypesValueImports(src)).not.toEqual([]);
      });
    }
    for (const [name, src] of Object.entries(TYPE_ONLY_FORMS)) {
      it(`passes: ${name}`, () => {
        expect(findTypesValueImports(src)).toEqual([]);
      });
    }
  });
});
