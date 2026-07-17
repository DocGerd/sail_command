// Copyright-holder resolution for gen-third-party-notices.mjs, kept in a
// side-effect-free module so the author-field sanitization is unit-testable
// (src/lib/copyrightHolder.test.ts) without running the generator.

// Verified upstream copyright holders for packages whose npm tarball omits
// the license text AND whose package.json author field does not match the
// copyright line of the upstream LICENSE. Checked 2026-07-16 against:
// - https://github.com/protomaps/PMTiles/blob/main/LICENSE
//   ("Copyright 2021 Protomaps LLC")
// - https://github.com/protomaps/basemaps/blob/main/LICENSE.md
//   ("Copyright 2019-2023 Protomaps LLC, Kelso Cartography"). Note: that
//   LICENSE.md is a compound file (it also contains MIT sections for Mapzen
//   2015-2018 / Linux Foundation 2019); the generated block reproduces the
//   canonical BSD-3 per the package's declared npm license.
export const COPYRIGHT_HOLDER_OVERRIDES = {
  pmtiles: '2021 Protomaps LLC',
  '@protomaps/basemaps': '2019-2023 Protomaps LLC, Kelso Cartography',
};

// Copyright holder for the license template: verified override first, then
// the package.json author field (string or object form; "<email>" and
// "(url)" decorations stripped), falling back to "the <name> authors".
export function copyrightHolder(pkg) {
  const override = COPYRIGHT_HOLDER_OVERRIDES[pkg.name];
  if (override) return override;
  const raw = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  const holder = raw
    ?.replace(/<[^>]*>/g, '')
    .replace(/\([^)]*\)/g, '')
    // The two targeted removals above are single-pass, and deleting a match
    // can splice the survivors into a NEW `<...`-shaped instance (e.g.
    // "<(x)script" -> "<script"); an unclosed "<script" never matched at all
    // (CodeQL js/incomplete-multi-character-sanitization, #69). Dropping
    // every residual angle bracket makes the result fixpoint-stable: with no
    // `<` or `>` left, no tag-shaped content can survive.
    .replace(/[<>]/g, '')
    .trim();
  return holder || `the ${pkg.name} authors`;
}
