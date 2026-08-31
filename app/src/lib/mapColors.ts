// Shared Okabe-Ito-derived colour constants for map/route/AIS/boat chrome
// (#715). Single source of truth for a family that was independently
// hardcoded across app.css, RouteLayer.tsx, RouteSummary.tsx, AisLayer.tsx,
// ViaMarkers.tsx, BoatMarker.tsx, DepthProfile.tsx and windBarbs.ts —
// applying the lib/depthColor.ts pattern (a plain constants module, no
// React/DOM dependency) to this second, previously-uncentralised family.
//
// NOT a locked-palette violation: app.css's own header comment states these
// semantic map colours are Okabe-Ito and deliberately DECOUPLED from the UI
// accent tokens (--sc-accent et al.) — this module centralises the VALUES;
// it does not fold them into the --sc-* token system, and introduces zero
// new colours.
//
// app.css cannot IMPORT this module — no compiler spans CSS and
// TypeScript — so its own sites read these same values through --sc-*
// custom properties instead: --sc-starboard, --sc-port, --sc-via,
// --sc-motor, --sc-ink, --sc-halo (#715), the same shape as the
// pre-existing --sc-depth-warning-fg (#251). mapColors.test.ts is the
// twin that keeps each token's value honest against these constants (the
// maskTolerance.test.ts / useBannerHeight.test.ts readFileSync pattern).
//
// An earlier revision of this comment said app.css keeps RAW hex literals
// because "a MapLibre paint expression and a Canvas 2D strokeStyle
// structurally cannot consume var()" — that was wrong for app.css: every
// true MapLibre-paint / Canvas-2D-strokeStyle site this module exists for
// (RouteLayer.tsx, AisLayer.tsx, DataLayers.tsx, windBarbs.ts,
// BoatMarker.tsx, ViaMarkers.tsx) is TypeScript, not CSS, and those files
// import this module directly — var() was never a candidate mechanism
// for them, and app.css's own DOM CSS sites (legend swatches, AIS status
// text) have no such barrier (corrected after PR #798 review).
//
// Case is UPPERCASE throughout, matching how this repo already cites
// Okabe-Ito hex codes elsewhere (CLAUDE.md, existing code comments). Hex
// letter case has no rendering effect, so app.css's lowercase spellings of
// the same values are not a divergence — mapColors.test.ts's twin compares
// case-insensitively.

/** Starboard-tack sail line; also the AIS vessel-marker fill. Okabe-Ito green. */
export const STARBOARD_COLOR = '#009E73';

/** Port-tack sail line. Okabe-Ito vermillion. */
export const PORT_COLOR = '#D55E00';

/** User via-waypoint markers. Okabe-Ito reddish-purple. */
export const VIA_COLOR = '#CC79A7';

/**
 * Own-ship boat marker (BoatMarker.tsx). Okabe-Ito blue — deliberately
 * distinct from STARBOARD_COLOR/the AIS vessel colour (see AisLayer.tsx's
 * own comment on that choice).
 */
export const BOAT_COLOR = '#0072B2';

/**
 * Motor legs — the route line, the legend swatch, wind/depth-profile motor
 * segments. Neutral grey, deliberately NOT part of the Okabe-Ito set
 * (app.css's header comment: "the rest of the map layer is neutral").
 */
export const MOTOR_COLOR = '#5B5B5B';

/**
 * Map-chrome ink: maneuver-circle strokes/fills, route and AIS label text,
 * wind-barb glyph strokes. Neutral black, not Okabe-Ito.
 */
export const INK_COLOR = '#1A1A1A';

/** White halo/stroke behind INK_COLOR text and markers. Neutral. */
export const HALO_COLOR = '#FFFFFF';

/**
 * Active-leg highlight halo on the route (RouteLayer's HIGHLIGHT_LAYER) —
 * app.css's header comment calls this the "position halo". Neutral
 * amber-yellow, not part of the Okabe-Ito set.
 */
export const POSITION_HALO_COLOR = '#FFD400';

/**
 * Safety-depth warning family (#251/#53): the shallow-leg casing, the depth
 * profile's safety line/fill, and app.css's own --sc-depth-warning-fg custom
 * property — mapColors.test.ts twins this constant against that property's
 * literal value, since app.css cannot import from this module. Okabe-Ito
 * orange.
 */
export const DEPTH_WARNING_COLOR = '#E69F00';
