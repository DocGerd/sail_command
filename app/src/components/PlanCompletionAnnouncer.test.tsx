// #983 TZ pin: this file hand-derives expected wall-clock strings (e.g.
// "15/07/2026, 15:00") for a fixed UTC instant, so the assertion is only
// deterministic if formatDateTime's ambient Date/Intl timezone is fixed to
// Europe/Berlin regardless of the host/CI machine's own TZ — CI runs UTC,
// a dev sandbox runs CEST (UTC+2), and the two disagree by exactly that
// offset (reproduced: `TZ=UTC npm --prefix app run test -- PlanCompletionAnnouncer`
// failed by exactly 2h before this pin was added). Same convention as
// `app/src/lib/format.test.ts`, which documents why any top-level position
// in this file is safe (module evaluation completes before any `it()` body
// runs) and why the pin must never move inside a test body.
// @ts-expect-error process is not typed in browser context
process.env.TZ = 'Europe/Berlin';

import { StrictMode } from 'react';
import { render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import type { RigResult } from '../types';
import PlanCompletionAnnouncer from './PlanCompletionAnnouncer';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);

function makeResult(over: Partial<RigResult> = {}): RigResult {
  return {
    sailId: 'genoa',
    legs: [],
    etaMs: DEPARTURE_MS + 5 * 3_600_000,
    durationMs: 5 * 3_600_000,
    distanceNm: 21.5,
    maneuverCount: 2,
    motorDistanceNm: 0,
    ...over,
  };
}

function status(): HTMLElement {
  const el = document.querySelector('.plan-completion-announce');
  if (!el) throw new Error('expected .plan-completion-announce to exist');
  return el as HTMLElement;
}

function renderAnnouncer(result: RigResult | null, resultKey: string | null) {
  return render(
    <I18nProvider>
      <PlanCompletionAnnouncer result={result} resultKey={resultKey} />
    </I18nProvider>,
  );
}

describe('PlanCompletionAnnouncer (#983)', () => {
  it('renders an always-mounted, empty sr-only role="status" region before any result', () => {
    renderAnnouncer(null, null);
    const el = status();
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('role', 'status');
    expect(el).toHaveAttribute('aria-atomic', 'true');
    expect(el).toHaveTextContent('');
  });

  it('announces the ETA/duration/distance sentence once a result+key arrive', () => {
    localStorage.setItem('sc-lang', 'en');
    renderAnnouncer(makeResult(), 'plan-1-1000');
    // en-GB DD/MM/YYYY, HH:MM (format.test.ts's pinned convention);
    // 5*3_600_000 ms = 5 h 00 min; 21.5 formats as "21.5 nm".
    expect(status()).toHaveTextContent(
      'Route calculated — arrival 15/07/2026, 15:00, duration 5 h 00 min, 21.5 nm.',
    );
  });

  // #983 TRANSITION test: a same-key re-render carrying DIFFERENT result
  // content (as a same-id/same-createdAtMs re-render could in principle
  // produce) must NOT re-announce — the announced text stays frozen at the
  // FIRST result for that key. This is the component's own defensive dedup
  // (App.tsx's `announceCompletion` already only ever calls this with a
  // genuinely new key per completion, so this is a backstop, not the
  // primary correctness mechanism — see PlanCompletionAnnouncer.tsx's own
  // header).
  it('does NOT re-announce when the SAME resultKey re-renders with different result content', () => {
    localStorage.setItem('sc-lang', 'en');
    const { rerender } = renderAnnouncer(makeResult({ distanceNm: 21.5 }), 'plan-1-1000');
    expect(status()).toHaveTextContent('21.5 nm');

    rerender(
      <I18nProvider>
        <PlanCompletionAnnouncer result={makeResult({ distanceNm: 30 })} resultKey="plan-1-1000" />
      </I18nProvider>,
    );
    expect(status()).toHaveTextContent('21.5 nm');
    expect(status()).not.toHaveTextContent('30.0 nm');
  });

  // #983 TRANSITION test, the SAME-id/DIFFERENT-createdAtMs shape this
  // repo's #961/#747 composite-identity idiom exists for (recalculate-and-
  // replace, #937 confirm-solve): a NEW resultKey must re-announce even
  // though a naive `plan.id`-only gate would have missed it.
  it('DOES re-announce when resultKey changes (a recalculate-and-replace under an unchanged plan.id)', () => {
    localStorage.setItem('sc-lang', 'en');
    const { rerender } = renderAnnouncer(makeResult({ distanceNm: 21.5 }), 'plan-1-1000');
    expect(status()).toHaveTextContent('21.5 nm');

    rerender(
      <I18nProvider>
        <PlanCompletionAnnouncer result={makeResult({ distanceNm: 30 })} resultKey="plan-1-1001" />
      </I18nProvider>,
    );
    expect(status()).toHaveTextContent('30.0 nm');
  });

  it('#983: renders and announces correctly under <StrictMode> (double-effect-invocation safe)', () => {
    localStorage.setItem('sc-lang', 'en');
    render(
      <StrictMode>
        <I18nProvider>
          <PlanCompletionAnnouncer result={makeResult()} resultKey="plan-1-1000" />
        </I18nProvider>
      </StrictMode>,
    );
    // A StrictMode double-invoke of the announcement effect must still land
    // on exactly one, correct sentence — not an empty region (the effect
    // never ran) and not a duplicated/garbled one.
    expect(status()).toHaveTextContent(
      'Route calculated — arrival 15/07/2026, 15:00, duration 5 h 00 min, 21.5 nm.',
    );
  });
});
