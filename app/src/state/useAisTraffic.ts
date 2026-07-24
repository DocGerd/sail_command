import { useEffect, useRef, useState } from 'react';
import {
  AisStreamClient,
  browserAisSocket,
  type AisBoundingBox,
  type AisClientStatus,
  type AisStreamCallbacks,
} from '../services/aisStream';
import {
  mergeAisMessage,
  snapshotTargets,
  sweepDropped,
  type AisTarget,
  type AisTargetSnapshot,
} from '../lib/aisTargets';
import { countTargetsInCorridor } from '../lib/routeCorridor';

export type AisStatus = 'off' | 'connecting' | 'live' | 'offline' | 'keyError';

/**
 * #158: settle gate for jittery inputs. Returns `value` only once it has held
 * (by Object.is) for `settleMs` UNINTERRUPTED; any change re-arms the window,
 * and returning to the settled value cancels the pending adoption. AisTraffic
 * consumes activeLegIndex through it: the index is a hysteresis-free per-fix
 * nearest-leg argmin that flips between adjacent values at GPS-fix rate near
 * leg boundaries — RouteLayer absorbs those flips with a cheap setFilter, but
 * a network resubscription needs this stronger absorption so the corridor
 * recomputes at leg-transition cadence, never fix rate.
 *
 * `resetKey` (#162 review): when its identity changes, the raw `value` is
 * adopted IN THE SAME RENDER, bypassing the settle window. Only same-key
 * changes are GPS-fix jitter; a key change (AisTraffic passes plan+rig
 * identity) means the value's frame of reference moved — holding the old
 * plan's settled index against a new plan's legs would slice the wrong
 * corridor for up to settleMs. Uses React's render-time state-adjustment
 * pattern (not an effect), so consumers never observe the stale pairing.
 */
export function useSettledValue<T>(value: T, settleMs: number, resetKey?: unknown): T {
  const [state, setState] = useState({ settled: value, resetKey });
  const keyChanged = !Object.is(state.resetKey, resetKey);
  if (keyChanged) setState({ settled: value, resetKey });
  const settled = keyChanged ? value : state.settled;
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = window.setTimeout(() => setState({ settled: value, resetKey }), settleMs);
    return () => window.clearTimeout(timer);
  }, [value, settled, settleMs, resetKey]);
  return settled;
}

export interface AisClientLike {
  start(bboxes: AisBoundingBox[]): void;
  updateSubscription(bboxes: AisBoundingBox[]): void;
  stop(): void;
}

export interface UseAisTrafficInput {
  // string | undefined (not ?-optional): settings.aisApiKey is string|undefined
  // and exactOptionalPropertyTypes forbids passing undefined into a ?-optional.
  apiKey: string | undefined;
  ownMmsi: string | undefined;
  // The subscribed union (corridor ∪ padded viewport, pre-merged by the
  // caller); null = gates closed / no viewport yet.
  bboxes: AisBoundingBox[] | null;
  // Corridor-only subset, for routeCount ([] without a plan).
  corridorBoxes: AisBoundingBox[];
  online: boolean;
  visible: boolean;
}

export interface UseAisTrafficDeps {
  createClient?: (apiKey: string, callbacks: AisStreamCallbacks) => AisClientLike;
  now?: () => number;
}

export interface UseAisTrafficResult {
  status: AisStatus;
  targets: AisTargetSnapshot[];
  targetCount: number;
  routeCount: number;
}

function defaultCreateClient(apiKey: string, callbacks: AisStreamCallbacks): AisClientLike {
  return new AisStreamClient(apiKey, callbacks, { socketFactory: browserAisSocket });
}

/**
 * #25 AIS live traffic overlay hook. Mirrors useOwnshipGps: high-frequency data
 * stays local (the target Map lives in a ref; only the ≤1 Hz snapshot is React
 * state), never AppState. Only mounted while the Live tab is active (App gates
 * the mount), so "Live tab active" is implied; the socket additionally requires
 * a non-empty key, navigator.onLine, and document visibility — all passed in.
 * Going offline/hidden stops the socket but KEEPS the store aging; unmount
 * (tab switch) discards it, so a fresh Live visit starts empty.
 */
export function useAisTraffic(
  input: UseAisTrafficInput,
  deps: UseAisTrafficDeps = {},
): UseAisTrafficResult {
  const { apiKey, ownMmsi, bboxes, corridorBoxes, online, visible } = input;
  const createClient = deps.createClient ?? defaultCreateClient;
  const now = deps.now ?? Date.now;

  const keyValid = apiKey !== undefined && apiKey.length > 0;

  const storeRef = useRef<Map<string, AisTarget>>(new Map());
  const clientRef = useRef<AisClientLike | null>(null);
  const clientKeyRef = useRef<string | null>(null);
  // ownMmsi read through a ref so the client's long-lived onMessage closure
  // always filters against the latest value without recreating the client.
  // Synced in an effect (not during render) — the react-hooks lint rule
  // forbids ref writes in the render body.
  const ownMmsiRef = useRef(ownMmsi);
  useEffect(() => {
    ownMmsiRef.current = ownMmsi;
  }, [ownMmsi]);
  // Corridor boxes read through a ref (the ownMmsiRef precedent) so the 1 Hz
  // interval below never re-arms on a corridor change.
  const corridorBoxesRef = useRef(corridorBoxes);
  useEffect(() => {
    corridorBoxesRef.current = corridorBoxes;
  }, [corridorBoxes]);

  const [clientStatus, setClientStatus] = useState<AisClientStatus>('closed');
  const [targets, setTargets] = useState<AisTargetSnapshot[]>([]);
  const [routeCount, setRouteCount] = useState(0);

  // ≤1 Hz publish tick: doubles as the drop-sweeper and recomputes age tiers so
  // stale targets fade smoothly. One new array per second is exactly the
  // "setData at most 1 Hz" the renderer wants. routeCount piggybacks on the
  // same tick — never recomputed per AIS message.
  useEffect(() => {
    const id = setInterval(() => {
      const t = now();
      sweepDropped(storeRef.current, t);
      const snap = snapshotTargets(storeRef.current, t);
      setTargets(snap);
      setRouteCount(countTargetsInCorridor(snap, corridorBoxesRef.current));
    }, 1000);
    return () => clearInterval(id);
  }, [now]);

  // Connection lifecycle. The guard is written inline (not via the `keyValid`
  // boolean) so TypeScript's control-flow analysis narrows `apiKey` to a
  // non-empty string and `bbox` to non-null past it — a separate boolean const
  // would not narrow them, and `createClient(apiKey, …)` would fail strict.
  useEffect(() => {
    if (
      apiKey === undefined ||
      apiKey.length === 0 ||
      !online ||
      !visible ||
      bboxes === null ||
      bboxes.length === 0
    ) {
      clientRef.current?.stop();
      clientRef.current = null;
      clientKeyRef.current = null;
      return; // store intentionally NOT cleared — targets persist & keep aging
    }
    if (!clientRef.current || clientKeyRef.current !== apiKey) {
      clientRef.current?.stop();
      const client = createClient(apiKey, {
        onMessage: (msg) => mergeAisMessage(storeRef.current, msg, now(), ownMmsiRef.current),
        onStatus: (s) => setClientStatus(s),
      });
      clientRef.current = client;
      clientKeyRef.current = apiKey;
      client.start(bboxes);
    } else {
      clientRef.current.updateSubscription(bboxes);
    }
  }, [online, visible, bboxes, apiKey, createClient, now]);

  // Unmount teardown: a tab switch discards the store so a fresh Live visit
  // starts empty (spec).
  useEffect(() => {
    const store = storeRef.current;
    return () => {
      clientRef.current?.stop();
      clientRef.current = null;
      store.clear();
    };
  }, []);

  // Whether the connection gates are open this render — the same condition the
  // lifecycle effect guards on. Deriving the effective client status from it at
  // render time (instead of a setClientStatus('closed') reset inside the
  // effect) avoids the react-hooks set-state-in-effect cascade, mirroring
  // useOwnshipGps's derived-fix precedent; the observable status mapping is
  // identical.
  const clientActive = keyValid && online && visible && bboxes !== null && bboxes.length > 0;
  const effectiveStatus: AisClientStatus = clientActive ? clientStatus : 'closed';

  const status: AisStatus = !keyValid
    ? 'off'
    : !online
      ? 'offline'
      : effectiveStatus === 'keyError'
        ? 'keyError'
        : effectiveStatus === 'live'
          ? 'live'
          : 'connecting';

  return { status, targets, targetCount: targets.length, routeCount };
}
