import { useEffect, useRef, useState } from 'react';
import { getPlan } from '../services/db';
import { readSessionSnapshot, writeSessionSnapshot, type Tab } from '../lib/sessionSnapshot';
import { useActivePlan } from './AppState';

/**
 * #113 session restore. Owns both halves of the UI-session snapshot:
 *
 * - Boot restore (once per app boot): reads the snapshot and replays
 *   PlansList's exact load path — getPlan(id) → setPlan(plan) — so a restored
 *   plan renders against its STORED wind grid, zero network (a silent
 *   forecast refresh is explicitly #114's scope, not this hook's; the
 *   existing stale-forecast banner covers an aged restored plan unchanged).
 *   The rig choice is re-applied after setPlan (which resets it to the
 *   recommended rig), then the tab. Restoring into the Live tab only mounts
 *   LiveView, which starts with tracking OFF — GPS starts only via its
 *   explicit toggle.
 * - Write-back: one effect keyed on (plan id, tab, rig) — it runs exactly
 *   once per actual change of those values (plan set/cleared, tab change, rig
 *   change; all rare user events), never polls, and writing localStorage
 *   changes no React state, so it cannot loop. Gated on `restored`, which
 *   settles strictly asynchronously (the promise chain below — never a sync
 *   setState in the effect), so the pre-restore initial state (no plan, Plan
 *   tab) can never clobber the very snapshot being restored.
 *
 * Fallbacks (every path settles `restored` — the session never gets stuck
 * un-writable, the app never stuck loading): missing/corrupt snapshot →
 * fresh boot; plan id no longer in IndexedDB → full fresh boot (per #113's
 * AC the tab is NOT restored either — the snapshot described a session
 * around a plan that no longer exists), after which the write-back effect
 * immediately self-heals the stale snapshot; getPlan rejection → logged
 * fresh boot; storage denied (private mode) → readSessionSnapshot returns
 * null and writes are best-effort no-ops, i.e. session-only behavior.
 */
export function useSessionRestore(tab: Tab, setTab: (t: Tab) => void): void {
  const { plan, rig, setPlan, setRig } = useActivePlan();
  const [restored, setRestored] = useState(false);
  const startedRef = useRef(false);

  // Mirrors the active plan id for the async restore below to check at
  // resolve time (same pattern as App.tsx's planIdRef clobber guard): if the
  // user managed to activate a plan while getPlan was in flight, the restore
  // must not yank it (or their tab) away.
  const planIdRef = useRef<string | null>(plan?.id ?? null);
  useEffect(() => {
    planIdRef.current = plan?.id ?? null;
  }, [plan?.id]);

  useEffect(() => {
    // Once per boot — a ref, not state: StrictMode re-runs effects on the
    // same instance and refs survive that, so the IndexedDB read (and the
    // state application) never double-fires.
    if (startedRef.current) return;
    startedRef.current = true;

    const restore = async (): Promise<void> => {
      const snapshot = readSessionSnapshot();
      if (snapshot === null) return;
      if (snapshot.planId === null) {
        // No plan was open — the tab alone is still "where the user left off".
        setTab(snapshot.tab);
        return;
      }
      const restoredPlan = await getPlan(snapshot.planId);
      if (restoredPlan && planIdRef.current === null) {
        setPlan(restoredPlan);
        // setPlan just reset the rig to the plan's recommended one; a
        // persisted non-null rig is the user's explicit comparison choice.
        // Applied verbatim: a rig whose result is null is a state the
        // RouteSummary rig tabs let a user select anyway (it shows the
        // no-route reason).
        if (snapshot.rig !== null) setRig(snapshot.rig);
        setTab(snapshot.tab);
      }
      // else: plan deleted since (or the user beat the restore to it) —
      // silent fresh start, today's boot behavior.
    };

    void restore()
      .catch((err) => {
        console.error('session restore failed', err);
      })
      .finally(() => {
        setRestored(true);
      });
  }, [setPlan, setRig, setTab]);

  useEffect(() => {
    if (!restored) return;
    writeSessionSnapshot({ v: 1, planId: plan?.id ?? null, tab, rig });
  }, [restored, plan?.id, tab, rig]);
}
