import { useEffect, useState } from 'react';
import { listWaypoints, type SavedWaypoint } from '../services/db';

/**
 * #924: a read-only view of the persisted saved-waypoint list, shared by the
 * map layer (components/SavedWaypointsLayer.tsx) and kept live by the panel
 * picker (components/SavedWaypoints.tsx).
 *
 * WHY A BUS RATHER THAN LIFTED STATE. #848's picker owns its own list state
 * and re-fetches after every save/delete; the map layer is mounted in a
 * different subtree (inside MapView, for the map context) and is separated
 * from the picker by PlannerPanel, so sharing one useState would mean
 * threading props through a component this change has no other reason to
 * touch. The bus is the same shape usePersistedToggle.ts uses for #681's
 * cross-instance sync, with IndexedDB rather than localStorage as the store:
 * the writer announces "the store moved", every reader re-reads it. No list
 * is cached at module level — each consumer keeps its own copy, so nothing
 * survives between tests beyond an empty subscriber set.
 *
 * The ONE writer is the picker. This hook deliberately exposes no mutator:
 * the map layer's only action is inserting a waypoint into the route draft,
 * which never touches the `waypoints` store.
 */
const listeners = new Set<() => void>();

/** Announce that the `waypoints` store has changed, so every mounted
 * `useSavedWaypoints()` re-reads it. Safe to call with no subscribers. */
export function notifySavedWaypointsChanged(): void {
  // Copied before iterating: a listener that unsubscribes during the walk
  // (an unmount inside a React state update) must not skip its neighbour.
  for (const listener of [...listeners]) listener();
}

export function useSavedWaypoints(): SavedWaypoint[] {
  const [items, setItems] = useState<SavedWaypoint[]>([]);

  useEffect(() => {
    // A plain local, NOT a ref written in the cleanup: under StrictMode the
    // dev-only mount -> cleanup -> remount double-invoke runs this effect
    // body a second time, so a ref latched false by the first cleanup would
    // stay false forever and every read would silently discard its result
    // (CLAUDE.md's StrictMode bullet). A per-invocation local is re-created
    // by the remount, so the second pass is live again.
    let cancelled = false;
    const read = () => {
      void listWaypoints()
        .then((next) => {
          if (!cancelled) setItems(next);
        })
        // Best-effort, like DataLayers' own asset load: a failed read leaves
        // the map layer empty rather than taking the map down. The PICKER is
        // where a read failure is disclosed to the user (#848's
        // `waypoints.actionError`), and it reads the same store, so a
        // failure here is never silent product-wide.
        .catch(console.error);
    };
    listeners.add(read);
    read();
    return () => {
      cancelled = true;
      listeners.delete(read);
    };
  }, []);

  return items;
}
