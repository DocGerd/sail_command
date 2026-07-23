import type { Lang } from '../i18n';

// #107: UAT-badge-only strings. Deliberately NOT in the main i18n dicts
// (src/i18n/dict.de.ts / dict.en.ts): keys added there would ship in the
// PRODUCTION bundle and break its byte-identity guarantee (#96). This module
// is imported only from UatBadge.tsx, whose sole import site (App.tsx) is
// gated on the build-time `__SC_UAT__` define — so production tree-shakes
// component and dict away entirely, while the de/en `satisfies` parity
// convention still holds locally.
type UatMsgKey = 'uat.explain';

const de = {
  'uat.explain':
    'Testumgebung (UAT) – nicht die Produktivversion. Produktion: https://docgerd.github.io/sail_command/',
} satisfies Record<UatMsgKey, string>;

const en = {
  'uat.explain':
    'Test environment (UAT) – not the production version. Production: https://docgerd.github.io/sail_command/',
} satisfies Record<UatMsgKey, string>;

export const uatDict: Record<Lang, Record<UatMsgKey, string>> = { de, en };
