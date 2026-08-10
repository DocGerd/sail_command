import type { Settings } from '../types';
import { useT } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import NumberInput from './NumberInput';
import Field from './Field';
import { isValidMmsi } from '../lib/mmsi';

export interface OptionsPanelProps {
  value: Settings;
  onChange: (settings: Settings) => void;
}

export type NumericKey =
  | 'safetyDepthM'
  | 'depthComfortMarginM'
  | 'motorSpeedKn'
  | 'motorThresholdKn'
  | 'sailPreferenceKn'
  | 'maneuverPenaltyS'
  | 'performanceFactor';

export interface FieldSpec {
  key: NumericKey;
  labelKey: MsgKey;
  min: number;
  max: number;
  step: number;
}

// Safety depth is pulled OUT of the advanced group (#64 §3.3): it is one of the
// two most-changed inputs, so it stays visible in PlannerPanel's compact row.
// The spec (bounds included) lives here so both surfaces share one source.
// 2.2 m is a safety decision, not a UI nicety: it must never allow a value
// below the 2.1 m draft plus a minimum safety margin.
// eslint-disable-next-line react-refresh/only-export-components
export const SAFETY_DEPTH_FIELD: FieldSpec = {
  key: 'safetyDepthM',
  labelKey: 'options.safetyDepth.label',
  min: 2.2,
  max: 10,
  step: 0.1,
};

// #243: depth comfort preference margin, rendered first inside the advanced
// group (with its own help paragraph, unlike the four plain ADVANCED_FIELDS
// below) — kept separate from SAFETY_DEPTH_FIELD's compact-row treatment
// because the spec lists it alongside the other advanced settings, not as a
// second most-changed input. 0 = feature off (byte-identical solve).
// eslint-disable-next-line react-refresh/only-export-components
export const DEPTH_COMFORT_MARGIN_FIELD: FieldSpec = {
  key: 'depthComfortMarginM',
  labelKey: 'options.depthComfortMargin.label',
  min: 0,
  max: 5,
  step: 0.1,
};

// #254: sailing preference margin. Rendered with its own help paragraph like
// DEPTH_COMFORT_MARGIN_FIELD above, because the behaviour it controls is not
// guessable from the label. max 10 so the disabling value stays reachable at
// any motorSpeedKn (which itself maxes at 10).
// eslint-disable-next-line react-refresh/only-export-components
export const SAIL_PREFERENCE_FIELD: FieldSpec = {
  key: 'sailPreferenceKn',
  labelKey: 'options.sailPreference.label',
  min: 0,
  max: 10,
  step: 0.1,
};

// The four plain advanced numeric inputs that used to live behind the
// (now-removed, #299) "Erweitert" disclosure (DEPTH_COMFORT_MARGIN_FIELD and
// SAIL_PREFERENCE_FIELD above render separately, each with its own help
// paragraph, ahead of these). #299 exports each individually — rather than
// only the bundled array below — because SettingsPanel.tsx (the Boat tab)
// splits them across TWO different section groups (Boat & safety vs.
// Propulsion), so a single combined array can no longer be `.map()`-ed over
// in one place the way this file's own (legacy, see the default export's own
// comment) rendering still does.
// eslint-disable-next-line react-refresh/only-export-components
export const MOTOR_SPEED_FIELD: FieldSpec = {
  key: 'motorSpeedKn',
  labelKey: 'options.motorSpeed.label',
  min: 1,
  max: 10,
  step: 0.1,
};
// eslint-disable-next-line react-refresh/only-export-components
export const MOTOR_THRESHOLD_FIELD: FieldSpec = {
  key: 'motorThresholdKn',
  labelKey: 'options.motorThreshold.label',
  min: 0,
  max: 5,
  step: 0.1,
};
// eslint-disable-next-line react-refresh/only-export-components
export const MANEUVER_PENALTY_FIELD: FieldSpec = {
  key: 'maneuverPenaltyS',
  labelKey: 'options.maneuverPenalty.label',
  min: 0,
  max: 300,
  step: 1,
};
// eslint-disable-next-line react-refresh/only-export-components
export const PERFORMANCE_FACTOR_FIELD: FieldSpec = {
  key: 'performanceFactor',
  labelKey: 'options.performanceFactor.label',
  min: 0.5,
  max: 1.1,
  step: 0.05,
};

// Recomposed from the four named exports above — same objects, same order,
// so this file's own default-export rendering below (kept byte-behavior-
// identical for its pre-existing test suite, see that component's own
// comment) is unaffected by the split.
const ADVANCED_FIELDS: FieldSpec[] = [
  MOTOR_SPEED_FIELD,
  MOTOR_THRESHOLD_FIELD,
  MANEUVER_PENALTY_FIELD,
  PERFORMANCE_FACTOR_FIELD,
];

/** Commit a single numeric setting, skipping a redundant update on an unchanged blur. */
// eslint-disable-next-line react-refresh/only-export-components
export function commitSetting(
  value: Settings,
  key: NumericKey,
  n: number,
  onChange: (s: Settings) => void,
): void {
  if (n === value[key]) return;
  onChange({ ...value, [key]: n });
}

// #299: this component is no longer RENDERED anywhere in the live app —
// PlannerPanel's "Erweitert" Disclosure that used to host it was replaced by
// the dedicated Boat tab (SettingsPanel.tsx), which groups these same fields
// (imported from this file: SAFETY_DEPTH_FIELD stays in PlannerPanel's
// compact row; DEPTH_COMFORT_MARGIN_FIELD/SAIL_PREFERENCE_FIELD/the four
// MOTOR_*/MANEUVER_*/PERFORMANCE_* specs above/commitSetting are the shared
// source of truth both surfaces read) under section headings instead of one
// flat list. This function's OWN body is deliberately left byte-behavior-
// identical to its pre-#299 shape — OptionsPanel.test.tsx exercises it
// directly and is out of #299's file scope — rather than being deleted or
// rewritten to call SettingsPanel; a follow-up PR can remove both this
// component and its test file once #299 has landed and nothing depends on
// the old shape anymore.
export default function OptionsPanel({ value, onChange }: OptionsPanelProps) {
  const t = useT();

  const mmsi = value.ownMmsi ?? '';
  const mmsiInvalid = mmsi !== '' && !isValidMmsi(mmsi);

  return (
    <div className="options-panel">
      {/* #243: rendered separately from ADVANCED_FIELDS so it can carry a
          help paragraph (aria-describedby, visible text, never a title
          tooltip — gloved touch) explaining what the margin does. */}
      <div className="options-field">
        <label htmlFor={`options-${DEPTH_COMFORT_MARGIN_FIELD.key}`}>
          {t(DEPTH_COMFORT_MARGIN_FIELD.labelKey)}
        </label>
        <NumberInput
          id={`options-${DEPTH_COMFORT_MARGIN_FIELD.key}`}
          value={value[DEPTH_COMFORT_MARGIN_FIELD.key]}
          min={DEPTH_COMFORT_MARGIN_FIELD.min}
          max={DEPTH_COMFORT_MARGIN_FIELD.max}
          step={DEPTH_COMFORT_MARGIN_FIELD.step}
          aria-describedby="options-depthComfortMarginM-help"
          onCommit={(n) => commitSetting(value, DEPTH_COMFORT_MARGIN_FIELD.key, n, onChange)}
        />
      </div>
      <p className="options-help" id="options-depthComfortMarginM-help">
        {t('options.depthComfortMargin.help')}
      </p>
      <div className="options-field">
        <label htmlFor={`options-${SAIL_PREFERENCE_FIELD.key}`}>
          {t(SAIL_PREFERENCE_FIELD.labelKey)}
        </label>
        <NumberInput
          id={`options-${SAIL_PREFERENCE_FIELD.key}`}
          value={value[SAIL_PREFERENCE_FIELD.key]}
          min={SAIL_PREFERENCE_FIELD.min}
          max={SAIL_PREFERENCE_FIELD.max}
          step={SAIL_PREFERENCE_FIELD.step}
          aria-describedby="options-sailPreferenceKn-help"
          onCommit={(n) => commitSetting(value, SAIL_PREFERENCE_FIELD.key, n, onChange)}
        />
      </div>
      <p className="options-help" id="options-sailPreferenceKn-help">
        {t('options.sailPreference.help')}
      </p>
      {ADVANCED_FIELDS.map((f) => (
        <div key={f.key} className="options-field">
          <label htmlFor={`options-${f.key}`}>{t(f.labelKey)}</label>
          <NumberInput
            id={`options-${f.key}`}
            value={value[f.key]}
            min={f.min}
            max={f.max}
            step={f.step}
            onCommit={(n) => commitSetting(value, f.key, n, onChange)}
          />
        </div>
      ))}
      <div className="options-field">
        <label htmlFor="options-motorEnabled">{t('options.motorEnabled.label')}</label>
        <input
          id="options-motorEnabled"
          type="checkbox"
          checked={value.motorEnabled}
          aria-describedby="options-motorEnabled-help"
          onChange={(e) => onChange({ ...value, motorEnabled: e.target.checked })}
        />
      </div>
      {/* Sibling of the checkbox field, not a child of it: the wide-layout rule
          turns the checkbox `.options-field` into a flex row, which would strand
          a third child inline. aria-describedby links by id regardless of nesting.
          A visible paragraph, never a `title` tooltip — tooltips don't exist for
          gloved touch. */}
      <p className="options-help" id="options-motorEnabled-help">
        {t('options.motorEnabled.help')}
      </p>
      {/* #25 addendum: standalone "show my position" ownship marker — default
          OFF/opt-in (types.ts DEFAULT_SETTINGS). Unrelated to routing (not
          part of PlanRequest), so it lives here as a plain settings toggle
          rather than in PlannerPanel's advanced-summary recap, which only
          recaps solver-relevant fields. */}
      <div className="options-field">
        <label htmlFor="options-showOwnship">{t('options.showOwnship.label')}</label>
        <input
          id="options-showOwnship"
          type="checkbox"
          checked={value.showOwnship}
          aria-describedby="options-showOwnship-help"
          onChange={(e) => onChange({ ...value, showOwnship: e.target.checked })}
        />
      </div>
      <p className="options-help" id="options-showOwnship-help">
        {t('options.showOwnship.help')}
      </p>
      {/* #25 AIS live traffic overlay (Live tab only): BYOK aisstream.io key +
          own-vessel MMSI. Text fields (not NumberInput — the key is
          alphanumeric and the MMSI is a string that preserves leading zeros).
          Both commit on change like the checkboxes above. */}
      <Field
        label={t('options.ais.apiKey.label')}
        htmlFor="options-aisApiKey"
        help={t('options.ais.help')}
        helpId="options-ais-help"
      >
        <input
          id="options-aisApiKey"
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="options-ais-help"
          value={value.aisApiKey ?? ''}
          onChange={(e) => onChange({ ...value, aisApiKey: e.target.value })}
        />
      </Field>
      <Field label={t('options.ais.mmsi.label')} htmlFor="options-ownMmsi">
        <input
          id="options-ownMmsi"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={mmsiInvalid}
          aria-describedby={mmsiInvalid ? 'options-ownMmsi-error' : undefined}
          value={mmsi}
          onChange={(e) => onChange({ ...value, ownMmsi: e.target.value })}
        />
      </Field>
      {mmsiInvalid && (
        <p className="options-help" id="options-ownMmsi-error" role="alert">
          {t('options.ais.mmsi.invalid')}
        </p>
      )}
    </div>
  );
}
