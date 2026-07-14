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

const renderProbe = () =>
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>,
  );

afterEach(() => {
  localStorage.clear();
});

it('translates, interpolates and defaults to German when no language is stored', () => {
  renderProbe();
  expect(screen.getByTestId('msg')).toHaveTextContent('SailCommand');
  expect(screen.getByTestId('vars')).toHaveTextContent('Ankunft 14:30');
});

it('restores a persisted English preference on mount', () => {
  localStorage.setItem('sc-lang', 'en');
  renderProbe();
  expect(screen.getByTestId('vars')).toHaveTextContent('Arrival 14:30');
});

it('toggle switches the rendered language and persists it', () => {
  localStorage.setItem('sc-lang', 'de');
  renderProbe();
  expect(screen.getByTestId('vars')).toHaveTextContent('Ankunft 14:30');
  fireEvent.click(screen.getByText('toggle'));
  expect(screen.getByTestId('vars')).toHaveTextContent('Arrival 14:30');
  expect(localStorage.getItem('sc-lang')).toBe('en');
});
