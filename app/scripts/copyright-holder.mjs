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

// Drop every angle-bracket-delimited span (and any stray '<'/'>') by scanning
// character by character, so the output can NEVER contain '<' or '>'. A '<'
// opens a span that swallows characters up to its matching '>' (depth-counted,
// so nested brackets are handled); an unclosed '<' truncates the rest of the
// string. Using a scanner instead of `.replace(/<[^>]*>/g, '')` avoids the
// "removal of a multi-character pattern can create a new instance" heuristic
// that CodeQL js/incomplete-multi-character-sanitization flags (#69) — there
// is no regex removal to be incomplete.
function stripAngleBracketed(s) {
  let out = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      if (depth > 0) depth -= 1;
    } else if (depth === 0) {
      out += ch;
    }
  }
  return out;
}

// Copyright holder for the license template: verified override first, then
// the package.json author field (string or object form). "(url)" decorations
// are stripped first, then stripAngleBracketed() removes any "<email>" span
// and every residual bracket. The scanner runs LAST on purpose: even if the
// paren strip splices survivors into a fresh "<...`-shaped fragment (e.g.
// "<(x)script" -> "<script"), the scanner then drops it, so the result is
// bracket-free by construction (#69). Falls back to "the <name> authors".
export function copyrightHolder(pkg) {
  const override = COPYRIGHT_HOLDER_OVERRIDES[pkg.name];
  if (override) return override;
  const raw = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  const holder = raw ? stripAngleBracketed(raw.replace(/\([^)]*\)/g, '')).trim() : '';
  return holder || `the ${pkg.name} authors`;
}
