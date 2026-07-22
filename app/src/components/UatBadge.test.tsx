import { render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import UatBadge from './UatBadge';

// #107. The real gate in App.tsx is the build-time define — the fold-exact
// `__SC_UAT__ ? … : t('app.title')` ternary in the h1 title slot — fixed per
// build, so this file exercises the rendered badge itself plus a pin of the
// define's vitest value. The ABSENCE state goes through the real import-site
// gate in App.test.tsx's shell test (with `__SC_UAT__` false there, no UAT
// chip renders), not through a mirror here — a test-local copy of the gate
// expression would drift silently from App.tsx's actual shape.
const renderBadge = () =>
  render(
    <I18nProvider>
      <UatBadge />
    </I18nProvider>,
  );

afterEach(() => {
  localStorage.clear();
});

describe('UatBadge (#107)', () => {
  it('__SC_UAT__ is a defined build-time constant and false outside a UAT build (vitest inherits the vite define)', () => {
    // Pins BOTH that the define reaches vitest at all (an undefined constant
    // would throw ReferenceError here) and its non-UAT value: SC_DEPLOY_ENV
    // is unset for unit tests, exactly like a production build.
    expect(__SC_UAT__).toBe(false);
  });

  it('renders a .chip pill labeled with the invariant environment code "UAT"', () => {
    renderBadge();
    const chip = screen.getByText('UAT');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).toHaveClass('chip', 'uat-badge');
  });

  it('carries the German explanation (default language) as title text, pointing at the production URL', () => {
    renderBadge();
    expect(screen.getByText('UAT')).toHaveAttribute(
      'title',
      'Testumgebung (UAT) – nicht die Produktivversion. Produktion: https://docgerd.github.io/sail_command/',
    );
  });

  it('carries the English explanation when the persisted language is en', () => {
    localStorage.setItem('sc-lang', 'en');
    renderBadge();
    expect(screen.getByText('UAT')).toHaveAttribute(
      'title',
      'Test environment (UAT) – not the production version. Production: https://docgerd.github.io/sail_command/',
    );
  });
});
