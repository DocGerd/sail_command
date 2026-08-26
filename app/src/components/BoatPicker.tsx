import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../types';
import { BOATS, boatById, type BoatDef, type BoatId } from '../data/boats';
import { useLang, useT } from '../i18n';
import { clampSettingsToBoat } from '../lib/boatSettings';
import { POLAR_TIER_LABEL_KEY, weakestPolarTier } from '../lib/boatProvenance';
import { formatDepthM } from '../lib/depthDisclosure';
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
  const [lang] = useLang();
  const tier = weakestPolarTier(boat);
  const inputId = `boat-option-${boat.id}`;
  const keelId = `${inputId}-keel`;
  // Spec N.2's disclosure fires on `hullVerified === false`, i.e. "this draft
  // was NOT checked against this hull's own papers" — not on the presence of
  // a field. `draftProvenance` is REQUIRED on every BoatDef, so a fleet entry
  // cannot ship without answering the question; an OPTIONAL field was the
  // #563/#565 cross-branch defect, where the two fleet boats carried
  // `draftProvenance` while this component still read a `keelAssumption` that
  // nothing wrote, and the paragraph was silently never emitted for exactly
  // the two hulls the spec requires it for.
  const keelUnverified = !boat.draftProvenance.hullVerified;
  // `exactOptionalPropertyTypes`: the prop must be OMITTED, not passed as
  // `undefined`, when there is no caveat paragraph to point at — same shape as
  // SettingsPanel.tsx's own `fieldExtra`/`inputExtra` spreads.
  const keelDescribedBy = keelUnverified ? { 'aria-describedby': keelId } : {};
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
        // Points at the keel caveat below, so the sentence reaches a
        // screen-reader user who ARROWS onto this boat. Without it the caveat
        // is only reachable by reading past the control: arrow keys move
        // between radios and skip everything else in the group, which is
        // native behaviour no container role changes (PR #563 MINOR 4). It is
        // the DESCRIPTION, not the name — folding it into the label would make
        // every radio announce a paragraph, which the keel comment below
        // rejects for good reason.
        {...keelDescribedBy}
        onChange={onSelect}
      />
      <label className="boat-option-label" htmlFor={inputId}>
        <span className="boat-option-name">{boat.name}</span>
        <span className="boat-option-facts">
          <span className="boat-option-draft tabular-nums">
            {t('boat.draft', { depth: formatDepthM(boat.draftM, lang) })}
          </span>
          {/* The tier word alone ("Estimated") does not say what is estimated,
              so the accessible name spells the subject out while the visible
              text stays chip-sized. No `title`: with `aria-label` present it
              would become the accessible DESCRIPTION, giving this chip the
              same string as both name and description, and the per-sail chips
              below already set a no-tooltip convention (PR #563 MINOR 5). */}
          <Chip
            className={`chip-polar-tier chip-polar-tier-${tier}`}
            aria-label={t('boat.polarTier.aria', { tier: t(POLAR_TIER_LABEL_KEY[tier]) })}
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
          folding it in would make every radio announce a paragraph — the
          radio's `aria-describedby` above is what still carries it to a
          screen reader, as a description rather than a name.

          Absent on a hull-verified boat — today the Salona 45 alone, the app's
          model-level reference boat (spec J OQ-4's carve-out) with no individual
          vessel whose papers could disagree. It renders for every fleet entry,
          all of which are `hullVerified: false`. (Until this PR that first
          clause read "today that is the whole catalogue", which was true when
          written and stopped being true the moment the two fleet boats landed
          — the same commit that made this paragraph reachable at all.) */}
      {keelUnverified && (
        <p className="boat-option-keel" id={keelId}>
          {t('boat.keel.assumed', { keel: boat.draftProvenance.keel })}
        </p>
      )}
      {/* #566. `draftProvenance.note` is REQUIRED on every catalogue entry
          (boats.ts) but had zero consumers — including on the hull-verified
          Salona 45, which carries its own model-level citation. Rendered
          UNCONDITIONALLY, never gated on `keelUnverified`: gating it would
          silently drop the reference boat's own note, exactly the failure
          this decision exists to prevent (the keel caveat right above is
          fine to gate — it states a DIFFERENT fact, "this draft was not
          hull-verified", which is trivially false for the reference boat —
          but the note is a citation that exists for every boat regardless).
          Catalogue data per spec F.3, same as `sail.polarProvenance.note`
          below — not an i18n key, so it renders as authored, verbatim.
          #607 maintainer ruling (2026-08-25, DELIBERATE): this renders in
          the citation's ORIGINAL language regardless of the active UI
          language — paraphrasing a source citation per language is how a
          citation becomes wrong. Not a missing i18n key; do not re-file
          this as an anomaly (it already has been — #607 itself).
          #707: `lang="en"` (every catalogue note constant in data/boats.ts is
          verified English — WCAG 2.1 SC 3.1.2, Language of Parts) — this
          marks the LANGUAGE of the verbatim citation for assistive tech, it
          does not translate or paraphrase it, so it is fully compatible with
          the #607 ruling above, not a reversal of it. */}
      <p className="boat-option-draft-note" lang="en">
        {boat.draftProvenance.note}
      </p>
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
                  citation per language is how a citation becomes wrong.
                  #607 maintainer ruling (2026-08-25, DELIBERATE): renders in
                  the citation's original language regardless of UI
                  language, by design — do not re-file this as an anomaly.
                  #707: `lang="en"` — same rationale as
                  `boat-option-draft-note` above (WCAG 2.1 SC 3.1.2); marks
                  the citation's language, does not translate it. */}
              <span className="boat-option-sail-note" lang="en">
                {sail.polarProvenance.note}
              </span>
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
  const [lang] = useLang();
  const [notice, setNotice] = useState<ClampNotice | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);

  // #699: a clamping switch scrolls the notice into view — without this, the
  // announcement can render below the Boat card's ~18-20 rows of boat
  // options, inside .app-panel's own overflow-y:auto, with nothing drawing
  // the eye to it. Runs in an effect keyed on `notice`, not inline in
  // handleSelect: at the point handleSelect calls setNotice the DOM still
  // shows the PREVIOUS (possibly empty, zero-height per the "costs no layout
  // while empty" CSS rule — test/boatPickerNoticeLiveRegion.test.ts) state,
  // so scrollIntoView measured then would target the wrong box. This effect
  // fires after React has committed the notice's real (expanded) text, so it
  // scrolls to where the announcement actually ends up. `notice` is null on
  // an unclamped switch (see the branch below), so this never fires then —
  // matching the issue's own "only when clamped" requirement without a
  // separate boolean.
  useEffect(() => {
    if (notice) noticeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [notice]);

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

    // Native radios select on arrow-key focus, so arrowing THROUGH a deeper
    // boat clamps up and persists on the way past, and nothing lowers it
    // again. That is spec C.7 working as specified — the clamp is monotone by
    // design — but it means transit, not just landing, raises the gate.

    // Deliberately NOT applying settingsDefaultsForBoat's other two fields
    // (motorSpeedKn, maneuverPenaltyS): spec C.7 governs safetyDepthM alone,
    // and those two are values the user may have tuned for their own crew.
    // Overwriting them on a boat switch would be clamping a preference, which
    // is the direction the spec forbids for the one field it does cover.
  }

  return (
    <Card title={t('boat.section.title')} className="boat-picker-card">
      {/* `group`, NOT `radiogroup` (PR #563 MINOR 4): WAI-ARIA gives
          `radiogroup` required owned elements `radio`, and each option here
          also owns a keel caveat and a provenance disclosure. `group` permits
          arbitrary owned content and still carries the accessible name.
          Nothing is lost by the change: arrow-key roving and the single tab
          stop come from the shared `name` attribute, which is native browser
          behaviour and independent of the container's ARIA role. */}
      <div className="boat-picker" role="group" aria-label={t('boat.picker.label')}>
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
          the mutation on. app.css therefore zeroes an empty one's box rather
          than setting `display: none`, which would take it back out of that
          tree and lose the announcement — see that rule's own comment, and
          test/boatPickerNoticeLiveRegion.test.ts, which pins it. */}
      <p className="boat-picker-notice" role="status" ref={noticeRef}>
        {notice
          ? t('boat.clamp.notice', {
              depth: formatDepthM(notice.depthM, lang),
              boat: notice.boatName,
            })
          : null}
      </p>
    </Card>
  );
}
