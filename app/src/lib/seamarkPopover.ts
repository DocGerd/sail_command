import type { MsgKey } from '../i18n/dict.de';
import type { SeamarkProperties } from '../types';

// Pure row-building logic for the seamark info popover (#7) — DataLayers.tsx
// resolves labelKey and calls resolveSeamarkPopoverValue() (t-injected, see
// below) to build the actual DOM (a MapLibre Popup's setDOMContent), so this
// stays unit-testable without a map/DOM.

/** One rendered value fragment: either a dict key (DataLayers resolves it via
 * t(key, vars)) or verbatim text that must never be translated. A row's value
 * is an ordered list of these, joined with a space by the caller. */
export type SeamarkPopoverToken =
  { key: MsgKey; vars?: Record<string, string | number> } | { text: string };

export interface SeamarkPopoverRow {
  labelKey: MsgKey;
  value: SeamarkPopoverToken[];
}

/** Structural type for the app's `t()` (see `i18n/index.tsx`'s `useT`) —
 * typed here, never imported at runtime, to keep this module DOM/React-free. */
export type SeamarkPopoverTranslate = (
  key: MsgKey,
  vars?: Record<string, string | number>,
) => string;

/** Turns a row's value tokens into the exact string the popover renders
 * (#300 F4): the only place that decides how tokens join. Exported and
 * `t`-injected so DataLayers.tsx's DOM code stays a thin caller and this
 * join logic is directly unit-testable with a stub `t`, without a
 * map/Popup. Category rows join with ", " — the terms are independent
 * concepts and read as a run-on otherwise (#300 F7); colour rows (a colour
 * SEQUENCE, e.g. "black yellow black") and every other row keep the plain
 * space humanize() always used. */
export function resolveSeamarkPopoverValue(
  row: SeamarkPopoverRow,
  t: SeamarkPopoverTranslate,
): string {
  const separator = row.labelKey === 'seamark.popover.category' ? ', ' : ' ';
  return row.value
    .map((token) => ('text' in token ? token.text : t(token.key, token.vars)))
    .join(separator);
}

// Fallback for any raw OSM tag value with no entry in the translation maps
// below (#300): replaces separators with spaces so an unrecognised tag stays
// readable rather than rendering a missing-key placeholder or the raw
// underscored/semicolon-joined string. This is intentionally the SAME
// behaviour the whole popover used before #300 — it now only fires for the
// tail the maps below don't cover, e.g. a future pipeline re-run (#295)
// introducing a value seamarks.json doesn't have today.
function humanize(raw: string): string {
  return raw
    .split(/[_;:]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
}

// Hand-curated from the values actually present in the committed
// `app/public/data/seamarks.json` (#300 measured 11 seamarkType / 29 category
// / 7 base colour values — see the issue for the full count). Deliberately
// NOT closed over the full IALA tagging scheme: `tokenFor` below falls back
// to humanize() for anything missing here, which is what makes adding a
// finite table safe despite the open-ended tag space.
// `seamarkPopover.coverage.test.ts` pins that every value in the shipped
// dataset resolves to a key (never a fallback) — it fails loudly if a
// pipeline re-run introduces an untranslated value.
const SEAMARK_TYPE_KEYS: Record<string, MsgKey> = {
  beacon_cardinal: 'seamark.value.type.beacon_cardinal',
  beacon_isolated_danger: 'seamark.value.type.beacon_isolated_danger',
  beacon_lateral: 'seamark.value.type.beacon_lateral',
  beacon_special_purpose: 'seamark.value.type.beacon_special_purpose',
  buoy_cardinal: 'seamark.value.type.buoy_cardinal',
  buoy_isolated_danger: 'seamark.value.type.buoy_isolated_danger',
  buoy_lateral: 'seamark.value.type.buoy_lateral',
  buoy_safe_water: 'seamark.value.type.buoy_safe_water',
  buoy_special_purpose: 'seamark.value.type.buoy_special_purpose',
  light_major: 'seamark.value.type.light_major',
  light_minor: 'seamark.value.type.light_minor',
};

const SEAMARK_CATEGORY_KEYS: Record<string, MsgKey> = {
  anchorage: 'seamark.value.category.anchorage',
  cable: 'seamark.value.category.cable',
  clearing: 'seamark.value.category.clearing',
  degaussing_range: 'seamark.value.category.degaussing_range',
  east: 'seamark.value.category.east',
  firing_danger_area: 'seamark.value.category.firing_danger_area',
  foul_ground: 'seamark.value.category.foul_ground',
  lanby: 'seamark.value.category.lanby',
  leading: 'seamark.value.category.leading',
  marine_farm: 'seamark.value.category.marine_farm',
  mooring: 'seamark.value.category.mooring',
  no_entry: 'seamark.value.category.no_entry',
  north: 'seamark.value.category.north',
  notice: 'seamark.value.category.notice',
  odas: 'seamark.value.category.odas',
  pipeline: 'seamark.value.category.pipeline',
  port: 'seamark.value.category.port',
  preferred_channel_port: 'seamark.value.category.preferred_channel_port',
  preferred_channel_starboard: 'seamark.value.category.preferred_channel_starboard',
  recording: 'seamark.value.category.recording',
  recreation_zone: 'seamark.value.category.recreation_zone',
  recreational: 'seamark.value.category.recreational',
  south: 'seamark.value.category.south',
  starboard: 'seamark.value.category.starboard',
  target: 'seamark.value.category.target',
  unknown_purpose: 'seamark.value.category.unknown_purpose',
  warning: 'seamark.value.category.warning',
  wave_recorder: 'seamark.value.category.wave_recorder',
  west: 'seamark.value.category.west',
  yachting: 'seamark.value.category.yachting',
};

// Shared by `colour` (compound, e.g. "black;yellow;black" or
// "black:yellow:black" — OSM data uses both separators) and `lightColour`:
// both tag the same base IALA colour vocabulary.
const SEAMARK_COLOUR_KEYS: Record<string, MsgKey> = {
  black: 'seamark.value.colour.black',
  green: 'seamark.value.colour.green',
  grey: 'seamark.value.colour.grey',
  orange: 'seamark.value.colour.orange',
  red: 'seamark.value.colour.red',
  white: 'seamark.value.colour.white',
  yellow: 'seamark.value.colour.yellow',
};

function tokenFor(raw: string, map: Record<string, MsgKey>): SeamarkPopoverToken {
  const key = map[raw];
  return key ? { key } : { text: humanize(raw) };
}

// Splits a compound tag value ("black;yellow;black", "no_entry;foul_ground")
// on its separator and translates each component independently — an unknown
// component falls back to humanize() for JUST that component, so one
// unrecognised term in a compound doesn't blank out the rest.
function compoundTokens(raw: string, map: Record<string, MsgKey>): SeamarkPopoverToken[] {
  return raw
    .split(/[;:]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => tokenFor(part, map));
}

/** Builds the ordered (label key, value tokens) rows for a seamark's info
 * popover: type + category + colour when present, then light
 * character/colour/period when tagged (#7 spec). */
export function seamarkPopoverRows(props: SeamarkProperties): SeamarkPopoverRow[] {
  const rows: SeamarkPopoverRow[] = [
    { labelKey: 'seamark.popover.type', value: [tokenFor(props.seamarkType, SEAMARK_TYPE_KEYS)] },
  ];
  if (props.category) {
    rows.push({
      labelKey: 'seamark.popover.category',
      value: compoundTokens(props.category, SEAMARK_CATEGORY_KEYS),
    });
  }
  if (props.colour) {
    rows.push({
      labelKey: 'seamark.popover.colour',
      value: compoundTokens(props.colour, SEAMARK_COLOUR_KEYS),
    });
  }
  if (props.lightCharacter) {
    // Verbatim, NEVER translated (#300): Fl/Oc/Iso/Q/VQ/LFl/Q+LFl/F are
    // international chart abbreviations, not prose — a translated light
    // character would be actively wrong on a chart-adjacent readout.
    rows.push({
      labelKey: 'seamark.popover.lightCharacter',
      value: [{ text: props.lightCharacter }],
    });
  }
  if (props.lightColour) {
    rows.push({
      labelKey: 'seamark.popover.lightColour',
      value: compoundTokens(props.lightColour, SEAMARK_COLOUR_KEYS),
    });
  }
  if (props.lightPeriod) {
    rows.push({
      labelKey: 'seamark.popover.lightPeriod',
      value: [{ key: 'seamark.popover.lightPeriodUnit', vars: { value: props.lightPeriod } }],
    });
  }
  return rows;
}
