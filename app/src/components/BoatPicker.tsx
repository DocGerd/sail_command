import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Settings } from '../types';
import { BOATS, boatById, type BoatDef, type BoatId } from '../data/boats';
import { type Lang, useLang, useT } from '../i18n';
import { clampSettingsToBoat } from '../lib/boatSettings';
import { defaultSafetyDepthM } from '../lib/boatDepth';
import { POLAR_TIER_LABEL_KEY, weakestPolarTier } from '../lib/boatProvenance';
import { formatDepthM } from '../lib/depthDisclosure';
import {
  computeHarborAccess,
  findLowerSettingHint,
  type HarborAccessByHarbor,
  type HarborWithReachability,
  type LowerSettingHintOutcome,
} from '../lib/harborReachability';
import type { NavMask } from '../lib/mask';
import { isValidMmsi } from '../lib/mmsi';
import { usePersistedOwnMmsi } from '../lib/ownMmsi';
import { useNavMask } from '../state/useNavMask';
import { loadRoutingAssets } from '../services/assets';
import Card from './Card';
import Chip from './Chip';
import Disclosure from './Disclosure';
import Field from './Field';

type TFunction = ReturnType<typeof useT>;

// #1292 (#1135 §13 item 1/3, PR #1316): per-`unreachable` harbour, decimetres
// scanned per idle tick before yielding — a full scan can cost up to
// ~DEFAULT_HINT_MAX_STEPS floods (~150-200ms each, harborReachability.ts's
// own comment), so this keeps any ONE synchronous slice small regardless of
// how many decimetres a search ultimately needs. `findLowerSettingHint`'s
// `resumeFromDepthM` is what lets `useLowerSettingHints` below continue the
// SAME downward scan across ticks rather than restarting it.
const HINT_STEPS_PER_SLICE = 3;

/**
 * §12 Q3/§9: loaded independently of any parent prop, mirroring
 * `state/useNavMask.ts`'s own module-cached `loadRoutingAssets()` singleton
 * (see that hook's comment) — this component has no route to a new prop
 * without editing `SettingsPanel.tsx`/`App.tsx`, and none is needed: the
 * promise is fetch-once and shared, so this costs no extra network work and
 * shares the SAME `harbors` array reference `computeHarborAccess`'s own
 * per-(mask, harbors) cache keys on.
 */
function useHarborsAsset(): HarborWithReachability[] | null {
  const [harbors, setHarbors] = useState<HarborWithReachability[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadRoutingAssets()
      .then((assets) => {
        if (cancelled) return;
        setHarbors(assets.harbors as HarborWithReachability[]);
      })
      .catch((err: unknown) => {
        // Mirrors useNavMask's own degrade-to-null contract: a failed asset
        // load must read as the §5.1 "not yet checked" pending string, never
        // throw into the Boat tab or silently read as all-clear.
        console.warn('BoatPicker: routing assets unavailable, harbour access disabled', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return harbors;
}

function scheduleIdle(work: () => void): { cancel: () => void } {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    const handle = window.requestIdleCallback(work, { timeout: 2000 });
    return {
      cancel: () => {
        if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle);
      },
    };
  }
  const handle = setTimeout(work, 0);
  return { cancel: () => clearTimeout(handle) };
}

/**
 * §12 Q3: derive the SELECTED boat's access synchronously as soon as the
 * assets are ready (`eager`); every OTHER boat only once this component has
 * already mounted, and lazily even then — §9's cost note ("a per-hull
 * classification is ~1 s… compute off the main thread or in idle slices")
 * is why a non-selected row does not compute at all until an idle tick, so
 * three boats don't pay their worst-case cost in the same render.
 * `computeHarborAccess` is itself memoised per (mask, harbors, boat.id,
 * depth), so calling it again on every render of the eager path is cheap
 * after the first.
 */
function useHarborAccessForOption(
  mask: NavMask | null,
  harbors: HarborWithReachability[] | null,
  boat: BoatDef,
  depthM: number,
  eager: boolean,
): HarborAccessByHarbor | null {
  const [deferred, setDeferred] = useState<HarborAccessByHarbor | null>(null);

  useEffect(() => {
    // `eager`: rendered directly below, not from this state. `!mask ||
    // !harbors`: nothing to schedule yet — `deferred` starts `null` and is
    // set only from the scheduled callback below, so there is nothing to
    // reset here (mask/harbors only ever transition null -> loaded, never
    // back, so this branch is not a state a later render needs undone).
    if (eager || !mask || !harbors) return;
    let cancelled = false;
    const { cancel } = scheduleIdle(() => {
      if (!cancelled) setDeferred(computeHarborAccess(mask, harbors, boat, depthM));
    });
    return () => {
      cancelled = true;
      cancel();
    };
  }, [eager, mask, harbors, boat, depthM]);

  if (eager) return mask && harbors ? computeHarborAccess(mask, harbors, boat, depthM) : null;
  return deferred;
}

/**
 * #1321 (round-3 review of PR #1316): `findLowerSettingHint` only searches
 * down to this boat's own DEFAULT safety depth, so a harbour reachable only
 * BELOW that default is never surfaced — never render "unreachable at any
 * setting"; `boat.harbors.hintNotFound` states the narrower, true claim.
 * Deferred and step-bounded (`HINT_STEPS_PER_SLICE`) for the same reason as
 * `useHarborAccessForOption`: the search is DELIBERATELY LAZY per that
 * function's own doc comment and must never run from `handleSelect` or any
 * eager path. A non-selected boat sits at its own default, so its search
 * range is empty and every outcome resolves 'not-found' in one step; only
 * the SELECTED boat at a live depth above its default can need more than one
 * idle tick, which is exactly the `resumeFromDepthM` resume this hook drives.
 */
function useLowerSettingHints(
  mask: NavMask | null,
  boat: BoatDef,
  depthM: number,
  unreachable: readonly HarborWithReachability[],
): ReadonlyMap<string, LowerSettingHintOutcome> {
  const [hints, setHints] = useState<ReadonlyMap<string, LowerSettingHintOutcome>>(new Map());

  useEffect(() => {
    // A stale `hints` entry from a PRIOR (boat, depthM) run is at worst one
    // idle tick out of date — the very first step below overwrites it, and
    // nothing reads an entry for a harbour that has left `unreachable`
    // (BoatOption only looks up ids from the CURRENT `unreachable` array) —
    // so no synchronous reset is needed here, only the mask-not-loaded and
    // nothing-to-search guards.
    if (!mask || unreachable.length === 0) return;
    const boundMask = mask;
    let cancelled = false;
    let cancelIdle: (() => void) | null = null;
    const working = new Map<string, LowerSettingHintOutcome>();

    function step(index: number, resumeFromDepthM: number | undefined): void {
      if (cancelled || index >= unreachable.length) return;
      const scheduled = scheduleIdle(() => {
        if (cancelled) return;
        const harbor = unreachable[index]!;
        const outcome = findLowerSettingHint(
          boundMask,
          harbor,
          boat,
          resumeFromDepthM ?? depthM,
          HINT_STEPS_PER_SLICE,
        );
        working.set(harbor.id, outcome);
        setHints(new Map(working));
        if (outcome.kind === 'exhausted') step(index, outcome.resumeFromDepthM);
        else step(index + 1, undefined);
      });
      cancelIdle = scheduled.cancel;
    }
    step(0, undefined);

    return () => {
      cancelled = true;
      cancelIdle?.();
    };
  }, [mask, boat, depthM, unreachable]);

  return hints;
}

/**
 * §5.1: one line for the harbour-access disclosure's summary (or the
 * no-disclosure/pending states) AND for the merged boat-switch announcement
 * below — both name the same fact, so they share this composer rather than
 * drifting into two phrasings of "N affected at X m". `null` count means the
 * derivation has not run yet (mask/harbors not loaded, or — for a
 * non-selected boat — its own deferred computation hasn't fired); `isDefault`
 * appends `boat.harbors.summaryDefault` for every row EXCEPT the announcement
 * and the selected boat's own row, both of which are always at the LIVE
 * setting (§12 Q7).
 */
function harborAccessSummaryText(
  count: number | null,
  depthM: number,
  lang: Lang,
  t: TFunction,
  isDefault: boolean,
): string {
  const depth = formatDepthM(depthM, lang);
  if (count === null) return t('boat.harbors.pending');
  const suffix = isDefault ? ` ${t('boat.harbors.summaryDefault')}` : '';
  const body =
    count === 0
      ? t('boat.harbors.noneAffected', { depth })
      : t('boat.harbors.summary', { count, depth });
  return `${body}${suffix}`;
}

/** #1321: the per-harbour qualifier appended to each name inside
 * `boat.harbors.unreachable`'s `{list}` — `undefined`/`'exhausted'` both
 * render as still-checking, since a caller must never surface an
 * intermediate `resumeFromDepthM` state as if it were a final answer. */
/** Exported for direct unit testing against a REAL `findLowerSettingHint`
 * outcome — a pure function, no React involved. */
// eslint-disable-next-line react-refresh/only-export-components
export function harborHintSuffix(
  outcome: LowerSettingHintOutcome | undefined,
  boat: BoatDef,
  lang: Lang,
  t: TFunction,
): string {
  if (!outcome || outcome.kind === 'exhausted') return t('boat.harbors.hintPending');
  if (outcome.kind === 'found') {
    const depth = formatDepthM(outcome.hint.depthM, lang);
    // Review Major (PR #1324): a `found` hint's OWN state matters — reaching
    // a harbour only via `shallow-approach` still carries the depth-warning
    // caution `boat.harbors.shallow` states elsewhere; collapsing it into
    // the plain `hintFound` phrase silently dropped that caution. Keyed by
    // the outcome's `hint.state`, never by the harbour's own (always
    // `unreachable`, since that's the only state this hint is ever queried
    // for) — mirrors sibling PR #1323's `harborAccessCopy`, which keys the
    // same distinction the same way.
    return outcome.hint.state === 'shallow-approach'
      ? t('boat.harbors.hintFoundShallow', { depth })
      : t('boat.harbors.hintFound', { depth });
  }
  // #1321/orchestrator ruling: the search floor is this boat's
  // DEFAULT safety depth, not its true minimum, and a user can already hold
  // a depth below that default without ever switching boats — so this must
  // never claim "at any setting this boat keeps"; it states only what the
  // search actually checked.
  return t('boat.harbors.hintNotFound', { boat: boat.name });
}

export interface BoatPickerProps {
  boatId: BoatId;
  onBoatIdChange: (next: BoatId) => void;
  /** The live settings record — read for the spec C.7 clamp, written back through onSettingsChange. */
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
  /** #1325 (#1135 §5.4): the currently SELECTED origin/destination's harbor
   * id, `null` when nothing is picked or the pick is a map tap rather than a
   * harbor (App.tsx: `origin?.source === 'harbor' ? origin.harborId : null`).
   * This component has no other route to that state — see the module doc
   * comment on why it self-loads `mask`/`harbors` instead of taking them as
   * props; this is the one piece those two assets cannot substitute for. */
  originHarborId: string | null;
  destinationHarborId: string | null;
}

/**
 * The merged boat-switch announcement (maintainer ruling on #1292):
 * boat, then the raised depth if any, then any now-unreachable SELECTED
 * endpoint (#1325), then this boat's harbour access — ONE `role="status"`
 * message, never two. `clamp` carries BOTH endpoints (#1293's
 * original reason for the shape) though only `toM` reaches `boat.clamp.notice`
 * today; `null` means spec C.7 did not fire on this switch, so the composer
 * below skips that clause entirely rather than reporting a change that did
 * not happen.
 */
interface ClampNotice {
  /** Kept alongside `boatName` so the announcement's access clause can be
   * RECOMPUTED reactively (see `composeSwitchAnnouncement`) rather than
   * frozen at switch time — see that function's own comment for why. */
  boatId: BoatId;
  boatName: string;
  clamp: { fromM: number; toM: number } | null;
  /** The depth ACTUALLY used to compute the access clause below — the
   * CLAMPED value when `clamp` is set, otherwise the live setting this
   * switch found unchanged. #1292 ordering rule: this is read AFTER the
   * clamp decision in `handleSelect`, never `settings.safetyDepthM` from
   * before it — reading pre-clamp here would announce the wrong boat's
   * access at a depth the app never actually applies (spec C.7 clamps UP
   * before anything else runs). */
  depthM: number;
}

/** #1325 (#1135 §5.4): one clause for a SELECTED endpoint whose boat-scoped
 * access is 'unreachable' for the newly picked boat — `null` for every other
 * case (no pick, a tap pick with no `harborId`, the harbor missing from
 * `harbors`, or any state other than 'unreachable'). Deliberately excludes
 * 'known-disconnected': that state is boat-independent — it was already
 * unreachable before this switch too, per its own #652/#834 marker on the
 * endpoint row (§5.3) — so re-announcing it on every switch would be noise
 * about a fact the switch did not change. */
function endpointUnreachableClause(
  harborId: string | null,
  endpointLabelKey: 'planner.origin.label' | 'planner.destination.label',
  access: HarborAccessByHarbor,
  harbors: readonly HarborWithReachability[],
  boatName: string,
  lang: Lang,
  t: TFunction,
): string | null {
  if (harborId === null || access.get(harborId) !== 'unreachable') return null;
  const harbor = harbors.find((h) => h.id === harborId);
  if (!harbor) return null;
  return t('boat.switch.endpointUnreachable', {
    endpoint: t(endpointLabelKey),
    harbor: harbor.names[lang],
    boat: boatName,
  });
}

/**
 * PR #1324 review Minor: the access clause is computed HERE, at RENDER
 * time, from the CURRENT `mask`/`harbors` — never captured once inside
 * `handleSelect` and frozen into `notice`. A switch fired before assets
 * finished loading used to freeze on `boat.harbors.pending` forever, even
 * after `mask`/`harbors` resolved and the boat's OWN row updated reactively;
 * calling `computeHarborAccess` inline here means every re-render (including
 * the one `mask`/`harbors` loading triggers) recomputes it fresh, at no
 * extra cost — the function is memoised per (mask, harbors, boat.id, depth).
 */
function composeSwitchAnnouncement(
  notice: ClampNotice,
  mask: NavMask | null,
  harbors: HarborWithReachability[] | null,
  originHarborId: string | null,
  destinationHarborId: string | null,
  lang: Lang,
  t: TFunction,
): string {
  const parts = [t('boat.switch.selected', { boat: notice.boatName })];
  if (notice.clamp) {
    parts.push(
      t('boat.clamp.notice', {
        depth: formatDepthM(notice.clamp.toM, lang),
        boat: notice.boatName,
      }),
    );
  }
  let accessCount: number | null = null;
  if (mask && harbors) {
    const access = computeHarborAccess(mask, harbors, boatById(notice.boatId), notice.depthM);
    // Origin before destination — matches PlannerPanel's own top-to-bottom
    // reading order for the two endpoint rows.
    const originClause = endpointUnreachableClause(
      originHarborId,
      'planner.origin.label',
      access,
      harbors,
      notice.boatName,
      lang,
      t,
    );
    if (originClause) parts.push(originClause);
    const destinationClause = endpointUnreachableClause(
      destinationHarborId,
      'planner.destination.label',
      access,
      harbors,
      notice.boatName,
      lang,
      t,
    );
    if (destinationClause) parts.push(destinationClause);
    accessCount = countAffectedHarbors(access, harbors);
  }
  parts.push(harborAccessSummaryText(accessCount, notice.depthM, lang, t, false));
  return parts.join(' ');
}

/** Count of harbours affected for one (boat, depth) pair — `shallow-approach`
 * plus `unreachable`, `known-disconnected` EXCLUDED because that state is a
 * per-HARBOUR fact (already marked in the harbor picker's #652 marker),
 * independent of this boat's draft or depth setting; §5.1's "nothing
 * affected beyond known-disconnected" one-line/no-disclosure case is exactly
 * this exclusion. */
function countAffectedHarbors(
  access: HarborAccessByHarbor,
  harbors: readonly HarborWithReachability[],
): number {
  let n = 0;
  for (const h of harbors) {
    const state = access.get(h.id);
    if (state === 'shallow-approach' || state === 'unreachable') n++;
  }
  return n;
}

interface BoatOptionProps {
  boat: BoatDef;
  selected: boolean;
  onSelect: () => void;
  mask: NavMask | null;
  harbors: HarborWithReachability[] | null;
  /** `settings.safetyDepthM` — used only when `selected` (§12 Q7); every
   * other row uses its OWN `defaultSafetyDepthM`, never this value (§6's
   * rejected "one derivation for every boat at the live setting" option,
   * which would under-mark a deeper boat by a shallower boat's setting). */
  liveDepthM: number;
}

function BoatOption({ boat, selected, onSelect, mask, harbors, liveDepthM }: BoatOptionProps) {
  const t = useT();
  const [lang] = useLang();
  const tier = weakestPolarTier(boat);
  const inputId = `boat-option-${boat.id}`;
  const keelId = `${inputId}-keel`;
  // #701: the provenance note (below) needs its own id too, so the radio's
  // `aria-describedby` can point at it UNCONDITIONALLY — unlike the keel
  // caveat, `draftProvenance.note` renders for every boat (see the #566
  // comment on that paragraph), so it must always be in the description
  // list, not just when `keelUnverified`.
  const noteId = `${inputId}-note`;
  // #1292: this boat's own harbour-access disclosure id, joined into the
  // radio's `aria-describedby` below just like `noteId` — it renders
  // UNCONDITIONALLY (pending, one-line, or the full disclosure), so it is
  // always in the description list.
  const harborsId = `${inputId}-harbors`;
  const depthM = selected ? liveDepthM : defaultSafetyDepthM(boat);
  const access = useHarborAccessForOption(mask, harbors, boat, depthM, selected);
  const { shallow, unreachable, affectedCount } = useMemo(() => {
    if (!access || !harbors) {
      return {
        shallow: [] as HarborWithReachability[],
        unreachable: [] as HarborWithReachability[],
        affectedCount: 0,
      };
    }
    const shallowList: HarborWithReachability[] = [];
    const unreachableList: HarborWithReachability[] = [];
    for (const h of harbors) {
      const state = access.get(h.id);
      if (state === 'shallow-approach') shallowList.push(h);
      else if (state === 'unreachable') unreachableList.push(h);
    }
    return {
      shallow: shallowList,
      unreachable: unreachableList,
      affectedCount: shallowList.length + unreachableList.length,
    };
  }, [access, harbors]);
  const hints = useLowerSettingHints(mask, boat, depthM, unreachable);
  // Spec N.2's disclosure fires on `hullVerified === false`, i.e. "this draft
  // was NOT checked against this hull's own papers" — not on the presence of
  // a field. `draftProvenance` is REQUIRED on every BoatDef, so a fleet entry
  // cannot ship without answering the question; an OPTIONAL field was the
  // #563/#565 cross-branch defect, where the two fleet boats carried
  // `draftProvenance` while this component still read a `keelAssumption` that
  // nothing wrote, and the paragraph was silently never emitted for exactly
  // the two hulls the spec requires it for.
  const keelUnverified = !boat.draftProvenance.hullVerified;
  // #701: `aria-describedby` takes a space-separated id list, so both the
  // keel caveat (when present) and the provenance note are always included.
  // Before this fix the note carried no `id` at all and this attribute was
  // omitted entirely on a hull-verified boat (today only the Salona 45), so
  // the citation was unreachable to a screen-reader user who arrows onto it.
  const keelDescribedBy = {
    // #1292: `harborsId` joins the list UNCONDITIONALLY, alongside `noteId`
    // — arrowing onto this boat must announce its harbour-access count the
    // same way it already announces the provenance note.
    'aria-describedby': keelUnverified
      ? `${keelId} ${noteId} ${harborsId}`
      : `${noteId} ${harborsId}`,
  };
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
        // Points at the keel caveat (when present) AND the provenance note
        // below, so both sentences reach a screen-reader user who ARROWS onto
        // this boat. Without it, either paragraph is only reachable by
        // reading past the control: arrow keys move between radios and skip
        // everything else in the group, which is native behaviour no
        // container role changes (PR #563 MINOR 4). #701: the note id is
        // ALWAYS included — unlike the keel caveat, the note renders for
        // every boat, so gating it on `keelUnverified` the way the caveat is
        // would leave it unreachable on a hull-verified boat (today the
        // Salona 45 alone). It is the DESCRIPTION, not the name — folding it
        // into the label would make every radio announce a paragraph, which
        // the keel comment below rejects for good reason.
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
          screen reader, as a description rather than a name (one id in the
          space-separated list alongside the note's own, #701).

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
          #607 maintainer ruling (DELIBERATE): this renders in
          the citation's ORIGINAL language regardless of the active UI
          language — paraphrasing a source citation per language is how a
          citation becomes wrong. Not a missing i18n key; do not re-file
          this as an anomaly (it already has been — #607 itself).
          #707: `lang="en"` (every catalogue note constant in data/boats.ts is
          verified English — WCAG 2.1 SC 3.1.2, Language of Parts) — this
          marks the LANGUAGE of the verbatim citation for assistive tech, it
          does not translate or paraphrase it, so it is fully compatible with
          the #607 ruling above, not a reversal of it.
          #701: `id={noteId}` makes this reachable via the radio's
          `aria-describedby` (see that attribute's own comment above) — before
          this fix the element had no id and was referenced by nothing, so a
          screen-reader user never heard it. `.boat-option-draft-note` in
          app.css also gets a left border to visually separate this citation
          from the keel caveat immediately above it (when both render), since
          the two previously shared identical typography and read as one
          run-on paragraph. */}
      <p className="boat-option-draft-note" id={noteId} lang="en">
        {boat.draftProvenance.note}
      </p>
      {/* #1292 (#1135 §5.1/§13 item 3): per-boat harbour access. THREE render
          states, in this order: PENDING while `mask`/`harbors` haven't
          loaded yet, or — for a non-selected boat — before its own deferred
          derivation has run (§9: computing all three boats synchronously up
          front could cost ~1s each, so a non-selected row's own
          `computeHarborAccess` call is deferred to an idle tick); a ONE-LINE
          no-disclosure summary when nothing beyond `known-disconnected` is
          affected (§5.1 explicitly rejects wrapping that in a `Disclosure`
          with nothing to expand into); and the full disclosure once >=1
          harbour is `shallow-approach`/`unreachable`. Wrapped in a `<div
          id={harborsId}>` rather than passing an id to `Disclosure` itself
          (which accepts no such prop) — whichever of the three states is
          showing is what the radio's `aria-describedby` above reaches; a
          closed `<details>`'s body drops out of the accessibility tree
          regardless, so this reaches exactly the SUMMARY text either way.
          `boat-option-harbors-slot` gives it `grid-column: 2` matching
          `.boat-option-keel`/`-draft-note`/`-polars` — omitting it left this
          wrapper auto-placed into the narrow radio column (measured,
          app.css's own comment on the rule). */}
      <div id={harborsId} className="boat-option-harbors-slot">
        {access === null ? (
          <p className="boat-option-harbors">{t('boat.harbors.pending')}</p>
        ) : affectedCount === 0 ? (
          <p className="boat-option-harbors">
            {harborAccessSummaryText(0, depthM, lang, t, !selected)}
          </p>
        ) : (
          <Disclosure
            className="boat-option-harbors"
            summary={harborAccessSummaryText(affectedCount, depthM, lang, t, !selected)}
          >
            {shallow.length > 0 && (
              <p>
                {t('boat.harbors.shallow', {
                  list: shallow.map((h) => h.names[lang]).join(', '),
                })}
              </p>
            )}
            {unreachable.length > 0 && (
              <p>
                {t('boat.harbors.unreachable', {
                  list: unreachable
                    .map(
                      (h) =>
                        `${h.names[lang]} (${harborHintSuffix(hints.get(h.id), boat, lang, t)})`,
                    )
                    .join(', '),
                })}
              </p>
            )}
          </Disclosure>
        )}
      </div>
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
                  #607 maintainer ruling (DELIBERATE): renders in
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
  originHarborId,
  destinationHarborId,
}: BoatPickerProps) {
  const t = useT();
  const [lang] = useLang();
  const [notice, setNotice] = useState<ClampNotice | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  // #1292: loaded once here, shared by every BoatOption row AND `handleSelect`'s
  // own announcement — see `useNavMask`/`useHarborsAsset`'s own comments for
  // why this needs no new prop from SettingsPanel/App.tsx.
  const mask = useNavMask();
  const harbors = useHarborsAsset();
  // #746: keyed on the CURRENTLY SELECTED boat, so a switch swaps the field's
  // value in the same commit that swaps the selection — the hook re-reads
  // during render rather than in an effect, for the reason its own comment
  // gives.
  const [storedMmsi, setOwnMmsi] = usePersistedOwnMmsi(boatId);
  const mmsi = storedMmsi ?? '';
  const mmsiInvalid = mmsi !== '' && !isValidMmsi(mmsi);

  // #699: a clamping switch scrolls the notice into view — without this, the
  // announcement can render below the Boat card's ~18-20 rows of boat
  // options, inside .app-panel's own overflow-y:auto, with nothing drawing
  // the eye to it. Runs in an effect keyed on `notice`, not inline in
  // handleSelect: at the point handleSelect calls setNotice the DOM still
  // shows the PREVIOUS (possibly empty, zero-height per the "costs no layout
  // while empty" CSS rule — test/boatPickerNoticeLiveRegion.test.ts) state,
  // so scrollIntoView measured then would target the wrong box. `notice` is
  // null on an unclamped switch (see the branch below), so this never fires
  // then — matching the issue's own "only when clamped" requirement without
  // a separate boolean.
  //
  // useLayoutEffect, not useEffect (#699 REVIEW FIX, MINOR): `noticeRef` is
  // this component's OWN JSX descendant, so it is already attached by the
  // time either hook fires — not the sibling-ref hazard PanelResizer.tsx's
  // own comment documents. A passive `useEffect` runs AFTER the browser's
  // next paint, so a clamping switch could paint the expanded notice and
  // only scroll a frame later; `useLayoutEffect` runs synchronously after
  // the DOM mutation but BEFORE that paint, closing the flash while still
  // seeing the real (post-commit, non-empty) box `useEffect` did. REASONED,
  // NOT MEASURED: this rests on React's documented effect-timing contract,
  // not on an observed flash — the real catalogue has only 3 boats, so the
  // notice already sits fully in view with nothing to visibly scroll past,
  // and no tool available here captures frame-level paint timing to show
  // the difference on a card that DOES overflow.
  // #1292: gated on `notice?.clamp`, not on `notice` being non-null — the
  // merged announcement now sets `notice` on EVERY switch (clamped or not),
  // where before #1292 an unclamped switch left `notice` `null` and this
  // effect's own `if (notice)` never fired. #699's "only when clamped"
  // requirement is unchanged; only the condition that expresses it moved.
  useLayoutEffect(() => {
    if (notice?.clamp) noticeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [notice]);

  function handleSelect(nextId: BoatId): void {
    if (nextId === boatId) return;
    const nextBoat = boatById(nextId);
    // Spec C.7: clamp UP, persist the clamped value, and tell the user.
    // NEVER down — a deeper-drafted user's deliberately generous margin is
    // not ours to shrink, and `clampSettingsToBoat` is what enforces that;
    // this call site must not second-guess its `clamped` verdict.
    const { settings: clampedSettings, clamped } = clampSettingsToBoat(settings, nextBoat);
    if (clamped) onSettingsChange(clampedSettings);

    // #1292 ORDERING RULE: the depth THIS switch actually applies — the
    // clamped value when `clamped`, the unchanged live setting otherwise.
    // Reading `settings.safetyDepthM` here unconditionally would announce
    // the newly selected boat's access at its PRE-clamp depth, which the
    // app never actually plans at (spec C.7 raises it before anything else
    // runs). The access COUNT itself is deliberately NOT computed here —
    // `composeSwitchAnnouncement` derives it at render time from the
    // CURRENT `mask`/`harbors` (review Minor: computing it once here would
    // freeze on `boat.harbors.pending` forever if assets were still loading
    // at switch time, never catching up once they resolved).
    const depthM = clamped ? clampedSettings.safetyDepthM : settings.safetyDepthM;

    setNotice({
      boatId: nextId,
      boatName: nextBoat.name,
      clamp: clamped ? { fromM: settings.safetyDepthM, toM: clampedSettings.safetyDepthM } : null,
      depthM,
    });
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
            mask={mask}
            harbors={harbors}
            liveDepthM={settings.safetyDepthM}
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
          ? composeSwitchAnnouncement(
              notice,
              mask,
              harbors,
              originHarborId,
              destinationHarborId,
              lang,
              t,
            )
          : null}
      </p>
      {/* #746. The own-vessel MMSI, scoped to the SELECTED boat. It sits here
          rather than in the Live & AIS card because a field that must follow
          the boat belongs beside the control that changes the boat — and
          because pairing it with the aisstream.io API key invited reading the
          two as one credential, when they differ on every axis that matters:
          the key identifies an ACCOUNT and IS transmitted, the MMSI identifies
          a VESSEL and never is. Storage is one localStorage key per boat
          (lib/ownMmsi.ts); it is deliberately NOT a `Settings` field, so it
          never enters a saved plan's `PlanRequest.settings` snapshot.

          Validation is UNCHANGED from the pre-#746 SettingsPanel control it
          replaces: every keystroke persists, and `isValidMmsi` (exactly nine
          digits) drives `aria-invalid` plus a `role="alert"` message. Moving
          the field must not quietly weaken the one check it had. */}
      <Field label={t('boat.mmsi.label')} htmlFor="boat-ownMmsi" help={t('boat.mmsi.help')}>
        <input
          id="boat-ownMmsi"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={mmsiInvalid}
          aria-describedby={mmsiInvalid ? 'boat-ownMmsi-error' : undefined}
          value={mmsi}
          onChange={(e) => setOwnMmsi(e.target.value)}
        />
      </Field>
      {mmsiInvalid && (
        <p className="options-help" id="boat-ownMmsi-error" role="alert">
          {t('boat.mmsi.invalid')}
        </p>
      )}
    </Card>
  );
}
