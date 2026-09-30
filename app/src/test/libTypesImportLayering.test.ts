import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// #1602: these lib modules may import `../types` as types only, so a value
// import cannot pull `types.ts` (and `DEFAULT_SETTINGS`) into them. The tsconfigs
// set `verbatimModuleSyntax`, under which only `import type` / `export type`
// is elided: `import { type A }` still emits `import {} from '../types'`.
// `?raw` is only vacuous for `.css`; each read is asserted non-empty below.
const LIB_FILES = ['mask.ts', 'geo.ts', 'depthGate.ts', 'boatDepth.ts'] as const;
const libSources = import.meta.glob<string>(
  ['../lib/mask.ts', '../lib/geo.ts', '../lib/depthGate.ts', '../lib/boatDepth.ts'],
  { query: '?raw', import: 'default', eager: true },
);

const TYPES_TARGET = 'src/types';

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function resolvesToTypes(specifier: string, fileName: string): boolean {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return false;
  const dir = fileName.split('/').slice(0, -1).join('/');
  const resolved = normalizePath(specifier.startsWith('/') ? specifier : `${dir}/${specifier}`);
  return (
    resolved === TYPES_TARGET ||
    resolved === `${TYPES_TARGET}/index` ||
    resolved.startsWith(`${TYPES_TARGET}.`)
  );
}

/** One description per import/export of `src/types` that is not `import type`/`export type`. */
function findTypesValueImports(source: string, fileName = 'src/lib/x.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: string[] = [];
  const flag = (node: ts.Node) => hits.push(node.getText(sf));
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (resolvesToTypes(node.moduleSpecifier.text, fileName) && !node.importClause?.isTypeOnly) {
        flag(node);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (resolvesToTypes(node.moduleSpecifier.text, fileName) && !node.isTypeOnly) flag(node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      if (resolvesToTypes(node.moduleReference.expression.text, fileName) && !node.isTypeOnly) {
        flag(node);
      }
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const callsModule =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require');
      if (callsModule && arg !== undefined && ts.isStringLiteralLike(arg)) {
        if (resolvesToTypes(arg.text, fileName)) flag(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('#1602: lib/{mask,geo,depthGate,boatDepth} import ../types as types only', () => {
  for (const file of LIB_FILES) {
    it(`${file} has no value import of ../types`, () => {
      const source = libSources[`../lib/${file}`];
      expect(source).toBeTypeOf('string');
      expect(source!.length).toBeGreaterThan(0);
      const fileName = `src/lib/${file}`;
      const parsed = ts.createSourceFile(fileName, source!, ts.ScriptTarget.Latest, true);
      expect(parsed.statements.length).toBeGreaterThan(0);
      expect(findTypesValueImports(source!, fileName)).toEqual([]);
    });
  }

  describe('matcher positive control', () => {
    const VALUE_FORMS: Record<string, string> = {
      'named value': `import { DEFAULT_SETTINGS } from '../types';`,
      'default value': `import Types from "../types";`,
      'inline type only': `import { type LatLon } from '../types';`,
      'default plus inline type': `import Types, { type LatLon } from '../types';`,
      'inline type plus value': `import { type LatLon, DEFAULT_SETTINGS } from '../types';`,
      namespace: `import * as T from '../types';`,
      'side effect': `import '../types';`,
      'side effect double quote': `import "../types";`,
      'named re-export': `export { DEFAULT_SETTINGS } from '../types';`,
      'star re-export': `export * from '../types';`,
      'backtick dynamic specifier': 'const t = await import(`../types`);',
      'multi-line': `import {\n  type LatLon,\n  DEFAULT_SETTINGS,\n} from\n  '../types';`,
      'explicit extension': `import { DEFAULT_SETTINGS } from '../types.ts';`,
      'dynamic import': `const t = await import('../types');`,
      'renamed value named type': `import { type as alias } from '../types';`,
      'dot-slash-dot-dot': `import { DEFAULT_SETTINGS } from './../types';`,
      'indirect dot-dot': `import { DEFAULT_SETTINGS } from '../lib/../types';`,
      'vite absolute': `import { DEFAULT_SETTINGS } from '/src/types';`,
      'index form': `import { DEFAULT_SETTINGS } from '../types/index';`,
      'require call': `const t = require('../types');`,
      'import equals require': `import t = require('../types');`,
      'regex literal before value import': `const re = /[/*]/;\nimport { DEFAULT_SETTINGS } from '../types';\n/** doc */`,
      'semicolon-less': `export type X = { a: 1 }\nimport { DEFAULT_SETTINGS } from '../types'`,
      'empty braces': `import {} from '../types';`,
      'after a type import': `import type { LatLon } from '../types';\nimport { DEFAULT_SETTINGS } from '../types';`,
    };
    const TYPE_ONLY_FORMS: Record<string, string> = {
      'import type': `import type { LatLon, MaskMeta } from '../types';`,
      'import type double quote': `import type { LatLon } from "../types";`,
      'dot-slash-dot-dot type': `import type { LatLon } from './../types';`,
      'typeof import type position': `type T = typeof import('../types');`,
      'import type default': `import type Types from '../types';`,
      'import type namespace': `import type * as T from '../types';`,
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
