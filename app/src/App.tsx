import { useT } from './i18n';

export default function App() {
  const t = useT();
  return (
    <main>
      <h1>{t('app.title')}</h1>
    </main>
  );
}
