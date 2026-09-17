import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { Harbor } from '../types';
import { useLang, useT, type Lang } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import {
  findLowerSettingHint,
  type HarborAccessByHarbor,
  type HarborAccessState,
  type HarborWithReachability,
  type LowerSettingHintOutcome,
} from '../lib/harborReachability';
import type { NavMask } from '../lib/mask';
import type { BoatDef } from '../data/boats';
import { formatDepthM } from '../lib/depthDisclosure';

// #652: `knownDisconnected` is a build-generated field (pipeline/
// build_harbors.mjs, sourced from pipeline/verify_mask.py's
// KNOWN_DISCONNECTED dict) naming the five #9 harbours genuinely
// unreachable at the ~46 m mask resolution. It used to live here as a local
// intersection (every existing caller still passes a plain `Harbor[]` — the
// field is optional, so that stays structurally assignable) rather than
// widening the shared `Harbor` type in types.ts. #834 promoted the alias
// itself to `lib/harborReachability.ts` — a NON-closure module, unlike
// types.ts — once PlannerPanel's selected-endpoint row became the second
// consumer this comment always said to expect; that module's own comment
// carries the full reasoning. Re-exported here so this file's existing
// `import { type HarborWithReachability } from './HarborPicker'` callers
// (HarborPicker.test.tsx) keep working unchanged.
export type { HarborWithReachability } from '../lib/harborReachability';

export interface HarborPickerProps {
  harbors: HarborWithReachability[];
  // Harbor ids most-recently-selected (most-recent-first). Ordered ahead of the
  // alphabetical rest in the empty-query state so round-trip harbors are one tap
  // away. Owned by PlannerPanel's useRecentHarbors.
  recentIds: string[];
  onSelect: (harbor: Harbor) => void;
  // Fired when the user dismisses the popup WITHOUT selecting — Esc, or blur
  // without a pick. Lets a caller that reopened the combobox over an already-
  // committed endpoint (the "Ändern" flow) revert to the collapsed row rather
  // than strand an empty search box while the old selection silently persists.
  onCancel?: () => void;
  // #737: focus the search input the instant THIS instance mounts. Scoped to
  // the "Ändern"/"Change" reopen flow specifically, never to every mount —
  // PlannerPanel is the only caller and passes its own `editingOrigin`/
  // `editingDestination` state, which transitions to `true` ONLY inside the
  // Change button's onClick handler (never from a prop diff on `origin`/
  // `destination` themselves), so this reads `true` precisely when, and only
  // when, a real user click just reopened the picker over an already-picked
  // endpoint. On every OTHER mount — cold load, or restoring a saved plan,
  // both of which leave `editingOrigin`/`editingDestination` at their initial
  // `false` since neither is driven by props — the caller passes `false` (or
  // omits it), so no focus is stolen (#695's fix hit exactly this trap on the
  // CLOSING side: a derived boolean that also flips on unrelated prop churn).
  autoFocus?: boolean;
  // #1291/§13 item 2: the SELECTED boat + its live safety-depth setting,
  // used to derive each option's per-boat access marker (§5.2). Optional so
  // existing call sites/tests that don't need access markers need not
  // thread them through — omitting either yields NO per-boat marker (the
  // known-disconnected one is unaffected, it needs neither).
  boat?: BoatDef;
  safetyDepthM?: number;
  // #1291: `computeHarborAccess(mask, harbors, boat, safetyDepthM)`'s result
  // for `harbors`, or null/undefined while the mask or derivation is not yet
  // available. Owned by the caller (PlannerPanel) so the SAME map instance
  // is reused across this picker's sibling instance and the selected-
  // endpoint row (§5.3) — computing it once per (mask, harbors, boat, gate)
  // via `computeHarborAccess`'s own memoisation, never per option render.
  harborAccess?: HarborAccessByHarbor | null;
  mask?: NavMask | null;
}

/**
 * §5.2/§5.3/§13 item 2: the ORDERED marker line(s) for one harbor's access
 * state, ready for `t()`. Precedence: `known-disconnected` wins over every
 * boat-scoped state (harborReachability.ts's own §2 doc comment — it is a
 * per-HARBOUR fact, independent of boat/gate) and needs neither `boat` nor
 * `safetyDepthM`; `ok` and a not-yet-computed (`undefined`) state render
 * NOTHING (never an empty-reads-as-clear false all-clear, but here there is
 * genuinely nothing to disclose). For `unreachable`, `hint` supplies the
 * OPTIONAL second line, keyed by the STATE `findLowerSettingHint` found at
 * its highest reaching decimetre (`hint.hint.state`) — 'ok' vs
 * 'shallow-approach' — never by the harbor's OWN (unreachable) state; that
 * is the #1291 "which key wins when a harbour qualifies for both states"
 * rule.
 *
 * PR #1323 review Major 1: there is NO "below the boat's recommended depth"
 * branch here — `findLowerSettingHint`'s own frozen floor is
 * `defaultSafetyDepthM(boat)` (harborReachability.ts's PR #1316 fix-wave-2
 * comment), so `hint.hint.depthM >= defaultSafetyDepthM(boat)` is a THEOREM
 * given the real API, true for EVERY `'found'` outcome the production
 * caller can ever observe, not a runtime branch. An earlier revision
 * branched on that inequality and, on the (unreachable) false side, keyed
 * by `hint.hint.state` — so the real, reachable branch discarded
 * `hint.hint.state` unconditionally and always rendered the no-caveat
 * copy, even for a `shallow-approach` hint (`harborReachability.test.ts`'s
 * own faldsled fixture: `findLowerSettingHint(...)` →
 * `{kind:'found', hint:{depthM:5, state:'shallow-approach'}}`). Fixed by
 * keying on `hint.hint.state` ALONE — no depth comparison, no "below
 * recommended" clause, since there is nothing to be below.
 *
 * `'not-found'` adds the #1321 line, SCOPED to what
 * `findLowerSettingHint` actually checked: it searches only
 * `[defaultSafetyDepthM(boat), safetyDepthM)`, never the boat's absolute
 * floor (`OptionsPanel.tsx` lets a user dial `safetyDepthM` down to
 * `minSafetyDepthM(boat)` without a boat switch — PR #1323 review Major 2),
 * so the copy states "not reachable at or above the recommended depth" and
 * says NOTHING about settings below it — not even the "any setting it
 * keeps" framing #1321's own issue text first proposed, which read as
 * covering the boat's whole valid range. `'exhausted'` (the search hit its
 * own step budget without finishing) adds nothing rather than a wrong claim
 * either way; this component does not implement the design's idle-slicing
 * resume — an accepted, documented simplification (§9 calls the resume a
 * recommendation, not a requirement for this consumer).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function harborAccessCopy(
  state: HarborAccessState | undefined,
  hint: LowerSettingHintOutcome | null,
  boat: BoatDef | undefined,
  safetyDepthM: number | undefined,
  lang: Lang,
): { key: MsgKey; vars?: Record<string, string | number> }[] {
  if (state === 'known-disconnected') return [{ key: 'harborPicker.knownDisconnected' }];
  if (!boat || safetyDepthM === undefined) return [];
  if (state === 'shallow-approach') {
    return [{ key: 'harborPicker.boatShallow', vars: { boat: boat.name } }];
  }
  if (state === 'unreachable') {
    const lines: { key: MsgKey; vars?: Record<string, string | number> }[] = [
      {
        key: 'harborPicker.boatUnreachable',
        vars: { boat: boat.name, depth: formatDepthM(safetyDepthM, lang) },
      },
    ];
    if (hint?.kind === 'found') {
      const depth = formatDepthM(hint.hint.depthM, lang);
      lines.push(
        hint.hint.state === 'shallow-approach'
          ? { key: 'harborPicker.boatLowerSettingAtDefaultShallow', vars: { depth } }
          : { key: 'harborPicker.boatLowerSettingAtDefault', vars: { depth } },
      );
    } else if (hint?.kind === 'not-found') {
      lines.push({
        key: 'harborPicker.boatUnreachableAtOrAboveDefault',
        vars: { boat: boat.name },
      });
    }
    return lines;
  }
  return [];
}

/** §5.2: the per-option access state, `known-disconnected` derived from
 * either the caller's `harborAccess` map (once computed) or the harbor's own
 * static `knownDisconnected` field as a pre-mask fallback — the two never
 * disagree once `harborAccess` is available, since `computeHarborAccess`
 * reads the same field. */
function accessStateOf(
  harbor: HarborWithReachability,
  harborAccess: HarborAccessByHarbor | null | undefined,
): HarborAccessState | undefined {
  return (
    harborAccess?.get(harbor.id) ??
    (harbor.knownDisconnected === true ? 'known-disconnected' : undefined)
  );
}

// Diacritic-insensitive normalization for harbor-name search. Lowercase
// FIRST: 'Æ'/'Ø' have no NFD decomposition (they aren't accented letters,
// just distinct letters), so the ø/æ replacements below only ever see them
// once toLowerCase() has already folded them to 'æ'/'ø'.
// eslint-disable-next-line react-refresh/only-export-components
export function normalizeHarborSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replaceAll('ø', 'o')
    .replaceAll('æ', 'ae');
}

function matchesQuery(harbor: Harbor, normalizedQuery: string): boolean {
  if (normalizedQuery === '') return true;
  return (
    normalizeHarborSearch(harbor.names.de).includes(normalizedQuery) ||
    normalizeHarborSearch(harbor.names.da).includes(normalizedQuery) ||
    normalizeHarborSearch(harbor.names.en).includes(normalizedQuery)
  );
}

function startsWithQuery(harbor: Harbor, normalizedQuery: string): boolean {
  return (
    normalizeHarborSearch(harbor.names.de).startsWith(normalizedQuery) ||
    normalizeHarborSearch(harbor.names.da).startsWith(normalizedQuery) ||
    normalizeHarborSearch(harbor.names.en).startsWith(normalizedQuery)
  );
}

/**
 * Orders the harbors for the listbox.
 *
 * - Empty query: recently-used first (in `recentIds` order, de-duped, existing
 *   harbors only), then the remaining harbors alphabetically.
 * - Non-empty query: only matches, with exact-prefix matches ahead of
 *   substring-only matches; alphabetical (by normalized display name) is the
 *   final tiebreak within each group, so the result is deterministic — no
 *   locale-dependent collation.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function rankHarbors(
  harbors: Harbor[],
  query: string,
  lang: Lang,
  recentIds: string[],
): Harbor[] {
  const nq = normalizeHarborSearch(query);
  const alpha = (a: Harbor, b: Harbor): number => {
    const na = normalizeHarborSearch(a.names[lang]);
    const nb = normalizeHarborSearch(b.names[lang]);
    return na < nb ? -1 : na > nb ? 1 : 0;
  };

  if (nq === '') {
    const byId = new Map(harbors.map((h) => [h.id, h]));
    const seen = new Set<string>();
    const recent: Harbor[] = [];
    for (const id of recentIds) {
      const h = byId.get(id);
      if (h && !seen.has(id)) {
        recent.push(h);
        seen.add(id);
      }
    }
    const rest = harbors.filter((h) => !seen.has(h.id)).sort(alpha);
    return [...recent, ...rest];
  }

  const matched = harbors.filter((h) => matchesQuery(h, nq));
  const prefix = matched.filter((h) => startsWithQuery(h, nq)).sort(alpha);
  const substring = matched.filter((h) => !startsWithQuery(h, nq)).sort(alpha);
  return [...prefix, ...substring];
}

/**
 * Accessible harbor combobox (WAI-ARIA combobox + listbox pattern). The input
 * carries role="combobox" with aria-expanded / aria-controls / aria-autocomplete
 * and aria-activedescendant pointing at the active option; the popup is a
 * role="listbox" of role="option" rows. ↑/↓ move the active option (wrapping),
 * Enter selects it, Esc closes, blur/select closes. Origin and destination each
 * mount their own instance simultaneously, so every id derives from a per-
 * instance useId() base — no cross-instance collision on the option ids the
 * active-descendant wiring depends on.
 */
export default function HarborPicker({
  harbors,
  recentIds,
  onSelect,
  onCancel,
  autoFocus,
  boat,
  safetyDepthM,
  harborAccess,
  mask,
}: HarborPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [lang] = useLang();
  const t = useT();
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-option-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);

  // #737: mount-only, deliberately not keyed on `autoFocus` in the deps array
  // — this instance is freshly mounted (never reused) every time the caller's
  // ternary flips from the collapsed row to this combobox, so "at mount" and
  // "the caller just opened this" coincide exactly once per open. Re-running
  // on every `autoFocus` identity change would be a no-op here (the prop
  // never flips after mount without a remount), but keeping the effect
  // unambiguously mount-scoped matches the intent in the prop's own doc
  // comment above.
  //
  // useLayoutEffect, not useEffect (PR #754 review Minor): `useEffect` fires
  // AFTER paint, leaving a real first-paint window with nothing focused. This
  // is the SAFE case of the ref-ownership rule (see the `App.tsx`
  // `--sc-panel-w` writer vs. `PanelResizer.tsx`'s sibling-ref measurement
  // effect in CLAUDE.md's code-conventions section): `inputRef` targets
  // HarborPicker's OWN returned `<input>` host fiber, not a sibling or a
  // child component's node, so React's `commitAttachRef` for this component's
  // own fiber runs before this component's own layout effects — the ref is
  // always attached by the time this runs. `PanelResizer.tsx`'s case is the
  // opposite (a SIBLING's ref, ordering-dependent, measured
  // `panelRef.current === null` under `useLayoutEffect`) and stays on
  // `useEffect` for that reason.
  useLayoutEffect(() => {
    if (autoFocus) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only, see comment above
  }, []);

  const results = useMemo(
    () => rankHarbors(harbors, query, lang, recentIds),
    [harbors, query, lang, recentIds],
  );

  // Keep the active option visible: with the aria-activedescendant pattern DOM
  // focus stays on the input, so the browser never auto-scrolls the listbox —
  // past the visible rows (and on the ArrowUp→last wrap) the highlight would sit
  // off-screen. This is a genuine DOM side-effect (not a setState), so an effect
  // is the right tool. `block: 'nearest'` scrolls the minimum needed.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = document.getElementById(`${baseId}-option-${activeIndex}`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, baseId]);

  // Opening (focus) or changing the query resets the active option to the top
  // (best-ranked) match, so Enter takes the first match and the highlight is
  // predictable. Reset happens on those events rather than in an effect (which
  // would cascade renders). aria-activedescendant / Enter are guarded against a
  // stale index if `results` shrinks from an unrelated prop change while open.
  const openList = () => {
    setOpen(true);
    setActiveIndex(0);
  };

  const choose = (harbor: Harbor) => {
    onSelect(harbor);
    setQuery('');
    setOpen(false);
  };

  const move = (delta: number) => {
    if (results.length === 0) return;
    setActiveIndex((i) => {
      if (i < 0) return delta > 0 ? 0 : results.length - 1;
      return (i + delta + results.length) % results.length;
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (open) move(1);
        else setOpen(true);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (open) move(-1);
        else setOpen(true);
        break;
      case 'Enter':
        if (open && activeIndex >= 0 && activeIndex < results.length) {
          e.preventDefault();
          choose(results[activeIndex]);
        }
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          setOpen(false);
          onCancel?.();
        }
        break;
    }
  };

  // Dismiss without a selection (Esc handled above, or focus leaving the input).
  // An option click keeps focus on the input (its onMouseDown preventDefault),
  // and a keyboard/click selection unmounts this combobox, so neither path
  // reaches here — onCancel only fires on a genuine abandon.
  const onBlur = () => {
    setOpen(false);
    onCancel?.();
  };

  const showNoResults = open && query !== '' && results.length === 0;

  return (
    <div className="harbor-picker">
      <label htmlFor={inputId}>{t('harborPicker.searchLabel')}</label>
      <input
        ref={inputRef}
        id={inputId}
        className="harbor-picker-input"
        type="text"
        role="combobox"
        // Reflects whether the popup element actually exists — the listbox is
        // not rendered in the no-results state, so expanded must be false there.
        aria-expanded={open && results.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && activeIndex >= 0 && activeIndex < results.length
            ? optionId(activeIndex)
            : undefined
        }
        placeholder={t('harborPicker.searchPlaceholder')}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          openList();
        }}
        onFocus={openList}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      {open && results.length > 0 && (
        <ul
          className="harbor-picker-listbox"
          role="listbox"
          id={listboxId}
          aria-label={t('harborPicker.resultsLabel')}
        >
          {results.map((h, i) => {
            const caveat = h.approachNote?.[lang];
            // #652/#1291: disclosed BEFORE a solve — the whole point of the
            // original #652 issue is that today a user only learns this
            // after spending a full solve plus the #53 depth-relaxation
            // probe search on a harbor that cannot route at ANY
            // safety-depth setting. `accessStateOf` extends that to the
            // per-boat states (§5.2) once `harborAccess` is available, and
            // otherwise falls back to `h.knownDisconnected` alone — the one
            // state that needs no mask to be already known.
            const access = accessStateOf(h, harborAccess);
            const hint =
              access === 'unreachable' && mask && boat && safetyDepthM !== undefined
                ? findLowerSettingHint(mask, h, boat, safetyDepthM)
                : null;
            const accessLines = harborAccessCopy(access, hint, boat, safetyDepthM, lang);
            return (
              <li
                key={h.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                className="harbor-picker-option"
                // Keep focus on the input so the input's onBlur doesn't close the
                // popup before the click lands; the click then selects.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(h)}
              >
                <span className="harbor-picker-name">{h.names[lang]}</span>
                {accessLines.map((line) => (
                  <span key={line.key} className="harbor-picker-unreachable">
                    {t(line.key, line.vars)}
                  </span>
                ))}
                {caveat && <span className="harbor-picker-caveat">{caveat}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {showNoResults && <p className="harbor-picker-empty">{t('harborPicker.noResults')}</p>}
    </div>
  );
}
