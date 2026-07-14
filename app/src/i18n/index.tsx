import { createContext, useContext, useState, type ReactNode } from 'react';
import { de, type MsgKey } from './dict.de';
import { en } from './dict.en';

export type Lang = 'de' | 'en';
const dicts: Record<Lang, Record<MsgKey, string>> = { de, en };

const LangCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({
  lang: 'de',
  setLang: () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() =>
    localStorage.getItem('sc-lang') === 'en' ? 'en' : 'de',
  );
  const setLang = (l: Lang) => {
    localStorage.setItem('sc-lang', l);
    setLangState(l);
  };
  return <LangCtx.Provider value={{ lang, setLang }}>{children}</LangCtx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLang(): [Lang, (l: Lang) => void] {
  const { lang, setLang } = useContext(LangCtx);
  return [lang, setLang];
}

// eslint-disable-next-line react-refresh/only-export-components
export function useT() {
  const { lang } = useContext(LangCtx);
  return (key: MsgKey, vars?: Record<string, string | number>): string => {
    let msg: string = dicts[lang][key];
    for (const [k, v] of Object.entries(vars ?? {})) msg = msg.replaceAll(`{${k}}`, String(v));
    return msg;
  };
}
