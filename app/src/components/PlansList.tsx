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
  const { setPlan } = useActivePlan();
  const t = useT();
  const [lang] = useLang();

  const refresh = useCallback(() => {
    void listPlans().then(setPlans);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleLoad = useCallback(
    (id: string) => {
      setPendingDeleteId(null);
      void getPlan(id).then((plan) => {
        // Renders against the plan's STORED wind grid — getPlan/setPlan only,
        // never a re-fetch; refresh() below re-syncs the summary list (e.g.
        // its createdAt ordering) but never touches windGrid.
        if (plan) setPlan(plan);
        refresh();
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
      setPendingDeleteId(null);
      void deletePlan(id).then(refresh);
    },
    [pendingDeleteId, refresh],
  );

  if (plans.length === 0) {
    return <p className="plans-list-empty">{t('plansList.empty')}</p>;
  }

  return (
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
  );
}
