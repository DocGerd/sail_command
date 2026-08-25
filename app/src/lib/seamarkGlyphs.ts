import type { Map as MaplibreMap } from 'maplibre-gl';
import type { SeamarkProperties } from '../types';

// Testing: the classification/bucketing helpers and seamarkSegments() (pure
// geometry) are unit-tested directly. registerSeamarkImages() replays those
// segments onto a canvas — same rationale as windBarbs.ts: plain jsdom's
// canvas.getContext('2d') returns null (no canvas/WebGL backend), so it
// no-ops there; registering real images against a live MapLibre GL map is
// browser-only (manual/Playwright verification).

const IMAGE_SIZE = 24; // smaller than windBarbs' 32: seamarks are a much
// denser point layer (~1,794 vs one barb per route sample). This is the
// LOGICAL glyph coordinate space every segment below is expressed in — kept
// at 24 so none of the hand-derived R1001 geometry constants (#165) below
// need touching. The registered image is drawn at a higher raster
// resolution (CANVAS_SIZE) via a canvas-transform scale in drawSeamark(), so
// every offset/line-width in the logical box scales up together instead of
// only a subset of hardcoded pixels being bumped (#191).
const CENTER = IMAGE_SIZE / 2;

// #353 PR1: a single scale-factor parameter for the whole seamark size axis —
// raster resolution here (CANVAS_SIZE/PIXEL_RATIO below), on-screen icon-size
// and the collision-padding compensation that keeps it in seamarkGeoJson.ts's
// SEAMARKS_LAYOUT. This is the DEFAULT/no-override value — reproduces every
// value below byte-for-byte (seamarkGeoJson.test.ts pins the EVALUATED
// layout, not just this constant). #353 PR2 wires the RUNTIME control:
// SettingsPanel.tsx's size slider persists an override via
// `usePersistedNumber('sc-seamark-size-scale', ...)`, and DataLayers.tsx
// falls back to this constant when none is stored.
export const SEAMARK_SIZE_SCALE = 1;

// #353 PR2: the size-control's bounds. MAX is tied to the ONE piece of
// evidence the #353 issue itself found for a size ceiling — general
// touch-target guidance (~44-48px), not anything marine-specific — rather
// than a round number: SEAMARK_NATURAL_ICON_PX (32 logical px at scale 1,
// below) times 1.5 is exactly 48. MIN is the same distance below 1 (halves
// the natural footprint to 16px) for a symmetric range; there is no
// evidence-based floor to anchor it to instead.
export const SEAMARK_SIZE_MIN = 0.5;
export const SEAMARK_SIZE_MAX = 1.5;

// #191: on-screen seamarks were only ~13-20px (IMAGE_SIZE=24 registered at
// the implicit default pixelRatio 1) — too small to read at planning zooms.
// Raising the raster resolution with a MATCHING pixelRatio (rather than only
// widening seamarkGeoJson.ts's icon-size stops, which would upscale/blur the
// old 24px bitmap) grows the natural footprint from 24 to
// BASE_CANVAS_SIZE/BASE_PIXEL_RATIO = 32 logical px while keeping the glyph
// crisp.
const BASE_CANVAS_SIZE = 64;
const BASE_PIXEL_RATIO = 2;
// CANVAS_SIZE and PIXEL_RATIO are intended to scale TOGETHER with
// SEAMARK_SIZE_SCALE, so their ratio — the glyph's "natural" on-screen
// footprint at icon-size 1, exported below as SEAMARK_NATURAL_ICON_PX —
// stays put. CANVAS_SIZE alone is meant to govern RASTER resolution (enough
// raw pixels for a larger on-screen render, via SEAMARKS_LAYOUT's icon-size,
// to stay crisp); the layer's icon-size is meant to be the ONLY thing that
// actually grows the on-screen size — if the natural footprint moved too,
// the visible growth would come from TWO independent multipliers instead of
// one, and the icon-padding compensation formula in seamarkGeoJson.ts —
// which assumes a single, well-defined growth-per-zoom-stop — would be
// wrong.
//
// #484 F4: that intent is NOT met by a bare `BASE_CANVAS_SIZE *
// SEAMARK_SIZE_SCALE`, because `canvas.width`/`canvas.height` and
// `ctx.getImageData`'s `sw`/`sh` are WebIDL `unsigned long`/`long`, so a
// fractional value TRUNCATES silently — no throw, no warning. Measured in
// real Chromium at scale 1.6 (this PR's own mutation-check scale):
// `Math.round(64 * 1.6)` = 102.4, `canvas.width` reads back **102**, and the
// real natural footprint becomes `102 / (2*1.6)` = 31.875 px — 0.125 px
// short of the idealized 32 a bare `BASE_CANVAS_SIZE / BASE_PIXEL_RATIO`
// would still claim. At scale 1 (this PR's shipped default) `64 * 1` is
// already an integer, so the truncation is a no-op and every value below is
// byte-identical to before this comment. `Math.round()` here makes
// CANVAS_SIZE the ACTUAL integer the browser will use, so
// SEAMARK_NATURAL_ICON_PX (derived from it below, not from the idealized
// BASE_CANVAS_SIZE/BASE_PIXEL_RATIO ratio) always reflects the raster that
// is really registered — the invariant holds by DEFINITION now, not "by
// construction" of an untruncated ratio that the canvas never actually
// stores. This also fixes the smaller sibling defect the truncation caused:
// `drawSeamark()`'s `ctx.scale(CANVAS_SIZE / IMAGE_SIZE, ...)` now scales by
// the SAME rounded value the canvas was actually sized to, instead of an
// untruncated `102.4 / 24` against a 102px-wide canvas (~0.4 px clipped off
// the right/bottom edge at scale 1.6, invisible there but growing with the
// fractional part at other scales).
export interface SeamarkRasterConfig {
  canvasSize: number;
  pixelRatio: number;
  /** The natural CSS-px footprint at icon-size 1 — always canvasSize /
   * pixelRatio using the ACTUAL rounded canvasSize, never the idealized
   * BASE_CANVAS_SIZE/BASE_PIXEL_RATIO ratio (#484 F4). */
  naturalIconPx: number;
}

/**
 * Pure, scale-parameterized raster config (#484 F4, mirroring
 * seamarkGeoJson.ts's `seamarksLayout(scale)` factory) — exported so a test
 * can drive a non-1 scale without a module constant standing in the way.
 * `canvasSize` is ALWAYS an integer (`Math.round`): `canvas.width`/
 * `canvas.height` and `ctx.getImageData`'s `sw`/`sh` are WebIDL
 * `unsigned long`/`long`, which TRUNCATE a fractional assignment silently —
 * no throw, no warning. Rounding here, once, makes canvasSize the value the
 * browser will actually store, so naturalIconPx (derived from THIS
 * canvasSize, not from an untruncated `BASE_CANVAS_SIZE * scale`) always
 * matches the raster that is really registered.
 */
export function seamarkRasterConfig(scale: number): SeamarkRasterConfig {
  const canvasSize = Math.round(BASE_CANVAS_SIZE * scale);
  const pixelRatio = BASE_PIXEL_RATIO * scale;
  return { canvasSize, pixelRatio, naturalIconPx: canvasSize / pixelRatio };
}

// #353 PR2: only `naturalIconPx` is still needed as a module-level constant
// (the scale-invariant export below) — `canvasSize`/`pixelRatio` are now
// read fresh per call in `registerSeamarkImages`, at whatever scale is
// passed in, rather than fixed at the default.
const { naturalIconPx: DEFAULT_NATURAL_ICON_PX } = seamarkRasterConfig(SEAMARK_SIZE_SCALE);
// Exported so seamarkGeoJson.ts's icon-padding compensation is derived from
// the SAME number rather than a duplicated literal (CLAUDE.md's "twin
// search" prose-rot rule — a duplicated 32 could silently drift from this
// one). At scale 1 this is still exactly 64/2 = 32, byte-identical to
// before #484.
export const SEAMARK_NATURAL_ICON_PX = DEFAULT_NATURAL_ICON_PX;
const INK = '#1a1a1a'; // standard black used for topmarks/outlines, not data-driven
// Cardinal-mark yellow: raw CSS `yellow` (#ffff00) is too garish / low-contrast
// against the yellow-vs-black R1001 banding, so a defined IALA-style amber-yellow
// is used for the cardinal body bands (#165).
const CARDINAL_YELLOW = '#f5c400';
// Near-white keyline stroked around cardinal bodies/cones so their black bands
// don't merge with the app's dark-theme basemap (#165, §2.4).
const OUTLINE = '#f2f2f2';

export interface Point2D {
  x: number;
  y: number;
}

/**
 * One primitive of a seamark glyph in the 24x24 icon box. Unlike
 * BarbSegment (windBarbs.ts, one constant stroke colour per icon), seamark
 * glyphs mix several data-driven fill colours in one icon (lateral red vs
 * green, cardinal/safe-water/special-purpose/isolated-danger colour
 * banding), so colour travels on the segment itself rather than being a
 * fixed canvas style.
 */
export type SeamarkSegment =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string }
  | { kind: 'polygon'; points: readonly Point2D[]; fill: string }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: string }
  | { kind: 'ring'; cx: number; cy: number; r: number; stroke: string; width: number }
  | { kind: 'line'; points: readonly Point2D[]; stroke: string; width: number };

/** Which glyph family a seamark:type resolves to. 'unknown' is a safety net
 * for a value the pipeline's core-AtoN prefix filter would never actually
 * let through — it never intentionally occurs. */
export type SeamarkFamily =
  | 'lateral'
  | 'cardinal'
  | 'safeWater'
  | 'specialPurpose'
  | 'isolatedDanger'
  | 'lightMajor'
  | 'lightMinor'
  | 'unknown';

/**
 * Classifies a raw `seamark:type` value (e.g. "buoy_lateral",
 * "beacon_cardinal", "light_minor") into a glyph family, by suffix/exact
 * match rather than a closed enum — a beacon_lateral and a buoy_lateral
 * render the same lateral glyph (colour/shape differ, not the family), and a
 * future re-pull that finds a seamark:type this repo hasn't seen yet (e.g. a
 * beacon_safe_water, absent from the current bbox pull) still degrades to
 * 'unknown' instead of a type error.
 */
export function classifySeamark(seamarkType: string): SeamarkFamily {
  if (seamarkType.endsWith('_lateral')) return 'lateral';
  if (seamarkType.endsWith('_cardinal')) return 'cardinal';
  if (seamarkType.endsWith('_safe_water')) return 'safeWater';
  if (seamarkType.endsWith('_special_purpose')) return 'specialPurpose';
  if (seamarkType.endsWith('_isolated_danger')) return 'isolatedDanger';
  if (seamarkType === 'light_major') return 'lightMajor';
  if (seamarkType === 'light_minor') return 'lightMinor';
  return 'unknown';
}

/**
 * Even base rank per family (#200), ordered in four tiers: the marks whose
 * hazard warning is self-contained come first and are never displaced;
 * everything below them is ranked on how useful the mark is AT THE SCALE WHERE
 * CULLING HAPPENS — `sc-seamarks` only collision-culls below z12 — which for
 * the middle tiers means scarcity and design range, not warning content.
 *
 * So this is NOT a pure danger-content ordering, and Tier 2 is where it
 * departs: a lighthouse and a fairway mark carry no danger information at all
 * (R1001 is explicit for safe water), yet both outrank the dense lateral
 * sequence because 6 and 23 in-area marks that anchor a landfall are what a
 * skipper reads at z8-z10, while an individual lateral out of 828 is not.
 * The tier boundary above them is the hard one: nothing may displace a
 * cardinal or isolated-danger mark, whatever its scale-appropriateness.
 *
 * #144 shipped a single ordering by on-screen prominence, which let 107 minor
 * lights systematically out-place 121 cardinals and 6 isolated-danger marks:
 * a mark warning of a hazard was no more likely to survive a collision than a
 * routine one.
 *
 * Gaps of 2 leave room for the lit-ness promotion (-1) without families ever
 * interleaving: a lit lateral (7) beats an unlit lateral (8) but never any
 * cardinal (1/2).
 *
 * Tiers, with the IALA R1001 Ed 2.0 (2022) basis for each:
 *
 * TIER 1 — the two marks whose warning is SELF-CONTAINED: one symbol carries
 * the whole message, at any scale, and nothing may displace them.
 * - `isolatedDanger` §2.3.1 — sits on a danger with navigable water all around
 *   it, and the safe passing distance "cannot be specified", so nothing else
 *   on screen implies it.
 * - `cardinal` §2.2.3 — "To indicate the safe side on which to pass a danger."
 *
 * TIER 2 — scarce marks that anchor a passage at PLANNING scale. Neither
 * carries danger information, and both are ranked on a property R1001 states
 * about them plus the fact that culling only happens below z12, where
 * scale-appropriateness is what matters:
 * - `lightMajor` §2.7.1.1 — a lighthouse provides "a long or medium range
 *   light" and "a significant daymark"; R1001 §2.7 files it under "OTHER
 *   MARKS", outside the six MBS types (§1.2), but range is precisely what
 *   makes a mark usable at small scale. 6 in the forecast area.
 * - `safeWater` §2.4.1.1 — indicates "channel entrance, port or estuary
 *   approach, landfall, or best point of passage under bridges": the decision
 *   points of a passage plan. 23 in the forecast area.
 *   §2.4.1 is explicit that it "does not mark a danger", which is why it
 *   cannot enter Tier 1 — but the same on-deck reasoning that lifts a
 *   lighthouse above the dense sequence marks lifts a fairway mark too, and
 *   granting it to one and not the other would be an unprincipled asymmetry
 *   (raised in review of #200 and accepted).
 *
 * TIER 3 — `lateral`, the dense sequence marks. §3.1 Table 16 has a "New
 * Danger" column listing Lateral, Cardinal, Isolated Danger and Emergency
 * Wreck — §3.2.2 spells it out — and §2.5.2.4 says "the limit of safe
 * navigation ... will continue to be marked by Lateral (or Cardinal) marks",
 * so laterals ARE danger-bearing and stay above everything below them. They
 * rank under Tiers 1-2 because a lateral is not a self-contained instruction:
 * §2.1.1 has them "denote the port and starboard sides of channels" relative
 * to a conventional direction of buoyage, so a single lateral is one datum on
 * a channel edge described by many marks, whereas a cardinal or
 * isolated-danger mark is a complete instruction on its own. 828 in-area.
 *
 * TIER 4 — no danger information and not scarce:
 * - `lightMinor`: §2.7 again, but short-range and dense (107 in-area).
 * - `specialPurpose`: §2.5.1 — special marks "are not generally intended to
 *   mark channels or obstructions where the MBS provides suitable
 *   alternatives".
 * - `unknown`: an unclassifiable mark must never displace a cardinal, so
 *   failing to the bottom is the safe direction.
 *
 * NOTE for a future pipeline re-pull — where the gaps actually are:
 * - R1001 §2.6's Emergency Wreck mark would rank above `isolatedDanger` (it
 *   marks a NEW danger, by definition absent from every chart AND from this
 *   app's own depth mask). OSM has no `seamark:type` for it; such a buoy is
 *   mapped as `seamark:type=buoy_special_purpose` with a blue/yellow colour
 *   tag, which passes the pipeline's `buoy_` prefix filter and then
 *   classifySeamark's `_special_purpose` suffix rule, landing at
 *   `specialPurpose` = 12 — the LOWEST real rank. It would not land in
 *   `unknown`, so a guard must watch classifySeamark, not this table's floor.
 *   No blue-striped mark (R1001 Table 11) exists in the committed pull.
 * - `light_vessel` and `light_float` (R1001 §2.7.5 Major Floating Aids) DO
 *   pass the `light_` prefix filter and then fall through classifySeamark to
 *   `unknown` = 14 — below `specialPurpose` — despite being the long-range
 *   aids the `lightMajor` bullet argues should rank high. Neither is in the
 *   current pull, so nothing is broken today.
 */
const FAMILY_RANK: Record<SeamarkFamily, number> = {
  isolatedDanger: 0,
  cardinal: 2,
  lightMajor: 4,
  safeWater: 6,
  lateral: 8,
  lightMinor: 10,
  specialPurpose: 12,
  unknown: 14,
};

/**
 * #353 PR2 (mapping corrected in review — #513 F1/F2): the display-CATEGORY
 * floor/ladder — a coarser, user-facing grouping than FAMILY_RANK above.
 * Named after, and INFORMED BY, IMO Resolution MSC.232(82) (adopted
 * 2006-12-05) Appendix 2, "SENC INFORMATION AVAILABLE FOR DISPLAY DURING
 * ROUTE PLANNING AND ROUTE MONITORING" — the ECDIS Display Base / Standard
 * Display / All Other Information split, verified against the resolution's
 * own text (not a paraphrase) — but NOT a literal rendering of it: Appendix
 * 2 item 1 (Display Base) lists only coastline, the safety contour, and
 * isolated (underwater and fixed) dangers, and explicitly does NOT include
 * any aid-to-navigation class — "buoys, beacons, other aids to navigation
 * and fixed structures" is item 2.3, i.e. STANDARD, undivided (no
 * distinction between cardinal/lateral/safe-water/light buoys). This app's
 * BASE tier is a DELIBERATE, product-specific safety floor broader than
 * IMO's own Display Base, keeping `cardinal`/`lateral` (channel-edge and
 * danger-passing marks) plus `safeWater`/`lightMajor` (scarce
 * landfall/passage anchors) non-optional even at the most restrictive
 * declutter setting — never a literal "this is what Display Base contains"
 * claim. An EARLIER revision of this comment made exactly that false claim,
 * citing superseded IMO A.817(19) §1.4 (whose "including buoys and beacons"
 * clause was REMOVED when MSC.232(82) superseded it) — that citation was
 * wrong and is not used here. Three tiers, cumulative (each includes every
 * family in the tiers below it):
 *
 * - BASE (product floor, broader than IMO's Display Base — see above):
 *   `isolatedDanger`, `cardinal`, `lateral`, `safeWater`, `lightMajor`.
 * - STANDARD (default) adds: `lightMinor`, `unknown`, and — since the #521
 *   maintainer ruling (2026-08-21) — the ENTIRE `specialPurpose` family,
 *   all 703 (26 distinct raw category strings; measured, not assumed),
 *   every one of which is a point mark whatever it annotates. Appendix 2
 *   item 2.3's undivided AtoN group covers the whole family, and this app
 *   used to carve two categories out to ALL as a declutter choice; #521
 *   reversed that (full reasoning in the ALL bullet below). The 584
 *   categories that were ALREADY Standard-tier before #521 are e.g.
 *   `leading` (64), `clearing` (3 — the *Gefahrenpeilung* this repo's own
 *   German-terminology notes name, #300), `no_entry`, `firing_danger_area`,
 *   `warning`, `yachting`, `recording`, `odas`, `recreation_zone`,
 *   `recreational`, `mooring`, `marine_farm`, `target`, `degaussing_range`,
 *   `foul_ground`, `lanby`, `unknown_purpose`, `wave_recorder`, `notice`,
 *   and an untagged/`(none)` category (281 of 703, the plurality) — which
 *   cannot be shown to be anything OTHER than Standard-tier AtoN content,
 *   so it defaults to the more visible tier, not the more hidden one, per
 *   the guard-asymmetry principle #513 F2 applies to `unknown`. `unknown`
 *   moved here from ALL for the same reason F2 raised: an unclassifiable
 *   mark must fail toward being SHOWN. An earlier revision also cited item
 *   2.6's "prohibited and restricted areas" here; dropped, because every
 *   shipped feature is a Point — the same category error as the item-3.2
 *   claim below.
 * - ALL: no `specialPurpose` category lands here any more, and no other
 *   family ever did (see `DISPLAY_TIER_OF_FAMILY` below) — so at the
 *   shipped data ALL is INERT: selecting it renders identically to
 *   STANDARD. This is the "honest cost" #521 itself named (three radio
 *   buttons, two distinct outcomes; BASE still differs).
 *   `SPECIAL_PURPOSE_ALL_CATEGORIES` is kept as a live (now-empty) Set
 *   rather than deleted, so a FUTURE product decision to decant some other
 *   category to ALL has somewhere to land without re-plumbing
 *   `specialPurposeDisplayTier`.
 *
 *   Until #521, `cable` (117 marks) and `pipeline` (2) were the two
 *   categories tiered ALL — a DELIBERATE DECLUTTERING CHOICE, a departure
 *   from the ECDIS convention rather than an application of it. An earlier
 *   revision justified that with Appendix 2 item 3.2's "submarine cables
 *   and pipelines"; that was a CATEGORY ERROR and is not used here. Item
 *   3.2 is plain English and names no object class; in S-57 that content
 *   is `CBLSUB` (Line) / `PIPSOL`, whereas all 1794 features in the
 *   shipped data are POINTS (measured 2026-08-13: zero lines, zero
 *   areas) — `category=cable` is S-57 CATSPM 6, "cable mark", a point aid
 *   to navigation under item 2.3 exactly like every other STANDARD-tier
 *   mark. The maintainer ruling on #521 (2026-08-21) resolved the
 *   resulting product question in favour of showing them: at the Standard
 *   default the cable/pipeline mark was the ONLY on-chart cue that a
 *   submarine cable or pipeline exists at all, in the Flensburg Fjord /
 *   Danish South Sea area where anchoring is routine — hiding it removed
 *   the sole warning rather than decluttering a redundant one.
 *
 *   **UNVERIFIED, and NOT settled by the #521 ruling**: the S-52
 *   Presentation Library's own lookup tables assign display category per
 *   object class AND attribute, and are not freely retrievable (registered
 *   distribution) — nobody has checked whether PresLib places `BOYSPP` +
 *   `CATSPM=6` in OTHER. #521's ruling is a PRODUCT decision made without
 *   that data, not a resolution of the PresLib question; it stays open for
 *   a future issue, not this one.
 *
 * At the shipped data (measured against `app/public/data/seamarks.json`,
 * 1794 features: lateral 828, specialPurpose 703 [cable 117, pipeline 2,
 * everything else 584], cardinal 121, lightMinor 107, safeWater 23,
 * lightMajor 6, isolatedDanger 6, unknown 0), the default (STANDARD) now
 * hides ZERO `specialPurpose` marks — not the 119 cable/pipeline marks it
 * hid before #521, and not the 810 the family-level mapping in the FIRST
 * #353 PR2 revision hid (#513's Blocker F1). That does NOT depend on
 * whether `safeWater`/`lightMajor` sit in BASE or STANDARD (both are shown
 * at the STANDARD default either way) — only on the `specialPurpose` split,
 * which #521 made a no-op.
 */
export type SeamarkDisplayTier = 0 | 1 | 2;
export const SEAMARK_DISPLAY_TIER_BASE = 0;
export const SEAMARK_DISPLAY_TIER_STANDARD = 1;
export const SEAMARK_DISPLAY_TIER_ALL = 2;
/** Standard, per the #353 issue's own design sketch ("Standard (default)")
 * — and MSC.232(82) §3.4 makes Standard Display the mode "intended to be
 * used as a minimum during route planning and route monitoring"; route
 * planning is what this app is for.
 * NOT because ECDIS loads into it: an earlier revision of this comment
 * cited §3.4 for a load default, which the resolution does not say — §5.4
 * has power-up return to "the most recent manually selected settings".
 * Post #521 (maintainer ruling 2026-08-21): the STANDARD default now shows
 * the ENTIRE `specialPurpose` family out of the box, `cable`/`pipeline`
 * included — the #513 F1/F2 carve-out to ALL is reversed; see the
 * tier-ladder doc comment above for the full reasoning and for why ALL is
 * now inert for today's shipped data. */
export const DEFAULT_SEAMARK_DISPLAY_TIER: SeamarkDisplayTier = SEAMARK_DISPLAY_TIER_STANDARD;

/** The `specialPurpose` categories this app declutters to the ALL tier —
 * EMPTY since the #521 maintainer ruling (2026-08-21): `cable` and
 * `pipeline` moved to STANDARD (see `seamarkDisplayTier`'s doc comment
 * above for the full reasoning and the still-UNVERIFIED PresLib caveat).
 * A product choice, not an Appendix 2 item 3.2 application. Kept as a live
 * Set rather than deleted or inlined to a constant `false` — the mechanism
 * (and `specialPurposeDisplayTier`'s compound-tag handling below) stays
 * ready for a FUTURE product decision to decant some other category to
 * ALL, without needing to re-plumb this function. */
const SPECIAL_PURPOSE_ALL_CATEGORIES = new Set<string>();

/** The `specialPurpose` family is now a UNIFORM display tier (#521,
 * reversing #513 F1/F2's cable/pipeline carve-out to ALL) — the whole
 * family, `cable`/`pipeline` included, stays STANDARD as point AtoN
 * content (MSC.232(82) Appendix 2 item 2.3).
 * `SPECIAL_PURPOSE_ALL_CATEGORIES` being empty is what makes this uniform
 * in practice; the split logic below is retained for a possible future
 * category (see that Set's own doc comment). */
function specialPurposeDisplayTier(category: string | undefined): SeamarkDisplayTier {
  const tokens = (category ?? '').split(';').map((s) => s.trim());
  return tokens.some((t) => SPECIAL_PURPOSE_ALL_CATEGORIES.has(t))
    ? SEAMARK_DISPLAY_TIER_ALL
    : SEAMARK_DISPLAY_TIER_STANDARD;
}

const DISPLAY_TIER_OF_FAMILY: Record<
  Exclude<SeamarkFamily, 'specialPurpose'>,
  SeamarkDisplayTier
> = {
  isolatedDanger: SEAMARK_DISPLAY_TIER_BASE,
  cardinal: SEAMARK_DISPLAY_TIER_BASE,
  lateral: SEAMARK_DISPLAY_TIER_BASE,
  safeWater: SEAMARK_DISPLAY_TIER_BASE,
  lightMajor: SEAMARK_DISPLAY_TIER_BASE,
  lightMinor: SEAMARK_DISPLAY_TIER_STANDARD,
  unknown: SEAMARK_DISPLAY_TIER_STANDARD,
};

/** The display-category tier a seamark belongs to (#353 PR2) — the LOWEST
 * tier a user must select to still see this mark; `seamarkGeoJson.ts` stamps
 * this onto every feature as `displayTier` and the `sc-seamarks` layer's
 * `filter` keeps a feature only while the selected tier is >= its own.
 * `specialPurpose` is the one family whose tier is NOT a pure function of
 * the family alone — see `specialPurposeDisplayTier` above. */
export function seamarkDisplayTier(props: SeamarkProperties): SeamarkDisplayTier {
  const family = classifySeamark(props.seamarkType);
  if (family === 'specialPurpose') return specialPurposeDisplayTier(props.category);
  return DISPLAY_TIER_OF_FAMILY[family];
}

/**
 * Narrows a `usePersistedNumber` read (`number | null`) to a real
 * `SeamarkDisplayTier`, replacing an unchecked `as SeamarkDisplayTier` cast
 * at both call sites (#513 F8). localStorage is user-writable and survives
 * across app versions, so `n` can be a hand-edited or legacy value that is
 * not one of the three real tiers — e.g. `1.5`, or an ordinal a FUTURE
 * version defines that this one does not recognize. A bare cast asserts
 * membership without checking it: that `1.5` would silently build
 * `['<=', ['get','displayTier'], 1.5]`, which happens to behave like
 * STANDARD — a wrong answer with no visible failure.
 *
 * Two DIFFERENT fallbacks for two DIFFERENT situations, not one:
 * - `n === null` means "no override stored" — the legitimate empty state
 *   `usePersistedNumber`'s own contract documents — and falls back to the
 *   product default (`DEFAULT_SEAMARK_DISPLAY_TIER`).
 * - Any OTHER non-tier value is corrupt/unrecognized DATA, not an absence,
 *   and falls back to the MOST-VISIBLE tier (ALL) — the same guard-asymmetry
 *   principle as `unknown`'s family fallback above (#513 F2): an
 *   unrecognized value must fail toward SHOWING more, never toward
 *   whatever number happened to be stored.
 *
 * That second guarantee depends on BOTH call sites (`DataLayers.tsx`,
 * `SettingsPanel.tsx`) reading `usePersistedNumber('sc-seamark-display-tier',
 * -Infinity, Infinity)` — UNCLAMPED (#513 R4). `usePersistedNumber`'s own
 * `clamp(n, min, max)` runs BEFORE this function ever sees the value, so a
 * [BASE, ALL]-bounded read would launder a stored `-1` into `0` = BASE — the
 * MOST-HIDDEN tier — before this guard could see anything but a
 * legitimate-looking in-range number. Only a value OUTSIDE [0, 2], or a
 * non-integer inside it, reaches the `SEAMARK_DISPLAY_TIER_ALL` branch below;
 * an integer that happens to equal a real tier is indistinguishable from a
 * deliberate choice and is honoured as one — this function narrows valid
 * values, it does not second-guess them.
 */
export function toSeamarkDisplayTier(n: number | null): SeamarkDisplayTier {
  if (n === null) return DEFAULT_SEAMARK_DISPLAY_TIER;
  if (
    n === SEAMARK_DISPLAY_TIER_BASE ||
    n === SEAMARK_DISPLAY_TIER_STANDARD ||
    n === SEAMARK_DISPLAY_TIER_ALL
  ) {
    return n;
  }
  return SEAMARK_DISPLAY_TIER_ALL;
}

/**
 * Collision-culling priority for the `sc-seamarks` layer's
 * `symbol-sort-key` (#144): LOWER sorts first, and MapLibre places symbols
 * in sort order, so lower keys win collisions. Stamped per feature at
 * data-build time (seamarkFeatureCollectionWithIcons) — never re-derived in
 * a style expression. Lit marks (any light field present) outrank unlit
 * peers of the same family; integers only.
 *
 * The lit-ness promotion is deliberately smaller than the family gap, so it
 * can only ever reorder marks WITHIN a family (#200): a lit lateral (7) still
 * loses to the worst unlit safe-water mark (6), and a lit lighthouse (3) still
 * loses to the worst unlit cardinal (2). Lit-ness is a visibility property,
 * never a reason to reorder the tiers above.
 */
export function seamarkPriority(props: SeamarkProperties): number {
  const lit =
    props.lightCharacter !== undefined ||
    props.lightColour !== undefined ||
    props.lightPeriod !== undefined;
  return FAMILY_RANK[classifySeamark(props.seamarkType)] - (lit ? 1 : 0);
}

type ShapeBucket = 'can' | 'conical' | 'spar' | 'spherical' | 'pillar';

/** Buckets the raw OSM `shape` tag into one of a handful of drawable
 * silhouettes. Unrecognized/absent shapes (pillar, super-buoy, tower,
 * lattice, ...) fall back to 'pillar' — the generic buoy body. */
function bucketShape(shape: string | undefined): ShapeBucket {
  switch (shape) {
    case 'can':
    case 'barrel':
      return 'can';
    case 'conical':
      return 'conical';
    case 'spar':
    case 'stake':
    case 'pile':
    case 'pole':
      return 'spar';
    case 'spherical':
      return 'spherical';
    default:
      return 'pillar';
  }
}

const KNOWN_CSS_COLOURS = new Set([
  'red',
  'green',
  'yellow',
  'black',
  'white',
  'grey',
  'gray',
  'orange',
  'blue',
]);

/** Normalizes one OSM colour token to a CSS colour, defaulting anything
 * unrecognized to a neutral grey rather than passing an arbitrary string
 * through to canvas fillStyle. */
function cssColour(token: string | undefined): string {
  const t = token?.trim().toLowerCase();
  return t && KNOWN_CSS_COLOURS.has(t) ? t : '#888888';
}

/** Splits a raw OSM colour tag ("yellow;black;yellow", the rare
 * colon-typo'd "black:yellow:black") into normalized CSS colour tokens. */
function colourTokens(colour: string | undefined): string[] {
  if (!colour) return [];
  return colour
    .split(/[;:]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(cssColour);
}

/** First colour token, or a neutral grey fallback — used where a glyph has
 * one dominant fill rather than a banded pattern (lateral buoy bodies). */
function primaryColour(colour: string | undefined): string {
  return colourTokens(colour)[0] ?? '#888888';
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fills `box` with equal-sized bands of `tokens` (>=1), horizontal or
 * vertical. Falls back to a single neutral-grey band when no colour tag was
 * present at all. */
function bandSegments(
  tokens: readonly string[],
  orientation: 'horizontal' | 'vertical',
  box: Box,
): SeamarkSegment[] {
  const fills = tokens.length > 0 ? tokens : ['#888888'];
  return fills.map((fill, i) => {
    if (orientation === 'horizontal') {
      const bandH = box.h / fills.length;
      return { kind: 'rect', x: box.x, y: box.y + i * bandH, w: box.w, h: bandH, fill };
    }
    const bandW = box.w / fills.length;
    return { kind: 'rect', x: box.x + i * bandW, y: box.y, w: bandW, h: box.h, fill };
  });
}

/**
 * R1001 Ed 2.0 §2.2 Tables 5–6: a lateral mark's topmark SHAPE is tied to the
 * side of the channel, never to its colour — a port-hand mark carries a single
 * CAN, a starboard-hand mark a single CONE point up. That mapping is
 * region-independent (Region B swaps the colours and keeps the shapes), so it
 * is a fixed convention here rather than anything data-driven beyond category.
 *
 * The two preferred-channel categories INVERT relative to their name, and an
 * `endsWith('port')` test would get both of them wrong: a
 * `preferred_channel_port` mark says the preferred channel lies to port, i.e.
 * leave the mark to starboard — it is a modified STARBOARD-hand mark and
 * carries a cone. Hence the explicit table.
 *
 * Category is the only sound source: in the committed pull, **51** laterals
 * carry a colour that contradicts their category, and deriving the side from
 * the colour would put the wrong side indication on every one of them. 45 of
 * the 51 carry a colour naming the wrong side or no side at all — 18 port
 * marks tagged black, 15 port and 9 starboard grey, 2 starboard white, and one
 * PORT mark green — and the remaining 6 (4 starboard, 2 port) carry NO colour
 * tag at all, so `primaryColour` resolves them to the neutral grey fallback.
 * (Measured: no lateral carries an unrecognized colour token; the fallback is
 * reached only by absence.) 51 is the canonical figure and the one the
 * CHANGELOG uses — quote it, not the 45-mark enumeration above (#298).
 *
 * Reach, extended by #307: the pillar bucket's 11 (#298) and the spar
 * bucket's 39 of those 51 are now corrected — every bucket that draws a
 * topmark keys it off `category`, never `colour`. Measured, spar bucket only
 * (shape in {spar,stake,pile,pole}, colour contradicting category): 18 port
 * tagged black, 8 port / 5 starboard grey, 2 starboard white, 2 port / 4
 * starboard untagged = 39. The one remaining mark (a PORT buoy tagged green)
 * is a `can`, untouched by design rather than omission: a can's SILHOUETTE
 * already indicates port per R1001 regardless of its colour tag — unlike a
 * spar or pillar, a uniform body shape with no side information of its own —
 * so it was never actually resting on colour the way the other 50 were.
 */
const LATERAL_TOPMARK: Record<string, 'can' | 'cone'> = {
  port: 'can',
  preferred_channel_starboard: 'can', // modified port-hand mark (red, green band)
  starboard: 'cone',
  preferred_channel_port: 'cone', // modified starboard-hand mark (green, red band)
};

/**
 * Pillar/unknown-shape lateral budget in the 24×24 box (#298). Before this,
 * the body (x 9..15) and a ball topmark (cx 12, r 3 -> x 9..15) were the SAME
 * WIDTH, overlapped by 1px and shared one fill, so the pair rendered as a
 * single rounded-top box rather than a topmark above a body.
 *
 * The three separators are the ones the compliant cardinal glyph already uses:
 * a background GAP (2 units between topmark and body here, against the
 * cardinal's 1 — both measured between shape outlines, which is also what the
 * S1 test measures; in rendered INK the keyline stroke costs 0.5 wherever it
 * traces an outer edge, so the cone reads 1.5 and the cardinal 0.5, while the
 * can keeps the full 2 because its keyline is inset), a WIDTH CONTRAST
 * (topmark 6 vs. body 8 — the cardinal runs 8 vs. 10), and the near-white
 * KEYLINE. Equal width is what actually reads as "one shape", so the contrast
 * is not decoration.
 */
const LATERAL_PILLAR_BODY: Box = { x: 8, y: 9, w: 8, h: 12 };
const LATERAL_CAN_TOPMARK: Box = { x: 9, y: 2, w: 6, h: 5 };
const LATERAL_CONE_TOPMARK: readonly Point2D[] = [
  { x: 12, y: 1 },
  { x: 15, y: 7 },
  { x: 9, y: 7 },
];

/**
 * Spar lateral topmark budget (#307). The spar body (x 10..14, w4, y5..21) is
 * a thin pole occupying nearly the full canvas height, leaving only y0..5 of
 * clear space above it — far less than the pillar's y0..9. Both shapes still
 * use the S1/S2 rules from the pillar docblock above (>=1 unit empty band,
 * >=2 units of width contrast), just at the tighter budget this shape allows:
 * topmark box y1..4 (h3) against the body's y5 gives S1 = 1; topmark width 6
 * against the body's width 4 gives S2 = 2 — same width (6, x9..15) as the
 * pillar topmarks, reused rather than re-derived, but WIDER than this body
 * (4) where the pillar's was NARROWER than its body (8): S2's direction is
 * shape-dependent (see the S2 comment in seamarkGlyphs.test.ts), and a
 * spar's body is already narrower than either topmark shape needs to be.
 */
const LATERAL_SPAR_CAN_TOPMARK: Box = { x: 9, y: 1, w: 6, h: 3 };
const LATERAL_SPAR_CONE_TOPMARK: readonly Point2D[] = [
  { x: 12, y: 1 },
  { x: 15, y: 4 },
  { x: 9, y: 4 },
];

function lateralSegments(props: SeamarkProperties): SeamarkSegment[] {
  const fill = primaryColour(props.colour);
  switch (bucketShape(props.shape)) {
    case 'can':
      return [{ kind: 'rect', x: 7, y: 9, w: 10, h: 11, fill }];
    case 'conical':
      return [
        {
          kind: 'polygon',
          points: [
            { x: 12, y: 6 },
            { x: 18, y: 20 },
            { x: 6, y: 20 },
          ],
          fill,
        },
      ];
    case 'spar': {
      // Unlike can/conical, a spar's silhouette (a plain pole) carries no
      // side information of its own — same reasoning as the pillar case
      // below — so it needs the category-derived topmark just as much as a
      // pillar does. #307: 524 of 828 in-area lateral marks are in this
      // bucket and, before this, rendered with no topmark at all.
      const segments: SeamarkSegment[] = [{ kind: 'rect', x: 10, y: 5, w: 4, h: 16, fill }];
      switch (LATERAL_TOPMARK[props.category ?? '']) {
        case 'can':
          segments.push(
            { kind: 'rect', ...LATERAL_SPAR_CAN_TOPMARK, fill },
            bodyOutline(LATERAL_SPAR_CAN_TOPMARK),
          );
          break;
        case 'cone':
          segments.push(
            { kind: 'polygon', points: LATERAL_SPAR_CONE_TOPMARK, fill },
            coneOutline(LATERAL_SPAR_CONE_TOPMARK),
          );
          break;
      }
      return segments;
    }
    case 'spherical':
      return [{ kind: 'circle', cx: 12, cy: 13, r: 6, fill }];
    case 'pillar':
    default: {
      // A pillar (and every unrecognized shape falling back to it) has no
      // silhouette of its own that carries the side, so R1001 makes the
      // topmark the whole message here — unlike a can or conical body, where
      // the topmark is "if any" because the body already says it.
      const segments: SeamarkSegment[] = [
        { kind: 'rect', ...LATERAL_PILLAR_BODY, fill },
        bodyOutline(LATERAL_PILLAR_BODY),
      ];
      // An untagged/unrecognized category draws NO topmark rather than a
      // guessed one: showing the wrong side is worse than showing none — the
      // same nav-safety rule the cardinal path applies to an unknown category.
      switch (LATERAL_TOPMARK[props.category ?? '']) {
        case 'can':
          segments.push(
            { kind: 'rect', ...LATERAL_CAN_TOPMARK, fill },
            bodyOutline(LATERAL_CAN_TOPMARK),
          );
          break;
        case 'cone':
          segments.push(
            { kind: 'polygon', points: LATERAL_CONE_TOPMARK, fill },
            coneOutline(LATERAL_CONE_TOPMARK),
          );
          break;
      }
      return segments;
    }
  }
}

type ConeDir = 'up' | 'down';

// Cardinal topmark orientation, by category — region-independent per IALA
// R1001 Ed 2.0 §2.2.1.1 (cardinal marks are identical in Regions A and B),
// NOT data-driven (the pipeline carries no topmark tag; this is the fixed
// R1001 convention). North: both cones point up. South: both point down.
// East: base-to-base (top up, bottom down) → diamond. West: point-to-point
// (top down, bottom up) → hourglass. The cone points also indicate where the
// BLACK body band sits (N up = black top; S down = black bottom; E apart =
// black top+bottom; W inward = black middle).
const CARDINAL_CONES: Record<string, { top: ConeDir; bottom: ConeDir }> = {
  north: { top: 'up', bottom: 'up' },
  south: { top: 'down', bottom: 'down' },
  east: { top: 'up', bottom: 'down' },
  west: { top: 'down', bottom: 'up' },
};

// Body colour bands top→bottom per category, hand-derived from R1001 Tables 5–6.
const CARDINAL_BANDS: Record<string, string[]> = {
  north: [INK, CARDINAL_YELLOW], // black over yellow
  south: [CARDINAL_YELLOW, INK], // yellow over black
  east: [INK, CARDINAL_YELLOW, INK], // black-yellow-black
  west: [CARDINAL_YELLOW, INK, CARDINAL_YELLOW], // yellow-black-yellow
};

// Topmark cone geometry (24×24 box). The two cones meet at a shared middle row
// CONE_MID, with extremes CONE_TOP / CONE_BOT so every vertex stays on-canvas
// (fixes the old fixed-apex off-canvas clipping); apex on centre column CX,
// base half-width HW (x 8..16).
const CONE_TOP = 1;
const CONE_MID = 6;
const CONE_BOT = 11;
const CX = 12;
const HW = 4;

// One cone as [apex, base+HW, base−HW]. `isTop` selects the y-band; `dir` is
// the pointing (apex) direction — an up cone apexes at the smaller y of its
// band, a down cone at the larger. So a top-down and a bottom-up cone both
// apex at CONE_MID (West's hourglass), and a top-up and bottom-down cone both
// base at CONE_MID (East's diamond).
function cardinalCone(isTop: boolean, dir: ConeDir): Point2D[] {
  const rows = isTop ? [CONE_TOP, CONE_MID] : [CONE_MID, CONE_BOT];
  const [apexY, baseY] = dir === 'up' ? rows : [rows[1], rows[0]];
  return [
    { x: CX, y: apexY },
    { x: CX + HW, y: baseY },
    { x: CX - HW, y: baseY },
  ];
}

// Light near-white keyline around the body box, inset 0.5px so the 1px stroke
// isn't clipped at the y=24 canvas boundary (dark-theme legibility, §2.4).
function bodyOutline(box: Box): SeamarkSegment {
  const x0 = box.x + 0.5;
  const y0 = box.y + 0.5;
  const x1 = box.x + box.w - 0.5;
  const y1 = box.y + box.h - 0.5;
  return {
    kind: 'line',
    points: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
      { x: x0, y: y0 },
    ],
    stroke: OUTLINE,
    width: 1,
  };
}

// Light keyline tracing a cone's 3 vertices, repeating the apex to close it.
function coneOutline(points: readonly Point2D[]): SeamarkSegment {
  return { kind: 'line', points: [...points, points[0]], stroke: OUTLINE, width: 1 };
}

// The same keyline for a sphere topmark, stroked ON the circle just as
// coneOutline strokes on a cone's edges (#298). Two callers, two reasons:
// isolated danger, where the spheres sit over a black body band and above one
// another, so without it "two spheres, vertically disposed" renders as a
// single lozenge; and safe water, where nothing merges but an INK sphere on
// transparent canvas is otherwise unreadable against the dark-theme basemap.
function sphereOutline(cx: number, cy: number, r: number): SeamarkSegment {
  return { kind: 'ring', cx, cy, r, stroke: OUTLINE, width: 1 };
}

function cardinalSegments(props: SeamarkProperties): SeamarkSegment[] {
  const cat = props.category ?? '';
  const cones = CARDINAL_CONES[cat];
  const bands = CARDINAL_BANDS[cat];
  const body: Box = { x: 7, y: 12, w: 10, h: 12 };
  // Untagged / unknown category → neutral grey body with NO cones. It must
  // never masquerade as North — the exact nav-safety failure class of #165.
  if (!cones || !bands) {
    return bandSegments(['#888888'], 'horizontal', body);
  }
  const topCone = cardinalCone(true, cones.top);
  const bottomCone = cardinalCone(false, cones.bottom);
  return [
    ...bandSegments(bands, 'horizontal', body),
    bodyOutline(body),
    { kind: 'polygon', points: topCone, fill: INK },
    coneOutline(topCone),
    { kind: 'polygon', points: bottomCone, fill: INK },
    coneOutline(bottomCone),
  ];
}

// R1001 §2.4 specifies a single sphere topmark, and specifies it RED. It is
// drawn in INK here instead, deliberately: the body is red/white VERTICALLY
// striped, so a red sphere resting on it would recreate exactly the
// same-colour merge #298 exists to close. Chart practice (INT-1) likewise
// renders topmarks as black shapes whatever the mark's colour. The sphere now
// sits 2 units clear of the body outline (1.5 in rendered ink, once its
// keyline is counted) — it used to be tangent to it (#298).
function safeWaterSegments(props: SeamarkProperties): SeamarkSegment[] {
  const tokens = colourTokens(props.colour);
  const bands = bandSegments(tokens.length > 0 ? tokens : ['red', 'white'], 'vertical', {
    x: 7,
    y: 9,
    w: 10,
    h: 12,
  });
  return [...bands, { kind: 'circle', cx: CX, cy: 4, r: 3, fill: INK }, sphereOutline(CX, 4, 3)];
}

// R1001 §2.5 specifies a single X topmark; INK rather than the specified
// yellow for the same reason as the safe-water sphere above (yellow on a
// yellow body is no mark at all). Its lower tips used to reach y10 against a
// body starting at y9 — an overlap, though a cross-colour one — and now clear
// it (#298).
//
// The clearance, re-derived after the keyline was added: these are 45° lines,
// so a stroke of width w centred on the path extends w/2 PERPENDICULAR to it,
// i.e. (w/2)·sin45° ≈ 0.354·w in y — NOT w/2 straight down. The widest stroke
// on these points is the 3-wide keyline, putting worst-case ink at
// y = 7 + 1.061 = 8.061 against a body at y9: clearance ≈ 0.94.
//
// That is under the 1-unit S1 rule, and it is the ONE place where S1 does not
// bound what is actually rendered: `extentOf` measures a line by its POINTS
// and never expands by stroke width, so S1 reads this gap as 2. The mark still
// clears the body and there is no merge — but the honest number is 0.94, and
// the limitation is recorded rather than implied away.
//
// If a true ≥1 is ever wanted, NARROW THE KEYLINE — do not raise the X. The
// same 0.354·w relation runs in both directions, so the top tips already sit
// at y = 1 − 1.061 = −0.061, marginally off-canvas; lifting the glyph to buy
// 0.061 at the bottom would push the top to ≈ −0.12 and trade one end for the
// other. Solving (w/2)·sin45° ≤ 1 gives w ≤ 2.828, and w = 2.8 yields a
// clearance of 1.010 while ALSO returning the top tip on-canvas at +0.010 —
// no glyph movement, and S1's reading is unchanged either way.
//
// Opening that gap is exactly why the X needs the keyline its INK siblings
// already carry: on base its lower ~1 unit still overlapped the yellow body,
// so a fraction of it had a contrasting backdrop; now that it clears the body
// entirely, 100% of it sits on transparent canvas, where INK '#1a1a1a' is
// unreadable against the dark-theme basemap. A stroked glyph takes that
// keyline as a wider near-white UNDERLAY on the same points rather than an
// outline path — which also leaves the S1/S2 measurements untouched, since
// they read a line's extent from its POINTS and never expand by stroke width.
const SPECIAL_X_STROKES: readonly (readonly Point2D[])[] = [
  [
    { x: 9, y: 1 },
    { x: 15, y: 7 },
  ],
  [
    { x: 15, y: 1 },
    { x: 9, y: 7 },
  ],
];
const SPECIAL_X_WIDTH = 1.5;
const SPECIAL_X_KEYLINE_WIDTH = 3;

// #308: the X topmark got a near-white keyline underlay in #306, but the
// BODY box did not — a `colour=black` special-purpose mark (133 of 703 in
// the committed pull, S-57 CATSPM) is a solid INK-coloured rect on
// transparent canvas, which blends into the dark-theme basemap exactly as
// the pre-#306 X did. Same fix as every other multi-band family here
// (cardinal, isolated danger, lateral pillar/spar): a near-white
// `bodyOutline()` traced once around the whole box, unconditionally —
// harmless for a yellow/white/red body, and it also gives every band seam a
// consistent visual boundary rather than special-casing "is any band black".
const SPECIAL_BODY: Box = { x: 7, y: 9, w: 10, h: 12 };

function specialPurposeSegments(props: SeamarkProperties): SeamarkSegment[] {
  const tokens = colourTokens(props.colour);
  const bands = bandSegments(tokens.length > 0 ? tokens : ['yellow'], 'horizontal', SPECIAL_BODY);
  return [
    ...bands,
    bodyOutline(SPECIAL_BODY),
    // Both keyline underlays first, so neither can paint over the other
    // stroke's INK where the two cross at the centre of the X.
    ...SPECIAL_X_STROKES.map((points): SeamarkSegment => ({
      kind: 'line',
      points,
      stroke: OUTLINE,
      width: SPECIAL_X_KEYLINE_WIDTH,
    })),
    ...SPECIAL_X_STROKES.map((points): SeamarkSegment => ({
      kind: 'line',
      points,
      stroke: INK,
      width: SPECIAL_X_WIDTH,
    })),
  ];
}

/**
 * R1001 §2.3: black body with one or more broad red horizontal bands, topmark
 * TWO black spheres vertically disposed.
 *
 * The same #298 defect as the lateral pillar, in its worst form: the two
 * spheres (r 2.5 at cy 2.5 and cy 7) overlapped EACH OTHER by 0.5 units in one
 * INK fill, and the lower one came within 0.5 of a body whose top band is also
 * black — so the pair read as a single lozenge on a black box, losing the
 * "two spheres" that distinguish this mark from a safe-water one. Separated
 * here by 1.5 units both sphere-to-sphere and sphere-to-body, measured between
 * the circles themselves. Each keyline is stroked ON its circle, so it eats
 * 0.5 per ring FACING the gap: the sphere-to-sphere gap has a ring on BOTH
 * sides and loses 1.0, leaving 0.5, while the sphere-to-body gap has only the
 * lower sphere's ring — the body outline is inset — and loses 0.5, leaving
 * 1.0. Both are intended: two white rings meeting still read as two spheres
 * where two black fills do not.
 * The body takes the cardinal's y12 origin because a two-element topmark needs
 * the same vertical budget the cardinal's two cones do.
 */
const ISOLATED_DANGER_BODY: Box = { x: 7, y: 12, w: 10, h: 11 };
const ISOLATED_DANGER_SPHERE_R = 2;
const ISOLATED_DANGER_SPHERE_CY = [3, 8.5] as const;

function isolatedDangerSegments(props: SeamarkProperties): SeamarkSegment[] {
  const tokens = colourTokens(props.colour);
  const bands = bandSegments(
    tokens.length > 0 ? tokens : ['black', 'red', 'black'],
    'horizontal',
    ISOLATED_DANGER_BODY,
  );
  return [
    ...bands,
    bodyOutline(ISOLATED_DANGER_BODY),
    ...ISOLATED_DANGER_SPHERE_CY.flatMap((cy): SeamarkSegment[] => [
      { kind: 'circle', cx: CX, cy, r: ISOLATED_DANGER_SPHERE_R, fill: INK },
      sphereOutline(CX, cy, ISOLATED_DANGER_SPHERE_R),
    ]),
  ];
}

// Lights get a ray/star glyph rather than a buoy-body silhouette — a fixed
// light has no floating body, and the per-sector colour/range tagging on
// light_major is too complex to fold into one glyph colour (v1: a single
// neutral amber star, sized by major/minor only).
function lightSegments(major: boolean): SeamarkSegment[] {
  const r = major ? 10 : 6;
  const rayColour = '#e0a010';
  const rays = 8;
  const segments: SeamarkSegment[] = [];
  for (let i = 0; i < rays; i++) {
    const angle = (Math.PI * 2 * i) / rays;
    segments.push({
      kind: 'line',
      points: [
        { x: CENTER, y: CENTER },
        { x: CENTER + Math.cos(angle) * r, y: CENTER + Math.sin(angle) * r },
      ],
      stroke: rayColour,
      width: 1.5,
    });
  }
  segments.push({ kind: 'circle', cx: CENTER, cy: CENTER, r: major ? 3 : 2, fill: rayColour });
  return segments;
}

function unknownSegments(): SeamarkSegment[] {
  return [{ kind: 'circle', cx: CENTER, cy: CENTER, r: 5, fill: '#888888' }];
}

/** Pure per-family glyph geometry in the 24x24 icon box — the single source
 * of truth shared by the canvas draw below and any future SVG rendering
 * (mirrors barbSegments()' role in windBarbs.ts). */
export function seamarkSegments(props: SeamarkProperties): SeamarkSegment[] {
  switch (classifySeamark(props.seamarkType)) {
    case 'lateral':
      return lateralSegments(props);
    case 'cardinal':
      return cardinalSegments(props);
    case 'safeWater':
      return safeWaterSegments(props);
    case 'specialPurpose':
      return specialPurposeSegments(props);
    case 'isolatedDanger':
      return isolatedDangerSegments(props);
    case 'lightMajor':
      return lightSegments(true);
    case 'lightMinor':
      return lightSegments(false);
    default:
      return unknownSegments();
  }
}

/**
 * Deterministic `map.addImage()` id for a seamark, derived from its glyph
 * family plus whatever else the glyph actually varies on (shape for
 * lateral, category for cardinal, the full colour band for the
 * colour-keyed families) — this is what "icon-image keyed off
 * seamarkType/category" resolves to in practice: seamarkType alone can't
 * distinguish a red from a green lateral buoy, which the design's own
 * "canvas-drawn... red/green" glyph fidelity requires.
 */
export function seamarkImageId(props: SeamarkProperties): string {
  const family = classifySeamark(props.seamarkType);
  switch (family) {
    case 'lateral': {
      const shape = bucketShape(props.shape);
      const base = `seamark-lateral-${shape}-${primaryColour(props.colour)}`;
      // Both the `pillar` and `spar` (#307; was pillar-only, #298) buckets
      // draw a topmark derived from `category` — so both ids must carry the
      // category too, or the cache under-keys and one registered image
      // serves both sides of the channel. `can`/`conical`/`spherical` draw
      // no topmark and stay unsuffixed — their glyph does not vary on
      // category. Measured over the committed pull: 16 suffixed ids cover
      // 633 marks (109 pillar-bucket + 524 spar-bucket); the 5 unsuffixed
      // ids cover the remaining 195 (conical-green 94, can-red 81,
      // spherical-red 7, spherical-green 7, can-green 6). Extend the
      // condition if a topmark is ever added to another bucket.
      return shape === 'pillar' || shape === 'spar'
        ? `${base}-${props.category ?? 'unknown'}`
        : base;
    }
    case 'cardinal':
      return `seamark-cardinal-${props.category ?? 'unknown'}`;
    case 'safeWater':
      return `seamark-safewater-${colourTokens(props.colour).join('-') || 'default'}`;
    case 'specialPurpose':
      return `seamark-special-${colourTokens(props.colour).join('-') || 'default'}`;
    case 'isolatedDanger':
      return `seamark-isolated-${colourTokens(props.colour).join('-') || 'default'}`;
    case 'lightMajor':
      return 'seamark-light-major';
    case 'lightMinor':
      return 'seamark-light-minor';
    default:
      return 'seamark-unknown';
  }
}

// #353 PR2: `canvasSize` is now a PARAMETER, not the module-level default —
// `registerSeamarkImages` below re-registers glyphs at the user's chosen
// size scale (issue #353's own recommended "better route": raise the raster
// resolution and redraw, rather than only upscaling a fixed-resolution
// bitmap via icon-size, which would blur past ~1.0). Every caller that wants
// today's default still gets it via `seamarkRasterConfig(SEAMARK_SIZE_SCALE)`.
function drawSeamark(
  ctx: CanvasRenderingContext2D,
  props: SeamarkProperties,
  canvasSize: number,
): void {
  ctx.clearRect(0, 0, canvasSize, canvasSize);
  // Map the logical 24-unit coordinate space onto the higher-resolution
  // raster canvas: every segment coordinate/line-width below is expressed in
  // IMAGE_SIZE (24) units and scales up together (#191), so the R1001 cone
  // geometry and colour bands (#165) survive the resize unmodified.
  ctx.scale(canvasSize / IMAGE_SIZE, canvasSize / IMAGE_SIZE);
  for (const seg of seamarkSegments(props)) {
    ctx.beginPath();
    switch (seg.kind) {
      case 'rect':
        ctx.fillStyle = seg.fill;
        ctx.rect(seg.x, seg.y, seg.w, seg.h);
        ctx.fill();
        break;
      case 'circle':
        ctx.fillStyle = seg.fill;
        ctx.arc(seg.cx, seg.cy, seg.r, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'ring':
        ctx.strokeStyle = seg.stroke;
        ctx.lineWidth = seg.width;
        ctx.arc(seg.cx, seg.cy, seg.r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'polygon':
        ctx.fillStyle = seg.fill;
        seg.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
        break;
      case 'line':
        ctx.strokeStyle = seg.stroke;
        ctx.lineWidth = seg.width;
        seg.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
        break;
    }
  }
}

/**
 * Registers one canvas-drawn image per distinct `seamarkImageId()` actually
 * present in `allProperties`, so the `sc-seamarks` symbol layer can
 * reference `icon-image: ['get', 'icon']`. Safe to call more than once at
 * the SAME scale — already-registered images are skipped, same convention
 * as registerBarbImages().
 *
 * #353 PR2: `scale` drives `seamarkRasterConfig` fresh on every call rather
 * than reading the fixed module default, so a live size-slider change can
 * re-register glyphs at a NEW raster resolution — the issue's own
 * recommended route over merely upscaling `icon-size`, which would blur a
 * fixed-resolution bitmap past ~1.0. The `hasImage` skip is scale-BLIND: it
 * only knows an id is registered, not at what size — so re-registering at a
 * different scale is the CALLER's responsibility (`DataLayers.tsx` removes
 * every previously-registered id before calling this again with a changed
 * scale; see its own comment). At an UNCHANGED scale this is exactly the
 * pre-#353 idempotent-on-repeat behaviour.
 */
export function registerSeamarkImages(
  map: MaplibreMap,
  allProperties: readonly SeamarkProperties[],
  scale: number = SEAMARK_SIZE_SCALE,
): void {
  const { canvasSize, pixelRatio } = seamarkRasterConfig(scale);
  // De-dupe by id, keeping the FIRST properties seen for each — a Map
  // preserves insertion order, so registration order is unchanged from the
  // pre-#353 Set-based version (pinned by seamarkGlyphs.test.ts's ordered
  // addImage.mock.calls assertions).
  const byId = new Map<string, SeamarkProperties>();
  for (const props of allProperties) {
    const id = seamarkImageId(props);
    if (!byId.has(id)) byId.set(id, props);
  }
  for (const [id, props] of byId) {
    if (map.hasImage(id)) continue;
    const canvas = document.createElement('canvas');
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue; // no 2d context available (e.g. headless test env) — nothing to register
    drawSeamark(ctx, props, canvasSize);
    map.addImage(id, ctx.getImageData(0, 0, canvasSize, canvasSize), { pixelRatio });
  }
}

/** Deduped `seamarkImageId()` outputs actually present in `allProperties`
 * (#353 PR2) — shared by `registerSeamarkImages` above and by
 * `DataLayers.tsx`, which needs the same id set to `removeImage` a stale
 * raster before re-registering at a NEW size scale (registerSeamarkImages'
 * `hasImage` skip is scale-blind, so the caller owns that invalidation). */
export function seamarkImageIds(allProperties: readonly SeamarkProperties[]): string[] {
  return [...new Set(allProperties.map((props) => seamarkImageId(props)))];
}
