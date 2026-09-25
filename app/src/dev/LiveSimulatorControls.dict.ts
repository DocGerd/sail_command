import type { Lang } from '../i18n';

// #143: dev/UAT-only Live-view simulator control strings. Deliberately NOT
// in the main i18n dicts (src/i18n/dict.de.ts / dict.en.ts) — a key added
// there ships in the PRODUCTION bundle and would break its byte-identity
// guarantee (#96), mirroring UatBadge.dict.ts's own reasoning. This module
// is imported only from LiveSimulatorControls.tsx, whose sole import site
// (LiveView.tsx) is gated on the fold-exact `import.meta.env.DEV ||
// __SC_UAT__` condition, so production tree-shakes component and dict away
// entirely while the de/en `satisfies` parity convention still holds
// locally.
type LiveSimMsgKey =
  | 'liveSim.title'
  | 'liveSim.scenario.label'
  | 'liveSim.scenario.track'
  | 'liveSim.scenario.drift'
  | 'liveSim.scenario.stop'
  | 'liveSim.scenario.dropout'
  | 'liveSim.scenario.degraded-accuracy'
  | 'liveSim.play'
  | 'liveSim.pause'
  | 'liveSim.speed.label'
  | 'liveSim.jump.label'
  | 'liveSim.reroute.disabled';

const de = {
  'liveSim.title': 'Live-Simulator (nur Dev/UAT)',
  'liveSim.scenario.label': 'Szenario',
  'liveSim.scenario.track': 'Kursverfolgung',
  'liveSim.scenario.drift': 'Abdrift',
  'liveSim.scenario.stop': 'Gestoppt',
  'liveSim.scenario.dropout': 'GPS-Aussetzer',
  'liveSim.scenario.degraded-accuracy': 'Geringe Genauigkeit',
  'liveSim.play': 'Wiedergabe',
  'liveSim.pause': 'Pause',
  'liveSim.speed.label': 'Geschwindigkeit ×{multiplier}',
  'liveSim.jump.label': 'Position springen',
  'liveSim.reroute.disabled':
    'Neuplanung ist deaktiviert, solange der Live-Simulator läuft — die Position ist nicht real.',
} satisfies Record<LiveSimMsgKey, string>;

const en = {
  'liveSim.title': 'Live simulator (dev/UAT only)',
  'liveSim.scenario.label': 'Scenario',
  'liveSim.scenario.track': 'Track playback',
  'liveSim.scenario.drift': 'Drift off-route',
  'liveSim.scenario.stop': 'Stopped',
  'liveSim.scenario.dropout': 'GPS dropout',
  'liveSim.scenario.degraded-accuracy': 'Degraded accuracy',
  'liveSim.play': 'Play',
  'liveSim.pause': 'Pause',
  'liveSim.speed.label': 'Speed ×{multiplier}',
  'liveSim.jump.label': 'Jump to position',
  'liveSim.reroute.disabled':
    'Reroute is disabled while the Live simulator is running — the position is not real.',
} satisfies Record<LiveSimMsgKey, string>;

export const liveSimDict: Record<Lang, Record<LiveSimMsgKey, string>> = { de, en };
