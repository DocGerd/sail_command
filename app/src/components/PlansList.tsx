import { useCallback, useEffect, useState } from 'react';
import { deletePlan, getPlan, listPlans, type PlanSummary } from '../services/db';
import { useActivePlan } from '../state/AppState';
import { useT, useLang } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import { formatDateTime } from '../lib/format';
import type { Rig } from '../types';

const RIG_LABEL_KEY: Record<Rig, MsgKey> = {
  genoa: 'route.rig.genoa',
  fock: 'route.rig.fock',
};

export default function PlansList() {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  // Only one row's delete can be pending confirmation at a time. Chosen
  // semantics for "reset if the user taps elsewhere" (spec's phrasing):
  // tapping a *different* row's delete button moves the pending confirm to
  // that row instead of deleting the original, and tapping a row itself (to
  // load it) clears any pending confirm outright — both read as "elsewhere"
  // relative to the row that was awaiting its second tap.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // Shared by handleLoad/handleDeleteTap — both are simple "did the async
  // call fail" surfaces, so one inline line covers either without needing a
  // per-action variant of the same message.
  const [error, setError] = useState<MsgKey | null>(null);
  const { setPlan } = useActivePlan();
  const t = useT();
  const [lang] = useLang();

  const refresh = useCallback(() => {
    void listPlans().then(setPlans).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleLoad = useCallback(
    (id: string) => {
      setPendingDeleteId(null);
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
    [setPlan, refresh],
  );

  const handleDeleteTap = useCallback(
    (id: string) => {
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
    [pendingDeleteId, refresh],
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
              <span className="plans-list-eta">
                {t('route.totals.eta')} {formatDateTime(p.etaMs, lang)}
              </span>
              <span className="chip chip-rig">{t(RIG_LABEL_KEY[p.recommended])}</span>
            </button>
            <button
              type="button"
              className="plans-list-delete"
              onClick={() => handleDeleteTap(p.id)}
              aria-label={pendingDeleteId === p.id ? t('plansList.confirmDelete') : t('plansList.delete')}
            >
              {pendingDeleteId === p.id ? '✓' : '🗑'}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
