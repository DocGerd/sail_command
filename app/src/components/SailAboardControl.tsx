import { useId } from 'react';
import Button from './Button';
import { useT } from '../i18n';
import { sailLabelKey } from '../lib/resultSummary';
import type { SailId } from '../data/boats';

export interface SailAboardControlProps {
  /** Every headsail the boat's catalogue lists, in catalogue order. */
  catalogueIds: readonly SailId[];
  /** The headsails aboard now; never empty. */
  aboard: readonly SailId[];
  onChange: (ids: readonly SailId[]) => void;
}

/**
 * #1661 (multi-boat spec R.7): which headsails are aboard. "Both" or exactly
 * one sail, so the pressed state is a single choice as in `SegmentModeControl`.
 * Choosing what is already chosen reports nothing, which is also what keeps the
 * set from ever becoming empty. Nothing renders for a single-headsail boat.
 */
export default function SailAboardControl({
  catalogueIds,
  aboard,
  onChange,
}: SailAboardControlProps) {
  const t = useT();
  const labelId = useId();
  const hintId = useId();
  if (catalogueIds.length < 2) return null;
  const all = aboard.length === catalogueIds.length;
  const options: { key: string; label: string; ids: readonly SailId[]; pressed: boolean }[] = [
    { key: 'all', label: t('boat.sailsAboard.both'), ids: catalogueIds, pressed: all },
    ...catalogueIds.map((id) => ({
      key: id,
      label: t(sailLabelKey(id)),
      ids: [id],
      pressed: !all && aboard.length === 1 && aboard[0] === id,
    })),
  ];
  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={hintId} className="sc-field">
      <span id={labelId}>{t('boat.sailsAboard.group')}</span>
      <div className="planner-segment-mode-options">
        {options.map((o) => (
          <Button
            key={o.key}
            variant={o.pressed ? 'secondary' : 'ghost'}
            aria-pressed={o.pressed}
            onClick={() => {
              if (!o.pressed) onChange(o.ids);
            }}
          >
            {o.label}
          </Button>
        ))}
      </div>
      <p className="sc-field-help" id={hintId}>
        {t('boat.sailsAboard.hint')}
      </p>
    </div>
  );
}
