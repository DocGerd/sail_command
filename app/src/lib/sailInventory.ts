import { useCallback, useEffect, useMemo, useState } from 'react';
import { BOATS, sailIdsOf } from '../data/boats';
import type { BoatId, SailId } from '../data/boats';
import { safeGetItem, safeSetItem } from './storage';

/**
 * Which headsails are aboard, per boat (multi-boat spec §R.3, #1661).
 *
 * One localStorage key per boat, the `ownMmsi.ts` shape: no lookup table to
 * walk, so no `Object.prototype` fall-open. Membership is always an array scan
 * over the catalogue's own sail ids, never an object lookup or `in`.
 *
 * Stored value: `{"v":1,"aboard":[…],"hoisted":id|null}`. Reads are tolerant
 * and never throw; a failed write leaves the value session-only.
 */
export const SAIL_INVENTORY_KEY_PREFIX = 'sc-sail-inventory-';

const STORAGE_VERSION = 1;

export interface SailInventory {
  /** Aboard headsails in CATALOGUE order, never click order (spec D1); never empty for a catalogue boat. */
  readonly headsailIds: readonly SailId[];
  /** Always one of `headsailIds`, else `null`. */
  readonly hoistedSailId: SailId | null;
}

export function sailInventoryStorageKey(boatId: BoatId): string {
  return `${SAIL_INVENTORY_KEY_PREFIX}${boatId}`;
}

function catalogueHeadsails(boatId: BoatId): readonly SailId[] {
  const boat = BOATS.find((b) => b.id === boatId);
  return boat === undefined ? [] : sailIdsOf(boat);
}

function defaultInventory(boatId: BoatId): SailInventory {
  return { headsailIds: catalogueHeadsails(boatId), hoistedSailId: null };
}

/** `candidates` restricted to the catalogue, in catalogue order, de-duplicated. */
function normaliseAboard(boatId: BoatId, candidates: readonly unknown[]): readonly SailId[] {
  return catalogueHeadsails(boatId).filter((id) => candidates.some((c) => c === id));
}

function parseInventory(boatId: BoatId, raw: string | null): SailInventory {
  if (raw === null) return defaultInventory(boatId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultInventory(boatId);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return defaultInventory(boatId);
  }
  const record = parsed as Record<string, unknown>;
  if (record['v'] !== STORAGE_VERSION) return defaultInventory(boatId);
  const aboardRaw = record['aboard'];
  if (!Array.isArray(aboardRaw)) return defaultInventory(boatId);
  const aboard = normaliseAboard(boatId, aboardRaw);
  if (aboard.length === 0) return defaultInventory(boatId);
  const hoisted = aboard.find((id) => id === record['hoisted']) ?? null;
  return { headsailIds: aboard, hoistedSailId: hoisted };
}

/** Never throws; a missing, malformed or foreign-version entry reads as every headsail aboard. */
export function readSailInventory(boatId: BoatId): SailInventory {
  return parseInventory(boatId, safeGetItem(sailInventoryStorageKey(boatId)));
}

// Keyed by storage key, so two boats never cross-notify.
const listenersByKey = new Map<string, Set<(next: SailInventory) => void>>();

function notify(key: string, next: SailInventory): void {
  listenersByKey.get(key)?.forEach((listener) => listener(next));
}

/** Test-only probe, as `__ownMmsiListenerCountForKey`: a leaked listener is otherwise invisible. */
export function __sailInventoryListenerCountForKey(key: string): number {
  return listenersByKey.get(key)?.size ?? 0;
}

export interface SailInventoryActions {
  /**
   * Replaces the aboard set. An empty set, or one with no catalogue sail, is
   * ignored: there is no "no sails" state. A hoisted sail that is no longer
   * aboard is dropped in the same write.
   */
  readonly setHeadsails: (ids: readonly SailId[]) => void;
}

export function usePersistedSailInventory(boatId: BoatId): [SailInventory, SailInventoryActions] {
  const key = sailInventoryStorageKey(boatId);
  const [value, setValue] = useState<SailInventory>(() => readSailInventory(boatId));
  const [seenKey, setSeenKey] = useState(key);

  // Re-read DURING RENDER on a boat switch (as `usePersistedOwnMmsi`): an
  // effect would paint one frame carrying the previous boat's inventory.
  if (seenKey !== key) {
    setSeenKey(key);
    setValue(readSailInventory(boatId));
  }

  useEffect(() => {
    let listeners = listenersByKey.get(key);
    if (!listeners) {
      listeners = new Set();
      listenersByKey.set(key, listeners);
    }
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
      if (listeners.size === 0) listenersByKey.delete(key);
    };
  }, [key]);

  const setHeadsails = useCallback(
    (ids: readonly SailId[]) => {
      const aboard = normaliseAboard(boatId, ids);
      if (aboard.length === 0) return;
      const previous = readSailInventory(boatId);
      const hoisted = aboard.find((id) => id === previous.hoistedSailId) ?? null;
      // Best-effort: a failed write leaves the value session-only.
      safeSetItem(key, JSON.stringify({ v: STORAGE_VERSION, aboard, hoisted }));
      notify(key, { headsailIds: aboard, hoistedSailId: hoisted });
    },
    [boatId, key],
  );

  const actions = useMemo(() => ({ setHeadsails }), [setHeadsails]);

  return [seenKey === key ? value : readSailInventory(boatId), actions];
}
