import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ARM_NAMES } from '../../sweep/armNames';
import { ESTIMATE_BASED_ARM_NAMES, RIG_TIE_BAND_MS_TWIN } from '../../sweep/estimateBasedArms';
import { BOATS, DEFAULT_BOAT_ID } from '../data/boats';
import { RIG_TIE_BAND_MS } from '../routing/planRoute';

// #1716 spec T.7: the arms `compare.mjs --estimated-verdict-unsuppressed` lets
// change verdict are a hand-kept list, because sweep rows carry no boat. This
// holds that list to `sweepArms.ts` x `boats.ts`. `?raw` is only vacuous for
// `.css`; the read is asserted non-empty below.
const sources = import.meta.glob<string>('../../sweep/sweepArms.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** arm name -> `boatId` literal (undefined when the arm omits it), from the ARMS literal. */
function armBoatIds(source: string): Map<string, string | undefined> {
  const sf = ts.createSourceFile('sweepArms.ts', source, ts.ScriptTarget.Latest, true);
  const out = new Map<string, string | undefined>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ARMS' &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key =
          ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
        if (key === null) continue;
        let boatId: string | undefined;
        if (ts.isObjectLiteralExpression(prop.initializer)) {
          for (const inner of prop.initializer.properties) {
            if (
              ts.isPropertyAssignment(inner) &&
              ts.isIdentifier(inner.name) &&
              inner.name.text === 'boatId' &&
              ts.isStringLiteral(inner.initializer)
            ) {
              boatId = inner.initializer.text;
            }
          }
        }
        out.set(key, boatId);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('#1716 estimate-based sweep arms', () => {
  const source = Object.values(sources)[0] ?? '';
  const arms = armBoatIds(source);

  it('reads every arm of the ARMS literal (fail closed)', () => {
    expect(source.length).toBeGreaterThan(1000);
    expect([...arms.keys()].sort()).toEqual([...ARM_NAMES].sort());
  });

  it('lists exactly the arms whose boat has an estimated sail', () => {
    const expected = [...arms.entries()]
      .filter(([, boatId]) => {
        const id = boatId ?? DEFAULT_BOAT_ID;
        const boat = BOATS.find((x) => x.id === id);
        expect(boat, `arm boat ${id} is in the catalogue`).toBeDefined();
        return boat?.sails.some((s) => s.polarProvenance.tier === 'estimated') ?? false;
      })
      .map(([name]) => name)
      .sort();
    // Positive control: the derivation finds the arms it exists for.
    expect(expected).toContain('salona44-breeze');
    expect(expected).not.toContain('breeze');
    expect([...ESTIMATE_BASED_ARM_NAMES].sort()).toEqual(expected);
  });

  it('keeps the tie-band twin equal to the router constant', () => {
    expect(RIG_TIE_BAND_MS_TWIN).toBe(RIG_TIE_BAND_MS);
  });
});
