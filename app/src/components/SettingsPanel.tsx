import type { Ref } from 'react';
import type { Settings } from '../types';
import { useT } from '../i18n';
import { isValidMmsi } from '../lib/mmsi';
import {
  SEAMARK_DISPLAY_TIER_ALL,
  SEAMARK_DISPLAY_TIER_BASE,
  SEAMARK_DISPLAY_TIER_STANDARD,
  SEAMARK_SIZE_MAX,
  SEAMARK_SIZE_MIN,
  SEAMARK_SIZE_SCALE,
  toSeamarkDisplayTier,
} from '../lib/seamarkGlyphs';
import { usePersistedNumber } from '../lib/usePersistedNumber';
import Card from './Card';
import Field from './Field';
import NumberInput from './NumberInput';
import Slider from './Slider';
import {
  DEPTH_COMFORT_MARGIN_FIELD,
  MANEUVER_PENALTY_FIELD,
  MOTOR_SPEED_FIELD,
  MOTOR_THRESHOLD_FIELD,
  PERFORMANCE_FACTOR_FIELD,
  SAIL_PREFERENCE_FIELD,
  commitSetting,
  safetyDepthFieldFor,
  type FieldSpec,
} from './OptionsPanel';
import BoatPicker from './BoatPicker';
import { boatById, type BoatId } from '../data/boats';

// #299: the Boat tab's content — a SELF-CONTAINED settings surface with its
// own explicit props (value/onChange only, no App.tsx/PlannerPanel wiring
// baked in) so the host that renders it is swappable later without touching
// this file. This is now the ONLY place these fields are actually rendered
// in the live app; OptionsPanel.tsx's own default export (deleted in the
// #486 fix wave — see the git history / that PR's review) is gone entirely.
// The field SPECS (bounds, i18n label keys) and the commit helper still
// live in OptionsPanel.tsx (one source of truth for validation), but the
// actual JSX here is independent.
//
// SAFETY DEPTH (PR #486 review — issue #299's design question 2, corrected):
// renders BOTH here (canonical home, per the issue's own recommendation) AND
// inline in PlannerPanel's compact row (quick access — one of the two
// most-changed inputs, §3.3). Both surfaces share ONE source of truth —
// safetyDepthFieldFor(selectedBoat) and commitSetting from OptionsPanel.tsx
// (#539 item 2 replaced the shared `SAFETY_DEPTH_FIELD` constant with that
// per-boat derivation at BOTH call sites, so the two still share one source
// and still clamp identically) — reading
// and writing the SAME `value.safetyDepthM` App.tsx passes to both — so
// editing in either place is immediately reflected in the other on the next
// render (there is no local component state to go stale; both surfaces are
// pure functions of the same `settings` prop). Pinned by
// SettingsPanel.test.tsx / PlannerPanel.test.tsx's shared "single source of
// truth" tests.
export interface SettingsPanelProps {
  value: Settings;
  onChange: (settings: Settings) => void;
  // #54: the selected boat, and the setter the picker commits a switch
  // through. Held by App.tsx (localStorage via usePersistedBoatId) rather
  // than here, because PlannerPanel needs the same selection for its own
  // inline safety-depth bounds and this panel unmounts whenever the Boat tab
  // is not the active one.
  boatId: BoatId;
  onBoatIdChange: (next: BoatId) => void;
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

export default function SettingsPanel({
  value,
  onChange,
  boatId,
  onBoatIdChange,
  titleRef,
}: SettingsPanelProps) {
  const t = useT();
  const boat = boatById(boatId);
  // #699: computed once and reused for both the NumericField's spec and its
  // help text's {min}/{max} interpolation, rather than calling
  // safetyDepthFieldFor(boat) twice for the same render.
  const safetyDepthField = safetyDepthFieldFor(boat);
  const mmsi = value.ownMmsi ?? '';
  const mmsiInvalid = mmsi !== '' && !isValidMmsi(mmsi);

  // #353 PR2: seamark symbol size + display category are map CHROME, not a
  // domain `Settings` field — same localStorage/usePersistedNumber contract
  // as #355's panel width, deliberately NOT threaded through `value`/
  // `onChange` (those round-trip through IndexedDB with the rest of
  // `Settings`, per `AppState.tsx`'s `useSettings()`). DataLayers.tsx reads
  // the SAME keys to apply the live value to the map; the hook's own
  // cross-instance sync (see its module comment) is what keeps the two in
  // step despite this panel unmounting whenever the Boat tab isn't active.
  const [seamarkSizeScaleStored, setSeamarkSizeScale] = usePersistedNumber(
    'sc-seamark-size-scale',
    SEAMARK_SIZE_MIN,
    SEAMARK_SIZE_MAX,
  );
  const seamarkSizeScale = seamarkSizeScaleStored ?? SEAMARK_SIZE_SCALE;
  // #513 R4: unclamped bounds — see DataLayers.tsx's identical call site for
  // why [BASE, ALL] would launder a corrupt negative value past
  // `toSeamarkDisplayTier`'s own guard before it ever runs.
  const [seamarkDisplayTierStored, setSeamarkDisplayTier] = usePersistedNumber(
    'sc-seamark-display-tier',
    -Infinity,
    Infinity,
  );
  const seamarkDisplayTier = toSeamarkDisplayTier(seamarkDisplayTierStored);
  // #513 F6: computed ONCE and reused for both the visible `<output>` text
  // and the Slider's `aria-valuetext` — the two must never drift apart, or
  // the sighted and screen-reader experiences would disagree with each other.
  const seamarkSizePercentLabel = t('settings.seamarkSize.value', {
    percent: Math.round(seamarkSizeScale * 100),
  });

  return (
    <div className="settings-panel">
      {/* #54: the boat picker leads the tab. It sits ABOVE "Boat & safety"
          deliberately — every field in that card is scoped to the selected
          boat (its safety-depth minimum literally derives from this
          selection, #539 item 2), so choosing the boat is the parent act and
          reading it second would invert the dependency. */}
      <BoatPicker
        boatId={boatId}
        onBoatIdChange={onBoatIdChange}
        settings={value}
        onSettingsChange={onChange}
      />

      {/* #299 grouping: static boat characteristics + the depth safety
          preference — the two boat-handling numbers (maneuver penalty,
          performance factor) belong here rather than under Propulsion
          because they describe THIS boat/crew, not the sail-vs-motor
          decision. Safety depth leads the group (canonical home, PR #486
          review) — see this file's own top-of-file comment for why it also
          stays inline in PlannerPanel and how the two stay single-sourced. */}
      <Card title={t('settings.section.boatSafety')} titleRef={titleRef} titleTabIndex={-1}>
        {/* #539 item 2: bounds follow the SELECTED boat (spec J OQ-1's
            `draftM + 0.1`), not the catalogue default — a 2.30 m hull must
            not be offered the Salona 45's 2.2 m floor. */}
        <NumericField
          spec={safetyDepthField}
          value={value}
          onChange={onChange}
          help={t('options.safetyDepth.help', {
            min: safetyDepthField.min,
            max: safetyDepthField.max,
          })}
        />
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

      {/* #353 PR2: seamark symbol size (a continuous slider — precedented by
          OpenCPN's own "Chart Objects" scale-factor slider, #353's own
          research) and display category (discrete tiers — informed by IMO
          MSC.232(82) Appendix 2's ECDIS Display Base/Standard Display/All
          Other Information split, verified against the resolution's own
          text — see seamarkGlyphs.ts's `seamarkDisplayTier` doc comment for
          the exact mapping, corrected in review at #513 F1/F2). Grouped
          separately from Boat & safety/Propulsion/Live & AIS: this is map
          CHROME, not a boat characteristic or a routing input. */}
      <Card title={t('settings.section.mapDisplay')}>
        <Field
          label={t('settings.seamarkSize.label')}
          htmlFor="settings-seamarkSize"
          help={t('settings.seamarkSize.help')}
          helpId="settings-seamarkSize-help"
        >
          <div className="settings-seamark-size-row">
            <Slider
              id="settings-seamarkSize"
              value={seamarkSizeScale}
              min={SEAMARK_SIZE_MIN}
              max={SEAMARK_SIZE_MAX}
              step={0.1}
              aria-describedby="settings-seamarkSize-help"
              aria-valuetext={seamarkSizePercentLabel}
              onChange={setSeamarkSizeScale}
            />
            {/* #513 F6: `role="status"` is implicit on `<output>` (a polite
                live region) — without `aria-live="off"` it would queue its
                OWN announcement on every drag tick, on top of the slider's
                `aria-valuetext` announcement above, double-speaking the same
                value. The visible text still updates normally; only the
                live-region behavior is suppressed. */}
            <output
              htmlFor="settings-seamarkSize"
              className="settings-seamark-size-value"
              aria-live="off"
            >
              {seamarkSizePercentLabel}
            </output>
          </div>
        </Field>

        <div className="options-field">
          <span id="settings-seamarkCategory-legend">{t('settings.seamarkCategory.label')}</span>
          <div
            role="radiogroup"
            aria-labelledby="settings-seamarkCategory-legend"
            aria-describedby="settings-seamarkCategory-help"
            className="settings-seamark-category"
          >
            <label>
              <input
                type="radio"
                name="settings-seamarkCategory"
                checked={seamarkDisplayTier === SEAMARK_DISPLAY_TIER_BASE}
                onChange={() => setSeamarkDisplayTier(SEAMARK_DISPLAY_TIER_BASE)}
              />
              {t('settings.seamarkCategory.base')}
            </label>
            <label>
              <input
                type="radio"
                name="settings-seamarkCategory"
                checked={seamarkDisplayTier === SEAMARK_DISPLAY_TIER_STANDARD}
                onChange={() => setSeamarkDisplayTier(SEAMARK_DISPLAY_TIER_STANDARD)}
              />
              {t('settings.seamarkCategory.standard')}
            </label>
            <label>
              <input
                type="radio"
                name="settings-seamarkCategory"
                checked={seamarkDisplayTier === SEAMARK_DISPLAY_TIER_ALL}
                onChange={() => setSeamarkDisplayTier(SEAMARK_DISPLAY_TIER_ALL)}
              />
              {t('settings.seamarkCategory.all')}
            </label>
          </div>
          <p className="options-help" id="settings-seamarkCategory-help">
            {t('settings.seamarkCategory.help')}
          </p>
        </div>
      </Card>
    </div>
  );
}
