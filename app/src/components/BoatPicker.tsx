import { useState } from 'react';
import type { Settings } from '../types';
import { BOATS, boatById, type BoatDef, type BoatId } from '../data/boats';
import { useT } from '../i18n';
import { clampSettingsToBoat } from '../lib/boatSettings';
import { POLAR_TIER_LABEL_KEY, weakestPolarTier } from '../lib/boatProvenance';
import Card from './Card';
import Chip from './Chip';
import Disclosure from './Disclosure';

export interface BoatPickerProps {
  boatId: BoatId;
  onBoatIdChange: (next: BoatId) => void;
  /** The live settings record — read for the spec C.7 clamp, written back through onSettingsChange. */
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
}

/** What the spec C.7 clamp changed, captured for the status announcement. */
interface ClampNotice {
  depthM: number;
  boatName: string;
}

interface BoatOptionProps {
  boat: BoatDef;
  selected: boolean;
  onSelect: () => void;
}

function BoatOption({ boat, selected, onSelect }: BoatOptionProps) {
  const t = useT();
  const tier = weakestPolarTier(boat);
  const inputId = `boat-option-${boat.id}`;
  return (
    <div
      className={['boat-option', selected ? 'boat-option-selected' : null]
        .filter(Boolean)
        .join(' ')}
    >
      <input
        type="radio"
        id={inputId}
        // One shared `name` is what makes these a native radio group:
        // arrow-key roving focus, one tab stop for the whole set, and
        // exactly one selection — none of which a set of buttons gives us.
        name="sc-boat-picker"
        className="boat-option-radio"
        value={boat.id}
        checked={selected}
        onChange={onSelect}
      />
      <label className="boat-option-label" htmlFor={inputId}>
        <span className="boat-option-name">{boat.name}</span>
        <span className="boat-option-facts">
          <span className="boat-option-draft tabular-nums">
            {t('boat.draft', { depth: boat.draftM.toFixed(1) })}
          </span>
          {/* The tier word alone ("Estimated") does not say what is estimated,
              and the chip is the one part of this row a screen-reader user
              may hear out of context — so the accessible name spells the
              subject out while the visible text stays chip-sized. */}
          <Chip
            className={`chip-polar-tier chip-polar-tier-${tier}`}
            aria-label={t('boat.polarTier.aria', { tier: t(POLAR_TIER_LABEL_KEY[tier]) })}
            title={t('boat.polarTier.aria', { tier: t(POLAR_TIER_LABEL_KEY[tier]) })}
          >
            {t(POLAR_TIER_LABEL_KEY[tier])}
          </Chip>
        </span>
      </label>
      {/* Spec N.2. A wrong keel is invisible in EVERY artifact this app
          renders — the gate, the relaxation floor and the shallow banner all
          read as if the assumed draft were the hull's own. This sentence is
          the only thing that makes it checkable by someone who can see the
          boat, which is why it sits on the picker rather than in a JSON
          field. Rendered outside the <label> deliberately: it is a caveat
          about the option, not part of the control's accessible name, and
          folding it in would make every radio announce a paragraph.

          Absent on a boat that declares no assumption — today that is the
          whole catalogue, because the Salona 45 is the app's model-level
          reference boat (spec J OQ-4's carve-out) and not a fleet hull whose
          keel was assumed. It renders as soon as a fleet entry lands. */}
      {boat.keelAssumption !== undefined && (
        <p className="boat-option-keel">{t('boat.keel.assumed', { keel: boat.keelAssumption })}</p>
      )}
      <Disclosure className="boat-option-polars" summary={t('boat.polarDetail.summary')}>
        <ul className="boat-option-sails">
          {boat.sails.map((sail) => (
            <li key={sail.id}>
              <span className="boat-option-sail-head">
                <span className="boat-option-sail-name">{sail.label}</span>
                <Chip
                  className={`chip-polar-tier chip-polar-tier-${sail.polarProvenance.tier}`}
                  aria-label={t('boat.polarTier.aria', {
                    tier: t(POLAR_TIER_LABEL_KEY[sail.polarProvenance.tier]),
                  })}
                >
                  {t(POLAR_TIER_LABEL_KEY[sail.polarProvenance.tier])}
                </Chip>
              </span>
              {/* The catalogue's own source note, verbatim. Not an i18n key:
                  it is provenance data (spec F.3 — the same reason sail
                  labels are catalogue strings), and paraphrasing a source
                  citation per language is how a citation becomes wrong. */}
              <span className="boat-option-sail-note">{sail.polarProvenance.note}</span>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

/**
 * #54 / #539. The boat selection surface: one row per catalogue boat with its
 * name, draft, polar-provenance tier (spec G.3, spec N.5's picker label) and,
 * where the catalogue declares one, the keel assumption behind that draft
 * (spec N.2).
 *
 * ONE ENTRY IS THE RELEASE-1 SHAPE, not a degenerate case to apologise for:
 * a single selected radio row reads as "this is the boat you are planning
 * for", which is exactly true, and every fleet entry that lands afterwards
 * simply adds a row.
 *
 * Spec C.7's clamp lives HERE rather than in App.tsx because the announcement
 * has to appear where the action was taken — a status line in some other
 * panel would fire while the user is looking at this one.
 */
export default function BoatPicker({
  boatId,
  onBoatIdChange,
  settings,
  onSettingsChange,
}: BoatPickerProps) {
  const t = useT();
  const [notice, setNotice] = useState<ClampNotice | null>(null);

  function handleSelect(nextId: BoatId): void {
    if (nextId === boatId) return;
    const nextBoat = boatById(nextId);
    // Spec C.7: clamp UP, persist the clamped value, and tell the user.
    // NEVER down — a deeper-drafted user's deliberately generous margin is
    // not ours to shrink, and `clampSettingsToBoat` is what enforces that;
    // this call site must not second-guess its `clamped` verdict.
    const { settings: clampedSettings, clamped } = clampSettingsToBoat(settings, nextBoat);
    if (clamped) {
      onSettingsChange(clampedSettings);
      setNotice({ depthM: clampedSettings.safetyDepthM, boatName: nextBoat.name });
    } else {
      // A later switch that needs no clamp must not leave the previous
      // switch's notice standing beside it, claiming a change that this
      // selection did not make.
      setNotice(null);
    }
    onBoatIdChange(nextId);

    // Deliberately NOT applying settingsDefaultsForBoat's other two fields
    // (motorSpeedKn, maneuverPenaltyS): spec C.7 governs safetyDepthM alone,
    // and those two are values the user may have tuned for their own crew.
    // Overwriting them on a boat switch would be clamping a preference, which
    // is the direction the spec forbids for the one field it does cover.
  }

  return (
    <Card title={t('boat.section.title')} className="boat-picker-card">
      <div className="boat-picker" role="radiogroup" aria-label={t('boat.picker.label')}>
        {BOATS.map((b) => (
          <BoatOption
            key={b.id}
            boat={b}
            selected={b.id === boatId}
            onSelect={() => handleSelect(b.id)}
          />
        ))}
      </div>
      {/* Rendered UNCONDITIONALLY, empty when there is nothing to say: a
          role="status" live region must already be in the accessibility tree
          before its text changes, or assistive tech has nothing to observe
          the mutation on. app.css hides it with :empty so an empty region
          costs no layout. */}
      <p className="boat-picker-notice" role="status">
        {notice
          ? t('boat.clamp.notice', {
              depth: notice.depthM.toFixed(1),
              boat: notice.boatName,
            })
          : null}
      </p>
    </Card>
  );
}
