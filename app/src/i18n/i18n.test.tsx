import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider, useT, useLang } from './index';

function Probe() {
  const t = useT();
  const [lang, setLang] = useLang();
  return (
    <div>
      <span data-testid="msg">{t('app.title')}</span>
      <span data-testid="vars">{t('plan.eta', { time: '14:30' })}</span>
      <button onClick={() => setLang(lang === 'de' ? 'en' : 'de')}>toggle</button>
    </div>
  );
}

it('translates, interpolates and toggles language with persistence', () => {
  localStorage.setItem('sc-lang', 'de');
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>,
  );
  expect(screen.getByTestId('msg')).toHaveTextContent('SailCommand');
  expect(screen.getByTestId('vars').textContent).toContain('14:30');
  fireEvent.click(screen.getByText('toggle'));
  expect(localStorage.getItem('sc-lang')).toBe('en');
});
