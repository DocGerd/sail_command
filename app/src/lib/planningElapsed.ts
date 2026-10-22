import { PLAN_BUDGET_MS } from '../routing/workerClient';

/** Soft notice threshold: half the worker's plan budget. */
export const LONG_RUNNING_NOTICE_MS = PLAN_BUDGET_MS / 2;

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
