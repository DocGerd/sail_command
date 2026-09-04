import { useCallback, useEffect, useState } from 'react';
import { deleteWaypoint, listWaypoints, saveWaypoint, type SavedWaypoint } from '../services/db';
import { useT } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import { formatLatLon } from '../lib/format';
import type { ViaPoint } from '../types';
import Button from './Button';

export interface SavedWaypointsProps {
  // #848 spec §2.3/§2.4: reuses the `ViaPoint` shape #846 established
  // (`{lat, lon, name?}`) — a seamark-sourced waypoint is already flattened
  // to that shape by #845's picker before it ever reaches the draft via
  // list, so nothing here needs to know where a point came from.
  //
  // The current draft via list, read-only — offered here as a source to
  // save FROM (each entry gets its own "save" action below). Persistence is
  // otherwise fully self-contained: this component owns its own list state
  // and re-fetches it after every save/delete, mirroring PlansList.tsx's
  // refresh pattern rather than threading a refresh token through App.tsx.
  viaPoints: readonly ViaPoint[];
  // §2.6: PlannerPanel wires this straight through to App.tsx's shared
  // nearest-point-on-the-draft-chain insertion (the same helper #845's
  // "add seamark as waypoint" action uses) — with no route context yet, the
  // caller appends instead, per that section's explicit empty-case rule.
  onSelect: (w: ViaPoint) => void;
}

/**
 * #848: the panel-only saved-waypoint picker (design spec §2.7 — no map
 * layer in this release; that is #924). Lists waypoints persisted in the
 * IndexedDB `waypoints` store (services/db.ts), offers "save" for each entry
 * in the current draft via list, "add to route" to load a saved one back
 * into the draft, and two-tap delete — same interaction shape as
 * PlansList.tsx's own save/load/delete rows.
 */
export default function SavedWaypoints({ viaPoints, onSelect }: SavedWaypointsProps) {
  const t = useT();
  const [items, setItems] = useState<SavedWaypoint[]>([]);
  // Only one row's delete can be pending confirmation at a time — same
  // two-tap semantics as PlansList.tsx's pendingDeleteId.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<MsgKey | null>(null);

  const refresh = useCallback(() => {
    void listWaypoints()
      .then(setItems)
      .catch((err: unknown) => {
        console.error(err);
        setError('waypoints.actionError');
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSave = useCallback(
    (v: ViaPoint) => {
      setError(null);
      // #846's rename UI already lets a via point carry a name before it
      // gets here; an unnamed point falls back to its formatted coordinates
      // — the same fallback PlannerPanel's own via-row label already uses
      // (`v.name ?? formatLatLon(v)`), so a saved-but-unnamed waypoint reads
      // identically to how it read in the via list it was saved from.
      const w: SavedWaypoint = {
        id: crypto.randomUUID(),
        name: v.name ?? formatLatLon(v),
        lat: v.lat,
        lon: v.lon,
        createdAtMs: Date.now(),
      };
      void saveWaypoint(w)
        .then(refresh)
        .catch((err: unknown) => {
          console.error(err);
          setError('waypoints.actionError');
        });
    },
    [refresh],
  );

  const handleDeleteTap = useCallback(
    (id: string) => {
      if (pendingDeleteId !== id) {
        setPendingDeleteId(id);
        return;
      }
      setError(null);
      // Cleared only once deleteWaypoint settles, not synchronously — same
      // reasoning as PlansList.tsx's handleDeleteTap: clearing it up front
      // would let a second tap on the same row re-arm and re-issue a second
      // delete while the first is still in flight.
      void deleteWaypoint(id)
        .then(() => {
          setPendingDeleteId(null);
          refresh();
        })
        .catch((err: unknown) => {
          console.error(err);
          setPendingDeleteId(null);
          setError('waypoints.actionError');
        });
    },
    [pendingDeleteId, refresh],
  );

  return (
    <>
      {error && (
        <p className="inline-alert" role="alert">
          {t(error)}
        </p>
      )}
      {/* #848's own body requires device-local persistence be DISCLOSED, not
          discovered — follows the about.caveats.* pattern (no in-app sync,
          no backend; see CLAUDE.md's Open-Meteo/AIS bullets for the same
          "no backend" product position). */}
      <p className="waypoints-caveat">{t('waypoints.deviceLocal')}</p>
      {viaPoints.length > 0 && (
        <div className="waypoints-save-from-via">
          <ul className="waypoints-save-from-via-list">
            {viaPoints.map((v, i) => (
              <li key={i}>
                <Button variant="ghost" onClick={() => handleSave(v)}>
                  {t('waypoints.saveFromVia', { label: v.name ?? formatLatLon(v) })}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {items.length === 0 ? (
        <p className="waypoints-empty">{t('waypoints.empty')}</p>
      ) : (
        <ul className="waypoints-list">
          {items.map((w) => (
            <li key={w.id} className="waypoints-row">
              <button
                type="button"
                className="waypoints-load"
                onClick={() => onSelect({ lat: w.lat, lon: w.lon, name: w.name })}
              >
                <span className="waypoints-name">{w.name}</span>
                <span className="waypoints-coord">{formatLatLon(w)}</span>
              </button>
              <Button
                variant="ghost"
                className="waypoints-delete"
                onClick={() => handleDeleteTap(w.id)}
                aria-label={
                  pendingDeleteId === w.id ? t('waypoints.confirmDelete') : t('waypoints.delete')
                }
              >
                {pendingDeleteId === w.id ? '✓' : '🗑'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
