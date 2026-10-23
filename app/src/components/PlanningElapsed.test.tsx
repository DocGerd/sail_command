import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { PLAN_BUDGET_MS } from '../routing/workerClient';
import { LONG_RUNNING_NOTICE_MS, formatElapsed } from '../lib/planningElapsed';
import PlanningElapsed from './PlanningElapsed';

const START = Date.UTC(2026, 9, 22, 10, 0, 0);

function renderElapsed() {
  localStorage.setItem('sc-lang', 'en');
  return render(
    <I18nProvider>
      <PlanningElapsed startedAtMs={START} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

describe('formatElapsed', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [1000, '0:01'],
    [68_000, '1:08'],
    [600_000, '10:00'],
    [-5000, '0:00'],
  ])('%i ms -> %s', (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

describe('PlanningElapsed (#1775)', () => {
  it('ticks once a second from startedAtMs', () => {
    renderElapsed();
    expect(screen.getByText('Elapsed: 0:00')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(68_000);
    });
    expect(screen.getByText('Elapsed: 1:08')).toBeInTheDocument();
  });

  it('is not a live region, so the ticking is never announced', () => {
    const { container } = renderElapsed();
    expect(container.querySelector('[role="status"], [aria-live], [role="alert"]')).toBeNull();
  });

  it('shows the long-running notice only from half the plan budget', () => {
    expect(LONG_RUNNING_NOTICE_MS).toBe(PLAN_BUDGET_MS / 2);
    renderElapsed();
    act(() => {
      vi.advanceTimersByTime(LONG_RUNNING_NOTICE_MS - 1000);
    });
    expect(screen.queryByText(/taking a while/)).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/taking a while/)).toBeInTheDocument();
  });

  it('stops its interval on unmount', () => {
    const { unmount } = renderElapsed();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
