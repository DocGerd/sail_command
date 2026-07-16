import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, '..', 'app', 'public', 'icons');
const svg = readFileSync(join(iconsDir, 'icon.svg'));

// Background color baked into icon.svg's own full-bleed square — reused here so
// the maskable canvas outside the safe zone matches instead of showing through
// as transparent (which some launchers render as black).
const BG = '#10243D';

async function renderIcon(size, outFile) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(join(iconsDir, outFile));
  console.log(`wrote icons/${outFile} (${size}x${size})`);
}

// Maskable icons are cropped to an OS-defined shape (circle, squircle, ...)
// that can eat up to ~20% of the edges, so all content must sit inside a
// centered "safe zone". We pad 20% per side: the artwork is rendered at 60%
// of the canvas and composited onto a full-bleed background square in the
// icon's own color, matching manifest.icons' `purpose: 'maskable'` entry in
// vite.config.ts.
async function renderMaskable(size, outFile) {
  const safeZone = Math.round(size * 0.6);
  const inner = await sharp(svg, { density: 384 }).resize(safeZone, safeZone).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: inner, gravity: 'center' }])
    .png()
    .toFile(join(iconsDir, outFile));
  console.log(`wrote icons/${outFile} (${size}x${size}, maskable, 20% safe-zone padding)`);
}

// Social share card (Open Graph / Twitter): a 1200x630 PNG rasterized from the
// committed docs/brand/social-card.svg. Not an app icon — it lives under
// app/public/brand/ and is referenced by an absolute og:image URL. High
// density keeps the wordmark glyphs crisp at the exact export size. It is
// deliberately kept out of the SW precache (vite.config.ts globIgnores) so it
// doesn't grow the offline install budget (#28).
async function renderSocialCard() {
  const brandSrcDir = join(here, '..', 'docs', 'brand');
  const brandOutDir = join(here, '..', 'app', 'public', 'brand');
  const cardSvg = readFileSync(join(brandSrcDir, 'social-card.svg'));
  mkdirSync(brandOutDir, { recursive: true });
  await sharp(cardSvg, { density: 300 }).resize(1200, 630).png().toFile(join(brandOutDir, 'social-card.png'));
  console.log('wrote brand/social-card.png (1200x630)');
}

await renderIcon(192, 'icon-192.png');
await renderIcon(512, 'icon-512.png');
await renderMaskable(512, 'icon-maskable-512.png');
await renderSocialCard();
