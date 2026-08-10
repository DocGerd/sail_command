import type { Ref } from 'react';
import type { Settings } from '../types';
import { useT } from '../i18n';
import { isValidMmsi } from '../lib/mmsi';
import Card from './Card';
import Field from './Field';
import NumberInput from './NumberInput';
import {
  DEPTH_COMFORT_MARGIN_FIELD,
  MANEUVER_PENALTY_FIELD,
  MOTOR_SPEED_FIELD,
  MOTOR_THRESHOLD_FIELD,
  PERFORMANCE_FACTOR_FIELD,
  SAIL_PREFERENCE_FIELD,
  commitSetting,
  type FieldSpec,
} from './OptionsPanel';

// #299: the Boat tab's content — a SELF-CONTAINED settings surface with its
// own explicit props (value/onChange only, no App.tsx/PlannerPanel wiring
// baked in) so the host that renders it is swappable later without touching
// this file. This is now the ONLY place these fields are actually rendered
// in the live app; OptionsPanel.tsx's own default export (still exercised by
// its own pre-existing test suite) is kept byte-behavior-identical but is
// dead code in the running app — see that file's own comment. The field
// SPECS (bounds, i18n label keys) and the commit helper are shared from
// there (one source of truth for validation), but the actual JSX here is
// independent, not a re-render of OptionsPanel's tree — deliberately, so
// touching that legacy, test-pinned component can never change what ships
// on the Boat tab.
//
// SAFETY DEPTH ITSELF DOES NOT APPEAR HERE — it stays inline in
// PlannerPanel's compact row (§3.3, one of the two most-changed inputs,
// SAFETY_DEPTH_FIELD in OptionsPanel.tsx is its single source of truth,
// shared unchanged). This panel only carries the fields §3.3 originally
// hid behind "Erweitert" plus the pre-existing AIS/ownship toggles.
export interface SettingsPanelProps {
  value: Settings;
  onChange: (settings: Settings) => void;
  // #299 fix (PR #486 review): focus target for the safety-depth field's
  // "boat settings" link (App.tsx forwards it onto this panel's first Card
  // heading, tabIndex -1, focused on jump) — mirrors RouteSummary's own
  // `resultHeadingRef`/"Details ansehen" precedent (Card.tsx's docstring
  // names it). Optional so a host that never needs to move focus here
  // (there is none today, but the whole point of this panel's own props
  // surface is that a future one shouldn't need to change this file) can
  // simply omit it.
  titleRef?: Ref<HTMLHeadingElement>;
}

interface NumericFieldProps {
  spec: FieldSpec;
  value: Settings;
  onChange: (s: Settings) => void;
  help?: string;
}

/** One FieldSpec rendered through the Field/NumberInput primitives — the
 * Boat tab's per-field building block, analogous to OptionsPanel's own
 * hand-rolled `.options-field` pattern but built on the primitive layer
 * (#64) per this tab's own design brief. */
function NumericField({ spec, value, onChange, help }: NumericFieldProps) {
  const t = useT();
  const id = `settings-${spec.key}`;
  const helpId = `${id}-help`;
  // `exactOptionalPropertyTypes` (tsconfig) means `Field`'s/`NumberInput`'s
  // `help?`/`aria-describedby?` props must be OMITTED, not explicitly set to
  // `undefined`, when there's no help text — mirrors OptionsPanel.tsx's own
  // ADVANCED_FIELDS loop, which likewise never passes `aria-describedby` at
  // all for its help-less fields rather than passing it as `undefined`.
  const fieldExtra = help !== undefined ? { help, helpId } : {};
  const inputExtra = help !== undefined ? { 'aria-describedby': helpId } : {};
  return (
    <Field label={t(spec.labelKey)} htmlFor={id} {...fieldExtra}>
      <NumberInput
        id={id}
        value={value[spec.key]}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        {...inputExtra}
        onCommit={(n) => commitSetting(value, spec.key, n, onChange)}
      />
    </Field>
  );
}

export default function SettingsPanel({ value, onChange, titleRef }: SettingsPanelProps) {
  const t = useT();
  const mmsi = value.ownMmsi ?? '';
  const mmsiInvalid = mmsi !== '' && !isValidMmsi(mmsi);

  return (
    <div className="settings-panel">
      {/* #299 grouping: static boat characteristics + the depth SAFETY
          preference (safetyDepthM itself stays inline in PlannerPanel; this
          is only its comfort margin) — the two boat-handling numbers
          (maneuver penalty, performance factor) belong here rather than
          under Propulsion because they describe THIS boat/crew, not the
          sail-vs-motor decision. */}
      <Card title={t('settings.section.boatSafety')} titleRef={titleRef} titleTabIndex={-1}>
        <NumericField
          spec={DEPTH_COMFORT_MARGIN_FIELD}
          value={value}
          onChange={onChange}
          help={t('options.depthComfortMargin.help')}
        />
        <NumericField spec={MANEUVER_PENALTY_FIELD} value={value} onChange={onChange} />
        <NumericField spec={PERFORMANCE_FACTOR_FIELD} value={value} onChange={onChange} />
      </Card>

      {/* #299 grouping: everything that shapes the sail-vs-motor decision. */}
      <Card title={t('settings.section.propulsion')}>
        <div className="options-field">
          <label htmlFor="settings-motorEnabled">{t('options.motorEnabled.label')}</label>
          <input
            id="settings-motorEnabled"
            type="checkbox"
            checked={value.motorEnabled}
            aria-describedby="settings-motorEnabled-help"
            onChange={(e) => onChange({ ...value, motorEnabled: e.target.checked })}
          />
        </div>
        <p className="options-help" id="settings-motorEnabled-help">
          {t('options.motorEnabled.help')}
        </p>
        <NumericField spec={MOTOR_SPEED_FIELD} value={value} onChange={onChange} />
        <NumericField spec={MOTOR_THRESHOLD_FIELD} value={value} onChange={onChange} />
        <NumericField
          spec={SAIL_PREFERENCE_FIELD}
          value={value}
          onChange={onChange}
          help={t('options.sailPreference.help')}
        />
      </Card>

      {/* #299 grouping: live tracking + AIS, unrelated to routing (#25
          addendum) — unchanged from OptionsPanel.tsx's own grouping. */}
      <Card title={t('settings.section.liveAis')}>
        <div className="options-field">
          <label htmlFor="settings-showOwnship">{t('options.showOwnship.label')}</label>
          <input
            id="settings-showOwnship"
            type="checkbox"
            checked={value.showOwnship}
            aria-describedby="settings-showOwnship-help"
            onChange={(e) => onChange({ ...value, showOwnship: e.target.checked })}
          />
        </div>
        <p className="options-help" id="settings-showOwnship-help">
          {t('options.showOwnship.help')}
        </p>
        <Field
          label={t('options.ais.apiKey.label')}
          htmlFor="settings-aisApiKey"
          help={t('options.ais.help')}
          helpId="settings-ais-help"
        >
          <input
            id="settings-aisApiKey"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="settings-ais-help"
            value={value.aisApiKey ?? ''}
            onChange={(e) => onChange({ ...value, aisApiKey: e.target.value })}
          />
        </Field>
        <Field label={t('options.ais.mmsi.label')} htmlFor="settings-ownMmsi">
          <input
            id="settings-ownMmsi"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            aria-invalid={mmsiInvalid}
            aria-describedby={mmsiInvalid ? 'settings-ownMmsi-error' : undefined}
            value={mmsi}
            onChange={(e) => onChange({ ...value, ownMmsi: e.target.value })}
          />
        </Field>
        {mmsiInvalid && (
          <p className="options-help" id="settings-ownMmsi-error" role="alert">
            {t('options.ais.mmsi.invalid')}
          </p>
        )}
      </Card>
    </div>
  );
}
