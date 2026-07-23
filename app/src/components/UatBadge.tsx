import Chip from './Chip';
import { useLang } from '../i18n';
import { uatDict } from './UatBadge.dict';

/**
 * #107: persistent environment indicator for the UAT deployment
 * (https://docgerd.github.io/sail_command/uat/). Rendered inside the header
 * h1, so it is visible on every screen — installed PWA and offline included —
 * and never overlaps the map. The visible label "UAT" is an environment CODE,
 * invariant across languages (deliberately not a dict key); the localized
 * explanation rides on the title attribute from the UAT-local dict.
 *
 * Import this ONLY behind the build-time `__SC_UAT__` gate — the fold-exact
 * `__SC_UAT__ ? … : t('app.title')` ternary in App.tsx's h1 title slot (an
 * `&&` child gate leaves a minified `!1` residue; see App.tsx's comment):
 * production builds must tree-shake this module and UatBadge.dict.ts for
 * the prod bundle to stay byte-identical (#96). No dedicated CSS either — the shared `.chip` pill is
 * the entire visual (a UAT-only rule in app.css would change the production
 * stylesheet); `.uat-badge` is an unstyled hook for tests/browser passes.
 */
export default function UatBadge() {
  const [lang] = useLang();
  return (
    <Chip className="uat-badge" title={uatDict[lang]['uat.explain']}>
      UAT
    </Chip>
  );
}
