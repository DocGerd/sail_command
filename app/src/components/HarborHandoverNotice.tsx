import { useLang, useT } from '../i18n';
import { formatDepthM } from '../lib/depthDisclosure';
import { formatNm } from '../lib/format';
import { HARBOR_HANDOVER_NOTICE_CLASS, harborHandoverLines } from '../lib/harborHandover';
import { requestedGateM } from '../lib/shallowExposure';
import type { Plan } from '../types';

/**
 * #1721: states, for a plan routed from/to a handover point, that the striped
 * harbour approach on the map is not computed. A plain always-visible `<div>`:
 * a labelled `<section>` would collide with the `region` locators, and nothing
 * here is an alert (the plan is valid, the approach is disclosed).
 */
export function HarborHandoverNotice({ plan }: { plan: Plan }) {
  const t = useT();
  const [lang] = useLang();
  const lines = harborHandoverLines(plan);
  if (lines.length === 0) return null;
  const depth = formatDepthM(requestedGateM(plan), lang);
  return (
    <div className={HARBOR_HANDOVER_NOTICE_CLASS}>
      <p className="harbor-handover-notice__title">{t('route.handover.title')}</p>
      {lines.map((l) => (
        <p key={l.end}>
          {t(l.end === 'origin' ? 'route.handover.origin' : 'route.handover.destination', {
            boat: plan.request.boat.name,
            depth,
            dist: formatNm(l.distNm, lang),
          })}
        </p>
      ))}
      <p>{t('route.handover.body')}</p>
    </div>
  );
}
