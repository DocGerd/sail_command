import type { MsgKey } from '../i18n/dict.de';
import type { SeamarkProperties } from '../types';

// Pure row-building logic for the seamark info popover (#7) — DataLayers.tsx
// translates the labelKeys via t() and builds the actual DOM (a MapLibre
// Popup's setDOMContent), so this stays unit-testable without a map/DOM.

export interface SeamarkPopoverRow {
  labelKey: MsgKey;
  value: string;
}

// Humanizes a raw OSM tag value ("buoy_lateral", "yellow;black;yellow") into
// readable text by replacing separators with spaces. Deliberately NOT run
// through the i18n dict: unlike the field LABELS below (a fixed, small UI
// vocabulary), seamark:type/category/colour values are open-ended data
// straight from OSM — the category tag alone has dozens of possible values
// across the full IALA tagging scheme (and real-world data carries
// semicolon-joined compounds, e.g. "no_entry;foul_ground") — a translation
// table can't be closed over that. Field labels stay fully de/en localized.
function humanize(raw: string): string {
  return raw
    .split(/[_;:]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
}

/** Builds the ordered (label key, humanized value) rows for a seamark's info
 * popover: type + category + colour when present, then light
 * character/colour/period when tagged (#7 spec). */
export function seamarkPopoverRows(props: SeamarkProperties): SeamarkPopoverRow[] {
  const rows: SeamarkPopoverRow[] = [
    { labelKey: 'seamark.popover.type', value: humanize(props.seamarkType) },
  ];
  if (props.category) {
    rows.push({ labelKey: 'seamark.popover.category', value: humanize(props.category) });
  }
  if (props.colour) {
    rows.push({ labelKey: 'seamark.popover.colour', value: humanize(props.colour) });
  }
  if (props.lightCharacter) {
    rows.push({ labelKey: 'seamark.popover.lightCharacter', value: props.lightCharacter });
  }
  if (props.lightColour) {
    rows.push({ labelKey: 'seamark.popover.lightColour', value: humanize(props.lightColour) });
  }
  if (props.lightPeriod) {
    rows.push({ labelKey: 'seamark.popover.lightPeriod', value: `${props.lightPeriod} s` });
  }
  return rows;
}
