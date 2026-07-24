import { useCallback, useEffect, useState } from 'react';
import { deletePlan, getPlan, listPlans, type PlanSummary } from '../services/db';
import { useActivePlan } from '../state/AppState';
import { useT, useLang } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import { formatDateTime, toLocalInputValue } from '../lib/format';
import { FORECAST_DAYS } from '../services/openMeteo';
import { nextFullHourMs } from './PlannerPanel';
import Button from './Button';
import Field from './Field';
import type { Plan, Rig } from '../types';

const RIG_LABEL_KEY: Record<Rig, MsgKey> = {
  genoa: 'route.rig.genoa',
  fock: 'route.rig.fock',
};

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
    (p: PlanSummary) => {
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
      void getPlan(planId)
        .then((plan) => {
          if (!plan) {
            // Deleted underneath the open editor (another tab, say).
            setError('plansList.actionError');
            closeRecalc();
            return;
          }
          return onRecalculate(plan, departureMs, mode).then(() => {
            // The run settled (success OR run-level error — run() reports
            // those through its own planning phase/banner): close the editor
            // and re-list, so a new/replaced plan shows up immediately.
            closeRecalc();
            refresh();
          });
        })
        .catch((err) => {
          console.error(err);
          setError('plansList.actionError');
        });
    },
    [recalc, pendingReplace, onRecalculate, refresh, closeRecalc],
  );

  if (plans.length === 0) {
    return <p className="plans-list-empty">{t('plansList.empty')}</p>;
  }

  return (
    <>
      {error && <p role="alert">{t(error)}</p>}
      <ul className="plans-list">
        {plans.map((p) => (
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
              <span className="chip chip-rig">{t(RIG_LABEL_KEY[p.recommended])}</span>
            </button>
            <button
              type="button"
              className="plans-list-recalc-toggle"
              onClick={() => handleRecalcTap(p)}
              aria-label={t('plansList.recalc')}
              aria-expanded={recalc?.planId === p.id}
            >
              ⟳
            </button>
            <button
              type="button"
              className="plans-list-delete"
              onClick={() => handleDeleteTap(p.id)}
              aria-label={
                pendingDeleteId === p.id ? t('plansList.confirmDelete') : t('plansList.delete')
              }
            >
              {pendingDeleteId === p.id ? '✓' : '🗑'}
            </button>
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
                      if (!e.target.value) return;
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
        ))}
      </ul>
    </>
  );
}
