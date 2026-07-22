import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import UatBadge from './UatBadge';

// #107. The real gate in App.tsx is the build-time define (`__SC_UAT__ &&
// <UatBadge />`), fixed per build — so both states are exercised here via a
// literal mirror of that gate expression with an ordinary flag, plus a pin
// of the define's vitest value itself (App.test.tsx's shell test covers the
// real import site: with `__SC_UAT__` false there, no UAT chip renders).
function Gated({ uat }: { uat: boolean }) {
  return <I18nProvider>{uat && <UatBadge />}</I18nProvider>;
}

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
    render(<Gated uat={true} />);
    const chip = screen.getByText('UAT');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).toHaveClass('chip', 'uat-badge');
  });

  it('carries the German explanation (default language) as title text, pointing at the production URL', () => {
    render(<Gated uat={true} />);
    expect(screen.getByText('UAT')).toHaveAttribute(
      'title',
      'Testumgebung (UAT) – nicht die Produktivversion. Produktion: https://docgerd.github.io/sail_command/',
    );
  });

  it('carries the English explanation when the persisted language is en', () => {
    localStorage.setItem('sc-lang', 'en');
    render(<Gated uat={true} />);
    expect(screen.getByText('UAT')).toHaveAttribute(
      'title',
      'Test environment (UAT) – not the production version. Production: https://docgerd.github.io/sail_command/',
    );
  });

  it('the import-site gate shape renders the badge only when the flag is true', () => {
    render(<Gated uat={false} />);
    expect(screen.queryByText('UAT')).toBeNull();
    cleanup();
    render(<Gated uat={true} />);
    expect(screen.getByText('UAT')).toBeInTheDocument();
  });
});
