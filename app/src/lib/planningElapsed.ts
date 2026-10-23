import { PLAN_BUDGET_MS } from '../routing/workerClient';

/**
 * Soft notice threshold: half `PLAN_BUDGET_MS`, measured from run start
 * (wind fetch and start-up included). The worker's budget starts later, at
 * its plan handler, so the notice shows before half that budget is used.
 */
export const LONG_RUNNING_NOTICE_MS = PLAN_BUDGET_MS / 2;

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
