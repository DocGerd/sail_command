# SailCommand — Identity Rationale

**A DocGerdSoft product identity, derived from the DocGerdSoft brand system.**

## Concept — "Datum → Waterline"

The DocGerdSoft symbol is an equilateral delta split by a horizontal datum line. SailCommand
keeps that exact construction and gives the datum product meaning: **the datum line becomes
the waterline.** The upper triangle of the delta reads as a sail; the delta's base, tapered
inward below the slot, reads as a hull. Nothing is added — no mast, no waves, no rope
clichés — the mark is still two flat shapes separated by one horizontal gap, exactly like
the parent mark. Color: SailCommand takes **Azure (#2C6CB0)**, the signature accent of the
family — blue is the obvious hue for water, and critically it is the only family accent that
does not collide with any Okabe-Ito semantic map color (teal/green ≈ starboard #009E73,
rose ≈ waypoints #CC79A7). The neutral core (paper/ink/hairline/graphite) is inherited
unchanged.

Two other directions considered (both DocGerdSoft derivations):
1. **Course Delta** — keep the parent mark untouched, extend the datum line into a rhumb
   line through the lockup; identity carried only by color and the deep-navy brand field.
   Rejected: too weak a product signal; icon indistinguishable from the parent at 16 px.
2. **Sounding Lines** — line-variant delta with two extra datum strokes below, echoing
   bathymetric depth contours. Rejected: three hairline strokes die at favicon size and
   the mark stops reading as one object in a maskable crop.
Chosen: **Datum → Waterline**, because it converts the system's single most distinctive
element into the product's meaning with zero added complexity, and it is the only direction
that survives both the 16 px favicon and the maskable crop intact.

## Derivation table

| DocGerdSoft element | Status | SailCommand value / reason |
|---|---|---|
| Neutral core (paper, ink, hairline, graphite) | **Inherited** | `--sc-bg/-fg/-border` = paper/ink/hairline verbatim, both modes. |
| Accent = one per product, hue-rotated family | **Inherited** | Azure #2C6CB0 / #5E9BE0 (dark). Only family accent clear of all Okabe-Ito map hues. |
| Accent-strong (hover/pressed) | **Inherited** | #21568C / #82B2E8, exposed as `--sc-accent-strong`. |
| Functional info/warning/danger | **Adapted** | Banner fg = new "strong" shades (#7A5414, #9E3529) darkened per the accent→accent-strong logic; parent values #9A6B1A/#BC4438 miss 4.5:1 on tinted banner backgrounds (4.05 / 4.43). Dark mode uses parent values verbatim on new dark tints. |
| Banner backgrounds | **Adapted** | Parent defines no banner surfaces; tints derived per accent-tint logic (#EAF1F8 is the parent's own accent-tint). |
| Mark: delta + datum slot, 100-box, currentColor | **Adapted** | Same apex (50,22.59→shifted-center equilateral), same slot device; base tapered inward = hull, datum = waterline. Slot widened 5.5→7 units so the waterline still renders (≥1 px) at 16 px favicon — cockpit/sunlight legibility. |
| Wordmark: Geist 600, −0.025 em | **Inherited** | "SailCommand", converted to paths (constraint 3). |
| Lockup: mark + 1 px rule @18% + wordmark | **Inherited** | Same metrics, scaled. |
| Endorsement convention | **Proposed** (parent defines none) | Kicker line "BY DOCGERDSOFT" in Geist Mono 500, uppercase, 0.16 em tracking — the system's own kicker idiom — set under the product wordmark at ~1/3 its size. |
| Favicon/app-icon bg: near-black #0D0E10 | **Overridden** | `--sc-brand` #10243D — azure hue at ink depth ("chart navy"). Reasons: (a) the icon bg doubles as the PWA splash background — pure near-black reads as a dead screen at launch; (b) parent's own rule allows accent-colored product avatars; (c) keeps the fleet distinction: DocGerdSoft = black, SailCommand = navy. Same value both modes (one manifest theme_color). |
| Typography in UI: Geist webfont | **Overridden by HARD CONSTRAINT 2** | UI stays system-ui. Geist appears only inside SVG artwork, converted to paths. |
| Grid/spacing/radius scales | **Inherited** | 8-pt spacing, radii, 70ch measure — for any future non-map surfaces. |
| © line, no-company rule | **Inherited** | "© 2026 Patrick Kuhn"; no GmbH/®/™ anywhere. |

## Contrast (WCAG 2.1, computed)

| Pair | Light | Dark |
|---|---|---|
| fg on bg | 17.51:1 | 16.61:1 |
| accent as text on bg | 5.23:1 | 6.66:1 |
| info fg on info bg | 6.64:1 | 7.27:1 |
| warning fg on warning bg | 5.85:1 | 6.76:1 |
| error fg on error bg | 5.96:1 | 5.43:1 |
| white mark on --sc-brand | 15.65:1 | (same) |
| banner-art kicker #82B2E8 on brand | 7.07:1 | (same) |
| social-card tagline #C2C7CD on brand | 9.20:1 | (same) |
| banner tagline #ECEEF1 on brand | 13.46:1 | (same) |

All text-bearing pairs ≥ 4.5:1. Secondary EN tagline in artwork (#969CA4 on navy, 5.66:1) is decorative large-type in raster-only contexts, and still clears 4.5.

## Constraint conflicts & resolutions

1. **Geist vs. no-webfonts (HC 2):** constraint wins. UI typography = system-ui; brand font
   exists only as outlined paths inside the four SVG assets.
2. **Okabe-Ito map palette (HC 1):** untouched. Accent choice was made *around* it — azure
   #2C6CB0 is distinguishable from boat-blue #0072B2 in adjacent UI (darker, less cyan), and
   the map keeps #0072B2 as specified. No change proposed to any semantic map color.
3. **DocGerdSoft near-black icon bg vs. nautical PWA context:** overridden to #10243D
   (see table) — flagged here as the one deliberate brand-color deviation.
4. **Slot width 5.5→7 units:** deviation from parent mark geometry, required for the 16 px
   favicon (parent solves this with a line variant; a line variant cannot double as a
   maskable app icon, so the solid mark itself had to survive).

## Asset notes

- `icon.svg` — 512×512, flat, self-bg #10243D; motif spans 50–59% — inside the maskable
  ~60% safe zone; waterline slot ≥ 1 px at 16 px.
- `wordmark.svg` — fills with `currentColor`: inherits ink on light surfaces, paper on dark.
- `banner.svg` / `social-card.svg` — self-contained, paths only, no text/filters/gradients;
  German tagline first, English second (crew is German-primary).
- Tagline avoids authority claims: "Planung/planning", never "Navigation".

© 2026 Patrick Kuhn
