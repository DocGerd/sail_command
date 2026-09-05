import { useCallback, useEffect, useState } from 'react';
import { deletePlan, getPlan, listPlans, type PlanSummary } from '../services/db';
import { useActivePlan } from '../state/AppState';
import { useT, useLang } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import { formatDateTime, formatDuration, formatNm, toLocalInputValue } from '../lib/format';
import { FORECAST_DAYS } from '../services/openMeteo';
import { nextFullHourMs } from './PlannerPanel';
import Button from './Button';
import Field from './Field';
import type { Plan } from '../types';
import { activeRigResult } from '../lib/plan';
import { sailLabelKey } from '../lib/resultSummary';

// #114: the two ways a completed recalculation can be persisted — as a NEW
// plan (default, non-destructive) or REPLACING the original (explicit
// two-tap confirm only).
export type RecalcMode = 'new' | 'replace';

export interface PlansListProps {
  // Mirrors usePlanFlow.run()'s own navigator.onLine gate (which stays the
  // authoritative check): a recalculation fetches a FRESH forecast, so its
  // actions are disabled offline with honest messaging. Loading/deleting
  // saved plans (and via-replans) stay offline-capable and are NOT gated.
  online: boolean;
  // True while a planning run or via-replan is already in flight — recalc
  // actions are disabled so a second run can't be queued (mirrors canPlan).
  busy: boolean;
  // Runs the full fresh planning flow (fresh Open-Meteo fetch, both rigs)
  // seeded from `plan` with the edited departure. Resolves when the run
  // settles — errors surface through usePlanFlow's own phase/banner, so this
  // never rejects on a failed RUN (only on infrastructure failure).
  onRecalculate: (plan: Plan, departureMs: number, mode: RecalcMode) => Promise<void>;
}

// #114: per-row recalculate editor state — which row is open, the editable
// departure, and the datetime-local min/max guardrails (same soft bounds as
// PlannerPanel's departure input: now .. now + forecast horizon), captured
// when the editor opens.
interface RecalcDraft {
  planId: string;
  departureMs: number;
  minMs: number;
  maxMs: number;
}

export default function PlansList({ online, busy, onRecalculate }: PlansListProps) {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  // Only one row's delete can be pending confirmation at a time. Chosen
  // semantics for "reset if the user taps elsewhere" (spec's phrasing):
  // tapping a *different* row's delete button moves the pending confirm to
  // that row instead of deleting the original, and tapping a row itself (to
  // load it) clears any pending confirm outright — both read as "elsewhere"
  // relative to the row that was awaiting its second tap.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // Shared by handleLoad/handleDeleteTap/handleRecalcRun — all are simple
  // "did the async call fail" surfaces, so one inline line covers each
  // without needing a per-action variant of the same message.
  const [error, setError] = useState<MsgKey | null>(null);
  // #114: at most one recalc editor open at a time (mirrors pendingDeleteId's
  // one-pending-row rule); null = closed.
  const [recalc, setRecalc] = useState<RecalcDraft | null>(null);
  // #114: the destructive "replace original" needs its own second tap —
  // scoped to the open editor, reset whenever the editor moves/closes.
  const [pendingReplace, setPendingReplace] = useState(false);
  const { setPlan } = useActivePlan();
  const t = useT();
  const [lang] = useLang();

  const refresh = useCallback(() => {
    void listPlans().then(setPlans).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const closeRecalc = useCallback(() => {
    setRecalc(null);
    setPendingReplace(false);
  }, []);

  const handleLoad = useCallback(
    (id: string) => {
      setPendingDeleteId(null);
      closeRecalc();
      setError(null);
      void getPlan(id)
        .then((plan) => {
          // Renders against the plan's STORED wind grid — getPlan/setPlan only,
          // never a re-fetch; refresh() below re-syncs the summary list (e.g.
          // its createdAt ordering) but never touches windGrid.
          if (plan) setPlan(plan);
          refresh();
        })
        .catch((err) => {
          console.error(err);
          setError('plansList.actionError');
        });
    },
    [setPlan, refresh, closeRecalc],
  );

  const handleDeleteTap = useCallback(
    (id: string) => {
      // Arming a delete counts as tapping "elsewhere" for an open recalc
      // editor (and vice versa — see handleRecalcTap).
      closeRecalc();
      if (pendingDeleteId !== id) {
        setPendingDeleteId(id);
        return;
      }
      setError(null);
      // pendingDeleteId is cleared only once deletePlan settles (below), not
      // synchronously here — clearing it up front would let a second tap on
      // the same row re-arm the confirm state (and re-issue a second delete)
      // while the first one is still in flight.
      void deletePlan(id)
        .then(() => {
          setPendingDeleteId(null);
          refresh();
        })
        .catch((err) => {
          console.error(err);
          setPendingDeleteId(null);
          setError('plansList.actionError');
        });
    },
    [pendingDeleteId, refresh, closeRecalc],
  );

  // #114: toggles the row's recalc editor. The departure seed keeps the
  // plan's stored departure while it is still in the future; a plan whose
  // departure has passed gets the planner's own default (next full hour) —
  // recalculating for a past departure would only yield 'beyond-horizon'
  // against the fresh grid.
  const handleRecalcTap = useCallback(
    (p: Extract<PlanSummary, { kind: 'ok' }>) => {
      setPendingDeleteId(null);
      setError(null);
      if (recalc?.planId === p.id) {
        closeRecalc();
        return;
      }
      const nowMs = Date.now();
      setPendingReplace(false);
      setRecalc({
        planId: p.id,
        departureMs: p.departureMs > nowMs ? p.departureMs : nextFullHourMs(nowMs),
        minMs: nowMs,
        maxMs: nowMs + FORECAST_DAYS * 86_400_000,
      });
    },
    [recalc, closeRecalc],
  );

  // #961: PlannerPanel's own `role="status"` result announcement never fires
  // for a recalculate started from HERE. App.tsx renders the Plan and Routes
  // tabs as mutually exclusive branches (`{tab === 'plan' && <PlannerPanel
  // .../>}` vs `{tab === 'routes' && ... <PlansList .../>}`), so
  // PlannerPanel is UNMOUNTED — and its live-region node gone — while this
  // component is the one showing. #961's issue text named PlannerPanel's
  // `plan.id`-only ref gate as the defect, but no re-keying of that gate can
  // reach a path where the component itself is not mounted; this panel
  // needs its OWN announcement instead. One role="status" surface here,
  // sr-only (no in-flight phase text to show visibly, unlike PlannerPanel's),
  // text swapped rather than a second region added.
  const [recalcAnnouncement, setRecalcAnnouncement] = useState('');

  const handleRecalcRun = useCallback(
    (mode: RecalcMode) => {
      if (!recalc) return;
      // Replace is destructive: the first tap only arms the confirm state
      // (mirrors the two-tap delete); the run starts on the second tap.
      if (mode === 'replace' && !pendingReplace) {
        setPendingReplace(true);
        return;
      }
      const { planId, departureMs } = recalc;
      setError(null);
      // Snapshot the ids already on record BEFORE the run — what makes a
      // 'new'-mode success identifiable afterwards (a fresh id with no
      // earlier entry). `onRecalculate`'s own promise resolves on BOTH
      // success and a run-level failure (errors surface through
      // usePlanFlow's own phase/banner instead, per this file's own #114
      // comment below), so the promise settling is never proof of success.
      const beforeIds = new Set(plans.map((p) => p.id));
      void getPlan(planId)
        .then((plan) => {
          if (!plan) {
            // Deleted underneath the open editor (another tab, say).
            setError('plansList.actionError');
            closeRecalc();
            return;
          }
          const beforeCreatedAtMs = plan.createdAtMs;
          return onRecalculate(plan, departureMs, mode).then(() => {
            // The run settled (success OR run-level error — run() reports
            // those through its own planning phase/banner): close the editor
            // and re-list, so a new/replaced plan shows up immediately.
            closeRecalc();
            refresh();
            // Re-derive success from PERSISTED state, never from the
            // resolved promise above: usePlanFlow's run() writes the new
            // plan via services/db's savePlan (awaited) and returns early on
            // every failure path before doing so, so a 'replace' plan whose
            // createdAtMs actually moved, or a wholly new id, is proof the
            // run produced a real result — mirrors this repo's own
            // `${plan.id}-${plan.createdAtMs}` composite-identity idiom
            // (CLAUDE.md's #747 Disclosure-keying rule) rather than trusting
            // a plain id.
            void (
              mode === 'replace'
                ? getPlan(planId).then((p) => (p && p.createdAtMs !== beforeCreatedAtMs ? p : null))
                : listPlans().then((rows) => {
                    const fresh = rows.filter(
                      (r): r is Extract<PlanSummary, { kind: 'ok' }> =>
                        r.kind === 'ok' && !beforeIds.has(r.id),
                    );
                    if (fresh.length === 0) return null;
                    fresh.sort((a, b) => b.createdAtMs - a.createdAtMs);
                    return getPlan(fresh[0].id);
                  })
            ).then((result) => {
              if (!result) return;
              const res = activeRigResult(result, result.result.recommended);
              if (!res) return;
              setRecalcAnnouncement(
                t('plansList.recalcAnnounce', {
                  arrival: formatDateTime(res.etaMs, lang),
                  duration: formatDuration(res.durationMs),
                  distance: formatNm(res.distanceNm, lang),
                }),
              );
            });
          });
        })
        .catch((err) => {
          console.error(err);
          setError('plansList.actionError');
        });
    },
    [recalc, pendingReplace, onRecalculate, refresh, closeRecalc, plans, t, lang],
  );

  if (plans.length === 0) {
    return <p className="plans-list-empty">{t('plansList.empty')}</p>;
  }

  return (
    <>
      {/* #703: bare `<p role="alert">` carried no visual treatment at all —
          same shape as RouteSummary's stale-forecast/no-route lines, see
          `.inline-alert`'s app.css comment for why this is a standalone
          class rather than a modifier of an existing muted rule. */}
      {error && (
        <p className="inline-alert" role="alert">
          {t(error)}
        </p>
      )}
      {/* #961: the recalculate-and-replace result announcement — see
          recalcAnnouncement's own comment above handleRecalcRun. sr-only:
          this panel has no visible in-flight status text to swap it with,
          unlike PlannerPanel's own persistent live region. */}
      <p className="sr-only" role="status" aria-atomic="true">
        {recalcAnnouncement}
      </p>
      <ul className="plans-list">
        {plans.map((p) =>
          // #54 spec §I.3: a record the read-time normaliser cannot handle is
          // LISTED, never skipped — skipping made a plan vanish from the list
          // while its bytes survived, which from where the user sits is
          // indistinguishable from deletion. It has no departure, ETA or
          // recommended sail to show and cannot be opened or recalculated, so
          // the row carries only what is readable from any shape plus the
          // delete action — the app never deletes such a record itself, but
          // the user must still be able to.
          //
          // Delete stays available for BOTH reasons, including a record this
          // build is merely too old to read: suppressing it would leave a row
          // the user can never clear if they do not return to the newer
          // build. What the copy contributes is naming which case this is, so
          // the two-tap delete is at least an informed choice. It stops short
          // of promising the record is undamaged, and must keep stopping
          // short: the classification is derived from the stored
          // schemaVersion alone (services/db.ts), which cannot rule out a
          // record that is both newer AND corrupt.
          p.kind === 'unreadable' ? (
            <li key={p.id} className="plans-list-row plans-list-row-unreadable">
              <div className="plans-list-load">
                {p.name !== '' && <span className="plans-list-name">{p.name}</span>}
                {p.createdAtMs !== 0 && (
                  <span className="plans-list-created">
                    {t('plansList.created')} {formatDateTime(p.createdAtMs, lang)}
                  </span>
                )}
                <span className="plans-list-unreadable">
                  {t(
                    p.reason === 'newer-version'
                      ? 'plansList.unreadable.newerVersion'
                      : 'plansList.unreadable.damaged',
                  )}
                </span>
              </div>
              <Button
                variant="ghost"
                className="plans-list-delete"
                onClick={() => handleDeleteTap(p.id)}
                aria-label={
                  pendingDeleteId === p.id ? t('plansList.confirmDelete') : t('plansList.delete')
                }
              >
                {pendingDeleteId === p.id ? '✓' : '🗑'}
              </Button>
            </li>
          ) : (
            <li key={p.id} className="plans-list-row">
              <button type="button" className="plans-list-load" onClick={() => handleLoad(p.id)}>
                <span className="plans-list-name">{p.name}</span>
                <span className="plans-list-created">
                  {t('plansList.created')} {formatDateTime(p.createdAtMs, lang)}
                </span>
                <span className="plans-list-departure">
                  {t('planner.departure.label')} {formatDateTime(p.departureMs, lang)}
                </span>
                <span className="plans-list-eta">
                  {t('route.totals.eta')} {formatDateTime(p.etaMs, lang)}
                </span>
                <span className="chip chip-rig">{t(sailLabelKey(p.recommended))}</span>
              </button>
              <Button
                variant="ghost"
                className="plans-list-recalc-toggle"
                onClick={() => handleRecalcTap(p)}
                aria-label={t('plansList.recalc')}
                aria-expanded={recalc?.planId === p.id}
              >
                ⟳
              </Button>
              <Button
                variant="ghost"
                className="plans-list-delete"
                onClick={() => handleDeleteTap(p.id)}
                aria-label={
                  pendingDeleteId === p.id ? t('plansList.confirmDelete') : t('plansList.delete')
                }
              >
                {pendingDeleteId === p.id ? '✓' : '🗑'}
              </Button>
              {recalc?.planId === p.id && (
                <div className="plans-list-recalc" role="group" aria-label={t('plansList.recalc')}>
                  <Field
                    label={t('planner.departure.label')}
                    htmlFor={`plans-recalc-departure-${p.id}`}
                  >
                    <input
                      id={`plans-recalc-departure-${p.id}`}
                      type="datetime-local"
                      value={toLocalInputValue(recalc.departureMs)}
                      min={toLocalInputValue(recalc.minMs)}
                      max={toLocalInputValue(recalc.maxMs)}
                      onChange={(e) => {
                        // #643: identical hazard to PlannerPanel's departure
                        // input — see that file's onChange for the full,
                        // measured writeup (Chromium 151.0.7922.34 blanks a
                        // nonexistent composite date; react-dom 19.2.8's own
                        // controlled-input restore already rewrites the DOM
                        // back to the last-rendered prop with this line
                        // deleted, confirmed against real Chromium and real
                        // WebKit builds, PR #665). This write is therefore a
                        // measured NO-OP in every engine tested, kept only as
                        // explicit defensive code — it does not close #643.
                        // Mirror the `r ? … : r` null-safety the rest of this
                        // editor already uses, since `recalc` could in
                        // principle have closed between render and this
                        // event.
                        if (!e.target.value) {
                          if (recalc) e.target.value = toLocalInputValue(recalc.departureMs);
                          return;
                        }
                        const ms = new Date(e.target.value).getTime();
                        setRecalc((r) => (r ? { ...r, departureMs: ms } : r));
                      }}
                    />
                  </Field>
                  {!online && (
                    <p className="planner-guidance" role="alert">
                      {t('plansList.recalc.offline')}
                    </p>
                  )}
                  <div className="plans-list-recalc-actions">
                    <Button
                      variant="primary"
                      disabled={!online || busy}
                      onClick={() => handleRecalcRun('new')}
                    >
                      {t('plansList.recalc.saveNew')}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!online || busy}
                      onClick={() => handleRecalcRun('replace')}
                    >
                      {pendingReplace
                        ? t('plansList.recalc.confirmReplace')
                        : t('plansList.recalc.replace')}
                    </Button>
                    <Button variant="ghost" onClick={closeRecalc}>
                      {t('plansList.recalc.cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ),
        )}
      </ul>
    </>
  );
}
