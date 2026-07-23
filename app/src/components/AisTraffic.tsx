import { useEffect, useState } from 'react';
import { useMapInstance } from './MapView';
import { useT } from '../i18n';
import { useOnline } from '../state/AppState';
import { useAisTraffic, type AisStatus } from '../state/useAisTraffic';
import AisLayer from './AisLayer';
import Chip from './Chip';
import { padBoundingBox, viewportEscapedBbox, type AisBoundingBox } from '../services/aisStream';
import type { MsgKey } from '../i18n/dict.de';

const AIS_BBOX_PAD = 0.2; // subscribe to the viewport padded 20% each side
const AIS_RESUBSCRIBE_DEBOUNCE_MS = 2000;

const STATUS_KEY: Record<Exclude<AisStatus, 'live'>, MsgKey> = {
  off: 'ais.status.off',
  connecting: 'ais.status.connecting',
  offline: 'ais.status.offline',
  keyError: 'ais.status.keyError',
};

// Pure, unit-tested: the five-state status chip. Kept separate from the
// map/hook wiring so it can be tested without a MapLibre instance.
export function AisStatusChip({ status, targetCount }: { status: AisStatus; targetCount: number }) {
  const t = useT();
  const text =
    status === 'live' ? t('ais.status.live', { count: targetCount }) : t(STATUS_KEY[status]);
  return (
    <div className="ais-status" role="status">
      <Chip className={`ais-status-chip ais-status-${status}`}>{text}</Chip>
    </div>
  );
}

/**
 * #25: the Live-tab AIS overlay controller. Mounted only while tab === 'live'
 * (App), inside MapView's subtree so useMapInstance()/AisLayer see the map.
 * Owns the viewport→bbox subscription (debounced moveend, padded, re-sent only
 * when the view leaves the padded box) and the online/visibility gates, then
 * delegates the socket lifecycle to useAisTraffic. Renders the vessel layers
 * (AisLayer) plus a status-chip overlay on the map.
 */
export default function AisTraffic({
  apiKey,
  ownMmsi,
}: {
  apiKey: string | undefined;
  ownMmsi: string | undefined;
}) {
  const map = useMapInstance();
  const online = useOnline();
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [bbox, setBbox] = useState<AisBoundingBox | null>(null);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Track the viewport, debounced. Re-pad (and thus re-subscribe) only when the
  // current view escapes the padded box we last subscribed to — a small pan
  // inside the pad margin sends nothing.
  useEffect(() => {
    if (!map) return;
    const update = () => {
      const b = map.getBounds();
      const sw = { lat: b.getSouth(), lon: b.getWest() };
      const ne = { lat: b.getNorth(), lon: b.getEast() };
      setBbox((prev) =>
        prev && !viewportEscapedBbox(prev, sw, ne) ? prev : padBoundingBox(sw, ne, AIS_BBOX_PAD),
      );
    };
    update(); // initial bbox
    let timer: number | undefined;
    const onMoveEnd = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(update, AIS_RESUBSCRIBE_DEBOUNCE_MS);
    };
    map.on('moveend', onMoveEnd);
    return () => {
      window.clearTimeout(timer);
      map.off('moveend', onMoveEnd);
    };
  }, [map]);

  const { status, targets, targetCount } = useAisTraffic({
    apiKey,
    ownMmsi,
    bbox,
    online,
    visible,
  });

  return (
    <>
      <AisLayer targets={targets} />
      <AisStatusChip status={status} targetCount={targetCount} />
    </>
  );
}
