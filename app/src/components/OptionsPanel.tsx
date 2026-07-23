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
  'safetyDepthM' | 'motorSpeedKn' | 'motorThresholdKn' | 'maneuverPenaltyS' | 'performanceFactor';

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

// The five advanced numeric inputs that live behind the "Erweitert" disclosure.
const ADVANCED_FIELDS: FieldSpec[] = [
  { key: 'motorSpeedKn', labelKey: 'options.motorSpeed.label', min: 1, max: 10, step: 0.1 },
  { key: 'motorThresholdKn', labelKey: 'options.motorThreshold.label', min: 0, max: 5, step: 0.1 },
  { key: 'maneuverPenaltyS', labelKey: 'options.maneuverPenalty.label', min: 0, max: 300, step: 1 },
  {
    key: 'performanceFactor',
    labelKey: 'options.performanceFactor.label',
    min: 0.5,
    max: 1.1,
    step: 0.05,
  },
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

export default function OptionsPanel({ value, onChange }: OptionsPanelProps) {
  const t = useT();

  const mmsi = value.ownMmsi ?? '';
  const mmsiInvalid = mmsi !== '' && !isValidMmsi(mmsi);

  return (
    <div className="options-panel">
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
